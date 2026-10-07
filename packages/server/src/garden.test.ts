import { describe, expect, it } from 'vitest';
import type { GardenData, RunRow } from './data';
import { buildGardenView, evaluateGate, plantId, rateOf } from './garden';

const T0 = Date.parse('2026-09-01T00:00:00.000Z');
const day = (d: number, h = 10) => new Date(T0 + d * 864e5 + h * 36e5).toISOString();
let n = 0;
function run(o: Partial<RunRow> = {}): RunRow {
  return {
    id: `r${n++}`,
    agentId: 'agt_main',
    familyId: 'fam_a',
    harnessVersionId: 'hv1',
    parentRunId: null,
    loopId: null,
    startedAt: day(1),
    endedAt: day(1),
    trigger: 'human',
    models: ['claude-sonnet-5-5'],
    tokens: { input: 1000, output: 1000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    tokenQuality: 'reported',
    label: 'success',
    manual: false,
    signals: [],
    taskPreview: 'x',
    errorCount: 0,
    ...o,
  };
}
const bundle = {
  instructions: [{ path: 'CLAUDE.md', hash: 'h', bytes: 2000 }],
  tools: ['Bash', 'Read'],
  skills: [],
  subagents: [],
  mcpServers: ['github', 'linear'],
  hooks: [],
};
function data(o: Partial<GardenData> = {}): GardenData {
  return {
    families: [
      { id: 'fam_a', name: 'shop-api' },
      { id: 'fam_b', name: 'legacy' },
    ],
    versions: [
      {
        id: 'hv1',
        familyId: 'fam_a',
        validFrom: day(0),
        validTo: null,
        bundle: { ...bundle, model: 'claude-sonnet-5-5' } as never,
        primaryAgentId: 'agt_main',
      },
      {
        id: 'hv2',
        familyId: 'fam_b',
        validFrom: day(0),
        validTo: null,
        bundle: { ...bundle, mcpServers: ['github'] } as never,
        primaryAgentId: 'agt_main',
      },
    ],
    agents: [
      { id: 'agt_main', name: 'main', kind: 'main', definition: null },
      {
        id: 'agt_tw',
        name: 'test-writer',
        kind: 'subagent',
        definition: { scope: 'user', description: 'Writes focused unit tests for changed code' },
      },
      {
        id: 'agt_orphan',
        name: 'perf-profiler',
        kind: 'subagent',
        definition: { scope: 'user', description: 'Profiles CPU hot paths' },
      },
      { id: 'agt_nodesc', name: 'mystery', kind: 'subagent', definition: { scope: 'project' } },
    ],
    skills: [
      {
        id: 'skl_cl',
        name: 'changelog-writer',
        description: 'Write the changelog entry for the release from merged pull requests',
        scope: 'user',
      },
      {
        id: 'skl_rn',
        name: 'release-notes',
        description: 'Write the release notes entry for the release from merged pull requests',
        scope: 'user',
      },
      { id: 'skl_x', name: 'misc', description: null, scope: 'user' },
    ],
    runs: [],
    skillCalls: [],
    mcpCalls: [{ familyId: 'fam_a', server: 'linear', n: 3 }],
    loops: [],
    playbooks: [],
    attempts: {},
    ...o,
  };
}
const opts = { from: day(0, 0), to: day(30, 0) };

describe('rateOf', () => {
  it('credits partial as 0.5, excludes unknown, counts manual, gives a Wilson interval', () => {
    const r = rateOf([
      { label: 'success', manual: false },
      { label: 'partial', manual: true },
      { label: 'failure', manual: false },
      { label: 'unknown', manual: false },
    ]);
    expect(r.value).toBe(0.5);
    expect(r).toMatchObject({ n: 3, nUnknown: 1, nManual: 1 });
    expect(r.ci95![0]).toBeLessThan(0.5);
    expect(r.ci95![1]).toBeGreaterThan(0.5);
    expect(r.method).toMatch(/partial = 0.5/);
    expect(rateOf([]).value).toBeNull();
  });
});

describe('buildGardenView', () => {
  it('builds plants per (agent, bed) with median cost, the estimate flag and unpriced runs', () => {
    const runs = [
      run(),
      run({
        models: ['claude-sonnet-5-5'],
        tokens: { input: 0, output: 100_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      }),
      run({ models: ['mystery-model'] }),
      run({ agentId: 'agt_tw', tokenQuality: 'output_estimated', label: 'failure' }),
    ];
    const v = buildGardenView(data({ runs }), opts);
    const main = v.plants.find((p) => p.name === 'main')!;
    expect(main.runs).toBe(3);
    expect(main.unpricedRuns).toBe(1);
    expect(main.costPerRunUsd).toBeCloseTo((0.012 + 1.0) / 2, 5);
    expect(main.costEstimated).toBe(false);
    expect(v.plants.find((p) => p.name === 'test-writer')!.costEstimated).toBe(true);
    expect(v.plants[0]!.agentKind).toBe('main');
    expect(v.beds).toHaveLength(1); // bed without plants is not drawn
    expect(v.beds[0]!.soil).toMatchObject({
      model: 'claude-sonnet-5-5',
      toolCount: 2,
      mcpCount: 2,
      instructionBytes: 2000,
    });
  });

  it('staleness and recent failure share are relative to "now"', () => {
    const runs = [
      run({ startedAt: day(2), label: 'failure' }),
      run({ startedAt: day(25), label: 'failure' }),
      run({ startedAt: day(26) }),
    ];
    const p = buildGardenView(data({ runs }), opts).plants[0]!;
    expect(p.staleDays).toBe(3);
    expect(p.recentFailureShare).toBe(0.5); // only the last 14 days
  });

  it('draws bees from parent plant to child plant', () => {
    const parent = run({ id: 'p1' });
    const v = buildGardenView(
      data({
        runs: [
          parent,
          run({ agentId: 'agt_tw', parentRunId: 'p1' }),
          run({ agentId: 'agt_tw', parentRunId: 'p1' }),
        ],
      }),
      opts,
    );
    expect(v.bees).toEqual([
      {
        fromPlantId: plantId('agt_main', 'fam_a'),
        toPlantId: plantId('agt_tw', 'fam_a'),
        calls: 2,
      },
    ]);
  });

  it('finds weeds: orphan + undescribed agents, unused/undescribed/duplicate skills, unused MCP servers once', () => {
    const v = buildGardenView(
      data({
        runs: [run(), run({ familyId: 'fam_b' })],
        skillCalls: [{ runId: 'r_x', skillId: 'skl_cl', seq: 1 }],
      }),
      opts,
    );
    const reasons = v.weeds.map((w) => `${w.kind}:${w.subject.type}:${w.subject.id}`);
    expect(reasons).toContain('orphan:agent:agt_orphan');
    expect(reasons).toContain('unowned:agent:agt_nodesc');
    expect(reasons).toContain('orphan:skill:skl_rn');
    expect(reasons).toContain('unowned:skill:skl_x');
    expect(reasons).toContain('duplicate:skill:skl_rn');
    expect(reasons).not.toContain('orphan:skill:skl_cl');
    // github is connected in both beds and never called → one weed; linear is called → none.
    expect(reasons.filter((r) => r.includes('mcp_server'))).toEqual(['orphan:mcp_server:github']);
  });
});

describe('loop health', () => {
  const loop = (o: Partial<GardenData['loops'][number]> = {}) => ({
    id: 'loop1',
    name: 'nightly',
    tier: 'application',
    provenance: 'declared',
    triggerKind: 'cron',
    triggerDetail: 'every 1d',
    expectedIntervalSec: 86400,
    targets: { agentIds: ['agt_main'], familyIds: ['fam_a'] },
    ...o,
  });
  it('flowing at its expected cadence', () => {
    const runs = Array.from({ length: 28 }, (_, d) =>
      run({ startedAt: day(d + 1, 2), loopId: 'loop1' }),
    );
    const l = buildGardenView(data({ runs, loops: [loop()] }), opts).loops[0]!;
    expect(l.state).toBe('flowing');
    expect(l.runsPerDay).toBeCloseTo(28 / 30);
  });
  it('dry when 3× the expected interval passes without a run', () => {
    const runs = [run({ startedAt: day(5, 2), loopId: 'loop1' })];
    const l = buildGardenView(data({ runs, loops: [loop({ expectedIntervalSec: 604800 })] }), opts)
      .loops[0]!;
    expect(l.state).toBe('dry'); // last run ~25 days ago > 3 × 7 days
    expect(l.evidence.join(' ')).toMatch(
      /Dry: last run 2026-09-06, \d+ days ago; expected every 1w/,
    );
  });
  it('a loop that floods and then stops is dry, not flooding (current state wins)', () => {
    const runs = Array.from({ length: 12 }, (_, i) =>
      run({ startedAt: day(20, 6 + i / 10), loopId: 'loop1' }),
    );
    expect(buildGardenView(data({ runs, loops: [loop()] }), opts).loops[0]!.state).toBe('dry');
  });
  it('flooding when one day far exceeds the baseline while the loop is still running', () => {
    const runs = [
      ...Array.from({ length: 29 }, (_, d) => run({ startedAt: day(d + 1, 5), loopId: 'loop1' })),
      ...Array.from({ length: 12 }, (_, i) =>
        run({ startedAt: day(22, 6 + i / 10), loopId: 'loop1', label: 'failure', errorCount: 2 }),
      ),
    ];
    const l = buildGardenView(data({ runs, loops: [loop()] }), opts).loops[0]!;
    expect(l.state).toBe('flooding');
    expect(l.evidence.join(' ')).toMatch(/13 runs on .* 12 of them failed/);
  });
  it('hook loops without recorded executions say flow is an upper bound', () => {
    const l = buildGardenView(
      data({
        runs: [run()],
        loops: [loop({ triggerKind: 'hook', expectedIntervalSec: null, provenance: 'config' })],
      }),
      opts,
    ).loops[0]!;
    expect(l.state).toBe('flowing');
    expect(l.observed).toBe(false);
    expect(l.runsPerDay).toBe(0);
    expect(l.evidence[0]).toMatch(/Upper bound/);
  });
});

describe('playbook gates', () => {
  const s = (seq: number, o: Partial<GardenData['attempts'][string]['steps'][number]> = {}) => ({
    seq,
    kind: 'tool_call',
    preview: null,
    toolName: 'Bash',
    callId: `c${seq}`,
    skillId: null,
    isError: false,
    errorKind: null,
    ...o,
  });
  it('tests_pass opens on a passing test command and closes on a failing one', () => {
    const call = s(1, { preview: JSON.stringify({ command: 'pnpm test' }) });
    expect(
      evaluateGate(
        { kind: 'tests_pass' },
        [call],
        [call, s(2, { kind: 'tool_result', callId: 'c1' })],
      ).gate,
    ).toBe('open');
    expect(
      evaluateGate(
        { kind: 'tests_pass' },
        [call],
        [call, s(2, { kind: 'tool_result', callId: 'c1', isError: true })],
      ).gate,
    ).toBe('closed');
    expect(
      evaluateGate(
        { kind: 'tests_pass' },
        [s(1, { preview: JSON.stringify({ command: 'echo "pnpm test"' }) })],
        [],
      ).gate,
    ).toBe('closed');
  });
  it('closes later gates as "not reached" after a closed gate', () => {
    const steps = [
      s(0, { skillId: 'skl_cl' }),
      s(1, { kind: 'tool_result', callId: 'c0' }),
      s(2, { skillId: 'skl_rt' }),
      s(3, { preview: JSON.stringify({ command: 'pnpm test' }) }),
      s(4, { kind: 'tool_result', callId: 'c3', isError: true }),
    ];
    const v = buildGardenView(
      data({
        runs: [run({ id: 'att' })],
        playbooks: [
          {
            id: 'pb',
            name: 'release',
            steps: [
              { id: 'cl', skillId: 'skl_cl', gate: { kind: 'step_success' } },
              { id: 'rt', skillId: 'skl_rt', gate: { kind: 'tests_pass' } },
              { id: 'tag', skillId: 'skl_tag', gate: { kind: 'command_ok', pattern: 'git tag' } },
            ],
          },
        ],
        attempts: { pb: { runId: 'att', steps } },
      }),
      opts,
    );
    expect(v.playbooks[0]!.steps.map((x) => x.gate)).toEqual(['open', 'closed', 'unknown']);
    expect(v.playbooks[0]!.steps[2]!.evidence).toMatch(/Not reached/);
  });
});
