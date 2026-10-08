import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { costUsd, type Step } from '@garden/core';
import { ClaudeCodeAdapter, deriveAll, ingest, Redactor, Store } from '@garden/ingest';
import { createApp } from './app';
import {
  buildReplay,
  buildReplayView,
  contextWindowFor,
  FALLBACK_CONTEXT_WINDOW,
  loadReplayInput,
  stepLabel,
  type ReplayInput,
} from './replay';

const redactor = new Redactor(Buffer.alloc(32, 3));
const red = (t: string) => redactor.text(t, 2000);

const FIXTURE_HOME = new URL('../../../fixtures/claude-code', import.meta.url);
const FIXTURE_PROJECT = join(FIXTURE_HOME.pathname, 'projects', '-home-dev-demo');

interface RawUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

/**
 * Independent of the ingester: walk the raw JSONL lines in file order, keep the first usage per
 * `message.id`, and derive the prompt size (input + cache read + cache creation) per message.
 */
function rawMessages(file: string): { id: string; usage: RawUsage; context: number }[] {
  const out: { id: string; usage: RawUsage; context: number }[] = [];
  const seen = new Set<string>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const r = rec as { type?: string; message?: { id?: string; usage?: Record<string, number> } };
    const id = r.message?.id;
    const u = r.message?.usage;
    if (r.type !== 'assistant' || !id || !u || seen.has(id)) continue;
    seen.add(id);
    const usage = {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheCreate: u.cache_creation_input_tokens ?? 0,
    };
    out.push({ id, usage, context: usage.input + usage.cacheRead + usage.cacheCreate });
  }
  return out;
}
const rawTotal = (u: RawUsage) => u.input + u.output + u.cacheRead + u.cacheCreate;

async function ingestInto(home: string, dir: string): Promise<Store> {
  const store = new Store(join(dir, 'garden.db'));
  const a = new ClaudeCodeAdapter({ claudeHome: home, claudeJsonPath: join(dir, 'none.json') });
  await ingest(a, store, new Redactor(Buffer.alloc(32, 9)));
  deriveAll(store, a.garden);
  return store;
}

const dir = mkdtempSync(join(tmpdir(), 'garden-replay-'));
let store: Store;
beforeAll(async () => {
  const home = join(dir, 'claude');
  cpSync(FIXTURE_HOME, home, { recursive: true });
  store = await ingestInto(home, dir);
});
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const runsByPrompt = (prompt: string) =>
  store.db
    .prepare(
      'SELECT id FROM runs WHERE task_preview LIKE ? AND parent_run_id IS NULL ORDER BY started_at',
    )
    .all(`${prompt}%`)
    .map((r) => String(r.id));

