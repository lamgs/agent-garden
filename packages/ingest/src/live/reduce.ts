/**
 * The live state machine. Pure: `reduceLive` folds one observation into the state, `tickLive`
 * applies the time-based heuristics. Both take `now` (ms) so tests inject a clock. Neither mutates
 * its input state; changed agents are returned as fresh objects.
 */
import { resolveModelPrice, type LiveActivity, type LiveAgent } from '@garden/core';
import { activityForTool, permissionThresholdMs } from './activity';
import {
  DEFAULT_ACTIVE_WINDOW_SEC,
  DEFAULT_CONTEXT_WINDOW,
  LIVE_THRESHOLDS,
  TURN_END_STOP_REASONS,
  type LiveAgentHints,
  type LiveObservation,
  type LiveToolRef,
  type PermissionDecision,
  type RegistryStatus,
} from './types';

export interface OpenCall {
  callId: string;
  tool: LiveToolRef;
  startedMs: number;
  detail?: string;
  background?: boolean;
}

export interface LiveAgentState {
  agent: LiveAgent;
  /** Tool calls without a result yet, oldest first. */
  open: OpenCall[];
  /** Time of the newest line seen for this agent (line timestamp, else arrival time). */
  lastLineMs: number;
  /** Recent API message ids whose usage was already taken (bounded). */
  seenMessageIds: string[];
  spawnCallId?: string;
  permissionMode?: string;
  /** `source/reasonType` of the most recent permissionDecisions (bounded). */
  recentDecisions: string[];
  /** Call id we flagged as possibly waiting for permission (reconciled when its result lands). */
  guessedCallId?: string;
  /** Call id whose permission guess was suppressed (so the note is written once). */
  suppressedCallId?: string;
}

export interface LiveState {
  agents: Readonly<Record<string, LiveAgentState>>;
  activeWindowSec: number;
  /** Optional session-registry status by session id (main thread only). */
  registry: Readonly<Record<string, RegistryStatus>>;
}

export interface LiveUpdate {
  state: LiveState;
  /** Agents whose state changed (fresh objects). */
  changed: LiveAgent[];
  /** Keys removed from the state (no event within the active window). */
  gone: string[];
}

const SEEN_IDS_CAP = 64;
const DECISIONS_CAP = 5;
/** permissionDecision.source for calls approved by config (rule, mode, classifier): no prompt shown. */
const AUTO_SOURCE = 'config';

function reconcile(pd: PermissionDecision | undefined): string {
  if (!pd) return 'unverified (no permissionDecision on the result)';
  if (pd.source === AUTO_SOURCE)
    return `was a false positive (auto-approved: ${pd.reasonType ?? 'unknown reason'})`;
  return `likely confirmed (permissionDecision source ${pd.source ?? 'unknown'}, ${pd.decision ?? 'no decision'})`;
}

/** True when this agent's recent calls were all auto-approved, so it is not being prompted. */
function autoApproving(s: LiveAgentState): boolean {
  if (s.permissionMode === 'bypassPermissions') return true;
  return (
    s.recentDecisions.length >= 3 && s.recentDecisions.every((d) => d.startsWith(`${AUTO_SOURCE}/`))
  );
}

export function initialLiveState(activeWindowSec = DEFAULT_ACTIVE_WINDOW_SEC): LiveState {
  return { agents: {}, activeWindowSec, registry: {} };
}

