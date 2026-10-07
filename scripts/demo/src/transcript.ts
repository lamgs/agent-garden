/**
 * Writes Claude Code transcript lines in the shapes recorded in docs/sources.md (CC 2.1.293):
 * common fields on every line, one API response split across several assistant lines (one content
 * block each) that all repeat the identical full `usage`, tool results as user lines with
 * `toolUseResult`, subagent transcripts as separate sidechain files with a `.meta.json` sidecar.
 */
import { MINUTE, type Rng, iso } from './rng';

export const CLI_VERSION = '2.1.293';

export type Line = Record<string, unknown>;

export interface Usage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  cache_creation: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number };
  output_tokens_details: { thinking_tokens: number };
  server_tool_use: { web_search_requests: number; web_fetch_requests: number };
  service_tier: 'standard';
}

export type Block =
  | { type: 'thinking'; text: string; tokens?: number }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: Record<string, unknown>; tokens?: number };

export interface WriterOptions {
  rng: Rng;
  sessionId: string;
  cwd: string;
  gitBranch: string;
  entrypoint: 'cli' | 'sdk-cli';
  model: string;
  effort: string;
  permissionMode: string;
  start: number;
  /** Prompt tokens before the first message (system prompt, CLAUDE.md chain, tool definitions). */
  baseContext: number;
  /** Part of baseContext that is usually still cached from earlier sessions. */
  sharedCached: number;
  agentId?: string;
  agentType?: string;
}

export interface SubagentFile {
  agentId: string;
  lines: Line[];
  meta: {
    agentType: string;
    description: string;
    toolUseId: string;
    spawnDepth: 1;
    requestShape: 'standard';
    requestNonInteractive: false;
  };
}

/** Rough token estimate for text written into the context. */
export const tokensOf = (s: string): number => Math.max(1, Math.round(s.length / 3.6));

export class TranscriptWriter {
  readonly lines: Line[] = [];
  readonly subagents: SubagentFile[] = [];
  /** Clock in epoch ms; every write advances it. */
  t: number;
  /** Prompt size (tokens) the next API call will send. */
  context: number;
  model: string;
  /** Prompt tokens already in the prompt cache. */
  private cached: number;
  private parent: string | null = null;
  private lastCallAt: number;
  readonly opts: WriterOptions;
  readonly rng: Rng;

  constructor(opts: WriterOptions) {
    this.opts = opts;
    this.rng = opts.rng;
    this.t = opts.start;
    this.context = opts.baseContext;
    this.cached = opts.sharedCached;
    this.model = opts.model;
    this.lastCallAt = opts.start;
  }

  get isSidechain(): boolean {
    return this.opts.agentId !== undefined;
  }

  private base(type: string): Line {
    const o: Line = {
      parentUuid: this.parent,
      isSidechain: this.isSidechain,
      userType: 'external',
      cwd: this.opts.cwd,
      sessionId: this.opts.sessionId,
      version: CLI_VERSION,
      gitBranch: this.opts.gitBranch,
      entrypoint: this.opts.entrypoint,
    };
    if (this.opts.agentId) o.agentId = this.opts.agentId;
    o.type = type;
    return o;
  }

  private push(o: Line): string {
    const uuid = this.rng.uuid();
    o.uuid = uuid;
    o.timestamp = iso(this.t);
    this.lines.push(o);
    this.parent = uuid;
    return uuid;
  }

  advance(ms: number): void {
    this.t += Math.max(1, Math.round(ms));
  }

  attachment(attachment: Record<string, unknown>): string {
    this.advance(this.rng.int(2, 40));
    return this.push({ ...this.base('attachment'), attachment });
  }

  /** A prompt line. `human` adds origin {kind:'human'}; headless prompts carry no origin. */
  prompt(text: string, human: boolean): string {
    const o: Line = { ...this.base('user'), message: { role: 'user', content: text } };
    if (human) o.origin = { kind: 'human' };
    o.permissionMode = this.opts.permissionMode;
    this.context += tokensOf(text) + 12;
    return this.push(o);
  }

  /** First line of a subagent transcript: the prompt from the parent, parentUuid null. */
  subagentPrompt(text: string): string {
    this.parent = null;
    this.context += tokensOf(text) + 12;
    return this.push({ ...this.base('user'), message: { role: 'user', content: text } });
  }

  private usageFor(outputTokens: number, thinkingTokens: number): Usage {
    const gap = this.t - this.lastCallAt;
    // Prompt-cache TTL: 1h on the main thread, 5m in subagents.
    const ttl = this.isSidechain ? 5 * MINUTE : 60 * MINUTE;
    if (gap > ttl) this.cached = Math.min(this.cached, this.opts.sharedCached);
    const prompt = this.context;
    const input = this.rng.int(1, 9);
    const read = Math.min(this.cached, prompt - input);
    const creation = Math.max(0, prompt - input - read);
    const ttl1h = this.isSidechain ? 0 : creation;
    return {
      input_tokens: input,
      cache_creation_input_tokens: creation,
      cache_read_input_tokens: read,
      output_tokens: outputTokens,
      cache_creation: {
        ephemeral_5m_input_tokens: creation - ttl1h,
        ephemeral_1h_input_tokens: ttl1h,
      },
      output_tokens_details: { thinking_tokens: thinkingTokens },
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: 'standard',
    };
  }

