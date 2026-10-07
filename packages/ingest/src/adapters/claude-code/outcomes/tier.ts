import type { LoopTier } from '@garden/core';
import type { TierInput } from '../contracts';
import { commandWritesTo, isShipCommand, isTestCommand } from './commands';

/** Tools whose `file_path` / `notebook_path` argument is a file they modify. */
export const EDIT_TOOLS: ReadonlySet<string> = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
]);

/** Subagent types that check work rather than do it. */
export const VERIFIER_SUBAGENT = /review|test|qa|verif|lint/i;

const HARNESS_PATHS: readonly RegExp[] = [
  /(^|\/)CLAUDE(\.local)?\.md$/,
  /(^|\/)\.claude\/(agents|skills|commands|hooks)\//,
  /(^|\/)\.claude\/settings[^/]*\.json$/,
  /(^|\/)\.mcp\.json$/,
];

/**
 * A file that is part of an agent's harness: CLAUDE.md / CLAUDE.local.md (any directory, incl.
 * `~/.claude/CLAUDE.md`), `.claude/{agents,skills,commands,hooks}/`, `.claude/settings*.json`,
 * `.mcp.json`. Works for project paths and their `~/.claude/...` equivalents.
 */
export function isHarnessPath(path: string | undefined): boolean {
  if (path === undefined || path === '') return false;
  const p = path.replace(/\\/g, '/');
  return HARNESS_PATHS.some((re) => re.test(p));
}

/**
 * Which of the four nested loops a step belongs to (rules in docs/schema.md). Tool results are
 * classified like the call they answer (the parser copies `raw.command` / `raw.filePath` /
 * `raw.subagentType` onto them). When one Bash line does several things the outer loop wins:
 * hill_climbing > application > verification (`pnpm test && git push` is application).
 */
export function classifyTier(step: TierInput): LoopTier {
  if (step.kind === 'hook') return 'verification';

  const toolName = step.tool?.name;
  if (toolName !== undefined && EDIT_TOOLS.has(toolName) && isHarnessPath(step.raw.filePath)) {
    return 'hill_climbing';
  }

  const command = step.raw.command;
  if (command !== undefined && command.trim() !== '') {
    if (commandWritesTo(command, isHarnessPath)) return 'hill_climbing';
    if (isShipCommand(command)) return 'application';
    if (isTestCommand(command)) return 'verification';
  }

  const isSubagentStep =
    step.kind === 'subagent_spawn' ||
    step.kind === 'subagent_return' ||
    step.tool?.category === 'subagent';
  if (
    isSubagentStep &&
    step.raw.subagentType !== undefined &&
    VERIFIER_SUBAGENT.test(step.raw.subagentType)
  ) {
    return 'verification';
  }

  return 'agent';
}
