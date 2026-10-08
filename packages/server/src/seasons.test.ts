import { describe, expect, it } from 'vitest';
import type { HarnessBundle } from '@garden/core';
import type { GardenData, RunRow } from './data';
import { buildGardenView } from './garden';
import {
  buildSeasonsView,
  meaningfulChanges,
  rateDeltaOf,
  segmentChain,
  titleFromDiff,
  SEASONS_CAVEAT,
} from './seasons';
import { diffBundles } from '@garden/ingest/harness';

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
    heuristicLabel: 'success',
    score: 0.8,
    manualNote: null,
    manualAt: null,
    toolCallCount: 3,
    signals: [],
    taskPreview: 'x',
    errorCount: 0,
    ...o,
  };
}
const base = {
  model: 'claude-opus-5-5',
  entrypoint: 'cli',
  instructions: [{ path: 'CLAUDE.md', hash: 'h1', bytes: 12_000 }],
  tools: ['Bash', 'Read'],
  skills: [],
  subagents: [],
  mcpServers: ['github'],
  hooks: [],
  settingsHash: 's1',
} as unknown as HarnessBundle;
type V = GardenData['versions'][number];
function version(
  id: string,
  from: number,
  to: number | null,
  b: Partial<HarnessBundle>,
  o: Partial<V> = {},
): V {
  return {
    id,
    familyId: 'fam_a',
    validFrom: day(from, 0),
    validTo: to === null ? null : day(to, 0),
    bundle: { ...base, ...b } as HarnessBundle,
    primaryAgentId: 'agt_main',
    provenance: 'git',
    commitMessage: `commit ${id}\n\nbody`,
    commitSha: `sha_${id}`,
    diff: null,
    ...o,
  };
}
function data(versions: V[], runs: RunRow[], o: Partial<GardenData> = {}): GardenData {
  return {
    families: [{ id: 'fam_a', name: 'shop-api' }],
    versions,
    agents: [
      { id: 'agt_main', name: 'main', kind: 'main', definition: null },
      { id: 'agt_tw', name: 'test-writer', kind: 'subagent', definition: null },
    ],
    skills: [],
    runs,
    skillCalls: [],
    mcpCalls: [],
    loops: [],
    playbooks: [],
    attempts: {},
    ...o,
  };
}
const window = { from: day(0, 0), to: day(30, 0) };
function view(d: GardenData) {
  const garden = buildGardenView(d, window);
  return buildSeasonsView(d, garden, 'fam_a', { window });
}

