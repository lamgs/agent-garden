/**
 * Tooltip / panel content for every garden element: metric values with units, n, CI, unknown and
 * manual counts, and the registry's "how computed" text. Pure, so it is unit-tested and shared.
 */
import {
  bedStrata,
  bedTexture,
  bedTone,
  beeCount,
  careCardSize,
  irrigationFlow,
  irrigationState,
  plantBloom,
  plantDroop,
  plantFade,
  plantHeight,
  plantHue,
  playbookGate,
  weedKind,
  wilsonInterval,
  type BedSummary,
  type GardenView,
  type ID,
  type PlantSummary,
  type Rate,
} from '@garden/core';
import {
  bedLabel,
  formatBytes,
  formatCostPerRun,
  formatInt,
  formatLastRun,
  formatRate,
  formatShare,
  formatTotalCost,
} from './format';

export type HoverTarget =
  | { kind: 'plant'; id: ID }
  | { kind: 'bed'; id: ID }
  | { kind: 'loop'; id: ID }
  | { kind: 'bee'; from: ID; to: ID }
  | { kind: 'weed'; id: ID }
  | { kind: 'gate'; playbookId: ID; stepIndex: number }
  | { kind: 'card'; skillId: ID; plantId: ID };

export interface Description {
  title: string;
  subtitle?: string;
  rows: { label: string; value: string; level?: string }[];
  how: { channel: string; text: string }[];
  note?: string;
}

export function targetKey(t: HoverTarget): string {
  switch (t.kind) {
    case 'bee':
      return `bee:${t.from}>${t.to}`;
    case 'gate':
      return `gate:${t.playbookId}:${t.stepIndex}`;
    case 'card':
      return `card:${t.plantId}:${t.skillId}`;
    default:
      return `${t.kind}:${t.id}`;
  }
}

/** Runs-weighted success over a bed's plants, as a PlantSummary so the registry can bin it. */
export function bedAggregate(view: GardenView, bed: BedSummary): PlantSummary {
  const ps = view.plants.filter((p) => p.bedId === bed.id);
  const runs = ps.reduce((s, p) => s + p.runs, 0);
  let credit = 0;
  let n = 0;
  let nUnknown = 0;
  let nManual = 0;
  for (const p of ps) {
    nUnknown += p.success.nUnknown;
    nManual += p.success.nManual;
    if (p.success.value === null) continue;
    credit += p.success.value * p.success.n;
    n += p.success.n;
  }
  const success: Rate = {
    value: n > 0 ? credit / n : null,
    n,
    nUnknown,
    nManual,
    ci95: n > 0 ? wilsonInterval(credit, n) : null,
    method:
      'Pooled over the agents in this bed: Σ(success × n) ÷ Σn; 95% Wilson interval on the pooled credit.',
  };
  const last =
    ps
      .map((p) => p.lastRunAt)
      .filter((x): x is string => !!x)
      .sort()
      .pop() ?? null;
  const staleVals = ps.map((p) => p.staleDays).filter((x): x is number => x !== null);
  return {
    id: `agg:${bed.id}`,
    agentId: 'all',
    agentKind: 'main',
    bedId: bed.id,
    name: 'all agents',
    runs,
    success,
    recentFailureShare: null,
    costPerRunUsd: null,
    totalCostUsd: ps.some((p) => p.totalCostUsd !== null)
      ? ps.reduce((s, p) => s + (p.totalCostUsd ?? 0), 0)
      : null,
    costEstimated: ps.some((p) => p.costEstimated),
    unpricedRuns: ps.reduce((s, p) => s + p.unpricedRuns, 0),
    lastRunAt: last,
    staleDays: staleVals.length ? Math.min(...staleVals) : null,
    skillIds: [],
  };
}

const lv = (levels: readonly string[], i: number) => levels[i] ?? `level ${i}`;

export function describePlant(view: GardenView, p: PlantSummary): Description {
  const bed = view.beds.find((b) => b.id === p.bedId);
  const skills = view.skills.filter((s) => s.plantId === p.id);
  return {
    title: p.name,
    subtitle: `${p.agentKind === 'main' ? 'Main thread' : 'Subagent'} in ${bed ? bedLabel(bed) : p.bedId}`,
    rows: [
      {
        label: 'Runs',
        value: formatInt(p.runs),
        level: lv(plantHeight.levels, plantHeight.level(p)),
      },
      {
        label: 'Success',
        value: formatRate(p.success),
        level: lv(plantBloom.levels, plantBloom.level(p)),
      },
      {
        label: 'Failure share, last 14 d',
        value: formatShare(p.recentFailureShare),
        level: lv(plantDroop.levels, plantDroop.level(p)),
      },
      {
        label: 'Last run',
        value: formatLastRun(p),
        level: lv(plantFade.levels, plantFade.level(p)),
      },
      { label: 'Cost', value: formatCostPerRun(p), level: lv(plantHue.levels, plantHue.level(p)) },
      { label: 'Total cost', value: formatTotalCost(p) },
      ...(skills.length
        ? [
            {
              label: 'Skills',
              value: skills.map((s) => `${s.name} (${s.invocations}×)`).join(', '),
            },
          ]
        : []),
    ],
    how: [plantHeight, plantBloom, plantDroop, plantFade, plantHue].map((e) => ({
      channel: `${e.channel}: ${e.metric}`,
      text: e.howComputed,
    })),
    note: p.success.method,
  };
}

