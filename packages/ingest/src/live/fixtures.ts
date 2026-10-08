/**
 * Test helpers: synthetic Claude Code transcript lines in the real shapes (docs/sources.md). No real
 * data; every value is made up.
 */
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

export interface LineOpts {
  at: string;
  cwd?: string;
  sessionId?: string;
  agentId?: string;
}

const base = (o: LineOpts) => ({
  uuid: uuid(),
  timestamp: o.at,
  cwd: o.cwd ?? '/work/demo-repo',
  sessionId: o.sessionId ?? 'sess-1',
  version: '2.1.293',
  ...(o.agentId ? { agentId: o.agentId, isSidechain: true } : { isSidechain: false }),
});

export const L = {
  prompt: (o: LineOpts, text: string) =>
    JSON.stringify({
      ...base(o),
      type: 'user',
      origin: { kind: 'human' },
      permissionMode: 'default',
      message: { role: 'user', content: text },
    }),
  thinking: (o: LineOpts, id: string, thinking: string, stop: string | null = 'tool_use') =>
    JSON.stringify({
      ...base(o),
      type: 'assistant',
      message: {
        id,
        model: 'claude-opus-5-5',
        role: 'assistant',
        content: [{ type: 'thinking', thinking, signature: 'sig' }],
        stop_reason: stop,
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 90,
          output_tokens: 50,
        },
      },
    }),
  text: (o: LineOpts, id: string, text: string, stop: string | null = 'end_turn', ctx = 1100) =>
    JSON.stringify({
      ...base(o),
      type: 'assistant',
      message: {
        id,
        model: 'claude-opus-5-5',
        role: 'assistant',
        content: [{ type: 'text', text }],
        stop_reason: stop,
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: ctx - 10,
          cache_creation_input_tokens: 0,
          output_tokens: 50,
        },
      },
    }),
  toolUse: (
    o: LineOpts,
    id: string,
    callId: string,
    name: string,
    input: Record<string, unknown>,
    stop: string | null = 'tool_use',
  ) =>
    JSON.stringify({
      ...base(o),
      type: 'assistant',
      message: {
        id,
        model: 'claude-opus-5-5',
        role: 'assistant',
        content: [{ type: 'tool_use', id: callId, name, input }],
        stop_reason: stop,
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 2000,
          cache_creation_input_tokens: 0,
          output_tokens: 20,
        },
      },
    }),
  toolResult: (
    o: LineOpts,
    callId: string,
    content: string,
    extra: { isError?: boolean; toolUseResult?: unknown; permissionDecision?: unknown } = {},
  ) =>
    JSON.stringify({
      ...base(o),
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: callId, content, is_error: extra.isError ?? false },
        ],
      },
      toolUseResult: extra.toolUseResult ?? { stdout: content, stderr: '' },
      ...(extra.permissionDecision ? { permissionDecision: extra.permissionDecision } : {}),
    }),
  compact: (o: LineOpts) =>
    JSON.stringify({
      ...base(o),
      type: 'system',
      subtype: 'compact_boundary',
      compactMetadata: { trigger: 'auto', preTokens: 150000 },
    }),
  apiError: (o: LineOpts, text: string) =>
    JSON.stringify({
      ...base(o),
      type: 'assistant',
      isApiErrorMessage: true,
      message: {
        id: 'msg_err',
        model: '<synthetic>',
        role: 'assistant',
        content: [{ type: 'text', text }],
        stop_reason: 'stop_sequence',
      },
    }),
  taskNotification: (o: LineOpts, callId: string, status: string) =>
    JSON.stringify({
      ...base(o),
      type: 'attachment',
      attachment: {
        type: 'queued_command',
        commandMode: 'task-notification',
        prompt: `<task-notification>\n<task-id>t1</task-id>\n<tool-use-id>${callId}</tool-use-id>\n<status>${status}</status>\n<summary>done</summary>\n</task-notification>`,
      },
    }),
  unknown: (o: LineOpts) =>
    JSON.stringify({ ...base(o), type: 'brand-new-type', payload: { a: 1 } }),
  lastPrompt: () => JSON.stringify({ type: 'last-prompt', lastPrompt: 'x', leafUuid: uuid() }),
};
