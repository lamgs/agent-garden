import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter, deriveAll, ingest, Redactor, Store } from '@garden/ingest';
import { CSP, createApp } from './app';
import { exportStatic } from './export';
import { HOST, startServer } from './serve';

const dir = mkdtempSync(join(tmpdir(), 'garden-server-'));
let store: Store;
beforeAll(async () => {
  const home = join(dir, 'claude');
  cpSync(new URL('../../../fixtures/claude-code', import.meta.url), home, { recursive: true });
  store = new Store(join(dir, 'garden.db'));
  const a = new ClaudeCodeAdapter({ claudeHome: home, claudeJsonPath: join(dir, 'none.json') });
  await ingest(a, store, new Redactor(Buffer.alloc(32, 4)));
  deriveAll(store, a.garden);
});
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('API', () => {
  const app = () => createApp({ store, asOf: '2026-12-31T00:00:00Z' });
  it('health reports schema and counts', async () => {
    const r = await app().request('/api/health');
    expect(await r.json()).toMatchObject({ ok: true, schemaVersion: 2, live: false });
  });
  it('garden returns a GardenView for the window', async () => {
    const r = await app().request('/api/garden?days=3650');
    const v = (await r.json()) as { plants: { success: { method: string } }[]; beds: unknown[] };
    expect(r.status).toBe(200);
    expect(v.plants.length).toBeGreaterThan(0);
    expect(v.beds.length).toBeGreaterThan(0);
    for (const p of v.plants) expect(p.success.method).toBeTruthy();
  });
  it('validates query params', async () => {
    expect((await app().request('/api/garden?days=0')).status).toBe(400);
    expect((await app().request('/api/garden?asOf=yesterday')).status).toBe(400);
    expect((await app().request('/api/nope')).status).toBe(404);
  });
  it('sends the strict CSP (no remote origins, no eval) on every response', async () => {
    for (const path of ['/api/health', '/api/nope', '/api/legend']) {
      const csp = (await app().request(path)).headers.get('content-security-policy');
      expect(csp).toBe(CSP);
    }
    expect(CSP).not.toMatch(/https?:|unsafe-eval|\*/);
  });
  it('legend lists every encoding', async () => {
    const l = (await (await app().request('/api/legend')).json()) as { id: string }[];
    expect(l.map((e) => e.id)).toContain('plant.bloom');
  });
});

describe('server binding', () => {
  it('listens on 127.0.0.1 only', async () => {
    const { server, url } = await startServer({ store, port: 0 });
    const addr = server.address() as AddressInfo;
    expect(addr.address).toBe('127.0.0.1');
    expect(HOST).toBe('127.0.0.1');
    expect(url.startsWith('http://127.0.0.1:')).toBe(true);
    const r = await fetch(`${url}/api/health`);
    expect(r.status).toBe(200);
    await new Promise((res) => server.close(res));
  });
});

describe('static export', () => {
  it('writes garden and legend JSON', () => {
    const out = join(dir, 'export');
    const { files } = exportStatic({ store, asOf: '2026-12-31T00:00:00Z' }, out, 3650);
    expect(files.map((f) => f.replace(out, ''))).toEqual([
      '/data/garden.json',
      '/data/legend.json',
    ]);
  });
  it('copies the web app and marks index.html as a static export', () => {
    const web = join(dir, 'fake-dist');
    mkdirSync(web, { recursive: true });
    writeFileSync(
      join(web, 'index.html'),
      '<!doctype html><html><head><title>x</title></head></html>',
    );
    const out = join(dir, 'export2');
    exportStatic({ store, webDist: web }, out);
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toContain(
      'name="agent-garden-source" content="static"',
    );
  });
});

describe('plant, compare, replant views', () => {
  const app = () => createApp({ store, asOf: '2026-12-31T00:00:00Z' });
  const garden = async () =>
    (await (await app().request('/api/garden?days=3650')).json()) as {
      plants: { id: string; agentId: string; bedId: string; name: string }[];
      beds: { id: string }[];
    };
  it('plant view carries evidence: outcome mix, signal stats, tiers, runs', async () => {
    const g = await garden();
    const p = g.plants[0]!;
    const r = await app().request(`/api/plant/${p.id}?days=3650`);
    expect(r.status).toBe(200);
    const v = (await r.json()) as {
      runs: { outcome: { source: string } }[];
      runsTotal: number;
      signalStats: { id: string; fired: number; notFired: number; notApplicable: number }[];
      outcomeMix: Record<string, number>;
      tierBreakdown: Record<string, number>;
    };
    expect(v.runs.length).toBe(Math.min(v.runsTotal, 200));
    expect(Object.values(v.outcomeMix).reduce((a, b) => a + b, 0)).toBe(v.runsTotal);
    for (const s of v.signalStats) expect(s.fired + s.notFired + s.notApplicable).toBe(v.runsTotal);
    expect(Object.keys(v.tierBreakdown).sort()).toEqual([
      'agent',
      'application',
      'hill_climbing',
      'verification',
    ]);
    expect((await app().request('/api/plant/plt_nope?days=3650')).status).toBe(404);
  });
  it('compare and replant return 404 for unknown ids and a caveat otherwise', async () => {
    const g = await garden();
    const b = g.beds[0]!.id;
    const c = (await (
      await app().request(`/api/compare?left=${b}&right=${b}&days=3650`)
    ).json()) as { caveat: string; harnessChanges: string[] };
    expect(c.caveat).toMatch(/Correlation, not causation/);
    expect(c.harnessChanges).toEqual([]);
    expect((await app().request(`/api/compare?left=${b}&right=nope`)).status).toBe(404);
    const p = g.plants[0]!;
    const rv = (await (
      await app().request(`/api/replant?agent=${p.agentId}&from=${b}&to=${b}&days=3650`)
    ).json()) as { success: { delta: number | null } };
    expect(rv.success.delta === null || rv.success.delta === 0).toBe(true);
    expect((await app().request(`/api/replant?agent=nope&from=${b}&to=${b}`)).status).toBe(404);
  });
});

