/** Plant, bed-comparison, and replant views. Pure builders over GardenData + a few step aggregates. */
import {
  LOOP_TIERS,
  OUTCOME_LABELS,
  SIGNALS,
  type BedCompareView,
  type BedSummary,
  type GardenView,
  type HarnessSummary,
  type LoopTier,
  type ModelPrice,
  type OutcomeLabel,
  type PlantSummary,
  type PlantView,
  type RateDelta,
  type ReplantView,
  type RunRow as RunRowView,
  type SignalStat,
} from '@garden/core';
import { summarizeDiff } from '@garden/ingest';
import type { Store } from '@garden/ingest';
import { diffBundles } from '@garden/ingest/harness';
import type { GardenData, RunRow } from './data';
import { plantId, runCost } from './garden';

export const RUNS_CAP = 200;
export const CORRELATION_CAVEAT =
  'Correlation, not causation: the two sides may have handled different kinds of tasks. Compare the recent tasks before concluding the harness made the difference.';

type Version = GardenData['versions'][number];

export function harnessSummary(v: Version | undefined): HarnessSummary | null {
  if (!v) return null;
  const b = v.bundle;
  return {
    versionId: v.id,
    validFrom: v.validFrom,
    provenance: v.provenance,
    ...(b.model ? { model: b.model } : {}),
    ...(b.effort ? { effort: b.effort } : {}),
    ...(b.permissionMode ? { permissionMode: b.permissionMode } : {}),
    instructionBytes: b.instructions.reduce((n, i) => n + i.bytes, 0),
    toolCount: b.tools.length,
    tools: [...b.tools],
    mcpServers: [...b.mcpServers],
    skillCount: b.skills.length,
    hookCount: b.hooks.length,
    ...(v.commitMessage ? { commitMessage: v.commitMessage } : {}),
    changes: v.diff ? summarizeDiff(v.diff) : [],
  };
}

export function toRunRow(
  r: RunRow,
  data: Pick<GardenData, 'runs'>,
  pricing?: Record<string, ModelPrice>,
): RunRowView {
  const t = r.tokens;
  return {
    runId: r.id,
    startedAt: r.startedAt,
    durationMs: Math.max(0, Date.parse(r.endedAt) - Date.parse(r.startedAt)),
    taskPreview: r.taskPreview,
    trigger: r.trigger as RunRowView['trigger'],
    outcome: {
      label: r.label,
      score: r.score,
      source: r.manual ? 'manual' : 'heuristic',
      heuristicLabel: r.heuristicLabel,
      signals: r.signals,
      ...(r.manual && r.manualAt
        ? {
            manual: {
              label: r.label,
              at: r.manualAt,
              ...(r.manualNote ? { note: r.manualNote } : {}),
            },
          }
        : {}),
    },
    totalTokens: t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h,
    costUsd: runCost(r, pricing),
    costEstimated: r.tokenQuality === 'output_estimated',
    model: r.models[0] ?? null,
    toolCallCount: r.toolCallCount,
    errorCount: r.errorCount,
    childCount: data.runs.filter((c) => c.parentRunId === r.id).length,
  };
}

export function signalStats(runs: readonly RunRow[]): SignalStat[] {
  return SIGNALS.map((def) => {
    let fired = 0;
    let notFired = 0;
    let notApplicable = 0;
    for (const r of runs) {
      const s = r.signals.find((x) => x.id === def.id);
      if (!s || s.fired === null) notApplicable++;
      else if (s.fired) fired++;
      else notFired++;
    }
    return {
      id: def.id,
      weight: def.weight,
      description: def.description,
      fired,
      notFired,
      notApplicable,
    };
  });
}

export function rateDelta(a: PlantSummary | null, b: PlantSummary | null): RateDelta {
  const ra = a?.success;
  const rb = b?.success;
  if (ra?.value == null || rb?.value == null) return { delta: null, separated: false };
  const separated = !!ra.ci95 && !!rb.ci95 && (ra.ci95[1] < rb.ci95[0] || rb.ci95[1] < ra.ci95[0]);
  return { delta: rb.value - ra.value, separated };
}

const costRatio = (a: PlantSummary | null, b: PlantSummary | null): number | null =>
  a?.costPerRunUsd && b?.costPerRunUsd != null ? b.costPerRunUsd / a.costPerRunUsd : null;

function plantRuns(data: GardenData, agentId: string, familyId: string): RunRow[] {
  return data.runs.filter((r) => r.agentId === agentId && r.familyId === familyId);
}

