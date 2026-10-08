/**
 * Internal inputs of the live layer. A source (transcript tailer, demo player) turns raw records into
 * `LiveObservation`s; the pure reducer turns observations into `LiveAgent` state. Every string in an
 * observation is already redacted and truncated (see preview.ts): nothing here is raw transcript text.
 */
import type { LiveEvent, LiveAgent, ToolCategory } from '@garden/core';

export interface LiveToolRef {
  name: string;
  category: ToolCategory;
  mcpServer?: string;
  skillName?: string;
}

/** What the source knows about the agent an observation belongs to. */
export interface LiveAgentHints {
  key: string;
  sessionId: string;
  agentKind: 'main' | 'subagent';
  /** 'main', the subagent type, or undefined when not known yet. */
  agentName?: string;
  parentKey?: string;
  bedId: string;
  bedName: string;
  plantId?: string;
  model?: string;
  /** Subagents: the parent's spawn tool_use id (joins the child to its `subagent_end`). */
  spawnCallId?: string;
  loop?: LiveAgent['loop'];
  /** Line-level `permissionMode` (e.g. default, auto, bypassPermissions), when the line has one. */
  permissionMode?: string;
}

/** `permissionDecision` on a tool_result line (enum-like values; shapes in docs/sources.md). */
export interface PermissionDecision {
  decision?: string;
  source?: string;
  reasonType?: string;
}

/** One entry of the optional session registry (`~/.claude/sessions/<pid>.json`), main thread only. */
export interface RegistryStatus {
  /** busy | shell | idle | waiting (others kept verbatim). */
  status: string;
  waitingFor?: string;
  /** False when the process is known to have exited. */
  alive: boolean;
}

export interface LiveObservation {
  /** The event without `seq` (the hub assigns it). */
  event: Omit<LiveEvent, 'seq'>;
  agent: LiveAgentHints;
  /** tool_use id for tool_start / tool_end / subagent_start / subagent_end. */
  callId?: string;
  /** API stop_reason of the assistant message this event came from. */
  stopReason?: string;
  /** API message id: context tokens are taken once per id (CLAUDE.md dedupe rule). */
  apiMessageId?: string;
  /** Redacted short label of what the agent is doing. */
  detail?: string;
  /** subagent_end: how the child ended. */
  childOutcome?: 'done' | 'errored';
  /** error events: a user interrupt (the agent then waits for input, it did not fail). */
  interrupt?: boolean;
  /** tool_end: how the call was approved, when the line says. */
  permissionDecision?: PermissionDecision;
  /** tool_start: the call runs in the background (`run_in_background: true`), so it never blocks. */
  background?: boolean;
}

/** Heuristic thresholds (ms). Exported so the docs and tests use the same numbers. */
export const LIVE_THRESHOLDS = {
  /** tool_use without tool_result and no newer line → possibly waiting for permission. */
  permissionMs: 6_000,
  /** Same, for tools that are often legitimately slow (Bash, web). */
  slowToolPermissionMs: 30_000,
  /** No line for this long → idle. */
  idleMs: 5 * 60_000,
} as const;

/** API stop reasons that end a turn (the agent stops and hands back control). */
export const TURN_END_STOP_REASONS: ReadonlySet<string> = new Set([
  'end_turn',
  'stop_sequence',
  'max_tokens',
  'refusal',
]);

export const DEFAULT_ACTIVE_WINDOW_SEC = 30 * 60;
export const LIVE_PREVIEW_MAX = 120;
export const LIVE_RECENT_CAP = 200;
/** Context window used when the model is unknown or not in the pricing table. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
