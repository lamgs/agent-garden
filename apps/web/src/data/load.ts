/**
 * Where the garden comes from: the local API (live), a static export (`garden export`), or a
 * bundled fixture (`?fixture=demo`, `?fixture=synthetic500`). Nothing is fetched from elsewhere.
 */
import type { GardenView } from '@garden/core';

export type DataSource = 'api' | 'static' | 'fixture';

export interface Loaded {
  view: GardenView;
  source: DataSource;
  detail: string;
}

export const SOURCE_LABEL: Record<DataSource, string> = {
  api: 'live API',
  static: 'static export',
  fixture: 'fixture',
};

function isGardenView(x: unknown): x is GardenView {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return Array.isArray(o.beds) && Array.isArray(o.plants) && Array.isArray(o.loops);
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function attempt(url: string): Promise<GardenView | Error> {
  try {
    const v = await fetchJson(url);
    return isGardenView(v) ? v : new Error(`unexpected shape from ${url}`);
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

export function fixtureParam(search: string): string | null {
  return new URLSearchParams(search).get('fixture');
}

/** Why a garden "as of" a past date can't be shown from fixtures or a static export. */
export const AS_OF_UNAVAILABLE =
  'A garden as of a past date is computed by the local server from the stored runs. Fixtures and static exports only hold the current window. Run `pnpm demo` or `garden serve`.';

export async function loadGarden(
  days: number,
  search = window.location.search,
  asOf?: string,
): Promise<Loaded> {
  const fixture = fixtureParam(search);
  if (asOf !== undefined) {
    const isStaticExport =
      document.querySelector('meta[name="agent-garden-source"][content="static"]') !== null;
    if (fixture || isStaticExport) throw new Error(AS_OF_UNAVAILABLE);
    // No fallback to "now" data: showing the current garden under an "as of" banner would lie.
    const v = await attempt(
      `/api/garden?${new URLSearchParams({ days: String(days), asOf }).toString()}`,
    );
    if (v instanceof Error) throw new Error(`Garden as of ${asOf.slice(0, 10)}: ${v.message}`);
    return { view: v, source: 'api', detail: `${days} days as of ${asOf.slice(0, 10)}` };
  }
  if (fixture === 'demo') {
    const mod = await import('../fixtures/garden.demo.json');
    return { view: mod.default as GardenView, source: 'fixture', detail: 'demo fixture' };
  }
  if (fixture === 'synthetic500') {
    const { syntheticGarden } = await import('../fixtures/synthetic');
    return {
      view: syntheticGarden({ plants: 500 }),
      source: 'fixture',
      detail: 'synthetic, 500 plants',
    };
  }
  // `garden export` marks its index.html, so a static host never probes a non-existent /api.
  const isStatic =
    document.querySelector('meta[name="agent-garden-source"][content="static"]') !== null;
  const live = isStatic
    ? new Error('static export (no API)')
    : await attempt(`/api/garden?days=${days}`);
  if (live instanceof Error === false) return { view: live, source: 'api', detail: `${days} days` };
  const exported = await attempt('./data/garden.json');
  if (exported instanceof Error === false)
    return { view: exported, source: 'static', detail: 'data/garden.json' };
  throw new Error(
    `No garden data. Live API: ${live.message}. Static export: ${exported.message}. ` +
      'Run `pnpm demo`, or open with ?fixture=demo.',
    { cause: exported },
  );
}
