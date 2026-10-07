/** Pure builder: GardenData → GardenView. Every number carries how it was computed. */
import {
  costUsd,
  median,
  successCredit,
  wilsonInterval,
  type BedSummary,
  type BeeFlow,
  type GardenView,
  type LoopChannel,
  type ModelPrice,
  type PlantSummary,
  type PlaybookPath,
  type Rate,
  type SkillCard,
  type Weed,
} from '@garden/core';
import { isTestCommand, similarity, stableId } from '@garden/ingest';
import type { AttemptStep, GardenData, RunRow } from './data';

export interface BuildOptions {
  from: string;
  to: string;
  /** "Now" for staleness and loop health. Defaults to `to`. */
  now?: string;
  pricing?: Record<string, ModelPrice>;
}

const DAY = 86_400_000;
export const RECENT_DAYS = 14;
export const ORPHAN_DAYS = 30;
export const DUPLICATE_SIMILARITY = 0.5;
export const FLOOD_FACTOR = 3;
export const FLOOD_MIN_RUNS = 4;
export const DRY_FACTOR = 3;

export const plantId = (agentId: string, familyId: string): string =>
  stableId('plt', agentId, familyId);

export function rateOf(runs: readonly Pick<RunRow, 'label' | 'manual'>[]): Rate {
  let sum = 0;
  let n = 0;
  let nUnknown = 0;
  let nManual = 0;
  for (const r of runs) {
    const c = successCredit(r.label);
    if (r.manual) nManual++;
    if (c === null) nUnknown++;
    else {
      sum += c;
      n++;
    }
  }
  return {
    value: n ? sum / n : null,
    n,
    nUnknown,
    nManual,
    ci95: wilsonInterval(sum, n),
    method:
      'success = 1, partial = 0.5, failure = 0 over runs with a known label (manual labels override heuristics h1); ' +
      'unknown runs excluded; 95% Wilson interval on the credit sum.',
  };
}

export function runCost(r: RunRow, pricing?: Record<string, ModelPrice>): number | null {
  return costUsd(r.tokens, r.models[0] ?? '', pricing);
}

