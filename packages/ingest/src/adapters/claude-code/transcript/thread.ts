/**
 * Turns the lines of one thread (the main thread, or one subagent) into runs and steps.
 * Main thread: a run per human (or automated-origin) prompt. Subagent: exactly one run.
 */
import type { ToolCategory } from '@garden/core';
import {
  SUBAGENT_TOOL_NAMES,
  type ObservedHarness,
  type ParsedRun,
  type ParsedStep,
} from '../contracts';
import { classifyTier } from '../outcomes';
import { isSensitivePath } from '../../../redact';
import { stableId } from '../../../ids';
import type { SessionContext } from './context';
import { HarnessTracker, mcpServerOf } from './harness';
import {
  AssistantMessageSchema,
  AttachmentSchema,
  BlockSchema,
  CompactMetadataSchema,
  ToolUseResultAgentSchema,
  UserMessageSchema,
  type Block,
  type Line,
} from './schema';
import {
  WITHHELD_PREVIEW,
  addUsage,
  blockContentText,
  cap,
  compactJson,
  contextTokensOf,
  inputString,
  isInjectedText,
  isInterruptText,
  scrubSensitiveInput,
  toTokenUsage,
  zeroUsage,
} from './text';

const SUBAGENT_TOOLS: readonly string[] = SUBAGENT_TOOL_NAMES;
const SYNTHETIC_MODEL = '<synthetic>';
const KNOWN_BLOCK_TYPES = new Set([
  'thinking',
  'redacted_thinking',
  'text',
  'tool_use',
  'tool_result',
  'image',
]);
/** Older CC versions put `agentId: <id>` in the Agent/Task tool result text. */
const AGENT_ID_IN_TEXT = /agentId:\s*([A-Za-z0-9_-]+)/;

interface CallInfo {
  name: string;
  category: ToolCategory;
  mcpServer?: string;
  skillName?: string;
  command?: string;
  filePath?: string;
  subagentType?: string;
  sensitive: boolean;
}

type StepInput = Omit<ParsedStep, 'id' | 'seq' | 'loopTier' | 'at'>;

class RunBuilder {
  readonly steps: ParsedStep[] = [];
  readonly models: string[] = [];
  observed: ObservedHarness;
  observedFromAssistant = false;
  hasAssistantActivity = false;
  lastStopReason?: string;
  interrupted = false;
  endedAt: string;

  constructor(
    private readonly ctx: SessionContext,
    private readonly threadKey: string,
    readonly id: string,
    readonly init: Pick<
      ParsedRun,
      'agentName' | 'kind' | 'trigger' | 'cwd' | 'gitBranch' | 'startedAt' | 'taskText'
    >,
    observed: ObservedHarness,
    readonly provisional = false,
  ) {
    this.observed = observed;
    this.endedAt = init.startedAt;
  }

  touch(ts: string | undefined): void {
    if (ts) this.endedAt = ts;
  }

  addModel(model: string): void {
    if (!this.models.includes(model)) this.models.push(model);
  }

  addStep(uuid: string, blockIndex: number, at: string, input: StepInput): ParsedStep {
    const step: ParsedStep = {
      id: stableId('stp', this.ctx.rawSessionId, this.threadKey, uuid, blockIndex),
      seq: this.steps.length,
      at,
      loopTier: 'agent',
      ...input,
    };
    step.loopTier = classifyTier({ kind: step.kind, tool: step.tool, raw: step.raw });
    this.steps.push(step);
    this.touch(at || undefined);
    return step;
  }

  build(): ParsedRun {
    const tokens = zeroUsage();
    let toolCallCount = 0;
    let errorCount = 0;
    let compactionCount = 0;
    let peakContextTokens = 0;
    for (const s of this.steps) {
      if (s.tokens) addUsage(tokens, s.tokens);
      if (s.kind === 'tool_call' || s.kind === 'subagent_spawn') toolCallCount++;
      if (s.error) errorCount++;
      if (s.kind === 'compaction') compactionCount++;
      if (s.contextTokens !== undefined && s.contextTokens > peakContextTokens) {
        peakContextTokens = s.contextTokens;
      }
    }
    const run: ParsedRun = {
      id: this.id,
      sessionId: this.ctx.sesId,
      agentName: this.init.agentName,
      kind: this.init.kind,
      trigger: this.init.trigger,
      cwd: this.init.cwd,
      startedAt: this.init.startedAt,
      endedAt: this.endedAt,
      taskText: this.init.taskText,
      models: this.models,
      tokens,
      stepCount: this.steps.length,
      toolCallCount,
      errorCount,
      compactionCount,
      peakContextTokens,
      observed: this.observed,
      steps: this.steps,
      interrupted: this.interrupted,
    };
    if (this.init.gitBranch) run.gitBranch = this.init.gitBranch;
    if (this.lastStopReason) run.finalStopReason = this.lastStopReason;
    return run;
  }
}