export function describeBed(view: GardenView, b: BedSummary): Description {
  const agg = bedAggregate(view, b);
  return {
    title: b.name,
    subtitle: bedLabel(b),
    rows: [
      {
        label: 'Model',
        value: b.soil.model ?? 'unknown',
        level: lv(bedTone.levels, bedTone.level(b)),
      },
      { label: 'Effort', value: b.soil.effort ?? 'default' },
      ...(b.soil.permissionMode
        ? [{ label: 'Permission mode', value: b.soil.permissionMode }]
        : []),
      {
        label: 'Tools + MCP servers',
        value: `${b.soil.toolCount} tools + ${b.soil.mcpCount} MCP servers`,
        level: lv(bedTexture.levels, bedTexture.level(b)),
      },
      {
        label: 'Instructions (CLAUDE.md chain)',
        value: formatBytes(b.soil.instructionBytes),
        level: lv(bedStrata.levels, bedStrata.level(b)),
      },
      { label: 'Hooks', value: String(b.soil.hookCount) },
      { label: 'Seasons (harness versions)', value: String(b.seasonCount) },
      { label: 'Agents planted', value: String(b.plantIds.length) },
      { label: 'Runs (all agents)', value: formatInt(agg.runs) },
      {
        label: 'Pooled success',
        value: formatRate(agg.success),
        level: lv(plantBloom.levels, plantBloom.level(agg)),
      },
    ],
    how: [
      ...[bedTone, bedTexture, bedStrata].map((e) => ({
        channel: `${e.channel}: ${e.metric}`,
        text: e.howComputed,
      })),
      { channel: 'Pooled success (far zoom bloom)', text: agg.success.method },
    ],
  };
}

export function describe(view: GardenView, t: HoverTarget): Description | null {
  switch (t.kind) {
    case 'plant': {
      const p = view.plants.find((x) => x.id === t.id);
      return p ? describePlant(view, p) : null;
    }
    case 'bed': {
      const b = view.beds.find((x) => x.id === t.id);
      return b ? describeBed(view, b) : null;
    }
    case 'loop': {
      const l = view.loops.find((x) => x.loopId === t.id);
      if (!l) return null;
      const targets = [...new Set(l.targetPlantIds)].map((id) => plantLabel(view, id)).join(', ');
      return {
        title: l.name,
        subtitle: `Loop · ${l.tier.replace('_', ' ')} tier`,
        rows: [
          {
            label: 'State',
            value: l.state,
            level: lv(irrigationState.levels, irrigationState.level(l)),
          },
          {
            label: 'Runs per day',
            value: `${l.runsPerDay.toFixed(2)}/day`,
            level: lv(irrigationFlow.levels, irrigationFlow.level(l)),
          },
          { label: 'Waters', value: targets },
          ...l.evidence.map((e, i) => ({ label: i === 0 ? 'Evidence' : '', value: e })),
        ],
        how: [irrigationFlow, irrigationState].map((e) => ({
          channel: `${e.channel}: ${e.metric}`,
          text: e.howComputed,
        })),
      };
    }
    case 'bee': {
      const f = view.bees.find((b) => b.fromPlantId === t.from && b.toPlantId === t.to);
      if (!f) return null;
      return {
        title: `${plantLabel(view, f.fromPlantId)} → ${plantLabel(view, f.toPlantId)}`,
        subtitle: 'Subagent handoffs',
        rows: [
          {
            label: 'Calls',
            value: formatInt(f.calls),
            level: lv(beeCount.levels, beeCount.level(f)),
          },
        ],
        how: [{ channel: `${beeCount.channel}: ${beeCount.metric}`, text: beeCount.howComputed }],
      };
    }
    case 'weed': {
      const w = view.weeds.find((x) => x.id === t.id);
      if (!w) return null;
      const bed = w.bedId ? view.beds.find((b) => b.id === w.bedId) : undefined;
      return {
        title: `Weed: ${w.kind}`,
        subtitle: `${w.subject.type.replace('_', ' ')} · ${bed ? bed.name : 'compost corner (not tied to one bed)'}`,
        rows: [{ label: 'Reason', value: w.reason, level: lv(weedKind.levels, weedKind.level(w)) }],
        how: [{ channel: `${weedKind.channel}: ${weedKind.metric}`, text: weedKind.howComputed }],
      };
    }
    case 'gate': {
      const pb = view.playbooks.find((x) => x.id === t.playbookId);
      const s = pb?.steps[t.stepIndex];
      if (!pb || !s) return null;
      return {
        title: `Playbook “${pb.name}” · step ${t.stepIndex + 1}: ${s.stepId}`,
        subtitle: s.plantId ? plantLabel(view, s.plantId) : undefined,
        rows: [
          { label: 'Gate', value: s.gate, level: lv(playbookGate.levels, playbookGate.level(s)) },
          { label: 'Evidence', value: s.evidence },
        ],
        how: [
          {
            channel: `${playbookGate.channel}: ${playbookGate.metric}`,
            text: playbookGate.howComputed,
          },
        ],
      };
    }
    case 'card': {
      const s = view.skills.find((x) => x.skillId === t.skillId && x.plantId === t.plantId);
      if (!s) return null;
      return {
        title: `Skill: ${s.name}`,
        subtitle: `Care card on ${plantLabel(view, s.plantId)}`,
        rows: [
          {
            label: 'Invocations',
            value: formatInt(s.invocations),
            level: lv(careCardSize.levels, careCardSize.level(s)),
          },
        ],
        how: [
          {
            channel: `${careCardSize.channel}: ${careCardSize.metric}`,
            text: careCardSize.howComputed,
          },
        ],
      };
    }
  }
}

export function plantLabel(view: GardenView, plantId: ID): string {
  const p = view.plants.find((x) => x.id === plantId);
  if (!p) return plantId;
  const b = view.beds.find((x) => x.id === p.bedId);
  return `${p.name} (${b?.name ?? p.bedId})`;
}
