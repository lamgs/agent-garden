/**
 * Time-lapse replay (M5). `loadReplayInput` reads one run, its steps, and its subagent runs
 * (recursively, depth ≤ 3) from the store; `buildReplay` is a pure function over that input.
 *
 * Token and context math (CLAUDE.md "Data-format discipline"):
 * - `Step.tokens` / `Step.contextTokens` are stored only on the first step of each API message.
 *   The builder still dedupes by `apiMessageId`, so a duplicated row can never double-count.
 * - `contextTokens` is the latest reported prompt size, carried forward. An API message that
 *   reports a zero-size prompt (e.g. a synthetic API-error message) is not a measurement and
 *   does not reset the gauge.
 */
import {
  costUsd,
  PRICING_VERSION,
  resolveModelPrice,
  type ModelPrice,
  type ReplayFrame,
  type ReplayView,
  type RunRow as RunRowView,
  type Step,
  type TokenUsage,
} from '@garden/core';
import type { Store } from '@garden/ingest';
import type { OutcomeLabel, OutcomeSignalResult } from './types';
import type { RunRow } from './data';
import { plantId } from './garden';
import { toRunRow } from './plant';

/** Child runs are followed this many levels below the replayed run. */
export const REPLAY_MAX_DEPTH = 3;
/** Window assumed when the run's model is not in the pricing table. */
export const FALLBACK_CONTEXT_WINDOW = 200_000;
const LABEL_MAX = 110;

export interface ReplayInput {
  run: RunRow;
  /** Number of runs whose parent is this run (RunRow.childCount). */
  childCount: number;
  agent: { id: string; name: string; kind: 'main' | 'subagent' };
  bed: { id: string; name: string };
  steps: Step[];
  /** Skill id → skill name, for Skill tool calls. */
  skillNames: Record<string, string>;
  children: ReplayInput[];
}

// ---- loader ------------------------------------------------------------------------------------

const parseJson = <T>(v: unknown, fallback: T): T =>
  typeof v === 'string' ? (JSON.parse(v) as T) : fallback;

function loadRun(store: Store, id: string): RunRow | null {
  const r = store.db
    .prepare(
      `SELECT r.*, COALESCE(m.label, o.label, 'unknown') AS eff_label, m.run_id IS NOT NULL AS is_manual,
              o.signals_json, COALESCE(o.label, 'unknown') AS h_label, o.score AS h_score,
              m.note AS m_note, m.at AS m_at
         FROM runs r LEFT JOIN outcomes o ON o.run_id = r.id LEFT JOIN manual_labels m ON m.run_id = r.id
        WHERE r.id = ?`,
    )
    .get(id);
  if (!r) return null;
  return {
    id: String(r.id),
    agentId: String(r.agent_id),
    familyId: String(r.family_id),
    harnessVersionId: String(r.harness_version_id),
    parentRunId: r.parent_run_id === null ? null : String(r.parent_run_id),
    loopId: r.loop_id === null ? null : String(r.loop_id),
    startedAt: String(r.started_at),
    endedAt: String(r.ended_at),
    trigger: String(r.trigger),
    models: parseJson<string[]>(r.models_json, []),
    tokens: {
      input: Number(r.tok_input),
      output: Number(r.tok_output),
      cacheRead: Number(r.tok_cache_read),
      cacheWrite5m: Number(r.tok_cache_write_5m),
      cacheWrite1h: Number(r.tok_cache_write_1h),
    },
    tokenQuality: r.token_quality as RunRow['tokenQuality'],
    label: r.eff_label as OutcomeLabel,
    manual: Boolean(r.is_manual),
    heuristicLabel: r.h_label as OutcomeLabel,
    score: r.h_score === null ? null : Number(r.h_score),
    manualNote: r.m_note === null ? null : String(r.m_note),
    manualAt: r.m_at === null ? null : String(r.m_at),
    toolCallCount: Number(r.tool_call_count),
    signals: parseJson<OutcomeSignalResult[]>(r.signals_json, []),
    taskPreview: String(r.task_preview),
    errorCount: Number(r.error_count),
  };
}

/** Reads a run and its subagent runs (depth ≤ `maxDepth`). Null for an unknown run. */
export function loadReplayInput(
  store: Store,
  runId: string,
  maxDepth = REPLAY_MAX_DEPTH,
): ReplayInput | null {
  const db = store.db;
  const skillNames: Record<string, string> = {};
  for (const s of db.prepare('SELECT id, name FROM skills').all())
    skillNames[String(s.id)] = String(s.name);
  const seen = new Set<string>();
  const load = (id: string, depth: number): ReplayInput | null => {
    if (seen.has(id)) return null;
    seen.add(id);
    const run = loadRun(store, id);
    if (!run) return null;
    const a = db.prepare('SELECT id, name, kind FROM agents WHERE id = ?').get(run.agentId);
    const f = db.prepare('SELECT id, name FROM harness_families WHERE id = ?').get(run.familyId);
    const childCount = Number(
      (
        db.prepare('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = ?').get(id) as {
          n: number;
        }
      ).n,
    );
    const steps = store.getSteps(id);
    const children: ReplayInput[] = [];
    if (depth < maxDepth) {
      for (const s of steps) {
        if (s.kind !== 'subagent_spawn' || !s.childRunId) continue;
        const c = load(s.childRunId, depth + 1);
        if (c) children.push(c);
      }
    }
    return {
      run,
      childCount,
      agent: a
        ? { id: String(a.id), name: String(a.name), kind: a.kind as 'main' | 'subagent' }
        : { id: run.agentId, name: 'unknown agent', kind: run.parentRunId ? 'subagent' : 'main' },
      bed: f
        ? { id: String(f.id), name: String(f.name) }
        : { id: run.familyId, name: 'unknown bed' },
      steps,
      skillNames,
      children,
    };
  };
  return load(runId, 0);
}