describe('buildReplay on fixture transcripts', () => {
  it('is deterministic: same store, same view (byte for byte)', () => {
    for (const id of store.db
      .prepare('SELECT id FROM runs')
      .all()
      .map((r) => String(r.id))) {
      const a = JSON.stringify(buildReplayView(store, id));
      const b = JSON.stringify(buildReplayView(store, id));
      expect(a).toBe(b);
    }
  });

  it('returns null for an unknown run', () => {
    expect(buildReplayView(store, 'run_nope')).toBeNull();
  });

  it('context fill and cumulative tokens equal an independent dedupe of the raw usage (compaction fixture)', () => {
    const file = join(FIXTURE_PROJECT, '0b5e0000-0000-4000-8000-000000000003.jsonl');
    const raw = rawMessages(file);
    const [runId] = runsByPrompt('Refactor the parser');
    const v = buildReplayView(store, runId!)!;
    // Prompt sizes reported by each message, in order; zero-size reports (a synthetic API error)
    // are not measurements and do not move the gauge.
    const expectedContexts = raw.map((m) => m.context).filter((c) => c > 0);
    const seenContexts = v.frames
      .map((f) => f.contextTokens)
      .filter((c, i, a) => c > 0 && c !== a[i - 1]);
    expect(seenContexts).toEqual(expectedContexts);
    expect(v.peakContextTokens).toBe(Math.max(...expectedContexts));
    for (const f of v.frames) expect(f.contextFill).toBeCloseTo(f.contextTokens / v.contextWindow);
    expect(v.frames.at(-1)!.tokensCum).toBe(raw.reduce((n, m) => n + rawTotal(m.usage), 0));
    expect(v.run.totalTokens).toBe(v.frames.at(-1)!.tokensCum);
    // The compaction is a frame with its trigger and pre-compaction size.
    expect(v.compactions).toBe(1);
    const c = v.frames.find((f) => f.kind === 'compaction')!;
    expect(c.compaction).toEqual({ trigger: 'auto', preTokens: 180000 });
    expect(c.label).toBe('Compaction (auto, 180,000 tokens before)');
    // Context carried forward across the compaction until the next real measurement.
    expect(c.contextTokens).toBe(raw[0]!.context);
    // The synthetic API error is a brown-leaf frame.
    expect(v.frames.some((f) => f.kind === 'error' && f.isError)).toBe(true);
  });

  it('dedupes lines that repeat one API message, and the final cost equals the run cost', () => {
    const file = join(FIXTURE_PROJECT, '0b5e0000-0000-4000-8000-000000000001.jsonl');
    const raw = rawMessages(file);
    const [firstRun] = runsByPrompt('Add a changelog entry');
    const session = String(
      store.db.prepare('SELECT session_id AS s FROM runs WHERE id = ?').get(firstRun!)!.s,
    );
    const runs = store.db
      .prepare('SELECT id FROM runs WHERE session_id = ? ORDER BY started_at, id')
      .all(session)
      .map((r) => String(r.id));
    expect(runs.length).toBe(2);
    const views = runs.map((id) => buildReplayView(store, id)!);
    const total = views.reduce((n, v) => n + v.frames.at(-1)!.tokensCum, 0);
    expect(total).toBe(raw.reduce((n, m) => n + rawTotal(m.usage), 0));
    for (const v of views) {
      const last = v.frames.at(-1)!;
      expect(last.costUsdCum).toBeCloseTo(v.run.costUsd!, 10);
      // Monotone time and tokens.
      for (let i = 1; i < v.frames.length; i++) {
        expect(v.frames[i]!.t).toBeGreaterThanOrEqual(v.frames[i - 1]!.t);
        expect(v.frames[i]!.tokensCum).toBeGreaterThanOrEqual(v.frames[i - 1]!.tokensCum);
      }
    }
    const first = views[0]!;
    expect(first.contextWindow).toBe(1_000_000);
    expect(first.contextWindowSource).toContain('claude-opus-5-5');
    expect(first.contextWindowSource).toContain('pricing table');
    // Labels: thinking shows only a length, tools show their target, errors are flagged.
    const labels = first.frames.map((f) => f.label);
    expect(labels).toContain('Thinking (40 chars)');
    expect(labels.some((l) => l.startsWith('Bash Run tests'))).toBe(true);
    expect(labels.some((l) => l.startsWith('Bash failed: 1 test failed'))).toBe(true);
    expect(labels).toContain('Skill changelog-writer');
    expect(labels.some((l) => l.startsWith('github · create_issue'))).toBe(true);
    const bashErr = first.frames.find((f) => f.kind === 'tool_result' && f.tool?.name === 'Bash')!;
    expect(bashErr.isError).toBe(true);
    expect(bashErr.loopTier).toBe('verification');
    const skill = first.frames.find((f) => f.kind === 'tool_call' && f.tool?.category === 'skill')!;
    expect(skill.tool?.skillName).toBe('changelog-writer');
    const mcp = first.frames.find((f) => f.tool?.mcpServer === 'github')!;
    expect(mcp.tool?.category).toBe('mcp');
  });

  it('recurses into subagent runs: the fork frame points at a child replay', () => {
    const [runId] = runsByPrompt('Explore the repo');
    const v = buildReplayView(store, runId!)!;
    const fork = v.frames.find((f) => f.kind === 'subagent_spawn')!;
    expect(fork.forkRunId).toBeDefined();
    expect(fork.label).toMatch(/^Spawn Explore: Find TODOs/);
    expect(v.children).toHaveLength(1);
    const child = v.children[0]!;
    expect(child.run.runId).toBe(fork.forkRunId);
    expect(child.agent.kind).toBe('subagent');
    expect(child.run.trigger).toBe('subagent');
    expect(child.frames.length).toBeGreaterThan(0);
    expect(v.run.childCount).toBe(1);
    // Child timeline is relative to the child's own start.
    expect(child.frames[0]!.t).toBeGreaterThanOrEqual(0);
    // The independent dedupe over the subagent file matches the child's cumulative tokens.
    const sub = join(FIXTURE_PROJECT, '0b5e0000-0000-4000-8000-000000000004', 'subagents');
    const raw = readdirSync(sub)
      .filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) => rawMessages(join(sub, f)));
    expect(child.frames.at(-1)!.tokensCum).toBe(raw.reduce((n, m) => n + rawTotal(m.usage), 0));
  });
});

