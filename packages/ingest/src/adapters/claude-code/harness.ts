/**
 * Harness reconstruction (pre-redaction: bundles hold plain strings until the pipeline redacts them): the config bundle a run executed under.
 * Project config comes from git history at run time when available (provenance 'git'),
 * otherwise from the current files ('snapshot'); model/tools/listings come from the transcript.
 */
import type { HarnessBundle, HarnessDiff } from '@garden/core';
import { stableId } from '../../ids';
import type { Unredacted } from '../../redact';
import type { HarnessCommit, ObservedHarness, ScannedConfig } from './contracts';

export const agentId = (name: string): string => stableId('agt', name);
export const skillId = (name: string): string => stableId('skl', name);
export const familyId = (root: string): string => stableId('fam', root);

export function emptyConfig(root: string, scope: 'user' | 'project'): ScannedConfig {
  return {
    root,
    scope,
    instructions: [],
    agents: [],
    skills: [],
    hooks: [],
    mcpServers: [],
    permissions: { allow: [], deny: [] },
    warnings: [],
  };
}

export interface ConfigAtTime {
  config: ScannedConfig;
  commit?: HarnessCommit;
  provenance: 'git' | 'snapshot' | 'observed';
}

/** Project config in effect at `at`: the latest harness commit at or before `at`. */
export function projectConfigAt(
  commits: readonly HarnessCommit[],
  current: ScannedConfig,
  at: string,
): ConfigAtTime {
  if (commits.length === 0) {
    const hasFiles =
      current.instructions.length +
        current.agents.length +
        current.skills.length +
        current.hooks.length >
      0;
    return { config: current, provenance: hasFiles ? 'snapshot' : 'observed' };
  }
  const t = Date.parse(at);
  let found: HarnessCommit | undefined;
  for (const c of commits) {
    if (Date.parse(c.at) <= t) found = c;
    else break;
  }
  if (!found) return { config: emptyConfig(current.root, 'project'), provenance: 'observed' };
  return { config: found.snapshot, commit: found, provenance: 'git' };
}

/** Canonical name a skill is listed under (`plugin:name` for plugin skills). */
export const listedSkillName = (s: { name: string; plugin?: string }): string =>
  s.plugin ? `${s.plugin}:${s.name}` : s.name;

const uniqSorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

/**
 * Build the bundle. Identity-relevant only: entrypoint and observed permission mode vary per
 * session and are deliberately left out so they don't fragment seasons.
 */
/** Bundle before redaction. A stored HarnessBundle is assignable to this too. */
export type RawBundle = Unredacted<HarnessBundle>;

export function buildBundle(
  user: ScannedConfig,
  project: ScannedConfig,
  observed: ObservedHarness,
): RawBundle {
  const configSkills = [...user.skills, ...project.skills].map(listedSkillName);
  const configAgents = [...user.agents, ...project.agents].map((a) => a.name);
  const bundle: RawBundle = {
    instructions: [...user.instructions, ...project.instructions]
      .map((i) => ({ path: i.path, hash: i.hash, bytes: i.bytes }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    tools: uniqSorted(observed.tools.filter((t) => !t.startsWith('mcp__'))),
    skills: uniqSorted((observed.skills.length ? observed.skills : configSkills).map(skillId)),
    subagents: uniqSorted(
      (observed.subagentTypes.length ? observed.subagentTypes : configAgents).map(agentId),
    ),
    mcpServers: uniqSorted([
      ...observed.mcpServers,
      ...user.mcpServers.map((m) => m.name),
      ...project.mcpServers.map((m) => m.name),
    ]),
    hooks: [...user.hooks, ...project.hooks]
      .map((h) => ({
        event: h.event,
        ...(h.matcher ? { matcher: h.matcher } : {}),
        commandHash: h.commandHash,
      }))
      .sort((a, b) =>
        `${a.event}${a.matcher}${a.commandHash}`.localeCompare(
          `${b.event}${b.matcher}${b.commandHash}`,
        ),
      ),
  };
  const model = observed.model ?? project.model ?? user.model;
  if (model) bundle.model = model;
  if (observed.effort) bundle.effort = observed.effort;
  const mode = project.permissions.defaultMode ?? user.permissions.defaultMode;
  if (mode) bundle.permissionMode = mode;
  const settings = [user.settingsHash, project.settingsHash].filter(Boolean).join(':');
  if (settings) bundle.settingsHash = settings;
  return bundle;
}

/** Deterministic JSON (sorted keys) for hashing. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export const harnessVersionId = (famId: string, bundle: RawBundle): string =>
  stableId('hv', famId, canonicalJson(bundle));

const added = (a: readonly string[], b: readonly string[]) => b.filter((x) => !a.includes(x));

export function diffBundles(prev: RawBundle, next: RawBundle): HarnessDiff {
  const change = (a?: string, b?: string) =>
    a === b ? undefined : { ...(a ? { from: a } : {}), ...(b ? { to: b } : {}) };
  const diff: HarnessDiff = {
    toolsAdded: added(prev.tools, next.tools),
    toolsRemoved: added(next.tools, prev.tools),
    skillsAdded: added(prev.skills, next.skills),
    skillsRemoved: added(next.skills, prev.skills),
    mcpAdded: added(prev.mcpServers, next.mcpServers),
    mcpRemoved: added(next.mcpServers, prev.mcpServers),
    hooksChanged: canonicalJson(prev.hooks) !== canonicalJson(next.hooks),
    instructionBytesDelta:
      next.instructions.reduce((n, i) => n + i.bytes, 0) -
      prev.instructions.reduce((n, i) => n + i.bytes, 0),
  };
  const m = change(prev.model, next.model);
  if (m) diff.modelChanged = m;
  const e = change(prev.effort, next.effort);
  if (e) diff.effortChanged = e;
  const p = change(prev.permissionMode, next.permissionMode);
  if (p) diff.permissionModeChanged = p;
  return diff;
}

/** One-line summaries for the Seasons view. */
export function summarizeDiff(d: HarnessDiff): string[] {
  const out: string[] = [];
  if (d.modelChanged) out.push(`model ${d.modelChanged.from ?? '∅'} → ${d.modelChanged.to ?? '∅'}`);
  if (d.effortChanged)
    out.push(`effort ${d.effortChanged.from ?? '∅'} → ${d.effortChanged.to ?? '∅'}`);
  if (d.permissionModeChanged)
    out.push(
      `permissions ${d.permissionModeChanged.from ?? '∅'} → ${d.permissionModeChanged.to ?? '∅'}`,
    );
  if (d.instructionBytesDelta)
    out.push(
      `instructions ${d.instructionBytesDelta > 0 ? '+' : '−'}${Math.abs(d.instructionBytesDelta).toLocaleString('en-US')} bytes`,
    );
  if (d.hooksChanged) out.push('hooks changed');
  if (d.toolsAdded.length || d.toolsRemoved.length)
    out.push(`tools +${d.toolsAdded.length} −${d.toolsRemoved.length}`);
  if (d.skillsAdded.length || d.skillsRemoved.length)
    out.push(`skills +${d.skillsAdded.length} −${d.skillsRemoved.length}`);
  if (d.mcpAdded.length || d.mcpRemoved.length)
    out.push(`MCP +${d.mcpAdded.join(', +') || 0} −${d.mcpRemoved.join(', −') || 0}`);
  return out;
}
