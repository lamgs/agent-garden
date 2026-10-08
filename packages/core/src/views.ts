/**
 * View data contracts: the only data shapes the web app knows about.
 * Built by pure functions from the store; also written as static JSON by `garden export --static`.
 */
import type {
  HarnessDiff,
  ID,
  ISO,
  LoopTier,
  OutcomeLabel,
  StepKind,
  ToolCategory,
} from './schema';

/** A rate that always carries how it was computed. */
export interface Rate {
  value: number | null;
  /** Runs with a known label (heuristic or manual). */
  n: number;
  nUnknown: number;
  nManual: number;
  ci95: [number, number] | null;
  method: string;
}

export interface SoilSummary {
  model?: string;
  effort?: string;
  permissionMode?: string;
  toolCount: number;
  mcpCount: number;
  hookCount: number;
  instructionBytes: number;
}

export interface BedSummary {
  id: ID;
  name: string;
  soil: SoilSummary;
  currentHarnessVersionId: ID | null;
  seasonCount: number;
  plantIds: ID[];
}

export interface PlantSummary {
  /** Planting id: agent within bed. */
  id: ID;
  agentId: ID;
  agentKind: 'main' | 'subagent';
  bedId: ID;
  name: string;
  runs: number;
  success: Rate;
  /** Failure share of known-label runs in the last 14 days of the window. */
  recentFailureShare: number | null;
  costPerRunUsd: number | null;
  totalCostUsd: number | null;
  /** Some runs have estimated output tokens (tokenQuality 'output_estimated'); label costs as estimates. */
  costEstimated: boolean;
  /** Runs whose model has no price; excluded from cost. */
  unpricedRuns: number;
  lastRunAt: ISO | null;
  staleDays: number | null;
  skillIds: ID[];
}

export interface SkillCard {
  skillId: ID;
  name: string;
  plantId: ID;
  invocations: number;
}

export type LoopState = 'flowing' | 'flooding' | 'dry';

export interface LoopChannel {
  loopId: ID;
  name: string;
  tier: LoopTier;
  targetPlantIds: ID[];
  /** 0 when executions are not observed (see `observed`). */
  runsPerDay: number;
  /** false for loops whose executions are not recorded in the data (e.g. configured hooks). */
  observed: boolean;
  state: LoopState;
  evidence: string[];
}

export interface BeeFlow {
  fromPlantId: ID;
  toPlantId: ID;
  calls: number;
}

export type WeedKind = 'orphan' | 'duplicate' | 'unowned';

export interface Weed {
  id: ID;
  kind: WeedKind;
  subject: { type: 'agent' | 'skill' | 'hook' | 'mcp_server'; id: ID };
  bedId?: ID;
  reason: string;
}

export type GateState = 'open' | 'closed' | 'unknown';

export interface PlaybookPath {
  id: ID;
  name: string;
  steps: { stepId: string; bedId?: ID; plantId?: ID; gate: GateState; evidence: string }[];
}

export interface GardenView {
  generatedAt: ISO;
  window: { from: ISO; to: ISO };
  beds: BedSummary[];
  plants: PlantSummary[];
  skills: SkillCard[];
  loops: LoopChannel[];
  bees: BeeFlow[];
  weeds: Weed[];
  playbooks: PlaybookPath[];
}

export interface RunRow {
  runId: ID;
  startedAt: ISO;
  durationMs: number;
  /** Redacted, truncated first prompt. */
  taskPreview: string;
  trigger: 'human' | 'automated' | 'subagent';
  outcome: {
    label: OutcomeLabel;
    score: number | null;
    source: 'heuristic' | 'manual';
    heuristicLabel: OutcomeLabel;
    signals: { id: string; fired: boolean | null; weight: number; detail: string }[];
    manual?: { label: OutcomeLabel; note?: string; at: ISO };
  };
  totalTokens: number;
  costUsd: number | null;
  costEstimated: boolean;
  model: string | null;
  toolCallCount: number;
  errorCount: number;
  /** Subagent runs this run spawned. */
  childCount: number;
}

/** The harness a planting runs under, summarized for display. */
export interface HarnessSummary {
  versionId: ID;
  validFrom: ISO;
  provenance: 'git' | 'observed' | 'snapshot';
  model?: string;
  effort?: string;
  permissionMode?: string;
  instructionBytes: number;
  toolCount: number;
  tools: string[];
  mcpServers: string[];
  skillCount: number;
  hookCount: number;
  /** Commit subject when provenance is git. */
  commitMessage?: string;
  /** Changes from the previous version of this harness (summarizeDiff). */
  changes: string[];
}

export interface SignalStat {
  id: string;
  weight: number;
  description: string;
  fired: number;
  notFired: number;
  notApplicable: number;
}

