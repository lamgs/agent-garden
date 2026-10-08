import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { legend, type GardenView, type SeasonsView } from '@garden/core';
import { apiUrl, resolveFixture, type DemoFixtures } from './data/views';
import gardenJson from './fixtures/garden.demo.json';
import seasonsJson from './fixtures/seasons.demo.json';
import { formatRoute, gardenAsOfHref, parseRoute, seasonsHref } from './route';
import {
  dayCount,
  dayOf,
  dayToAsOf,
  defaultScrubDay,
  layoutLabels,
  primaryChain,
  rowSpans,
  seasonIndexAt,
  seriesLabel,
  spanAt,
} from './seasons-format';
import { SeasonsPage } from './views/SeasonsPage';

const garden = gardenJson as unknown as GardenView;
const all = seasonsJson as unknown as Record<string, SeasonsView>;
const shop = Object.values(all).find((v) => v.bed.name === 'shop-api')!;
const web = Object.values(all).find((v) => v.bed.name === 'web-dashboard')!;

describe('seasons routes', () => {
  it('parses and formats the seasons route and the as-of garden', () => {
    expect(parseRoute(seasonsHref('fam_a/b'))).toEqual({ view: 'seasons', bedId: 'fam_a/b' });
    const asOf = '2026-08-10T23:59:59.999Z';
    expect(parseRoute(gardenAsOfHref(asOf))).toEqual({ view: 'garden', asOf });
    expect(formatRoute({ view: 'garden' })).toBe('#/');
    expect(parseRoute('#/?asOf=yesterday')).toEqual({ view: 'unknown', hash: '/?asOf=yesterday' });
    expect(parseRoute('#/seasons/')).toEqual({ view: 'unknown', hash: '/seasons/' });
    expect(apiUrl({ view: 'seasons', bedId: 'fam x' }, 90)).toBe('/api/seasons/fam%20x?days=90');
  });
  it('the fixture answers every demo bed, and nothing else', () => {
    const fx = { seasons: all } as unknown as DemoFixtures;
    for (const b of garden.beds)
      expect(resolveFixture({ view: 'seasons', bedId: b.id }, fx)).toBe(all[b.id]);
    expect(resolveFixture({ view: 'seasons', bedId: 'fam_nope' }, fx)).toBeNull();
  });
});

describe('seasons layout', () => {
  it('rows span the window, seasons in order, boundaries at season starts', () => {
    const main = shop.series[0]!;
    expect(seriesLabel(main)).toBe('main');
    const spans = rowSpans(shop, main);
    expect(spans.map((s) => s.season.title)).toEqual([
      'Initial commit',
      'Tighten CLAUDE.md and add test hook',
    ]);
    expect(spans[0]!.t0).toBe(Date.parse(spans[0]!.season.from)); // first use, after the window start
    expect(spans[0]!.t1).toBe(Date.parse(spans[1]!.season.from));
    expect(spans[1]!.t1).toBe(Date.parse(shop.window.to));
    expect(spanAt(spans, Date.parse('2026-08-10T12:00:00Z'))).toBe(spans[0]);
    expect(spanAt(spans, Date.parse('2026-09-10T12:00:00Z'))).toBe(spans[1]);
  });
  it('the scrubber defaults to the day before the latest boundary and maps days to as-of times', () => {
    const d = defaultScrubDay(shop);
    expect(dayToAsOf(shop, d)).toBe('2026-08-16T23:59:59.999Z');
    expect(dayOf(shop, dayToAsOf(shop, d))).toBe(d);
    expect(dayToAsOf(shop, dayCount(shop) - 1)).toBe(shop.window.to);
    expect(seasonIndexAt(shop, '2026-08-16T23:59:59.999Z')).toBe(0);
    expect(seasonIndexAt(shop, '2026-09-01T00:00:00Z')).toBe(1);
    expect(primaryChain(web).map((s) => s.title)).toEqual([
      'Initial commit',
      'Add api-docs skill',
      'Switch default model to sonnet',
      'Model: opus 5.5 → sonnet 5.5',
    ]);
  });
  it('labels never overlap and stay inside the plot', () => {
    const left = layoutLabels([0, 10, 20, 800], [100, 100, 100, 100], 860);
    expect(left).toEqual([0, 106, 212, 760]);
    const crowded = layoutLabels([700, 760, 800], [100, 100, 100], 860);
    expect(crowded[2]! + 100).toBeLessThanOrEqual(860);
    for (let i = 1; i < crowded.length; i++)
      expect(crowded[i]!).toBeGreaterThanOrEqual(crowded[i - 1]! + 106);
  });
});

describe('seasons page (server-side render)', () => {
  const html = (source: 'api' | 'fixture') =>
    renderToStaticMarkup(
      createElement(SeasonsPage, { result: { status: 'ok', data: shop, source }, garden }),
    );
  it('shows the story: before/after rates, the delta, separation, the soil diff, and the caveat', () => {
    const h = html('fixture');
    expect(h).toContain('Tighten CLAUDE.md and add test hook');
    expect(h).toContain('51%');
    expect(h).toContain('87%');
    expect(h).toContain('+36 points');
    expect(h).toContain('separated');
    expect(h).toContain('within noise');
    expect(h).toContain('Hooks changed');
    expect(h).toContain('Correlation, not causation');
    expect(h).toContain('loop · nightly-flaky-triage');
    expect(h).toContain('How these numbers are computed');
  });
  it('the as-of action needs the local server', () => {
    expect(html('fixture')).toMatch(/<button[^>]*disabled[^>]*>View garden as of 2026-08-16/);
    expect(html('fixture')).toContain('computed by the local server');
    expect(html('api')).not.toMatch(/<button[^>]*disabled[^>]*>View garden as of/);
  });
  it('the season encodings are in the legend', () => {
    const ids = legend().map((e) => e.id);
    expect(ids).toContain('season.band');
    expect(ids).toContain('season.rate');
  });
});
