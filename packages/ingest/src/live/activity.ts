import type { LiveActivity, ToolCategory } from '@garden/core';
import { LIVE_THRESHOLDS } from './types';

const BY_NAME: Record<string, LiveActivity> = {
  Read: 'reading',
  LS: 'reading',
  NotebookRead: 'reading',
  Grep: 'searching',
  Glob: 'searching',
  ToolSearch: 'searching',
  Edit: 'editing',
  MultiEdit: 'editing',
  Write: 'editing',
  NotebookEdit: 'editing',
  Bash: 'running',
  BashOutput: 'running',
  KillShell: 'running',
  WebFetch: 'web',
  WebSearch: 'web',
  Skill: 'skill',
  Agent: 'delegating',
  Task: 'delegating',
  TodoWrite: 'thinking',
  AskUserQuestion: 'waiting_input',
  ExitPlanMode: 'waiting_input',
};

/** Activity while a tool call is open. Unknown built-ins count as `running` (a tool is executing). */
export function activityForTool(name: string, category: ToolCategory): LiveActivity {
  if (category === 'mcp') return 'mcp';
  if (category === 'skill') return 'skill';
  if (category === 'subagent') return 'delegating';
  return BY_NAME[name] ?? 'running';
}

/**
 * How long an open tool call may go without a newer line before we say "possibly waiting for
 * permission". Bash, web and MCP tools get the longer threshold. Delegation and user questions legitimately wait, so they never trigger it.
 */
export function permissionThresholdMs(name: string, category: ToolCategory): number | undefined {
  const a = activityForTool(name, category);
  if (a === 'delegating' || a === 'waiting_input') return undefined;
  if (a === 'running' || a === 'web' || a === 'mcp') return LIVE_THRESHOLDS.slowToolPermissionMs;
  return LIVE_THRESHOLDS.permissionMs;
}
