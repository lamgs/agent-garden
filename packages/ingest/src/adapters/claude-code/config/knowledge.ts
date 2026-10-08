/**
 * Knowledge scanner (milestone K): for one bed, every knowledge source Claude Code can load, how it
 * loads (always / on demand / path-scoped / not loaded), and the references between sources.
 *
 * Load chain (CC 2.1.293, docs/sources.md "Knowledge sources"):
 *   managed  <managedDir>/CLAUDE.md, <managedDir>/.claude/rules/**.md
 *   user     ~/.claude/CLAUDE.md, ~/.claude/rules/**.md
 *   project  for each dir from / down to the bed root: CLAUDE.md, .claude/CLAUDE.md, .claude/rules/**.md,
 *            CLAUDE.local.md (AGENTS.md instead when the project has no CLAUDE.md)
 *   memory   <claudeHome>/projects/<slug(root)>/memory/MEMORY.md (first 200 lines / 25,000 bytes)
 *   + `@path` imports of all of the above (depth < 5), loaded with their importer
 *   on demand: subdirectory CLAUDE.md, rules with `paths:`, memory topic files, skills, agents, docs
 *
 * Pre-redaction output: plain strings. Content never leaves this module: only sizes, line counts,
 * sha256 content hashes, and sha256 passage hashes (the pipeline re-keys those with the install HMAC).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  KnowledgeEdge,
  KnowledgeKind,
  KnowledgeLayer,
  KnowledgeLoadMode,
  KnowledgeScan,
  KnowledgeScope,
  KnowledgeSnapshot,
  KnowledgeSource,
} from '@garden/core';
import {
  IMPORT_MAX_DEPTH,
  MEMORY_INDEX_MAX_BYTES,
  MEMORY_INDEX_MAX_LINES,
  SKILL_LISTING_DESC_CHARS,
  layerOf,
} from '@garden/core';
import { contentHash, stableId } from '../../../ids';
import type { Unredacted } from '../../../redact';
import type { HarnessCommit, ScannedConfig } from '../contracts';
import {
  extractImports,
  extractLinks,
  extractMentions,
  looksLikeFile,
  memoryIndexCut,
  passages,
  ruleGlobs,
} from './knowledge-text';
import { isRecord, parseFrontmatter, parseJsonObject } from './parse';
import type { FileTree } from './tree';

export type RawKnowledgeSource = Unredacted<KnowledgeSource>;
export type RawKnowledgeEdge = Unredacted<KnowledgeEdge>;

export interface RawKnowledge {
  scan: Unredacted<KnowledgeScan>;
  sources: RawKnowledgeSource[];
  edges: RawKnowledgeEdge[];
  snapshots: Unredacted<KnowledgeSnapshot>[];
}

/** Claude Code's managed-policy directory per platform (verified in the binary). */
export function defaultManagedDir(platform = process.platform): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode';
  return '/etc/claude-code';
}

/** `~/.claude/projects/<slug>`: every non-alphanumeric character of the path replaced by '-'. */
export const projectSlug = (root: string): string => root.replace(/[^a-zA-Z0-9]/g, '-');

/** Files Claude Code reads as text in an @import (subset of its allow-list). */
const TEXT_EXT = new Set(
  '.md .txt .text .json .yaml .yml .toml .xml .csv .html .htm .css .scss .js .ts .tsx .jsx .mjs .cjs .py .rb .go .rs .java .kt .c .cc .cpp .h .hpp .cs .swift .sh .bash .zsh .sql .graphql .env.example .ini .cfg .conf'.split(
    ' ',
  ),
);
/** Above this, Claude Code skips an instruction file (4 MiB). */
export const MAX_INSTRUCTION_BYTES = 4 * 1024 * 1024;
const MAX_REFERENCED_DOCS = 60;
const MAX_MEMORY_FILES = 200;
const NESTED_MAX_DEPTH = 3;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'vendor']);
/** Bare file names too generic to call a dangling reference when not found. */
const GENERIC_NAMES = new Set([
  'claude.md',
  'claude.local.md',
  'agents.md',
  'memory.md',
  'skill.md',
  'readme.md',
  'changelog.md',
  'contributing.md',
  'license.md',
]);

