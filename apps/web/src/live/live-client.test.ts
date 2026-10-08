import { describe, expect, it } from 'vitest';
import type { LiveAgent, LiveEvent, LiveSnapshot } from '@garden/core';
import {
  attentionQueue,
  connectLive,
  liveSourceFor,
  parseLiveMessage,
  reduceLive,
  type EventSourceLike,
  type LiveState,
} from './live-client';

const T0 = '2026-10-01T12:00:00.000Z';
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();

const agent = (key: string, extra: Partial<LiveAgent> = {}): LiveAgent => ({
  key,
  sessionId: key,
  agentName: 'main',
  agentKind: 'main',
  bedId: 'fam_x',
  bedName: 'x',
  activity: 'thinking',
  activitySince: T0,
  lastEventAt: T0,
  contextTokens: 1000,
  contextWindow: 200_000,
  toolCalls: 0,
  errors: 0,
  evidence: 'test',
  ...extra,
});
const event = (seq: number, extra: Partial<LiveEvent> = {}): LiveEvent => ({
  seq,
  at: at(seq),
  kind: 'tool_start',
  agentKey: 'a',
  ...extra,
});
const snap = (extra: Partial<LiveSnapshot> = {}): LiveSnapshot => ({
  generatedAt: T0,
  source: 'transcripts',
  agents: [agent('a')],
  activeWindowSec: 300,
  recent: [event(1)],
  ...extra,
});

describe('parseLiveMessage', () => {
  it('accepts envelopes, JSON strings, and bare payloads under a named SSE event', () => {
    expect(parseLiveMessage({ type: 'snapshot', snapshot: snap() })?.type).toBe('snapshot');
    expect(parseLiveMessage(JSON.stringify({ type: 'event', event: event(2) }))?.type).toBe(
      'event',
    );
    expect(parseLiveMessage(agent('b'), 'agent')).toEqual({ type: 'agent', agent: agent('b') });
    expect(parseLiveMessage({ agentKey: 'a' }, 'gone')).toEqual({ type: 'gone', agentKey: 'a' });
  });

  it('rejects malformed payloads instead of throwing', () => {
    expect(parseLiveMessage('{not json')).toBeNull();
    expect(parseLiveMessage({ type: 'agent', agent: { key: 'a' } })).toBeNull();
    expect(parseLiveMessage({ type: 'event', event: { seq: 'x' } })).toBeNull();
    expect(parseLiveMessage({ type: 'nope' })).toBeNull();
    expect(parseLiveMessage(null)).toBeNull();
    expect(parseLiveMessage([1, 2])).toBeNull();
  });
});

describe('reduceLive', () => {
  it('drops deltas before the first snapshot', () => {
    expect(reduceLive(null, { type: 'agent', agent: agent('a') })).toBeNull();
  });

  it('upserts agents in arrival order and removes gone ones', () => {
    let s = reduceLive(null, { type: 'snapshot', snapshot: snap() });
    s = reduceLive(s, { type: 'agent', agent: agent('b', { lastEventAt: at(5) }) });
    s = reduceLive(s, { type: 'agent', agent: agent('a', { activity: 'editing' }) });
    expect(s!.agents.map((a) => [a.key, a.activity])).toEqual([
      ['a', 'editing'],
      ['b', 'thinking'],
    ]);
    expect(s!.generatedAt).toBe(at(5));
    s = reduceLive(s, { type: 'gone', agentKey: 'a' });
    expect(s!.agents.map((a) => a.key)).toEqual(['b']);
    const same = reduceLive(s, { type: 'gone', agentKey: 'zzz' });
    expect(same).toBe(s);
  });

  it('appends events newest last, dedupes by seq, caps the list', () => {
    let s = reduceLive(null, { type: 'snapshot', snapshot: snap() });
    for (let i = 2; i <= 10; i++) s = reduceLive(s, { type: 'event', event: event(i) }, 5);
    expect(s!.recent.map((e) => e.seq)).toEqual([6, 7, 8, 9, 10]);
    const again = reduceLive(s, { type: 'event', event: event(9) }, 5);
    expect(again).toBe(s);
    expect(s!.generatedAt).toBe(at(10));
  });

  it('a new snapshot (reconnect) replaces state and does not mutate the input', () => {
    const first = snap();
    let s = reduceLive(null, { type: 'snapshot', snapshot: first });
    s = reduceLive(s, { type: 'agent', agent: agent('b') });
    expect(first.agents).toHaveLength(1);
    s = reduceLive(s, { type: 'snapshot', snapshot: snap({ agents: [], recent: [] }) });
    expect(s!.agents).toEqual([]);
  });
});

