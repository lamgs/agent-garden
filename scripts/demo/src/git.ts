/** Builds each demo project as a real git repo whose history contains the harness changes. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type McpDef, json, renderAgent, renderSkill } from './config';
import { type Era, type ProjectSpec } from './projects';
import { DAY, iso, startOfUtcDay } from './rng';

const GIT_ENV_BASE: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  LANG: 'C',
};

function git(cwd: string, args: string[], at?: number): string {
  const env: NodeJS.ProcessEnv = { ...GIT_ENV_BASE };
  if (at !== undefined) {
    env.GIT_AUTHOR_DATE = iso(at);
    env.GIT_COMMITTER_DATE = iso(at);
  }
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Demo',
      '-c',
      'user.email=demo@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'init.defaultBranch=main',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function write(root: string, rel: string, content: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export function mcpJson(servers: McpDef[]): string {
  const out: Record<string, unknown> = {};
  for (const s of servers) out[s.name] = { command: s.command, args: s.args };
  return json({ mcpServers: out });
}

export function projectSettings(era: Era): string {
  const settings: Record<string, unknown> = {
    model: era.model,
    permissions: {
      allow: era.allow,
      deny: ['Read(./.env)', 'Bash(git push --force:*)'],
      ...(era.defaultMode ? { defaultMode: era.defaultMode } : {}),
    },
  };
  if (era.testHook) {
    settings.hooks = {
      PostToolUse: [
        {
          matcher: 'Edit|Write',
          hooks: [{ type: 'command', command: era.testHook, timeout: 120 }],
        },
      ],
    };
  }
  return json(settings);
}

function writeHarness(root: string, era: Era, previous?: Era): void {
  write(root, 'CLAUDE.md', era.claudeMd);
  write(root, '.claude/settings.json', projectSettings(era));
  if (previous) {
    for (const a of previous.agents)
      rmSync(join(root, '.claude/agents', `${a.name}.md`), { force: true });
    for (const s of previous.skills)
      rmSync(join(root, '.claude/skills', s.dir), { recursive: true, force: true });
  }
  for (const a of era.agents) write(root, `.claude/agents/${a.name}.md`, renderAgent(a));
  for (const s of era.skills) write(root, `.claude/skills/${s.dir}/SKILL.md`, renderSkill(s));
  if (era.mcp.length > 0) write(root, '.mcp.json', mcpJson(era.mcp));
}

/** Create `<root>` as a git repo with backdated commits. Returns commit count. */
export function buildRepo(root: string, p: ProjectSpec, now: number): number {
  mkdirSync(root, { recursive: true });
  git(root, ['init', '-q']);
  const day0 = startOfUtcDay(now);
  type Ev = { at: number; run: () => string };
  const events: Ev[] = [];
  p.eras.forEach((era, i) => {
    events.push({
      at: era.from,
      run: () => {
        if (i === 0) {
          for (const [rel, content] of Object.entries(p.sourceFiles)) write(root, rel, content);
          write(root, '.gitignore', 'node_modules/\n.env\n.env.*\n__pycache__/\n.venv/\n');
        }
        writeHarness(root, era, p.eras[i - 1]);
        return era.commit;
      },
    });
  });
  for (const [daysAgo, subject, rel, line] of p.sourceCommits) {
    events.push({
      at: day0 - daysAgo * DAY + 14 * 3_600_000 + daysAgo * 37_000,
      run: () => {
        appendFileSync(join(root, rel), line + '\n');
        return subject;
      },
    });
  }
  events.sort((a, b) => a.at - b.at);
  for (const ev of events) {
    const msg = ev.run();
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '--allow-empty', '-m', msg], ev.at);
  }
  return events.length;
}

/** Commit hash of HEAD. */
export function gitHead(root: string): string {
  return git(root, ['rev-parse', 'HEAD']).trim();
}

/** `git log` as [isoDate, subject] pairs, newest first. */
export function gitLog(root: string): [string, string][] {
  return git(root, ['log', '--format=%aI%x09%s'])
    .trim()
    .split('\n')
    .map((l) => l.split('\t') as [string, string]);
}