export class ThreadParser {
  private readonly builders: RunBuilder[] = [];
  private current?: RunBuilder;
  private readonly tracker = new HarnessTracker();
  private readonly calls = new Map<string, CallInfo>();
  private lastAt = '';
  private lineNo = 0;

  /**
   * @param threadKey 'main', the agentId, or a synthetic key for inline sidechains without one.
   * @param subagentRunId required in subagent mode.
   */
  constructor(
    private readonly ctx: SessionContext,
    readonly mode: 'main' | 'subagent',
    readonly threadKey: string,
    private readonly subagentRunId?: string,
  ) {}

  feed(line: Line, lineNo: number): void {
    this.lineNo = lineNo;
    if (line.timestamp) this.lastAt = line.timestamp;
    if (line.version) this.tracker.cliVersion = line.version;
    if (line.entrypoint) this.tracker.entrypoint = line.entrypoint;
    if (line.permissionMode) this.tracker.permissionMode = line.permissionMode;

    switch (line.type) {
      case 'user':
        this.onUser(line);
        break;
      case 'assistant':
        this.onAssistant(line);
        break;
      case 'attachment':
        this.onAttachment(line);
        break;
      case 'system':
        this.onSystem(line);
        break;
      default:
        break;
    }
    if (this.current && line.timestamp) this.current.touch(line.timestamp);
  }

  finish(): ParsedRun[] {
    return this.builders
      .filter((b) => !b.provisional || b.hasAssistantActivity)
      .map((b) => b.build());
  }

  // -------------------------------------------------------------------------------------------

  private uuidOf(line: Line): string {
    return line.uuid ?? `line:${this.lineNo}`;
  }

  private startRun(
    line: Line,
    id: string,
    trigger: ParsedRun['trigger'],
    taskText: string,
    provisional = false,
  ): RunBuilder {
    const b = new RunBuilder(
      this.ctx,
      this.threadKey,
      id,
      {
        agentName: this.mode === 'main' ? 'main' : 'unknown-subagent',
        kind: this.mode === 'main' ? 'main' : 'subagent',
        trigger,
        cwd: line.cwd ?? this.ctx.firstCwd ?? '',
        gitBranch: line.gitBranch ?? this.ctx.firstGitBranch,
        startedAt: line.timestamp ?? this.lastAt,
        taskText,
      },
      this.tracker.snapshot(),
      provisional,
    );
    this.builders.push(b);
    this.current = b;
    return b;
  }

  /** The run that non-prompt activity belongs to; creates one if there is none yet. */
  private ensureRun(line: Line, taskText = ''): RunBuilder {
    if (this.current) return this.current;
    if (this.mode === 'subagent') {
      return this.startRun(line, this.subagentRunId ?? '', 'subagent', taskText);
    }
    // Activity before any prompt (headless/automated sessions): provisional automated run, kept
    // only if it contains assistant activity.
    const id = stableId('run', this.ctx.rawSessionId, this.uuidOf(line));
    return this.startRun(line, id, 'automated', taskText, true);
  }

  private parseBlocks(content: unknown[]): Block[] {
    const out: Block[] = [];
    for (const raw of content) {
      const r = BlockSchema.safeParse(raw);
      const block: Block = r.success ? r.data : { type: '(invalid)' };
      this.ctx.count(`block.type=${block.type}`);
      if (!KNOWN_BLOCK_TYPES.has(block.type))
        this.ctx.unknown(`block.type=${block.type} (unknown)`);
      out.push(block);
    }
    return out;
  }

  private onAttachment(line: Line): void {
    const r = AttachmentSchema.safeParse(line.attachment);
    if (!r.success) return;
    const a = r.data;
    switch (a.type) {
      case 'skill_listing':
        if (a.names) this.tracker.setSkills(a.names, a.isInitial === true);
        break;
      case 'deferred_tools_delta':
        this.tracker.addTools(a.addedNames, a.removedNames);
        break;
      case 'agent_listing_delta':
        this.tracker.updateSubagentTypes(a.addedTypes, a.removedTypes, a.isInitial === true);
        break;
      case 'mcp_instructions_delta':
        this.tracker.updateMcpServers(a.addedNames, a.removedNames);
        break;
      case 'model':
        if (a.identity?.modelId) this.tracker.model = a.identity.modelId;
        break;
      default:
        break;
    }
  }

