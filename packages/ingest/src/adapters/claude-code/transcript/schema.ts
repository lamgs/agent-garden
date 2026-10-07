/**
 * Lenient zod schemas for Claude Code transcript lines (shapes in docs/sources.md). Every field is
 * optional and falls back to `undefined` on a type mismatch, so one odd field never drops a line.
 */
import { z } from 'zod';

const str = z.string().optional().catch(undefined);
const num = z.number().optional().catch(undefined);
const bool = z.boolean().optional().catch(undefined);
const strList = z.array(z.string()).optional().catch(undefined);

export const LineSchema = z.looseObject({
  type: z.string().catch('(missing)'),
  uuid: str,
  sessionId: str,
  timestamp: str,
  cwd: str,
  gitBranch: str,
  version: str,
  entrypoint: str,
  isSidechain: bool,
  agentId: str,
  isMeta: bool,
  isCompactSummary: bool,
  isApiErrorMessage: bool,
  error: z.unknown().optional(),
  permissionMode: str,
  effort: str,
  subtype: str,
  origin: z.looseObject({ kind: str }).optional().catch(undefined),
  message: z.unknown().optional(),
  attachment: z.unknown().optional(),
  toolUseResult: z.unknown().optional(),
  compactMetadata: z.unknown().optional(),
  hookCount: num,
  preventedContinuation: bool,
});
export type Line = z.infer<typeof LineSchema>;

export const UsageSchema = z.looseObject({
  input_tokens: num,
  output_tokens: num,
  cache_read_input_tokens: num,
  cache_creation_input_tokens: num,
  cache_creation: z
    .looseObject({ ephemeral_5m_input_tokens: num, ephemeral_1h_input_tokens: num })
    .optional()
    .catch(undefined),
  output_tokens_details: z.looseObject({ thinking_tokens: num }).optional().catch(undefined),
});
export type Usage = z.infer<typeof UsageSchema>;

export const AssistantMessageSchema = z.looseObject({
  id: str,
  model: str,
  content: z.array(z.unknown()).catch([]),
  stop_reason: z.string().nullable().optional().catch(undefined),
  usage: UsageSchema.optional().catch(undefined),
});

export const UserMessageSchema = z.looseObject({
  content: z.union([z.string(), z.array(z.unknown())]).catch([]),
});

export const BlockSchema = z.looseObject({
  type: z.string().catch('(missing)'),
  text: str,
  thinking: str,
  id: str,
  name: str,
  input: z.unknown().optional(),
  tool_use_id: str,
  is_error: bool,
  content: z.unknown().optional(),
});
export type Block = z.infer<typeof BlockSchema>;

export const AttachmentSchema = z.looseObject({
  type: z.string().catch('(missing)'),
  names: strList,
  isInitial: bool,
  addedNames: strList,
  removedNames: strList,
  addedTypes: strList,
  removedTypes: strList,
  identity: z.looseObject({ modelId: str }).optional().catch(undefined),
});

export const CompactMetadataSchema = z.looseObject({ trigger: str, preTokens: num });

export const AgentMetaSchema = z.looseObject({
  agentType: str,
  description: str,
  toolUseId: str,
  spawnDepth: num,
});
export type AgentMeta = z.infer<typeof AgentMetaSchema>;

export const ToolUseResultAgentSchema = z.looseObject({ agentId: str });
