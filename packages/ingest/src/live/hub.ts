/**
 * Holds the live state for one source, assigns event sequence numbers, keeps a short ring of recent
 * events, and fans `LiveMessage`s out to subscribers. Memory only: nothing is written to disk.
 */
import type { LiveEvent, LiveMessage, LiveSnapshot } from '@garden/core';
import {
  initialLiveState,
  liveAgents,
  reduceLive,
  setRegistry,
  tickLive,
  type LiveState,
  type LiveUpdate,
} from './reduce';
import {
  DEFAULT_ACTIVE_WINDOW_SEC,
  LIVE_RECENT_CAP,
  type LiveObservation,
  type RegistryStatus,
} from './types';

export type LiveListener = (msg: LiveMessage) => void;

export interface LiveHubOptions {
  source: LiveSnapshot['source'];
  activeWindowSec?: number;
  now?: () => number;
  /** Interval of the heuristic tick (ms). 0 disables the timer (tests call `tick()`). */
  tickMs?: number;
}

export class LiveHub {
  readonly source: LiveSnapshot['source'];
  private state: LiveState;
  private seq = 0;
  private readonly recent: LiveEvent[] = [];
  private readonly listeners = new Set<LiveListener>();
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly stopHooks: (() => void)[] = [];

  constructor(opts: LiveHubOptions) {
    this.source = opts.source;
    this.state = initialLiveState(opts.activeWindowSec ?? DEFAULT_ACTIVE_WINDOW_SEC);
    this.now = opts.now ?? Date.now;
    const tickMs = opts.tickMs ?? 1000;
    if (tickMs > 0) {
      this.timer = setInterval(() => this.tick(), tickMs);
      this.timer.unref?.();
    }
  }

  get activeWindowSec(): number {
    return this.state.activeWindowSec;
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  /** Feed one observation; broadcasts `event`, then `agent` for each changed agent. */
  push(obs: LiveObservation): LiveEvent {
    const event: LiveEvent = { seq: ++this.seq, ...obs.event };
    this.recent.push(event);
    if (this.recent.length > LIVE_RECENT_CAP) this.recent.shift();
    const u = reduceLive(this.state, obs, this.now());
    this.state = u.state;
    this.emit({ type: 'event', event });
    this.publish(u);
    return event;
  }

  /** Replace the optional session-registry view (by session id) and re-apply the heuristics. */
  setRegistry(registry: Record<string, RegistryStatus>): void {
    this.state = setRegistry(this.state, registry);
    this.tick();
  }

  tick(): void {
    const u = tickLive(this.state, this.now());
    this.state = u.state;
    this.publish(u);
  }

  snapshot(): LiveSnapshot {
    return {
      generatedAt: new Date(this.now()).toISOString(),
      source: this.source,
      agents: liveAgents(this.state),
      activeWindowSec: this.state.activeWindowSec,
      recent: [...this.recent],
    };
  }

  /** Subscribe; returns the unsubscribe function. */
  subscribe(fn: LiveListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Register cleanup for the source feeding this hub (watchers, timers). */
  onStop(fn: () => void): void {
    this.stopHooks.push(fn);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const fn of this.stopHooks.splice(0)) fn();
    this.listeners.clear();
  }

  private publish(u: LiveUpdate): void {
    for (const agent of u.changed) this.emit({ type: 'agent', agent });
    for (const agentKey of u.gone) this.emit({ type: 'gone', agentKey });
  }

  private emit(msg: LiveMessage): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(msg);
      } catch {
        // A failing subscriber must not break the others or the source.
      }
    }
  }
}