  private onUser(line: Line): void {
    if (line.isCompactSummary) return; // summary injected after compaction: not a prompt
    const msg = UserMessageSchema.safeParse(line.message);
    const content = msg.success ? msg.data.content : [];
    const blocks: Block[] =
      typeof content === 'string' ? [{ type: 'text', text: content }] : this.parseBlocks(content);
    const uuid = this.uuidOf(line);
    const at = line.timestamp ?? this.lastAt;

    if (!blocks.some((b) => b.type === 'tool_result')) {
      const text = blocks
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');
      if (isInterruptText(text)) {
        this.addInterrupt(this.ensureRun(line), uuid, 0, at, text);
        return;
      }
      const isPrompt = !line.isMeta && text.trim().length > 0 && !isInjectedText(text);
      if (!isPrompt) return; // meta or harness-injected text: not a run boundary, no step
      let run: RunBuilder;
      if (this.mode === 'main') {
        const kind = line.origin?.kind;
        const trigger = kind === undefined || kind === 'human' ? 'human' : 'automated';
        run = this.startRun(line, stableId('run', this.ctx.rawSessionId, uuid), trigger, cap(text));
      } else {
        run = this.ensureRun(line, cap(text));
        if (!run.init.taskText) run.init.taskText = cap(text);
      }
      run.addStep(uuid, 0, at, { kind: 'user_message', preview: cap(text), raw: {} });
      return;
    }

    const run = this.ensureRun(line);
    const resultCount = blocks.filter((b) => b.type === 'tool_result').length;
    blocks.forEach((b, i) => {
      if (b.type === 'tool_result') this.addToolResult(run, line, uuid, i, at, b, resultCount);
      else if (b.type === 'text' && b.text && isInterruptText(b.text)) {
        this.addInterrupt(run, uuid, i, at, b.text);
      }
    });
  }

  private addInterrupt(run: RunBuilder, uuid: string, i: number, at: string, text: string): void {
    run.interrupted = true;
    run.addStep(uuid, i, at, {
      kind: 'error',
      preview: cap(text),
      error: { kind: 'interrupt', message: cap(text) },
      raw: {},
    });
  }

  private addToolResult(
    run: RunBuilder,
    line: Line,
    uuid: string,
    i: number,
    at: string,
    b: Block,
    resultCount: number,
  ): void {
    const callId = b.tool_use_id ?? `${uuid}:${i}`;
    const call = this.calls.get(callId);
    if (!call) this.ctx.unknown('tool_result without matching tool_use');
    let text = blockContentText(b.content);
    if (!text && typeof line.toolUseResult === 'string') text = line.toolUseResult;
    const isError = b.is_error === true;
    const preview = call?.sensitive ? WITHHELD_PREVIEW : cap(text);
    const tool: NonNullable<ParsedStep['tool']> = {
      name: call?.name ?? '(unknown)',
      callId,
      category: call?.category ?? 'builtin',
      isError,
    };
    if (call?.mcpServer) tool.mcpServer = call.mcpServer;
    if (call?.skillName) tool.skillName = call.skillName;
    const step: StepInput = { kind: 'tool_result', preview, tool, raw: { answersCallId: callId } };
    if (call?.command) step.raw.command = call.command;
    if (call?.filePath) step.raw.filePath = call.filePath;
    if (call?.subagentType) step.raw.subagentType = call.subagentType;
    if (isError) step.error = { kind: 'tool', message: preview };
    run.addStep(uuid, i, at, step);

    if (call?.category === 'subagent') {
      let agentId: string | undefined;
      if (resultCount === 1) {
        const r = ToolUseResultAgentSchema.safeParse(line.toolUseResult);
        if (r.success) agentId = r.data.agentId;
      }
      agentId ??= AGENT_ID_IN_TEXT.exec(text)?.[1];
      if (agentId) this.ctx.agentIdByCallId.set(callId, agentId);
    }
  }

  private onAssistant(line: Line): void {
    const parsed = AssistantMessageSchema.safeParse(line.message);
    if (!parsed.success) {
      this.ctx.unknown('assistant.message (invalid)');
      return;
    }
    const msg = parsed.data;
    const run = this.ensureRun(line);
    run.hasAssistantActivity = true;
    const model = msg.model && msg.model !== SYNTHETIC_MODEL ? msg.model : undefined;
    if (model) this.tracker.model = model;
    if (line.effort) this.tracker.effort = line.effort;
    if (!run.observedFromAssistant) {
      run.observed = this.tracker.snapshot();
      run.observedFromAssistant = true;
    }
    if (model) run.addModel(model);
    const stopReason = msg.stop_reason ?? undefined;
    if (stopReason) run.lastStopReason = stopReason;

    const uuid = this.uuidOf(line);
    const at = line.timestamp ?? this.lastAt;
    const blocks = this.parseBlocks(msg.content);
    let usageAttached = false;
    const base = (): StepInput => {
      const s: StepInput = { kind: 'assistant_message', raw: {} };
      if (msg.id) s.apiMessageId = msg.id;
      if (model) s.model = model;
      if (stopReason) s.raw.stopReason = stopReason;
      if (!usageAttached && msg.usage && msg.id && !this.ctx.seenMessageIds.has(msg.id)) {
        s.tokens = toTokenUsage(msg.usage);
        s.contextTokens = contextTokensOf(msg.usage);
        this.ctx.seenMessageIds.add(msg.id);
        usageAttached = true;
      }
      return s;
    };

    const isApiError =
      line.isApiErrorMessage === true || (line.error !== undefined && line.error !== null);
    if (isApiError) {
      const text =
        blocks
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text)
          .join('\n') || (typeof line.error === 'string' ? line.error : compactJson(line.error));
      run.addStep(uuid, 0, at, {
        ...base(),
        kind: 'error',
        preview: cap(text),
        error: { kind: 'api', message: cap(text) },
      });
      return;
    }