describe('buildReplay (pure)', () => {
  const step = (seq: number, over: Partial<Step>): Step => ({
    id: `stp_${seq}`,
    runId: 'run_a',
    seq,
    at: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    kind: 'assistant_message',
    loopTier: 'agent',
    ...over,
  });
  const usage = (input: number, output: number, cacheRead = 0) => ({
    input,
    output,
    cacheRead,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
  });
  const input = (steps: Step[], children: ReplayInput[] = [], depthId = 'run_a'): ReplayInput => ({
    run: {
      id: depthId,
      agentId: 'agt_main',
      familyId: 'fam_x',
      harnessVersionId: 'hv',
      parentRunId: null,
      loopId: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:01:00.000Z',
      trigger: 'human',
      models: ['claude-haiku-4-5'],
      tokens: usage(0, 0),
      tokenQuality: 'reported',
      label: 'success',
      manual: false,
      heuristicLabel: 'success',
      score: 0.7,
      manualNote: null,
      manualAt: null,
      toolCallCount: 0,
      signals: [],
      taskPreview: 'x',
      errorCount: 0,
    },
    childCount: children.length,
    agent: { id: 'agt_main', name: 'main', kind: 'main' },
    bed: { id: 'fam_x', name: 'x' },
    steps,
    skillNames: {},
    children,
  });

  it('never double-counts a message id, even if two steps carry its usage', () => {
    const v = buildReplay(
      input([
        step(1, { apiMessageId: 'm1', tokens: usage(10, 5, 100), contextTokens: 110 }),
        step(2, { apiMessageId: 'm1', tokens: usage(10, 5, 100), contextTokens: 110 }),
        step(3, { apiMessageId: 'm2', tokens: usage(1, 2, 150), contextTokens: 151 }),
      ]),
    );
    expect(v.frames.map((f) => f.tokensCum)).toEqual([115, 115, 268]);
    expect(v.frames.map((f) => f.contextTokens)).toEqual([110, 110, 151]);
    expect(v.contextWindow).toBe(200_000); // haiku 4.5 in the pricing table
    expect(v.frames[2]!.contextFill).toBeCloseTo(151 / 200_000);
    expect(v.frames[2]!.costUsdCum).toBeCloseTo(costUsd(usage(11, 7, 250), 'claude-haiku-4-5')!);
  });

  it('caps fill at 100% and says so when the prompt exceeds the listed window', () => {
    const v = buildReplay(
      input([step(1, { apiMessageId: 'm1', tokens: usage(250_000, 1), contextTokens: 250_000 })]),
    );
    expect(v.frames[0]!.contextFill).toBe(1);
    expect(v.contextWindowSource).toContain('exceeds it');
  });

  it('labels thinking by length only and never by its text', () => {
    const t = stepLabel(step(1, { kind: 'thinking', preview: red('[thinking: 1234 chars]') }));
    expect(t).toBe('Thinking (1.2k chars)');
    expect(stepLabel(step(1, { kind: 'thinking', preview: red('secret plan') }))).toBe(
      'Thinking (redacted)',
    );
  });

  it('labels tool calls from their redacted input preview', () => {
    const call = (name: string, preview: string) =>
      stepLabel(
        step(1, {
          kind: 'tool_call',
          preview: red(preview),
          tool: { name, callId: 'c', category: 'builtin' },
        }),
      );
    expect(call('Edit', '{"file_path":"/home/dev/demo/src/app.ts","old_string":"a"')).toBe(
      'Edit …/src/app.ts',
    );
    expect(call('Grep', '{"pattern":"TODO","path":"src"}')).toBe('Grep src');
    expect(call('Bash', '{"command":"pnpm test"}')).toBe('Bash pnpm test');
    expect(call('WebFetch', '{"url":"https://example.invalid/x"}')).toBe(
      'WebFetch https://example.invalid/x',
    );
  });

  it('drops a fork id whose child is not present (depth cap) and falls back for unknown models', () => {
    const v = buildReplay({
      ...input([step(1, { kind: 'subagent_spawn', childRunId: 'run_missing' })]),
      run: { ...input([]).run, models: ['mystery-model'] },
    });
    expect(v.frames[0]!.forkRunId).toBeUndefined();
    expect(v.contextWindow).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(v.contextWindowSource).toContain('not in the pricing table');
    expect(v.frames[0]!.costUsdCum).toBeNull();
    expect(contextWindowFor(null).source).toContain('No model recorded');
  });
});

