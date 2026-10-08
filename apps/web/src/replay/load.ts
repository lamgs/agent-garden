/**
 * Loads a ReplayView. Live: GET /api/replay/:runId on the local server. Fixture mode
 * (`?fixture=demo`): the bundled demo replays (a few runs; anything else is "not in the fixture").
 * "Latest run of a plant" resolves through the plant view's runs table (most recent first).
 */
import type { ID, PlantView, ReplayView } from '@garden/core';
import { fixtureParam } from '../data/load';
import { dataMode, isStaticExport, type ViewResult } from '../data/views';

export interface ReplayFixture {
  /** How the fixture was made (shown nowhere; for humans reading the JSON). */
  generatedBy: string;
  runs: Record<ID, ReplayView>;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (body.error) return String(body.error);
  } catch {
    // not JSON
  }
  return `HTTP ${res.status}`;
}

export async function loadReplayFixture(): Promise<ReplayFixture> {
  return (await import('../fixtures/replay.demo.json')).default as unknown as ReplayFixture;
}

const MISSING_FIXTURE =
  'The bundled demo fixture has replays for a legacy-monolith main run (with two test-writer subagents and a compaction) and the latest test-writer run. Run `pnpm demo` to replay any run against the local server.';

export async function loadReplay(
  runId: ID,
  search = window.location.search,
): Promise<ViewResult<ReplayView>> {
  const mode = dataMode(search, isStaticExport());
  if (mode === 'fixture') {
    const fx = fixtureParam(search) === 'demo' ? await loadReplayFixture() : null;
    const v = fx?.runs[runId];
    return v
      ? { status: 'ok', data: v, source: 'fixture' }
      : {
          status: 'missing',
          title: 'This run is not in the demo fixture',
          message: MISSING_FIXTURE,
        };
  }
  if (mode === 'static') {
    return {
      status: 'missing',
      title: 'This static export has no replays',
      message:
        'Static exports carry only the garden. Run `garden serve` (or `pnpm demo`) to replay runs.',
    };
  }
  try {
    const res = await fetch(`/api/replay/${encodeURIComponent(runId)}`, {
      headers: { accept: 'application/json' },
    });
    if (res.status === 404)
      return { status: 'missing', title: 'No such run', message: await readError(res) };
    if (!res.ok) return { status: 'error', message: await readError(res) };
    return { status: 'ok', data: (await res.json()) as ReplayView, source: 'api' };
  } catch (e) {
    return {
      status: 'error',
      message: `Could not reach the local server: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** The most recent run of a plant, via the plant view (fixture or API). */
export async function latestRunOf(
  plantId: ID,
  days: number,
  search = window.location.search,
): Promise<ViewResult<ID>> {
  const mode = dataMode(search, isStaticExport());
  let plant: PlantView | null;
  if (mode === 'fixture') {
    const p = (await import('../fixtures/plant.demo.json')).default as unknown as PlantView;
    plant = fixtureParam(search) === 'demo' && p.plant.id === plantId ? p : null;
    if (!plant)
      return {
        status: 'missing',
        title: 'This plant is not in the demo fixture',
        message: MISSING_FIXTURE,
      };
  } else if (mode === 'static') {
    return {
      status: 'missing',
      title: 'This static export has no replays',
      message: 'Run `garden serve` (or `pnpm demo`) to replay runs.',
    };
  } else {
    try {
      const res = await fetch(`/api/plant/${encodeURIComponent(plantId)}?days=${days}`);
      if (!res.ok)
        return {
          status: 'missing',
          title: 'No runs for this plant',
          message: await readError(res),
        };
      plant = (await res.json()) as PlantView;
    } catch (e) {
      return { status: 'error', message: e instanceof Error ? e.message : String(e) };
    }
  }
  const run = plant.runs[0];
  return run
    ? { status: 'ok', data: run.runId, source: mode }
    : { status: 'missing', title: 'No runs in this window', message: 'Try a longer window.' };
}