describe('segmentation', () => {
  it('one season per meaningful change; empty diffs merge into the season before', () => {
    const segs = segmentChain([
      version('hv3', 20, null, { model: 'claude-sonnet-5-5' }), // out of order on purpose
      version('hv1', 0, 10, {}),
      version('hv2', 10, 20, { entrypoint: 'sdk-cli' } as Partial<HarnessBundle>), // not a harness change
    ]);
    expect(segs.map((s) => s.versionIds)).toEqual([['hv1', 'hv2'], ['hv3']]);
    expect(segs[0]!.season).toMatchObject({ from: day(0, 0), to: day(20, 0), title: 'commit hv1' });
    expect(segs[1]!.season).toMatchObject({ from: day(20, 0), to: null, title: 'commit hv3' });
    expect(segs[1]!.season.diffSummary).toEqual(['model claude-opus-5-5 → claude-sonnet-5-5']);
  });

  it('same-size instruction edits and subagent changes count as real changes', () => {
    const edited = {
      ...base,
      instructions: [{ ...base.instructions[0]!, hash: 'h2' }],
    };
    expect(meaningfulChanges(base, edited as HarnessBundle)).toEqual([
      'instructions edited (same size)',
    ]);
    expect(meaningfulChanges(base, { ...base, subagents: ['agt_x'] })).toEqual(['subagents +1 −0']);
    expect(meaningfulChanges(base, { ...base, entrypoint: 'sdk-ts' })).toEqual([]);
  });

  it('titles: commit subject when the commit is new, else generated from the diff', () => {
    const segs = segmentChain([
      version('hv1', 0, 10, {}),
      // Same commit, model observed later: the commit subject was already used.
      version('hv2', 10, null, { model: 'claude-sonnet-5-5' }, { commitSha: 'sha_hv1' }),
    ]);
    expect(segs.map((s) => s.season.title)).toEqual(['commit hv1', 'Model: opus 5.5 → sonnet 5.5']);
    const observed = segmentChain([
      version('o1', 0, 5, {}, { provenance: 'observed', commitMessage: null, commitSha: null }),
      version(
        'o2',
        5,
        null,
        {
          instructions: [{ ...base.instructions[0]!, hash: 'h9', bytes: 2_000 }],
          effort: 'medium',
        },
        { provenance: 'observed', commitMessage: null, commitSha: null },
      ),
    ]);
    expect(observed.map((s) => s.season.title)).toEqual([
      'First observed harness',
      'Effort: ∅ → medium, CLAUDE.md −9.8 KB',
    ]);
    const d = diffBundles(base, {
      ...base,
      hooks: [{ event: 'Stop', commandHash: 'c' }],
      mcpServers: [],
      tools: ['Bash'],
    });
    expect(titleFromDiff(d, [])).toBe('MCP −github, Tools +0 −1 (+1 more)');
  });

  it('chains are per primary agent: a subagent harness does not cut the main chain', () => {
    const v = view(
      data(
        [
          version('hv1', 0, 10, {}),
          version('hv2', 10, null, { model: 'claude-sonnet-5-5' }),
          version('sub1', 3, null, { tools: ['Read'] }, { primaryAgentId: 'agt_tw' }),
        ],
        [
          run({ harnessVersionId: 'hv1', startedAt: day(2) }),
          run({ harnessVersionId: 'hv2', startedAt: day(12) }),
          run({ agentId: 'agt_tw', harnessVersionId: 'sub1', startedAt: day(4) }),
        ],
      ),
    )!;
    expect(v.seasons.map((s) => [s.agentId, s.harnessVersionId])).toEqual([
      ['agt_main', 'hv1'],
      ['agt_main', 'hv2'],
      ['agt_tw', 'sub1'],
    ]);
    expect(v.series.map((s) => [s.agentName, s.perSeason.map((p) => p.harnessVersionId)])).toEqual([
      ['main', ['hv1', 'hv2']],
      ['test-writer', ['sub1']],
    ]);
  });
});

