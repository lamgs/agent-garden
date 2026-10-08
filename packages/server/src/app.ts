import { existsSync } from 'node:fs';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { z } from 'zod';
import { OUTCOME_LABELS, legend, type GardenView, type ModelPrice } from '@garden/core';
import type { Redactor, Store } from '@garden/ingest';
import { loadGardenData, type GardenData } from './data';
import { buildGardenView } from './garden';
import { buildCompareView, buildPlantView, buildReplantView, loadStepAggregates } from './plant';
import { route as routeQuery } from '@garden/router';
import { buildWindowIndex, RouterCache } from './route';

export interface AppOptions {
  store: Store;
  pricing?: Record<string, ModelPrice>;
  /** Fixed "now" (e.g. the demo dataset's end), else the real clock. */
  asOf?: string;
  /** Built web app (apps/web/dist). Omitted in API-only tests. */
  webDist?: string;
  /** Redacts free-text label notes before they reach the store. Required to accept notes. */
  redactor?: Redactor;
}

/** Hostnames the server answers to. Anything else (e.g. a DNS-rebinding domain) is refused. */
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function hostnameOf(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  return hostHeader.startsWith('[')
    ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
    : hostHeader.split(':')[0];
}

const LabelBody = z.object({
  label: z.enum([...OUTCOME_LABELS, 'clear']),
  note: z.string().max(2000).optional(),
});

/** GET /api/route query: the task text is capped so a request can't make the router do unbounded work. */
export const ROUTE_QUERY_MAX = 500;
const RouteQuery = z.object({
  q: z.string().trim().min(1).max(ROUTE_QUERY_MAX),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});

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

export function windowData(
  opts: AppOptions,
  days = DEFAULT_WINDOW_DAYS,
  asOf = opts.asOf,
): { data: GardenData; garden: GardenView } {
  const w = windowFor(days, asOf);
  const data = loadGardenData(opts.store, w.from, w.to);
  return {
    data,
    garden: buildGardenView(data, { ...w, ...(opts.pricing ? { pricing: opts.pricing } : {}) }),
  };
}

export function gardenView(
  opts: AppOptions,
  days = DEFAULT_WINDOW_DAYS,
  asOf = opts.asOf,
): GardenView {
  return windowData(opts, days, asOf).garden;
}

export function createApp(opts: AppOptions): Hono {
  const app = new Hono();
  const routers = new RouterCache();
  app.use('*', async (c, next) => {
    await next();
    c.header('Content-Security-Policy', CSP);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
  });

  // DNS-rebinding guard: only answer requests addressed to a loopback host.
  app.use('*', async (c, next) => {
    const host = hostnameOf(c.req.header('host') ?? new URL(c.req.url).host);
    if (!host || !LOOPBACK_HOSTS.has(host)) return c.json({ error: 'forbidden host' }, 403);
    await next();
  });
  // CSRF guard for writes: same-origin JSON only (a cross-site form or no-cors fetch can't do both).
  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin');
      let originHost: string | undefined;
      try {
        originHost = origin ? hostnameOf(new URL(origin).host) : undefined;
      } catch {
        originHost = undefined;
      }
      if (!originHost || !LOOPBACK_HOSTS.has(originHost))
        return c.json({ error: 'cross-origin write refused' }, 403);
      if (!(c.req.header('content-type') ?? '').startsWith('application/json'))
        return c.json({ error: 'expected application/json' }, 415);
    }
    await next();
  });

  const params = (c: { req: { query: (k: string) => string | undefined } }) => {
    const days = Number(c.req.query('days') ?? DEFAULT_WINDOW_DAYS);
    const asOf = c.req.query('asOf');
    if (!Number.isFinite(days) || days < 1 || days > 3650)
      return { error: 'days must be 1..3650' } as const;
    if (asOf !== undefined && Number.isNaN(Date.parse(asOf)))
      return { error: 'asOf must be an ISO date' } as const;
    return { days, asOf: asOf ?? opts.asOf } as const;
  };

  app.get('/api/plant/:id', (c) => {
    const p = params(c);
    if ('error' in p) return c.json({ error: p.error }, 400);
    const { data, garden } = windowData(opts, p.days, p.asOf);
    const plant = garden.plants.find((x) => x.id === c.req.param('id'));
    if (!plant) return c.json({ error: 'no such plant in this window' }, 404);
    const runIds = data.runs
      .filter((r) => r.agentId === plant.agentId && r.familyId === plant.bedId)
      .map((r) => r.id);
    return c.json(
      buildPlantView(data, garden, plant.id, loadStepAggregates(opts.store, runIds), opts.pricing),
    );
  });
  app.get('/api/compare', (c) => {
    const p = params(c);
    if ('error' in p) return c.json({ error: p.error }, 400);
    const { data, garden } = windowData(opts, p.days, p.asOf);
    const v = buildCompareView(data, garden, c.req.query('left') ?? '', c.req.query('right') ?? '');
    return v ? c.json(v) : c.json({ error: 'unknown bed' }, 404);
  });
  app.get('/api/replant', (c) => {
    const p = params(c);
    if ('error' in p) return c.json({ error: p.error }, 400);
    const { data, garden } = windowData(opts, p.days, p.asOf);
    const v = buildReplantView(
      data,
      garden,
      c.req.query('agent') ?? '',
      c.req.query('from') ?? '',
      c.req.query('to') ?? '',
      opts.pricing,
    );
    return v ? c.json(v) : c.json({ error: 'unknown agent or bed' }, 404);
  });
  app.post('/api/runs/:id/label', async (c) => {
    const runId = c.req.param('id');
    let body: z.infer<typeof LabelBody>;
    try {
      body = LabelBody.parse(await c.req.json());
    } catch {
      return c.json(
        { error: 'body must be {label: success|partial|failure|unknown|clear, note?: string}' },
        400,
      );
    }
    if (!opts.store.getRun(runId)) return c.json({ error: 'no such run' }, 404);
    if (body.label === 'clear') opts.store.clearManualLabel(runId);
    else {
      if (body.note && !opts.redactor)
        return c.json({ error: 'notes need a redactor (server misconfigured)' }, 501);
      const note = body.note && opts.redactor ? opts.redactor.text(body.note, 2000) : undefined;
      opts.store.putManualLabel(runId, body.label, note, new Date().toISOString());
    }
    routers.clear(); // outcomes changed: the router's outcome kNN must see the new label
    return c.json({ runId, outcome: opts.store.getOutcome(runId) ?? null });
  });
  app.get('/api/route', (c) => {
    const p = params(c);
    if ('error' in p) return c.json({ error: p.error }, 400);
    const parsed = RouteQuery.safeParse({ q: c.req.query('q'), limit: c.req.query('limit') });
    if (!parsed.success)
      return c.json({ error: `q must be 1..${ROUTE_QUERY_MAX} characters; limit 1..20` }, 400);
    const index = routers.get(`${p.days}|${p.asOf ?? ''}`, () => {
      const { data, garden } = windowData(opts, p.days, p.asOf);
      return buildWindowIndex(data, garden);
    });
    return c.json(routeQuery(index, parsed.data.q, { limit: parsed.data.limit ?? 5 }));
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
