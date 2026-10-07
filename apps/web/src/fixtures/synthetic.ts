/**
 * Deterministic synthetic GardenView for performance testing (`?fixture=synthetic500`).
 * Purely generated values (no real data). Same seed → identical output.
 */
import { wilsonInterval, type GardenView, type PlantSummary } from '@garden/core';
import { mulberry32 } from '../garden/draw';

const MODELS = [
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'claude-fable-1',
  'local-llm',
];
const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const WORDS = [
  'atlas',
  'birch',
  'cedar',
  'delta',
  'ember',
  'fjord',
  'grove',
  'heron',
  'iris',
  'juniper',
  'kelp',
  'linden',
  'maple',
  'nectar',
  'oak',
  'pine',
  'quill',
  'rowan',
  'sage',
  'thyme',
  'umber',
  'violet',
  'willow',
  'yarrow',
  'zinnia',
];
const ROLES = [
  'reviewer',
  'planner',
  'tester',
  'writer',
  'migrator',
  'profiler',
  'triager',
  'linter',
  'archivist',
  'scout',
  'builder',
  'deployer',
  'auditor',
];

export function syntheticGarden(opts: { plants?: number; seed?: number } = {}): GardenView {
  const target = opts.plants ?? 500;
  const rnd = mulberry32(opts.seed ?? 42);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const perBed = 20;
  const nBeds = Math.ceil(target / perBed);
  const nAgents = 40;
  const agents = Array.from({ length: nAgents }, (_, i) =>
    i === 0
      ? { id: 'agt_main', name: 'main', kind: 'main' as const }
      : {
          id: `agt_${String(i).padStart(3, '0')}`,
          name: `${ROLES[i % ROLES.length]}-${WORDS[i % WORDS.length]}`,
          kind: 'subagent' as const,
        },
  );
  const to = '2026-10-01T12:00:00.000Z';
  const view: GardenView = {
    generatedAt: to,
    window: { from: '2026-07-03T12:00:00.000Z', to },
    beds: [],
    plants: [],
    skills: [],
    loops: [],
    bees: [],
    weeds: [],
    playbooks: [],
  };
  let made = 0;
  for (let b = 0; b < nBeds; b++) {
    const bedId = `fam_syn_${String(b).padStart(3, '0')}`;
    const model = pick(MODELS);
    const plantIds: string[] = [];
    const chosen = new Set<number>([0]);
    while (chosen.size < Math.min(perBed, target - made))
      chosen.add(1 + Math.floor(rnd() * (nAgents - 1)));
    for (const ai of [...chosen].sort((x, y) => x - y)) {
      const a = agents[ai]!;
      const id = `plt_syn_${b}_${ai}`;
      const runs =
        a.kind === 'main' ? 20 + Math.floor(rnd() * 600) : Math.floor(Math.pow(rnd(), 2) * 150);
      const nUnknown = Math.floor(runs * rnd() * 0.1);
      const n = runs - nUnknown;
      const value = n === 0 ? null : Math.min(1, Math.max(0, 0.15 + rnd() * 0.85));
      const staleDays = runs === 0 ? null : Math.floor(Math.pow(rnd(), 3) * 80);
      const cost = rnd() < 0.05 ? null : Math.pow(10, -2.5 + rnd() * 3.4);
      const p: PlantSummary = {
        id,
        agentId: a.id,
        agentKind: a.kind,
        bedId,
        name: a.name,
        runs,
        success: {
          value,
          n,
          nUnknown,
          nManual: rnd() < 0.1 ? Math.floor(rnd() * 3) : 0,
          ci95: value === null ? null : wilsonInterval(value * n, n),
          method: 'synthetic',
        },
        recentFailureShare: n === 0 ? null : Math.pow(rnd(), 2),
        costPerRunUsd: cost,
        totalCostUsd: cost === null ? null : cost * runs,
        costEstimated: rnd() < 0.1,
        unpricedRuns: cost === null ? runs : 0,
        lastRunAt:
          staleDays === null
            ? null
            : new Date(Date.parse(to) - staleDays * 86_400_000).toISOString(),
        staleDays,
        skillIds: [],
      };
      const nSkills = rnd() < 0.3 ? 1 + Math.floor(rnd() * 4) : 0;
      for (let s = 0; s < nSkills; s++) {
        const skillId = `skl_syn_${(ai * 7 + s) % 60}`;
        if (p.skillIds.includes(skillId)) continue;
        p.skillIds.push(skillId);
        view.skills.push({
          skillId,
          name: `${pick(WORDS)}-skill`,
          plantId: id,
          invocations: 1 + Math.floor(Math.pow(rnd(), 2) * 120),
        });
      }
      view.plants.push(p);
      plantIds.push(id);
      made++;
    }
    view.beds.push({
      id: bedId,
      name: `${WORDS[b % WORDS.length]}-${Math.floor(b / WORDS.length) + 1}`,
      soil: {
        model,
        effort: pick(EFFORTS),
        toolCount: 8 + Math.floor(rnd() * 60),
        mcpCount: Math.floor(rnd() * 25),
        hookCount: Math.floor(rnd() * 4),
        instructionBytes: rnd() < 0.1 ? 0 : Math.floor(Math.pow(rnd(), 2) * 40000),
      },
      currentHarnessVersionId: `hv_syn_${b}`,
      seasonCount: 1 + Math.floor(rnd() * 4),
      plantIds,
    });
    // bees: main → some subagents in this bed
    for (const pid of plantIds.slice(1)) {
      if (rnd() < 0.15)
        view.bees.push({
          fromPlantId: plantIds[0]!,
          toPlantId: pid,
          calls: 1 + Math.floor(rnd() * 40),
        });
    }
    if (rnd() < 0.4) {
      view.weeds.push({
        id: `weed_syn_${b}`,
        kind: pick(['orphan', 'duplicate', 'unowned'] as const),
        subject: { type: 'mcp_server', id: `mcp_${b}` },
        bedId,
        reason: `Synthetic weed in bed ${b}.`,
      });
    }
  }
  const states = ['flowing', 'flowing', 'flowing', 'flooding', 'dry'] as const;
  for (let l = 0; l < 12; l++) {
    const targets = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(view.plants).id);
    view.loops.push({
      loopId: `loop_syn_${l}`,
      name: `synthetic-loop-${l}`,
      tier: pick(['agent', 'verification', 'application', 'hill_climbing'] as const),
      targetPlantIds: targets,
      runsPerDay: Math.pow(10, -1.2 + rnd() * 2.2),
      state: states[l % states.length]!,
      evidence: ['Synthetic loop.'],
    });
  }
  for (let w = 0; w < 4; w++) {
    view.weeds.push({
      id: `weed_syn_global_${w}`,
      kind: 'orphan',
      subject: { type: 'skill', id: `skl_orphan_${w}` },
      reason: 'Synthetic orphan skill.',
    });
  }
  const pbPlant = view.plants[0]!;
  view.playbooks.push({
    id: 'pb_syn',
    name: 'synthetic-release',
    steps: (['open', 'closed', 'unknown'] as const).map((gate, i) => ({
      stepId: `step${i + 1}`,
      bedId: pbPlant.bedId,
      plantId: pbPlant.id,
      gate,
      evidence: 'Synthetic gate.',
    })),
  });
  return view;
}
