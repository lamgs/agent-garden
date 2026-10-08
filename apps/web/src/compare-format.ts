/**
 * Pure formatting for the plant, compare, and replant views: deltas in rate points, cost ratios,
 * the separated / within-noise badge, signal names, and the ordered "what changed in the soil" list.
 */
import type { HarnessDiff, Rate, RateDelta } from '@garden/core';
import { formatBytes, pct, shortModel } from './format';

export const MINUS = '−';

/** Signed number with a real minus sign. */
export function signed(v: number, digits = 0): string {
  const s = Math.abs(v).toFixed(digits);
  if (Number(s) === 0) return s;
  return `${v < 0 ? MINUS : '+'}${s}`;
}

/** Rate delta (−1..1) → "−65 points". */
export function formatPoints(delta: number | null): string {
  if (delta === null) return 'no comparison';
  const pts = Math.round(delta * 100);
  return `${signed(pts)} ${Math.abs(pts) === 1 ? 'point' : 'points'}`;
}

/** Cost ratio → "3.1×". */
export function formatRatio(r: number | null): string {
  if (r === null || !Number.isFinite(r)) return 'unknown';
  if (r >= 10) return `${Math.round(r)}×`;
  return `${r.toFixed(r < 1 ? 2 : 1)}×`;
}

/** "3.1× the cost per run" / "0.45× (cheaper)". */
export function describeRatio(r: number | null): string {
  if (r === null || !Number.isFinite(r)) return 'cost per run unknown on one side';
  if (Math.abs(r - 1) < 0.05) return 'about the same cost per run';
  return `${formatRatio(r)} the cost per run`;
}

export type BadgeKind = 'separated' | 'noise' | 'none';

export interface SeparationBadge {
  kind: BadgeKind;
  label: string;
  title: string;
}

export function separationBadge(d: RateDelta): SeparationBadge {
  if (d.delta === null) {
    return {
      kind: 'none',
      label: 'not comparable',
      title: 'One side has no labeled runs, so there is no rate to compare.',
    };
  }
  if (d.separated) {
    return {
      kind: 'separated',
      label: 'separated',
      title:
        "The two 95% Wilson intervals don't overlap: a difference this large is unlikely to be noise at these sample sizes.",
    };
  }
  return {
    kind: 'noise',
    label: 'within noise',
    title:
      'The two 95% Wilson intervals overlap: at these sample sizes the difference could be noise.',
  };
}

/** "85–96%" or "no interval". */
export function formatCi(r: Rate): string {
  return r.ci95 ? `${pct(r.ci95[0])}–${pct(r.ci95[1])}` : 'no interval';
}

export function formatWeight(w: number): string {
  return signed(w, 2);
}

const SIGNAL_NAMES: Record<string, string> = {
  tests_passed_after_last_edit: 'Tests passed after last edit',
  tests_failing_at_end: 'Tests failing at end',
  clean_finish: 'Clean finish',
  errors_in_tail: 'Unrecovered errors at the end',
  user_retried: 'User retried or corrected',
  user_moved_on: 'User moved on',
  shipped: 'Shipped (commit, push, or PR)',
  parent_respawned: 'Parent respawned the subagent',
};