function latestVersion(data: GardenData, runs: readonly RunRow[]): Version | undefined {
  const last = runs.reduce<RunRow | undefined>(
    (m, r) => (!m || r.startedAt > m.startedAt ? r : m),
    undefined,
  );
  return last ? data.versions.find((v) => v.id === last.harnessVersionId) : undefined;
}

/** Step aggregates for a set of runs (tiers, tool and MCP usage). */
export interface StepAggregates {
  tiers: Record<LoopTier, number>;
  tools: { name: string; calls: number }[];
  mcp: { name: string; calls: number }[];
}

export function loadStepAggregates(store: Store, runIds: readonly string[]): StepAggregates {
  const tiers = Object.fromEntries(LOOP_TIERS.map((t) => [t, 0])) as Record<LoopTier, number>;
  if (runIds.length === 0) return { tiers, tools: [], mcp: [] };
  const db = store.db;
  db.exec('CREATE TEMP TABLE IF NOT EXISTS sel_runs (id TEXT PRIMARY KEY)');
  db.exec('DELETE FROM sel_runs');
  const ins = db.prepare('INSERT OR IGNORE INTO sel_runs (id) VALUES (?)');
  for (const id of runIds) ins.run(id);
  for (const r of db
    .prepare(
      'SELECT loop_tier AS t, COUNT(*) AS n FROM steps WHERE run_id IN (SELECT id FROM sel_runs) GROUP BY loop_tier',
    )
    .all() as {
    t: LoopTier;
    n: number;
  }[])
    tiers[r.t] = Number(r.n);
  const tools = db
    .prepare(
      `SELECT tool_name AS name, COUNT(*) AS calls FROM steps WHERE run_id IN (SELECT id FROM sel_runs) AND kind IN ('tool_call','subagent_spawn')
        GROUP BY tool_name ORDER BY calls DESC, name LIMIT 12`,
    )
    .all() as { name: string; calls: number }[];
  const mcp = db
    .prepare(
      `SELECT mcp_server AS name, COUNT(*) AS calls FROM steps WHERE run_id IN (SELECT id FROM sel_runs) AND kind = 'tool_call' AND mcp_server IS NOT NULL
        GROUP BY mcp_server ORDER BY calls DESC, name`,
    )
    .all() as { name: string; calls: number }[];
  return {
    tiers,
    tools: tools.map((t) => ({ ...t, calls: Number(t.calls) })),
    mcp: mcp.map((m) => ({ ...m, calls: Number(m.calls) })),
  };
}

export function buildPlantView(
  data: GardenData,
  garden: GardenView,
  id: string,
  agg: StepAggregates,
  pricing?: Record<string, ModelPrice>,
): PlantView | null {
  const plant = garden.plants.find((p) => p.id === id);
  if (!plant) return null;
  const bed = garden.beds.find((b) => b.id === plant.bedId)!;
  const agent = data.agents.find((a) => a.id === plant.agentId);
  const runs = plantRuns(data, plant.agentId, plant.bedId).sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt),
  );
  const mix = Object.fromEntries(OUTCOME_LABELS.map((l) => [l, 0])) as Record<OutcomeLabel, number>;
  for (const r of runs) mix[r.label]++;
  const skillName = new Map(data.skills.map((s) => [s.id, s.name]));
  const runIds = new Set(runs.map((r) => r.id));
  const skillCounts = new Map<string, number>();
  for (const c of data.skillCalls)
    if (runIds.has(c.runId)) skillCounts.set(c.skillId, (skillCounts.get(c.skillId) ?? 0) + 1);
  const def = agent?.definition as (PlantView['agent']['definition'] & object) | null | undefined;
  return {
    plant,
    bed,
    agent: {
      id: plant.agentId,
      name: plant.name,
      kind: plant.agentKind,
      ...(def ? { definition: def } : {}),
    },
    harness: harnessSummary(latestVersion(data, runs)),
    capabilities: {
      skills: [...skillCounts]
        .map(([sid, n]) => ({ id: sid, name: skillName.get(sid) ?? sid, invocations: n }))
        .sort((a, b) => b.invocations - a.invocations),
      mcpServers: agg.mcp,
      tools: agg.tools,
    },
    runs: runs.slice(0, RUNS_CAP).map((r) => toRunRow(r, data, pricing)),
    runsTotal: runs.length,
    outcomeMix: mix,
    signalStats: signalStats(runs),
    tierBreakdown: agg.tiers,
    otherBeds: garden.plants.filter((p) => p.agentId === plant.agentId && p.id !== plant.id),
  };
}

function snapshot(data: GardenData, garden: GardenView, bed: BedSummary) {
  return {
    bed,
    plants: garden.plants.filter((p) => p.bedId === bed.id),
    harness: harnessSummary(data.versions.find((v) => v.id === bed.currentHarnessVersionId)),
  };
}