describe('manual labels: UI → API → DB → recomputed views', () => {
  const app = () =>
    createApp({ store, asOf: '2026-12-31T00:00:00Z', redactor: new Redactor(Buffer.alloc(32, 4)) });
  const post = (runId: string, body: unknown, headers: Record<string, string> = {}) =>
    app().request(`/api/runs/${runId}/label`, {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:4310', 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('a manual label overrides the heuristic everywhere and can be cleared', async () => {
    const g = (await (await app().request('/api/garden?days=3650')).json()) as {
      plants: { id: string; success: { nManual: number; value: number | null } }[];
    };
    const plant = g.plants[0]!;
    const pv = (await (await app().request(`/api/plant/${plant.id}?days=3650`)).json()) as {
      runs: { runId: string; outcome: { label: string; heuristicLabel: string } }[];
    };
    const run = pv.runs[0]!;
    const flipped = run.outcome.heuristicLabel === 'failure' ? 'success' : 'failure';
    const r = await post(run.runId, { label: flipped, note: 'checked by hand' });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { outcome: { source: string } }).outcome.source).toBe('manual');

    const after = (await (await app().request(`/api/plant/${plant.id}?days=3650`)).json()) as {
      plant: { success: { nManual: number } };
      runs: {
        runId: string;
        outcome: {
          label: string;
          source: string;
          heuristicLabel: string;
          manual?: { note?: string };
        };
      }[];
    };
    const row = after.runs.find((x) => x.runId === run.runId)!;
    expect(row.outcome).toMatchObject({
      label: flipped,
      source: 'manual',
      heuristicLabel: run.outcome.heuristicLabel,
    });
    expect(row.outcome.manual?.note).toBe('checked by hand');
    expect(after.plant.success.nManual).toBe(plant.success.nManual + 1);
    const g2 = (await (await app().request('/api/garden?days=3650')).json()) as {
      plants: { id: string; success: { nManual: number } }[];
    };
    expect(g2.plants.find((p) => p.id === plant.id)!.success.nManual).toBe(
      plant.success.nManual + 1,
    );

    expect((await post(run.runId, { label: 'clear' })).status).toBe(200);
    const cleared = (await (await app().request(`/api/plant/${plant.id}?days=3650`)).json()) as {
      plant: { success: { nManual: number; value: number | null } };
    };
    expect(cleared.plant.success).toMatchObject({
      nManual: plant.success.nManual,
      value: plant.success.value,
    });
  });

  it('redacts secrets in notes before they reach the store', async () => {
    const runId = (store.db.prepare('SELECT id FROM runs LIMIT 1').get() as { id: string }).id;
    const { plantedSecrets } = await import('@garden/ingest/planted-secrets');
    const secret = plantedSecrets('note')[0]!;
    expect((await post(runId, { label: 'success', note: secret.context })).status).toBe(200);
    const note = (
      store.db.prepare('SELECT note FROM manual_labels WHERE run_id = ?').get(runId) as {
        note: string;
      }
    ).note;
    expect(note).not.toContain(secret.secret);
    expect(note).toContain('[REDACTED:');
    await post(runId, { label: 'clear' });
  });

  it('rejects bad input and unknown runs', async () => {
    const runId = (store.db.prepare('SELECT id FROM runs LIMIT 1').get() as { id: string }).id;
    expect((await post(runId, { label: 'great' })).status).toBe(400);
    expect((await post('run_nope', { label: 'success' })).status).toBe(404);
    const noRedactor = createApp({ store });
    const r = await noRedactor.request(`/api/runs/${runId}/label`, {
      method: 'POST',
      headers: { origin: 'http://localhost:4310', 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'success', note: 'x' }),
    });
    expect(r.status).toBe(501);
  });
});

describe('local-only guards', () => {
  const app = () => createApp({ store, redactor: new Redactor(Buffer.alloc(32, 4)) });
  const runId = () => (store.db.prepare('SELECT id FROM runs LIMIT 1').get() as { id: string }).id;
  it('refuses requests addressed to a non-loopback host (DNS rebinding)', async () => {
    const r = await app().request('/api/garden', { headers: { host: 'evil.example:4310' } });
    expect(r.status).toBe(403);
    expect(
      (await app().request('/api/health', { headers: { host: '127.0.0.1:4310' } })).status,
    ).toBe(200);
    expect((await app().request('/api/health', { headers: { host: '[::1]:4310' } })).status).toBe(
      200,
    );
  });
  it('refuses cross-origin or non-JSON writes (CSRF)', async () => {
    const body = JSON.stringify({ label: 'success' });
    const send = (headers: Record<string, string>) =>
      app().request(`/api/runs/${runId()}/label`, { method: 'POST', headers, body });
    expect((await send({ 'content-type': 'application/json' })).status).toBe(403); // no Origin
    expect(
      (await send({ origin: 'https://evil.example', 'content-type': 'application/json' })).status,
    ).toBe(403);
    expect((await send({ origin: 'null', 'content-type': 'application/json' })).status).toBe(403);
    expect(
      (await send({ origin: 'http://127.0.0.1:4310', 'content-type': 'text/plain' })).status,
    ).toBe(415);
    expect(store.getOutcome(runId())?.source).toBe('heuristic');
  });
});
