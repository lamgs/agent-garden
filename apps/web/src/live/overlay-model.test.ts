import { describe, expect, it } from 'vitest';
import {
  ENCODINGS,
  LIVE_GLYPH_ACTIVITIES,
  liveActivity,
  liveAttention,
  liveRing,
  type GardenView,
  type LiveActivity,
  type LiveAgent,
  type LiveSnapshot,
} from '@garden/core';
import garden from '../fixtures/garden.demo.json';
import { createLiveDemo, DEMO_LOOPS } from '../fixtures/live-demo';
import { computeLayout } from '../garden/layout';
import { freeSlots } from '../garden/live-layout';
import { attentionQueue, reduceAll } from './live-client';
import {
  anchorFor,
  anchorKey,
  glyphFor,
  isCompactionCut,
  liveBees,
  newLoopRuns,
  overlayMarks,
  waitInferred,
} from './overlay-model';

const view = garden as GardenView;
const shop = view.beds.find((b) => b.name === 'shop-api')!;
const shopMain = view.plants.find((p) => p.bedId === shop.id && p.name === 'main')!;

function agent(over: Partial<LiveAgent> = {}): LiveAgent {
  return {
    key: 'k1',
    sessionId: 's1',
    agentName: 'main',
    agentKind: 'main',
    bedId: shop.id,
    bedName: shop.name,
    activity: 'thinking',
    activitySince: '2026-10-01T12:00:00.000Z',
    lastEventAt: '2026-10-01T12:00:00.000Z',
    contextTokens: 50_000,
    contextWindow: 200_000,
    toolCalls: 0,
    errors: 0,
    evidence: 'test',
    ...over,
  };
}

function snap(agents: LiveAgent[], source: LiveSnapshot['source'] = 'transcripts'): LiveSnapshot {
  return {
    generatedAt: '2026-10-01T12:00:10.000Z',
    source,
    agents,
    activeWindowSec: 300,
    recent: [],
  };
}

/** Play the fixture stream for `ms` virtual milliseconds. */
function played(ms: number): LiveSnapshot {
  const d = createLiveDemo();
  let s: LiveSnapshot | null = d.snapshot();
  for (let t = 0; t < ms; t += 250) s = reduceAll(s, d.advance(250));
  return s!;
}

describe('agent → plant join', () => {
  it('uses plantId when the plant is in the view', () => {
    expect(anchorFor(agent({ plantId: shopMain.id }), view)).toEqual({
      kind: 'plant',
      plantId: shopMain.id,
      bedId: shop.id,
    });
  });

  it('falls back to bed + agent name when plantId is missing or unknown', () => {
    const a = anchorFor(agent({ plantId: 'plt_not_in_window' }), view);
    expect(a).toEqual({ kind: 'plant', plantId: shopMain.id, bedId: shop.id });
    expect(anchorFor(agent(), view)).toEqual(a);
  });

  it('is a seedling when the bed exists but the agent has no planting', () => {
    const a = anchorFor(agent({ agentName: 'brand-new-agent', agentKind: 'subagent' }), view);
    expect(a).toEqual({ kind: 'seedling', bedId: shop.id, agentName: 'brand-new-agent' });
    expect(anchorKey(a)).toBe(`seed:${shop.id}:brand-new-agent`);
  });

  it('is off-stage when the bed is not in this garden', () => {
    expect(anchorFor(agent({ bedId: 'fam_elsewhere' }), view)).toEqual({ kind: 'offstage' });
  });

  it('joins every fixture agent to a plant except the new cost-estimator seedling', () => {
    const s = played(30_000);
    const { marks, offstage } = overlayMarks(view, s);
    expect(offstage).toEqual([]);
    const seeds = marks.filter((m) => m.anchor.kind === 'seedling');
    expect(seeds.map((m) => m.primary.agentName)).toEqual(['cost-estimator']);
    for (const m of marks)
      if (m.anchor.kind === 'plant') expect(view.plants.some((p) => p.id === m.key)).toBe(true);
  });
});

describe('glyph mapping', () => {
  it('maps every glyph activity to its legend level and the rest to no mark', () => {
    LIVE_GLYPH_ACTIVITIES.forEach((a, i) => {
      expect(glyphFor(a)).toBe(a);
      expect(liveActivity.level({ activity: a })).toBe(i);
    });
    expect(LIVE_GLYPH_ACTIVITIES.length).toBe(liveActivity.levels.length);
    for (const a of ['idle', 'waiting_permission', 'waiting_input', 'errored'] as LiveActivity[])
      expect(glyphFor(a)).toBeNull();
  });

  it('registers every live channel in the encodings registry', () => {
    const ids = ENCODINGS.filter((e) => e.element === 'live').map((e) => e.id);
    expect(ids).toEqual([
      'live.ring',
      'live.activity',
      'live.attention',
      'live.error',
      'live.compaction',
      'live.bee',
      'live.loop_pulse',
      'live.seedling',
      'live.count',
    ]);
  });

  it('bins the ring by context fill like the replay band, faint when idle or done', () => {
    expect(liveRing.level(agent({ contextTokens: 20_000 }))).toBe(0);
    expect(liveRing.level(agent({ contextTokens: 120_000 }))).toBe(1);
    expect(liveRing.level(agent({ contextTokens: 190_000 }))).toBe(2);
    expect(liveRing.level(agent({ activity: 'idle' }))).toBe(3);
    expect(liveRing.level(agent({ activity: 'done', contextTokens: 190_000 }))).toBe(3);
  });
});

