/**
 * Loader for the knowledge map (K): GET /api/knowledge/:bedId on the local server, or the bundled
 * demo fixture (`?fixture=demo`, legacy-monolith only). Static exports carry only the garden.
 */
import type { ID, KnowledgeView } from '@garden/core';
import { fixtureParam } from './load';
import { dataMode, isStaticExport, type ViewResult } from './views';

export const knowledgeApiUrl = (bedId: ID, days: number) =>
  `/api/knowledge/${encodeURIComponent(bedId)}?days=${days}`;

export async function loadKnowledge(
  bedId: ID,
  days: number,
  search = window.location.search,
): Promise<ViewResult<KnowledgeView>> {
  const mode = dataMode(search, isStaticExport());
  if (mode === 'fixture') {
    const fx = (await import('../fixtures/knowledge.demo.json'))
      .default as unknown as KnowledgeView;
    if (fixtureParam(search) === 'demo' && fx.bed.id === bedId)
      return { status: 'ok', data: fx, source: 'fixture' };
    return {
      status: 'missing',
      title: 'This knowledge map is not in the demo fixture',
      message: `The bundled fixture has the knowledge map of ${fx.bed.name} only. Run \`pnpm demo\` to open every bed against the local server.`,
    };
  }
  if (mode === 'static')
    return {
      status: 'missing',
      title: 'This static export has no knowledge map',
      message: 'Static exports carry only the garden. Run `garden serve` (or `pnpm demo`).',
    };
  try {
    const res = await fetch(knowledgeApiUrl(bedId, days), {
      headers: { accept: 'application/json' },
    });
    if (res.status === 404)
      return {
        status: 'missing',
        title: 'No such bed',
        message: 'This bed is not in the store. Go back to the garden and pick a bed.',
      };
    if (!res.ok) return { status: 'error', message: `HTTP ${res.status}` };
    return { status: 'ok', data: (await res.json()) as KnowledgeView, source: 'api' };
  } catch (e) {
    return {
      status: 'error',
      message: `Could not reach the local server: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