export interface KnowledgeScanOptions {
  familyId: string;
  /** Bed (project) root. */
  root: string;
  /** ~/.claude */
  claudeHome: string;
  /** Home directory for `~/` (default: the parent of claudeHome). */
  homeDir?: string;
  managedDir?: string;
  /**
   * Stop the ancestor walk at this directory (it is scanned; its parents are not). Claude Code
   * walks to the filesystem root; the demo sets this so files above the demo folder (such as the
   * repo's own CLAUDE.md) do not leak into a synthetic dataset.
   */
  ancestorBoundary?: string;
  /** Override for the auto-memory folder (default: autoMemoryDirectory setting, else projects/<slug>/memory). */
  memoryDir?: string;
  claudeJsonPath?: string;
  user: ScannedConfig;
  project: ScannedConfig;
  /** Harness commits of the bed, oldest first (last-changed dates and the budget history). */
  commits: readonly HarnessCommit[];
  /** Per-commit always-loaded project layers (see projectLayersAt). */
  history?: readonly { at: string; sha: string; layers: Partial<Record<KnowledgeLayer, number>> }[];
  now: string;
}

interface FileFacts {
  abs: string;
  text: string;
  bytes: number;
  lines: number;
  hash: string;
  passageHashes: string[];
  mtime: string;
}

function readFacts(abs: string): FileFacts | undefined {
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX_INSTRUCTION_BYTES) return undefined;
    const buf = readFileSync(abs);
    const text = buf.toString('utf8');
    return {
      abs,
      text,
      bytes: buf.length,
      lines: text === '' ? 0 : text.replace(/\n$/, '').split('\n').length,
      hash: contentHash(buf),
      passageHashes: passages(text).map((p) => `${p.hash}:${p.bytes}`),
      mtime: st.mtime.toISOString(),
    };
  } catch {
    return undefined;
  }
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

function listMd(dir: string, recursive: boolean, depth = 0): string[] {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    const p = join(dir, n);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (recursive && depth < 6 && !SKIP_DIRS.has(n)) out.push(...listMd(p, true, depth + 1));
    } else if (n.toLowerCase().endsWith('.md')) out.push(p);
  }
  return out;
}

