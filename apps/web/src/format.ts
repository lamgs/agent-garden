/** Formatting shared by tooltips, the plant panel, and the table view (same numbers everywhere). */
import type { PlantSummary, Rate } from '@garden/core';

export function pct(v: number, digits = 0): string {
  return `${(v * 100).toFixed(digits)}%`;
}

/** "63% (95% CI 57–68%, n=313; 5 unknown, 0 manual)". Small n is always visible. */
export function formatRate(r: Rate): string {
  const counts = `n=${r.n}; ${r.nUnknown} unknown, ${r.nManual} manual`;
  if (r.value === null) return `no labeled runs (${counts})`;
  const ci = r.ci95 ? `95% CI ${pct(r.ci95[0])}–${pct(r.ci95[1])}, ` : '';
  return `${pct(r.value)} (${ci}${counts})`;
}

export function formatUsd(v: number): string {
  if (v === 0) return '$0';
  if (Math.abs(v) < 0.01) return `$${v.toPrecision(2)}`;
  if (Math.abs(v) < 1) return `$${v.toFixed(3)}`;
  if (Math.abs(v) < 100) return `$${v.toFixed(2)}`;
  return `$${Math.round(v).toLocaleString('en-US')}`;
}

export const ESTIMATE_NOTE = 'estimated: some runs only recorded stream-start output tokens';

/** Cost per run with the "estimated" marker and unpriced runs called out. */
export function formatCostPerRun(p: PlantSummary): string {
  if (p.costPerRunUsd === null) {
    return p.unpricedRuns > 0 ? `unknown (${p.unpricedRuns} unpriced runs)` : 'unknown';
  }
  let s = `${formatUsd(p.costPerRunUsd)} per run (median)`;
  if (p.costEstimated) s += ` (${ESTIMATE_NOTE})`;
  if (p.unpricedRuns > 0) s += `; ${p.unpricedRuns} unpriced runs excluded`;
  return s;
}

export function formatTotalCost(p: PlantSummary): string {
  if (p.totalCostUsd === null) return 'unknown';
  return `${formatUsd(p.totalCostUsd)}${p.costEstimated ? ' (estimated)' : ''}`;
}

export function formatLastRun(p: Pick<PlantSummary, 'lastRunAt' | 'staleDays'>): string {
  if (!p.lastRunAt) return 'never in this window';
  const day = p.lastRunAt.slice(0, 10);
  return p.staleDays === null ? day : `${day} (${formatDays(p.staleDays)} ago)`;
}

export function formatDays(d: number): string {
  if (d < 1) return '<1 d';
  return `${Math.round(d)} d`;
}

export function formatShare(v: number | null): string {
  return v === null ? 'no labeled runs in the last 14 days' : pct(v);
}

export function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  return `${(b / 1024).toFixed(1)} KB`;
}

export function formatInt(n: number): string {
  return n.toLocaleString('en-US');
}

/** "claude-sonnet-5-5" → "sonnet 5.5"; unknown shapes pass through. */
export function shortModel(model: string | undefined): string {
  if (!model) return 'unknown model';
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model);
  if (!m) return model;
  return `${m[1]} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

export function bedLabel(b: { name: string; soil: { model?: string; effort?: string } }): string {
  return `${b.name} · ${shortModel(b.soil.model)} · ${b.soil.effort ?? 'default effort'}`;
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