export function buildGardenView(data: GardenData, opts: BuildOptions): GardenView {
  const now = Date.parse(opts.now ?? opts.to);
  const windowDays = Math.max(1, (Date.parse(opts.to) - Date.parse(opts.from)) / DAY);
  const agentById = new Map(data.agents.map((a) => [a.id, a]));
  const familyById = new Map(data.families.map((f) => [f.id, f]));
  const runById = new Map(data.runs.map((r) => [r.id, r]));
  const mainAgentId = data.agents.find((a) => a.name === 'main')?.id;

  // ---- plants ----------------------------------------------------------------------------------
  const runsByPlant = new Map<string, RunRow[]>();
  for (const r of data.runs) {
    const id = plantId(r.agentId, r.familyId);
    runsByPlant.set(id, [...(runsByPlant.get(id) ?? []), r]);
  }
  const skillCallsByRun = new Map<string, string[]>();
  for (const c of data.skillCalls)
    skillCallsByRun.set(c.runId, [...(skillCallsByRun.get(c.runId) ?? []), c.skillId]);

  const plants: PlantSummary[] = [];
  const skills: SkillCard[] = [];
  const skillName = new Map(data.skills.map((s) => [s.id, s.name]));
  for (const [id, runs] of runsByPlant) {
    const first = runs[0]!;
    const agent = agentById.get(first.agentId);
    const costs = runs.map((r) => runCost(r, opts.pricing));
    const priced = costs.filter((c): c is number => c !== null);
    const recent = runs.filter(
      (r) => now - Date.parse(r.startedAt) <= RECENT_DAYS * DAY && r.label !== 'unknown',
    );
    const last = runs.reduce((m, r) => (r.startedAt > m ? r.startedAt : m), runs[0]!.startedAt);
    const invocations = new Map<string, number>();
    for (const r of runs)
      for (const s of skillCallsByRun.get(r.id) ?? [])
        invocations.set(s, (invocations.get(s) ?? 0) + 1);
    plants.push({
      id,
      agentId: first.agentId,
      agentKind: agent?.kind ?? 'subagent',
      bedId: first.familyId,
      name: agent?.name ?? 'unknown agent',
      runs: runs.length,
      success: rateOf(runs),
      recentFailureShare: recent.length
        ? recent.filter((r) => r.label === 'failure').length / recent.length
        : null,
      costPerRunUsd: median(priced),
      totalCostUsd: priced.length ? priced.reduce((a, b) => a + b, 0) : null,
      costEstimated: runs.some((r) => r.tokenQuality === 'output_estimated'),
      unpricedRuns: costs.length - priced.length,
      lastRunAt: last,
      staleDays: Math.max(0, Math.floor((now - Date.parse(last)) / DAY)),
      skillIds: [...invocations.keys()].sort(),
    });
    for (const [skillId, n] of invocations)
      skills.push({
        skillId,
        name: skillName.get(skillId) ?? skillId,
        plantId: id,
        invocations: n,
      });
  }
  // Stable order: main first, then by agent name, then bed — renderers place the same agent in the same slot.
  const order = (p: PlantSummary) =>
    `${p.agentKind === 'main' ? 0 : 1}:${p.name}:${familyById.get(p.bedId)?.name ?? ''}`;
  plants.sort((a, b) => order(a).localeCompare(order(b)));
  const plantIds = new Set(plants.map((p) => p.id));

  // ---- beds ------------------------------------------------------------------------------------
  const beds: BedSummary[] = [];
  for (const f of data.families) {
    const own = plants.filter((p) => p.bedId === f.id);
    if (own.length === 0) continue;
    const famVersions = data.versions.filter((v) => v.familyId === f.id && v.validFrom <= opts.to);
    const mainChain = famVersions.filter((v) => v.primaryAgentId === mainAgentId);
    const current = (mainChain.length ? mainChain : famVersions).at(-1);
    const b = current?.bundle;
    beds.push({
      id: f.id,
      name: f.name,
      soil: {
        ...(b?.model ? { model: b.model } : {}),
        ...(b?.effort ? { effort: b.effort } : {}),
        ...(b?.permissionMode ? { permissionMode: b.permissionMode } : {}),
        toolCount: b?.tools.length ?? 0,
        mcpCount: b?.mcpServers.length ?? 0,
        hookCount: b?.hooks.length ?? 0,
        instructionBytes: b?.instructions.reduce((n, i) => n + i.bytes, 0) ?? 0,
      },
      currentHarnessVersionId: current?.id ?? null,
      seasonCount: (mainChain.length ? mainChain : famVersions).length,
      plantIds: own.map((p) => p.id),
    });
  }

  // ---- bees (subagent handoffs) ----------------------------------------------------------------
  const beeCounts = new Map<string, number>();
  for (const r of data.runs) {
    if (!r.parentRunId) continue;
    const parent = runById.get(r.parentRunId);
    if (!parent) continue;
    const key = `${plantId(parent.agentId, parent.familyId)}>${plantId(r.agentId, r.familyId)}`;
    beeCounts.set(key, (beeCounts.get(key) ?? 0) + 1);
  }
  const bees: BeeFlow[] = [...beeCounts].map(([k, calls]) => {
    const [fromPlantId, toPlantId] = k.split('>') as [string, string];
    return { fromPlantId, toPlantId, calls };
  });

  return {
    generatedAt: new Date(now).toISOString(),
    window: { from: opts.from, to: opts.to },
    beds,
    plants,
    skills,
    loops: buildLoops(data, plants, plantIds, now, windowDays),
    bees,
    weeds: buildWeeds(data, plants, now),
    playbooks: buildPlaybooks(data, runById),
  };
}

// ---- loops (irrigation) --------------------------------------------------------------------------

