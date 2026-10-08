/**
 * Pure layout and formatting for the Seasons view: where each season sits on the time axis of a
 * row, which season a scrubbed date falls in, and non-overlapping placement of per-season labels.
 */
import type { ISO, Season, SeasonStat, SeasonsView } from '@garden/core';

export const DAY_MS = 86_400_000;

export type Series = SeasonsView['series'][number];

export interface SeasonSpan {
  season: Season;
  stat: SeasonStat | null;
  /** Index within the row (0 = first season shown). */
  index: number;
  /** Visible span on the time axis, ms since epoch, clipped to the window. */
  t0: number;
  t1: number;
}

/**
 * The spans one row draws. A season runs from its start until the next season of the row starts
 * (or its own end, or the window end), clipped to the window. Rows are per agent, so this is the
 * harness as that agent experienced it.
 */
export function rowSpans(view: SeasonsView, s: Series): SeasonSpan[] {
  const w0 = Date.parse(view.window.from);
  const w1 = Date.parse(view.window.to);
  const byId = new Map(view.seasons.map((x) => [x.harnessVersionId, x]));
  const items = s.perSeason
    .map((stat) => ({ stat, season: byId.get(stat.harnessVersionId) }))
    .filter((x): x is { stat: SeasonStat; season: Season } => !!x.season);
  return items.map(({ stat, season }, i) => {
    const next = items[i + 1]?.season.from;
    const end = next ?? season.to ?? view.window.to;
    return {
      season,
      stat,
      index: i,
      t0: Math.max(w0, Date.parse(season.from)),
      t1: Math.max(Math.max(w0, Date.parse(season.from)), Math.min(w1, Date.parse(end))),
    };
  });
}

/** Seasons of the bed's primary chain (the first row's agent): the band at the top. */
export function primaryChain(view: SeasonsView): Season[] {
  const first = view.series[0];
  if (!first) return view.seasons;
  const ids = new Set(first.perSeason.map((p) => p.harnessVersionId));
  return view.seasons.filter((s) => ids.has(s.harnessVersionId));
}

/** The span containing time `t`, or null. */
export function spanAt(spans: readonly SeasonSpan[], t: number): SeasonSpan | null {
  return (
    spans.find((s) => t >= s.t0 && t < s.t1) ?? (spans.at(-1)?.t1 === t ? spans.at(-1)! : null)
  );
}

/**
 * Place labels of width `widths[i]` as close to `desired[i]` (left edge, px) as possible, left to
 * right, without overlapping and within [0, max]. Returns left edges.
 */
export function layoutLabels(
  desired: readonly number[],
  widths: readonly number[],
  max: number,
  gap = 6,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < desired.length; i++) {
    const prev = i ? out[i - 1]! + widths[i - 1]! + gap : 0;
    out.push(Math.max(prev, Math.min(desired[i]!, max - widths[i]!)));
  }
  // Pull back from the right edge if the chain overflowed.
  for (let i = out.length - 1; i >= 0; i--) {
    const limit = i === out.length - 1 ? max - widths[i]! : out[i + 1]! - gap - widths[i]!;
    if (out[i]! > limit) out[i] = Math.max(0, limit);
  }
  return out;
}

/** Day index (0 = window start day) → the end of that UTC day, the "as of" a garden is built at. */
export function dayToAsOf(view: SeasonsView, day: number): ISO {
  const start = Date.parse(view.window.from.slice(0, 10) + 'T00:00:00.000Z');
  const t = Math.min(Date.parse(view.window.to), start + (day + 1) * DAY_MS - 1);
  return new Date(t).toISOString();
}

export function dayCount(view: SeasonsView): number {
  const start = Date.parse(view.window.from.slice(0, 10) + 'T00:00:00.000Z');
  return Math.max(1, Math.ceil((Date.parse(view.window.to) - start) / DAY_MS));
}

export function dayOf(view: SeasonsView, iso: ISO): number {
  const start = Date.parse(view.window.from.slice(0, 10) + 'T00:00:00.000Z');
  return Math.max(0, Math.min(dayCount(view) - 1, Math.floor((Date.parse(iso) - start) / DAY_MS)));
}

/**
 * Default scrub position: the last full day before the most recent season boundary of the primary
 * chain, so "View garden as of this date" shows the garden just before the latest change.
 */
export function defaultScrubDay(view: SeasonsView): number {
  const chain = primaryChain(view).filter((s) => s.from > view.window.from);
  const last = chain.at(-1);
  if (!last) return dayCount(view) - 1;
  return Math.max(0, dayOf(view, last.from) - 1);
}

/** "Season 2 of 3" style label for the primary chain at a date. */
export function seasonIndexAt(view: SeasonsView, iso: ISO): number {
  const chain = primaryChain(view);
  let idx = -1;
  chain.forEach((s, i) => {
    if (s.from <= iso) idx = i;
  });
  return idx;
}

export const PROVENANCE_LABEL: Record<Season['provenance'], string> = {
  git: 'git commit',
  observed: 'observed in transcripts',
  snapshot: 'config snapshot',
};

/** "main", "main · loop nightly-flaky-triage". */
export function seriesLabel(s: Series): string {
  return s.loop ? `${s.agentName} · loop ${s.loop.name}` : s.agentName;
}

export function seriesKey(s: Series): string {
  return `${s.agentId}:${s.loop?.id ?? ''}`;
}
