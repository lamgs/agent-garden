/**
 * Demo live source: replays stored runs (the demo dataset) as a live stream in accelerated time, so
 * the live view looks alive without real sessions. The schedule is a pure function of the runs and
 * a seed (`buildDemoSchedule`); the player only adds wall-clock timestamps. Several beds run
 * concurrently, subagent forks run while their parent waits, and each cycle includes a tool error,
 * a compaction (when the dataset has one), and a stalled tool call that trips the waiting_permission
 * heuristic. Previews come from the store (already redacted) and are re-cut to the live limit.
 */
import type { Step } from '@garden/core';
import { stableId } from '../ids';
import type { Redactor } from '../redact';
import type { Store } from '../store/store';
import { LiveHub } from './hub';
import { livePreview } from './preview';
import type { LiveAgentHints, LiveObservation } from './types';

export interface DemoRun {
  id: string;
  sessionId: string;
  agentId: string;
  agentName: string;
  kind: 'main' | 'subagent';
  familyId: string;
  bedName: string;
  model?: string;
  parentRunId?: string;
  startedAt: string;
  compactions: number;
  errors: number;
  steps: Pick<
    Step,
    'kind' | 'at' | 'preview' | 'tool' | 'error' | 'contextTokens' | 'apiMessageId' | 'childRunId'
  >[];
}

export interface DemoItem {
  /** Offset from the cycle start (ms). */
  atMs: number;
  obs: LiveObservation;
}

export interface DemoScheduleOptions {
  seed: number;
  /** Real-time compression factor for step gaps (default 8). */
  speed?: number;
  /** Concurrent lanes (default 4). */
  lanes?: number;
  /** Main runs per cycle (default 12). */
  runsPerCycle?: number;
  /** Steps played per run at most (default 80). */
  maxStepsPerRun?: number;
}

export const DEMO_PERMISSION_STALL_MS = 8_500;
const MIN_GAP = 200;
const MAX_GAP = 2_500;

