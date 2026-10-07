import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { contentHash } from '../../../ids';
import type {
  AgentDefinition,
  ConfigScope,
  HookConfig,
  InstructionFile,
  McpServerConfig,
  ScannedConfig,
  SkillDefinition,
} from '../contracts';
import {
  canonicalJson,
  deepMerge,
  isRecord,
  mcpServerNames,
  parseAgent,
  parseHooks,
  parseJson,
  parseJsonObject,
  parseSkill,
  sanitizeSettings,
  settingsFacts,
  type Rec,
} from './parse';
import { diskTree, type FileTree } from './tree';

/** Directories never searched for nested CLAUDE.md (dot-directories are skipped too). */
export const NESTED_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'vendor']);
export const NESTED_MAX_DEPTH = 3;
/** How deep under `<claudeHome>/plugins` to look for `skills/` directories. */
const PLUGIN_MAX_DEPTH = 6;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byNameThenPath = <T extends { name: string; path: string }>(a: T, b: T) =>
  cmp(a.name, b.name) || cmp(a.path, b.path);

/** Repo-relative path → is it a nested CLAUDE.md we track (depth 1..3, not in skipped dirs)? */
export function isNestedInstruction(rel: string): boolean {
  const segs = rel.split('/');
  const dirs = segs.slice(0, -1);
  if (segs[segs.length - 1] !== 'CLAUDE.md') return false;
  if (dirs.length < 1 || dirs.length > NESTED_MAX_DEPTH) return false;
  return dirs.every((d) => !NESTED_SKIP_DIRS.has(d) && !d.startsWith('.'));
}

interface Ctx {
  tree: FileTree;
  /** Absolute path for a tree-relative path. */
  abs: (rel: string) => string;
  warnings: string[];
}

function instruction(ctx: Ctx, rel: string, scope: InstructionFile['scope']): InstructionFile[] {
  const buf = ctx.tree.read(rel);
  if (!buf) return [];
  return [{ path: ctx.abs(rel), scope, bytes: buf.length, hash: contentHash(buf) }];
}