export interface PlantView {
  plant: PlantSummary;
  bed: BedSummary;
  agent: {
    id: ID;
    name: string;
    kind: 'main' | 'subagent';
    definition?: {
      scope: string;
      description?: string;
      tools?: string[];
      model?: string;
      path?: string;
    };
  };
  harness: HarnessSummary | null;
  capabilities: {
    skills: { id: ID; name: string; invocations: number }[];
    mcpServers: { name: string; calls: number }[];
    /** Most-used tools in this planting's runs. */
    tools: { name: string; calls: number }[];
  };
  /** Most recent first, capped; `runsTotal` is the full count in the window. */
  runs: RunRow[];
  runsTotal: number;
  outcomeMix: Record<OutcomeLabel, number>;
  /** How often each heuristic fired across this planting's runs: the evidence behind the rate. */
  signalStats: SignalStat[];
  /** Steps per loop tier across this planting's runs. */
  tierBreakdown: Record<LoopTier, number>;
  /** The same agent planted in other beds. */
  otherBeds: PlantSummary[];
}

export interface BedSnapshot {
  bed: BedSummary;
  plants: PlantSummary[];
  harness: HarnessSummary | null;
}

export interface RateDelta {
  /** right − left, in rate points (−1..1); null if either side has no labeled runs. */
  delta: number | null;
  /** Wilson intervals don't overlap: a difference unlikely to be noise at this n. */
  separated: boolean;
}

export interface BedCompareView {
  left: BedSnapshot;
  right: BedSnapshot;
  /** left → right. */
  harnessDiff: HarnessDiff;
  harnessChanges: string[];
  sharedAgents: {
    agentId: ID;
    name: string;
    left: PlantSummary;
    right: PlantSummary;
    success: RateDelta;
    /** right ÷ left median cost per run. */
    costRatio: number | null;
  }[];
  caveat: string;
}

/** The same agent in two beds: the "replant" comparison. */
export interface ReplantView {
  agent: { id: ID; name: string; kind: 'main' | 'subagent'; description?: string };
  from: {
    bed: BedSummary;
    plant: PlantSummary | null;
    harness: HarnessSummary | null;
    recent: RunRow[];
  };
  to: {
    bed: BedSummary;
    plant: PlantSummary | null;
    harness: HarnessSummary | null;
    recent: RunRow[];
  };
  harnessDiff: HarnessDiff | null;
  harnessChanges: string[];
  success: RateDelta;
  costRatio: number | null;
  /** Signal-level differences: share of runs each heuristic fired in, per side. */
  signals: { id: string; weight: number; fromShare: number | null; toShare: number | null }[];
  caveat: string;
}

/** Body of POST /api/runs/:runId/label. */
export interface LabelRequest {
  label: OutcomeLabel | 'clear';
  note?: string;
}

export interface ReplayFrame {
  /** Milliseconds since run start. */
  t: number;
  stepId: ID;
  seq: number;
  kind: StepKind;
  loopTier: LoopTier;
  /**
   * 0..1 share of the model's context window at this step: the latest `contextTokens` reported at
   * or before this step (deduped per API message), divided by `ReplayView.contextWindow`.
   */
  contextFill: number;
  /** Latest prompt size (input + cache read + cache write) at or before this step. */
  contextTokens: number;
  /** Cumulative deduped tokens (input + output + cache) up to and including this step. */
  tokensCum: number;
  /**
   * Cost of `tokensCum` at query time (pricing table × the run's model, cache rates applied);
   * null when the model is unpriced. Optional: added in M5 so the step panel never estimates
   * cost from a token share.
   */
  costUsdCum?: number | null;
  /** Short human label, e.g. "Edit src/app.ts" or "Thinking (1.2k chars)". Redacted preview text. */
  label: string;
  tool?: { name: string; category: ToolCategory; mcpServer?: string; skillName?: string };
  isError: boolean;
  /** Set on subagent_spawn steps: the child run (present in `children`). */
  forkRunId?: ID;
  compaction?: { trigger: 'auto' | 'manual'; preTokens?: number };
}

export interface ReplayView {
  run: RunRow;
  agent: { id: ID; name: string; kind: 'main' | 'subagent' };
  bed: { id: ID; name: string };
  plantId: ID;
  /** Context window of the run's model, from the pricing table; how it was chosen. */
  contextWindow: number;
  contextWindowSource: string;
  frames: ReplayFrame[];
  /** Child runs spawned by subagent_spawn frames, recursively, capped at depth 3. */
  children: ReplayView[];
  peakContextTokens: number;
  compactions: number;
}

/**
 * Live layer. Built from transcript files as they grow (default, no settings changes), or from
 * opt-in hook events. Everything here is derived, redacted, and never stored by default.
 */
export type LiveActivity =
  | 'idle'
  | 'thinking'
  | 'reading'
  | 'searching'
  | 'editing'
  | 'running'
  | 'web'
  | 'mcp'
  | 'skill'
  | 'delegating'
  | 'waiting_permission'
  | 'waiting_input'
  | 'compacting'
  | 'errored'
  | 'done';