/** mulberry32: small deterministic PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const plantIdOf = (agentId: string, familyId: string): string => stableId('plt', agentId, familyId);

function shuffle<T>(xs: T[], r: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Pick main runs for one cycle: round-robin over beds, distinct sessions, forced coverage. */
function pickRuns(mains: DemoRun[], r: () => number, n: number): DemoRun[] {
  const byBed = new Map<string, DemoRun[]>();
  for (const m of mains) byBed.set(m.familyId, [...(byBed.get(m.familyId) ?? []), m]);
  const queues = [...byBed.keys()].sort().map((k) => shuffle(byBed.get(k)!, r));
  const picked: DemoRun[] = [];
  const sessions = new Set<string>();
  const take = (run: DemoRun | undefined): void => {
    if (!run || sessions.has(run.sessionId) || picked.includes(run)) return;
    picked.push(run);
    sessions.add(run.sessionId);
  };
  // Coverage first: a compaction and an error, when the dataset has them.
  take(
    shuffle(
      mains.filter((m) => m.compactions > 0),
      r,
    )[0],
  );
  take(
    shuffle(
      mains.filter((m) => m.errors > 0),
      r,
    )[0],
  );
  for (let round = 0; picked.length < n && round < mains.length; round++) {
    let progressed = false;
    for (const q of queues) {
      if (picked.length >= n) break;
      const run = q.shift();
      if (run) {
        take(run);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return picked;
}

function stepWindow(run: DemoRun, max: number): DemoRun['steps'] {
  if (run.steps.length <= max) return run.steps;
  const c = run.steps.findIndex((s) => s.kind === 'compaction');
  const start = c > max / 2 ? Math.min(c - Math.floor(max / 2), run.steps.length - max) : 0;
  return run.steps.slice(start, start + max);
}

/**
 * Build one cycle of the demo schedule. Pure and deterministic for the same runs and seed.
 * `byId` must contain every child run referenced by `childRunId`.
 */
export function buildDemoSchedule(
  runs: readonly DemoRun[],
  redactor: Redactor,
  opts: DemoScheduleOptions,
): DemoItem[] {
  const r = rng(opts.seed);
  const speed = opts.speed ?? 8;
  const lanes = opts.lanes ?? 4;
  const maxSteps = opts.maxStepsPerRun ?? 80;
  const byId = new Map(runs.map((x) => [x.id, x]));
  const mains = runs.filter((x) => x.kind === 'main' && x.steps.length >= 4);
  const picked = pickRuns(mains, r, opts.runsPerCycle ?? 12);
  const items: DemoItem[] = [];
  const preview = (t: string | undefined): string | undefined =>
    t === undefined ? undefined : livePreview(redactor, t);

  // One stalled builtin call per cycle (fast tools only, so the stall reads as a permission wait).
  const stallable = picked.flatMap((run) =>
    stepWindow(run, maxSteps)
      .filter(
        (s) =>
          s.kind === 'tool_call' &&
          ['Read', 'Edit', 'Write', 'Grep', 'Glob'].includes(s.tool?.name ?? ''),
      )
      .map((s) => `${run.id}:${s.tool!.callId}`),
  );
  const stall = stallable.length > 0 ? stallable[Math.floor(r() * stallable.length)] : undefined;

  const gap = (prev: string | undefined, at: string): number => {
    const real = prev ? Date.parse(at) - Date.parse(prev) : 0;
    const scaled = Number.isFinite(real) ? real / speed : MIN_GAP;
    return Math.round(Math.min(MAX_GAP, Math.max(MIN_GAP, scaled)) + r() * 150);
  };

  /** Schedule one run starting at `t0`; returns the time of its last item. */
  const play = (run: DemoRun, t0: number, parentKey?: string, spawnCallId?: string): number => {
    const key = run.kind === 'main' ? `demo:${run.sessionId}` : `demo:${run.sessionId}:${run.id}`;
    const hints: LiveAgentHints = {
      key,
      sessionId: run.sessionId,
      agentKind: run.kind,
      agentName: run.agentName,
      bedId: run.familyId,
      bedName: run.bedName,
      plantId: plantIdOf(run.agentId, run.familyId),
    };
    if (run.model) hints.model = run.model;
    if (parentKey) hints.parentKey = parentKey;
    if (spawnCallId) hints.spawnCallId = spawnCallId;
    const emit = (atMs: number, o: Omit<LiveObservation, 'agent'>): void => {
      items.push({ atMs, obs: { ...o, agent: hints } });
    };
    const ev = (kind: LiveObservation['event']['kind']) => ({ at: '', kind, agentKey: key });

    let t = t0;
    let prevAt: string | undefined;
    const childEnds = new Map<string, number>();
    emit(t, { event: ev('session_seen') });
    for (const s of stepWindow(run, maxSteps)) {
      t += gap(prevAt, s.at);
      prevAt = s.at;
      const callId = s.tool?.callId;
      const tool = s.tool
        ? {
            name: s.tool.name,
            category: s.tool.category,
            ...(s.tool.mcpServer ? { mcpServer: s.tool.mcpServer } : {}),
          }
        : undefined;
      switch (s.kind) {
        case 'user_message': {
          const p = preview(s.preview);
          emit(t, {
            event: { ...ev('turn_start'), ...(p ? { preview: p } : {}) },
            ...(p ? { detail: p } : {}),
          });
          break;
        }
        case 'thinking':
          emit(t, { event: ev('thinking') }); // thinking text is never emitted
          break;
        case 'assistant_message': {
          const p = preview(s.preview);
          const o: Omit<LiveObservation, 'agent'> = {
            event: {
              ...ev('assistant_text'),
              ...(p ? { preview: p } : {}),
              ...(s.contextTokens !== undefined ? { contextTokens: s.contextTokens } : {}),
            },
          };
          if (s.apiMessageId) o.apiMessageId = s.apiMessageId;
          emit(t, o);
          break;
        }
        case 'tool_call':
        case 'subagent_spawn': {
          const p = preview(s.preview);
          emit(t, {
            event: {
              ...ev(s.kind === 'tool_call' ? 'tool_start' : 'subagent_start'),
              ...(tool ? { tool } : {}),
              ...(p ? { preview: p } : {}),
            },
            ...(callId ? { callId } : {}),
            ...(p ? { detail: p } : {}),
          });
          const child = s.childRunId ? byId.get(s.childRunId) : undefined;
          if (child && callId) childEnds.set(callId, play(child, t + 300, key, callId));
          if (callId && stall === `${run.id}:${callId}`) t += DEMO_PERMISSION_STALL_MS;
          break;
        }
        case 'tool_result': {
          if (callId && childEnds.has(callId)) t = Math.max(t, childEnds.get(callId)! + 300);
          const isSub = s.tool?.category === 'subagent';
          const isError = s.tool?.isError === true || s.error !== undefined;
          const p = isError ? preview(s.error?.message ?? s.preview) : undefined;
          const o: Omit<LiveObservation, 'agent'> = {
            event: {
              ...ev(isSub ? 'subagent_end' : 'tool_end'),
              ...(tool ? { tool } : {}),
              ...(isError ? { isError: true } : {}),
              ...(p ? { preview: p } : {}),
            },
          };
          if (callId) o.callId = callId;
          if (isSub) o.childOutcome = isError ? 'errored' : 'done';
          emit(t, o);
          break;
        }
        case 'compaction': {
          const p = preview(s.preview);
          emit(t, { event: { ...ev('compaction'), ...(p ? { preview: p } : {}) } });
          t += 1500; // compaction takes a moment
          break;
        }
        case 'error': {
          const p = preview(s.error?.message ?? s.preview);
          emit(t, {
            event: {
              ...ev('error'),
              isError: s.error?.kind !== 'interrupt',
              ...(p ? { preview: p } : {}),
            },
            ...(s.error?.kind === 'interrupt' ? { interrupt: true } : {}),
          });
          break;
        }
        default:
          break;
      }
    }
    if (run.kind === 'main') {
      t += gap(undefined, '') + 400;
      emit(t, { event: ev('turn_end'), stopReason: 'end_turn' });
    }
    return t;
  };

  const laneEnd = Array.from({ length: lanes }, (_, i) => i * 1_200);
  for (const run of picked) {
    let lane = 0;
    for (let i = 1; i < lanes; i++) if (laneEnd[i]! < laneEnd[lane]!) lane = i;
    laneEnd[lane] = play(run, laneEnd[lane]!) + 3_000 + Math.round(r() * 3_000);
  }
  items.sort((a, b) => a.atMs - b.atMs);
  return items;
}

/** Load demo runs (all main runs and their subagent runs, with steps) from the store. */
export function loadDemoRuns(store: Store, maxMainRuns = 400): DemoRun[] {
  const rows = store.db
    .prepare(
      `SELECT r.id, r.session_id, r.agent_id, r.family_id, r.parent_run_id, r.models_json,
              r.started_at, r.compaction_count, r.error_count, a.name AS agent_name, a.kind AS agent_kind,
              f.name AS bed_name
         FROM runs r JOIN agents a ON a.id = r.agent_id JOIN harness_families f ON f.id = r.family_id
        ORDER BY r.started_at DESC, r.id`,
    )
    .all();
  const runs: DemoRun[] = rows.map((x) => {
    const models = typeof x.models_json === 'string' ? (JSON.parse(x.models_json) as string[]) : [];
    const run: DemoRun = {
      id: String(x.id),
      sessionId: String(x.session_id),
      agentId: String(x.agent_id),
      agentName: String(x.agent_name),
      kind: x.agent_kind === 'subagent' ? 'subagent' : 'main',
      familyId: String(x.family_id),
      bedName: String(x.bed_name),
      startedAt: String(x.started_at),
      compactions: Number(x.compaction_count),
      errors: Number(x.error_count),
      steps: [],
    };
    if (models[0]) run.model = models[0];
    if (x.parent_run_id) run.parentRunId = String(x.parent_run_id);
    return run;
  });
  const mains = runs.filter((x) => x.kind === 'main');
  const keep = new Set(
    [...mains.slice(0, maxMainRuns), ...mains.filter((m) => m.compactions > 0)].map((m) => m.id),
  );
  const out = runs.filter((x) => keep.has(x.id) || (x.parentRunId && keep.has(x.parentRunId)));
  for (const run of out) run.steps = store.getSteps(run.id);
  return out;
}

export interface DemoLiveOptions {
  seed?: number;
  speed?: number;
  hub?: LiveHub;
  now?: () => number;
}

/** Plays demo schedules forever (cycle k uses seed + k) into a hub with source 'demo'. */
export class DemoLiveSource {
  readonly hub: LiveHub;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cycle = 0;
  private readonly now: () => number;
  private stopped = false;

  constructor(
    private readonly runs: DemoRun[],
    private readonly redactor: Redactor,
    private readonly opts: DemoLiveOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.hub = opts.hub ?? new LiveHub({ source: 'demo', now: this.now });
    this.hub.onStop(() => this.stop());
  }

  static fromStore(store: Store, redactor: Redactor, opts: DemoLiveOptions = {}): DemoLiveSource {
    return new DemoLiveSource(loadDemoRuns(store), redactor, opts);
  }

  start(): void {
    this.stopped = false;
    this.playCycle();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private playCycle(): void {
    if (this.stopped) return;
    const items = buildDemoSchedule(this.runs, this.redactor, {
      seed: (this.opts.seed ?? 1) + this.cycle++,
      ...(this.opts.speed ? { speed: this.opts.speed } : {}),
    });
    if (items.length === 0) return;
    const t0 = this.now();
    let i = 0;
    const next = (): void => {
      if (this.stopped) return;
      const elapsed = this.now() - t0;
      while (i < items.length && items[i]!.atMs <= elapsed) {
        const { obs } = items[i++]!;
        this.hub.push({ ...obs, event: { ...obs.event, at: new Date(this.now()).toISOString() } });
      }
      if (i >= items.length) {
        this.timer = setTimeout(() => this.playCycle(), 4_000);
      } else {
        this.timer = setTimeout(next, Math.max(10, items[i]!.atMs - (this.now() - t0)));
      }
      this.timer.unref?.();
    };
    next();
  }
}
