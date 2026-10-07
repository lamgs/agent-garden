/**
 * Internal contracts of the Claude Code adapter (M2). Workstreams code against these:
 *   transcript/  parseSession()          JSONL transcripts → ParsedSession
 *   config/      scanUserConfig() etc.   agents, skills, settings/hooks, MCP, CLAUDE.md, git history
 *   outcomes/    classifyTier(), detectSessionOutcomes()   pure functions over parsed data
 *   adapter.ts   wires them into NormalizedRecords (harness versions, families, loops)
 *
 * Everything here is PRE-redaction: plain strings, possibly containing secrets. Nothing in this
 * file is ever written to the store directly. The pipeline redacts every record first.
 */
import type {
  LoopTier,
  OutcomeSignalResult,
  StepKind,
  TokenUsage,
  ToolCategory,
} from '@garden/core';

// ---------------------------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------------------------

/** Harness state as observed in a transcript (attachments + line fields) at a point in time. */
export interface ObservedHarness {
  model?: string;
  effort?: string;
  permissionMode?: string;
  entrypoint?: string;
  cliVersion?: string;
  /** Tool names visible to the model, incl. `mcp__<server>__<tool>`. Sorted, unique. */
  tools: string[];
  /** Skill names from `skill_listing` (may be `plugin:skill`). Sorted, unique. */
  skills: string[];
  /** Subagent types from `agent_listing_delta`. Sorted, unique. */
  subagentTypes: string[];
  /** MCP server names from `mcp_instructions_delta` and `mcp__` tool prefixes. Sorted, unique. */
  mcpServers: string[];
}

export interface ParsedStep {
  /** stableId('stp', rawSessionId, agentId ?? 'main', line uuid, block index) */
  id: string;
  seq: number;
  at: string;
  kind: StepKind;
  loopTier: LoopTier;
  /** Plain text, capped at PRE_REDACTION_CAP chars (the redactor truncates further). */
  preview?: string;
  tool?: {
    name: string;
    callId: string;
    category: ToolCategory;
    mcpServer?: string;
    /** For category 'skill': the skill name from the Skill tool input. Adapter resolves to an id. */
    skillName?: string;
    isError?: boolean;
  };
  apiMessageId?: string;
  /** Only on the first step of each API message (dedupe by message.id). */
  tokens?: TokenUsage;
  contextTokens?: number;
  model?: string;
  error?: { kind: 'tool' | 'api' | 'hook_block' | 'interrupt'; message: string };
  compaction?: { trigger: 'auto' | 'manual'; preTokens?: number };
  childRunId?: string;
  /** Structured fields for detectors and tier classification. Never stored. */
  raw: {
    /** Bash command (tool_call) or the command of the call a tool_result answers. */
    command?: string;
    /** file_path / notebook_path / path argument of the call (or of the call a result answers). */
    filePath?: string;
    /** For tool_result steps: the tool_use id it answers. */
    answersCallId?: string;
    /** assistant message stop_reason, on assistant-content steps. */
    stopReason?: string;
    subagentType?: string;
    subagentPrompt?: string;
  };
}

export interface ParsedRun {
  /** Main: stableId('run', rawSessionId, uuid of the human prompt line). Subagent: stableId('run', rawSessionId, 'agent', agentId). */
  id: string;
  /** Schema session id: stableId('ses', rawSessionId). */
  sessionId: string;
  /** 'main' or the subagent type. */
  agentName: string;
  kind: 'main' | 'subagent';
  trigger: 'human' | 'automated' | 'subagent';
  parentRunId?: string;
  parentStepId?: string;
  cwd: string;
  gitBranch?: string;
  startedAt: string;
  endedAt: string;
  /** First prompt text, capped at PRE_REDACTION_CAP. */
  taskText: string;
  models: string[];
  /** Sum of step tokens (already deduped). */
  tokens: TokenUsage;
  stepCount: number;
  toolCallCount: number;
  errorCount: number;
  compactionCount: number;
  peakContextTokens: number;
  /** Harness state at run start. */
  observed: ObservedHarness;
  steps: ParsedStep[];
  /** stop_reason of the last assistant message in the run. */
  finalStopReason?: string;
  /** User interrupted the run ("[Request interrupted by user" or equivalent). */
  interrupted: boolean;
}

export interface TranscriptCensus {
  /** e.g. 'line.type=assistant', 'attachment.type=skill_listing', 'block.type=tool_use' */
  recordTypes: Record<string, number>;
  /** e.g. 'line.type=foo (unknown)', 'system.subtype=bar (unknown)' */
  unknownFields: Record<string, number>;
  /** CLI `version` field values. */
  versions: Record<string, number>;
}