export type LiveEventKind =
  | 'session_seen'
  | 'turn_start'
  | 'thinking'
  | 'assistant_text'
  | 'tool_start'
  | 'tool_end'
  | 'subagent_start'
  | 'subagent_end'
  | 'compaction'
  | 'error'
  | 'turn_end'
  | 'hook';

export interface LiveEvent {
  /** Monotonic per server process. */
  seq: number;
  at: ISO;
  kind: LiveEventKind;
  /** Stable key of the live agent this event belongs to (session, or session + subagent). */
  agentKey: ID;
  tool?: { name: string; category: ToolCategory; mcpServer?: string; skillName?: string };
  isError?: boolean;
  /** Prompt size after this event's API message, when known. */
  contextTokens?: number;
  /** Redacted, truncated (≤ 120 chars). Never thinking text. */
  preview?: string;
}

export interface LiveAgent {
  key: ID;
  sessionId: ID;
  /** 'main' or the subagent type. Matches Agent.name, so it joins with the history views. */
  agentName: string;
  agentKind: 'main' | 'subagent';
  /** Parent live agent for subagents. */
  parentKey?: ID;
  /** Harness family (bed) id and display name. */
  bedId: ID;
  bedName: string;
  /** Planting id when the agent already exists in the history store. */
  plantId?: ID;
  model?: string;
  activity: LiveActivity;
  activitySince: ISO;
  lastEventAt: ISO;
  currentTool?: { name: string; category: ToolCategory; mcpServer?: string; skillName?: string };
  /** Redacted short label of what it is doing now. */
  detail?: string;
  contextTokens: number;
  contextWindow: number;
  turnStartedAt?: ISO;
  /** Counts within the current turn. */
  toolCalls: number;
  errors: number;
  /** The loop that triggered this run, when known (headless/cron/hook). */
  loop?: { id?: ID; name: string; tier: LoopTier };
  /** How `activity` was decided, e.g. "tool_use without tool_result for 8 s → waiting_permission". */
  evidence: string;
}

export interface LiveSnapshot {
  generatedAt: ISO;
  source: 'transcripts' | 'hooks' | 'demo';
  /** Agents with an event in the last `activeWindowSec`, plus their parents. */
  agents: LiveAgent[];
  activeWindowSec: number;
  /** Most recent events, newest last, capped. */
  recent: LiveEvent[];
}

/** Server-sent events on GET /api/live/stream: one `snapshot` first, then `event` + `agent`. */
export type LiveMessage =
  | { type: 'snapshot'; snapshot: LiveSnapshot }
  | { type: 'event'; event: LiveEvent }
  | { type: 'agent'; agent: LiveAgent }
  | { type: 'gone'; agentKey: ID };

export interface Season {
  harnessVersionId: ID;
  /** The primary agent this season chain belongs to (chains are per bed + agent). */
  agentId: ID;
  from: ISO;
  to: ISO | null;
  provenance: 'git' | 'observed' | 'snapshot';
  /** Commit subject (git) or a generated title such as "Model: opus 5.5 → sonnet 5.5". */
  title: string;
  diffSummary: string[];
}

export interface SeasonStat {
  harnessVersionId: ID;
  success: Rate;
  costPerRunUsd: number | null;
  costEstimated: boolean;
  runs: number;
  /** Compared with the previous season of the same agent; null for the first. */
  vsPrevious: RateDelta | null;
}

export interface SeasonsView {
  familyId: ID;
  bed: BedSummary;
  window: { from: ISO; to: ISO };
  seasons: Season[];
  series: {
    agentId: ID;
    agentName: string;
    plantId: ID | null;
    perSeason: SeasonStat[];
  }[];
  caveat: string;
}

export interface RouterCandidate {
  kind: 'agent' | 'skill';
  id: ID;
  name: string;
  plantIds: ID[];
  score: number;
  /** Score components before weighting, each 0..1. */
  components: { lexical: number; embedding: number; outcome: number };
  /** 0..1, calibrated on the eval set (see `RouterResult.method.calibration`). */
  confidence: number;
  reasons: { kind: 'description_match' | 'similar_past_task' | 'outcome_history'; text: string }[];
  /**
   * Per planting (the same candidate in each bed): the outcome component recomputed from that bed's
   * similar past runs only, and the confidence that gives. Lexical and embedding are shared.
   */
  plantings?: { plantId: ID; outcome: number; n: number; confidence: number }[];
}

export interface RouterResult {
  query: string;
  method: {
    lexical: 'bm25';
    embedding: 'tfidf-lsa' | 'minilm' | 'none';
    weights: { lexical: number; embedding: number; outcome: number };
    /** How confidence was calibrated, e.g. "Platt fit on 30 demo queries, 2026-10-08". */
    calibration: string;
    corpusSize: number;
  };
  candidates: RouterCandidate[];
}
