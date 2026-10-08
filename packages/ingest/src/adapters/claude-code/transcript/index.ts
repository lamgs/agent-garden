import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { KnowledgeEvent, ParsedRun, ParsedSession } from '../contracts';
import { stableId } from '../../../ids';
import { SessionContext, type SpawnRef } from './context';
import { AgentMetaSchema, LineSchema, type AgentMeta, type Line } from './schema';
import { ThreadParser } from './thread';

export const KNOWN_LINE_TYPES = new Set([
  'user',
  'assistant',
  'attachment',
  'system',
  'queue-operation',
  'last-prompt',
  'atis-latch',
]);

/** Attachment types observed on real files (docs/sources.md). Others are reported as unknown. */
export const KNOWN_ATTACHMENT_TYPES = new Set([
  'environment',
  'model',
  'deferred_tools_delta',
  'agent_listing_delta',
  'mcp_instructions_delta',
  'skill_listing',
  'auto_mode',
  'total_tokens_reminder',
  'session_context',
  'date',
  'credential_org',
  'remote_session_change',
  'prompt_snapshot',
  'deferred_tools_record',
  'silent_turn_reminder',
  'task_reminder',
  'command_permissions',
  'queued_command',
  'edited_text_file',
  // Knowledge map (K): paths are read, content is dropped.
  'instructions',
  'nested_memory',
  'relevant_memories',
]);

export const KNOWN_SYSTEM_SUBTYPES = new Set(['compact_boundary', 'stop_hook_summary']);

const MAX_MALFORMED_WARNINGS_PER_FILE = 20;

/**
 * Stream a JSONL file and hand each valid line to `onLine`. Malformed lines become warnings.
 * Returns the file size in bytes (0 if unreadable).
 */
async function streamFile(
  path: string,
  ctx: SessionContext,
  onLine: (line: Line, lineNo: number) => void,
): Promise<number> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (e) {
    ctx.warn(`${path}: cannot read (${(e as Error).message})`);
    return 0;
  }
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let lineNo = 0;
  let malformed = 0;
  for await (const text of rl) {
    lineNo++;
    if (text.trim() === '') continue;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      malformed++;
      ctx.unknown('malformed JSON line');
      if (malformed <= MAX_MALFORMED_WARNINGS_PER_FILE) {
        ctx.warn(`${path}:${lineNo}: malformed JSON line skipped`);
      }
      continue;
    }
    const r = LineSchema.safeParse(json);
    if (!r.success) {
      ctx.unknown('non-object line');
      ctx.warn(`${path}:${lineNo}: line is not a JSON object, skipped`);
      continue;
    }
    censusLine(r.data, ctx);
    onLine(r.data, lineNo);
  }
  if (malformed > MAX_MALFORMED_WARNINGS_PER_FILE) {
    ctx.warn(`${path}: ${malformed} malformed lines in total`);
  }
  return size;
}

function censusLine(line: Line, ctx: SessionContext): void {
  ctx.count(`line.type=${line.type}`);
  if (!KNOWN_LINE_TYPES.has(line.type)) ctx.unknown(`line.type=${line.type} (unknown)`);
  if (line.version) ctx.version(line.version);
  if (line.timestamp) ctx.timestamp(line.timestamp);
  if (line.type === 'attachment') {
    const a = line.attachment;
    const t =
      typeof a === 'object' && a !== null && 'type' in a && typeof a.type === 'string'
        ? a.type
        : '(missing)';
    ctx.count(`attachment.type=${t}`);
    if (!KNOWN_ATTACHMENT_TYPES.has(t)) ctx.unknown(`attachment.type=${t} (unknown)`);
  }
  if (line.type === 'system') {
    const st = line.subtype ?? '(missing)';
    ctx.count(`system.subtype=${st}`);
    if (!KNOWN_SYSTEM_SUBTYPES.has(st)) ctx.unknown(`system.subtype=${st} (unknown)`);
  }
}

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const pathOf = (v: unknown): string | undefined =>
  isRec(v) && typeof v.path === 'string' && v.path ? v.path : undefined;

/**
 * Knowledge-usage evidence in one line: paths only. `instructions` / `nested_memory` /
 * `relevant_memories` attachments also carry file content; it is never read past `path`.
 */