export function buildLoops(
  data: GardenData,
  plants: readonly PlantSummary[],
  plantIds: ReadonlySet<string>,
  now: number,
  windowDays: number,
): LoopChannel[] {
  const out: LoopChannel[] = [];
  for (const l of data.loops) {
    const runs = data.runs.filter((r) => r.loopId === l.id);
    const evidence: string[] = [];
    let targets = [...new Set(runs.map((r) => plantId(r.agentId, r.familyId)))];
    if (targets.length === 0) {
      const agents = l.targets.agentIds.length
        ? l.targets.agentIds
        : plants.filter((p) => p.agentKind === 'main').map((p) => p.agentId);
      targets = l.targets.familyIds
        .flatMap((f) => agents.map((a) => plantId(a, f)))
        .filter((id) => plantIds.has(id));
    }
    let runsPerDay = runs.length / windowDays;
    let state: LoopChannel['state'] = 'flowing';

    if (l.triggerKind === 'hook' && runs.length === 0) {
      const bedRuns = data.runs.filter((r) => l.targets.familyIds.includes(r.familyId)).length;
      runsPerDay = bedRuns / windowDays;
      evidence.push(
        `Configured hook (${l.triggerDetail}). Individual executions are not recorded in transcripts, so flow = runs per day in the beds where it is active (an upper bound).`,
      );
    } else {
      evidence.push(
        `${runs.length} runs in the window (${runsPerDay.toFixed(2)}/day), ${l.provenance} loop, trigger ${l.triggerKind}.`,
      );
    }

    // Dry: expected cadence missed by DRY_FACTOR×.
    if (l.expectedIntervalSec) {
      const last = runs.at(-1);
      const gapSec = last ? (now - Date.parse(last.startedAt)) / 1000 : Infinity;
      if (gapSec > DRY_FACTOR * l.expectedIntervalSec) {
        state = 'dry';
        evidence.push(
          last
            ? `Dry: last run ${last.startedAt.slice(0, 10)}, ${Math.floor(gapSec / 86400)} days ago; expected every ${formatInterval(l.expectedIntervalSec)}.`
            : `Dry: no runs in the window; expected every ${formatInterval(l.expectedIntervalSec)}.`,
        );
      }
    }

    // Flooding: a day far above the loop's baseline within the last 30 days.
    if (state !== 'dry' && runs.length) {
      const perDay = new Map<string, RunRow[]>();
      for (const r of runs)
        perDay.set(r.startedAt.slice(0, 10), [...(perDay.get(r.startedAt.slice(0, 10)) ?? []), r]);
      const baseline = l.expectedIntervalSec
        ? 86400 / l.expectedIntervalSec
        : (median([...perDay.values()].map((d) => d.length)) ?? 1);
      let worst: [string, RunRow[]] | undefined;
      for (const e of perDay) {
        if (now - Date.parse(e[0]) > 30 * DAY) continue;
        if (!worst || e[1].length > worst[1].length) worst = e;
      }
      if (worst && worst[1].length >= Math.max(FLOOD_MIN_RUNS, FLOOD_FACTOR * baseline)) {
        state = 'flooding';
        const failing = worst[1].filter((r) => r.label === 'failure' || r.errorCount > 0).length;
        evidence.push(
          `Flooding: ${worst[1].length} runs on ${worst[0]} vs a baseline of ${baseline.toFixed(1)}/day; ${failing} of them failed or hit errors.`,
        );
      }
    }
    out.push({
      loopId: l.id,
      name: l.name,
      tier: l.tier as LoopChannel['tier'],
      targetPlantIds: targets,
      runsPerDay,
      state,
      evidence,
    });
  }
  return out;
}

