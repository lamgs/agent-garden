/**
 * View data contracts: the only data shapes the web app knows about.
 * Built by pure functions from the store; also written as static JSON by `garden export --static`.
 */
import type { HarnessDiff, ID, ISO, LoopTier, OutcomeLabel, StepKind } from './schema';

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
  kind: StepKind;
  /** 0..1 share of the model's context window. */
  contextFill: number;
  tokensCum: number;
  label: string;
  isError: boolean;
  forkRunId?: ID;
  compaction?: boolean;
}

export interface ReplayView {
  run: RunRow;
  contextWindow: number;
  frames: ReplayFrame[];
  children: ReplayView[];
}

export interface Season {
  harnessVersionId: ID;
  from: ISO;
  to: ISO | null;
  provenance: 'git' | 'observed' | 'snapshot';
  diffSummary: string[];
}

export interface SeasonsView {
  familyId: ID;
  seasons: Season[];
  series: {
    agentId: ID;
    perSeason: {
      harnessVersionId: ID;
      success: Rate;
      costPerRunUsd: number | null;
      runs: number;
    }[];
  }[];
  caveat: string;
}

export interface RouterCandidate {
  kind: 'agent' | 'skill';
  id: ID;
  name: string;
  plantIds: ID[];
  score: number;
  confidence: number;
  reasons: { kind: 'description_match' | 'similar_past_task' | 'outcome_history'; text: string }[];
}

export interface RouterResult {
  query: string;
  method: { lexical: 'bm25'; embedding: 'tfidf-lsa' | 'minilm'; weights: Record<string, number> };
  candidates: RouterCandidate[];
}