export function contextWindowOf(model: string | undefined): number {
  return (model && resolveModelPrice(model)?.contextWindow) || DEFAULT_CONTEXT_WINDOW;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const secs = (ms: number): string => `${Math.round(ms / 1000)} s`;

function newAgent(h: LiveAgentHints, atMs: number): LiveAgentState {
  const agent: LiveAgent = {
    key: h.key,
    sessionId: h.sessionId,
    agentName: h.agentName ?? (h.agentKind === 'main' ? 'main' : 'unknown-subagent'),
    agentKind: h.agentKind,
    bedId: h.bedId,
    bedName: h.bedName,
    activity: 'idle',
    activitySince: iso(atMs),
    lastEventAt: iso(atMs),
    contextTokens: 0,
    contextWindow: contextWindowOf(h.model),
    toolCalls: 0,
    errors: 0,
    evidence: 'transcript seen; no activity yet',
  };
  if (h.parentKey) agent.parentKey = h.parentKey;
  if (h.plantId) agent.plantId = h.plantId;
  if (h.model) agent.model = h.model;
  if (h.loop) agent.loop = h.loop;
  const s: LiveAgentState = {
    agent,
    open: [],
    lastLineMs: atMs,
    seenMessageIds: [],
    recentDecisions: [],
  };
  if (h.spawnCallId) s.spawnCallId = h.spawnCallId;
  if (h.permissionMode) s.permissionMode = h.permissionMode;
  return s;
}

function mergeHints(s: LiveAgentState, h: LiveAgentHints): void {
  const a = s.agent;
  a.bedId = h.bedId;
  a.bedName = h.bedName;
  if (h.agentName && (a.agentName === 'unknown-subagent' || a.agentKind === 'main')) {
    a.agentName = h.agentName;
  }
  if (h.parentKey) a.parentKey = h.parentKey;
  if (h.plantId) a.plantId = h.plantId;
  if (h.loop) a.loop = h.loop;
  if (h.model && h.model !== a.model) {
    a.model = h.model;
    a.contextWindow = contextWindowOf(h.model);
  }
  if (h.spawnCallId) s.spawnCallId = h.spawnCallId;
  if (h.permissionMode) s.permissionMode = h.permissionMode;
}

function setActivity(s: LiveAgentState, activity: LiveActivity, evidence: string, atMs: number) {
  if (s.agent.activity !== activity) {
    s.agent.activity = activity;
    s.agent.activitySince = iso(atMs);
  }
  s.agent.evidence = evidence;
}

function clone(s: LiveAgentState): LiveAgentState {
  const out: LiveAgentState = {
    ...s,
    agent: { ...s.agent },
    open: [...s.open],
    seenMessageIds: [...s.seenMessageIds],
    recentDecisions: [...s.recentDecisions],
  };
  if (s.agent.currentTool) out.agent.currentTool = { ...s.agent.currentTool };
  return out;
}

function setCurrentTool(s: LiveAgentState, call: OpenCall | undefined): void {
  if (call) {
    s.agent.currentTool = { ...call.tool };
    if (call.detail !== undefined) s.agent.detail = call.detail;
  } else delete s.agent.currentTool;
}

function endState(s: LiveAgentState): { activity: LiveActivity; label: string } {
  return s.agent.agentKind === 'main'
    ? { activity: 'waiting_input', label: 'waiting for the next prompt' }
    : { activity: 'done', label: 'subagent finished' };
}

/** Fold one observation into the state. */
export function reduceLive(state: LiveState, obs: LiveObservation, now: number): LiveUpdate {
  const h = obs.agent;
  const e = obs.event;
  const parsed = Date.parse(e.at);
  const atMs = Number.isNaN(parsed) ? now : parsed;
  const prev = state.agents[h.key];
  const s = prev ? clone(prev) : newAgent(h, atMs);
  if (prev) mergeHints(s, h);
  const agents: Record<string, LiveAgentState> = { ...state.agents, [h.key]: s };
  const changed: LiveAgent[] = [s.agent];

  if (atMs >= s.lastLineMs) {
    s.lastLineMs = atMs;
    s.agent.lastEventAt = iso(atMs);
  }
  if (e.contextTokens !== undefined) {
    const id = obs.apiMessageId;
    if (id === undefined || !s.seenMessageIds.includes(id)) {
      s.agent.contextTokens = e.contextTokens;
      if (id !== undefined) {
        s.seenMessageIds.push(id);
        if (s.seenMessageIds.length > SEEN_IDS_CAP) s.seenMessageIds.shift();
      }
    }
  }
  const endsTurn = obs.stopReason !== undefined && TURN_END_STOP_REASONS.has(obs.stopReason);

  switch (e.kind) {
    case 'session_seen':
      break;
    case 'turn_start': {
      s.agent.turnStartedAt = e.at;
      s.agent.toolCalls = 0;
      s.agent.errors = 0;
      s.open = [];
      setCurrentTool(s, undefined);
      const detail = obs.detail ?? e.preview;
      if (detail !== undefined) s.agent.detail = detail;
      else delete s.agent.detail;
      setActivity(s, 'thinking', 'prompt received; waiting for the model', atMs);
      break;
    }
    case 'thinking':
    case 'assistant_text': {
      s.agent.turnStartedAt ??= e.at;
      if (endsTurn) {
        const end = endState(s);
        s.open = [];
        setCurrentTool(s, undefined);
        setActivity(s, end.activity, `stop_reason ${obs.stopReason} → ${end.label}`, atMs);
      } else if (s.open.length === 0) {
        setActivity(
          s,
          'thinking',
          e.kind === 'thinking' ? 'thinking block' : 'assistant text, turn not ended',
          atMs,
        );
      }
      break;
    }
    case 'tool_start':
    case 'subagent_start': {
      s.agent.turnStartedAt ??= e.at;
      const tool: LiveToolRef = e.tool ?? { name: '(unknown)', category: 'builtin' };
      const call: OpenCall = { callId: obs.callId ?? `seq:${atMs}`, tool, startedMs: atMs };
      if (obs.detail !== undefined) call.detail = obs.detail;
      if (obs.background) call.background = true;
      s.open.push(call);
      s.agent.toolCalls++;
      setCurrentTool(s, call);
      setActivity(
        s,
        activityForTool(tool.name, tool.category),
        `${tool.name} tool_use, no tool_result yet`,
        atMs,
      );
      break;
    }
    case 'tool_end':
    case 'subagent_end': {
      const i = s.open.findIndex((c) => c.callId === obs.callId);
      const call = i >= 0 ? s.open.splice(i, 1)[0] : undefined;
      const name = call?.tool.name ?? e.tool?.name ?? 'tool';
      const last = s.open[s.open.length - 1];
      const pd = obs.permissionDecision;
      if (pd) {
        s.recentDecisions.push(`${pd.source ?? '?'}/${pd.reasonType ?? '?'}`);
        if (s.recentDecisions.length > DECISIONS_CAP) s.recentDecisions.shift();
      }
      let note = '';
      if (obs.callId && s.guessedCallId === obs.callId) {
        delete s.guessedCallId;
        note = `; earlier waiting_permission guess ${reconcile(pd)}`;
      }
      setCurrentTool(s, last);
      if (e.isError) {
        s.agent.errors++;
        setActivity(s, 'errored', `tool_result is_error for ${name}${note}`, atMs);
      } else if (last) {
        setActivity(
          s,
          activityForTool(last.tool.name, last.tool.category),
          `${last.tool.name} tool_use still open (${s.open.length} open)${note}`,
          atMs,
        );
      } else if (call || e.kind === 'tool_end') {
        setActivity(
          s,
          'thinking',
          `tool_result for ${name} received; waiting for the model${note}`,
          atMs,
        );
      }
      if (e.kind === 'subagent_end' && obs.callId) {
        for (const [k, child] of Object.entries(agents)) {
          if (child.spawnCallId !== obs.callId || child.agent.parentKey !== h.key) continue;
          const c = clone(child);
          c.open = [];
          setCurrentTool(c, undefined);
          const outcome = obs.childOutcome ?? 'done';
          setActivity(
            c,
            outcome,
            outcome === 'done'
              ? 'parent received the subagent result'
              : 'parent reported the subagent failed',
            atMs,
          );
          agents[k] = c;
          changed.push(c.agent);
        }
      }
      break;
    }
    case 'compaction':
      setActivity(s, 'compacting', 'compact_boundary record', atMs);
      break;
    case 'error':
      s.open = [];
      setCurrentTool(s, undefined);
      if (obs.interrupt) {
        setActivity(s, 'waiting_input', 'interrupted by the user', atMs);
      } else {
        s.agent.errors++;
        setActivity(s, 'errored', 'API error record', atMs);
      }
      break;
    case 'turn_end': {
      const end = endState(s);
      s.open = [];
      setCurrentTool(s, undefined);
      setActivity(
        s,
        end.activity,
        `stop_reason ${obs.stopReason ?? 'end_turn'} → ${end.label}`,
        atMs,
      );
      break;
    }
    case 'hook':
      break;
  }
  return { state: { ...state, agents }, changed, gone: [] };
}

/**
 * Replace the optional session-registry view (by session id). Pure; follow with `tickLive` to apply
 * it. A session whose process is known to have exited makes its agents `gone` on the next tick.
 */
export function setRegistry(state: LiveState, registry: Record<string, RegistryStatus>): LiveState {
  return { ...state, registry: { ...registry } };
}

type Verdict = { activity: LiveActivity; evidence: string } | 'note' | undefined;

function permissionVerdict(
  s: LiveAgentState,
  reg: RegistryStatus | undefined,
  now: number,
): Verdict {
  const call = s.open[s.open.length - 1];
  const a = s.agent.activity;
  if (a === 'waiting_permission' || a === 'idle' || a === 'done') return undefined;
  if (reg?.status === 'waiting') {
    const why = reg.waitingFor ? ` (waitingFor: ${reg.waitingFor})` : '';
    if (
      call &&
      !call.background &&
      permissionThresholdMs(call.tool.name, call.tool.category) !== undefined
    ) {
      return {
        activity: 'waiting_permission',
        evidence: `session registry status waiting${why} while ${call.tool.name} tool_use is open`,
      };
    }
    if (!call && a !== 'waiting_input') {
      return { activity: 'waiting_input', evidence: `session registry status waiting${why}` };
    }
    return undefined;
  }
  if (!call || call.background) return undefined;
  const thr = permissionThresholdMs(call.tool.name, call.tool.category);
  const quietMs = now - s.lastLineMs;
  const openMs = now - call.startedMs;
  if (thr === undefined || quietMs <= thr || openMs <= thr) return undefined;
  if (autoApproving(s)) return s.suppressedCallId === call.callId ? undefined : 'note';
  const caveat =
    thr === LIVE_THRESHOLDS.permissionMs
      ? 'a slow tool looks the same'
      : 'a long-running command looks the same';
  return {
    activity: 'waiting_permission',
    evidence: `possibly waiting for permission: ${call.tool.name} tool_use without tool_result for ${secs(openMs)} and no newer line (threshold ${secs(thr)}; ${caveat})`,
  };
}

/** Apply the time-based heuristics: possible permission waits, idle, and gone. */
export function tickLive(state: LiveState, now: number): LiveUpdate {
  const windowMs = state.activeWindowSec * 1000;
  const exited = (s: LiveAgentState): boolean => state.registry[s.agent.sessionId]?.alive === false;
  const expired = new Set(
    Object.values(state.agents)
      .filter((s) => now - s.lastLineMs > windowMs || exited(s))
      .map((s) => s.agent.key),
  );
  // Keep a parent while any of its children is still active (unless its process exited).
  for (const s of Object.values(state.agents)) {
    const p = s.agent.parentKey;
    const parent = p ? state.agents[p] : undefined;
    if (p && parent && !expired.has(s.agent.key) && !exited(parent)) expired.delete(p);
  }
  const agents: Record<string, LiveAgentState> = {};
  const changed: LiveAgent[] = [];
  const gone: string[] = [];
  for (const [k, s] of Object.entries(state.agents)) {
    if (expired.has(k)) {
      gone.push(k);
      continue;
    }
    const quietMs = now - s.lastLineMs;
    const a = s.agent.activity;
    const reg = s.agent.agentKind === 'main' ? state.registry[s.agent.sessionId] : undefined;
    let next: Verdict;
    if (
      quietMs > LIVE_THRESHOLDS.idleMs &&
      a !== 'idle' &&
      a !== 'done' &&
      reg?.status !== 'waiting'
    ) {
      next = {
        activity: 'idle',
        evidence: `no transcript line for ${Math.floor(quietMs / 60_000)} min`,
      };
    } else next = permissionVerdict(s, reg, now);
    if (!next) {
      agents[k] = s;
      continue;
    }
    const c = clone(s);
    if (next === 'note') {
      const call = c.open[c.open.length - 1]!;
      c.suppressedCallId = call.callId;
      c.agent.evidence = `${call.tool.name} tool_use open ${secs(now - call.startedMs)} with no newer line; not flagged as a permission wait because the last ${c.recentDecisions.length} calls were auto-approved${c.permissionMode ? ` (permissionMode ${c.permissionMode})` : ''}`;
    } else {
      if (next.activity === 'waiting_permission' && c.open.length > 0) {
        c.guessedCallId = c.open[c.open.length - 1]!.callId;
      }
      setActivity(c, next.activity, next.evidence, now);
    }
    agents[k] = c;
    changed.push(c.agent);
  }
  return { state: { ...state, agents }, changed, gone };
}

/** Agents for a snapshot, parents before children, then by key. */
export function liveAgents(state: LiveState): LiveAgent[] {
  return Object.values(state.agents)
    .map((s) => s.agent)
    .sort(
      (a, b) =>
        Number(a.agentKind === 'subagent') - Number(b.agentKind === 'subagent') ||
        a.key.localeCompare(b.key),
    );
}
