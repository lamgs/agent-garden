import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { gitHead, gitLog } from './git';
import {
  DEFAULT_NOW,
  type DemoManifest,
  generateDemo,
  plantedSecretValues,
  projectSlug,
  storyDates,
} from './index';

type Line = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const KNOWN_TYPES = new Set(['user', 'assistant', 'attachment', 'system']);
const SRC_DIR = import.meta.dirname;

function walk(dir: string, skipGit = true): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (skipGit && name === '.git') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, skipGit));
    else out.push(p);
  }
  return out;
}

const readJsonl = (p: string): Line[] =>
  readFileSync(p, 'utf8')
    .trimEnd()
    .split('\n')
    .map((l) => JSON.parse(l) as Line);

interface Session {
  path: string;
  project: string;
  lines: Line[];
  subagents: { path: string; meta: Line; lines: Line[] }[];
}

function loadSessions(m: DemoManifest): Session[] {
  const sessions: Session[] = [];
  for (const [project, root] of Object.entries(m.projectRoots)) {
    const dir = join(m.claudeHome, 'projects', projectSlug(root));
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(dir, name);
      const subDir = join(dir, name.replace(/\.jsonl$/, ''), 'subagents');
      const subagents: Session['subagents'] = [];
      let subNames: string[];
      try {
        subNames = readdirSync(subDir).sort();
      } catch {
        subNames = [];
      }
      for (const s of subNames) {
        if (!s.endsWith('.jsonl')) continue;
        const sp = join(subDir, s);
        subagents.push({
          path: sp,
          meta: JSON.parse(readFileSync(sp.replace(/\.jsonl$/, '.meta.json'), 'utf8')) as Line,
          lines: readJsonl(sp),
        });
      }
      sessions.push({ path, project, lines: readJsonl(path), subagents });
    }
  }
  return sessions;
}

const allLines = (ss: Session[]) =>
  ss.flatMap((s) => [...s.lines, ...s.subagents.flatMap((a) => a.lines)]);
const prompts = (s: Session) =>
  s.lines.filter(
    (l) => l.type === 'user' && typeof l.message.content === 'string' && !l.isCompactSummary,
  );

