/**
 * Normalized trace schema. Source of truth; documented in docs/schema.md.
 * Any change here must update docs/schema.md and the SQLite migration in packages/ingest.
 */

export type ID = string;
/** ISO-8601 timestamp. */
export type ISO = string;

declare const redactedBrand: unique symbol;
/**
 * Text that has passed through the ingestion redactor. Only packages/ingest/src/redact may
 * create values of this type (enforced by lint). Store write APIs accept only this type for
 * free-form text, so unredacted text cannot reach the database by accident.
 */
export type RedactedText = string & { readonly [redactedBrand]: true };

export const LOOP_TIERS = ['agent', 'verification', 'application', 'hill_climbing'] as const;
export type LoopTier = (typeof LOOP_TIERS)[number];

export interface Source {
  id: ID;
  adapter: string;
  root: RedactedText;
  adapterVersion: string;
}

export type DefinitionScope = 'user' | 'project' | 'plugin' | 'builtin';

export interface Agent {
  id: ID;
  /** 'main' for the main thread, else the subagent type (e.g. 'Explore', 'test-writer'). */
  name: string;
  kind: 'main' | 'subagent';
  definition?: {
    scope: DefinitionScope;
    path?: RedactedText;
    description?: RedactedText;
    tools?: string[];
    model?: string;
    contentHash: string;
  };
  firstSeenAt: ISO;
  lastSeenAt: ISO;
}

/** A bed: one lineage of harness versions, keyed by project root. */
export interface HarnessFamily {
  id: ID;
  name: string;
  projectRoot: RedactedText;
}

export interface HarnessBundle {
  model?: string;
  effort?: string;
  permissionMode?: string;
  entrypoint?: string;
  /** CLAUDE.md chain (user, project, nested). Content is never stored, only hashes and sizes. */
  instructions: { path: RedactedText; hash: string; bytes: number }[];
  tools: string[];
  skills: ID[];
  subagents: ID[];
  mcpServers: string[];
  /** Hook commands are stored as hashes only. */
  hooks: { event: string; matcher?: string; commandHash: string }[];
  settingsHash?: string;
}

export interface HarnessDiff {
  modelChanged?: { from?: string; to?: string };
  effortChanged?: { from?: string; to?: string };
  permissionModeChanged?: { from?: string; to?: string };
  toolsAdded: string[];
  toolsRemoved: string[];
  skillsAdded: ID[];
  skillsRemoved: ID[];
  mcpAdded: string[];
  mcpRemoved: string[];
  hooksChanged: boolean;
  /** Merged settings changed (hash differs). Detail is not stored: settings may hold secrets. */
  settingsChanged: boolean;
  instructionBytesDelta: number;
}

/** A season of a bed. */
export interface HarnessVersion {
  id: ID;
  familyId: ID;
  validFrom: ISO;
  validTo?: ISO;
  provenance: 'git' | 'observed' | 'snapshot';
  bundle: HarnessBundle;
  commit?: { sha: string; message: RedactedText };
  diffFromPrevious?: HarnessDiff;
}

export interface Skill {
  id: ID;
  /** Canonical identifier: frontmatter `name` (falls back to dirName). */
  name: string;
  dirName: string;
  scope: Exclude<DefinitionScope, 'builtin'>;
  path: RedactedText;
  description?: RedactedText;
  contentHash: string;
}

export type GateSpec =
  | { kind: 'step_success' }
  | { kind: 'tests_pass' }
  | { kind: 'command_ok'; pattern: string }
  | { kind: 'manual' };

export interface Playbook {
  id: ID;
  name: string;
  source: 'garden.yaml';
  steps: { id: string; skillId?: ID; agentId?: ID; gate: GateSpec }[];
}

export type LoopTriggerKind =
  'hook' | 'cron' | 'loop_skill' | 'headless_repeat' | 'stop_continuation' | 'declared';

export interface Loop {
  id: ID;
  name: string;
  tier: LoopTier;
  provenance: 'declared' | 'config' | 'inferred';
  trigger: { kind: LoopTriggerKind; detail: RedactedText };
  expectedIntervalSec?: number;
  targets: { agentIds: ID[]; familyIds: ID[] };
}