    blocks.forEach((b, i) => {
      if (b.type === 'thinking' || b.type === 'redacted_thinking') {
        const preview =
          b.type === 'thinking'
            ? `[thinking: ${(b.thinking ?? '').length} chars]`
            : '[thinking: redacted]';
        run.addStep(uuid, i, at, { ...base(), kind: 'thinking', preview });
      } else if (b.type === 'text') {
        run.addStep(uuid, i, at, {
          ...base(),
          kind: 'assistant_message',
          preview: cap(b.text ?? ''),
        });
      } else if (b.type === 'tool_use') {
        this.addToolCall(run, uuid, i, at, b, base());
      }
    });
  }

  private addToolCall(
    run: RunBuilder,
    uuid: string,
    i: number,
    at: string,
    b: Block,
    s: StepInput,
  ): void {
    const name = b.name ?? '(unknown)';
    const callId = b.id ?? `${uuid}:${i}`;
    const input = b.input;
    const mcpServer = mcpServerOf(name);
    const isSpawn = SUBAGENT_TOOLS.includes(name);
    const category: ToolCategory = mcpServer
      ? 'mcp'
      : name === 'Skill'
        ? 'skill'
        : isSpawn
          ? 'subagent'
          : 'builtin';
    const skillName =
      category === 'skill' ? inputString(input, 'skill', 'name', 'command') : undefined;
    const command = name === 'Bash' ? inputString(input, 'command') : undefined;
    const filePath = inputString(input, 'file_path', 'notebook_path', 'path');
    const sensitive = filePath !== undefined && isSensitivePath(filePath);

    s.kind = isSpawn ? 'subagent_spawn' : 'tool_call';
    s.preview = cap(compactJson(sensitive ? scrubSensitiveInput(input) : input));
    s.tool = { name, callId, category };
    if (mcpServer) s.tool.mcpServer = mcpServer;
    if (skillName) s.tool.skillName = skillName;
    if (command) s.raw.command = command;
    if (filePath) s.raw.filePath = filePath;
    if (isSpawn) {
      const subagentType = inputString(input, 'subagent_type');
      const prompt = inputString(input, 'prompt');
      if (subagentType) s.raw.subagentType = subagentType;
      if (prompt) s.raw.subagentPrompt = cap(prompt);
    }
    const step = run.addStep(uuid, i, at, s);
    const info: CallInfo = { name, category, sensitive };
    if (mcpServer) info.mcpServer = mcpServer;
    if (skillName) info.skillName = skillName;
    if (command) info.command = command;
    if (filePath) info.filePath = filePath;
    if (s.raw.subagentType) info.subagentType = s.raw.subagentType;
    this.calls.set(callId, info);
    if (isSpawn) this.ctx.spawns.set(callId, { step, runId: run.id, linked: false });
  }

  private onSystem(line: Line): void {
    const subtype = line.subtype ?? '';
    const uuid = this.uuidOf(line);
    const at = line.timestamp ?? this.lastAt;
    if (subtype === 'compact_boundary') {
      const run = this.ensureRun(line);
      const meta = CompactMetadataSchema.safeParse(line.compactMetadata);
      const trigger = meta.success && meta.data.trigger === 'manual' ? 'manual' : 'auto';
      const preTokens = meta.success ? meta.data.preTokens : undefined;
      const compaction: ParsedStep['compaction'] = { trigger };
      if (preTokens !== undefined) compaction.preTokens = preTokens;
      run.addStep(uuid, 0, at, {
        kind: 'compaction',
        preview: `[compaction: ${trigger}${preTokens !== undefined ? `, ${preTokens} tokens before` : ''}]`,
        compaction,
        raw: {},
      });
    } else if (subtype.includes('hook') && this.current) {
      const n = line.hookCount;
      this.current.addStep(uuid, 0, at, {
        kind: 'hook',
        preview: `[${subtype}${n !== undefined ? `: ${n} hooks` : ''}${line.preventedContinuation ? ', prevented continuation' : ''}]`,
        raw: {},
      });
    }
  }
}
