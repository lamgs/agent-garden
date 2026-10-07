/**
 * Deterministic demo dataset: a fake person's Claude Code home (~/.claude, ~/.claude.json), six
 * project git repos, and a garden.yaml, all in real Claude Code formats (docs/sources.md).
 * Same seed and `now` => byte-identical output apart from absolute paths.
 */
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { stringify } from 'yaml';
import {
  MODEL_IDS,
  USER_AGENTS,
  USER_MCP,
  USER_SKILLS,
  type McpDef,
  json,
  renderAgent,
  renderSkill,
  userClaudeMd,
  userSettings,
} from './config';
import { buildRepo } from './git';
import { type ProjectSpec, buildProjects, eraAt, storyDates } from './projects';
import { DAY, HOUR, MINUTE, Rng, iso, startOfUtcDay } from './rng';
import { demoSecrets } from './secrets';
import {
  BACKFILL_PROMPT,
  CORRECTIONS,
  type Globals,
  type Intent,
  NIGHTLY_PROMPT,
  type S,
  SWEEP_PROMPT,
  type Task,
  backfillRun,
  baseContext,
  commitRun,
  curlSecretRun,
  envSecretRun,
  newTask,
  nightlyRun,
  releaseRun,
  remoteSecretRun,
  runawayRun,
  startAttachments,
  sweepRun,
  workRun,
} from './story';
import { type Line, TranscriptWriter } from './transcript';

export { demoSecrets, plantedSecretValues } from './secrets';
export { storyDates } from './projects';

export const DEFAULT_NOW = '2026-10-01T12:00:00Z';
export const DEFAULT_SEED = 42;

export interface DemoOptions {
  seed?: number;
  /** ISO timestamp the 90-day story ends at. */
  now?: string;
  /** Multiplier on interactive session volume (loops, releases, and story beats are unaffected). */
  scale?: number;
}

export interface DemoManifest {
  claudeHome: string;
  claudeJsonPath: string;
  homeDir: string;
  projectRoots: Record<string, string>;
  gardenYamlPath: string;
  counts: { sessions: number; runs: number; subagentRuns: number; lines: number };
}

/** `~/.claude/projects/<slug>`: the cwd with every non-alphanumeric character replaced by '-'. */
export const projectSlug = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-');

type PlanKind =
  | 'interactive'
  | 'long'
  | 'nightly'
  | 'backfill'
  | 'runaway'
  | 'sweep'
  | 'release'
  | 'secret-env'
  | 'secret-curl'
  | 'secret-remote';

interface Plan {
  project: string;
  start: number;
  kind: PlanKind;
  runs?: number;
  release?: { version: string; prev: string; pass: boolean };
}

const HEADLESS: ReadonlySet<PlanKind> = new Set(['nightly', 'backfill', 'runaway', 'sweep']);