// ---- pure builder ------------------------------------------------------------------------------

const zero = (): TokenUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
});
const total = (u: TokenUsage) => u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US');

/** The context window for a model, and a sentence saying where it came from. */
export function contextWindowFor(
  model: string | null,
  pricing?: Record<string, ModelPrice>,
): { window: number; source: string } {
  if (!model)
    return {
      window: FALLBACK_CONTEXT_WINDOW,
      source: `No model recorded for this run; assumed ${fmtInt(FALLBACK_CONTEXT_WINDOW)} tokens.`,
    };
  const price = resolveModelPrice(model, pricing);
  if (!price)
    return {
      window: FALLBACK_CONTEXT_WINDOW,
      source: `${model} is not in the pricing table (${PRICING_VERSION}); assumed ${fmtInt(FALLBACK_CONTEXT_WINDOW)} tokens.`,
    };
  const fromOverride =
    pricing !== undefined &&
    (pricing[model] !== undefined ||
      pricing[model.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '')] !== undefined);
  return {
    window: price.contextWindow,
    source: `${model}: ${fmtInt(price.contextWindow)} tokens, from ${
      fromOverride ? 'the garden.yaml pricing override' : `the pricing table (${PRICING_VERSION})`
    }.`,
  };
}

const shortPath = (p: string) => {
  const parts = p.split('/').filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`;
};

/** First string value of one of `keys` in a (possibly truncated) JSON preview. */
function jsonField(preview: string, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const m = new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(preview);
    if (m?.[1] !== undefined) {
      try {
        return JSON.parse(`"${m[1]}"`) as string;
      } catch {
        return m[1];
      }
    }
  }
  return undefined;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, n = LABEL_MAX) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function formatChars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

function toolTarget(name: string, preview: string): string | undefined {
  const path = jsonField(preview, ['file_path', 'notebook_path', 'path']);
  if (name === 'Bash') return jsonField(preview, ['description', 'command']);
  if (path) return shortPath(path);
  return jsonField(preview, [
    'pattern',
    'query',
    'url',
    'skill',
    'description',
    'title',
    'subject',
    'name',
  ]);
}

function displayToolName(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]} · ${m[2]}` : name;
}

/**
 * A short label for a step, built only from its redacted preview. Thinking steps never show
 * text: only the length marker the ingester stored.
 */
export function stepLabel(
  s: Step,
  skillNames: Record<string, string> = {},
  /** Label of the tool_call this step answers (for tool_result steps). */
  callTarget?: string,
): string {
  const preview = oneLine(s.preview ?? '');
  const tool = s.tool ? displayToolName(s.tool.name) : '';
  switch (s.kind) {
    case 'thinking': {
      const m = /^\[thinking: (\d+) chars\]$/.exec(s.preview ?? '');
      if (!m) return 'Thinking (redacted)';
      return m[1] === '0'
        ? 'Thinking (no text recorded)'
        : `Thinking (${formatChars(Number(m[1]))} chars)`;
    }
    case 'user_message':
      return clip(`Prompt: ${preview || '(empty)'}`);
    case 'assistant_message':
      return clip(`Says: ${preview || '(empty)'}`);
    case 'tool_call': {
      if (s.tool?.category === 'skill') {
        const skill =
          (s.tool.skillId ? skillNames[s.tool.skillId] : undefined) ??
          jsonField(preview, ['skill', 'name', 'command']);
        return clip(`Skill ${skill ?? ''}`.trim());
      }
      const target = toolTarget(s.tool?.name ?? '', preview);
      return clip(target ? `${tool} ${oneLine(target)}` : tool || 'Tool call');
    }
    case 'tool_result': {
      const err = s.tool?.isError === true || s.error !== undefined;
      if (err) return clip(`${tool} failed: ${oneLine(s.error?.message ?? preview) || 'error'}`);
      // Subagent results are the subagent's answer; other results are named by their call.
      if (s.tool?.category === 'subagent' || !callTarget)
        return clip(`${tool} returned${preview ? `: ${preview}` : ''}`);
      return `${clip(callTarget, LABEL_MAX - 5)} → ok`;
    }
    case 'subagent_spawn': {
      const type = jsonField(preview, ['subagent_type']);
      const desc = jsonField(preview, ['description']);
      return clip(`Spawn ${type ?? 'subagent'}${desc ? `: ${oneLine(desc)}` : ''}`);
    }
    case 'subagent_return':
      return clip(`Subagent returned${preview ? `: ${preview}` : ''}`);
    case 'compaction': {
      const pre = s.compaction?.preTokens;
      return `Compaction (${s.compaction?.trigger ?? 'auto'}${pre !== undefined ? `, ${fmtInt(pre)} tokens before` : ''})`;
    }
    case 'error':
      return clip(
        `${s.error?.kind === 'api' ? 'API error' : 'Error'}: ${oneLine(s.error?.message ?? preview) || 'unknown'}`,
      );
    case 'hook':
      return clip(preview.replace(/^\[|\]$/g, '') || 'Hook');
  }
}