  /**
   * One API response, written as one line per content block. Returns the uuid of the last line
   * and the ids of any tool_use blocks.
   */
  respond(
    blocks: Block[],
    stopReason: 'tool_use' | 'end_turn' | null,
  ): { uuid: string; toolUseIds: string[] } {
    const rng = this.rng;
    // Model latency.
    this.advance(rng.int(1500, 4000) + blocks.length * rng.int(800, 6000));
    let thinking = 0;
    let output = 0;
    for (const b of blocks) {
      if (b.type === 'thinking') {
        const t = b.tokens ?? rng.int(80, 900);
        thinking += t;
        output += t;
      } else if (b.type === 'text') output += tokensOf(b.text) + rng.int(2, 12);
      else output += b.tokens ?? tokensOf(JSON.stringify(b.input)) + rng.int(20, 60);
    }
    const usage = this.usageFor(output, thinking);
    const messageId = rng.messageId();
    const requestId = rng.requestId();
    const toolUseIds: string[] = [];
    let uuid = '';
    blocks.forEach((b, i) => {
      let content: Record<string, unknown>;
      if (b.type === 'thinking') {
        content = {
          type: 'thinking',
          thinking: b.text,
          signature: rng.chars(48, 'ABCDEFabcdef0123456789+/'),
        };
      } else if (b.type === 'text') {
        content = { type: 'text', text: b.text };
      } else {
        const id = rng.toolUseId();
        toolUseIds.push(id);
        content = { type: 'tool_use', id, name: b.name, input: b.input };
      }
      const line: Line = {
        ...this.base('assistant'),
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: this.model,
          content: [content],
          stop_reason: stopReason,
          stop_sequence: null,
          usage,
        },
        requestId,
        apiBlockIndex: i,
        effort: this.opts.effort,
      };
      if (this.opts.agentType) line.attributionAgent = this.opts.agentType;
      if (i > 0) this.advance(rng.int(5, 120));
      uuid = this.push(line);
    });
    this.lastCallAt = this.t;
    // Everything up to and including this response is now cached for the next call.
    this.cached = this.context + output - thinking;
    this.context += output - thinking;
    return { uuid, toolUseIds };
  }

  /** A tool_result user line answering `toolUseId`. */
  result(
    toolUseId: string,
    sourceUuid: string,
    content: string | { type: 'text'; text: string }[],
    isError: boolean,
    toolUseResult: unknown,
    durationMs: number,
    tokens?: number,
  ): string {
    this.advance(durationMs);
    const text = typeof content === 'string' ? content : content.map((c) => c.text).join('\n');
    this.context += tokens ?? tokensOf(text) + 20;
    return this.push({
      ...this.base('user'),
      message: {
        role: 'user',
        content: [{ tool_use_id: toolUseId, type: 'tool_result', content, is_error: isError }],
      },
      toolUseResult,
      sourceToolAssistantUUID: sourceUuid,
    });
  }

  /** The user pressed Esc while the agent was working. */
  interrupt(text = '[Request interrupted by user]'): string {
    this.advance(this.rng.int(2000, 15000));
    return this.push({
      ...this.base('user'),
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
  }

  /**
   * Auto-compaction, in the hypothesized format (docs/sources.md: compact_boundary [COM]).
   * The context drops back to the base plus the summary.
   */
  compact(summary: string): void {
    const preTokens = this.context;
    this.advance(this.rng.int(20_000, 60_000));
    const logicalParent = this.parent;
    this.parent = null;
    this.push({
      ...this.base('system'),
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      isMeta: false,
      level: 'info',
      logicalParentUuid: logicalParent,
      compactMetadata: { trigger: 'auto', preTokens },
    });
    this.advance(50);
    this.context = this.opts.baseContext + tokensOf(summary);
    this.cached = this.opts.sharedCached;
    this.push({
      ...this.base('user'),
      message: { role: 'user', content: summary },
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    });
  }

  /** Spawn a sidechain writer for a subagent; the caller fills it and then calls finishSubagent. */
  child(agentType: string, model: string, baseContext: number): TranscriptWriter {
    return new TranscriptWriter({
      ...this.opts,
      start: this.t + this.rng.int(300, 1200),
      model,
      baseContext,
      sharedCached: Math.round(baseContext * 0.6),
      agentId: this.rng.agentId(),
      agentType,
    });
  }

  addSubagent(child: TranscriptWriter, description: string, toolUseId: string): void {
    this.subagents.push({
      agentId: child.opts.agentId as string,
      lines: child.lines,
      meta: {
        agentType: child.opts.agentType as string,
        description,
        toolUseId,
        spawnDepth: 1,
        requestShape: 'standard',
        requestNonInteractive: false,
      },
    });
    this.t = Math.max(this.t, child.t);
  }
}