describe('attribution and per-season metrics', () => {
  const versions = [
    version('hv1', 0, 10, {}),
    version('hv1b', 10, 15, { entrypoint: 'sdk-cli' } as Partial<HarnessBundle>), // merges into hv1
    version('hv2', 15, null, { model: 'claude-sonnet-5-5', instructions: [] }),
  ];
  it('runs go to the season of the harness they ran under, including boundary runs', () => {
    const runs = [
      run({ harnessVersionId: 'hv1', startedAt: day(1), label: 'failure' }),
      run({ harnessVersionId: 'hv1b', startedAt: day(11), label: 'success' }), // merged season
      // Started after hv2 first appeared, but on the old harness: still the old season.
      run({ harnessVersionId: 'hv1b', startedAt: day(15, 5), label: 'failure' }),
      // The run that defines the boundary (first use of hv2 = its validFrom).
      run({ harnessVersionId: 'hv2', startedAt: day(15, 0), label: 'success' }),
      run({ harnessVersionId: 'hv2', startedAt: day(20), label: 'partial', manual: true }),
      run({ harnessVersionId: 'hv2', startedAt: day(21), label: 'unknown' }),
    ];
    const v = view(data(versions, runs))!;
    expect(v.seasons.map((s) => s.harnessVersionId)).toEqual(['hv1', 'hv2']);
    const [s1, s2] = v.series[0]!.perSeason;
    expect(s1).toMatchObject({ harnessVersionId: 'hv1', runs: 3, vsPrevious: null });
    expect(s1!.success).toMatchObject({ n: 3, nUnknown: 0, nManual: 0 });
    expect(s1!.success.value).toBeCloseTo(1 / 3);
    // success 1 + partial 0.5 over 2 known; unknown excluded; manual counted.
    expect(s2).toMatchObject({ harnessVersionId: 'hv2', runs: 3 });
    expect(s2!.success).toMatchObject({ value: 0.75, n: 2, nUnknown: 1, nManual: 1 });
    expect(s2!.vsPrevious!.delta).toBeCloseTo(0.75 - 1 / 3);
    expect(s2!.vsPrevious!.separated).toBe(false); // tiny n: intervals overlap
    expect(v.series[0]!.perSeason.reduce((a, p) => a + p.runs, 0)).toBe(runs.length);
    expect(v.caveat).toBe(SEASONS_CAVEAT);
    expect(v.caveat).toMatch(/Correlation, not causation/);
  });

  it('separated when Wilson intervals do not overlap; median cost and the estimate flag', () => {
    const runs = [
      ...Array.from({ length: 40 }, (_, i) =>
        run({ harnessVersionId: 'hv1', startedAt: day(1), label: i < 8 ? 'success' : 'failure' }),
      ),
      ...Array.from({ length: 40 }, (_, i) =>
        run({
          harnessVersionId: 'hv2',
          startedAt: day(16),
          label: i < 36 ? 'success' : 'failure',
          tokenQuality: i === 0 ? 'output_estimated' : 'reported',
        }),
      ),
    ];
    const [s1, s2] = view(data(versions, runs))!.series[0]!.perSeason;
    expect(s1!.success.value).toBeCloseTo(0.2);
    expect(s2!.success.value).toBeCloseTo(0.9);
    expect(s2!.vsPrevious).toMatchObject({ separated: true });
    expect(s2!.vsPrevious!.delta).toBeCloseTo(0.7);
    expect(s1!.costEstimated).toBe(false);
    expect(s2!.costEstimated).toBe(true);
    expect(s1!.costPerRunUsd).toBeGreaterThan(0);
    expect(rateDeltaOf(null, s2!.success)).toEqual({ delta: null, separated: false });
  });

  it('loop-triggered runs get their own row; a season with no runs still shows', () => {
    const runs = [
      run({ harnessVersionId: 'hv1', startedAt: day(1) }),
      run({ harnessVersionId: 'hv1', startedAt: day(2), loopId: 'loop_n', trigger: 'automated' }),
      run({ harnessVersionId: 'hv2', startedAt: day(16) }),
    ];
    const v = view(
      data(versions, runs, {
        loops: [
          {
            id: 'loop_n',
            name: 'nightly',
            tier: 'application',
            provenance: 'declared',
            triggerKind: 'declared',
            triggerDetail: '',
            expectedIntervalSec: 86400,
            targets: { agentIds: ['agt_main'], familyIds: ['fam_a'] },
          },
        ],
      }),
    )!;
    expect(v.series.map((s) => [s.agentName, s.loop?.name ?? null])).toEqual([
      ['main', null],
      ['main', 'nightly'],
    ]);
    expect(v.series[1]!.perSeason.map((p) => p.runs)).toEqual([1, 0]);
    expect(v.series[1]!.perSeason[1]!.success.value).toBeNull();
    expect(v.series[1]!.perSeason[1]!.vsPrevious).toEqual({ delta: null, separated: false });
  });

  it('seasons outside the window are dropped; unknown beds give null', () => {
    const d = data(
      [version('old', -60, -40, {}), ...versions.map((x) => ({ ...x }))],
      [run({ harnessVersionId: 'hv2', startedAt: day(16) })],
    );
    d.versions[1]!.bundle = { ...base, model: 'claude-haiku-5' } as HarnessBundle;
    const v = view(d)!;
    expect(v.seasons.map((s) => s.harnessVersionId)).not.toContain('old');
    expect(v.window).toEqual(window);
    const garden = buildGardenView(d, window);
    expect(buildSeasonsView(d, garden, 'fam_nope', { window })).toBeNull();
  });
});