const within = (child: string, parent: string) => {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

/** Auto-memory folder: `autoMemoryDirectory` (user or local settings; ignored in project settings), else the default. */
export function memoryDirFor(root: string, claudeHome: string, homeDir: string): string {
  const fromSettings = (file: string): string | undefined => {
    try {
      const doc = parseJsonObject(readFileSync(file, 'utf8'), file, []);
      const v = doc?.autoMemoryDirectory;
      if (typeof v !== 'string' || !v.trim()) return undefined;
      return v.startsWith('~/') ? join(homeDir, v.slice(2)) : resolve(root, v);
    } catch {
      return undefined;
    }
  };
  return (
    fromSettings(join(root, '.claude', 'settings.local.json')) ??
    fromSettings(join(claudeHome, 'settings.json')) ??
    join(claudeHome, 'projects', projectSlug(root), 'memory')
  );
}

/** The one boolean read from ~/.claude.json for this: external @imports approved for the project. */
export function externalImportsApproved(claudeJsonPath: string | undefined, root: string): boolean {
  if (!claudeJsonPath) return false;
  try {
    const doc = parseJsonObject(readFileSync(claudeJsonPath, 'utf8'), claudeJsonPath, []);
    const projects = doc && isRecord(doc.projects) ? doc.projects : {};
    const p = projects[root];
    return isRecord(p) && p.hasClaudeMdExternalIncludesApproved === true;
  } catch {
    return false;
  }
}

/**
 * Always-loaded project bytes per layer in a file tree (a git commit): CLAUDE.md, .claude/CLAUDE.md,
 * CLAUDE.local.md, and rules without `paths`. Imports are not followed in history.
 */
export function projectLayersAt(tree: FileTree): Partial<Record<KnowledgeLayer, number>> {
  const out: Partial<Record<KnowledgeLayer, number>> = {};
  const add = (l: KnowledgeLayer, n: number) => (out[l] = (out[l] ?? 0) + n);
  for (const rel of ['CLAUDE.md', '.claude/CLAUDE.md']) {
    const b = tree.read(rel);
    if (b) add('project', b.length);
  }
  const local = tree.read('CLAUDE.local.md');
  if (local) add('local', local.length);
  const walk = (dir: string) => {
    for (const e of tree.list(dir)) {
      const rel = `${dir}/${e.name}`;
      if (e.isDir) walk(rel);
      else if (e.name.toLowerCase().endsWith('.md')) {
        const b = tree.read(rel);
        if (!b) continue;
        const fm = parseFrontmatter(b.toString('utf8'), rel, []);
        if (!ruleGlobs(fm?.paths)) add('rules', b.length);
      }
    }
  };
  walk('.claude/rules');
  return out;
}

/** Build the knowledge graph of one bed from the files on disk now. */
export function scanKnowledge(o: KnowledgeScanOptions): RawKnowledge {
  const root = resolve(o.root);
  const home = o.homeDir ?? dirname(resolve(o.claudeHome));
  const claudeHome = resolve(o.claudeHome);
  const managedDir = o.managedDir ?? defaultManagedDir();
  const memoryDir = o.memoryDir ?? memoryDirFor(root, claudeHome, home);
  const approved = externalImportsApproved(o.claudeJsonPath, root);
  const warnings: string[] = [];
  const sources = new Map<string, RawKnowledgeSource>(); // by absolute path
  const facts = new Map<string, FileFacts>();
  const edges: RawKnowledgeEdge[] = [];

  // Last change per project-relative path from git, else mtime.
  const lastCommit = new Map<string, string>();
  for (const c of o.commits) for (const p of c.changedPaths) lastCommit.set(p, c.at);

  const display = (abs: string): string => {
    if (within(abs, memoryDir)) return `memory/${relative(memoryDir, abs).split(sep).join('/')}`;
    if (within(abs, claudeHome))
      return `~/.claude/${relative(claudeHome, abs).split(sep).join('/')}`;
    if (within(abs, root)) return relative(root, abs).split(sep).join('/') || '.';
    if (within(abs, home)) return `~/${relative(home, abs).split(sep).join('/')}`;
    return abs;
  };

  const add = (
    abs: string,
    kind: KnowledgeKind,
    scope: KnowledgeScope,
    loadMode: KnowledgeLoadMode,
    extra: Partial<RawKnowledgeSource> = {},
  ): RawKnowledgeSource | undefined => {
    const existing = sources.get(abs);
    if (existing) return existing;
    const f = readFacts(abs);
    if (!f) return undefined;
    facts.set(abs, f);
    const relRoot = within(abs, root) ? relative(root, abs).split(sep).join('/') : undefined;
    const gitAt = relRoot ? lastCommit.get(relRoot) : undefined;
    const s: RawKnowledgeSource = {
      id: stableId('ks', o.familyId, abs),
      familyId: o.familyId,
      kind,
      scope,
      path: abs,
      displayPath: display(abs),
      bytes: f.bytes,
      lines: f.lines,
      alwaysBytes: loadMode === 'always' ? f.bytes : 0,
      loadMode,
      contentHash: f.hash,
      passageHashes: f.passageHashes,
      lastChangedAt: gitAt ?? f.mtime,
      changedVia: gitAt ? 'git' : 'mtime',
      ...extra,
    };
    sources.set(abs, s);
    return s;
  };

  const edge = (
    from: RawKnowledgeSource,
    kind: KnowledgeEdge['kind'],
    target: string,
    to: RawKnowledgeSource | undefined,
    extra: { beyondCap?: boolean; reason?: string; resolved?: boolean } = {},
  ) => {
    const id = stableId('ke', from.id, kind, target);
    if (edges.some((e) => e.id === id)) return;
    edges.push({
      id,
      familyId: o.familyId,
      fromId: from.id,
      ...(to ? { toId: to.id } : {}),
      kind,
      target,
      resolved: extra.resolved ?? to !== undefined,
      beyondCap: extra.beyondCap ?? false,
      ...(extra.reason ? { reason: extra.reason } : {}),
    });
  };

  const resolveRef = (target: string, fromAbs: string): string =>
    target.startsWith('~/')
      ? join(home, target.slice(2))
      : isAbsolute(target)
        ? target
        : resolve(dirname(fromAbs), target);

  /** Follow `@imports` of a loaded file (depth = hops from the root file). */
  const followImports = (from: RawKnowledgeSource, depth: number) => {
    const f = facts.get(from.path);
    if (!f || !f.text.includes('@')) return;
    for (const hit of extractImports(f.text)) {
      const abs = resolveRef(hit.target, from.path);
      const label = `@${hit.target}`;
      if (!isFile(abs)) {
        if (looksLikeFile(hit.target))
          edge(from, 'import', label, undefined, { reason: `no file at ${display(abs)}` });
        continue;
      }
      const ext = extname(abs).toLowerCase();
      const d = depth + 1;
      let mode: KnowledgeLoadMode = from.loadMode;
      let note: string | undefined;
      if (ext && !TEXT_EXT.has(ext)) {
        mode = 'not_loaded';
        note = 'Non-text file in an @import: Claude Code skips it.';
      } else if (d >= IMPORT_MAX_DEPTH) {
        mode = 'not_loaded';
        note = `Imported ${d} levels deep: Claude Code stops at depth ${IMPORT_MAX_DEPTH}.`;
      } else if (
        from.scope !== 'user' &&
        !within(abs, root) &&
        !within(abs, claudeHome) &&
        !approved
      ) {
        mode = 'not_loaded';
        note =
          'Outside the project: loads only after you approve external imports for this project (Claude Code asks once).';
      } else if (from.loadMode === 'not_loaded') {
        note = 'Its importer is not loaded.';
      } else {
        note = `Imported by ${from.displayPath}.`;
      }
      const existing = sources.get(abs);
      const target =
        existing ??
        add(abs, 'import', from.scope === 'memory' ? 'memory' : from.scope, mode, {
          importDepth: d,
          loadNote: note,
        });
      if (!target) {
        edge(from, 'import', label, undefined, { reason: 'unreadable or over 4 MiB' });
        continue;
      }
      edge(from, 'import', label, target);
      if (!existing && mode !== 'not_loaded') followImports(target, d);
    }
  };

  // ---- 1. managed, user ---------------------------------------------------------------------------
  const roots: RawKnowledgeSource[] = [];
  const push = (s: RawKnowledgeSource | undefined) => s && roots.push(s);
  push(add(join(managedDir, 'CLAUDE.md'), 'managed_claude_md', 'managed', 'always'));
  const rules = (dir: string, scope: KnowledgeScope) => {
    for (const abs of listMd(dir, true)) {
      const text = readFacts(abs)?.text ?? '';
      const fm = parseFrontmatter(text, abs, []);
      const globs = ruleGlobs(fm?.paths);
      push(
        add(abs, 'rule', scope, globs ? 'path_scoped' : 'always', {
          ...(globs
            ? {
                globs,
                loadNote: `Loads when the agent touches a file matching ${globs.join(', ')}.`,
              }
            : {}),
        }),
      );
    }
  };
  rules(join(managedDir, '.claude', 'rules'), 'managed');
  push(add(join(claudeHome, 'CLAUDE.md'), 'user_claude_md', 'user', 'always'));
  rules(join(claudeHome, 'rules'), 'user');

  // ---- 2. project: ancestors down to the root --------------------------------------------------------
  const dirs: string[] = [];
  const boundary = o.ancestorBoundary ? resolve(o.ancestorBoundary) : undefined;
  const insideBoundary =
    boundary !== undefined && (root === boundary || root.startsWith(boundary + sep));
  for (let d = root; ; d = dirname(d)) {
    dirs.unshift(d);
    if (dirname(d) === d || (insideBoundary && d === boundary)) break;
  }
  let hasProjectClaudeMd = false;
  for (const d of dirs) {
    const atRoot = d === root;
    for (const rel of ['CLAUDE.md', join('.claude', 'CLAUDE.md')]) {
      const abs = join(d, rel);
      if (abs === join(claudeHome, 'CLAUDE.md')) continue; // the user file, already added
      const s = add(
        abs,
        'project_claude_md',
        'project',
        'always',
        atRoot ? {} : { loadNote: 'Ancestor directory: loaded for every project below it.' },
      );
      if (s) {
        push(s);
        if (atRoot) hasProjectClaudeMd = true;
      }
    }
    rules(join(d, '.claude', 'rules'), 'project');
    push(add(join(d, 'CLAUDE.local.md'), 'local_claude_md', 'local', 'always'));
  }
  const agentsMd = join(root, 'AGENTS.md');
  if (isFile(agentsMd)) {
    push(
      add(agentsMd, 'project_claude_md', 'project', hasProjectClaudeMd ? 'not_loaded' : 'always', {
        loadNote: hasProjectClaudeMd
          ? 'AGENTS.md loads only when the project has no CLAUDE.md (default instructionFiles: claude-md-or-agents-md).'
          : 'Loaded in place of CLAUDE.md (the project has none).',
      }),
    );
  }

  // ---- 3. nested CLAUDE.md (on demand) and a basename index for mention lookups --------------------
  const mdByName = new Map<string, string[]>();
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(dir, n);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(n) || n.startsWith('.') || depth >= NESTED_MAX_DEPTH) continue;
        const nested = join(p, 'CLAUDE.md');
        push(
          add(nested, 'nested_claude_md', 'project', 'on_demand', {
            loadNote: `Loads when the agent works in ${display(p)}/.`,
          }),
        );
        walk(p, depth + 1);
      } else if (n.toLowerCase().endsWith('.md')) {
        const k = n.toLowerCase();
        mdByName.set(k, [...(mdByName.get(k) ?? []), p]);
      }
    }
  };
  if (existsSync(root)) walk(root, 0);

  // ---- 4. auto memory ------------------------------------------------------------------------------
  const indexAbs = join(memoryDir, 'MEMORY.md');
  const index = add(indexAbs, 'memory_index', 'memory', 'always');
  let indexCut: ReturnType<typeof memoryIndexCut> | undefined;
  if (index) {
    indexCut = memoryIndexCut(
      facts.get(indexAbs)!.text,
      MEMORY_INDEX_MAX_LINES,
      MEMORY_INDEX_MAX_BYTES,
    );
    index.alwaysBytes = indexCut.loadedBytes;
    if (indexCut.loadedBytes < index.bytes - 2)
      index.loadNote = `Only the first ${indexCut.loadedLines} lines (${indexCut.loadedBytes.toLocaleString('en-US')} bytes) load; Claude Code cuts MEMORY.md at ${MEMORY_INDEX_MAX_LINES} lines or ${MEMORY_INDEX_MAX_BYTES.toLocaleString('en-US')} bytes.`;
    roots.push(index);
  }
  const topics = listMd(memoryDir, true)
    .filter((p) => p !== indexAbs)
    .slice(0, MAX_MEMORY_FILES);
  for (const abs of topics) {
    const fm = parseFrontmatter(readFacts(abs)?.text ?? '', abs, []);
    const type = typeof fm?.type === 'string' ? fm.type : undefined;
    add(abs, 'memory_topic', 'memory', 'on_demand', {
      loadNote: 'Recalled when relevant (first 4,096 bytes) or read by the agent.',
      ...(type ? { memoryType: type } : {}),
    });
  }

  // ---- 5. imports of every root file ------------------------------------------------------------------
  for (const s of [...roots]) followImports(s, 0);

  // ---- 6. MEMORY.md links → topic files ------------------------------------------------------------
  if (index && indexCut) {
    const f = facts.get(indexAbs)!;
    const hits = [...extractLinks(f.text), ...extractMentions(f.text)];
    const seen = new Set<string>();
    for (const h of hits) {
      const abs = resolve(memoryDir, h.target);
      if (seen.has(abs) || abs === indexAbs) continue;
      seen.add(abs);
      const beyondCap = h.line > indexCut.loadedLines || h.byteOffset >= indexCut.cutAtByte;
      const to = sources.get(abs);
      edge(index, 'index_link', h.target, to, {
        beyondCap,
        ...(to ? {} : { reason: `no file ${h.target} in the memory folder` }),
      });
    }
  }

  // ---- 7. mentions of .md paths in instruction files → memory files and docs -------------------------
  let docs = 0;
  const instructionKinds = new Set<KnowledgeKind>([
    'managed_claude_md',
    'user_claude_md',
    'project_claude_md',
    'local_claude_md',
    'nested_claude_md',
    'rule',
    'import',
  ]);
  for (const s of [...sources.values()]) {
    if (!instructionKinds.has(s.kind)) continue;
    const f = facts.get(s.path);
    if (!f) continue;
    const seen = new Set<string>();
    for (const h of extractMentions(f.text)) {
      if (seen.has(h.target)) continue;
      seen.add(h.target);
      const t = h.target;
      const bare = !t.includes('/');
      const cands = [
        resolveRef(t, s.path),
        resolve(root, t),
        resolve(memoryDir, t.replace(/^(?:\.\/)?memory\//, '')),
        ...(bare ? (mdByName.get(t.toLowerCase()) ?? []) : []),
      ];
      const hit = cands.find((c) => isFile(c));
      if (!hit) {
        // A bare name ("PLAN.md") is only a broken pointer when it reads like a memory file: a
        // snake_case name, or "memory" on the same line. Generic names are never flagged.
        if (bare && GENERIC_NAMES.has(t.toLowerCase())) continue;
        const lineText = f.text.split('\n')[h.line - 1] ?? '';
        if (bare && !t.includes('_') && !/memor/i.test(lineText)) continue;
        edge(s, 'mention', t, undefined, {
          reason: 'no such file next to it, in the project, or in the memory folder',
        });
        continue;
      }
      if (hit === s.path) continue;
      let to = sources.get(hit);
      if (!to && docs < MAX_REFERENCED_DOCS && (within(hit, root) || within(hit, memoryDir))) {
        to = add(
          hit,
          'referenced_doc',
          within(hit, memoryDir) ? 'memory' : 'project',
          'on_demand',
          {
            loadNote: `Read when the agent follows the mention in ${s.displayPath}.`,
          },
        );
        if (to) docs++;
      }
      if (to) edge(s, 'mention', t, to);
    }
  }

  // ---- 8. skills and agents: the listing line is always loaded, the body on demand ----------------
  const listing = (name: string, description?: string) =>
    Buffer.byteLength(
      `- ${name}: ${(description ?? '').slice(0, SKILL_LISTING_DESC_CHARS)}`,
      'utf8',
    );
  for (const sk of [...o.user.skills, ...o.project.skills]) {
    const name = sk.plugin ? `${sk.plugin}:${sk.name}` : sk.name;
    const s = add(sk.path, 'skill', sk.scope === 'plugin' ? 'plugin' : sk.scope, 'on_demand', {
      name,
      loadNote:
        'Name and description are listed in every session; the body loads when the skill is invoked.',
    });
    if (s) s.alwaysBytes = listing(name, sk.description);
  }
  for (const a of [...o.user.agents, ...o.project.agents]) {
    const s = add(
      a.path,
      'agent_definition',
      a.scope === 'plugin' ? 'plugin' : a.scope,
      'on_demand',
      {
        name: a.name,
        loadNote:
          'Name and description are listed in every session; the body is the subagent’s prompt when it is spawned.',
      },
    );
    if (s) s.alwaysBytes = listing(a.name, a.description);
  }

  const all = [...sources.values()].sort((a, b) => a.displayPath.localeCompare(b.displayPath));

  // ---- 9. budget snapshots: per harness commit (project layers) and now (every layer) -------------
  const snapshots: Unredacted<KnowledgeSnapshot>[] = (o.history ?? []).map((h) => ({
    familyId: o.familyId,
    at: h.at,
    commitSha: h.sha,
    provenance: 'git' as const,
    layers: h.layers,
  }));
  const now: Partial<Record<KnowledgeLayer, number>> = {};
  for (const s of all) {
    const l = layerOf(s);
    if (l) now[l] = (now[l] ?? 0) + s.alwaysBytes;
  }
  snapshots.push({ familyId: o.familyId, at: o.now, provenance: 'current', layers: now });

  return {
    scan: {
      familyId: o.familyId,
      scannedAt: o.now,
      memoryDir,
      externalImportsApproved: approved,
      warnings,
    },
    sources: all,
    edges: edges.sort((a, b) => a.id.localeCompare(b.id)),
    snapshots,
  };
}
