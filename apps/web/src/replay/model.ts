/**
 * Pure replay view-model: lanes (the run tree flattened), one time-ordered list of every step
 * across lanes (the playback order), and the compressed time axis. No DOM, no drawing.
 */
import type { ID, ReplayFrame, ReplayView } from '@garden/core';

/** Gaps between consecutive steps longer than this are compressed. */
export const IDLE_THRESHOLD_MS = 15_000;
/** Display width of a compressed gap. */
export const COMPRESSED_GAP_MS = 4_000;

export interface Lane {
  index: number;
  runId: ID;
  depth: number;
  /** Lane index of the parent run (null for the main run). */
  parent: number | null;
  view: ReplayView;
  /** Absolute ms. */
  start: number;
  end: number;
  /** Frame index in the parent's frames that spawned this run. */
  spawnFrame: number | null;
}

export interface FlatStep {
  lane: number;
  /** Index into `lanes[lane].view.frames`. */
  frame: number;
  /** Absolute ms. */
  at: number;
}

export interface Gap {
  /** Display ms where the compressed gap starts. */
  at: number;
  realMs: number;
}

export interface Timeline {
  start: number;
  end: number;
  /** Total display length (ms). */
  total: number;
  gaps: Gap[];
  /** Absolute ms → display ms. */
  toDisplay: (abs: number) => number;
  /** Display ms → absolute ms (inside a compressed gap: interpolated across the real gap). */
  toAbs: (display: number) => number;
}

export interface ReplayModel {
  lanes: Lane[];
  steps: FlatStep[];
  timeline: Timeline;
}

export function flattenLanes(root: ReplayView): Lane[] {
  const lanes: Lane[] = [];
  const visit = (
    v: ReplayView,
    depth: number,
    parent: number | null,
    spawnFrame: number | null,
  ) => {
    const start = Date.parse(v.run.startedAt);
    const lastT = v.frames.at(-1)?.t ?? 0;
    const end = Math.max(start + v.run.durationMs, start + lastT);
    const index = lanes.length;
    lanes.push({ index, runId: v.run.runId, depth, parent, view: v, start, end, spawnFrame });
    const byId = new Map(v.children.map((c) => [c.run.runId, c]));
    const done = new Set<ID>();
    v.frames.forEach((f, i) => {
      const c = f.forkRunId ? byId.get(f.forkRunId) : undefined;
      if (c && !done.has(c.run.runId)) {
        done.add(c.run.runId);
        visit(c, depth + 1, index, i);
      }
    });
    for (const c of v.children) if (!done.has(c.run.runId)) visit(c, depth + 1, index, null);
  };
  visit(root, 0, null, null);
  return lanes;
}

/** Piecewise-linear time axis over sorted instants; long idle gaps get a fixed width. */
export function buildTimeline(instants: readonly number[]): Timeline {
  const pts = [...new Set(instants.filter((x) => Number.isFinite(x)))].sort((a, b) => a - b);
  if (pts.length === 0) pts.push(0);
  const disp: number[] = [0];
  const gaps: Gap[] = [];
  for (let i = 1; i < pts.length; i++) {
    const g = pts[i]! - pts[i - 1]!;
    const d = g > IDLE_THRESHOLD_MS ? COMPRESSED_GAP_MS : g;
    if (g > IDLE_THRESHOLD_MS) gaps.push({ at: disp[i - 1]!, realMs: g });
    disp.push(disp[i - 1]! + d);
  }
  const toDisplay = (abs: number): number => {
    if (abs <= pts[0]!) return 0;
    if (abs >= pts.at(-1)!) return disp.at(-1)!;
    let lo = 0;
    let hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid]! <= abs) lo = mid;
      else hi = mid;
    }
    const span = pts[hi]! - pts[lo]!;
    return disp[lo]! + (span === 0 ? 0 : ((abs - pts[lo]!) / span) * (disp[hi]! - disp[lo]!));
  };
  const toAbs = (d: number): number => {
    if (d <= 0) return pts[0]!;
    if (d >= disp.at(-1)!) return pts.at(-1)!;
    let lo = 0;
    let hi = disp.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (disp[mid]! <= d) lo = mid;
      else hi = mid;
    }
    const span = disp[hi]! - disp[lo]!;
    return pts[lo]! + (span === 0 ? 0 : ((d - disp[lo]!) / span) * (pts[hi]! - pts[lo]!));
  };
  return { start: pts[0]!, end: pts.at(-1)!, total: disp.at(-1)!, gaps, toDisplay, toAbs };
}

export function buildModel(root: ReplayView): ReplayModel {
  const lanes = flattenLanes(root);
  const steps: FlatStep[] = [];
  const instants: number[] = [];
  for (const l of lanes) {
    instants.push(l.start, l.end);
    l.view.frames.forEach((f, i) => {
      steps.push({ lane: l.index, frame: i, at: l.start + f.t });
      instants.push(l.start + f.t);
    });
  }
  // Time order; ties keep lane order (parent before child), then frame order.
  steps.sort((a, b) => a.at - b.at || a.lane - b.lane || a.frame - b.frame);
  return { lanes, steps, timeline: buildTimeline(instants) };
}

export const frameOf = (m: ReplayModel, s: FlatStep): ReplayFrame =>
  m.lanes[s.lane]!.view.frames[s.frame]!;

/** Last playback step at or before a display time (−1 before the first step). */
export function stepAtDisplay(m: ReplayModel, display: number): number {
  let lo = -1;
  let hi = m.steps.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (m.timeline.toDisplay(m.steps[mid]!.at) <= display) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Position of a playback step in the flat list, for the frame `frame` of lane `lane`. */
export function stepIndexOf(m: ReplayModel, lane: number, frame: number): number {
  return m.steps.findIndex((s) => s.lane === lane && s.frame === frame);
}

/** The latest frame of a lane reached by playback step `index` (null before the lane starts). */
export function laneFrameAt(m: ReplayModel, lane: number, index: number): number | null {
  let best: number | null = null;
  for (let i = 0; i <= index && i < m.steps.length; i++) {
    const s = m.steps[i]!;
    if (s.lane === lane) best = s.frame;
  }
  return best;
}

export function formatClock(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
