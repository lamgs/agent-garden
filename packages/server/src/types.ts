export type {
  HarnessBundle,
  HarnessDiff,
  OutcomeLabel,
  OutcomeSignalResult,
  GateSpec,
} from '@garden/core';
import type { GateSpec } from '@garden/core';
export interface PlaybookStepRow {
  id: string;
  skillId?: string;
  agentId?: string;
  gate: GateSpec;
}