describe('attentionQueue', () => {
  it('lists permission waits first, then input waits, longest wait first', () => {
    const s = snap({
      generatedAt: at(100),
      agents: [
        agent('in-short', { activity: 'waiting_input', activitySince: at(90) }),
        agent('perm', { activity: 'waiting_permission', activitySince: at(95) }),
        agent('in-long', { activity: 'waiting_input', activitySince: at(10) }),
        agent('busy', { activity: 'editing' }),
      ],
    });
    const q = attentionQueue(s);
    expect(q.map((i) => i.key)).toEqual(['perm', 'in-long', 'in-short']);
    expect(q[0]!.waitingMs).toBe(5000);
    expect(q.every((i) => i.inferred)).toBe(true);
    expect(attentionQueue({ ...s, source: 'hooks' }).every((i) => !i.inferred)).toBe(true);
  });
});

describe('liveSourceFor', () => {
  it('reads the fixture param', () => {
    expect(liveSourceFor('?fixture=demo')).toEqual({ kind: 'fixture', crowd: false });
    expect(liveSourceFor('?fixture=demo&crowd=1')).toEqual({ kind: 'fixture', crowd: true });
    expect(liveSourceFor('')).toEqual({ kind: 'stream' });
  });
});

class FakeES implements EventSourceLike {
  static last: FakeES | null = null;
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  listeners = new Map<string, ((ev: MessageEvent) => void)[]>();
  closed = false;
  constructor(readonly url: string) {
    FakeES.last = this;
  }
  addEventListener(type: string, fn: (ev: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  send(data: unknown, name?: string) {
    const ev = { data: JSON.stringify(data) } as MessageEvent;
    if (name) for (const fn of this.listeners.get(name) ?? []) fn(ev);
    else this.onmessage?.(ev);
  }
}

describe('connectLive', () => {
  const manualTimers = () => {
    const fns: (() => void)[] = [];
    return {
      setIntervalImpl: (fn: () => void) => (fns.push(fn), fns.length),
      clearIntervalImpl: () => (fns.length = 0),
      tick: () => fns.forEach((f) => f()),
      count: () => fns.length,
    };
  };

  it('streams from EventSource and reduces messages', async () => {
    const states: LiveState[] = [];
    const c = connectLive({ search: '', EventSourceImpl: FakeES, onState: (s) => states.push(s) });
    const es = FakeES.last!;
    expect(es.url).toBe('/api/live/stream');
    es.send({ type: 'snapshot', snapshot: snap() });
    es.send(agent('b'), 'agent');
    es.send({ type: 'bogus' });
    await c.ready;
    const s = states.at(-1)!;
    expect(s.status).toBe('live');
    expect(s.snapshot!.agents.map((a) => a.key)).toEqual(['a', 'b']);
    expect(s.rejected).toBe(1);
    es.onerror?.(new Event('error'));
    expect(states.at(-1)!.status).toBe('reconnecting');
    c.close();
    expect(es.closed).toBe(true);
  });

  it('falls back to the demo stream when the live stream never answers', async () => {
    const states: LiveState[] = [];
    const t = manualTimers();
    const c = connectLive({
      search: '',
      EventSourceImpl: FakeES,
      onState: (s) => states.push(s),
      ...t,
    });
    FakeES.last!.onerror?.(new Event('error'));
    expect(FakeES.last!.closed).toBe(true);
    await c.ready;
    expect(states.at(-1)!.status).toBe('fallback');
    expect(states.at(-1)!.snapshot!.source).toBe('demo');
    c.close();
  });

  it('plays the fixture under ?fixture=demo and advances on each tick', async () => {
    const states: LiveState[] = [];
    const t = manualTimers();
    const c = connectLive({ search: '?fixture=demo', onState: (s) => states.push(s), ...t });
    await c.ready;
    expect(states.at(-1)!.status).toBe('fixture');
    const before = states.at(-1)!.snapshot!.generatedAt;
    for (let i = 0; i < 20; i++) t.tick();
    expect(Date.parse(states.at(-1)!.snapshot!.generatedAt)).toBeGreaterThan(Date.parse(before));
    c.close();
    expect(t.count()).toBe(0);
  });
});
