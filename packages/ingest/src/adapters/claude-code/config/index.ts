/**
 * Config scanners for the Claude Code adapter: CLAUDE.md chain, agents, skills (incl. plugins),
 * settings/hooks/permissions, MCP server names, and git history of harness files.
 * Never throws on malformed files: problems are reported in `ScannedConfig.warnings`.
 */
export { scanProjectConfig, scanUserConfig } from './scan';
export { gitHarnessHistory, gitRoot } from './git';
