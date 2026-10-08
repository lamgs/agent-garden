/**
 * Seasons: a bed's harness history cut into periods of one harness, with outcomes per period.
 *
 * Segmentation is per (bed, primary agent) chain, the same chains the derive pass builds: a
 * harness is the environment one agent runs inside, so main-thread and subagent harnesses do not
 * interleave. Consecutive versions with no meaningful difference (e.g. only the entrypoint moved)
 * merge into one season, so every season boundary is a real change to the soil.
 *
 * Runs are attributed to seasons by the harness version they ran under, never by timestamp: a run
 * that started on the old harness after the new one first appeared still counts for the old season.
 */
import type {
  BedSummary,
  GardenView,
  HarnessBundle,
  HarnessDiff,
  ModelPrice,
  Rate,
  RateDelta,
  Season,
  SeasonStat,
  SeasonsView,
} from '@garden/core';
import { median } from '@garden/core';
import { summarizeDiff } from '@garden/ingest';
import { diffBundles } from '@garden/ingest/harness';
import type { GardenData, RunRow } from './data';
import { plantId, rateOf, runCost } from './garden';

export const SEASONS_CAVEAT =
  'Correlation, not causation: a season boundary lines up a harness change with a change in outcomes, ' +
  'but the work itself may have changed too (different tasks, a new teammate, a quieter month). ' +
  'Read the runs on both sides before crediting the harness.';

type Version = GardenData['versions'][number];

