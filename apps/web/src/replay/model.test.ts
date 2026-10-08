import { describe, expect, it } from 'vitest';
import {
  ENCODINGS,
  replayContext,
  replayMarkShape,
  STEP_KINDS,
  type ReplayView,
} from '@garden/core';
import fixture from '../fixtures/replay.demo.json';
import { parseRoute, formatRoute, replayHref, latestReplayHref } from '../route';
import {
  buildModel,
  buildTimeline,
  COMPRESSED_GAP_MS,
  flattenLanes,
  IDLE_THRESHOLD_MS,
  laneFrameAt,
  stepAtDisplay,
} from './model';

const runs = (fixture as unknown as { runs: Record<string, ReplayView> }).runs;
const DEMO = runs['run_8308c289de49b5b3']!;

describe('replay time axis', () => {
  it('keeps short gaps real and compresses idle gaps to a fixed, labeled width', () => {
    const t = buildTimeline([0, 1000, 3000, 3000 + 120_000, 3000 + 121_000]);
    expect(t.gaps).toEqual([{ at: 3000, realMs: 120_000 }]);
    expect(t.total).toBe(3000 + COMPRESSED_GAP_MS + 1000);
    expect(t.toDisplay(1000)).toBe(1000);
    expect(t.toDisplay(3000 + 60_000)).toBeCloseTo(3000 + COMPRESSED_GAP_MS / 2);
    expect(t.toAbs(t.toDisplay(3000 + 120_500))).toBeCloseTo(3000 + 120_500);
    // A gap exactly at the threshold is not compressed.
    expect(buildTimeline([0, IDLE_THRESHOLD_MS]).gaps).toEqual([]);
  });

  it('is monotone over the demo replay', () => {
    const m = buildModel(DEMO);
    let prev = -1;
    for (const s of m.steps) {
      const d = m.timeline.toDisplay(s.at);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
    expect(m.timeline.total).toBeLessThan(m.timeline.end - m.timeline.start);
  });
});

describe('replay lanes and playback order', () => {
  it('flattens the run tree: main lane first, each child after its spawn', () => {
    const lanes = flattenLanes(DEMO);
    expect(lanes.map((l) => [l.depth, l.view.agent.name])).toEqual([
      [0, 'main'],
      [1, 'test-writer'],
      [1, 'test-writer'],
    ]);
    for (const l of lanes.slice(1)) {
      expect(l.parent).toBe(0);
      const fork = DEMO.frames[l.spawnFrame!]!;
      expect(fork.kind).toBe('subagent_spawn');
      expect(fork.forkRunId).toBe(l.runId);
    }
  });

  it('plays every step of every lane once, in time order', () => {
    const m = buildModel(DEMO);
    const total = DEMO.frames.length + DEMO.children.reduce((n, c) => n + c.frames.length, 0);
    expect(m.steps).toHaveLength(total);
    for (let i = 1; i < m.steps.length; i++)
      expect(m.steps[i]!.at).toBeGreaterThanOrEqual(m.steps[i - 1]!.at);
    expect(stepAtDisplay(m, -1)).toBe(-1);
    expect(stepAtDisplay(m, m.timeline.total)).toBe(total - 1);
    expect(laneFrameAt(m, 0, total - 1)).toBe(DEMO.frames.length - 1);
    expect(laneFrameAt(m, 1, 0)).toBeNull();
  });
});

describe('replay encodings and fixture', () => {
  it('every step kind maps to a mark shape and context levels follow the fill', () => {
    for (const kind of STEP_KINDS)
      expect(replayMarkShape.level({ kind })).toBeLessThan(replayMarkShape.levels.length);
    expect(replayContext.level({ contextFill: 0.1 })).toBe(0);
    expect(replayContext.level({ contextFill: 0.85 })).toBe(2);
    expect(ENCODINGS.filter((e) => e.element === 'replay').length).toBeGreaterThanOrEqual(6);
  });

  it('the demo fixture carries forks, a compaction, errors, and context within the window', () => {
    expect(DEMO.compactions).toBe(1);
    expect(DEMO.children).toHaveLength(2);
    expect(DEMO.children.every((c) => c.frames.some((f) => f.isError))).toBe(true);
    for (const v of [DEMO, ...DEMO.children])
      for (const f of v.frames) {
        expect(f.contextFill).toBeCloseTo(Math.min(1, f.contextTokens / v.contextWindow));
        expect(f.label).not.toMatch(/^Thinking \((?!\d|redacted|no text recorded)/);
      }
  });

  it('routes: #/replay/:runId and #/replay?plant= round-trip', () => {
    expect(parseRoute(replayHref('run_x'))).toEqual({
      view: 'replay',
      runId: 'run_x',
      plantId: null,
    });
    expect(parseRoute(latestReplayHref('plt_y'))).toEqual({
      view: 'replay',
      runId: null,
      plantId: 'plt_y',
    });
    expect(formatRoute(parseRoute('#/replay/run_x'))).toBe('#/replay/run_x');
    expect(parseRoute('#/replay').view).toBe('unknown');
  });
});
