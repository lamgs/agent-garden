import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { Agent, HarnessVersion, LoopTier, Run, Step } from '@garden/core';
import { HEURISTIC_VERSION, scoreSignals } from '@garden/core';
import type { Adapter, AdapterContext, Census, NormalizedRecord } from '../../adapter';
import { stableId } from '../../ids';
import type { Unredacted } from '../../redact';
import { gitHarnessHistory, gitRoot, scanProjectConfig, scanUserConfig } from './config';
import type {
  AgentDefinition,
  HarnessCommit,
  ParsedRun,
  ParsedSession,
  ScannedConfig,
} from './contracts';
import { durationSeconds, loadGardenConfig, type GardenConfig } from './garden-yaml';
import {
  agentId,
  buildBundle,
  emptyConfig,
  familyId,
  harnessVersionId,
  listedSkillName,
  projectConfigAt,
  skillId,
  type RawBundle,
} from './harness';
import { detectSessionOutcomes } from './outcomes';
import { parseSession } from './transcript';

export const ADAPTER_ID = 'claude-code';
export const ADAPTER_VERSION = '1';

/** Built-in subagent types (observed in `agent_listing_delta.builtInTypes`, CC 2.1.293). */
export const BUILTIN_SUBAGENTS = [
  'Explore',
  'general-purpose',
  'Plan',
  'claude',
  'claude-code-guide',
  'statusline-setup',
];

export interface ClaudeCodeOptions {
  /** Default ~/.claude */
  claudeHome?: string;
  /** Default ~/.claude.json (only MCP server names are read). */
  claudeJsonPath?: string;
  /** Optional garden.yaml with playbooks, declared loops, pricing overrides. */
  gardenYamlPath?: string;
  /** Re-parse every session even if unchanged. */
  full?: boolean;
}

interface Family {
  id: string;
  root: string;
  name: string;
  current: ScannedConfig;
  commits: HarnessCommit[];
}

interface SessionFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export class ClaudeCodeAdapter implements Adapter {
  readonly id = ADAPTER_ID;
  readonly version = ADAPTER_VERSION;
  readonly claudeHome: string;
  readonly claudeJsonPath: string;
  readonly garden: GardenConfig;
  private readonly families = new Map<string, Family>();
  private readonly rootByCwd = new Map<string, string>();
  private userConfig?: ScannedConfig;

  constructor(private readonly opts: ClaudeCodeOptions = {}) {
    this.claudeHome = opts.claudeHome ?? join(homedir(), '.claude');
    this.claudeJsonPath = opts.claudeJsonPath ?? join(homedir(), '.claude.json');
    this.garden = loadGardenConfig(opts.gardenYamlPath);
  }

  get projectsDir(): string {
    return join(this.claudeHome, 'projects');
  }

  /** Main transcripts: `projects/<slug>/<sessionId>.jsonl`. Size/mtime include subagent files. */
  sessionFiles(): SessionFile[] {
    if (!existsSync(this.projectsDir)) return [];
    const out: SessionFile[] = [];
    for (const slug of readdirSync(this.projectsDir).sort()) {
      const dir = join(this.projectsDir, slug);
      if (!statSync(dir).isDirectory()) continue;
      for (const f of readdirSync(dir).sort()) {
        if (!f.endsWith('.jsonl')) continue;
        const path = join(dir, f);
        const st = statSync(path);
        let size = st.size;
        let mtimeMs = st.mtimeMs;
        const subDir = join(dir, f.replace(/\.jsonl$/, ''), 'subagents');
        if (existsSync(subDir)) {
          for (const s of readdirSync(subDir)) {
            const sst = statSync(join(subDir, s));
            size += sst.size;
            mtimeMs = Math.max(mtimeMs, sst.mtimeMs);
          }
        }
        out.push({ path, size, mtimeMs });
      }
    }
    return out;
  }

  private user(): ScannedConfig {
    this.userConfig ??= existsSync(this.claudeHome)
      ? scanUserConfig(this.claudeHome, this.claudeJsonPath)
      : emptyConfig(this.claudeHome, 'user');
    return this.userConfig;
  }