export function knowledgeEvents(line: Line): KnowledgeEvent[] {
  const at = line.timestamp ?? '';
  if (!at) return [];
  const out: KnowledgeEvent[] = [];
  if (line.type === 'attachment' && isRec(line.attachment)) {
    const a = line.attachment;
    if (a.type === 'instructions' && Array.isArray(a.files)) {
      for (const f of a.files) {
        const p = pathOf(f);
        if (p) out.push({ kind: 'session_load', path: p, at });
      }
    } else if (a.type === 'nested_memory') {
      const p = pathOf(a) ?? pathOf(a.content);
      if (p) out.push({ kind: 'nested_load', path: p, at });
    } else if (a.type === 'relevant_memories' && Array.isArray(a.memories)) {
      for (const m of a.memories) {
        const p = pathOf(m);
        if (p) out.push({ kind: 'memory_recall', path: p, at });
      }
    }
  } else if (
    line.type === 'assistant' &&
    isRec(line.message) &&
    Array.isArray(line.message.content)
  ) {
    for (const b of line.message.content) {
      if (!isRec(b) || b.type !== 'tool_use' || b.name !== 'Read' || !isRec(b.input)) continue;
      const p = b.input.file_path;
      if (typeof p === 'string' && /\.md$/i.test(p)) out.push({ kind: 'read', path: p, at });
    }
  }
  return out;
}

interface SubThread {
  parser: ThreadParser;
  agentId?: string;
  meta?: AgentMeta;
}

async function listSubagentFiles(dir: string, ctx: SessionContext): Promise<string[]> {
  try {
    const names = await readdir(dir);
    return names
      .filter((n) => n.startsWith('agent-') && n.endsWith('.jsonl'))
      .sort()
      .map((n) => join(dir, n));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      ctx.warn(`${dir}: cannot list subagent transcripts (${(e as Error).message})`);
    }
    return [];
  }
}

async function readMeta(path: string, ctx: SessionContext): Promise<AgentMeta | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined; // sidecar is optional
  }
  try {
    const r = AgentMetaSchema.safeParse(JSON.parse(text));
    if (r.success) return r.data;
  } catch {
    // fall through
  }
  ctx.warn(`${path}: unreadable subagent meta`);
  return undefined;
}

/** Link each subagent run to the spawn step that started it, and name it. */
function linkSubagents(subs: { run: ParsedRun; thread: SubThread }[], ctx: SessionContext): void {
  const callIdByAgentId = new Map<string, string>();
  for (const [callId, agentId] of ctx.agentIdByCallId) callIdByAgentId.set(agentId, callId);

  const tryClaim = (callId: string | undefined): SpawnRef | undefined => {
    if (!callId) return undefined;
    const s = ctx.spawns.get(callId);
    return s && !s.linked ? s : undefined;
  };

  // Pass 1: explicit links (meta.toolUseId, agentId reported in the tool result).
  const pending: typeof subs = [];
  const link = (sub: (typeof subs)[number], spawn: SpawnRef): void => {
    spawn.linked = true;
    spawn.step.childRunId = sub.run.id;
    sub.run.parentStepId = spawn.step.id;
    sub.run.parentRunId = spawn.runId;
    sub.run.agentName =
      sub.thread.meta?.agentType ?? spawn.step.raw.subagentType ?? 'unknown-subagent';
  };
  for (const sub of subs) {
    const spawn =
      tryClaim(sub.thread.meta?.toolUseId) ??
      tryClaim(sub.thread.agentId ? callIdByAgentId.get(sub.thread.agentId) : undefined);
    if (spawn) link(sub, spawn);
    else pending.push(sub);
  }
  // Pass 2: match by prompt text (older formats without agentId in the result).
  for (const sub of pending) {
    const spawn = [...ctx.spawns.values()].find(
      (s) => !s.linked && sub.run.taskText !== '' && s.step.raw.subagentPrompt === sub.run.taskText,
    );
    if (spawn) {
      link(sub, spawn);
    } else {
      sub.run.agentName = sub.thread.meta?.agentType ?? 'unknown-subagent';
      ctx.warn(`subagent run ${sub.thread.agentId ?? sub.run.id} has no matching parent spawn`);
    }
  }
}

/**
 * Parse one session: the main transcript at `mainPath` plus its subagent transcripts in
 * `<dir>/<sessionId>/subagents/agent-*.jsonl` (with `.meta.json` sidecars). Tolerant: unknown
 * records are counted in `census.unknownFields` and reported in `warnings`, never thrown.
 */