export function isErrorStep(s: Step): boolean {
  return s.kind === 'error' || s.error !== undefined || s.tool?.isError === true;
}

/** Pure: frames, context fill, and cumulative tokens/cost for one run and its subagent runs. */
export function buildReplay(input: ReplayInput, pricing?: Record<string, ModelPrice>): ReplayView {
  const { run } = input;
  const model = run.models[0] ?? null;
  const cw = contextWindowFor(model, pricing);
  const start = Date.parse(run.startedAt);
  const seenMessages = new Set<string>();
  const cum = zero();
  let context = 0;
  let peak = 0;
  let compactions = 0;
  let lastT = 0;
  const frames: ReplayFrame[] = [];
  const steps = [...input.steps].sort((a, b) => a.seq - b.seq);
  const callLabels = new Map<string, string>();
  for (const s of steps) {
    const fresh = !s.apiMessageId || !seenMessages.has(s.apiMessageId);
    if (s.apiMessageId) seenMessages.add(s.apiMessageId);
    if (fresh && s.tokens) {
      cum.input += s.tokens.input;
      cum.output += s.tokens.output;
      cum.cacheRead += s.tokens.cacheRead;
      cum.cacheWrite5m += s.tokens.cacheWrite5m;
      cum.cacheWrite1h += s.tokens.cacheWrite1h;
    }
    if (fresh && s.contextTokens !== undefined && s.contextTokens > 0) context = s.contextTokens;
    peak = Math.max(peak, context);
    if (s.kind === 'compaction') compactions++;
    const at = Date.parse(s.at);
    lastT = Math.max(lastT, Number.isNaN(at) ? lastT : at - start);
    const f: ReplayFrame = {
      t: lastT,
      stepId: s.id,
      seq: s.seq,
      kind: s.kind,
      loopTier: s.loopTier,
      contextFill: Math.min(1, context / cw.window),
      contextTokens: context,
      tokensCum: total(cum),
      costUsdCum: model ? costUsd(cum, model, pricing) : null,
      label: stepLabel(
        s,
        input.skillNames,
        s.kind === 'tool_result' && s.tool ? callLabels.get(s.tool.callId) : undefined,
      ),
      isError: isErrorStep(s),
    };
    if (s.tool) {
      const skillName =
        s.tool.category === 'skill'
          ? ((s.tool.skillId ? input.skillNames[s.tool.skillId] : undefined) ??
            jsonField(s.preview ?? '', ['skill', 'name']))
          : undefined;
      f.tool = {
        name: s.tool.name,
        category: s.tool.category,
        ...(s.tool.mcpServer ? { mcpServer: s.tool.mcpServer } : {}),
        ...(skillName ? { skillName } : {}),
      };
    }
    if ((s.kind === 'tool_call' || s.kind === 'subagent_spawn') && s.tool)
      callLabels.set(s.tool.callId, f.label);
    if (s.kind === 'subagent_spawn' && s.childRunId) f.forkRunId = s.childRunId;
    if (s.compaction) f.compaction = { ...s.compaction };
    frames.push(f);
  }
  const children = input.children.map((c) => buildReplay(c, pricing));
  const childIds = new Set(children.map((c) => c.run.runId));
  // A fork whose child run is not in `children` (depth cap, or not ingested) keeps no dangling id.
  for (const f of frames) if (f.forkRunId && !childIds.has(f.forkRunId)) delete f.forkRunId;
  const runRow: RunRowView = {
    ...toRunRow(run, { runs: [] }, pricing),
    childCount: input.childCount,
  };
  const window =
    peak > cw.window
      ? {
          window: cw.window,
          source: `${cw.source} The observed prompt (${fmtInt(peak)} tokens) exceeds it; fill is capped at 100%.`,
        }
      : cw;
  return {
    run: runRow,
    agent: input.agent,
    bed: input.bed,
    plantId: plantId(run.agentId, run.familyId),
    contextWindow: window.window,
    contextWindowSource: window.source,
    frames,
    children,
    peakContextTokens: peak,
    compactions,
  };
}

/** Load + build. Null for an unknown run. */
export function buildReplayView(
  store: Store,
  runId: string,
  pricing?: Record<string, ModelPrice>,
): ReplayView | null {
  const input = loadReplayInput(store, runId);
  return input ? buildReplay(input, pricing) : null;
}
