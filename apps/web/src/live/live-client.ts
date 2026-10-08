/**
 * Live layer client. Served by the local API it reads `GET /api/live/stream` (SSE carrying
 * `LiveMessage` JSON: one `snapshot`, then `event` / `agent` / `gone`). With `?fixture=demo`, or
 * when the stream is unavailable, it plays the deterministic demo stream (fixtures/live-demo.ts).
 * Nothing is fetched from anywhere but this origin.
 *
 * The pure parts (message parsing, the reducer to a `LiveSnapshot`, the attention queue) carry no
 * DOM or timers so they are unit-tested directly.
 */
import type { ID, LiveAgent, LiveEvent, LiveMessage, LiveSnapshot } from '@garden/core';
import type { LiveDemoOptions } from '../fixtures/live-demo';
import { waitInferred } from './overlay-model';

export const LIVE_STREAM_URL = '/api/live/stream';
export const RECENT_CAP = 60;

// ---- parsing (IO boundary) -----------------------------------------------------------------

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === 'string';
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

function isAgent(x: unknown): x is LiveAgent {
  return (
    isObj(x) &&
    isStr(x.key) &&
    isStr(x.sessionId) &&
    isStr(x.agentName) &&
    (x.agentKind === 'main' || x.agentKind === 'subagent') &&
    isStr(x.bedId) &&
    isStr(x.activity) &&
    isNum(x.contextTokens) &&
    isNum(x.contextWindow)
  );
}

function isEvent(x: unknown): x is LiveEvent {
  return isObj(x) && isNum(x.seq) && isStr(x.at) && isStr(x.kind) && isStr(x.agentKey);
}

function isSnapshot(x: unknown): x is LiveSnapshot {
  return (
    isObj(x) &&
    isStr(x.generatedAt) &&
    Array.isArray(x.agents) &&
    x.agents.every(isAgent) &&
    Array.isArray(x.recent) &&
    x.recent.every(isEvent)
  );
}

/**
 * Validate one stream payload. Accepts the `LiveMessage` envelope (`{ type, ... }`), or, for an
 * SSE event named `snapshot` / `event` / `agent` / `gone`, the bare inner object. Anything else →
 * null (counted by the caller, never thrown).
 */
export function parseLiveMessage(raw: unknown, eventName?: string): LiveMessage | null {
  let x = raw;
  if (typeof x === 'string') {
    try {
      x = JSON.parse(x) as unknown;
    } catch {
      return null;
    }
  }
  if (!isObj(x)) return null;
  const type = isStr(x.type) ? x.type : eventName;
  switch (type) {
    case 'snapshot': {
      const s = 'snapshot' in x ? x.snapshot : x;
      return isSnapshot(s) ? { type: 'snapshot', snapshot: s } : null;
    }
    case 'event': {
      const e = 'event' in x ? x.event : x;
      return isEvent(e) ? { type: 'event', event: e } : null;
    }
    case 'agent': {
      const a = 'agent' in x ? x.agent : x;
      return isAgent(a) ? { type: 'agent', agent: a } : null;
    }
    case 'gone':
      return isStr(x.agentKey) ? { type: 'gone', agentKey: x.agentKey } : null;
    default:
      return null;
  }
}

// ---- reducer -------------------------------------------------------------------------------

const later = (a: string, b: string) => (Date.parse(b) > Date.parse(a) ? b : a);

/**
 * Apply one message to the current snapshot (immutable: changed parts are new objects).
 * Before the first `snapshot` arrives there is nothing to apply deltas to, so they are dropped
 * (the server always sends a snapshot first, and again after a reconnect).
 * Events are deduplicated by `seq` (a reconnect can replay); `recent` stays newest last, capped.
 */
export function reduceLive(
  s: LiveSnapshot | null,
  m: LiveMessage,
  cap = RECENT_CAP,
): LiveSnapshot | null {
  if (m.type === 'snapshot') {
    return {
      ...m.snapshot,
      agents: [...m.snapshot.agents],
      recent: m.snapshot.recent.slice(-cap),
    };
  }
  if (!s) return null;
  switch (m.type) {
    case 'event': {
      const last = s.recent[s.recent.length - 1];
      if (last && m.event.seq <= last.seq) return s;
      const recent = [...s.recent, m.event];
      if (recent.length > cap) recent.splice(0, recent.length - cap);
      return { ...s, recent, generatedAt: later(s.generatedAt, m.event.at) };
    }
    case 'agent': {
      const i = s.agents.findIndex((a) => a.key === m.agent.key);
      const agents = [...s.agents];
      if (i < 0) agents.push(m.agent);
      else agents[i] = m.agent;
      return { ...s, agents, generatedAt: later(s.generatedAt, m.agent.lastEventAt) };
    }
    case 'gone': {
      if (!s.agents.some((a) => a.key === m.agentKey)) return s;
      return { ...s, agents: s.agents.filter((a) => a.key !== m.agentKey) };
    }
  }
}

/** Reduce a batch of messages. */
export function reduceAll(
  s: LiveSnapshot | null,
  ms: readonly LiveMessage[],
  cap = RECENT_CAP,
): LiveSnapshot | null {
  let out = s;
  for (const m of ms) out = reduceLive(out, m, cap);
  return out;
}

// ---- selectors -----------------------------------------------------------------------------

export interface AttentionItem {
  key: ID;
  agent: LiveAgent;
  reason: 'waiting_permission' | 'waiting_input';
  waitingMs: number;
  /** Guessed from silence or an end of turn (see `waitInferred`); hooks and the registry record it. */
  inferred: boolean;
}