export async function parseSession(mainPath: string): Promise<ParsedSession> {
  const rawSessionId = basename(mainPath).replace(/\.jsonl$/, '');
  const ctx = new SessionContext(rawSessionId);
  const main = new ThreadParser(ctx, 'main', 'main');
  const subagentDir = join(dirname(mainPath), rawSessionId, 'subagents');
  const subagentFiles = await listSubagentFiles(subagentDir, ctx);
  const fileAgentIds = new Set(
    subagentFiles.map((p) =>
      basename(p)
        .replace(/^agent-/, '')
        .replace(/\.jsonl$/, ''),
    ),
  );

  // Main file. Inline sidechain lines (older format) are grouped by agentId, else by block.
  const inline = new Map<string, SubThread>();
  let blockKey: string | undefined;
  const knowledge: KnowledgeEvent[] = [];
  let bytesRead = await streamFile(mainPath, ctx, (line, lineNo) => {
    knowledge.push(...knowledgeEvents(line));
    if (line.cwd && ctx.firstCwd === undefined) ctx.firstCwd = line.cwd;
    if (line.gitBranch && ctx.firstGitBranch === undefined) ctx.firstGitBranch = line.gitBranch;
    if (line.entrypoint && ctx.firstEntrypoint === undefined) {
      ctx.firstEntrypoint = line.entrypoint;
    }
    if (line.isSidechain === true) {
      let key: string;
      if (line.agentId) key = line.agentId;
      else key = blockKey ??= `sidechain:${line.uuid ?? `line:${lineNo}`}`;
      let t = inline.get(key);
      if (!t) {
        const runId = stableId('run', rawSessionId, 'agent', key);
        t = { parser: new ThreadParser(ctx, 'subagent', key, runId) };
        if (line.agentId) t.agentId = line.agentId;
        inline.set(key, t);
      }
      t.parser.feed(line, lineNo);
      return;
    }
    if (line.type === 'user' || line.type === 'assistant') blockKey = undefined;
    main.feed(line, lineNo);
  });

  // Subagent files.
  const subThreads: SubThread[] = [];
  for (const path of subagentFiles) {
    const agentId = basename(path)
      .replace(/^agent-/, '')
      .replace(/\.jsonl$/, '');
    const runId = stableId('run', rawSessionId, 'agent', agentId);
    const t: SubThread = { parser: new ThreadParser(ctx, 'subagent', agentId, runId), agentId };
    const meta = await readMeta(path.replace(/\.jsonl$/, '.meta.json'), ctx);
    if (meta) t.meta = meta;
    bytesRead += await streamFile(path, ctx, (line, lineNo) => {
      knowledge.push(...knowledgeEvents(line));
      t.parser.feed(line, lineNo);
    });
    subThreads.push(t);
  }
  for (const t of inline.values()) {
    if (t.agentId && fileAgentIds.has(t.agentId)) {
      ctx.warn(`inline sidechain for agent ${t.agentId} ignored: a subagent file exists`);
      continue;
    }
    subThreads.push(t);
  }

  const mainRuns = main.finish();
  const subs: { run: ParsedRun; thread: SubThread }[] = [];
  for (const thread of subThreads) {
    const runs = thread.parser.finish();
    if (runs.length === 0) {
      ctx.warn(`subagent ${thread.agentId ?? thread.parser.threadKey} has no records`);
      continue;
    }
    for (const run of runs) subs.push({ run, thread });
  }
  linkSubagents(subs, ctx);
  subs.sort(
    (a, b) => a.run.startedAt.localeCompare(b.run.startedAt) || a.run.id.localeCompare(b.run.id),
  );

  for (const [k, n] of Object.entries(ctx.census.unknownFields)) {
    if (k.startsWith('line.type=')) ctx.warn(`${k}: ${n} lines`);
  }
  ctx.finalizeWarnings();

  const session: ParsedSession = {
    id: ctx.sesId,
    rawSessionId,
    path: mainPath,
    cwd: ctx.firstCwd ?? '',
    startedAt: ctx.startedAt ?? '',
    endedAt: ctx.endedAt ?? '',
    runs: [...mainRuns, ...subs.map((s) => s.run)],
    census: ctx.census,
    warnings: ctx.warnings,
    bytesRead,
    knowledge,
  };
  if (ctx.lastVersion) session.cliVersion = ctx.lastVersion;
  if (ctx.firstEntrypoint) session.entrypoint = ctx.firstEntrypoint;
  if (ctx.firstGitBranch) session.gitBranch = ctx.firstGitBranch;
  return session;
}