/** Human name for a heuristic signal id; unknown ids are de-snaked. */
export function signalName(id: string): string {
  const known = SIGNAL_NAMES[id];
  if (known) return known;
  const s = id.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface SoilChange {
  key:
    | 'model'
    | 'instructions'
    | 'mcp'
    | 'hooks'
    | 'effort'
    | 'permissions'
    | 'tools'
    | 'skills'
    | 'settings'
    | 'other';
  title: string;
  detail?: string;
}

const ORDER: SoilChange['key'][] = [
  'model',
  'instructions',
  'mcp',
  'hooks',
  'effort',
  'permissions',
  'tools',
  'skills',
  'settings',
  'other',
];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const orNone = (s?: string) => s ?? '∅ (not set)';

function addRemove(added: string[], removed: string[], noun: string): SoilChange['title'] | null {
  if (!added.length && !removed.length) return null;
  const parts: string[] = [];
  if (added.length) parts.push(`+${plural(added.length, noun)}`);
  if (removed.length) parts.push(`${MINUS}${plural(removed.length, noun)}`);
  return parts.join(', ');
}

function keyOf(change: string): SoilChange['key'] {
  const head = change.toLowerCase();
  for (const k of ORDER) if (head.startsWith(k === 'mcp' ? 'mcp' : k)) return k;
  if (head.startsWith('permission')) return 'permissions';
  return 'other';
}

/**
 * The soil difference as a list, biggest items first (model, instructions, MCP, hooks, ...).
 * Structured from the HarnessDiff when available; otherwise from summarizeDiff's strings.
 */
export function soilChanges(diff: HarnessDiff | null, changes: readonly string[]): SoilChange[] {
  const out: SoilChange[] = [];
  if (diff) {
    if (diff.modelChanged) {
      out.push({
        key: 'model',
        title: `Model: ${diff.modelChanged.from ? shortModel(diff.modelChanged.from) : '∅'} → ${diff.modelChanged.to ? shortModel(diff.modelChanged.to) : '∅'}`,
        detail: `${orNone(diff.modelChanged.from)} → ${orNone(diff.modelChanged.to)}`,
      });
    }
    if (diff.instructionBytesDelta !== 0) {
      const d = diff.instructionBytesDelta;
      out.push({
        key: 'instructions',
        title: `Instructions ${d > 0 ? '+' : MINUS}${formatBytes(Math.abs(d))}`,
        detail: `CLAUDE.md chain ${d > 0 ? 'grew' : 'shrank'} by ${Math.abs(d).toLocaleString('en-US')} bytes`,
      });
    }
    const mcp = addRemove(diff.mcpAdded, diff.mcpRemoved, 'MCP server');
    if (mcp) {
      out.push({
        key: 'mcp',
        title: mcp,
        detail: [
          ...diff.mcpAdded.map((m) => `+${m}`),
          ...diff.mcpRemoved.map((m) => `${MINUS}${m}`),
        ].join(', '),
      });
    }
    if (diff.hooksChanged) out.push({ key: 'hooks', title: 'Hooks changed' });
    if (diff.effortChanged) {
      out.push({
        key: 'effort',
        title: `Effort: ${diff.effortChanged.from ?? 'default'} → ${diff.effortChanged.to ?? 'default'}`,
      });
    }
    if (diff.permissionModeChanged) {
      out.push({
        key: 'permissions',
        title: `Permission mode: ${diff.permissionModeChanged.from ?? 'default'} → ${diff.permissionModeChanged.to ?? 'default'}`,
      });
    }
    const tools = addRemove(diff.toolsAdded, diff.toolsRemoved, 'tool');
    if (tools) {
      out.push({
        key: 'tools',
        title: tools,
        detail: [
          ...diff.toolsAdded.map((m) => `+${m}`),
          ...diff.toolsRemoved.map((m) => `${MINUS}${m}`),
        ].join(', '),
      });
    }
    const skills = addRemove(diff.skillsAdded, diff.skillsRemoved, 'skill');
    if (skills) out.push({ key: 'skills', title: skills });
    if (diff.settingsChanged) {
      out.push({
        key: 'settings',
        title: 'Settings changed',
        detail: 'Detail not stored: settings may hold secrets.',
      });
    }
  } else {
    for (const c of changes)
      out.push({ key: keyOf(c), title: c.charAt(0).toUpperCase() + c.slice(1) });
  }
  return out
    .map((c, i) => ({ c, i }))
    .sort((a, b) => ORDER.indexOf(a.c.key) - ORDER.indexOf(b.c.key) || a.i - b.i)
    .map(({ c }) => c);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  const m = Math.round(s / 60);
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** "2026-09-28 13:50" (UTC, as stored). */
export function formatDateTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export function shareText(v: number | null): string {
  return v === null ? 'n/a' : pct(v);
}

/** "In legacy-monolith, test-writer’s success rate is 65 points lower, at 3.1× the cost per run." */
export function verdictSentence(
  agent: string,
  toBed: string,
  delta: number | null,
  ratio: number | null,
): string {
  if (delta === null) return `No success rate to compare for ${agent} in ${toBed}.`;
  const pts = Math.round(Math.abs(delta) * 100);
  const rate =
    pts === 0
      ? `${agent}’s success rate is about the same`
      : `${agent}’s success rate is ${pts} ${pts === 1 ? 'point' : 'points'} ${delta < 0 ? 'lower' : 'higher'}`;
  return `In ${toBed}, ${rate}, at ${describeRatio(ratio)}.`;
}
