/**
 * Hash routes (no router dependency). The hash carries the view; the query string before it
 * keeps carrying the data source (`?fixture=demo`), so fixture mode survives navigation.
 *
 *   #/                                  garden
 *   #/plant/:plantId                    plant view
 *   #/compare?left=<bedId>&right=<bedId> bed compare
 *   #/replant?agent=&from=&to=          replant
 *   #/replay/:runId                     time-lapse replay of one run
 *   #/replay?plant=<plantId>            replay of a plant's latest run
 *   #/knowledge/:bedId                  knowledge map of a bed (K)
 */
import type { ID } from '@garden/core';

export type Route =
  | { view: 'garden' }
  | { view: 'plant'; plantId: ID }
  | { view: 'compare'; left: ID; right: ID }
  | { view: 'replant'; agent: ID; from: ID; to: ID }
  | { view: 'replay'; runId: ID | null; plantId: ID | null }
  | { view: 'knowledge'; bedId: ID }
  | { view: 'unknown'; hash: string };

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  if (raw === '' || raw === '/') return { view: 'garden' };
  const [path = '', query = ''] = raw.split('?', 2);
  const q = new URLSearchParams(query);
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'plant' && parts.length === 2 && parts[1]) {
    return { view: 'plant', plantId: decodeURIComponent(parts[1]) };
  }
  if (parts[0] === 'compare' && parts.length === 1) {
    const left = q.get('left');
    const right = q.get('right');
    if (left && right) return { view: 'compare', left, right };
  }
  if (parts[0] === 'replant' && parts.length === 1) {
    const agent = q.get('agent');
    const from = q.get('from');
    const to = q.get('to');
    if (agent && from && to) return { view: 'replant', agent, from, to };
  }
  if (parts[0] === 'replay' && parts.length === 2 && parts[1]) {
    return { view: 'replay', runId: decodeURIComponent(parts[1]), plantId: null };
  }
  if (parts[0] === 'replay' && parts.length === 1 && q.get('plant')) {
    return { view: 'replay', runId: null, plantId: q.get('plant') };
  }
  // Knowledge map (K)
  if (parts[0] === 'knowledge' && parts.length === 2 && parts[1]) {
    return { view: 'knowledge', bedId: decodeURIComponent(parts[1]) };
  }
  return { view: 'unknown', hash: raw };
}

export function formatRoute(r: Route): string {
  switch (r.view) {
    case 'garden':
      return '#/';
    case 'plant':
      return `#/plant/${encodeURIComponent(r.plantId)}`;
    case 'compare':
      return `#/compare?${new URLSearchParams({ left: r.left, right: r.right }).toString()}`;
    case 'replant':
      return `#/replant?${new URLSearchParams({ agent: r.agent, from: r.from, to: r.to }).toString()}`;
    case 'replay':
      return r.runId
        ? `#/replay/${encodeURIComponent(r.runId)}`
        : `#/replay?${new URLSearchParams({ plant: r.plantId ?? '' }).toString()}`;
    case 'knowledge':
      return `#/knowledge/${encodeURIComponent(r.bedId)}`;
    case 'unknown':
      return `#${r.hash}`;
  }
}

export const plantHref = (plantId: ID) => formatRoute({ view: 'plant', plantId });
export const compareHref = (left: ID, right: ID) => formatRoute({ view: 'compare', left, right });
export const replantHref = (agent: ID, from: ID, to: ID) =>
  formatRoute({ view: 'replant', agent, from, to });
export const replayHref = (runId: ID) => formatRoute({ view: 'replay', runId, plantId: null });
export const latestReplayHref = (plantId: ID) =>
  formatRoute({ view: 'replay', runId: null, plantId });

export const knowledgeHref = (bedId: ID) => formatRoute({ view: 'knowledge', bedId });

/** Navigate by setting the hash: the browser records history, so back/forward just work. */
export function navigate(r: Route | string): void {
  const h = typeof r === 'string' ? r : formatRoute(r);
  if (window.location.hash !== h) window.location.hash = h;
}
