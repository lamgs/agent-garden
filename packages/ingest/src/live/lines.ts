/**
 * Turns parsed transcript lines into live observations. Reuses the history parser's schemas, tool
 * categorization, and text helpers so live and history agree on what a line means. Tolerant:
 * unknown record shapes are counted (shape keys only, never content) and skipped.
 */
import { SUBAGENT_TOOL_NAMES } from '../adapters/claude-code/contracts';
import {
  KNOWN_ATTACHMENT_TYPES,
  KNOWN_LINE_TYPES,
  KNOWN_SYSTEM_SUBTYPES,
} from '../adapters/claude-code/transcript';
import { mcpServerOf } from '../adapters/claude-code/transcript/harness';
import {
  AgentMetaSchema,
  AssistantMessageSchema,
  BlockSchema,
  CompactMetadataSchema,
  ToolUseResultAgentSchema,
  UserMessageSchema,
  type AgentMeta,
  type Block,
  type Line,
} from '../adapters/claude-code/transcript/schema';
import {
  blockContentText,
  compactJson,
  contextTokensOf,
  inputString,
  isInjectedText,
  isInterruptText,
} from '../adapters/claude-code/transcript/text';
import { KNOWN_BLOCK_TYPES } from '../adapters/claude-code/transcript/thread';
import { agentId as agentIdOf, familyId } from '../adapters/claude-code/harness';
import { stableId } from '../ids';
import { isSensitivePath, type Redactor } from '../redact';
import { SENSITIVE_DETAIL, livePreview, toolLabel } from './preview';
import {
  TURN_END_STOP_REASONS,
  type LiveAgentHints,
  type LiveObservation,
  type LiveToolRef,
  type PermissionDecision,
} from './types';

const SYNTHETIC_MODEL = '<synthetic>';
const SPAWN_TOOLS: readonly string[] = SUBAGENT_TOOL_NAMES;
const MAX_TRACKED_IDS = 256;

export interface LiveCensus {
  recordTypes: Record<string, number>;
  unknownFields: Record<string, number>;
}

export interface Bed {
  id: string;
  name: string;
}

/** Session-wide state shared by the main thread and its subagents. */
export interface LiveSession {
  rawSessionId: string;
  sesId: string;
  /** Project directory name under projects/ (fallback bed when no cwd has been seen). */
  projectDir: string;
  /** Spawn tool_use id → subagent_type from the parent's call. */
  spawnTypeByCallId: Map<string, string>;
  /** agentId → spawn tool_use id, from the parent's tool result. */
  callIdByAgentId: Map<string, string>;
  /** Agent ids that have their own transcript file (inline sidechain lines for them are skipped). */
  subagentFiles: Set<string>;
  /** Inline sidechain threads (older format), by agentId. */
  inline: Map<string, LiveThread>;
  /** Live threads of this session, by agent key. */
  threads: Map<string, LiveThread>;
}

export interface LiveThread {
  session: LiveSession;
  kind: 'main' | 'subagent';
  key: string;
  agentId?: string;
  meta?: AgentMeta;
  cwd?: string;
  model?: string;
  permissionMode?: string;
  seen: boolean;
  /** tool_use id → tool, for results. */
  calls: Map<string, LiveToolRef & { sensitive: boolean }>;
  /** Message ids whose turn_end was already emitted (one API message spans several lines). */
  endedMessageIds: Set<string>;
}

export function newLiveSession(rawSessionId: string, projectDir: string): LiveSession {
  return {
    rawSessionId,
    sesId: stableId('ses', rawSessionId),
    projectDir,
    spawnTypeByCallId: new Map(),
    callIdByAgentId: new Map(),
    subagentFiles: new Set(),
    inline: new Map(),
    threads: new Map(),
  };
}

export function newLiveThread(
  session: LiveSession,
  kind: 'main' | 'subagent',
  agentId?: string,
): LiveThread {
  const key = kind === 'main' ? session.sesId : `${session.sesId}:${agentId ?? 'unknown'}`;
  const t: LiveThread = {
    session,
    kind,
    key,
    seen: false,
    calls: new Map(),
    endedMessageIds: new Set(),
  };
  if (agentId) t.agentId = agentId;
  session.threads.set(key, t);
  return t;
}