  private family(cwd: string): Family {
    let root = this.rootByCwd.get(cwd);
    if (!root) {
      root = (existsSync(cwd) ? gitRoot(cwd) : undefined) ?? cwd;
      this.rootByCwd.set(cwd, root);
    }
    let fam = this.families.get(root);
    if (!fam) {
      const exists = existsSync(root);
      fam = {
        id: familyId(root),
        root,
        name: basename(root) || root,
        current: exists
          ? scanProjectConfig(root, this.claudeJsonPath)
          : emptyConfig(root, 'project'),
        commits: exists ? gitHarnessHistory(root) : [],
      };
      this.families.set(root, fam);
    }
    return fam;
  }

  async *read(ctx: AdapterContext): AsyncIterable<NormalizedRecord> {
    const sourceId = stableId('src', ADAPTER_ID, this.claudeHome);
    yield {
      type: 'source',
      value: {
        id: sourceId,
        adapter: ADAPTER_ID,
        root: this.claudeHome,
        adapterVersion: ADAPTER_VERSION,
      },
    };

    const user = this.user();
    user.warnings.forEach((w) => ctx.warn(`user config: ${w}`));
    const emittedFamilies = new Set<string>();
    const emittedVersions = new Set<string>();
    const seenAgents = new Map<string, { first: string; last: string; kind: Agent['kind'] }>();
    const definitions = new Map<string, AgentDefinition>();
    for (const a of user.agents) definitions.set(a.name, a);

    for (const file of this.sessionFiles()) {
      const prev = ctx.fileState(file.path);
      if (!this.opts.full && prev && prev.size === file.size && prev.mtimeMs === file.mtimeMs)
        continue;
      let session: ParsedSession;
      try {
        session = await parseSession(file.path);
      } catch (e) {
        ctx.warn(`${file.path}: ${(e as Error).message}`);
        continue;
      }
      session.warnings.forEach((w) => ctx.warn(`${basename(file.path)}: ${w}`));
      if (session.runs.length === 0) {
        yield {
          type: 'file_state',
          value: { adapter: ADAPTER_ID, ...file, byteOffset: file.size },
        };
        continue;
      }

      const sessionFam = this.family(session.cwd);
      for (const fam of [sessionFam, ...session.runs.map((r) => this.family(r.cwd))]) {
        if (emittedFamilies.has(fam.id)) continue;
        emittedFamilies.add(fam.id);
        fam.current.warnings.forEach((w) => ctx.warn(`${fam.name} config: ${w}`));
        for (const a of fam.current.agents) definitions.set(a.name, a); // project shadows user
        yield { type: 'family', value: { id: fam.id, name: fam.name, projectRoot: fam.root } };
      }

      yield {
        type: 'session',
        value: {
          id: session.id,
          sourceId,
          familyId: sessionFam.id,
          path: session.path,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          ...(session.cliVersion ? { cliVersion: session.cliVersion } : {}),
          ...(session.entrypoint ? { entrypoint: session.entrypoint } : {}),
          ...(session.gitBranch ? { gitBranch: session.gitBranch } : {}),
        },
      };

      const outcomes = detectSessionOutcomes(session);
      // Parents before children so harness/agent records precede runs that reference them.
      for (const run of session.runs) {
        const fam = this.family(run.cwd);
        const at = projectConfigAt(fam.commits, fam.current, run.startedAt);
        const bundle = buildBundle(user, at.config, run.observed);
        const hvId = harnessVersionId(fam.id, bundle);
        if (!emittedVersions.has(hvId)) {
          emittedVersions.add(hvId);
          yield {
            type: 'harness_version',
            value: harnessRecord(hvId, fam.id, run.startedAt, at, bundle),
          };
        }
        const seen = seenAgents.get(run.agentName);
        if (!seen) {
          seenAgents.set(run.agentName, {
            first: run.startedAt,
            last: run.endedAt,
            kind: run.kind,
          });
          yield {
            type: 'agent',
            value: agentRecord(run.agentName, run.kind, run.startedAt, run.endedAt, definitions),
          };
        } else {
          if (run.startedAt < seen.first) seen.first = run.startedAt;
          if (run.endedAt > seen.last) seen.last = run.endedAt;
        }
        yield { type: 'run', value: runRecord(run, fam.id, hvId) };
        for (const step of run.steps) yield { type: 'step', value: stepRecord(step, run.id) };
        const signals = outcomes.get(run.id) ?? [];
        const { label, score } = scoreSignals(signals);
        yield {
          type: 'outcome',
          value: { runId: run.id, label, score, heuristicVersion: HEURISTIC_VERSION, signals },
        };
      }
      yield { type: 'file_state', value: { adapter: ADAPTER_ID, ...file, byteOffset: file.size } };
    }

    // Definitions (incl. agents never run, which become "orphan" weeds), with seen ranges.
    const now = new Date().toISOString();
    for (const name of new Set([...definitions.keys(), ...seenAgents.keys()])) {
      const seen = seenAgents.get(name);
      yield {
        type: 'agent',
        value: agentRecord(
          name,
          seen?.kind ?? (name === 'main' ? 'main' : 'subagent'),
          seen?.first ?? now,
          seen?.last ?? now,
          definitions,
        ),
      };
    }
    // Skills: user scope, then every project family touched (this pass or not, families map only has this pass).
    const allSkills = [
      ...user.skills,
      ...[...this.families.values()].flatMap((f) => f.current.skills),
    ];
    for (const s of allSkills) {
      const name = listedSkillName(s);
      yield {
        type: 'skill',
        value: {
          id: skillId(name),
          name,
          dirName: s.dirName,
          scope: s.scope,
          path: s.path,
          contentHash: s.contentHash,
          ...(s.description ? { description: s.description } : {}),
        },
      };
    }
    yield* this.configLoops(user);
    yield* this.declared();
  }

