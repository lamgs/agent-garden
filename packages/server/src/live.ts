/**
 * Live API: GET /api/live (LiveSnapshot) and GET /api/live/stream (server-sent events). The stream
 * sends one `snapshot`, then `event` / `agent` / `gone` messages as they happen, and a comment
 * heartbeat every 15 s. A disconnect unsubscribes the client from the hub. Payloads are the hub's
 * messages verbatim: every string in them already passed the Redactor in the live layer.
 */
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { LiveMessage } from '@garden/core';
import type { LiveHub, Store } from '@garden/ingest';

export const LIVE_HEARTBEAT_MS = 15_000;

export interface LiveRouteOptions {
  heartbeatMs?: number;
}

export function registerLiveRoutes(app: Hono, hub: LiveHub | undefined, o: LiveRouteOptions = {}) {
  const off = { error: 'live layer is off (start with `garden serve`, without --no-live)' };
  app.get('/api/live', (c) => (hub ? c.json(hub.snapshot()) : c.json(off, 404)));
  app.get('/api/live/stream', (c) => {
    if (!hub) return c.json(off, 404);
    return streamSSE(c, async (stream) => {
      let queue: Promise<unknown> = Promise.resolve();
      const send = (msg: LiveMessage): void => {
        const id = msg.type === 'event' ? String(msg.event.seq) : undefined;
        queue = queue
          .then(() =>
            stream.writeSSE({ event: msg.type, data: JSON.stringify(msg), ...(id ? { id } : {}) }),
          )
          .catch(() => undefined);
      };
      // Snapshot and subscribe in the same tick, so no message falls between them.
      send({ type: 'snapshot', snapshot: hub.snapshot() });
      const unsubscribe = hub.subscribe(send);
      const heartbeat = setInterval(() => {
        queue = queue.then(() => stream.write(': heartbeat\n\n')).catch(() => undefined);
      }, o.heartbeatMs ?? LIVE_HEARTBEAT_MS);
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          clearInterval(heartbeat);
          unsubscribe();
          resolve();
        });
      });
    });
  });
}

/** `plantExists` for the tailer: plantings in the history store, refreshed at most once a minute. */
export function storePlantLookup(
  store: Store,
  plantIdOf: (agentId: string, familyId: string) => string,
  refreshMs = 60_000,
): (plantId: string) => boolean {
  let ids = new Set<string>();
  let loadedAt = -Infinity;
  return (id) => {
    if (Date.now() - loadedAt > refreshMs) {
      ids = new Set(
        store.db
          .prepare('SELECT DISTINCT agent_id, family_id FROM runs')
          .all()
          .map((r) => plantIdOf(String(r.agent_id), String(r.family_id))),
      );
      loadedAt = Date.now();
    }
    return ids.has(id);
  };
}