export interface ParsedSession {
  /** stableId('ses', rawSessionId) */
  id: string;
  rawSessionId: string;
  /** Main transcript path. */
  path: string;
  cwd: string;
  cliVersion?: string;
  entrypoint?: string;
  gitBranch?: string;
  startedAt: string;
  endedAt: string;
  /** Main-thread runs in order, then subagent runs. */
  runs: ParsedRun[];
  census: TranscriptCensus;
  warnings: string[];
  /** Total bytes read across the main file and subagent files. */
  bytesRead: number;
}

/** Characters kept from any raw text before redaction (redaction then truncates to 2000). */
export const PRE_REDACTION_CAP = 8000;

export const SUBAGENT_TOOL_NAMES = ['Agent', 'Task'] as const;

// ---------------------------------------------------------------------------------------------
// Config (agents, skills, settings, MCP, CLAUDE.md) and git history
// ---------------------------------------------------------------------------------------------

export type ConfigScope = 'user' | 'project' | 'local' | 'plugin';

export interface InstructionFile {
  path: string;
  scope: 'user' | 'project' | 'local' | 'nested';
  bytes: number;
  hash: string;
}

export interface AgentDefinition {
  name: string;
  description?: string;
  tools?: string[];
  model?: string;
  scope: Exclude<ConfigScope, 'local'>;
  path: string;
  contentHash: string;
  /** Other frontmatter keys, kept as opaque metadata (values never include secrets we parse). */
  extraKeys: string[];
}

export interface SkillDefinition {
  /** Canonical: frontmatter name, falling back to dirName. */
  name: string;
  dirName: string;
  description?: string;
  scope: Exclude<ConfigScope, 'local'>;
  path: string;
  contentHash: string;
  /** Plugin namespace when scope = plugin (listed as `<plugin>:<name>`). */
  plugin?: string;
}

export interface HookConfig {
  event: string;
  matcher?: string;
  type: string;
  /** Command text is never stored; hash only. */
  commandHash: string;
  /** Settings file that declared it. */
  sourcePath: string;
  scope: ConfigScope;
}

export interface McpServerConfig {
  name: string;
  scope: ConfigScope;
  transport?: string;
  sourcePath: string;
}

export interface ScannedConfig {
  /** ~/.claude for user scope, the project root for project scope. */
  root: string;
  scope: 'user' | 'project';
  instructions: InstructionFile[];
  agents: AgentDefinition[];
  skills: SkillDefinition[];
  hooks: HookConfig[];
  mcpServers: McpServerConfig[];
  permissions: { allow: string[]; deny: string[]; defaultMode?: string };
  /** Model pinned in settings (`model` key), if any. */
  model?: string;
  /** sha256 of the canonicalized merged settings (secrets in env excluded before hashing). */
  settingsHash?: string;
  warnings: string[];
}

export interface HarnessCommit {
  sha: string;
  at: string;
  /** Commit subject line. */
  message: string;
  /** Harness files changed in this commit (repo-relative). */
  changedPaths: string[];
  /** Project config as of this commit (read via `git show <sha>:<path>`). */
  snapshot: ScannedConfig;
}

// ---------------------------------------------------------------------------------------------
// Outcomes and loop tiers
// ---------------------------------------------------------------------------------------------

export type TierInput = Pick<ParsedStep, 'kind' | 'tool' | 'raw'>;

export type SessionOutcomes = Map<string, OutcomeSignalResult[]>;

// ---------------------------------------------------------------------------------------------
// garden.yaml (user-declared playbooks, loops, pricing overrides)
// ---------------------------------------------------------------------------------------------
//
// playbooks:
//   - name: release
//     project: shop-api                 # optional: family name
//     steps:
//       - { id: changelog, skill: changelog-writer, gate: step_success }
//       - { id: tests, skill: run-tests, gate: tests_pass }
//       - { id: tag, agent: release-manager, gate: { command_ok: "git tag" } }
// loops:
//   - name: nightly-flaky-triage
//     project: shop-api
//     agent: main
//     trigger: cron                     # cron | hook | loop_skill | headless_repeat | declared
//     every: 1d                         # 30m | 6h | 1d | 7d
//     match: "triage flaky"             # optional: substring of the task prompt to attribute runs
// pricing:
//   claude-opus-5-5: { input: 4, output: 20, cacheRead: 0.2, contextWindow: 1000000 }
