/**
 * Pure live-overlay model: joins live agents to the garden (agent → plant), groups them per plant,
 * and decides what each live channel shows (encodings `live.*`). No Pixi, no DOM, no timers, so the
 * renderer overlay (garden/live-overlay.ts) and the DOM chrome read the same answers.
 */
import {
  liveActivity,
  liveRing,
  liveWorking,
  LIVE_GLYPH_ACTIVITIES,
  type GardenView,
  type ID,
  type LiveActivity,
  type LiveAgent,
  type LiveSnapshot,
} from '@garden/core';

export type GlyphKind = (typeof LIVE_GLYPH_ACTIVITIES)[number];

/** Activity → ink mark above the plant, or null when another channel draws the state. */
export function glyphFor(activity: LiveActivity): GlyphKind | null {
  const i = liveActivity.level({ activity });
  return i < 0 ? null : LIVE_GLYPH_ACTIVITIES[i]!;
}

export type Anchor =
  | { kind: 'plant'; plantId: ID; bedId: ID }
  | { kind: 'seedling'; bedId: ID; agentName: string }
  | { kind: 'offstage' };

/**
 * Where a live agent attaches: its `plantId` when that plant is in the view, else the plant in its
 * bed with the same agent name, else a seedling in its bed (no planting yet), else off-stage (its
 * bed is not in this garden window).
 */
export function anchorFor(agent: LiveAgent, view: GardenView): Anchor {
  if (agent.plantId) {
    const p = view.plants.find((x) => x.id === agent.plantId);
    if (p) return { kind: 'plant', plantId: p.id, bedId: p.bedId };
  }
  const byName = view.plants.find((x) => x.bedId === agent.bedId && x.name === agent.agentName);
  if (byName) return { kind: 'plant', plantId: byName.id, bedId: byName.bedId };
  if (view.beds.some((b) => b.id === agent.bedId))
    return { kind: 'seedling', bedId: agent.bedId, agentName: agent.agentName };
  return { kind: 'offstage' };
}

export function anchorKey(a: Anchor): string {
  return a.kind === 'plant'
    ? a.plantId
    : a.kind === 'seedling'
      ? `seed:${a.bedId}:${a.agentName}`
      : 'offstage';
}

/**
 * Was this wait recorded or guessed? Hook events, the session registry's `waiting` status, and an
 * open AskUserQuestion / ExitPlanMode call (the tool is the question) are recorded. Everything else
 * in transcript or demo mode is inferred from silence or an end of turn.
 */
export function waitInferred(agent: LiveAgent, source: LiveSnapshot['source']): boolean {
  if (source === 'hooks') return false;
  if (/^session registry/i.test(agent.evidence)) return false;
  if (
    agent.activity === 'waiting_input' &&
    /AskUserQuestion|ExitPlanMode/.test(`${agent.currentTool?.name ?? ''} ${agent.evidence}`)
  )
    return false;
  return true;
}

export interface Attention {
  reason: 'waiting_permission' | 'waiting_input';
  inferred: boolean;
}

export function attentionOf(agent: LiveAgent, source: LiveSnapshot['source']): Attention | null {
  if (agent.activity !== 'waiting_permission' && agent.activity !== 'waiting_input') return null;
  return { reason: agent.activity, inferred: waitInferred(agent, source) };
}

/** Urgency for choosing which agent a shared plant shows: lower first. */
function urgency(a: LiveAgent): number {
  if (a.activity === 'waiting_permission') return 0;
  if (a.activity === 'waiting_input') return 1;
  if (a.activity === 'errored') return 2;
  if (liveWorking(a.activity)) return 3;
  return 4;
}

export interface LiveMark {
  key: string;
  anchor: Exclude<Anchor, { kind: 'offstage' }>;
  /** Most urgent first; `agents[0]` is what the ring and tag show. */
  agents: LiveAgent[];
  primary: LiveAgent;
  /** 0..1 prompt size ÷ window of the primary agent. */
  fill: number;
  /** `live.ring` level. */
  ringLevel: number;
  glyph: GlyphKind | null;
  attention: Attention | null;
  /** Errors this turn of the primary agent. */
  errors: number;
  errored: boolean;
  compacting: boolean;
  count: number;
}

export function fillOf(a: Pick<LiveAgent, 'contextTokens' | 'contextWindow'>): number {
  return a.contextWindow > 0 ? Math.max(0, Math.min(1, a.contextTokens / a.contextWindow)) : 0;
}