const WAREHOUSE_MCP: McpDef = {
  name: 'warehouse',
  command: 'uvx',
  args: ['acme-warehouse-mcp', '--read-only'],
  tools: ['query', 'list_tables', 'describe_table'],
};

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function planSessions(projects: ProjectSpec[], now: number, seed: number, scale: number): Plan[] {
  const day0 = startOfUtcDay(now);
  const d = storyDates(now);
  const plans: Plan[] = [];
  for (const p of projects) {
    const rng = Rng.derive(seed, `plan:${p.name}`);
    for (let daysAgo = 90; daysAgo >= 1; daysAgo--) {
      const dayStart = day0 - daysAgo * DAY;
      const dow = new Date(dayStart).getUTCDay();
      const weekend = dow === 0 || dow === 6;
      const lambda = p.sessionsPerWeekday * scale * (weekend ? 0.15 : 1);
      let n = 0;
      for (let k = 0; k < 6; k++) if (rng.chance(lambda / 6)) n++;
      for (let k = 0; k < n; k++) {
        const start =
          dayStart + rng.int(13, 21) * HOUR + rng.int(0, 59) * MINUTE + rng.int(0, 59) * 1000;
        plans.push({
          project: p.name,
          start,
          kind: 'interactive',
          runs: Math.min(7, 1 + geometric(rng, 0.36)),
        });
      }
    }
  }
  const at = (daysAgo: number, hour: number, minute = 0) =>
    day0 - daysAgo * DAY + hour * HOUR + minute * MINUTE;

  // Long sessions that hit auto-compaction.
  for (const [project, daysAgo] of [
    ['legacy-monolith', 66],
    ['legacy-monolith', 31],
    ['legacy-monolith', 8],
    ['shop-api', 12],
  ] as const) {
    plans.push({ project, start: at(daysAgo, 13, 5), kind: 'long', runs: 11 });
  }

  // Loop (a): nightly flaky-test triage in shop-api, healthy.
  const loopRng = Rng.derive(seed, 'loops');
  for (let daysAgo = 89; daysAgo >= 0; daysAgo--) {
    plans.push({
      project: 'shop-api',
      start: at(daysAgo, 2, loopRng.int(0, 9)) + loopRng.int(0, 59) * 1000,
      kind: 'nightly',
    });
  }
  // Daily backfill in data-pipeline, which runs away ~10 days ago (loop b).
  const runawayDay = Math.round((day0 - startOfUtcDay(d.runawayStart)) / DAY);
  for (let daysAgo = 89; daysAgo >= 0; daysAgo--) {
    if (daysAgo === runawayDay) continue;
    plans.push({
      project: 'data-pipeline',
      start: at(daysAgo, 5, loopRng.int(0, 4)) + loopRng.int(0, 59) * 1000,
      kind: 'backfill',
    });
  }
  let t = d.runawayStart;
  for (let i = 0; i < 40; i++) {
    plans.push({ project: 'data-pipeline', start: t, kind: 'runaway' });
    t += loopRng.int(150, 200) * 1000;
  }
  // Loop (c): weekly dependency sweep in infra that stopped ~35 days ago.
  for (let s = d.sweepLast; s >= d.windowStart + DAY; s -= 7 * DAY) {
    plans.push({ project: 'infra', start: s + loopRng.int(0, 120) * 1000, kind: 'sweep' });
  }

  // Release playbook runs in shop-api; the most recent fails at the tests step.
  const releases = [78, 57, 36, 15, 3];
  releases.forEach((daysAgo, i) => {
    plans.push({
      project: 'shop-api',
      start: at(daysAgo, 12, 10),
      kind: 'release',
      release: { version: `v1.${i + 4}.0`, prev: `v1.${i + 3}.0`, pass: i < releases.length - 1 },
    });
  });

  // Redaction showcase.
  plans.push({ project: 'data-pipeline', start: at(52, 12, 30), kind: 'secret-env' });
  plans.push({ project: 'shop-api', start: at(21, 12, 40), kind: 'secret-curl' });
  plans.push({ project: 'infra', start: at(40, 12, 20), kind: 'secret-remote' });

  const order = new Map(projects.map((p, i) => [p.name, i]));
  return plans.sort(
    (a, b) =>
      (order.get(a.project) as number) - (order.get(b.project) as number) || a.start - b.start,
  );
}

function geometric(rng: Rng, p: number): number {
  let n = 0;
  while (!rng.chance(p) && n < 20) n++;
  return n;
}

