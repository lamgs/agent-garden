import { describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_BUDGET_TOKENS,
  alwaysLoadedTokens,
  checkBudget,
  checkDuplicates,
  checkReferences,
  checkSkills,
  checkStale,
  checkUsage,
  knowledgeFindings,
  layerOf,
  type KnowledgeCheckInput,
  type KnowledgeSourceFacts,
} from './knowledge';

const src = (p: Partial<KnowledgeSourceFacts> & { id: string }): KnowledgeSourceFacts => ({
  kind: 'project_claude_md',
  scope: 'project',
  displayPath: p.id,
  bytes: 400,
  lines: 10,
  alwaysBytes: p.loadMode && p.loadMode !== 'always' ? 0 : (p.bytes ?? 400),
  loadMode: 'always',
  passageHashes: [],
  ...p,
});

const input = (p: Partial<KnowledgeCheckInput>): KnowledgeCheckInput => ({
  sources: [],
  edges: [],
  usage: new Map(),
  history: [],
  window: { from: '2026-07-01T00:00:00Z', to: '2026-10-01T00:00:00Z' },
  skillPairs: [],
  sessionsInWindow: 20,
  ...p,
});

describe('layers and budget', () => {
  it('maps kinds to always-loaded layers; on-demand sources have none', () => {
    expect(layerOf(src({ id: 'a', kind: 'user_claude_md' }))).toBe('user');
    expect(layerOf(src({ id: 'b', kind: 'rule', loadMode: 'path_scoped' }))).toBeNull();
    expect(layerOf(src({ id: 'c', kind: 'skill', loadMode: 'on_demand', alwaysBytes: 120 }))).toBe(
      'listings',
    );
    expect(layerOf(src({ id: 'd', kind: 'nested_claude_md', loadMode: 'on_demand' }))).toBeNull();
  });

  it('sums always-loaded tokens per layer (bytes ÷ 4, rounded up)', () => {
    const r = alwaysLoadedTokens([
      src({ id: 'u', kind: 'user_claude_md', scope: 'user', bytes: 401 }),
      src({ id: 'p', bytes: 4000 }),
      src({ id: 'm', kind: 'memory_index', scope: 'memory', bytes: 30_000, alwaysBytes: 25_000 }),
    ]);
    expect(r.layers.map((l) => [l.layer, l.tokens])).toEqual([
      ['user', 101],
      ['project', 1000],
      ['memory', 6250],
    ]);
    expect(r.total).toBe(7351);
  });

  it('flags a bed over budget and a file over 200 lines', () => {
    const f = checkBudget(
      input({
        sources: [src({ id: 'big', bytes: KNOWLEDGE_BUDGET_TOKENS * 4 + 400, lines: 600 })],
      }),
    );
    expect(f.map((x) => x.kind).sort()).toEqual(['large_file', 'over_budget']);
    expect(f.find((x) => x.kind === 'over_budget')!.tokensAtStake).toBe(100);
    expect(f.find((x) => x.kind === 'over_budget')!.action).toBe('move_to_on_demand');
  });

  it('flags growth over the window from the history series', () => {
    const f = checkBudget(
      input({
        history: [
          { at: '2026-05-01T00:00:00Z', tokens: 1000 },
          { at: '2026-08-01T00:00:00Z', tokens: 1500 },
          { at: '2026-10-01T00:00:00Z', tokens: 3000 },
        ],
      }),
    );
    const g = f.find((x) => x.kind === 'budget_growth')!;
    expect(g.tokensAtStake).toBe(2000);
    expect(g.evidence[0]).toContain('+200%');
  });
});

