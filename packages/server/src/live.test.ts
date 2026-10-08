import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import type { LiveMessage } from '@garden/core';
import {
  ClaudeCodeAdapter,
  DemoLiveSource,
  LiveHub,
  LiveTailer,
  Redactor,
  Store,
  buildDemoSchedule,
  deriveAll,
  ingest,
  loadDemoRuns,
  type LiveObservation,
} from '@garden/ingest';
import { L } from '@garden/ingest/live-fixtures';
import { plantedSecrets } from '@garden/ingest/planted-secrets';
import { createApp } from './app';
import { plantId } from './garden';
import { storePlantLookup } from './live';
import { startServer } from './serve';

const store = new Store(':memory:');
const dir = mkdtempSync(join(tmpdir(), 'garden-live-api-'));
const servers: { close: () => void }[] = [];
afterAll(() => {
  for (const s of servers) s.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const obs = (
  kind: LiveObservation['event']['kind'],
  extra: Partial<LiveObservation> = {},
): LiveObservation => ({
  event: { at: new Date().toISOString(), kind, agentKey: 'ses_1' },
  agent: {
    key: 'ses_1',
    sessionId: 'ses_1',
    agentKind: 'main',
    agentName: 'main',
    bedId: 'fam_1',
    bedName: 'repo',
  },
  ...extra,
});

async function serve(hub: LiveHub, heartbeatMs = 15_000) {
  const { server, url } = await startServer({
    store,
    live: hub,
    liveHeartbeatMs: heartbeatMs,
    port: 0,
  });
  servers.push(server);
  return { url: url.replace(/:\d+$/, `:${(server.address() as AddressInfo).port}`) };
}

/** Read SSE frames until `until` returns true. Returns parsed messages and the raw bytes. */
async function readStream(
  url: string,
  until: (msgs: LiveMessage[], raw: string) => boolean,
  ctl = new AbortController(),
) {
  const res = await fetch(`${url}/api/live/stream`, { signal: ctl.signal });
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let raw = '';
  const msgs: LiveMessage[] = [];
  const names: string[] = [];
  const deadline = Date.now() + 5000;
  while (!until(msgs, raw) && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    raw += dec.decode(value, { stream: true });
    msgs.length = 0;
    names.length = 0;
    for (const frame of raw.split('\n\n').slice(0, -1)) {
      const ev = /^event: (.+)$/m.exec(frame)?.[1];
      const data = /^data: (.+)$/m.exec(frame)?.[1];
      if (ev && data) {
        names.push(ev);
        msgs.push(JSON.parse(data) as LiveMessage);
      }
    }
  }
  return { msgs, names, raw, ctl };
}

describe('live API', () => {
  it('404s when the live layer is off and keeps the loopback host guard', async () => {
    const off = createApp({ store });
    expect((await off.request('/api/live')).status).toBe(404);
    expect((await off.request('/api/live/stream')).status).toBe(404);
    const on = createApp({ store, live: new LiveHub({ source: 'demo', tickMs: 0 }) });
    expect((await on.request('http://evil.test/api/live')).status).toBe(403);
    expect((await on.request('http://evil.test/api/live/stream')).status).toBe(403);
    const snap = await (await on.request('http://127.0.0.1/api/live')).json();
    expect(snap).toMatchObject({ source: 'demo', agents: [], recent: [], activeWindowSec: 1800 });
  });

  it('streams a snapshot first, then event and agent messages, with heartbeats; cleans up on disconnect', async () => {
    const hub = new LiveHub({ source: 'transcripts', tickMs: 0 });
    hub.push(obs('turn_start', { detail: 'before connect' }));
    const { url } = await serve(hub, 40);
    const ctl = new AbortController();
    const reading = readStream(url, (m, raw) => m.length >= 5 && raw.includes(': heartbeat'), ctl);
    await new Promise((r) => setTimeout(r, 100));
    expect(hub.subscriberCount).toBe(1);
    hub.push(
      obs('tool_start', {
        event: {
          ...obs('tool_start').event,
          kind: 'tool_start',
          tool: { name: 'Read', category: 'builtin' },
        },
        callId: 'c1',
      }),
    );
    hub.push(
      obs('tool_end', {
        event: {
          ...obs('tool_start').event,
          kind: 'tool_end',
          tool: { name: 'Read', category: 'builtin' },
        },
        callId: 'c1',
      }),
    );
    const { msgs, names, raw } = await reading;
    expect(names.slice(0, 5)).toEqual(['snapshot', 'event', 'agent', 'event', 'agent']);
    const first = msgs[0]!;
    expect(first.type === 'snapshot' && first.snapshot.agents[0]!.detail).toBe('before connect');
    expect(msgs[1]).toMatchObject({ type: 'event', event: { seq: 2, kind: 'tool_start' } });
    expect(msgs[2]).toMatchObject({ type: 'agent', agent: { activity: 'reading' } });
    expect(msgs[4]).toMatchObject({ type: 'agent', agent: { activity: 'thinking' } });
    expect(raw).toMatch(/^id: 2$/m);
    expect(raw).toContain(': heartbeat');
    ctl.abort();
    for (let i = 0; i < 50 && hub.subscriberCount > 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(hub.subscriberCount).toBe(0);
  });

  it('emits gone messages from the heuristic tick', async () => {
    let now = Date.now();
    const hub = new LiveHub({
      source: 'transcripts',
      tickMs: 0,
      now: () => now,
      activeWindowSec: 60,
    });
    hub.push(obs('turn_start'));
    const { url } = await serve(hub);
    const reading = readStream(url, (m) => m.some((x) => x.type === 'gone'));
    await new Promise((r) => setTimeout(r, 100));
    now += 61_000;
    hub.tick();
    const { msgs } = await reading;
    expect(msgs.at(-1)).toEqual({ type: 'gone', agentKey: 'ses_1' });
  });

  it('planted secrets in a tailed transcript never appear in SSE payload bytes', async () => {
    const proj = join(dir, '-work-x');
    mkdirSync(proj, { recursive: true });
    const f = join(proj, 'sess-s.jsonl');
    writeFileSync(f, '');
    const tl = new LiveTailer({
      redactor: new Redactor(Buffer.alloc(32, 5)),
      projectsDir: dir,
      sessionsDir: null,
      watch: false,
      pollMs: 0,
      scanMs: 0,
    });
    await tl.start();
    const { url } = await serve(tl.hub);
    const secrets = plantedSecrets('sse');
    const reading = readStream(
      url,
      (m) => m.filter((x) => x.type === 'event').length >= secrets.length * 4,
    );
    await new Promise((r) => setTimeout(r, 100));
    const at = () => ({ at: new Date().toISOString() });
    appendFileSync(
      f,
      secrets
        .flatMap((s, i) => [
          L.prompt(at(), s.context),
          L.toolUse(at(), `m${i}`, `b${i}`, 'Bash', { command: s.context }),
          L.toolResult(at(), `b${i}`, s.context, { isError: true }),
          L.text(at(), `t${i}`, s.context, 'end_turn'),
        ])
        .join('\n') + '\n',
    );
    await tl.poll();
    const { raw } = await reading;
    tl.hub.stop();
    const bytes = Buffer.from(raw, 'utf8');
    expect(raw).toContain('[REDACTED:');
    for (const s of secrets) expect(bytes.includes(Buffer.from(s.secret)), s.kind).toBe(false);
  });

  it('demo source replays stored runs with plant ids that exist in the store', async () => {
    const home = join(dir, 'claude');
    cpSync(new URL('../../../fixtures/claude-code', import.meta.url), home, { recursive: true });
    const st = new Store(join(dir, 'demo.db'));
    const redactor = new Redactor(Buffer.alloc(32, 4));
    const a = new ClaudeCodeAdapter({ claudeHome: home, claudeJsonPath: join(dir, 'none.json') });
    await ingest(a, st, redactor);
    deriveAll(st, a.garden);
    const runs = loadDemoRuns(st);
    expect(runs.length).toBeGreaterThan(0);
    const items = buildDemoSchedule(runs, redactor, { seed: 3 });
    expect(items.length).toBeGreaterThan(0);
    const exists = storePlantLookup(st, plantId);
    for (const it of items) expect(exists(it.obs.agent.plantId!)).toBe(true);
    const demo = DemoLiveSource.fromStore(st, redactor, { seed: 3, speed: 50 });
    demo.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(demo.hub.snapshot()).toMatchObject({ source: 'demo' });
    expect(demo.hub.snapshot().recent.length).toBeGreaterThan(0);
    demo.hub.stop();
    st.close();
  });
});