function drawIntent(
  rng: Rng,
  rates: { success: number; failure: number; partial: number },
): Intent {
  return rng.weighted<Intent>([
    ['success', rates.success],
    ['failure', rates.failure],
    ['partial', rates.partial],
  ]);
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function interactiveSession(s: S, nRuns: number, long: boolean): void {
  const { w, rng } = s;
  let task: Task = newTask(s);
  let prev: Intent | undefined;
  let prevInterrupted = false;
  let mode: 'work' | 'commit' = 'work';
  for (let i = 0; i < nRuns; i++) {
    let intent = drawIntent(rng, s.p.mainRates(w.t));
    if (i === nRuns - 1 && rng.chance(0.08)) intent = 'unknown';
    let prompt = task.prompt;
    if (i > 0) {
      let gap: number;
      if (prev === 'failure') {
        gap = prevInterrupted ? rng.int(8, 50) * 1000 : rng.int(40, 240) * 1000;
        prompt = prevInterrupted
          ? `wrong file, the logic is in ${task.subject.file}`
          : rng.pick(CORRECTIONS);
        if (mode === 'commit') mode = 'work';
      } else {
        const r = rng.next();
        if (prev === 'success' && mode === 'work' && r < 0.35) {
          prompt = 'thanks, commit it';
          mode = 'commit';
          gap = rng.int(40, 300) * 1000;
        } else if (mode === 'work' && r < 0.6) {
          const next = newTask(s);
          task = {
            ...next,
            subject: task.subject,
            prompt: next.prompt.replace(next.subject.name, task.subject.name),
          };
          prompt = `great, now ${lowerFirst(task.prompt)}`;
          mode = 'work';
          gap = rng.int(60, 300) * 1000;
        } else {
          task = newTask(s);
          prompt = task.prompt;
          mode = 'work';
          gap = rng.int(8, 45) * MINUTE;
        }
      }
      if (long && w.context > 110_000) {
        w.compact(
          `This session is being continued from a previous conversation that ran out of context. Summary: we have been working on ${s.p.name}: ${task.subject.name} (${task.subject.file}). Recent changes were made and partially tested. Continue from the last request.`,
        );
      }
      w.advance(gap);
    }
    w.prompt(prompt, true);
    s.g.runs++;
    if (mode === 'commit') {
      commitRun(s, task, intent);
      prevInterrupted = false;
    } else {
      prevInterrupted = workRun(s, task, intent) === 'interrupted';
      if (prevInterrupted) intent = 'failure';
    }
    prev = intent;
    if (intent === 'unknown') break;
  }
}

export async function generateDemo(outDir: string, opts: DemoOptions = {}): Promise<DemoManifest> {
  const seed = opts.seed ?? DEFAULT_SEED;
  const now = Date.parse(opts.now ?? DEFAULT_NOW);
  if (Number.isNaN(now)) throw new Error(`invalid now: ${opts.now}`);
  const scale = opts.scale ?? 1;
  const out = resolve(outDir);
  const homeDir = join(out, 'home');
  const claudeHome = join(homeDir, '.claude');
  const claudeJsonPath = join(homeDir, '.claude.json');
  const gardenYamlPath = join(out, 'garden.yaml');

  // User-level config.
  writeFile(join(claudeHome, 'CLAUDE.md'), userClaudeMd());
  writeFile(join(claudeHome, 'settings.json'), userSettings());
  for (const a of USER_AGENTS)
    writeFile(join(claudeHome, 'agents', `${a.name}.md`), renderAgent(a));
  for (const s of USER_SKILLS)
    writeFile(join(claudeHome, 'skills', s.dir, 'SKILL.md'), renderSkill(s));

  // Projects as git repos.
  const projects = buildProjects(now, seed);
  const projectRoots: Record<string, string> = {};
  for (const p of projects) {
    const root = join(out, 'projects', p.name);
    projectRoots[p.name] = root;
    buildRepo(root, p, now);
  }

  // ~/.claude.json: user-scope MCP servers and a projects map (one local-scope server). No identity keys.
  const localMcp: Record<string, McpDef[]> = { 'data-pipeline': [WAREHOUSE_MCP] };
  const mcpEntry = (m: McpDef) => ({ type: 'stdio', command: m.command, args: m.args });
  const claudeJsonProjects: Record<string, unknown> = {};
  for (const p of projects) {
    const servers: Record<string, unknown> = {};
    for (const m of localMcp[p.name] ?? []) servers[m.name] = mcpEntry(m);
    claudeJsonProjects[projectRoots[p.name] as string] = {
      allowedTools: [],
      mcpServers: servers,
      hasTrustDialogAccepted: true,
    };
  }
  writeFile(
    claudeJsonPath,
    json({
      numStartups: 412,
      autoUpdates: true,
      mcpServers: Object.fromEntries(USER_MCP.map((m) => [m.name, mcpEntry(m)])),
      projects: claudeJsonProjects,
    }),
  );

  const g: Globals = {
    secrets: demoSecrets(seed),
    localMcp,
    interrupts: 0,
    runs: 0,
    subagentRuns: 0,
  };
  const plans = planSessions(projects, now, seed, scale);
  const byName = new Map(projects.map((p) => [p.name, p]));
  const lastEnd = new Map<string, number>();
  let sessions = 0;
  let lines = 0;

  plans.forEach((plan, idx) => {
    const p = byName.get(plan.project) as ProjectSpec;
    const root = projectRoots[p.name] as string;
    const headless = HEADLESS.has(plan.kind);
    let start = plan.start;
    if (!headless) {
      const prevEnd = lastEnd.get(p.name) ?? 0;
      if (start < prevEnd + 3 * MINUTE) start = prevEnd + (3 + (idx % 20)) * MINUTE;
    }
    if (start > now - 2 * HOUR) return;
    const era = eraAt(p, start);
    const rng = Rng.derive(seed, `session:${idx}:${p.name}:${plan.kind}`);
    const base = baseContext(p, era, g);
    const w = new TranscriptWriter({
      rng,
      sessionId: rng.uuid(),
      cwd: root,
      gitBranch:
        headless || plan.kind === 'release' ? (p.branches[0] as string) : rng.pick(p.branches),
      entrypoint: headless ? 'sdk-cli' : 'cli',
      model: MODEL_IDS[era.model],
      effort: p.effort,
      permissionMode: headless ? 'bypassPermissions' : era.permissionMode,
      start,
      baseContext: base,
      sharedCached: Math.round(base * 0.75),
    });
    const s: S = { w, p, era, root, rng, g, readScale: plan.kind === 'long' ? 6 : 1 };
    startAttachments(s);
    const date = iso(start - DAY).slice(0, 10);
    const single = (prompt: string, human: boolean, fn: () => void) => {
      w.prompt(prompt, human);
      g.runs++;
      fn();
    };
    switch (plan.kind) {
      case 'interactive':
      case 'long':
        interactiveSession(s, plan.runs ?? 3, plan.kind === 'long');
        break;
      case 'nightly':
        single(NIGHTLY_PROMPT, false, () => nightlyRun(s, date));
        break;
      case 'backfill':
        single(BACKFILL_PROMPT, false, () => backfillRun(s, date));
        break;
      case 'runaway':
        single(BACKFILL_PROMPT, false, () => runawayRun(s, date));
        break;
      case 'sweep':
        single(SWEEP_PROMPT, false, () => sweepRun(s));
        break;
      case 'release': {
        const r = plan.release as NonNullable<Plan['release']>;
        single(
          `Cut release ${r.version}: update the changelog, run the tests, and tag it`,
          true,
          () => releaseRun(s, r.version, r.prev, r.pass),
        );
        break;
      }
      case 'secret-env':
        single(
          "The local backfill can't connect to the warehouse. Can you check my env setup?",
          true,
          () => envSecretRun(s),
        );
        break;
      case 'secret-curl':
        single(
          'Hit the staging orders endpoint and check whether the new discount field shows up',
          true,
          () => curlSecretRun(s),
        );
        break;
      case 'secret-remote':
        single('Why does git push keep asking for credentials in this repo?', true, () =>
          remoteSecretRun(s),
        );
        break;
    }
    if (!headless) lastEnd.set(p.name, w.t);

    const sessionId = w.opts.sessionId;
    const dir = join(claudeHome, 'projects', projectSlug(root));
    const mtime = new Date(w.t);
    const mainPath = join(dir, `${sessionId}.jsonl`);
    writeFile(mainPath, toJsonl(w.lines));
    utimesSync(mainPath, mtime, mtime);
    lines += w.lines.length;
    for (const sub of w.subagents) {
      const base = join(dir, sessionId, 'subagents', `agent-${sub.agentId}`);
      writeFile(`${base}.jsonl`, toJsonl(sub.lines));
      writeFile(`${base}.meta.json`, JSON.stringify(sub.meta) + '\n');
      lines += sub.lines.length;
    }
    sessions++;
  });

  writeFile(gardenYamlPath, gardenYaml());

  return {
    claudeHome,
    claudeJsonPath,
    homeDir,
    projectRoots,
    gardenYamlPath,
    counts: { sessions, runs: g.runs + g.subagentRuns, subagentRuns: g.subagentRuns, lines },
  };
}

const toJsonl = (lines: Line[]): string => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

export function gardenYaml(): string {
  const doc = {
    playbooks: [
      {
        name: 'release',
        project: 'shop-api',
        steps: [
          { id: 'changelog', skill: 'changelog-writer', gate: 'step_success' },
          { id: 'tests', skill: 'run-tests', gate: 'tests_pass' },
          { id: 'tag', skill: 'tag-release', gate: { command_ok: 'git tag' } },
        ],
      },
    ],
    loops: [
      {
        name: 'nightly-flaky-triage',
        project: 'shop-api',
        agent: 'main',
        trigger: 'cron',
        every: '1d',
        match: 'Triage flaky',
      },
      {
        name: 'dependency-update-sweep',
        project: 'infra',
        agent: 'main',
        trigger: 'cron',
        every: '7d',
        match: 'Dependency update sweep',
      },
    ],
  };
  return (
    '# Agent Garden config for the demo dataset (generated by scripts/demo).\n' + stringify(doc)
  );
}
