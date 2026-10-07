import { existsSync } from 'node:fs';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { legend, type GardenView, type ModelPrice } from '@garden/core';
import type { Store } from '@garden/ingest';
import { loadGardenData } from './data';
import { buildGardenView } from './garden';

export interface AppOptions {
  store: Store;
  pricing?: Record<string, ModelPrice>;
  /** Fixed "now" (e.g. the demo dataset's end), else the real clock. */
  asOf?: string;
  /** Built web app (apps/web/dist). Omitted in API-only tests. */
  webDist?: string;
}

const DAY = 86_400_000;
export const DEFAULT_WINDOW_DAYS = 90;

/** Content-Security-Policy: nothing may load from or connect to anywhere but this origin. */
export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

export function windowFor(days: number, asOf?: string): { from: string; to: string } {
  const to = asOf ? new Date(asOf) : new Date();
  return { from: new Date(to.getTime() - days * DAY).toISOString(), to: to.toISOString() };
}

export function gardenView(
  opts: AppOptions,
  days = DEFAULT_WINDOW_DAYS,
  asOf = opts.asOf,
): GardenView {
  const w = windowFor(days, asOf);
  return buildGardenView(loadGardenData(opts.store, w.from, w.to), {
    ...w,
    ...(opts.pricing ? { pricing: opts.pricing } : {}),
  });
}

export function createApp(opts: AppOptions): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    await next();
    c.header('Content-Security-Policy', CSP);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
  });

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      schemaVersion: opts.store.schemaVersion(),
      runs: opts.store.count('runs'),
      asOf: opts.asOf ?? null,
    }),
  );
  app.get('/api/legend', (c) => c.json(legend()));
  app.get('/api/garden', (c) => {
    const days = Number(c.req.query('days') ?? DEFAULT_WINDOW_DAYS);
    if (!Number.isFinite(days) || days < 1 || days > 3650)
      return c.json({ error: 'days must be 1..3650' }, 400);
    const asOf = c.req.query('asOf');
    if (asOf !== undefined && Number.isNaN(Date.parse(asOf)))
      return c.json({ error: 'asOf must be an ISO date' }, 400);
    return c.json(gardenView(opts, days, asOf ?? opts.asOf));
  });
  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

  if (opts.webDist && existsSync(opts.webDist)) {
    app.use('/*', serveStatic({ root: opts.webDist }));
    app.get('*', serveStatic({ root: opts.webDist, path: 'index.html' })); // SPA fallback
  }
  return app;
}