describe('duplicates', () => {
  it('finds passages shared by the user and a project CLAUDE.md and suggests deleting the project copy', () => {
    const f = checkDuplicates(
      input({
        sources: [
          src({
            id: 'u',
            kind: 'user_claude_md',
            scope: 'user',
            displayPath: '~/.claude/CLAUDE.md',
            passageHashes: ['h1:80', 'h2:60'],
          }),
          src({ id: 'p', displayPath: 'CLAUDE.md', passageHashes: ['h1:80', 'h3:50'] }),
        ],
      }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.kind).toBe('duplicate_passage');
    expect(f[0]!.tokensAtStake).toBe(20);
    expect(f[0]!.actionText).toContain('Delete the copy in CLAUDE.md');
  });

  it('counts repeats within one file and cross-bed copies', () => {
    const f = checkDuplicates(
      input({
        sources: [src({ id: 'p', passageHashes: ['h1:40', 'h1:40', 'h9:100'] })],
        otherBedPassages: new Map([['h9', ['shop-api']]]),
      }),
    );
    expect(f.map((x) => x.action).sort()).toEqual(['dedupe', 'dedupe_into_user']);
  });
});

describe('references and memory', () => {
  const index = src({
    id: 'idx',
    kind: 'memory_index',
    scope: 'memory',
    displayPath: 'memory/MEMORY.md',
    lines: 260,
    bytes: 12_000,
    alwaysBytes: 9_000,
  });
  const topicA = src({ id: 'ta', kind: 'memory_topic', scope: 'memory', loadMode: 'on_demand' });
  const topicB = src({ id: 'tb', kind: 'memory_topic', scope: 'memory', loadMode: 'on_demand' });
  const topicC = src({ id: 'tc', kind: 'memory_topic', scope: 'memory', loadMode: 'on_demand' });
  const edges = [
    {
      id: 'e1',
      fromId: 'idx',
      toId: 'ta',
      kind: 'index_link' as const,
      target: 'a.md',
      resolved: true,
      beyondCap: false,
    },
    {
      id: 'e2',
      fromId: 'idx',
      toId: 'tb',
      kind: 'index_link' as const,
      target: 'b.md',
      resolved: true,
      beyondCap: true,
    },
    {
      id: 'e3',
      fromId: 'p',
      kind: 'import' as const,
      target: '@docs/gone.md',
      resolved: false,
      beyondCap: false,
      reason: 'no such file',
    },
  ];
  const f = checkReferences(
    input({ sources: [index, topicA, topicB, topicC, src({ id: 'p' })], edges }),
  );

  it('flags dangling imports from always-loaded files as high severity', () => {
    const d = f.find((x) => x.kind === 'dangling_ref')!;
    expect(d.severity).toBe('high');
    expect(d.edgeIds).toEqual(['e3']);
  });
  it('flags orphan memory files, and ones linked only past the cap', () => {
    const o = f.filter((x) => x.kind === 'orphan_memory');
    expect(o.map((x) => x.sourceIds[0]).sort()).toEqual(['tb', 'tc']);
    expect(o.find((x) => x.sourceIds[0] === 'tb')!.action).toBe('shorten_index');
    expect(o.find((x) => x.sourceIds[0] === 'tc')!.action).toBe('add_reference');
  });
  it('a memory file that was read is not an orphan', () => {
    const g = checkReferences(
      input({
        sources: [topicC],
        usage: new Map([
          ['tc', { count: 2, sessions: 2, lastAt: '2026-09-01T00:00:00Z', kinds: ['read'] }],
        ]),
      }),
    );
    expect(g).toEqual([]);
  });
  it('flags MEMORY.md over its load cap with the pointers it hides', () => {
    const c = f.find((x) => x.kind === 'over_cap')!;
    expect(c.severity).toBe('high');
    expect(c.edgeIds).toEqual(['e2']);
    expect(c.tokensAtStake).toBe(750);
  });
});

describe('usage, staleness, skills', () => {
  it('groups on-demand sources never loaded in the window, skipping ones already flagged', () => {
    const f = checkUsage(
      input({
        sources: [
          src({ id: 'n1', kind: 'nested_claude_md', loadMode: 'on_demand' }),
          src({ id: 'n2', kind: 'nested_claude_md', loadMode: 'on_demand' }),
          src({ id: 's1', kind: 'skill', loadMode: 'on_demand', alwaysBytes: 200, name: 'x' }),
          src({ id: 't1', kind: 'memory_topic', loadMode: 'on_demand' }),
        ],
        usage: new Map([['n2', { count: 1, sessions: 1, lastAt: null, kinds: ['nested_load'] }]]),
      }),
      new Set(['t1']),
    );
    expect(f.map((x) => [x.sourceIds, x.action])).toEqual([
      [['n1'], 'delete'],
      [['s1'], 'review'],
    ]);
  });
  it('says nothing about usage without sessions', () => {
    expect(
      checkUsage(
        input({
          sessionsInWindow: 0,
          sources: [src({ id: 'n', kind: 'rule', loadMode: 'path_scoped' })],
        }),
        new Set(),
      ),
    ).toEqual([]);
  });
  it('flags stale always-loaded files only when outcomes dropped, with a correlation caveat', () => {
    const base = {
      sources: [
        src({ id: 'old', lastChangedAt: '2026-05-01T00:00:00Z' }),
        src({ id: 'new', lastChangedAt: '2026-09-20T00:00:00Z' }),
      ],
    };
    const drop = {
      recent: { value: 0.4, n: 20 },
      prior: { value: 0.7, n: 40 },
      splitAt: '2026-09-01T00:00:00Z',
    };
    const f = checkStale(input({ ...base, outcomeTrend: drop }));
    expect(f).toHaveLength(1);
    expect(f[0]!.sourceIds).toEqual(['old']);
    expect(f[0]!.caveat).toMatch(/Correlation/);
    expect(
      checkStale(input({ ...base, outcomeTrend: { ...drop, recent: { value: 0.68, n: 20 } } })),
    ).toEqual([]);
    expect(
      checkStale(input({ ...base, outcomeTrend: { ...drop, recent: { value: 0.4, n: 3 } } })),
    ).toEqual([]);
  });
  it('flags overlapping skill descriptions', () => {
    const f = checkSkills(
      input({
        sources: [
          src({ id: 'a', kind: 'skill', loadMode: 'on_demand', alwaysBytes: 100, name: 'a' }),
          src({ id: 'b', kind: 'skill', loadMode: 'on_demand', alwaysBytes: 80, name: 'b' }),
        ],
        skillPairs: [
          { aId: 'a', bId: 'b', similarity: 0.9 },
          { aId: 'a', bId: 'b', similarity: 0.1 },
        ],
      }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.tokensAtStake).toBe(20);
  });
});

describe('knowledgeFindings', () => {
  it('is deterministic and sorted by severity, then tokens', () => {
    const i = input({
      sources: [
        src({ id: 'p', bytes: 50_000, lines: 900, passageHashes: ['h:10', 'h:10'] }),
        src({
          id: 'nd',
          kind: 'not_a_file' as never,
          loadMode: 'not_loaded',
          loadNote: 'AGENTS.md is shadowed',
        }),
      ],
      edges: [
        {
          id: 'e',
          fromId: 'p',
          kind: 'import',
          target: '@x.md',
          resolved: false,
          beyondCap: false,
        },
      ],
    });
    const a = knowledgeFindings(i);
    expect(a).toEqual(knowledgeFindings(i));
    const sev = a.map((f) => f.severity);
    expect(sev.indexOf('low')).toBeGreaterThan(sev.lastIndexOf('high'));
    expect(new Set(a.map((f) => f.id)).size).toBe(a.length);
  });
});
