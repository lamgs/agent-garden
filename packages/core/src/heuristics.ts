import type { OutcomeLabel, OutcomeSignalResult } from './schema';

/**
 * Success heuristics v1. Every outcome stores the version, the signals, and their weights,
 * and the UI shows them. Changing a weight or threshold means bumping HEURISTIC_VERSION.
 */
export const HEURISTIC_VERSION = 'h1';

export interface SignalDef {
  id: string;
  weight: number;
  description: string;
  appliesTo: 'all' | 'main' | 'subagent';
}

export const SIGNALS: readonly SignalDef[] = [
  {
    id: 'tests_passed_after_last_edit',
    weight: 0.35,
    description: 'A test command ran after the last file edit and returned without error.',
    appliesTo: 'all',
  },
  {
    id: 'tests_failing_at_end',
    weight: -0.35,
    description: 'The last test command in the run returned an error.',
    appliesTo: 'all',
  },
  {
    id: 'clean_finish',
    weight: 0.1,
    description: 'The final assistant message ended normally, with no interrupt.',
    appliesTo: 'all',
  },
  {
    id: 'errors_in_tail',
    weight: -0.2,
    description:
      'A tool or API error in the last 5 steps was never followed by a success of the same tool.',
    appliesTo: 'all',
  },
  {
    id: 'user_retried',
    weight: -0.3,
    description:
      'The next human prompt came within 10 minutes and reads as a correction, or the user interrupted.',
    appliesTo: 'main',
  },
  {
    id: 'user_moved_on',
    weight: 0.1,
    description: 'The next human prompt is an acknowledgement or a new topic.',
    appliesTo: 'main',
  },
  {
    id: 'shipped',
    weight: 0.1,
    description: 'git commit, git push, or PR creation succeeded during the run.',
    appliesTo: 'all',
  },
  {
    id: 'parent_respawned',
    weight: -0.2,
    description:
      'The parent spawned the same subagent type with a similar prompt again in the same turn.',
    appliesTo: 'subagent',
  },
];

export const SUCCESS_THRESHOLD = 0.65;
export const FAILURE_THRESHOLD = 0.35;

/** Combine detector results into a label. Detectors live in the ingest adapters. */
export function scoreSignals(results: readonly OutcomeSignalResult[]): {
  label: OutcomeLabel;
  score: number | null;
} {
  const fired = results.filter((r) => r.fired === true);
  if (fired.length === 0) return { label: 'unknown', score: null };
  const raw = 0.5 + fired.reduce((acc, r) => acc + r.weight, 0);
  const score = Math.min(1, Math.max(0, Math.round(raw * 1000) / 1000));
  const label: OutcomeLabel =
    score >= SUCCESS_THRESHOLD ? 'success' : score <= FAILURE_THRESHOLD ? 'failure' : 'partial';
  return { label, score };
}

/** Success-rate numerator: success = 1, partial = 0.5, failure = 0. Unknown is excluded. */
export function successCredit(label: OutcomeLabel): number | null {
  switch (label) {
    case 'success':
      return 1;
    case 'partial':
      return 0.5;
    case 'failure':
      return 0;
    case 'unknown':
      return null;
  }
}