function nestedInstructions(ctx: Ctx): InstructionFile[] {
  const out: InstructionFile[] = [];
  const walk = (dir: string, depth: number) => {
    for (const e of ctx.tree.list(dir)) {
      if (!e.isDir || e.isSymlink) continue;
      if (NESTED_SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      const rel = dir === '' ? e.name : `${dir}/${e.name}`;
      out.push(...instruction(ctx, `${rel}/CLAUDE.md`, 'nested'));
      if (depth < NESTED_MAX_DEPTH) walk(rel, depth + 1);
    }
  };
  walk('', 1);
  return out;
}

function agents(ctx: Ctx, dir: string, scope: AgentDefinition['scope']): AgentDefinition[] {
  const out: AgentDefinition[] = [];
  for (const e of ctx.tree.list(dir)) {
    if (e.isDir || !e.name.toLowerCase().endsWith('.md')) continue;
    const rel = `${dir}/${e.name}`;
    const buf = ctx.tree.read(rel);
    if (!buf) continue;
    out.push(parseAgent(buf, e.name, ctx.abs(rel), scope, ctx.warnings));
  }
  return out;
}

function skillsIn(
  ctx: Ctx,
  dir: string,
  scope: SkillDefinition['scope'],
  plugin?: string,
): SkillDefinition[] {
  const out: SkillDefinition[] = [];
  for (const e of ctx.tree.list(dir)) {
    if (!e.isDir) continue;
    const rel = `${dir}/${e.name}/SKILL.md`;
    const buf = ctx.tree.read(rel);
    if (!buf) continue;
    out.push(parseSkill(buf, e.name, ctx.abs(rel), scope, ctx.warnings, plugin));
  }
  return out;
}

const VERSIONISH = /^(v?\d+(\.\d+)*([-+][\w.]+)?|[0-9a-f]{7,40})$/i;

/**
 * Plugin name for a directory that contains `skills/`: `name` from `.claude-plugin/plugin.json`
 * when present, else the directory name. If that looks like a version or commit hash (the
 * `plugins/cache/<marketplace>/<plugin>/<version>/` layout), the parent directory name is used.
 */
function pluginName(ctx: Ctx, pluginDir: string): string {
  const manifest = ctx.tree.read(`${pluginDir}/.claude-plugin/plugin.json`);
  if (manifest) {
    const m = parseJson(
      manifest.toString('utf8'),
      ctx.abs(`${pluginDir}/.claude-plugin/plugin.json`),
      ctx.warnings,
    );
    if (isRecord(m) && typeof m.name === 'string' && m.name.trim()) return m.name.trim();
  }
  const segs = pluginDir.split('/');
  const last = segs[segs.length - 1] ?? pluginDir;
  if (VERSIONISH.test(last) && segs.length >= 2) return segs[segs.length - 2] ?? last;
  return last;
}

function pluginSkills(ctx: Ctx): SkillDefinition[] {
  const found: SkillDefinition[] = [];
  const walk = (dir: string, depth: number) => {
    for (const e of ctx.tree.list(dir)) {
      if (!e.isDir || e.isSymlink || e.name === 'node_modules' || e.name === '.git') continue;
      const rel = `${dir}/${e.name}`;
      if (e.name === 'skills') {
        found.push(...skillsIn(ctx, rel, 'plugin', pluginName(ctx, dir)));
        continue;
      }
      if (depth < PLUGIN_MAX_DEPTH) walk(rel, depth + 1);
    }
  };
  walk('plugins', 1);
  // The same plugin can be present more than once (marketplace checkout + cache). Keep the first
  // copy (by path) of each `<plugin>:<name>`.
  found.sort(byNameThenPath);
  const seen = new Set<string>();
  return found.filter((s) => {
    const key = `${s.plugin ?? ''}:${s.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface SettingsResult {
  hooks: HookConfig[];
  permissions: ScannedConfig['permissions'];
  model?: string;
  settingsHash?: string;
}

/** Settings files in ascending precedence (later wins). */
function settings(ctx: Ctx, files: { rel: string; scope: ConfigScope }[]): SettingsResult {
  const hooks: HookConfig[] = [];
  const allow = new Set<string>();
  const deny = new Set<string>();
  let defaultMode: string | undefined;
  let model: string | undefined;
  let merged: unknown;
  let any = false;
  for (const f of files) {
    const buf = ctx.tree.read(f.rel);
    if (!buf) continue;
    const path = ctx.abs(f.rel);
    const s: Rec | undefined = parseJsonObject(buf.toString('utf8'), path, ctx.warnings);
    if (!s) continue;
    any = true;
    hooks.push(...parseHooks(s.hooks, path, f.scope, ctx.warnings));
    const facts = settingsFacts(s);
    facts.allow.forEach((x) => allow.add(x));
    facts.deny.forEach((x) => deny.add(x));
    defaultMode = facts.defaultMode ?? defaultMode;
    model = facts.model ?? model;
    merged = deepMerge(merged ?? {}, sanitizeSettings(s));
  }
  const res: SettingsResult = {
    hooks,
    permissions: { allow: [...allow].sort(cmp), deny: [...deny].sort(cmp) },
  };
  if (defaultMode !== undefined) res.permissions.defaultMode = defaultMode;
  if (model !== undefined) res.model = model;
  if (any) res.settingsHash = contentHash(canonicalJson(merged));
  return res;
}

const hookOrder = (a: HookConfig, b: HookConfig) =>
  cmp(a.sourcePath, b.sourcePath) ||
  cmp(a.event, b.event) ||
  cmp(a.matcher ?? '', b.matcher ?? '') ||
  cmp(a.type, b.type) ||
  cmp(a.commandHash, b.commandHash);

const mcpOrder = (a: McpServerConfig, b: McpServerConfig) =>
  cmp(a.name, b.name) || cmp(a.scope, b.scope) || cmp(a.sourcePath, b.sourcePath);

function finish(c: ScannedConfig): ScannedConfig {
  c.instructions.sort((a, b) => cmp(a.path, b.path));
  c.agents.sort(byNameThenPath);
  c.skills.sort(byNameThenPath);
  c.hooks.sort(hookOrder);
  c.mcpServers.sort(mcpOrder);
  return c;
}

function build(
  root: string,
  scope: ScannedConfig['scope'],
  ctx: Ctx,
  parts: Partial<ScannedConfig>,
  s: SettingsResult,
): ScannedConfig {
  const c: ScannedConfig = {
    root,
    scope,
    instructions: parts.instructions ?? [],
    agents: parts.agents ?? [],
    skills: parts.skills ?? [],
    hooks: s.hooks,
    mcpServers: parts.mcpServers ?? [],
    permissions: s.permissions,
    warnings: ctx.warnings,
  };
  if (s.model !== undefined) c.model = s.model;
  if (s.settingsHash !== undefined) c.settingsHash = s.settingsHash;
  return finish(c);
}

/**
 * Read `~/.claude.json` and return only MCP server names/transports: top-level `mcpServers`
 * (user scope) and, when `projectRoot` is given, `projects[<root>].mcpServers` (local scope).
 * No other key is read or returned. The parsed object does not escape this function.
 */
export function claudeJsonMcp(
  claudeJsonPath: string,
  projectRoot: string | undefined,
  warnings: string[],
): McpServerConfig[] {
  let text: string;
  try {
    text = readFileSync(claudeJsonPath, 'utf8');
  } catch {
    return [];
  }
  const doc = parseJsonObject(text, claudeJsonPath, warnings);
  if (!doc) return [];
  if (projectRoot === undefined) {
    return mcpServerNames(doc.mcpServers, 'user', claudeJsonPath, warnings);
  }
  const projects = isRecord(doc.projects) ? doc.projects : {};
  const candidates = [projectRoot, resolve(projectRoot)];
  try {
    candidates.push(realpathSync(projectRoot));
  } catch {
    // root may not exist on disk
  }
  for (const key of candidates) {
    const p = projects[key];
    if (isRecord(p)) return mcpServerNames(p.mcpServers, 'local', claudeJsonPath, warnings);
  }
  return [];
}

/** Scan user-level config: `<claudeHome>/{CLAUDE.md,agents,skills,settings.json,plugins}` and user MCP servers in `claudeJsonPath`. */
export function scanUserConfig(claudeHome: string, claudeJsonPath?: string): ScannedConfig {
  const root = resolve(claudeHome);
  const ctx: Ctx = { tree: diskTree(root), abs: (rel) => join(root, rel), warnings: [] };
  const mcpServers = claudeJsonPath ? claudeJsonMcp(claudeJsonPath, undefined, ctx.warnings) : [];
  return build(
    root,
    'user',
    ctx,
    {
      instructions: instruction(ctx, 'CLAUDE.md', 'user'),
      agents: agents(ctx, 'agents', 'user'),
      skills: [...skillsIn(ctx, 'skills', 'user'), ...pluginSkills(ctx)],
      mcpServers,
    },
    settings(ctx, [{ rel: 'settings.json', scope: 'user' }]),
  );
}

/** Project config from any file tree (disk or a git commit). Local-scope MCP is not included. */
export function scanProjectTree(
  root: string,
  tree: FileTree,
  warnings: string[] = [],
): ScannedConfig {
  const ctx: Ctx = { tree, abs: (rel) => join(root, rel), warnings };
  const mcpServers: McpServerConfig[] = [];
  const mcpBuf = tree.read('.mcp.json');
  if (mcpBuf) {
    const path = ctx.abs('.mcp.json');
    const doc = parseJsonObject(mcpBuf.toString('utf8'), path, warnings);
    if (doc) mcpServers.push(...mcpServerNames(doc.mcpServers, 'project', path, warnings));
  }
  return build(
    root,
    'project',
    ctx,
    {
      instructions: [
        ...instruction(ctx, 'CLAUDE.md', 'project'),
        ...instruction(ctx, '.claude/CLAUDE.md', 'project'),
        ...instruction(ctx, 'CLAUDE.local.md', 'local'),
        ...nestedInstructions(ctx),
      ],
      agents: agents(ctx, '.claude/agents', 'project'),
      skills: skillsIn(ctx, '.claude/skills', 'project'),
      mcpServers,
    },
    settings(ctx, [
      { rel: '.claude/settings.json', scope: 'project' },
      { rel: '.claude/settings.local.json', scope: 'local' },
    ]),
  );
}

/** Scan a project: CLAUDE.md chain, `.claude/{agents,skills,settings.json,settings.local.json}`, `.mcp.json`, local-scope MCP in `claudeJsonPath`. */
export function scanProjectConfig(root: string, claudeJsonPath?: string): ScannedConfig {
  const abs = resolve(root);
  const c = scanProjectTree(abs, diskTree(abs));
  if (claudeJsonPath) {
    c.mcpServers.push(...claudeJsonMcp(claudeJsonPath, abs, c.warnings));
    c.mcpServers.sort(mcpOrder);
  }
  return c;
}