describe('GET /api/replay/:runId', () => {
  it('serves a replay and 404s an unknown run', async () => {
    const app = createApp({ store });
    const [runId] = runsByPrompt('Refactor the parser');
    const ok = await app.request(`/api/replay/${runId}`);
    expect(ok.status).toBe(200);
    const v = (await ok.json()) as { run: { runId: string }; frames: unknown[] };
    expect(v.run.runId).toBe(runId);
    expect(v.frames.length).toBeGreaterThan(0);
    expect((await app.request('/api/replay/run_nope')).status).toBe(404);
  });
});

// ---- this container's real transcripts (skipped when absent, e.g. in CI) ----------------------

const REAL = join(homedir(), '.claude', 'projects');
describe.skipIf(!existsSync(REAL))('replay on real transcripts in ~/.claude/projects', () => {
  it('every run replays; context and tokens equal an independent dedupe of the raw usage', async () => {
    // Snapshot first: live sessions keep growing while the test runs.
    const snap = mkdtempSync(join(tmpdir(), 'garden-replay-real-'));
    try {
      cpSync(REAL, join(snap, 'claude', 'projects'), { recursive: true });
      const files: string[] = [];
      const walk = (d: string) => {
        for (const f of readdirSync(d)) {
          const p = join(d, f);
          if (statSync(p).isDirectory()) walk(p);
          else if (f.endsWith('.jsonl')) files.push(p);
        }
      };
      walk(join(snap, 'claude', 'projects'));
      const raw = new Map<string, { usage: RawUsage; context: number }>();
      for (const f of files) for (const m of rawMessages(f)) if (!raw.has(m.id)) raw.set(m.id, m);
      const real = await ingestInto(join(snap, 'claude'), snap);
      try {
        const ids = real.db
          .prepare('SELECT id FROM runs')
          .all()
          .map((r) => String(r.id));
        expect(ids.length).toBeGreaterThan(0);
        for (const id of ids) {
          const input = loadReplayInput(real, id, 0)!;
          const v = buildReplay(input);
          expect(v.frames).toHaveLength(input.steps.length);
          const msgIds = new Set<string>();
          let expectedContext = 0;
          input.steps.forEach((s, i) => {
            const fresh = s.apiMessageId !== undefined && !msgIds.has(s.apiMessageId);
            if (s.apiMessageId) msgIds.add(s.apiMessageId);
            const m = fresh ? raw.get(s.apiMessageId!) : undefined;
            if (m && m.context > 0) expectedContext = m.context;
            expect(v.frames[i]!.contextTokens, `${id} step ${s.seq}`).toBe(expectedContext);
            expect(v.frames[i]!.contextFill).toBeLessThanOrEqual(1);
            expect(v.frames[i]!.label).not.toMatch(/^Thinking \((?!\d|redacted|no text recorded)/);
          });
          const expectedTokens = [...msgIds].reduce(
            (n, m) => n + (raw.get(m) ? rawTotal(raw.get(m)!.usage) : 0),
            0,
          );
          expect(v.frames.at(-1)?.tokensCum ?? 0, id).toBe(expectedTokens);
        }
      } finally {
        real.close();
      }
    } finally {
      rmSync(snap, { recursive: true, force: true });
    }
  }, 60_000);
});