/** Group the snapshot's agents per anchor and decide each channel. */
export function overlayMarks(
  view: GardenView,
  snap: LiveSnapshot,
): { marks: LiveMark[]; offstage: LiveAgent[] } {
  const groups = new Map<string, { anchor: LiveMark['anchor']; agents: LiveAgent[] }>();
  const offstage: LiveAgent[] = [];
  for (const a of snap.agents) {
    const anc = anchorFor(a, view);
    if (anc.kind === 'offstage') {
      offstage.push(a);
      continue;
    }
    const k = anchorKey(anc);
    const g = groups.get(k) ?? { anchor: anc, agents: [] };
    g.agents.push(a);
    groups.set(k, g);
  }
  const marks: LiveMark[] = [];
  for (const [key, g] of groups) {
    const agents = [...g.agents].sort(
      (x, y) =>
        urgency(x) - urgency(y) ||
        Date.parse(y.lastEventAt) - Date.parse(x.lastEventAt) ||
        x.key.localeCompare(y.key),
    );
    const p = agents[0]!;
    marks.push({
      key,
      anchor: g.anchor,
      agents,
      primary: p,
      fill: fillOf(p),
      ringLevel: liveRing.level(p),
      glyph: glyphFor(p.activity),
      attention: attentionOf(p, snap.source),
      errors: p.errors,
      errored: p.activity === 'errored',
      compacting: p.activity === 'compacting',
      count: agents.length,
    });
  }
  marks.sort((a, b) => a.key.localeCompare(b.key));
  return { marks, offstage };
}

export interface LiveBeeSpec {
  /** The child agent's key. */
  key: ID;
  from: string;
  to: string;
  /** The child is still working (hover) or finished (fly back). */
  returning: boolean;
}

/**
 * One live bee per subagent whose parent is live and both sit on the canvas, flying from the
 * parent's mark to the child's mark. A child that is done or errored sends its bee back.
 */
export function liveBees(view: GardenView, snap: LiveSnapshot): LiveBeeSpec[] {
  const byKey = new Map(snap.agents.map((a) => [a.key, a]));
  const out: LiveBeeSpec[] = [];
  for (const c of snap.agents) {
    if (c.agentKind !== 'subagent' || !c.parentKey) continue;
    const parent = byKey.get(c.parentKey);
    if (!parent) continue;
    const from = anchorFor(parent, view);
    const to = anchorFor(c, view);
    if (from.kind === 'offstage' || to.kind === 'offstage') continue;
    out.push({
      key: c.key,
      from: anchorKey(from),
      to: anchorKey(to),
      returning: c.activity === 'done' || c.activity === 'errored',
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Loops that just started a run: agents not seen before (`seen`) that carry a loop, matched to the
 * view's channels by id, then by name. Mutates `seen` to include every current agent.
 */
export function newLoopRuns(view: GardenView, snap: LiveSnapshot, seen: Set<ID>): ID[] {
  const out = new Set<ID>();
  for (const a of snap.agents) {
    if (seen.has(a.key)) continue;
    seen.add(a.key);
    if (!a.loop || a.agentKind !== 'main') continue;
    const ch =
      (a.loop.id ? view.loops.find((l) => l.loopId === a.loop!.id) : undefined) ??
      view.loops.find((l) => l.name === a.loop!.name);
    if (ch) out.add(ch.loopId);
  }
  return [...out];
}

/** A compaction cut: the prompt dropped by more than a third, or the agent is compacting. */
export function isCompactionCut(prevFill: number | undefined, a: LiveAgent): boolean {
  if (a.activity === 'compacting') return true;
  if (prevFill === undefined) return false;
  return prevFill > 0.05 && fillOf(a) < prevFill * (2 / 3);
}

/** Bed-level summary for the far zoom and the status pill. */
export function liveCounts(snap: LiveSnapshot | null): {
  agents: number;
  working: number;
  waiting: number;
} {
  if (!snap) return { agents: 0, working: 0, waiting: 0 };
  let working = 0;
  let waiting = 0;
  for (const a of snap.agents) {
    if (a.activity === 'waiting_permission' || a.activity === 'waiting_input') waiting++;
    else if (liveWorking(a.activity)) working++;
  }
  return { agents: snap.agents.length, working, waiting };
}

const ACTIVITY_LABEL: Record<LiveActivity, string> = {
  idle: 'idle',
  thinking: 'thinking',
  reading: 'reading',
  searching: 'searching',
  editing: 'editing',
  running: 'running a command',
  web: 'on the web',
  mcp: 'calling an MCP connector',
  skill: 'using a skill',
  delegating: 'delegating to a subagent',
  waiting_permission: 'waiting for permission',
  waiting_input: 'waiting for your input',
  compacting: 'compacting context',
  errored: 'hit an error',
  done: 'done',
};

export function activityLabel(a: LiveActivity): string {
  return ACTIVITY_LABEL[a];
}

/** "8 s", "2 min 05 s", "1 h 03 min". */
export function formatWait(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}
