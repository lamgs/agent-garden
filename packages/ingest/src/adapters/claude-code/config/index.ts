import type { HarnessCommit, ScannedConfig } from '../contracts';

/** Scan user-level config: `<claudeHome>/{CLAUDE.md,agents,skills,settings.json,plugins}` and user MCP servers in `claudeJsonPath`. */
export function scanUserConfig(claudeHome: string, claudeJsonPath?: string): ScannedConfig {
  throw new Error(`scanUserConfig not implemented (${claudeHome}, ${claudeJsonPath})`);
}

/** Scan a project: CLAUDE.md chain, `.claude/{agents,skills,settings.json,settings.local.json}`, `.mcp.json`, local-scope MCP in `claudeJsonPath`. */
export function scanProjectConfig(root: string, claudeJsonPath?: string): ScannedConfig {
  throw new Error(`scanProjectConfig not implemented (${root}, ${claudeJsonPath})`);
}

/** Commits that touched harness files in the git repo at `root`, oldest first. [] if not a repo. */
export function gitHarnessHistory(root: string): HarnessCommit[] {
  throw new Error(`gitHarnessHistory not implemented (${root})`);
}

/** Git top-level for a directory, or undefined if not inside a repo. */
export function gitRoot(dir: string): string | undefined {
  throw new Error(`gitRoot not implemented (${dir})`);
}