export function parseAgentMeta(text: string): AgentMeta | undefined {
  try {
    const r = AgentMetaSchema.safeParse(JSON.parse(text));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

const remember = <T>(set: Set<T>, v: T): void => {
  set.add(v);
  if (set.size > MAX_TRACKED_IDS) set.delete(set.values().next().value as T);
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const ENUM_LIKE = /^[A-Za-z_-]{1,40}$/;
const enumField = (v: unknown): string | undefined =>
  typeof v === 'string' && ENUM_LIKE.test(v) ? v : undefined;

/** `permissionDecision` on a tool_result line. Only short enum-like values are kept. */
export function permissionDecisionOf(line: Line): PermissionDecision | undefined {
  const pd = (line as Record<string, unknown>).permissionDecision;
  if (!isRecord(pd)) return undefined;
  const out: PermissionDecision = {};
  const decision = enumField(pd.decision);
  const source = enumField(pd.source);
  const reasonType = enumField(pd.reasonType);
  if (decision) out.decision = decision;
  if (source) out.source = source;
  if (reasonType) out.reasonType = reasonType;
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface InterpreterOptions {
  redactor: Redactor;
  /** cwd → bed. Must match the history adapter (canonicalProjectRoot + familyId). */
  resolveBed: (cwd: string) => Bed;
  /** True when the planting exists in the history store (then `plantId` is set). */
  plantExists?: (plantId: string) => boolean;
}

export class LiveLineInterpreter {
  readonly census: LiveCensus = { recordTypes: {}, unknownFields: {} };

  constructor(private readonly opts: InterpreterOptions) {}

  private count(k: string): void {
    this.census.recordTypes[k] = (this.census.recordTypes[k] ?? 0) + 1;
  }

  unknown(k: string): void {
    this.census.unknownFields[k] = (this.census.unknownFields[k] ?? 0) + 1;
  }

  private preview(text: string): string {
    return livePreview(this.opts.redactor, text);
  }

  hints(t: LiveThread): LiveAgentHints {
    const s = t.session;
    const bed = t.cwd
      ? this.opts.resolveBed(t.cwd)
      : { id: familyId(`projects-dir:${s.projectDir}`), name: s.projectDir };
    const h: LiveAgentHints = {
      key: t.key,
      sessionId: s.sesId,
      agentKind: t.kind,
      bedId: bed.id,
      bedName: bed.name,
    };
    if (t.kind === 'main') h.agentName = 'main';
    else {
      const spawn = t.meta?.toolUseId ?? (t.agentId ? s.callIdByAgentId.get(t.agentId) : undefined);
      const name = t.meta?.agentType ?? (spawn ? s.spawnTypeByCallId.get(spawn) : undefined);
      if (name) h.agentName = name;
      if (spawn) h.spawnCallId = spawn;
      h.parentKey = s.sesId;
    }
    if (t.model) h.model = t.model;
    if (t.permissionMode) h.permissionMode = t.permissionMode;
    if (h.agentName && this.opts.plantExists) {
      const plant = stableId('plt', agentIdOf(h.agentName), bed.id);
      if (this.opts.plantExists(plant)) h.plantId = plant;
    }
    return h;
  }

  /** Census + routing of one line read from a file belonging to `fileThread`. */
  interpret(fileThread: LiveThread, line: Line, arrivalMs: number): LiveObservation[] {
    this.censusLine(line);
    let t = fileThread;
    if (fileThread.kind === 'main' && line.isSidechain === true) {
      if (!line.agentId || fileThread.session.subagentFiles.has(line.agentId)) return [];
      const s = fileThread.session;
      t = s.inline.get(line.agentId) ?? newLiveThread(s, 'subagent', line.agentId);
      s.inline.set(line.agentId, t);
    }
    if (line.cwd) t.cwd = line.cwd;
    if (line.permissionMode) t.permissionMode = line.permissionMode;
    const at =
      line.timestamp && !Number.isNaN(Date.parse(line.timestamp))
        ? line.timestamp
        : new Date(arrivalMs).toISOString();
    const out: LiveObservation[] = [];
    const body = this.lineObservations(t, line, at);
    if (!t.seen && (body.length > 0 || line.type === 'user' || line.type === 'assistant')) {
      t.seen = true;
      out.push({ event: { at, kind: 'session_seen', agentKey: t.key }, agent: this.hints(t) });
    }
    out.push(...body);
    return out;
  }

  private censusLine(line: Line): void {
    this.count(`line.type=${line.type}`);
    if (!KNOWN_LINE_TYPES.has(line.type)) this.unknown(`line.type=${line.type}`);
    if (line.type === 'attachment') {
      const a = line.attachment;
      const ty = isRecord(a) && typeof a.type === 'string' ? a.type : '(missing)';
      this.count(`attachment.type=${ty}`);
      if (!KNOWN_ATTACHMENT_TYPES.has(ty)) this.unknown(`attachment.type=${ty}`);
    }
    if (line.type === 'system') {
      const st = line.subtype ?? '(missing)';
      this.count(`system.subtype=${st}`);
      if (!KNOWN_SYSTEM_SUBTYPES.has(st)) this.unknown(`system.subtype=${st}`);
    }
  }

  private blocks(content: unknown[]): Block[] {
    return content.map((raw) => {
      const r = BlockSchema.safeParse(raw);
      const b: Block = r.success ? r.data : { type: '(invalid)' };
      this.count(`block.type=${b.type}`);
      if (!KNOWN_BLOCK_TYPES.has(b.type)) this.unknown(`block.type=${b.type}`);
      return b;
    });
  }

  private lineObservations(t: LiveThread, line: Line, at: string): LiveObservation[] {
    switch (line.type) {
      case 'user':
        return this.onUser(t, line, at);
      case 'assistant':
        return this.onAssistant(t, line, at);
      case 'system':
        return this.onSystem(t, line, at);
      case 'attachment':
        return this.onAttachment(t, line, at);
      default:
        return [];
    }
  }

  private obs(t: LiveThread, event: Omit<LiveObservation['event'], 'agentKey'>): LiveObservation {
    return { event: { ...event, agentKey: t.key }, agent: this.hints(t) };
  }

  private onUser(t: LiveThread, line: Line, at: string): LiveObservation[] {
    if (line.isCompactSummary) return [];
    const msg = UserMessageSchema.safeParse(line.message);
    const content = msg.success ? msg.data.content : [];
    const blocks: Block[] =
      typeof content === 'string' ? [{ type: 'text', text: content }] : this.blocks(content);
    const results = blocks.filter((b) => b.type === 'tool_result');
    if (results.length === 0) {
      const text = blocks
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');
      if (isInterruptText(text)) {
        return [
          { ...this.obs(t, { at, kind: 'error', preview: this.preview(text) }), interrupt: true },
        ];
      }
      if (line.isMeta || text.trim().length === 0 || isInjectedText(text)) return [];
      t.calls.clear();
      const preview = this.preview(text);
      return [{ ...this.obs(t, { at, kind: 'turn_start', preview }), detail: preview }];
    }
    const out: LiveObservation[] = [];
    for (const b of results) {
      const callId = b.tool_use_id ?? '';
      const call = t.calls.get(callId);
      if (!call) this.unknown('tool_result without tool_use in the tailed range');
      const tool: LiveToolRef = call
        ? { name: call.name, category: call.category }
        : { name: '(unknown)', category: 'builtin' };
      if (call?.mcpServer) tool.mcpServer = call.mcpServer;
      if (call?.skillName) tool.skillName = call.skillName;
      const isError = b.is_error === true;
      const ev: Omit<LiveObservation['event'], 'agentKey'> = { at, kind: 'tool_end', tool };
      if (isError) {
        ev.isError = true;
        ev.preview = call?.sensitive ? SENSITIVE_DETAIL : this.preview(blockContentText(b.content));
      }
      let childOutcome: LiveObservation['childOutcome'];
      if (call?.category === 'subagent') {
        const tur = isRecord(line.toolUseResult) ? line.toolUseResult : undefined;
        if (results.length === 1) {
          const r = ToolUseResultAgentSchema.safeParse(line.toolUseResult);
          if (r.success && r.data.agentId) t.session.callIdByAgentId.set(r.data.agentId, callId);
        }
        const async = tur?.isAsync === true || tur?.status === 'async_launched';
        if (!async) {
          ev.kind = 'subagent_end';
          childOutcome = isError ? 'errored' : 'done';
        }
      }
      const o: LiveObservation = { ...this.obs(t, ev), callId };
      if (childOutcome) o.childOutcome = childOutcome;
      const pd = permissionDecisionOf(line);
      if (pd) o.permissionDecision = pd;
      out.push(o);
      t.calls.delete(callId);
    }
    return out;
  }

  private onAssistant(t: LiveThread, line: Line, at: string): LiveObservation[] {
    const parsed = AssistantMessageSchema.safeParse(line.message);
    if (!parsed.success) {
      this.unknown('assistant.message (invalid)');
      return [];
    }
    const msg = parsed.data;
    if (msg.model && msg.model !== SYNTHETIC_MODEL) t.model = msg.model;
    const stopReason = msg.stop_reason ?? undefined;
    const blocks = this.blocks(msg.content);
    const out: LiveObservation[] = [];
    let usageTaken = false;
    const push = (
      ev: Omit<LiveObservation['event'], 'agentKey'>,
      extra: Partial<LiveObservation> = {},
    ): void => {
      if (!usageTaken && msg.usage) {
        ev.contextTokens = contextTokensOf(msg.usage);
        usageTaken = true;
      }
      const o: LiveObservation = { ...this.obs(t, ev), ...extra };
      if (msg.id) o.apiMessageId = msg.id;
      if (stopReason) o.stopReason = stopReason;
      out.push(o);
    };

    if (line.isApiErrorMessage === true || (line.error !== undefined && line.error !== null)) {
      const text =
        blocks
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text)
          .join('\n') || (typeof line.error === 'string' ? line.error : compactJson(line.error));
      push({ at, kind: 'error', isError: true, preview: this.preview(text) });
      return out;
    }
    for (const b of blocks) {
      if (b.type === 'thinking' || b.type === 'redacted_thinking') {
        push({ at, kind: 'thinking' }); // thinking text is never emitted
      } else if (b.type === 'text' && typeof b.text === 'string') {
        push({ at, kind: 'assistant_text', preview: this.preview(b.text) });
      } else if (b.type === 'tool_use') {
        const name = b.name ?? '(unknown)';
        const callId = b.id ?? '';
        const mcpServer = mcpServerOf(name);
        const isSpawn = SPAWN_TOOLS.includes(name);
        const category: LiveToolRef['category'] = mcpServer
          ? 'mcp'
          : name === 'Skill'
            ? 'skill'
            : isSpawn
              ? 'subagent'
              : 'builtin';
        const tool: LiveToolRef = { name, category };
        if (mcpServer) tool.mcpServer = mcpServer;
        if (category === 'skill') {
          const sk = inputString(b.input, 'skill', 'name', 'command');
          if (sk) tool.skillName = this.preview(sk);
        }
        const path = inputString(b.input, 'file_path', 'notebook_path', 'path');
        const sensitive = path !== undefined && isSensitivePath(path);
        t.calls.set(callId, { ...tool, sensitive });
        if (isSpawn) {
          const st = inputString(b.input, 'subagent_type');
          if (st) t.session.spawnTypeByCallId.set(callId, st);
        }
        const detail = this.preview(toolLabel(name, b.input));
        const extra: Partial<LiveObservation> = { callId, detail };
        if (isRecord(b.input) && b.input.run_in_background === true) extra.background = true;
        push({ at, kind: isSpawn ? 'subagent_start' : 'tool_start', tool, preview: detail }, extra);
      }
    }
    if (stopReason && TURN_END_STOP_REASONS.has(stopReason)) {
      const id = msg.id ?? `${line.uuid ?? at}`;
      if (!t.endedMessageIds.has(id)) {
        remember(t.endedMessageIds, id);
        push({ at, kind: 'turn_end' });
      }
    }
    return out;
  }

  private onSystem(t: LiveThread, line: Line, at: string): LiveObservation[] {
    const st = line.subtype ?? '';
    if (st === 'compact_boundary') {
      const m = CompactMetadataSchema.safeParse(line.compactMetadata);
      const trigger = m.success && m.data.trigger === 'manual' ? 'manual' : 'auto';
      const pre = m.success ? m.data.preTokens : undefined;
      return [
        this.obs(t, {
          at,
          kind: 'compaction',
          preview: `[compaction: ${trigger}${pre !== undefined ? `, ${pre} tokens before` : ''}]`,
        }),
      ];
    }
    if (st.includes('hook')) {
      const n = line.hookCount;
      return [
        this.obs(t, {
          at,
          kind: 'hook',
          preview: `[${st}${n !== undefined ? `: ${n} hooks` : ''}${line.preventedContinuation ? ', prevented continuation' : ''}]`,
        }),
      ];
    }
    return [];
  }

  /** Background subagents report completion via a `<task-notification>` queued_command. */
  private onAttachment(t: LiveThread, line: Line, at: string): LiveObservation[] {
    const a = line.attachment;
    if (!isRecord(a) || a.type !== 'queued_command') return [];
    const text = compactJson(a);
    if (!text.includes('<task-notification>')) return [];
    const callId = /<tool-use-id>([A-Za-z0-9_-]+)<\/tool-use-id>/.exec(text)?.[1];
    if (!callId) return [];
    const isChild = [...t.session.threads.values()].some(
      (c) => c.kind === 'subagent' && c.meta?.toolUseId === callId,
    );
    if (!isChild && !t.session.spawnTypeByCallId.has(callId)) return [];
    const status = /<status>([a-z_]+)<\/status>/.exec(text)?.[1] ?? 'completed';
    const failed = /fail|error|kill|cancel/.test(status);
    const o: LiveObservation = {
      ...this.obs(t, {
        at,
        kind: 'subagent_end',
        tool: { name: 'Agent', category: 'subagent' },
      }),
      callId,
      childOutcome: failed ? 'errored' : 'done',
    };
    return [o];
  }
}
