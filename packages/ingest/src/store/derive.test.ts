import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ZERO_USAGE } from '@garden/core';
import { EMPTY_GARDEN_CONFIG } from '../adapters/claude-code/garden-yaml';
import { agentId } from '../adapters/claude-code/harness';
import { Redactor } from '../redact';
import { deriveAll, promptFingerprint } from './derive';
import { Store } from './store';

const dir = mkdtempSync(join(tmpdir(), 'garden-derive-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const red = new Redactor(Buffer.alloc(32, 2));
const bundle = (model: string, bytes: number) => ({
  model,
  instructions: [{ path: red.text('CLAUDE.md'), hash: String(bytes), bytes }],
  tools: [],
  skills: [],
  subagents: [],
  mcpServers: [],
  hooks: [],
});

function seed(): Store {
  const s = new Store(join(dir, `${Math.random()}.db`));
  s.putSource({ id: 'src', adapter: 'x', root: red.text('/'), adapterVersion: '1' });
  s.putFamily({ id: 'fam', name: 'shop-api', projectRoot: red.text('/shop-api') });
  s.putAgent({
    id: agentId('main'),
    name: 'main',
    kind: 'main',
    firstSeenAt: '2030-01-01T00:00:00Z',
    lastSeenAt: '2030-01-01T00:00:00Z',
  });
  s.putHarnessVersion({
    id: 'hvA',
    familyId: 'fam',
    validFrom: '2030-01-01T00:00:00Z',
    provenance: 'git',
    bundle: bundle('claude-opus-5-5', 30000),
  });
  s.putHarnessVersion({
    id: 'hvB',
    familyId: 'fam',
    validFrom: '2030-01-01T00:00:00Z',
    provenance: 'git',
    bundle: bundle('claude-sonnet-5-5', 2000),
  });
  const day = (d: number, h = 2) => new Date(Date.UTC(2026, 8, d, h)).toISOString();
  let n = 0;
  const run = (
    start: string,
    hv: string,
    prompt: string,
    entrypoint = 'cli',
    trigger: 'human' | 'automated' = 'human',
  ) => {
    const sid = `se${n}`;
    s.putSession({
      id: sid,
      sourceId: 'src',
      familyId: 'fam',
      path: red.text(`/p/${n}`),
      entrypoint,
      startedAt: start,
      endedAt: start,
    });
    s.putRun({
      id: `r${n++}`,
      sessionId: sid,
      agentId: agentId('main'),
      familyId: 'fam',
      harnessVersionId: hv,
      startedAt: start,
      endedAt: start,
      trigger,
      taskPreview: red.text(prompt),
      models: [],
      tokens: { ...ZERO_USAGE },
      stepCount: 0,
      toolCallCount: 0,
      errorCount: 0,
      compactionCount: 0,
      peakContextTokens: 0,
    });
  };
  run(day(1, 10), 'hvA', 'fix login bug');
  run(day(2, 10), 'hvA', 'add pagination');
  run(day(10, 10), 'hvB', 'refactor cart');
  for (let d = 3; d <= 9; d++)
    run(day(d), 'hvB', `Triage flaky tests from CI run ${1000 + d}`, 'sdk-cli', 'automated');
  for (let i = 0; i < 4; i++) run(day(20, i), 'hvB', 'Sync data warehouse', 'sdk-cli', 'automated');
  run(day(21), 'hvB', 'one-off automated thing', 'sdk-cli', 'automated');
  return s;
}

describe('deriveAll', () => {
  it('computes harness validity windows and diffs per family', () => {
    const s = seed();
    deriveAll(s, EMPTY_GARDEN_CONFIG);
    const rows = s.db
      .prepare(
        'SELECT id, valid_from, valid_to, diff_json FROM harness_versions ORDER BY valid_from',
      )
      .all() as Record<string, string | null>[];
    expect(rows.map((r) => r.id)).toEqual(['hvA', 'hvB']);
    expect(rows[0]!.valid_to).toBe(rows[1]!.valid_from);
    expect(rows[1]!.valid_to).toBeNull();
    expect(JSON.parse(rows[1]!.diff_json!).instructionBytesDelta).toBe(-28000);
    expect(rows[0]!.diff_json).toBeNull();
    s.close();
  });

  it('keeps one season chain per agent, so subagent harnesses do not interleave with main', () => {
    const s = seed();
    s.putAgent({
      id: agentId('Explore'),
      name: 'Explore',
      kind: 'subagent',
      firstSeenAt: 'x',
      lastSeenAt: 'x',
    });
    s.putHarnessVersion({
      id: 'hvSub',
      familyId: 'fam',
      validFrom: 'x',
      provenance: 'observed',
      bundle: bundle('claude-haiku-5-5', 0),
    });
    const r = s.getRun('r1')!;
    s.putRun({
      ...r,
      id: 'sub1',
      agentId: agentId('Explore'),
      harnessVersionId: 'hvSub',
      startedAt: '2026-09-01T12:00:00.000Z',
    });
    deriveAll(s, EMPTY_GARDEN_CONFIG);
    const get = (id: string) =>
      s.db.prepare('SELECT valid_to, diff_json FROM harness_versions WHERE id = ?').get(id) as {
        valid_to: string | null;
        diff_json: string | null;
      };
    expect(get('hvSub')).toEqual({ valid_to: null, diff_json: null });
    expect(get('hvA').valid_to).toBe('2026-09-03T02:00:00.000Z');
    s.close();
  });

  it('fixes agent seen ranges from runs', () => {
    const s = seed();
    deriveAll(s, EMPTY_GARDEN_CONFIG);
    const a = s.db.prepare('SELECT first_seen_at FROM agents').get() as { first_seen_at: string };
    expect(a.first_seen_at).toBe('2026-09-01T10:00:00.000Z');
    s.close();
  });

  it('infers loops from repeated automated prompts (≥3), ignoring digits, and attributes runs', () => {
    const s = seed();
    const rep = deriveAll(s, EMPTY_GARDEN_CONFIG);
    expect(rep.loopsInferred).toBe(2);
    const loops = s.db
      .prepare(`SELECT name, expected_interval_sec FROM loops ORDER BY name`)
      .all() as { name: string; expected_interval_sec: number }[];
    expect(loops.map((l) => l.name)).toEqual([
      'Sync data warehouse',
      'Triage flaky tests from CI run 1003',
    ]);
    expect(loops[1]!.expected_interval_sec).toBe(86400);
    expect(s.getRun('r0')?.loopId).toBeUndefined();
    s.close();
  });

  it('declared loops claim matching runs first; re-running is idempotent', () => {
    const s = seed();
    const garden = {
      ...EMPTY_GARDEN_CONFIG,
      loops: [
        {
          name: 'nightly',
          project: 'shop-api',
          agent: 'main',
          trigger: 'cron' as const,
          every: '1d',
          match: 'triage flaky',
        },
      ],
    };
    const r1 = deriveAll(s, garden);
    const r2 = deriveAll(s, garden);
    expect(r1).toEqual(r2);
    expect(r1.loopsInferred).toBe(1);
    expect(r1.runsAttributedToLoops).toBe(11);
    s.close();
  });

  it('fingerprints ignore numbers, hashes and redaction markers', () => {
    expect(promptFingerprint('Triage CI run 1234 at a1b2c3d4e5')).toBe(
      promptFingerprint('Triage CI run 99 at ffffffff00'),
    );
    expect(promptFingerprint('token [REDACTED:jwt:abcd1234] x')).toBe('token x');
  });
});
