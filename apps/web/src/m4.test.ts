import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BedCompareView, GardenView, PlantView, ReplantView } from '@garden/core';
import {
  formatDuration,
  formatPoints,
  formatRatio,
  separationBadge,
  signalName,
  soilChanges,
  verdictSentence,
} from './compare-format';
import {
  apiUrl,
  dataMode,
  labelingDisabledReason,
  resolveFixture,
  type DemoFixtures,
} from './data/views';
import compareJson from './fixtures/compare.demo.json';
import gardenJson from './fixtures/garden.demo.json';
import plantJson from './fixtures/plant.demo.json';
import replantJson from './fixtures/replant.demo.json';
import { compareHref, formatRoute, parseRoute, plantHref, replantHref, type Route } from './route';
import { ComparePage } from './views/ComparePage';
import { PlantPage } from './views/PlantPage';
import { ReplantPage } from './views/ReplantPage';

const plant = plantJson as unknown as PlantView;
const compare = compareJson as unknown as BedCompareView;
const replant = replantJson as unknown as ReplantView;
const garden = gardenJson as unknown as GardenView;
const fx: DemoFixtures = { plant, compare, replant };

describe('routing', () => {
  it('parses every route and round-trips through formatRoute', () => {
    const routes: Route[] = [
      { view: 'garden' },
      { view: 'plant', plantId: 'plt_1' },
      { view: 'compare', left: 'fam_a', right: 'fam_b' },
      { view: 'replant', agent: 'agt_x', from: 'fam_a', to: 'fam_b' },
    ];
    for (const r of routes) expect(parseRoute(formatRoute(r))).toEqual(r);
  });
  it('treats empty hashes as the garden and malformed ones as unknown', () => {
    expect(parseRoute('')).toEqual({ view: 'garden' });
    expect(parseRoute('#')).toEqual({ view: 'garden' });
    expect(parseRoute('#/')).toEqual({ view: 'garden' });
    expect(parseRoute('#/compare?left=a')).toEqual({ view: 'unknown', hash: '/compare?left=a' });
    expect(parseRoute('#/plant/')).toEqual({ view: 'unknown', hash: '/plant/' });
    expect(parseRoute('#/nope')).toEqual({ view: 'unknown', hash: '/nope' });
  });
  it('encodes ids safely', () => {
    expect(plantHref('a/b c')).toBe('#/plant/a%2Fb%20c');
    expect(parseRoute(plantHref('a/b c'))).toEqual({ view: 'plant', plantId: 'a/b c' });
    expect(compareHref('x', 'y')).toBe('#/compare?left=x&right=y');
    expect(replantHref('a', 'f', 't')).toBe('#/replant?agent=a&from=f&to=t');
  });
});

describe('delta, ratio, and badge formatting', () => {
  it('formats rate deltas in points with a real minus sign', () => {
    expect(formatPoints(replant.success.delta)).toBe('−65 points');
    expect(formatPoints(0.004)).toBe('0 points');
    expect(formatPoints(0.01)).toBe('+1 point');
    expect(formatPoints(null)).toBe('no comparison');
  });
  it('formats cost ratios', () => {
    expect(formatRatio(replant.costRatio)).toBe('3.1×');
    expect(formatRatio(0.456)).toBe('0.46×');
    expect(formatRatio(12.4)).toBe('12×');
    expect(formatRatio(null)).toBe('unknown');
  });
  it('labels separation honestly', () => {
    expect(separationBadge({ delta: -0.65, separated: true }).label).toBe('separated');
    expect(separationBadge({ delta: 0, separated: false }).label).toBe('within noise');
    expect(separationBadge({ delta: null, separated: false }).kind).toBe('none');
  });
  it('writes the verdict sentence', () => {
    expect(verdictSentence('test-writer', 'legacy-monolith', -0.652, 3.07)).toBe(
      'In legacy-monolith, test-writer’s success rate is 65 points lower, at 3.1× the cost per run.',
    );
    expect(verdictSentence('a', 'b', 0.001, 1.01)).toBe(
      'In b, a’s success rate is about the same, at about the same cost per run.',
    );
  });
  it('names signals and durations', () => {
    expect(signalName('tests_failing_at_end')).toBe('Tests failing at end');
    expect(signalName('some_new_signal')).toBe('Some new signal');
    expect(formatDuration(59_600)).toBe('1 min 0 s');
    expect(formatDuration(119_471)).toBe('1 min 59 s');
    expect(formatDuration(450)).toBe('450 ms');
  });
});

describe('what changed in the soil', () => {
  it('lists the biggest changes first: model, instructions, MCP, hooks', () => {
    const items = soilChanges(replant.harnessDiff, replant.harnessChanges);
    expect(items.map((i) => i.key)).toEqual([
      'model',
      'instructions',
      'mcp',
      'hooks',
      'effort',
      'permissions',
      'skills',
      'settings',
    ]);
    expect(items[0]!.title).toBe('Model: sonnet 5.5 → opus 5.5');
    expect(items[1]!.title).toBe('Instructions +29.4 KB');
    expect(items[2]!.title).toBe('+7 MCP servers');
  });
  it('falls back to summary strings, still ordered', () => {
    const items = soilChanges(null, ['hooks changed', 'MCP +x −0', 'model a → b']);
    expect(items.map((i) => i.key)).toEqual(['model', 'mcp', 'hooks']);
  });
  it('says so when nothing differs', () => {
    expect(soilChanges(null, [])).toEqual([]);
  });
});

