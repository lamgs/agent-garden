/**
 * View data contracts: the only data shapes the web app knows about.
 * Built by pure functions from the store; also written as static JSON by `garden export --static`.
 */
import type { Agent, HarnessDiff, ID, ISO, LoopTier, OutcomeLabel, StepKind } from './schema';

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
  runsPerDay: number;
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
  taskPreview: string;
  outcome: {
    label: OutcomeLabel;
    score: number | null;
    source: 'heuristic' | 'manual';
    signals: { id: string; fired: boolean | null; weight: number; detail: string }[];
  };
  totalTokens: number;
  costUsd: number | null;
  model: string | null;
}

export interface BedSnapshot {
  bed: BedSummary;
  plants: PlantSummary[];
}

export interface BedCompareView {
  left: BedSnapshot;
  right: BedSnapshot;
  harnessDiff: HarnessDiff;
  sharedAgents: { agentId: ID; left: PlantSummary; right: PlantSummary }[];
}

export interface PlantView {
  plant: PlantSummary;
  agent: Agent;
  capabilities: { tools: string[]; skills: ID[]; mcpServers: string[]; model?: string };
  runs: RunRow[];
  tierBreakdown: Record<LoopTier, number>;
  otherBeds: PlantSummary[];
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
