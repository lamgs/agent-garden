import type { LoopTier } from '@garden/core';
import type { ParsedSession, SessionOutcomes, TierInput } from '../contracts';

/** Which of the four nested loops a step belongs to (rules in docs/schema.md). */
export function classifyTier(step: TierInput): LoopTier {
  void step;
  return 'agent';
}

/** Run every heuristic signal (packages/core SIGNALS) for every run in the session. */
export function detectSessionOutcomes(session: ParsedSession): SessionOutcomes {
  throw new Error(`detectSessionOutcomes not implemented (${session.id})`);
}