describe('fixture resolution and data modes', () => {
  it('resolves exactly the demo ids', () => {
    expect(resolveFixture({ view: 'plant', plantId: plant.plant.id }, fx)).toBe(plant);
    expect(resolveFixture({ view: 'plant', plantId: 'plt_other' }, fx)).toBeNull();
    const c = { view: 'compare' as const, left: compare.left.bed.id, right: compare.right.bed.id };
    expect(resolveFixture(c, fx)).toBe(compare);
    expect(resolveFixture({ ...c, left: c.right, right: c.left }, fx)).toBeNull();
    const r = {
      view: 'replant' as const,
      agent: replant.agent.id,
      from: replant.from.bed.id,
      to: replant.to.bed.id,
    };
    expect(resolveFixture(r, fx)).toBe(replant);
    expect(resolveFixture({ ...r, from: r.to, to: r.from }, fx)).toBeNull();
  });
  it('labels are writable only against the live API', () => {
    expect(labelingDisabledReason('api')).toBeNull();
    expect(labelingDisabledReason('fixture')).toMatch(/saved by the local server/);
    expect(labelingDisabledReason('static')).toMatch(/pnpm demo/);
    expect(dataMode('?fixture=demo', false)).toBe('fixture');
    expect(dataMode('', true)).toBe('static');
    expect(dataMode('', false)).toBe('api');
  });
  it('builds API urls with the window', () => {
    expect(apiUrl({ view: 'plant', plantId: 'p 1' }, 30)).toBe('/api/plant/p%201?days=30');
    expect(apiUrl({ view: 'compare', left: 'a', right: 'b' }, 90)).toBe(
      '/api/compare?left=a&right=b&days=90',
    );
    expect(apiUrl({ view: 'replant', agent: 'x', from: 'a', to: 'b' }, 90)).toBe(
      '/api/replant?agent=x&from=a&to=b&days=90',
    );
  });
});

describe('pages render the contracts (server-side, no canvas)', () => {
  it('plant view: rate with n and CI, evidence, other beds with names, runs', () => {
    const html = renderToStaticMarkup(
      createElement(PlantPage, {
        result: { status: 'ok', data: plant, source: 'fixture' },
        garden,
        onReload: () => undefined,
      }),
    );
    expect(html).toContain('Why this rate');
    expect(html).toContain('95% Wilson interval <b>19%–36%</b>');
    expect(html).toContain('n=102');
    expect(html).toContain('Tests failing at end');
    expect(html).toContain('Compare in shop-api →');
    expect(html).toContain('Showing 40 of 102 runs');
    expect(html).toContain('(labels are read-only here)');
  });
  it('compare view: soil diff, deltas, badge, caveat', () => {
    const html = renderToStaticMarkup(
      createElement(ComparePage, {
        result: { status: 'ok', data: compare, source: 'fixture' },
        garden,
      }),
    );
    expect(html).toContain('What differs in the soil');
    expect(html).toContain('−65 points');
    expect(html).toContain('within noise');
    expect(html).toContain('Correlation, not causation');
  });
  it('replant view: verdict, signals, and the never-planted state', () => {
    const ok = renderToStaticMarkup(
      createElement(ReplantPage, {
        result: { status: 'ok', data: replant, source: 'fixture' },
        garden,
      }),
    );
    expect(ok).toContain('−65 points');
    expect(ok).toContain('3.1×');
    expect(ok).toContain('How often each signal fired');
    expect(ok).not.toContain('User retried or corrected'); // null on both sides: skipped
    const empty: ReplantView = {
      ...replant,
      to: { ...replant.to, plant: null, recent: [] },
      success: { delta: null, separated: false },
      costRatio: null,
      signals: [],
    };
    const html = renderToStaticMarkup(
      createElement(ReplantPage, {
        result: { status: 'ok', data: empty, source: 'fixture' },
        garden,
      }),
    );
    expect(html).toContain('never planted here');
    expect(html).toContain('No prediction');
    expect(html).toContain('What changed in the soil');
    expect(html).not.toContain('How often each signal fired');
  });
  it('missing fixture ids show a clear message', () => {
    const html = renderToStaticMarkup(
      createElement(PlantPage, {
        result: {
          status: 'missing',
          title: 'This plant view is not in the demo fixture',
          message: 'Run `pnpm demo`.',
        },
        garden: null,
        onReload: () => undefined,
      }),
    );
    expect(html).toContain('not in the demo fixture');
    expect(html).toContain('<code>pnpm demo</code>');
  });
});
