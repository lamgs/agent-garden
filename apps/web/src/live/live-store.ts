/**
 * One live connection for the page, outside React. The renderer overlay subscribes imperatively;
 * DOM chrome reads it with `useLive()` (useSyncExternalStore), so live updates never touch the
 * garden's React tree. `?live=off` starts with the layer off; the status pill toggles it.
 */
import { useSyncExternalStore } from 'react';
import type { ID, LiveSnapshot } from '@garden/core';
import { connectLive, type LiveConnection, type LiveState } from './live-client';

export type LivePill = 'connecting' | 'live' | 'fixture' | 'reconnecting' | 'off';

export interface LiveStoreState {
  /** null when the layer is off or nothing has arrived. */
  snapshot: LiveSnapshot | null;
  pill: LivePill;
  /** Why it is in this state (connection detail, or why it is off). */
  detail: string;
  /** The user switched the layer off (vs. the stream being unavailable). */
  userOff: boolean;
  rejected: number;
  /** Wall-clock ms when the snapshot last changed (to extrapolate "now" between updates). */
  receivedAt: number;
  /** Names of every agent seen, so ticker lines of agents that are gone still read. */
  names: ReadonlyMap<ID, { bedName: string; agentName: string; bedId: ID }>;
}

type Listener = () => void;

function pillOf(s: LiveState): { pill: LivePill; snapshot: LiveSnapshot | null; detail: string } {
  switch (s.status) {
    case 'live':
      return { pill: 'live', snapshot: s.snapshot, detail: s.detail };
    case 'fixture':
      return { pill: 'fixture', snapshot: s.snapshot, detail: s.detail };
    case 'reconnecting':
      return { pill: 'reconnecting', snapshot: s.snapshot, detail: s.detail };
    case 'connecting':
      return { pill: 'connecting', snapshot: s.snapshot, detail: s.detail };
    case 'fallback':
      // The client would play the demo stream here. Never mix demo agents into a real garden:
      // the layer is off and the pill says why.
      return {
        pill: 'off',
        snapshot: null,
        detail: s.detail.replace(/^demo stream \((.*)\)$/, '$1'),
      };
  }
}

export class LiveStore {
  private conn: LiveConnection | null = null;
  private listeners = new Set<Listener>();
  private names = new Map<ID, { bedName: string; agentName: string; bedId: ID }>();
  private state: LiveStoreState = {
    snapshot: null,
    pill: 'off',
    detail: 'starts with the garden view',
    userOff: false,
    rejected: 0,
    receivedAt: 0,
    names: this.names,
  };

  constructor(
    private readonly search: string = typeof window !== 'undefined' ? window.location.search : '',
  ) {}

  get = (): LiveStoreState => this.state;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<LiveStoreState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  /** Why no live stream can exist for this page (null: it may). */
  private unavailable: string | null = null;
  private configured = false;

  /**
   * Called when the garden view is shown, with where its data came from. The live layer exists
   * for the local API (when the server runs it: `/api/health` → `live`) and the demo fixture; a
   * static export or another fixture has no stream, so nothing is requested.
   */
  configure(source: 'api' | 'static' | 'fixture'): void {
    if (this.configured) return;
    this.configured = true;
    const q = new URLSearchParams(this.search);
    const fixture = q.get('fixture');
    if (source === 'fixture' && fixture !== 'demo')
      this.unavailable = `no live stream for the ${fixture ?? 'bundled'} fixture`;
    else if (source === 'static') this.unavailable = 'static export: no live stream';
    if (this.unavailable) return this.set({ pill: 'off', detail: this.unavailable });
    if (q.get('live') === 'off')
      return this.set({ userOff: true, pill: 'off', detail: 'live layer off (?live=off)' });
    if (source !== 'api') return this.start();
    this.set({ pill: 'connecting', detail: 'checking the local API…' });
    void fetch('/api/health', { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? (r.json() as Promise<unknown>) : null))
      .catch(() => null)
      .then((h) => {
        const live = h && typeof h === 'object' ? (h as { live?: unknown }).live : undefined;
        if (live === false) {
          this.unavailable = 'the server runs without the live layer (--no-live)';
          this.set({ pill: 'off', detail: this.unavailable });
        } else this.start();
      });
  }

  start(): void {
    if (this.conn || this.historical) return;
    if (this.unavailable) return this.set({ pill: 'off', detail: this.unavailable });
    if (!this.configured) return;
    this.set({ userOff: false, pill: 'connecting', detail: 'connecting…' });
    this.conn = connectLive({
      search: this.search,
      onState: (s) => {
        const p = pillOf(s);
        if (s.status === 'fallback') {
          this.conn?.close();
          this.conn = null;
        }
        if (p.snapshot)
          for (const a of p.snapshot.agents)
            if (!this.names.has(a.key))
              this.names.set(a.key, { bedName: a.bedName, agentName: a.agentName, bedId: a.bedId });
        this.set({
          ...p,
          rejected: s.rejected,
          receivedAt: p.snapshot !== this.state.snapshot ? Date.now() : this.state.receivedAt,
        });
      },
    });
  }

  stop(byUser = true): void {
    this.conn?.close();
    this.conn = null;
    this.set({
      snapshot: null,
      pill: 'off',
      userOff: byUser,
      detail: byUser ? 'live layer switched off' : this.state.detail,
    });
  }

  /** Set while the garden shows a past date (`asOf`): live only describes now, so it stays off. */
  private historical: string | null = null;

  setHistorical(asOf: string | undefined): void {
    const next = asOf ?? null;
    if (next === this.historical) return;
    this.historical = next;
    if (next) {
      const wasOn = Boolean(this.conn);
      this.conn?.close();
      this.conn = null;
      this.set({
        snapshot: null,
        pill: 'off',
        detail: `garden shown as of ${next.slice(0, 10)}: live shows only now`,
      });
      this.resumeOnNow = wasOn || !this.state.userOff;
    } else if (this.configured && this.resumeOnNow && !this.state.userOff) this.start();
  }

  private resumeOnNow = false;

  toggle(): void {
    if (this.unavailable || !this.configured || this.historical) return;
    if (this.state.userOff || (!this.conn && this.state.pill === 'off')) this.start();
    else this.stop(true);
  }

  /** The live clock: the snapshot's time, advanced by wall time since it arrived. */
  now(at = Date.now()): number {
    const s = this.state.snapshot;
    if (!s) return at;
    return Date.parse(s.generatedAt) + Math.max(0, at - this.state.receivedAt);
  }
}

let shared: LiveStore | null = null;

/** The page's live store (connects once `configure` is called by the garden view). */
export function liveStore(): LiveStore {
  shared ??= new LiveStore();
  return shared;
}

export function useLive(): LiveStoreState {
  const s = liveStore();
  return useSyncExternalStore(s.subscribe, s.get, s.get);
}
