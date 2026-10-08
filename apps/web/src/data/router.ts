/**
 * "Which one do I call?" loader. Live: GET /api/route on the local server. Fixture mode
 * (`?fixture=demo`): a few real RouterResults exported from the demo dataset, matched by query
 * text. Static exports have no router (it needs the local index).
 */
import type { ID, RouterResult } from '@garden/core';
import { dataMode, isStaticExport } from './views';
import { fixtureParam } from './load';

export const ROUTE_QUERY_MAX = 500;
/** Results shown and highlighted in the garden. */
export const ROUTE_LIMIT = 3;

export type RouteLoad =
  | { status: 'ok'; result: RouterResult; source: 'api' | 'fixture' }
  | { status: 'missing'; message: string; examples: string[] }
  | { status: 'error'; message: string };

export interface RouterFixture {
  results: RouterResult[];
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export function matchFixture(fx: RouterFixture, q: string): RouterResult | null {
  return fx.results.find((r) => norm(r.query) === norm(q)) ?? null;
}

/** Plants to glow and their badge text: a plant shared by several candidates shows the highest confidence. */
export function highlightFor(result: RouterResult | null): {
  plantIds: ID[];
  badges: Record<ID, string>;
} {
  const best = new Map<ID, number>();
  for (const c of result?.candidates ?? [])
    for (const id of c.plantIds) {
      const own = c.plantings?.find((p) => p.plantId === id)?.confidence ?? c.confidence;
      best.set(id, Math.max(best.get(id) ?? 0, own));
    }
  const badges: Record<ID, string> = {};
  for (const [id, conf] of best) badges[id] = formatConfidence(conf);
  return { plantIds: [...best.keys()], badges };
}

export function formatConfidence(c: number): string {
  if (c >= 0.995) return '>99%';
  if (c < 0.01) return '<1%';
  return `${Math.round(c * 100)}%`;
}

export async function loadRoute(
  q: string,
  days: number,
  search = window.location.search,
): Promise<RouteLoad> {
  const query = q.trim().slice(0, ROUTE_QUERY_MAX);
  const mode = dataMode(search, isStaticExport());
  if (mode === 'fixture') {
    const fx =
      fixtureParam(search) === 'demo'
        ? ((await import('../fixtures/router.demo.json')).default as unknown as RouterFixture)
        : { results: [] };
    const hit = matchFixture(fx, query);
    if (hit)
      return {
        status: 'ok',
        result: { ...hit, candidates: hit.candidates.slice(0, ROUTE_LIMIT) },
        source: 'fixture',
      };
    return {
      status: 'missing',
      message:
        'The demo fixture only has answers for a few questions. Run `pnpm demo` to ask anything against the local index.',
      examples: fx.results.map((r) => r.query),
    };
  }
  if (mode === 'static') {
    return {
      status: 'missing',
      message:
        'The router needs the local server (it builds an index from your runs). Run `garden serve`.',
      examples: [],
    };
  }
  try {
    const params = new URLSearchParams({
      q: query,
      days: String(days),
      limit: String(ROUTE_LIMIT),
    });
    const res = await fetch(`/api/route?${params.toString()}`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const body: unknown = await res.json();
        if (body && typeof body === 'object' && 'error' in body)
          msg = String((body as { error: unknown }).error);
      } catch {
        // not JSON
      }
      return { status: 'error', message: msg };
    }
    return { status: 'ok', result: (await res.json()) as RouterResult, source: 'api' };
  } catch (e) {
    return {
      status: 'error',
      message: `Could not reach the local server: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