  /** Hooks are loop machinery: each configured hook is a loop on the verification clock. */
  private *configLoops(user: ScannedConfig): Iterable<NormalizedRecord> {
    const allFamilyIds = [...this.families.values()].map((f) => f.id);
    const scopes: { cfg: ScannedConfig; familyIds: string[] }[] = [
      { cfg: user, familyIds: allFamilyIds },
      ...[...this.families.values()].map((f) => ({ cfg: f.current, familyIds: [f.id] })),
    ];
    for (const { cfg, familyIds } of scopes) {
      for (const h of cfg.hooks) {
        const tier: LoopTier =
          h.event === 'UserPromptSubmit' || h.event === 'SessionStart' ? 'agent' : 'verification';
        yield {
          type: 'loop',
          value: {
            id: stableId('loop', 'hook', cfg.root, h.event, h.matcher, h.commandHash),
            name: `${h.event} hook${h.matcher ? ` (${h.matcher})` : ''}`,
            tier,
            provenance: 'config',
            trigger: {
              kind: 'hook',
              detail: `${h.scope} ${h.event}${h.matcher ? ` matcher=${h.matcher}` : ''} (${h.type})`,
            },
            targets: { agentIds: [], familyIds },
          },
        };
      }
    }
  }

  private *declared(): Iterable<NormalizedRecord> {
    const famByName = new Map([...this.families.values()].map((f) => [f.name, f.id]));
    for (const l of this.garden.loops) {
      yield {
        type: 'loop',
        value: {
          id: stableId('loop', 'declared', l.name),
          name: l.name,
          tier: 'application',
          provenance: 'declared',
          trigger: {
            kind: l.trigger,
            detail:
              [l.every && `every ${l.every}`, l.match && `match "${l.match}"`]
                .filter(Boolean)
                .join(', ') || 'declared',
          },
          ...(l.every ? { expectedIntervalSec: durationSeconds(l.every) } : {}),
          targets: {
            agentIds: [agentId(l.agent)],
            familyIds: l.project && famByName.has(l.project) ? [famByName.get(l.project)!] : [],
          },
        },
      };
    }
    for (const p of this.garden.playbooks) {
      yield {
        type: 'playbook',
        value: {
          id: stableId('pb', p.name),
          name: p.name,
          source: 'garden.yaml',
          steps: p.steps.map((s) => ({
            id: s.id,
            ...(s.skill ? { skillId: skillId(s.skill) } : {}),
            ...(s.agent ? { agentId: agentId(s.agent) } : {}),
            gate: s.gate,
          })),
        },
      };
    }
  }