function formatInterval(sec: number): string {
  if (sec % 604800 === 0) return `${sec / 604800}w`;
  if (sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  return `${Math.round(sec / 60)}m`;
}

// ---- weeds -------------------------------------------------------------------------------------

export function buildWeeds(data: GardenData, plants: readonly PlantSummary[], now: number): Weed[] {
  const weeds: Weed[] = [];
  const ranAgents = new Set(
    plants.filter((p) => p.staleDays !== null && p.staleDays <= ORPHAN_DAYS).map((p) => p.agentId),
  );
  const anyRunAgents = new Set(plants.map((p) => p.agentId));
  for (const a of data.agents) {
    if (!a.definition || a.definition.scope === 'builtin') continue;
    if (!ranAgents.has(a.id)) {
      weeds.push({
        id: stableId('weed', 'orphan', a.id),
        kind: 'orphan',
        subject: { type: 'agent', id: a.id },
        reason: anyRunAgents.has(a.id)
          ? `Agent “${a.name}” has not run in ${ORPHAN_DAYS} days.`
          : `Agent “${a.name}” is defined (${a.definition.scope}) but never ran in the window.`,
      });
    }
    if (!a.definition.description) {
      weeds.push({
        id: stableId('weed', 'unowned', a.id),
        kind: 'unowned',
        subject: { type: 'agent', id: a.id },
        reason: `Agent “${a.name}” has no description, so nothing can route to it.`,
      });
    }
  }
  const invoked = new Set(data.skillCalls.map((c) => c.skillId));
  for (const s of data.skills) {
    if (!invoked.has(s.id))
      weeds.push({
        id: stableId('weed', 'orphan', s.id),
        kind: 'orphan',
        subject: { type: 'skill', id: s.id },
        reason: `Skill “${s.name}” was never invoked in the window.`,
      });
    if (!s.description)
      weeds.push({
        id: stableId('weed', 'unowned', s.id),
        kind: 'unowned',
        subject: { type: 'skill', id: s.id },
        reason: `Skill “${s.name}” has no description; the model cannot know when to load it.`,
      });
  }
  const described = [
    ...data.skills
      .filter((s) => s.description)
      .map((s) => ({ type: 'skill' as const, id: s.id, name: s.name, d: s.description! })),
    ...data.agents
      .filter((a) => a.definition?.description && a.definition.scope !== 'builtin')
      .map((a) => ({
        type: 'agent' as const,
        id: a.id,
        name: a.name,
        d: a.definition!.description!,
      })),
  ];
  for (let i = 0; i < described.length; i++)
    for (let j = i + 1; j < described.length; j++) {
      const a = described[i]!;
      const b = described[j]!;
      if (a.type !== b.type) continue;
      const sim = similarity(a.d, b.d);
      if (sim >= DUPLICATE_SIMILARITY)
        weeds.push({
          id: stableId('weed', 'duplicate', a.id, b.id),
          kind: 'duplicate',
          subject: { type: b.type, id: b.id },
          reason: `${b.type === 'skill' ? 'Skill' : 'Agent'} “${b.name}” overlaps with “${a.name}” (description similarity ${sim.toFixed(2)}). Merge or differentiate them.`,
        });
    }
  // MCP servers available in some bed's current harness but never called in any bed.
  // (A server used somewhere is not a weed; one connected everywhere and never used is one finding.)
  const calledAnywhere = new Set(data.mcpCalls.map((c) => c.server));
  const mainId = data.agents.find((a) => a.name === 'main')?.id;
  const bedsByServer = new Map<string, { id: string; name: string }[]>();
  for (const f of data.families) {
    const current = data.versions
      .filter((v) => v.familyId === f.id && (v.primaryAgentId === mainId || !mainId))
      .at(-1);
    if (!current || !plants.some((p) => p.bedId === f.id)) continue;
    for (const server of current.bundle.mcpServers ?? [])
      bedsByServer.set(server, [...(bedsByServer.get(server) ?? []), f]);
  }
  for (const [server, beds] of [...bedsByServer].sort(([a], [b]) => a.localeCompare(b))) {
    if (calledAnywhere.has(server)) continue;
    weeds.push({
      id: stableId('weed', 'orphan', 'mcp', server),
      kind: 'orphan',
      subject: { type: 'mcp_server', id: server },
      ...(beds.length === 1 ? { bedId: beds[0]!.id } : {}),
      reason: `MCP server “${server}” is connected in ${beds.length === 1 ? beds[0]!.name : `${beds.length} beds (${beds.map((b) => b.name).join(', ')})`} but was never called in the window. Its tool descriptions still cost context.`,
    });
  }
  void now;
  return weeds;
}

// ---- playbooks ---------------------------------------------------------------------------------

function commandOf(preview: string | null): string | undefined {
  if (!preview) return undefined;
  try {
    const v = JSON.parse(preview) as { command?: unknown };
    return typeof v.command === 'string' ? v.command : undefined;
  } catch {
    return undefined;
  }
}

export function buildPlaybooks(
  data: GardenData,
  runById: ReadonlyMap<string, RunRow>,
): PlaybookPath[] {
  return data.playbooks.map((pb) => {
    const attempt = data.attempts[pb.id];
    const run = attempt ? runById.get(attempt.runId) : undefined;
    const where = run ? { bedId: run.familyId, plantId: plantId(run.agentId, run.familyId) } : {};
    if (!attempt || !run) {
      return {
        id: pb.id,
        name: pb.name,
        steps: pb.steps.map((s) => ({
          stepId: s.id,
          gate: 'unknown' as const,
          evidence: 'No run started this playbook in the window.',
        })),
      };
    }
    const steps = attempt.steps;
    const startOf = pb.steps.map((s) =>
      s.skillId
        ? steps.find((x) => x.kind === 'tool_call' && x.skillId === s.skillId)?.seq
        : steps[0]?.seq,
    );
    let blocked = false;
    const date = run.startedAt.slice(0, 10);
    return {
      id: pb.id,
      name: pb.name,
      steps: pb.steps.map((s, i) => {
        if (blocked)
          return {
            stepId: s.id,
            ...where,
            gate: 'unknown' as const,
            evidence: 'Not reached: an earlier gate is closed.',
          };
        const start = startOf[i];
        if (start === undefined) {
          blocked = true;
          return {
            stepId: s.id,
            ...where,
            gate: 'unknown' as const,
            evidence: `Step not started in the latest attempt (${date}).`,
          };
        }
        const end = startOf.slice(i + 1).find((x) => x !== undefined && x > start) ?? Infinity;
        const seg = steps.filter((x) => x.seq >= start && x.seq < end);
        const { gate, evidence } = evaluateGate(s.gate, seg, steps);
        if (gate !== 'open') blocked = true;
        return { stepId: s.id, ...where, gate, evidence: `${evidence} (latest attempt ${date})` };
      }),
    };
  });
}

function resultOf(call: AttemptStep, all: readonly AttemptStep[]): AttemptStep | undefined {
  return all.find((x) => x.kind === 'tool_result' && x.callId === call.callId && x.seq > call.seq);
}

export function evaluateGate(
  gate: GardenData['playbooks'][number]['steps'][number]['gate'],
  seg: readonly AttemptStep[],
  all: readonly AttemptStep[],
): { gate: 'open' | 'closed' | 'unknown'; evidence: string } {
  switch (gate.kind) {
    case 'manual':
      return { gate: 'unknown', evidence: 'Manual gate: label the run to open it.' };
    case 'step_success': {
      const err = seg.find((x) => x.isError && x.errorKind !== 'interrupt');
      return err
        ? { gate: 'closed', evidence: `Error at step ${err.seq}.` }
        : { gate: 'open', evidence: 'Step finished without errors.' };
    }
    case 'tests_pass': {
      const tests = seg.filter(
        (x) => x.kind === 'tool_call' && isTestCommand(commandOf(x.preview)),
      );
      const lastTest = tests.at(-1);
      if (!lastTest) return { gate: 'closed', evidence: 'No test command ran in this step.' };
      const res = resultOf(lastTest, all);
      const cmd = commandOf(lastTest.preview)!.slice(0, 60);
      return res && !res.isError
        ? { gate: 'open', evidence: `\`${cmd}\` passed.` }
        : { gate: 'closed', evidence: `\`${cmd}\` failed.` };
    }
    case 'command_ok': {
      const call = seg.find(
        (x) => x.kind === 'tool_call' && (commandOf(x.preview) ?? '').includes(gate.pattern),
      );
      if (!call) return { gate: 'closed', evidence: `No command matching “${gate.pattern}” ran.` };
      const res = resultOf(call, all);
      return res && !res.isError
        ? { gate: 'open', evidence: `“${gate.pattern}” succeeded.` }
        : { gate: 'closed', evidence: `“${gate.pattern}” failed.` };
    }
  }
}
