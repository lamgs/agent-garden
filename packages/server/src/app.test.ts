import { cpSync, mkdtempSync, rmSync } from 'node:fs';
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
    expect(await r.json()).toMatchObject({ ok: true, schemaVersion: 2 });
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
});