/** One chain's seasons with the versions each one merged. */
export interface Segment {
  season: Season;
  versionIds: string[];
  /** Bundle of the season's first version: what the soil was. */
  bundle: HarnessBundle;
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');

/**
 * What changed between two bundles, as display lines. Extends `summarizeDiff` with changes the
 * stored diff does not count: instruction files edited without a size change, and subagent
 * definitions added or removed. Empty means "no meaningful change".
 */
export function meaningfulChanges(prev: HarnessBundle, next: HarnessBundle): string[] {
  const d = diffBundles(prev, next);
  const out = summarizeDiff(d);
  if (
    d.instructionBytesDelta === 0 &&
    !sameSet(
      prev.instructions.map((i) => i.hash),
      next.instructions.map((i) => i.hash),
    )
  )
    out.push('instructions edited (same size)');
  const subAdded = next.subagents.filter((s) => !prev.subagents.includes(s)).length;
  const subRemoved = prev.subagents.filter((s) => !next.subagents.includes(s)).length;
  if (subAdded || subRemoved) out.push(`subagents +${subAdded} −${subRemoved}`);
  return out;
}

const firstLine = (s: string) => s.split('\n')[0]!.trim();

/** "claude-sonnet-5-5" → "sonnet 5.5". */
export function shortModelName(model: string | undefined): string {
  if (!model) return '∅';
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model);
  return m ? `${m[1]} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : model;
}

const kb = (bytes: number) =>
  Math.abs(bytes) < 1024 ? `${Math.abs(bytes)} B` : `${(Math.abs(bytes) / 1024).toFixed(1)} KB`;

/** A title generated from the diff when there is no commit subject to use. */
export function titleFromDiff(d: HarnessDiff, changes: readonly string[]): string {
  const parts: string[] = [];
  if (d.modelChanged)
    parts.push(
      `Model: ${shortModelName(d.modelChanged.from)} → ${shortModelName(d.modelChanged.to)}`,
    );
  if (d.effortChanged)
    parts.push(`Effort: ${d.effortChanged.from ?? '∅'} → ${d.effortChanged.to ?? '∅'}`);
  if (d.permissionModeChanged)
    parts.push(
      `Permissions: ${d.permissionModeChanged.from ?? '∅'} → ${d.permissionModeChanged.to ?? '∅'}`,
    );
  if (d.instructionBytesDelta)
    parts.push(
      `CLAUDE.md ${d.instructionBytesDelta > 0 ? '+' : '−'}${kb(d.instructionBytesDelta)}`,
    );
  if (d.mcpAdded.length || d.mcpRemoved.length)
    parts.push(
      `MCP ${[...d.mcpAdded.map((m) => `+${m}`), ...d.mcpRemoved.map((m) => `−${m}`)].join(' ')}`,
    );
  if (d.toolsAdded.length || d.toolsRemoved.length)
    parts.push(`Tools +${d.toolsAdded.length} −${d.toolsRemoved.length}`);
  if (d.skillsAdded.length || d.skillsRemoved.length)
    parts.push(`Skills +${d.skillsAdded.length} −${d.skillsRemoved.length}`);
  if (d.hooksChanged) parts.push('Hooks changed');
  if (d.settingsChanged) parts.push('Settings changed');
  if (!parts.length && changes.length)
    parts.push(changes[0]!.replace(/^./, (c) => c.toUpperCase()));
  if (!parts.length) return 'Harness changed';
  return parts.length > 2
    ? `${parts.slice(0, 2).join(', ')} (+${parts.length - 2} more)`
    : parts.join(', ');
}

/**
 * Cut one chain (versions of one bed + primary agent, any order) into seasons.
 * Versions are ordered by first use; a version identical in every meaningful way to the season
 * before it merges into that season.
 */
export function segmentChain(chain: readonly Version[]): Segment[] {
  const sorted = [...chain].sort(
    (a, b) => a.validFrom.localeCompare(b.validFrom) || a.id.localeCompare(b.id),
  );
  const out: Segment[] = [];
  let lastBundle: HarnessBundle | null = null;
  let lastSha: string | null = null;
  for (const v of sorted) {
    const prev = out.at(-1);
    const changes = lastBundle ? meaningfulChanges(lastBundle, v.bundle) : [];
    if (prev && changes.length === 0) {
      // Same soil: extend the current season.
      prev.versionIds.push(v.id);
      prev.season.to = v.validTo;
      if (v.provenance === 'git' && prev.season.provenance !== 'git')
        prev.season.provenance = 'git';
      lastBundle = v.bundle;
      lastSha = v.commitSha ?? lastSha;
      continue;
    }
    const sha = v.commitSha ?? null;
    const commitTitle =
      v.provenance === 'git' && v.commitMessage && (!prev || (sha !== null && sha !== lastSha))
        ? firstLine(v.commitMessage)
        : null;
    const title =
      commitTitle ??
      (lastBundle
        ? titleFromDiff(diffBundles(lastBundle, v.bundle), changes)
        : v.provenance === 'observed'
          ? 'First observed harness'
          : 'First recorded harness');
    out.push({
      season: {
        harnessVersionId: v.id,
        agentId: v.primaryAgentId ?? '',
        from: v.validFrom,
        to: v.validTo,
        provenance: v.provenance,
        title,
        diffSummary: changes,
      },
      versionIds: [v.id],
      bundle: v.bundle,
    });
    lastBundle = v.bundle;
    lastSha = sha ?? lastSha;
  }
  return out;
}

/** Same logic as bed compare: delta right − left, "separated" when the Wilson intervals don't overlap. */
export function rateDeltaOf(a: Rate | null | undefined, b: Rate | null | undefined): RateDelta {
  if (a?.value == null || b?.value == null) return { delta: null, separated: false };
  const separated = !!a.ci95 && !!b.ci95 && (a.ci95[1] < b.ci95[0] || b.ci95[1] < a.ci95[0]);
  return { delta: b.value - a.value, separated };
}

export function seasonStat(
  harnessVersionId: string,
  runs: readonly RunRow[],
  prev: SeasonStat | null,
  pricing?: Record<string, ModelPrice>,
): SeasonStat {
  const success = rateOf(runs);
  const priced = runs.map((r) => runCost(r, pricing)).filter((c): c is number => c !== null);
  return {
    harnessVersionId,
    success,
    costPerRunUsd: median(priced),
    costEstimated: runs.some((r) => r.tokenQuality === 'output_estimated'),
    runs: runs.length,
    vsPrevious: prev ? rateDeltaOf(prev.success, success) : null,
  };
}

export interface SeasonsOptions {
  window: { from: string; to: string };
  pricing?: Record<string, ModelPrice>;
}

/**
 * Pure builder: the Seasons view of one bed. `data.runs` must already be limited to the window.
 * Returns null for an unknown bed (or one with no runs in the window).
 */
export function buildSeasonsView(
  data: GardenData,
  garden: GardenView,
  familyId: string,
  opts: SeasonsOptions,
): SeasonsView | null {
  const bed: BedSummary | undefined = garden.beds.find((b) => b.id === familyId);
  if (!bed) return null;
  const { from, to } = opts.window;
  const agentById = new Map(data.agents.map((a) => [a.id, a]));
  const loopById = new Map(data.loops.map((l) => [l.id, l]));
  const mainAgentId = data.agents.find((a) => a.name === 'main')?.id;

  // 1. Chains per primary agent, segmented.
  const chains = new Map<string, Version[]>();
  for (const v of data.versions) {
    if (v.familyId !== familyId || !v.primaryAgentId) continue;
    chains.set(v.primaryAgentId, [...(chains.get(v.primaryAgentId) ?? []), v]);
  }
  const segmentOf = new Map<string, Segment>(); // version id → its season
  const segmentsByChain = new Map<string, Segment[]>();
  for (const [agentId, chain] of chains) {
    const segs = segmentChain(chain);
    segmentsByChain.set(agentId, segs);
    for (const s of segs) for (const id of s.versionIds) segmentOf.set(id, s);
  }

  // 2. Series: one per agent, with loop-triggered runs split into their own rows (a loop repeats
  //    one task, so mixing it in would let a change in loop volume move the agent's rate).
  const runs = data.runs.filter((r) => r.familyId === familyId);
  const groups = new Map<string, RunRow[]>();
  for (const r of runs) {
    const key = `${r.agentId}\u0000${r.loopId ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const plantIds = new Set(garden.plants.map((p) => p.id));
  const usedChains = new Set<string>();
  const series: SeasonsView['series'] = [];
  for (const [key, rs] of groups) {
    const [agentId, loopId] = key.split('\u0000') as [string, string];
    const byVersion = new Map<Segment, RunRow[]>();
    for (const r of rs) {
      const seg = segmentOf.get(r.harnessVersionId);
      if (!seg) continue; // no recorded harness version for this run (counted nowhere)
      byVersion.set(seg, [...(byVersion.get(seg) ?? []), r]);
    }
    // Every season of each chain this series ran in (so a season with zero runs still shows).
    const chainIds = new Set([...byVersion.keys()].map((s) => s.season.agentId));
    const segs = [...chainIds]
      .flatMap((c) => segmentsByChain.get(c) ?? [])
      .filter((s) => s.season.from <= to && (s.season.to === null || s.season.to >= from))
      .sort((a, b) => a.season.from.localeCompare(b.season.from));
    for (const c of chainIds) usedChains.add(c);
    const perSeason: SeasonStat[] = [];
    for (const s of segs)
      perSeason.push(
        seasonStat(
          s.season.harnessVersionId,
          byVersion.get(s) ?? [],
          perSeason.at(-1) ?? null,
          opts.pricing,
        ),
      );
    const agent = agentById.get(agentId);
    const loop = loopId ? loopById.get(loopId) : undefined;
    const pid = plantId(agentId, familyId);
    series.push({
      agentId,
      agentName: agent?.name ?? 'unknown agent',
      plantId: plantIds.has(pid) ? pid : null,
      ...(loopId ? { loop: { id: loopId, name: loop?.name ?? loopId } } : {}),
      perSeason,
    });
  }
  const runsOf = (s: SeasonsView['series'][number]) => s.perSeason.reduce((n, p) => n + p.runs, 0);
  const rank = (s: SeasonsView['series'][number]) => (s.agentId === mainAgentId ? 0 : 1);
  const agentRuns = new Map<string, number>();
  for (const s of series) agentRuns.set(s.agentId, (agentRuns.get(s.agentId) ?? 0) + runsOf(s));
  series.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (agentRuns.get(b.agentId) ?? 0) - (agentRuns.get(a.agentId) ?? 0) ||
      a.agentName.localeCompare(b.agentName) ||
      (a.loop ? 1 : 0) - (b.loop ? 1 : 0) ||
      (a.loop?.name ?? '').localeCompare(b.loop?.name ?? ''),
  );

  // 3. Seasons of every chain shown, main chain first, each chain in time order.
  const chainOrder = [...usedChains].sort(
    (a, b) =>
      (a === mainAgentId ? 0 : 1) - (b === mainAgentId ? 0 : 1) ||
      (agentRuns.get(b) ?? 0) - (agentRuns.get(a) ?? 0) ||
      a.localeCompare(b),
  );
  const seasons = chainOrder.flatMap((c) =>
    (segmentsByChain.get(c) ?? [])
      .filter((s) => s.season.from <= to && (s.season.to === null || s.season.to >= from))
      .map((s) => s.season),
  );

  return { familyId, bed, window: { from, to }, seasons, series, caveat: SEASONS_CAVEAT };
}