/**
 * "Needs you now": agents waiting for permission or for input, permission first, then the longest
 * wait first. In transcript or demo mode most waits are inferred; hook events, the session
 * registry, and AskUserQuestion / ExitPlanMode calls record them.
 */
export function attentionQueue(
  s: LiveSnapshot,
  nowMs = Date.parse(s.generatedAt),
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const a of s.agents) {
    if (a.activity !== 'waiting_permission' && a.activity !== 'waiting_input') continue;
    items.push({
      key: a.key,
      agent: a,
      reason: a.activity,
      waitingMs: Math.max(0, nowMs - Date.parse(a.activitySince)),
      inferred: waitInferred(a, s.source),
    });
  }
  const rank = (r: AttentionItem['reason']) => (r === 'waiting_permission' ? 0 : 1);
  return items.sort(
    (x, y) =>
      rank(x.reason) - rank(y.reason) || y.waitingMs - x.waitingMs || x.key.localeCompare(y.key),
  );
}

// ---- connection ----------------------------------------------------------------------------

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'fixture' | 'fallback';

export interface LiveState {
  snapshot: LiveSnapshot | null;
  status: LiveStatus;
  /** Human-readable source line, e.g. "demo stream (fixture)" or why it fell back. */
  detail: string;
  /** Payloads that failed validation (reported, never thrown). */
  rejected: number;
}

/** The subset of EventSource we use, so tests can pass a fake. */
export interface EventSourceLike {
  readyState: number;
  onopen: ((ev: Event) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  addEventListener(type: string, fn: (ev: MessageEvent) => void): void;
  close(): void;
}

export interface ConnectOptions {
  onState: (s: LiveState) => void;
  search?: string;
  url?: string;
  EventSourceImpl?: new (url: string) => EventSourceLike;
  /** Fixture playback tick (virtual ms per real tick, 1:1). */
  tickMs?: number;
  setIntervalImpl?: (fn: () => void, ms: number) => unknown;
  clearIntervalImpl?: (h: unknown) => void;
  demo?: LiveDemoOptions;
}

export interface LiveConnection {
  close(): void;
  /** Resolves once the first state with a snapshot has been delivered. */
  ready: Promise<void>;
}

/** Which source the URL asks for. `?fixture=demo` (optionally `&crowd=1`) plays the demo stream. */
export function liveSourceFor(
  search: string,
): { kind: 'fixture'; crowd: boolean } | { kind: 'stream' } {
  const q = new URLSearchParams(search);
  if (q.get('fixture') === 'demo') return { kind: 'fixture', crowd: q.get('crowd') === '1' };
  return { kind: 'stream' };
}

const STREAM_TYPES = ['snapshot', 'event', 'agent', 'gone'] as const;

export function connectLive(opts: ConnectOptions): LiveConnection {
  const search = opts.search ?? (typeof window !== 'undefined' ? window.location.search : '');
  const setI = opts.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
  const clearI =
    opts.clearIntervalImpl ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const tickMs = opts.tickMs ?? 250;
  let state: LiveState = {
    snapshot: null,
    status: 'connecting',
    detail: 'connecting…',
    rejected: 0,
  };
  let closed = false;
  let es: EventSourceLike | null = null;
  let timer: unknown = null;
  let resolveReady: () => void = () => undefined;
  const ready = new Promise<void>((r) => (resolveReady = r));

  const publish = (patch: Partial<LiveState>) => {
    if (closed) return;
    state = { ...state, ...patch };
    opts.onState(state);
    if (state.snapshot) resolveReady();
  };

  const startFixture = async (status: 'fixture' | 'fallback', detail: string, crowd: boolean) => {
    const { createLiveDemo } = await import('../fixtures/live-demo');
    if (closed) return;
    const demo = createLiveDemo({ crowd, ...opts.demo });
    publish({ snapshot: demo.snapshot(), status, detail });
    timer = setI(() => {
      const msgs = demo.advance(tickMs);
      if (msgs.length) publish({ snapshot: reduceAll(state.snapshot, msgs) });
    }, tickMs);
  };

  const src = liveSourceFor(search);
  const ES =
    opts.EventSourceImpl ??
    (typeof EventSource !== 'undefined'
      ? (EventSource as unknown as new (url: string) => EventSourceLike)
      : undefined);

  if (src.kind === 'fixture') {
    void startFixture('fixture', `demo stream${src.crowd ? ', crowd' : ''} (fixture)`, src.crowd);
  } else if (!ES) {
    void startFixture('fallback', 'demo stream (no EventSource in this browser)', false);
  } else {
    const url = opts.url ?? LIVE_STREAM_URL;
    let received = false;
    const source = new ES(url);
    es = source;
    const onData = (ev: MessageEvent, name?: string) => {
      const m = parseLiveMessage(ev.data, name);
      if (!m) {
        publish({ rejected: state.rejected + 1 });
        return;
      }
      received = true;
      publish({ snapshot: reduceLive(state.snapshot, m), status: 'live', detail: url });
    };
    source.onmessage = (ev) => onData(ev);
    for (const t of STREAM_TYPES) source.addEventListener(t, (ev) => onData(ev, t));
    source.onopen = () => publish({ status: received ? 'live' : 'connecting', detail: url });
    source.onerror = () => {
      // Never got a message (no live API, e.g. static export or preview): play the demo instead.
      // CLOSED (2) means the browser gave up retrying.
      if (!received || source.readyState === 2) {
        source.close();
        es = null;
        void startFixture('fallback', `demo stream (live stream unavailable at ${url})`, false);
      } else publish({ status: 'reconnecting', detail: `${url} (reconnecting)` });
    };
  }

  return {
    ready,
    close() {
      closed = true;
      es?.close();
      if (timer !== null) clearI(timer);
    },
  };
}
