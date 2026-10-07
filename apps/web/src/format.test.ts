import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GardenView, PlantSummary } from '@garden/core';
import { TableView } from './components/TableView';
import { describe as describeTarget, describePlant, type HoverTarget } from './describe';
import demo from './fixtures/garden.demo.json';
import { bedLabel, formatCostPerRun, formatRate, formatTotalCost, shortModel } from './format';

const view = demo as GardenView;
const tw = view.plants.find((p) => p.name === 'test-writer' && p.success.value! < 0.3)!;

describe('formatting', () => {
  it('formats a Rate with value, Wilson CI, n, unknown and manual counts', () => {
    expect(formatRate(tw.success)).toBe('26% (95% CI 19%–36%, n=102; 0 unknown, 0 manual)');
    expect(
      formatRate({ value: null, n: 0, nUnknown: 4, nManual: 0, ci95: null, method: 'x' }),
    ).toBe('no labeled runs (n=0; 4 unknown, 0 manual)');
    expect(
      formatRate({ value: 1, n: 3, nUnknown: 0, nManual: 2, ci95: [0.44, 1], method: 'x' }),
    ).toContain('n=3; 0 unknown, 2 manual');
  });

  it('marks estimated and unknown costs', () => {
    const est: PlantSummary = { ...tw, costEstimated: true };
    expect(formatCostPerRun(est)).toContain('estimated');
    expect(formatTotalCost(est)).toContain('(estimated)');
    expect(formatCostPerRun(tw)).not.toContain('estimated');
    expect(formatCostPerRun({ ...tw, costPerRunUsd: null, unpricedRuns: 3 })).toBe(
      'unknown (3 unpriced runs)',
    );
  });

  it('labels beds with name · model short name · effort', () => {
    const lm = view.beds.find((b) => b.name === 'legacy-monolith')!;
    expect(bedLabel(lm)).toBe('legacy-monolith · opus 5.5 · xhigh');
    expect(shortModel('claude-sonnet-5-5')).toBe('sonnet 5.5');
    expect(shortModel(undefined)).toBe('unknown model');
  });

  it('tooltip content carries metrics, levels, and how-computed text for every element', () => {
    const d = describePlant(view, tw);
    const text = JSON.stringify(d);
    expect(text).toContain('95% CI');
    expect(text).toContain('Drooping (≥50%)');
    expect(d.how).toHaveLength(5);
    const est = describePlant(view, { ...tw, costEstimated: true });
    expect(est.rows.find((r) => r.label === 'Cost')!.value).toContain('estimated');
    const targets: HoverTarget[] = [
      { kind: 'loop', id: view.loops[0]!.loopId },
      { kind: 'weed', id: view.weeds[0]!.id },
      { kind: 'bed', id: view.beds[0]!.id },
      { kind: 'gate', playbookId: view.playbooks[0]!.id, stepIndex: 1 },
      { kind: 'bee', from: view.bees[0]!.fromPlantId, to: view.bees[0]!.toPlantId },
      { kind: 'card', skillId: view.skills[0]!.skillId, plantId: view.skills[0]!.plantId },
    ];
    for (const t of targets) {
      const dd = describeTarget(view, t)!;
      expect(dd.how.length).toBeGreaterThan(0);
      expect(dd.rows.length).toBeGreaterThan(0);
    }
  });

  it('the table view shows the same Rate and cost strings as the tooltip', () => {
    const est: GardenView = {
      ...view,
      plants: view.plants.map((p) => (p.id === tw.id ? { ...p, costEstimated: true } : p)),
    };
    const html = renderToStaticMarkup(
      createElement(TableView, { view: est, onSelect: () => undefined }),
    );
    expect(html).toContain(formatRate(tw.success));
    expect(html).toContain('estimated');
    expect(html).toContain('flooding');
    expect(html).toContain('closed');
  });
});