export function buildCompareView(
  data: GardenData,
  garden: GardenView,
  leftId: string,
  rightId: string,
): BedCompareView | null {
  const lb = garden.beds.find((b) => b.id === leftId);
  const rb = garden.beds.find((b) => b.id === rightId);
  if (!lb || !rb) return null;
  const left = snapshot(data, garden, lb);
  const right = snapshot(data, garden, rb);
  const lv = data.versions.find((v) => v.id === lb.currentHarnessVersionId);
  const rv = data.versions.find((v) => v.id === rb.currentHarnessVersionId);
  const diff = lv && rv ? diffBundles(lv.bundle, rv.bundle) : emptyDiff();
  const sharedAgents = left.plants.flatMap((lp) => {
    const rp = right.plants.find((p) => p.agentId === lp.agentId);
    return rp
      ? [
          {
            agentId: lp.agentId,
            name: lp.name,
            left: lp,
            right: rp,
            success: rateDelta(lp, rp),
            costRatio: costRatio(lp, rp),
          },
        ]
      : [];
  });
  return {
    left,
    right,
    harnessDiff: diff,
    harnessChanges: summarizeDiff(diff),
    sharedAgents,
    caveat: CORRELATION_CAVEAT,
  };
}

export function buildReplantView(
  data: GardenData,
  garden: GardenView,
  agentId: string,
  fromBedId: string,
  toBedId: string,
  pricing?: Record<string, ModelPrice>,
): ReplantView | null {
  const fromBed = garden.beds.find((b) => b.id === fromBedId);
  const toBed = garden.beds.find((b) => b.id === toBedId);
  const agent = data.agents.find((a) => a.id === agentId);
  if (!fromBed || !toBed || !agent) return null;
  const side = (bed: BedSummary) => {
    const plant = garden.plants.find((p) => p.id === plantId(agentId, bed.id)) ?? null;
    const runs = plantRuns(data, agentId, bed.id).sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt),
    );
    // Without a planting, show the bed's current harness: the soil the agent would be replanted into.
    const harness = harnessSummary(
      latestVersion(data, runs) ?? data.versions.find((v) => v.id === bed.currentHarnessVersionId),
    );
    return {
      bed,
      plant,
      harness,
      recent: runs.slice(0, 5).map((r) => toRunRow(r, data, pricing)),
      runs,
    };
  };
  const f = side(fromBed);
  const t = side(toBed);
  // Compare like with like: if either bed has no planting of this agent, compare the two beds'
  // current harnesses (a subagent's observed harness differs from a bed's main-thread harness).
  if (!f.plant || !t.plant) {
    f.harness = harnessSummary(data.versions.find((v) => v.id === fromBed.currentHarnessVersionId));
    t.harness = harnessSummary(data.versions.find((v) => v.id === toBed.currentHarnessVersionId));
  }
  const fv = data.versions.find((v) => v.id === f.harness?.versionId);
  const tv = data.versions.find((v) => v.id === t.harness?.versionId);
  const diff = fv && tv ? diffBundles(fv.bundle, tv.bundle) : null;
  const share = (runs: readonly RunRow[], id: string): number | null => {
    const applicable = runs.filter((r) => r.signals.some((s) => s.id === id && s.fired !== null));
    return applicable.length
      ? applicable.filter((r) => r.signals.some((s) => s.id === id && s.fired)).length /
          applicable.length
      : null;
  };
  const { runs: _fr, ...from } = f;
  const { runs: _tr, ...to } = t;
  void _fr;
  void _tr;
  return {
    agent: {
      id: agentId,
      name: agent.name,
      kind: agent.kind,
      ...(agent.definition?.description ? { description: agent.definition.description } : {}),
    },
    from,
    to,
    harnessDiff: diff,
    harnessChanges: diff ? summarizeDiff(diff) : [],
    success: rateDelta(f.plant, t.plant),
    costRatio: costRatio(f.plant, t.plant),
    signals: SIGNALS.map((d) => ({
      id: d.id,
      weight: d.weight,
      fromShare: share(f.runs, d.id),
      toShare: share(t.runs, d.id),
    })),
    caveat: CORRELATION_CAVEAT,
  };
}

function emptyDiff() {
  return {
    toolsAdded: [],
    toolsRemoved: [],
    skillsAdded: [],
    skillsRemoved: [],
    mcpAdded: [],
    mcpRemoved: [],
    hooksChanged: false,
    settingsChanged: false,
    instructionBytesDelta: 0,
  };
}