describe('overlay state from a snapshot', () => {
  it('shows the most urgent agent of a shared plant and counts the rest', () => {
    const s = snap([
      agent({ key: 'a', activity: 'editing', lastEventAt: '2026-10-01T12:00:09.000Z' }),
      agent({ key: 'b', activity: 'waiting_permission', contextTokens: 170_000 }),
      agent({ key: 'c', activity: 'idle' }),
    ]);
    const [m] = overlayMarks(view, s).marks;
    expect(m!.key).toBe(shopMain.id);
    expect(m!.count).toBe(3);
    expect(m!.primary.key).toBe('b');
    expect(m!.glyph).toBeNull();
    expect(m!.attention).toEqual({ reason: 'waiting_permission', inferred: true });
    expect(m!.ringLevel).toBe(2);
    expect(m!.fill).toBeCloseTo(0.85);
  });

  it('dashes inferred waits; hooks, the registry, and AskUserQuestion are recorded', () => {
    const silent = agent({ activity: 'waiting_permission', evidence: 'possibly waiting…' });
    expect(waitInferred(silent, 'transcripts')).toBe(true);
    expect(waitInferred(silent, 'demo')).toBe(true);
    expect(waitInferred(silent, 'hooks')).toBe(false);
    expect(
      waitInferred(
        agent({ activity: 'waiting_permission', evidence: 'session registry status waiting' }),
        'transcripts',
      ),
    ).toBe(false);
    expect(
      waitInferred(
        agent({
          activity: 'waiting_input',
          currentTool: { name: 'AskUserQuestion', category: 'builtin' },
        }),
        'transcripts',
      ),
    ).toBe(false);
    expect(liveAttention.level({ reason: 'waiting_permission', inferred: true })).toBe(1);
    expect(liveAttention.level({ reason: 'waiting_input', inferred: false })).toBe(2);
    // The Needs-you queue uses the same rule.
    const q = attentionQueue(
      snap([
        silent,
        agent({ key: 'r', activity: 'waiting_input', evidence: 'session registry status waiting' }),
      ]),
    );
    expect(q.map((i) => [i.key, i.inferred])).toEqual([
      ['k1', true],
      ['r', false],
    ]);
  });

  it('carries errors and compaction state', () => {
    const [m] = overlayMarks(view, snap([agent({ activity: 'errored', errors: 2 })])).marks;
    expect(m!.errored).toBe(true);
    expect(m!.errors).toBe(2);
    const a = agent({ contextTokens: 20_000 });
    expect(isCompactionCut(0.9, a)).toBe(true);
    expect(isCompactionCut(0.12, a)).toBe(false);
    expect(isCompactionCut(undefined, a)).toBe(false);
    expect(isCompactionCut(undefined, agent({ activity: 'compacting' }))).toBe(true);
  });

  it('flies a bee parent → child while the child works, and back when it is done', () => {
    const parent = agent({ key: 'p', activity: 'delegating' });
    const child = agent({
      key: 'p:test-writer:1',
      agentName: 'test-writer',
      agentKind: 'subagent',
      parentKey: 'p',
    });
    const testWriter = view.plants.find((p) => p.bedId === shop.id && p.name === 'test-writer')!;
    expect(liveBees(view, snap([parent, child]))).toEqual([
      { key: child.key, from: shopMain.id, to: testWriter.id, returning: false },
    ]);
    expect(liveBees(view, snap([parent, { ...child, activity: 'done' }]))[0]!.returning).toBe(true);
    expect(liveBees(view, snap([child]))).toEqual([]);
  });

  it('pulses a loop channel once, for new loop-triggered runs only', () => {
    const seen = new Set<string>();
    const loopRun = agent({ key: 'h1', loop: { ...DEMO_LOOPS.backfill } });
    expect(newLoopRuns(view, snap([loopRun]), seen)).toEqual([DEMO_LOOPS.backfill.id]);
    expect(newLoopRuns(view, snap([loopRun]), seen)).toEqual([]);
    const byName = agent({ key: 'h2', loop: { name: DEMO_LOOPS.flaky.name, tier: 'application' } });
    expect(newLoopRuns(view, snap([loopRun, byName]), seen)).toEqual([DEMO_LOOPS.flaky.id]);
  });

  it('fixture stream: the shop-api publish becomes an inferred permission wait', () => {
    const s = played(20_000);
    const { marks } = overlayMarks(view, s);
    const m = marks.find((x) => x.key === shopMain.id)!;
    expect(m.attention).toEqual({ reason: 'waiting_permission', inferred: true });
    expect(attentionQueue(s)[0]!.agent.bedName).toBe('shop-api');
  });
});

describe('seedling placement', () => {
  it('takes free slots in the bed, never a planted one', () => {
    const L = computeLayout(view);
    const spots = freeSlots(L, shop.id, 3);
    expect(spots).toHaveLength(3);
    const planted = [...L.plants.values()].filter((p) => p.bedId === shop.id);
    for (const s of spots) {
      expect(planted.some((p) => p.x === s.x && p.y === s.y)).toBe(false);
      const bed = L.beds.find((b) => b.bedId === shop.id)!;
      expect(s.x).toBeGreaterThan(bed.x);
      expect(s.x).toBeLessThan(bed.x + bed.w);
      expect(s.y).toBeGreaterThan(bed.y);
      expect(s.y).toBeLessThan(bed.y + bed.h);
    }
    expect(new Set(spots.map((s) => `${s.x},${s.y}`)).size).toBe(3);
    expect(freeSlots(L, 'fam_missing', 2)).toEqual([]);
  });
});