  async inspect(): Promise<Census> {
    const census: Census = {
      adapter: ADAPTER_ID,
      roots: [],
      recordTypes: {},
      unknownFields: {},
      versions: {},
      warnings: [],
    };
    const files = this.sessionFiles();
    census.roots.push({
      path: this.projectsDir,
      exists: existsSync(this.projectsDir),
      files: files.length,
      bytes: files.reduce((n, f) => n + f.size, 0),
    });
    for (const p of ['agents', 'skills', 'settings.json', 'CLAUDE.md', 'plugins']) {
      const path = join(this.claudeHome, p);
      census.roots.push({
        path,
        exists: existsSync(path),
        files: existsSync(path) && statSync(path).isDirectory() ? readdirSync(path).length : 0,
        bytes: 0,
      });
    }
    census.roots.push({
      path: this.claudeJsonPath,
      exists: existsSync(this.claudeJsonPath),
      files: 0,
      bytes: 0,
    });
    const add = (into: Record<string, number>, from: Record<string, number>) => {
      for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
    };
    let runs = 0;
    let subagentRuns = 0;
    for (const f of files) {
      try {
        const s = await parseSession(f.path);
        add(census.recordTypes, s.census.recordTypes);
        add(census.unknownFields, s.census.unknownFields);
        add(census.versions, s.census.versions);
        runs += s.runs.length;
        subagentRuns += s.runs.filter((r) => r.kind === 'subagent').length;
        census.warnings.push(...s.warnings.slice(0, 5).map((w) => `${basename(f.path)}: ${w}`));
      } catch (e) {
        census.warnings.push(`${basename(f.path)}: failed to parse: ${(e as Error).message}`);
      }
    }
    census.recordTypes['derived.runs'] = runs;
    census.recordTypes['derived.subagent_runs'] = subagentRuns;
    const user = this.user();
    census.recordTypes['config.user.agents'] = user.agents.length;
    census.recordTypes['config.user.skills'] = user.skills.length;
    census.recordTypes['config.user.hooks'] = user.hooks.length;
    census.recordTypes['config.user.mcp_servers'] = user.mcpServers.length;
    census.warnings.push(...user.warnings);
    return census;
  }
}

function harnessRecord(
  id: string,
  famId: string,
  at: string,
  cfg: ReturnType<typeof projectConfigAt>,
  bundle: RawBundle,
): Unredacted<HarnessVersion> {
  return {
    id,
    familyId: famId,
    // Provisional; store/derive.ts recomputes validity across all runs of the family.
    validFrom: at,
    provenance: cfg.provenance,
    bundle,
    ...(cfg.commit ? { commit: { sha: cfg.commit.sha, message: cfg.commit.message } } : {}),
  };
}

function agentRecord(
  name: string,
  kind: Agent['kind'],
  first: string,
  last: string,
  definitions: Map<string, AgentDefinition>,
): Unredacted<Agent> {
  const def = definitions.get(name);
  const rec: Unredacted<Agent> = {
    id: agentId(name),
    name,
    kind,
    firstSeenAt: first,
    lastSeenAt: last,
  };
  if (def) {
    rec.definition = {
      scope: def.scope,
      path: def.path,
      contentHash: def.contentHash,
      ...(def.description ? { description: def.description } : {}),
      ...(def.tools ? { tools: def.tools } : {}),
      ...(def.model ? { model: def.model } : {}),
    };
  } else if (BUILTIN_SUBAGENTS.includes(name)) {
    rec.definition = { scope: 'builtin', contentHash: 'builtin' };
  }
  return rec;
}

function runRecord(run: ParsedRun, famId: string, hvId: string): Unredacted<Run> {
  return {
    id: run.id,
    sessionId: run.sessionId,
    agentId: agentId(run.agentName),
    familyId: famId,
    harnessVersionId: hvId,
    ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
    ...(run.parentStepId ? { parentStepId: run.parentStepId } : {}),
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    trigger: run.trigger,
    taskPreview: run.taskText,
    models: run.models,
    tokens: run.tokens,
    stepCount: run.stepCount,
    toolCallCount: run.toolCallCount,
    errorCount: run.errorCount,
    compactionCount: run.compactionCount,
    peakContextTokens: run.peakContextTokens,
  };
}

function stepRecord(step: ParsedRun['steps'][number], runId: string): Unredacted<Step> {
  const rec: Unredacted<Step> = {
    id: step.id,
    runId,
    seq: step.seq,
    at: step.at,
    kind: step.kind,
    loopTier: step.loopTier,
  };
  if (step.preview !== undefined) rec.preview = step.preview;
  if (step.tool) {
    const { skillName, ...tool } = step.tool;
    rec.tool = { ...tool, ...(skillName ? { skillId: skillId(skillName) } : {}) };
  }
  if (step.apiMessageId) rec.apiMessageId = step.apiMessageId;
  if (step.tokens) rec.tokens = step.tokens;
  if (step.contextTokens !== undefined) rec.contextTokens = step.contextTokens;
  if (step.error) rec.error = step.error;
  if (step.compaction) rec.compaction = step.compaction;
  if (step.childRunId) rec.childRunId = step.childRunId;
  return rec;
}