describe('demo dataset (default scale)', () => {
  let out: string;
  let m: DemoManifest;
  let sessions: Session[];
  let elapsed: number;

  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), 'garden-demo-'));
    const t0 = Date.now();
    m = await generateDemo(out);
    elapsed = Date.now() - t0;
    sessions = loadSessions(m);
  }, 60_000);

  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it('is fast, modest in size, and has counts in range', () => {
    expect(elapsed).toBeLessThan(10_000);
    const bytes = walk(out).reduce((a, p) => a + statSync(p).size, 0);
    expect(bytes).toBeLessThan(60 * 1024 * 1024);
    expect(m.counts.runs).toBeGreaterThanOrEqual(1500);
    expect(m.counts.runs).toBeLessThanOrEqual(2500);
    expect(m.counts.subagentRuns).toBeGreaterThan(300);
    expect(m.counts.sessions).toBe(sessions.length);
    expect(m.counts.lines).toBe(allLines(sessions).length);
    expect(Object.keys(m.projectRoots)).toHaveLength(6);
  });

  it('writes parseable lines with known types, common fields, and an intact parentUuid chain', () => {
    for (const s of sessions) {
      for (const file of [s.lines, ...s.subagents.map((a) => a.lines)]) {
        const seen = new Set<string>();
        for (const l of file) {
          expect(KNOWN_TYPES.has(l.type)).toBe(true);
          for (const k of [
            'uuid',
            'sessionId',
            'timestamp',
            'cwd',
            'gitBranch',
            'version',
            'entrypoint',
            'isSidechain',
            'userType',
          ]) {
            expect(l[k], `${k} in ${s.path}`).toBeDefined();
          }
          expect(l.cwd).toBe(m.projectRoots[s.project]);
          expect(l.version).toBe('2.1.293');
          if (l.parentUuid !== null) expect(seen.has(l.parentUuid)).toBe(true);
          seen.add(l.uuid);
        }
      }
      expect(s.lines.slice(0, 4).map((l) => l.attachment?.type)).toEqual([
        'deferred_tools_delta',
        'agent_listing_delta',
        'mcp_instructions_delta',
        'skill_listing',
      ]);
    }
  });

  it('splits API responses across lines that repeat the identical usage', () => {
    const byId = new Map<string, string[]>();
    for (const l of allLines(sessions)) {
      if (l.type !== 'assistant') continue;
      expect(l.message.content).toHaveLength(1);
      expect(l.requestId).toMatch(/^req_/);
      expect(l.effort).toBeDefined();
      const u = l.message.usage;
      for (const k of [
        'input_tokens',
        'output_tokens',
        'cache_read_input_tokens',
        'cache_creation_input_tokens',
      ]) {
        expect(typeof u[k]).toBe('number');
      }
      expect(
        u.cache_creation.ephemeral_5m_input_tokens + u.cache_creation.ephemeral_1h_input_tokens,
      ).toBe(u.cache_creation_input_tokens);
      expect(u.output_tokens_details.thinking_tokens).toBeLessThanOrEqual(u.output_tokens);
      const list = byId.get(l.message.id) ?? [];
      list.push(JSON.stringify(u));
      byId.set(l.message.id, list);
    }
    let multi = 0;
    for (const usages of byId.values()) {
      expect(new Set(usages).size).toBe(1);
      if (usages.length > 1) multi++;
    }
    expect(multi / byId.size).toBeGreaterThan(0.4);
    // Context of tens of thousands of tokens, with cache reads growing within a session.
    const legacy = sessions.find(
      (s) => s.project === 'legacy-monolith' && prompts(s).length >= 3,
    ) as Session;
    const reads = legacy.lines
      .filter((l) => l.type === 'assistant')
      .map((l) => l.message.usage.cache_read_input_tokens);
    expect(Math.max(...reads)).toBeGreaterThan(40_000);
    expect(reads[reads.length - 1]).toBeGreaterThan(reads[0]);
  });

  it('links every subagent transcript to an Agent tool_use and tool_result in its parent', () => {
    let n = 0;
    for (const s of sessions) {
      for (const sub of s.subagents) {
        n++;
        const agentId = sub.path.match(/agent-(a[0-9a-f]+)\.jsonl$/)?.[1];
        expect(sub.meta).toMatchObject({
          spawnDepth: 1,
          requestShape: 'standard',
          requestNonInteractive: false,
        });
        expect(sub.lines[0]?.parentUuid).toBeNull();
        expect(sub.lines[0]?.type).toBe('user');
        for (const l of sub.lines) {
          expect(l.isSidechain).toBe(true);
          expect(l.agentId).toBe(agentId);
          expect(l.sessionId).toBe(s.lines[0]?.sessionId);
        }
        const use = s.lines.find(
          (l) =>
            l.type === 'assistant' &&
            l.message.content[0].type === 'tool_use' &&
            l.message.content[0].id === sub.meta.toolUseId,
        );
        expect(use?.message.content[0].name).toBe('Agent');
        expect(use?.message.content[0].input.subagent_type).toBe(sub.meta.agentType);
        const res = s.lines.find(
          (l) =>
            l.type === 'user' &&
            Array.isArray(l.message.content) &&
            l.message.content[0]?.tool_use_id === sub.meta.toolUseId,
        );
        expect(res?.toolUseResult).toMatchObject({ agentId, status: 'completed' });
        const lastText = sub.lines.at(-1)?.message.content[0].text;
        expect(res?.message.content[0].content[0].text).toBe(lastText);
      }
    }
    expect(n).toBe(m.counts.subagentRuns);
  });

  it('commits the harness changes at the story dates', () => {
    const d = storyDates(Date.parse(DEFAULT_NOW));
    const shop = gitLog(m.projectRoots['shop-api'] as string);
    const season = shop.find(([, s]) => s === 'Tighten CLAUDE.md and add test hook');
    expect(season).toBeDefined();
    expect(Date.parse(season?.[0] as string)).toBe(d.shopSeason);
    expect(Date.parse(DEFAULT_NOW) - d.shopSeason).toBeGreaterThan(44 * 86_400_000);
    const dash = gitLog(m.projectRoots['web-dashboard'] as string);
    expect(
      Date.parse(dash.find(([, s]) => s === 'Switch default model to sonnet')?.[0] as string),
    ).toBe(d.dashboardModelSwitch);
    expect(dash.some(([, s]) => s === 'Add api-docs skill')).toBe(true);
    const shopRoot = m.projectRoots['shop-api'] as string;
    expect(readFileSync(join(shopRoot, 'CLAUDE.md'), 'utf8').length).toBeLessThan(3000);
    expect(
      JSON.parse(readFileSync(join(shopRoot, '.claude/settings.json'), 'utf8')).hooks.PostToolUse[0]
        .matcher,
    ).toBe('Edit|Write');
    expect(
      readFileSync(join(m.projectRoots['legacy-monolith'] as string, 'CLAUDE.md'), 'utf8').length,
    ).toBeGreaterThan(28_000);
  });

  it('writes user config, ~/.claude.json without identity, and garden.yaml', () => {
    const cj = JSON.parse(readFileSync(m.claudeJsonPath, 'utf8'));
    expect(Object.keys(cj.mcpServers)).toEqual(['github']);
    expect(cj.oauthAccount).toBeUndefined();
    expect(cj.userID).toBeUndefined();
    expect(Object.keys(cj.projects[m.projectRoots['data-pipeline'] as string].mcpServers)).toEqual([
      'warehouse',
    ]);
    const settings = JSON.parse(readFileSync(join(m.claudeHome, 'settings.json'), 'utf8'));
    expect(settings.hooks.PostToolUse[0].hooks[0].type).toBe('command');
    const tw = readFileSync(join(m.claudeHome, 'agents/test-writer.md'), 'utf8');
    expect(tw).toMatch(/^---\nname: test-writer\ndescription: .+\ntools: .+\nmodel: inherit\n---/);
    expect(readFileSync(join(m.claudeHome, 'skills/misc-helpers/SKILL.md'), 'utf8')).not.toMatch(
      /description:/,
    );

    const g = parse(readFileSync(m.gardenYamlPath, 'utf8'));
    expect(g.loops.map((l: Line) => [l.name, l.every, l.match])).toEqual([
      ['nightly-flaky-triage', '1d', 'Triage flaky'],
      ['dependency-update-sweep', '7d', 'Dependency update sweep'],
    ]);
    expect(g.playbooks[0].steps).toEqual([
      { id: 'changelog', skill: 'changelog-writer', gate: 'step_success' },
      { id: 'tests', skill: 'run-tests', gate: 'tests_pass' },
      { id: 'tag', skill: 'tag-release', gate: { command_ok: 'git tag' } },
    ]);
  });

  it('tells the loop stories: nightly, runaway, and dead', () => {
    const now = Date.parse(DEFAULT_NOW);
    const d = storyDates(now);
    const firstPrompt = (s: Session) => prompts(s)[0];
    const nightly = sessions.filter(
      (s) => s.project === 'shop-api' && firstPrompt(s)?.message.content.startsWith('Triage flaky'),
    );
    expect(nightly.length).toBeGreaterThanOrEqual(85);
    for (const s of nightly) {
      expect(s.lines[0]?.entrypoint).toBe('sdk-cli');
      expect(firstPrompt(s)?.origin).toBeUndefined();
      expect(new Date(firstPrompt(s)?.timestamp).getUTCHours()).toBe(2);
    }
    const backfills = sessions
      .filter((s) => s.project === 'data-pipeline' && s.lines[0]?.entrypoint === 'sdk-cli')
      .map((s) => Date.parse(firstPrompt(s)?.timestamp));
    const burst = backfills.filter(
      (t) => t >= d.runawayStart && t < d.runawayStart + 2 * 3_600_000,
    );
    expect(burst.length).toBeGreaterThanOrEqual(35);
    const sweeps = sessions.filter(
      (s) =>
        s.project === 'infra' &&
        firstPrompt(s)?.message.content.startsWith('Dependency update sweep'),
    );
    expect(sweeps.length).toBeGreaterThanOrEqual(6);
    const lastSweep = Math.max(...sweeps.map((s) => Date.parse(firstPrompt(s)?.timestamp)));
    expect(now - lastSweep).toBeGreaterThan(34 * 86_400_000);
  });

  it('records the observed harness change (model and skill listing)', () => {
    const d = storyDates(Date.parse(DEFAULT_NOW));
    const dash = sessions.filter((s) => s.project === 'web-dashboard');
    for (const s of dash) {
      const t = Date.parse(s.lines[0]?.timestamp);
      const models = new Set(
        s.lines.filter((l) => l.type === 'assistant').map((l) => l.message.model),
      );
      expect(models.has(t < d.dashboardModelSwitch ? 'claude-opus-5-5' : 'claude-sonnet-5-5')).toBe(
        true,
      );
      const skills: string[] = s.lines[3]?.attachment.names;
      expect(skills.includes('api-docs')).toBe(t >= d.dashboardSkillAdded);
    }
  });

  it('includes compaction, interrupts, tool errors, and the release playbook', () => {
    const lines = allLines(sessions);
    const boundaries = sessions.flatMap((s) =>
      s.lines.flatMap((l, i) =>
        l.type === 'system' && l.subtype === 'compact_boundary'
          ? [[l, s.lines[i + 1] as Line] as const]
          : [],
      ),
    );
    expect(boundaries.length).toBeGreaterThanOrEqual(2);
    for (const [b, next] of boundaries) {
      expect(b.compactMetadata.trigger).toBe('auto');
      expect(b.compactMetadata.preTokens).toBeGreaterThan(100_000);
      expect(next.isCompactSummary).toBe(true);
    }
    const interrupts = lines.filter(
      (l) =>
        l.type === 'user' &&
        Array.isArray(l.message.content) &&
        String(l.message.content[0]?.text).startsWith('[Request interrupted by user'),
    );
    expect(interrupts.length).toBeGreaterThanOrEqual(2);
    const errors = lines.filter(
      (l) =>
        l.type === 'user' &&
        Array.isArray(l.message.content) &&
        l.message.content[0]?.is_error === true,
    );
    expect(errors.length).toBeGreaterThan(20);

    const releases = sessions
      .filter((s) => prompts(s)[0]?.message.content.startsWith('Cut release'))
      .sort((a, b) => Date.parse(a.lines[0]?.timestamp) - Date.parse(b.lines[0]?.timestamp));
    expect(releases.length).toBe(5);
    const skillsUsed = (s: Session) =>
      s.lines
        .filter((l) => l.type === 'assistant' && l.message.content[0].name === 'Skill')
        .map((l) => l.message.content[0].input.skill);
    expect(skillsUsed(releases[0] as Session)).toEqual([
      'changelog-writer',
      'run-tests',
      'tag-release',
    ]);
    const last = releases.at(-1) as Session;
    expect(skillsUsed(last)).toEqual(['changelog-writer', 'run-tests']);
    const testResult = last.lines
      .filter((l) => l.type === 'user' && Array.isArray(l.message.content))
      .at(-1);
    expect(testResult?.message.content[0].is_error).toBe(true);
  });

  it('plants the redaction-showcase secrets in transcripts but never in source', () => {
    const secrets = plantedSecretValues(42);
    const transcriptText = sessions.map((s) => readFileSync(s.path, 'utf8')).join('\n');
    for (const secret of secrets) expect(transcriptText).toContain(secret);
    for (const file of walk(SRC_DIR)) {
      const src = readFileSync(file, 'utf8');
      for (const secret of secrets)
        expect(src.includes(secret), `${file} contains a planted secret`).toBe(false);
      // Secret-shaped prefixes are assembled from fragments, so they never appear literally.
      expect(src).not.toMatch(new RegExp(`${'sk'}_${'live'}_|${'gh'}p_[A-Za-z0-9]`));
    }
  });
});

