/**
 * Hash routes (no router dependency). The hash carries the view; the query string before it
 * keeps carrying the data source (`?fixture=demo`), so fixture mode survives navigation.
 *
 *   #/                                  garden
 *   #/plant/:plantId                    plant view
 *   #/compare?left=<bedId>&right=<bedId> bed compare
 *   #/replant?agent=&from=&to=          replant
 */
import type { ID } from '@garden/core';

export type Route =
  | { view: 'garden' }
  | { view: 'plant'; plantId: ID }
  | { view: 'compare'; left: ID; right: ID }
  | { view: 'replant'; agent: ID; from: ID; to: ID }
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
    case 'unknown':
      return `#${r.hash}`;
  }
}

export const plantHref = (plantId: ID) => formatRoute({ view: 'plant', plantId });
export const compareHref = (left: ID, right: ID) => formatRoute({ view: 'compare', left, right });
export const replantHref = (agent: ID, from: ID, to: ID) =>
  formatRoute({ view: 'replant', agent, from, to });

/** Navigate by setting the hash: the browser records history, so back/forward just work. */
export function navigate(r: Route | string): void {
  const h = typeof r === 'string' ? r : formatRoute(r);
  if (window.location.hash !== h) window.location.hash = h;
}
