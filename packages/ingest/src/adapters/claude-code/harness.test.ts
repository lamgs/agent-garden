import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HarnessCommit, ObservedHarness, ScannedConfig } from './contracts';
import { durationSeconds, loadGardenConfig } from './garden-yaml';
import {
  buildBundle,
  canonicalJson,
  diffBundles,
  emptyConfig,
  harnessVersionId,
  projectConfigAt,
  summarizeDiff,
} from './harness';

const observed = (o: Partial<ObservedHarness> = {}): ObservedHarness => ({
  tools: ['Bash', 'Read', 'mcp__github__get_me'],
  skills: ['run-tests'],
  subagentTypes: ['Explore'],
  mcpServers: ['github'],
  model: 'claude-sonnet-5-5',
  ...o,
});
const cfg = (o: Partial<ScannedConfig> = {}): ScannedConfig => ({
  ...emptyConfig('/repo', 'project'),
  ...o,
});
const commit = (at: string, snapshot: ScannedConfig): HarnessCommit => ({
  sha: at,
  at,
  message: 'm',
  changedPaths: [],
  snapshot,
});

describe('projectConfigAt', () => {
  const a = cfg({
    instructions: [{ path: 'CLAUDE.md', scope: 'project', bytes: 30000, hash: 'a' }],
  });
  const b = cfg({
    instructions: [{ path: 'CLAUDE.md', scope: 'project', bytes: 2000, hash: 'b' }],
  });
  const commits = [commit('2026-08-01T00:00:00Z', a), commit('2026-09-01T00:00:00Z', b)];
  it('picks the latest commit at or before the run', () => {
    expect(projectConfigAt(commits, b, '2026-08-15T00:00:00Z').config).toBe(a);
    expect(projectConfigAt(commits, b, '2026-09-01T00:00:00Z').config).toBe(b);
    expect(projectConfigAt(commits, b, '2026-09-20T00:00:00Z').provenance).toBe('git');
  });
  it('before the first commit, the project had no tracked harness', () => {
    const at = projectConfigAt(commits, b, '2026-07-01T00:00:00Z');
    expect(at.provenance).toBe('observed');
    expect(at.config.instructions).toEqual([]);
  });
  it('without git, uses the current files', () => {
    expect(projectConfigAt([], b, '2026-07-01T00:00:00Z').provenance).toBe('snapshot');
    expect(projectConfigAt([], cfg(), '2026-07-01T00:00:00Z').provenance).toBe('observed');
  });
});

describe('bundles', () => {
  const user = {
    ...emptyConfig('/home/.claude', 'user' as const),
    hooks: [
      {
        event: 'Stop',
        type: 'command',
        commandHash: 'h1',
        sourcePath: 's',
        scope: 'user' as const,
      },
    ],
  };
  it('excludes MCP tools from tools (servers tracked separately) and is order-independent', () => {
    const b1 = buildBundle(user, cfg(), observed());
    const b2 = buildBundle(
      user,
      cfg(),
      observed({ tools: ['mcp__github__get_me', 'Read', 'Bash'] }),
    );
    expect(b1.tools).toEqual(['Bash', 'Read']);
    expect(harnessVersionId('f', b1)).toBe(harnessVersionId('f', b2));
  });
  it('changes identity when model or instructions change', () => {
    const base = buildBundle(user, cfg(), observed());
    expect(
      harnessVersionId('f', buildBundle(user, cfg(), observed({ model: 'claude-opus-5-5' }))),
    ).not.toBe(harnessVersionId('f', base));
    const withDoc = cfg({
      instructions: [{ path: 'CLAUDE.md', scope: 'project', bytes: 10, hash: 'x' }],
    });
    expect(harnessVersionId('f', buildBundle(user, withDoc, observed()))).not.toBe(
      harnessVersionId('f', base),
    );
  });
  it('falls back to configured skills/agents when nothing was observed', () => {
    const p = cfg({
      skills: [
        { name: 'deploy', dirName: 'deploy', scope: 'project', path: 'p', contentHash: 'c' },
      ],
    });
    expect(buildBundle(user, p, observed({ skills: [] })).skills).toHaveLength(1);
  });
  it('diffs and summarizes', () => {
    const a = buildBundle(
      user,
      cfg({ instructions: [{ path: 'CLAUDE.md', scope: 'project', bytes: 30000, hash: 'a' }] }),
      observed({ model: 'claude-opus-5-5' }),
    );
    const b = buildBundle(
      user,
      cfg({ instructions: [{ path: 'CLAUDE.md', scope: 'project', bytes: 2000, hash: 'b' }] }),
      observed({ mcpServers: ['github', 'linear'] }),
    );
    const d = diffBundles(a, b);
    expect(d.modelChanged).toEqual({ from: 'claude-opus-5-5', to: 'claude-sonnet-5-5' });
    expect(d.instructionBytesDelta).toBe(-28000);
    expect(d.mcpAdded).toEqual(['linear']);
    expect(d.settingsChanged).toBe(false);
    expect(
      diffBundles({ ...a, settingsHash: 'x' }, { ...a, settingsHash: 'y' }).settingsChanged,
    ).toBe(true);
    expect(summarizeDiff(d)).toEqual([
      'model claude-opus-5-5 → claude-sonnet-5-5',
      'instructions −28,000 bytes',
      'MCP +linear −0',
    ]);
  });
  it('canonicalJson sorts keys and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: [{ d: undefined, c: 2 }] })).toBe('{"a":[{"c":2}],"b":1}');
  });
});

describe('garden.yaml', () => {
  const dir = mkdtempSync(join(tmpdir(), 'garden-yaml-'));
  it('missing file → empty config', () =>
    expect(loadGardenConfig(join(dir, 'nope.yaml')).loops).toEqual([]));
  it('parses playbooks, loops, gates, pricing', () => {
    const p = join(dir, 'garden.yaml');
    writeFileSync(
      p,
      `playbooks:
  - name: release
    steps:
      - { id: changelog, skill: changelog-writer }
      - { id: tests, skill: run-tests, gate: tests_pass }
      - { id: tag, agent: release-manager, gate: { command_ok: "git tag" } }
loops:
  - { name: nightly, project: shop-api, trigger: cron, every: 1d, match: "Triage flaky" }
pricing:
  my-model: { input: 1, output: 2, cacheRead: 0.1 }
`,
    );
    const g = loadGardenConfig(p);
    expect(g.playbooks[0]!.steps.map((s) => s.gate)).toEqual([
      { kind: 'step_success' },
      { kind: 'tests_pass' },
      { kind: 'command_ok', pattern: 'git tag' },
    ]);
    expect(g.loops[0]).toMatchObject({ agent: 'main', trigger: 'cron', every: '1d' });
    expect(g.pricing['my-model']!.contextWindow).toBe(1_000_000);
  });
  it('rejects invalid files with a readable message', () => {
    const p = join(dir, 'bad.yaml');
    writeFileSync(p, 'loops:\n  - { name: x, every: often }\n');
    expect(() => loadGardenConfig(p)).toThrow(/loops\.0\.every/);
  });
  it('durations', () => {
    expect(durationSeconds('30m')).toBe(1800);
    expect(durationSeconds('1w')).toBe(604800);
  });
});