describe('determinism', () => {
  it('produces identical files for the same seed (modulo the output path)', async () => {
    const a = mkdtempSync(join(tmpdir(), 'garden-demo-a-'));
    const b = mkdtempSync(join(tmpdir(), 'garden-demo-b-'));
    const c = mkdtempSync(join(tmpdir(), 'garden-demo-c-'));
    try {
      const ma = await generateDemo(a, { seed: 7, scale: 0.15 });
      const mb = await generateDemo(b, { seed: 7, scale: 0.15 });
      await generateDemo(c, { seed: 8, scale: 0.15 });
      expect(ma.counts).toEqual(mb.counts);
      const norm = (root: string, s: string) =>
        s.split(projectSlug(root)).join('<SLUG>').split(root).join('<OUT>');
      const snapshot = (root: string) =>
        new Map(
          walk(root).map((p) => [
            norm(root, relative(root, p)),
            norm(root, readFileSync(p, 'utf8')),
          ]),
        );
      const sa = snapshot(a);
      const sb = snapshot(b);
      expect([...sa.keys()]).toEqual([...sb.keys()]);
      for (const [k, v] of sa) expect(sb.get(k), k).toBe(v);
      for (const name of Object.keys(ma.projectRoots)) {
        expect(gitHead(ma.projectRoots[name] as string)).toBe(
          gitHead(mb.projectRoots[name] as string),
        );
      }
      const sc = snapshot(c);
      expect([...sc.keys()]).not.toEqual([...sa.keys()]);
    } finally {
      for (const d of [a, b, c]) rmSync(d, { recursive: true, force: true });
    }
  }, 60_000);
});
