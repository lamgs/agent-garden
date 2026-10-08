import { describe, expect, it } from 'vitest';
import {
  ENCODINGS,
  binIndex,
  bedStrata,
  bedStrataWeight,
  costUsd,
  legend,
  plantBloom,
  plantFade,
  plantHeight,
  plantHue,
  resolveModelPrice,
  scoreSignals,
  successCredit,
  wilsonInterval,
  betaSmoothed,
  median,
  SIGNALS,
  type PlantSummary,
  type BedSummary,
} from './index';

const plant = (over: Partial<PlantSummary> = {}): PlantSummary => ({
  id: 'p',
  agentId: 'a',
  agentKind: 'main',
  bedId: 'b',
  name: 'main',
  runs: 10,
  success: { value: 0.7, n: 10, nUnknown: 0, nManual: 0, ci95: null, method: 'h1' },
  recentFailureShare: 0.1,
  costPerRunUsd: 0.3,
  totalCostUsd: 3,
  costEstimated: false,
  unpricedRuns: 0,
  lastRunAt: null,
  staleDays: 2,
  skillIds: [],
  ...over,
});

describe('stats', () => {
  it('wilson interval brackets the proportion and handles n=0', () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    const [lo, hi] = wilsonInterval(8, 10)!;
    expect(lo).toBeLessThan(0.8);
    expect(hi).toBeGreaterThan(0.8);
    expect(lo).toBeCloseTo(0.49, 2);
    expect(hi).toBeCloseTo(0.943, 2);
  });
  it('beta smoothing pulls small samples toward 0.5', () => {
    expect(betaSmoothed(1, 1)).toBeCloseTo(0.6);
    expect(betaSmoothed(0, 0)).toBe(0.5);
  });
  it('median', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

describe('pricing', () => {
  it('prices all five token types', () => {
    const usd = costUsd(
      { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 },
      'claude-opus-5-5',
    );
    // 4 + 20 + 0.2 + 4*1.25 + 4*2
    expect(usd).toBeCloseTo(37.2);
  });
  it('resolves suffixed ids and refuses unknown models', () => {
    expect(resolveModelPrice('claude-sonnet-5-5[1m]')?.input).toBe(2);
    expect(resolveModelPrice('claude-haiku-4-5-20251001')?.contextWindow).toBe(200_000);
    expect(
      costUsd({ input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, 'gpt-x'),
    ).toBeNull();
  });
});

describe('heuristics', () => {
  it('unknown when nothing fired', () => {
    expect(scoreSignals([{ id: 'clean_finish', fired: false, weight: 0.1, detail: '' }])).toEqual({
      label: 'unknown',
      score: null,
    });
  });
  it('thresholds', () => {
    const s = (ids: string[]) =>
      scoreSignals(
        SIGNALS.map((d) => ({ id: d.id, fired: ids.includes(d.id), weight: d.weight, detail: '' })),
      );
    expect(s(['tests_passed_after_last_edit', 'clean_finish']).label).toBe('success');
    expect(s(['tests_failing_at_end']).label).toBe('failure');
    expect(s(['clean_finish']).label).toBe('partial');
    expect(s(['tests_failing_at_end', 'errors_in_tail', 'user_retried']).score).toBe(0);
  });
  it('credit', () => {
    expect(successCredit('partial')).toBe(0.5);
    expect(successCredit('unknown')).toBeNull();
  });
});

describe('encodings registry', () => {
  it('binIndex', () => {
    expect(binIndex(0, [1, 4])).toBe(0);
    expect(binIndex(1, [1, 4])).toBe(1);
    expect(binIndex(99, [1, 4])).toBe(2);
  });
  it('every encoding has a unique id and a legend entry with levels', () => {
    const ids = ENCODINGS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const l = legend();
    expect(l.map((e) => e.id)).toEqual(ids);
    for (const e of l) {
      expect(e.levels.length).toBeGreaterThan(0);
      expect(e.metric.length).toBeGreaterThan(0);
      expect(e.action.length).toBeGreaterThan(0);
    }
  });
  it('covers every element in the brief’s mapping table', () => {
    const elements = new Set(ENCODINGS.map((e) => e.element));
    for (const el of [
      'plant',
      'bed',
      'care_card',
      'irrigation',
      'bee',
      'weed',
      'playbook',
      'season',
    ])
      expect(elements.has(el as never)).toBe(true);
    const plantChannels = ENCODINGS.filter((e) => e.element === 'plant').map((e) => e.metric);
    expect(plantChannels.join(' ')).toMatch(/Runs/);
    expect(plantChannels.join(' ')).toMatch(/Success rate/);
    expect(plantChannels.join(' ')).toMatch(/cost/i);
  });
  it('plant levels stay within legend range for extreme inputs', () => {
    const extremes = [
      plant({
        runs: 0,
        success: { value: null, n: 0, nUnknown: 0, nManual: 0, ci95: null, method: '' },
        costPerRunUsd: null,
        staleDays: null,
        recentFailureShare: null,
      }),
      plant({
        runs: 10_000,
        success: { value: 1, n: 100, nUnknown: 0, nManual: 0, ci95: null, method: '' },
        costPerRunUsd: 999,
        staleDays: 999,
        recentFailureShare: 1,
      }),
    ];
    for (const p of extremes)
      for (const e of ENCODINGS.filter((x) => x.element === 'plant')) {
        const lvl = (e.level as (i: PlantSummary) => number)(p);
        expect(lvl).toBeGreaterThanOrEqual(0);
        expect(lvl).toBeLessThan(e.levels.length);
      }
  });
  it('specific bins', () => {
    expect(plantHeight.level(plant({ runs: 4 }))).toBe(2);
    expect(
      plantBloom.level(
        plant({ success: { value: 1, n: 5, nUnknown: 0, nManual: 0, ci95: null, method: '' } }),
      ),
    ).toBe(5);
    expect(
      plantBloom.level(
        plant({ success: { value: 1, n: 4, nUnknown: 0, nManual: 0, ci95: null, method: '' } }),
      ),
    ).toBe(0);
    expect(plantFade.level(plant({ staleDays: 14 }))).toBe(1);
    expect(plantHue.level(plant({ costPerRunUsd: 0.01 }))).toBe(1);
    const bed = {
      soil: { instructionBytes: 5000, toolCount: 0, mcpCount: 0, hookCount: 0 },
    } as BedSummary;
    // No knowledge scan: one band for the CLAUDE.md chain, weight from bytes ÷ 4.
    expect(bedStrata.level(bed)).toBe(1);
    expect(bedStrataWeight.level(bed)).toBe(1);
    const scanned = {
      soil: {
        ...bed.soil,
        knowledge: {
          alwaysTokens: 12_000,
          findingCount: 0,
          layers: [
            { layer: 'user', tokens: 300 },
            { layer: 'project', tokens: 11_000 },
            { layer: 'memory', tokens: 700 },
          ],
        },
      },
    } as BedSummary;
    expect(bedStrata.level(scanned)).toBe(3);
    expect(bedStrataWeight.level(scanned)).toBe(3);
  });
});