export interface Session {
  id: ID;
  sourceId: ID;
  familyId: ID;
  path: RedactedText;
  cliVersion?: string;
  entrypoint?: string;
  gitBranch?: string;
  startedAt: ISO;
  endedAt: ISO;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** Subset of output, when reported. */
  thinking?: number;
}

export const ZERO_USAGE: Readonly<TokenUsage> = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  thinking: 0,
});

export interface Run {
  id: ID;
  sessionId: ID;
  agentId: ID;
  familyId: ID;
  harnessVersionId: ID;
  parentRunId?: ID;
  parentStepId?: ID;
  loopId?: ID;
  startedAt: ISO;
  endedAt: ISO;
  trigger: 'human' | 'automated' | 'subagent';
  /** First prompt, redacted then truncated. */
  taskPreview: RedactedText;
  models: string[];
  /** Deduped by API message id. */
  tokens: TokenUsage;
  /**
   * 'output_estimated': the source only had stream-start usage snapshots, so tokens.output is a
   * lower-bound estimate from visible output length. The UI must label costs from such runs.
   */
  tokenQuality: 'reported' | 'output_estimated';
  stepCount: number;
  toolCallCount: number;
  errorCount: number;
  compactionCount: number;
  peakContextTokens: number;
}

export const STEP_KINDS = [
  'user_message',
  'assistant_message',
  'thinking',
  'tool_call',
  'tool_result',
  'subagent_spawn',
  'subagent_return',
  'compaction',
  'error',
  'hook',
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export type ToolCategory = 'builtin' | 'mcp' | 'skill' | 'subagent';

export interface Step {
  id: ID;
  runId: ID;
  seq: number;
  at: ISO;
  kind: StepKind;
  loopTier: LoopTier;
  /** Redacted, truncated. Thinking steps keep only a length marker. */
  preview?: RedactedText;
  tool?: {
    name: string;
    callId: string;
    category: ToolCategory;
    mcpServer?: string;
    skillId?: ID;
    isError?: boolean;
  };
  apiMessageId?: string;
  /** Present only on the first step of each API message, so sums are dedupe-safe. */
  tokens?: TokenUsage;
  /** Prompt size (input + cache read + cache write) for this API call. */
  contextTokens?: number;
  error?: { kind: 'tool' | 'api' | 'hook_block' | 'interrupt'; message: RedactedText };
  compaction?: { trigger: 'auto' | 'manual'; preTokens?: number };
  childRunId?: ID;
}

export const OUTCOME_LABELS = ['success', 'partial', 'failure', 'unknown'] as const;
export type OutcomeLabel = (typeof OUTCOME_LABELS)[number];

export interface OutcomeSignalResult {
  id: string;
  /** null = signal not applicable to this run. */
  fired: boolean | null;
  weight: number;
  detail: string;
}

export interface Outcome {
  runId: ID;
  label: OutcomeLabel;
  score: number | null;
  source: 'heuristic' | 'manual';
  heuristicVersion: string;
  signals: OutcomeSignalResult[];
  manual?: { label: OutcomeLabel; note?: RedactedText; at: ISO };
}

// ---------------------------------------------------------------------------------------------
// Knowledge map (milestone K). Where a run's instructions and memory come from. Content is never
// stored: only paths, sizes, hashes, and derived facts. Formats: docs/sources.md "Knowledge sources".
// ---------------------------------------------------------------------------------------------

export const KNOWLEDGE_KINDS = [
  'managed_claude_md',
  'user_claude_md',
  'project_claude_md',
  'local_claude_md',
  'nested_claude_md',
  'rule',
  'import',
  'memory_index',
  'memory_topic',
  'referenced_doc',
  'skill',
  'agent_definition',
] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export type KnowledgeScope = 'managed' | 'user' | 'project' | 'local' | 'memory' | 'plugin';

/**
 * always: in the session prompt of every session. on_demand: loaded when the agent reads it,
 * invokes it, or works in its directory. path_scoped: a rule with `paths` globs, loaded when a
 * matching file is touched. not_loaded: present on disk but never reaches the model (reason given).
 */
export const KNOWLEDGE_LOAD_MODES = ['always', 'on_demand', 'path_scoped', 'not_loaded'] as const;
export type KnowledgeLoadMode = (typeof KNOWLEDGE_LOAD_MODES)[number];

/** Layer of the always-loaded stack a source belongs to (soil strata), top to bottom. */
export const KNOWLEDGE_LAYERS = [
  'managed',
  'user',
  'project',
  'local',
  'rules',
  'imports',
  'memory',
  'listings',
] as const;
export type KnowledgeLayer = (typeof KNOWLEDGE_LAYERS)[number];

export interface KnowledgeSource {
  /** stableId('ks', familyId, kind, path). */
  id: ID;
  familyId: ID;
  kind: KnowledgeKind;
  scope: KnowledgeScope;
  /** Absolute path, redacted. */
  path: RedactedText;
  /** Short path for display: relative to the bed root, `~/.claude/…`, or `memory/…`. */
  displayPath: RedactedText;
  /** Skill or agent name (kinds skill / agent_definition). */
  name?: string;
  bytes: number;
  lines: number;
  /**
   * Bytes that reach the model in every session: the whole file for `always` sources, the
   * listing line (name + capped description) for skills and agents, the capped part of MEMORY.md.
   */
  alwaysBytes: number;
  loadMode: KnowledgeLoadMode;
  /** Why a source is not_loaded, or what loads an on_demand one. Generated text. */
  loadNote?: RedactedText;
  /** Import hops from the file that started the chain (imports only). */
  importDepth?: number;
  /** `paths` globs of a path-scoped rule. */
  globs?: RedactedText[];
  /** Memory topic `type` frontmatter (user | feedback | project | reference), when present. */
  memoryType?: string;
  /** sha256 of the file content. */
  contentHash: string;
  /** Keyed hashes (per-install HMAC) of normalized passages: duplicate detection without text. */
  passageHashes: string[];
  /** Last change: the last git commit touching the file, else its mtime. */
  lastChangedAt?: ISO;
  changedVia?: 'git' | 'mtime';
}

export type KnowledgeEdgeKind = 'import' | 'index_link' | 'mention';

export interface KnowledgeEdge {
  /** stableId('ke', fromId, kind, target). */
  id: ID;
  familyId: ID;
  fromId: ID;
  /** Target source when resolved. */
  toId?: ID;
  kind: KnowledgeEdgeKind;
  /** The reference as written (redacted), e.g. `@docs/api.md` or `feedback_testing.md`. */
  target: RedactedText;
  resolved: boolean;
  /** The reference sits past MEMORY.md's load cap, so the agent never sees the pointer. */
  beyondCap: boolean;
  /** Why it did not resolve or load. Generated text. */
  reason?: RedactedText;
}

/** Always-loaded bytes per layer at one point in time (a git commit, or the current scan). */
export interface KnowledgeSnapshot {
  familyId: ID;
  at: ISO;
  commitSha?: string;
  /** git: project layers as committed (user-level files are not versioned). current: every layer, now. */
  provenance: 'git' | 'current';
  layers: Partial<Record<KnowledgeLayer, number>>;
}

export type KnowledgeUsageKind = 'session_load' | 'nested_load' | 'memory_recall' | 'read';

/** Evidence from one session that a knowledge file reached the model. */
export interface KnowledgeUsage {
  sessionId: ID;
  familyId: ID;
  /** Absolute path as recorded in the transcript, redacted (joins KnowledgeSource.path). */
  path: RedactedText;
  kind: KnowledgeUsageKind;
  count: number;
  firstAt: ISO;
  lastAt: ISO;
}

/** One knowledge scan of a bed (its current files). */
export interface KnowledgeScan {
  familyId: ID;
  scannedAt: ISO;
  /** Auto-memory directory for this bed, redacted. */
  memoryDir?: RedactedText;
  /** `projects[root].hasClaudeMdExternalIncludesApproved` from ~/.claude.json (the only key read for this). */
  externalImportsApproved: boolean;
  warnings: RedactedText[];
}
