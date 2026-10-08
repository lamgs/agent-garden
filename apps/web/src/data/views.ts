/**
 * Loaders for the M4 views (plant, compare, replant) and the manual-label write.
 * Live: the local API on 127.0.0.1. Fixture mode (`?fixture=demo`): the bundled demo responses,
 * which exist for exactly one plant / bed pair / replant; any other id is reported as "not in the
 * demo fixture". Static exports carry only the garden, so these views need the local server.
 */
import type {
  BedCompareView,
  ID,
  LabelRequest,
  OutcomeLabel,
  PlantView,
  ReplantView,
} from '@garden/core';
import type { Route } from '../route';
import { fixtureParam, type DataSource } from './load';

export type ViewRoute = Extract<Route, { view: 'plant' | 'compare' | 'replant' }>;
export type ViewData<R extends ViewRoute> = R extends { view: 'plant' }
  ? PlantView
  : R extends { view: 'compare' }
    ? BedCompareView
    : ReplantView;

export type ViewResult<T> =
  | { status: 'ok'; data: T; source: DataSource }
  | { status: 'missing'; title: string; message: string }
  | { status: 'error'; message: string };

export function dataMode(search: string, isStaticExport: boolean): DataSource {
  if (fixtureParam(search)) return 'fixture';
  return isStaticExport ? 'static' : 'api';
}

export function isStaticExport(): boolean {
  return document.querySelector('meta[name="agent-garden-source"][content="static"]') !== null;
}

/** Labels are written by the local server only; fixtures and static exports are read-only. */
export function labelingDisabledReason(source: DataSource): string | null {
  return source === 'api'
    ? null
    : 'Labels are saved by the local server; run `pnpm demo` or `garden serve`.';
}

export interface DemoFixtures {
  plant: PlantView;
  compare: BedCompareView;
  replant: ReplantView;
}

/** Which bundled demo fixture answers a route, or null when the ids are not the fixture's. */
export function resolveFixture(
  route: ViewRoute,
  fx: DemoFixtures,
): PlantView | BedCompareView | ReplantView | null {
  switch (route.view) {
    case 'plant':
      return fx.plant.plant.id === route.plantId ? fx.plant : null;
    case 'compare':
      return fx.compare.left.bed.id === route.left && fx.compare.right.bed.id === route.right
        ? fx.compare
        : null;
    case 'replant':
      return fx.replant.agent.id === route.agent &&
        fx.replant.from.bed.id === route.from &&
        fx.replant.to.bed.id === route.to
        ? fx.replant
        : null;
  }
}

export function apiUrl(route: ViewRoute, days: number): string {
  switch (route.view) {
    case 'plant':
      return `/api/plant/${encodeURIComponent(route.plantId)}?days=${days}`;
    case 'compare':
      return `/api/compare?${new URLSearchParams({ left: route.left, right: route.right, days: String(days) }).toString()}`;
    case 'replant':
      return `/api/replant?${new URLSearchParams({ agent: route.agent, from: route.from, to: route.to, days: String(days) }).toString()}`;
  }
}

const VIEW_NOUN: Record<ViewRoute['view'], string> = {
  plant: 'plant view',
  compare: 'bed comparison',
  replant: 'replant view',
};

async function loadDemoFixtures(): Promise<DemoFixtures> {
  const [plant, compare, replant] = await Promise.all([
    import('../fixtures/plant.demo.json'),
    import('../fixtures/compare.demo.json'),
    import('../fixtures/replant.demo.json'),
  ]);
  return {
    plant: plant.default as unknown as PlantView,
    compare: compare.default as unknown as BedCompareView,
    replant: replant.default as unknown as ReplantView,
  };
}

async function errorText(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object' && 'error' in body) {
      return String((body as { error: unknown }).error);
    }
  } catch {
    // not JSON
  }
  return `HTTP ${res.status}`;
}

export async function loadView<R extends ViewRoute>(
  route: R,
  days: number,
  search = window.location.search,
): Promise<ViewResult<ViewData<R>>> {
  const mode = dataMode(search, isStaticExport());
  if (mode === 'fixture') {
    const which = fixtureParam(search);
    const hit = which === 'demo' ? resolveFixture(route, await loadDemoFixtures()) : null;
    if (!hit) {
      return {
        status: 'missing',
        title: `This ${VIEW_NOUN[route.view]} is not in the demo fixture`,
        message:
          which === 'demo'
            ? 'The bundled demo fixture has one plant (test-writer in legacy-monolith), one bed pair (shop-api vs legacy-monolith), and one replant (test-writer, shop-api → legacy-monolith). Run `pnpm demo` to explore every plant against the local server.'
            : `The “${which ?? ''}” fixture only contains a garden. Run \`pnpm demo\` to open this view against the local server.`,
      };
    }
    return { status: 'ok', data: hit as ViewData<R>, source: 'fixture' };
  }
  if (mode === 'static') {
    return {
      status: 'missing',
      title: `This static export has no ${VIEW_NOUN[route.view]}`,
      message:
        'Static exports carry only the garden. Run `garden serve` (or `pnpm demo`) to open plant, compare, and replant views.',
    };
  }
  try {
    const res = await fetch(apiUrl(route, days), { headers: { accept: 'application/json' } });
    if (res.status === 404) {
      return {
        status: 'missing',
        title: `Nothing to show for this ${VIEW_NOUN[route.view]}`,
        message: `${await errorText(res)} (window: ${days} days). Try a longer window or go back to the garden.`,
      };
    }
    if (!res.ok) return { status: 'error', message: await errorText(res) };
    return { status: 'ok', data: (await res.json()) as ViewData<R>, source: 'api' };
  } catch (e) {
    return {
      status: 'error',
      message: `Could not reach the local server: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export interface LabelResponse {
  runId: ID;
  outcome: { label: OutcomeLabel; source: string } | null;
}

/** POST a manual label. JSON content type is required: the server refuses anything else. */
export async function postLabel(runId: ID, body: LabelRequest): Promise<LabelResponse> {
  const payload: LabelRequest = { label: body.label };
  const note = body.note?.trim();
  if (note && body.label !== 'clear') payload.note = note;
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/label`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Label not saved: ${await errorText(res)}`);
  return (await res.json()) as LabelResponse;
}
