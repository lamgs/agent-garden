import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { plantedSecrets } from '../../../redact/planted-secrets';
import { gitHarnessHistory, gitRoot, scanProjectConfig, scanUserConfig } from './index';

const tmpRoots: string[] = [];
function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'garden-config-')));
  tmpRoots.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

function put(root: string, rel: string, content: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

const secret =
  plantedSecrets('cfg')[0]?.secret ?? ['sk', 'ant', 'fallback', 'Z'.repeat(40)].join('-');
const fakeEmail = ['decoy.person', 'example.invalid'].join('@');
const hookCommand = ['curl -H "Authorization: Bearer', secret, '"'].join(' ');

function fakeClaudeHome(): { home: string; claudeJson: string; project: string } {
  const base = tmp();
  const home = join(base, '.claude');
  const project = join(base, 'proj');
  put(home, 'CLAUDE.md', '# user instructions\n');
  put(
    home,
    'agents/reviewer.md',
    '---\nname: code-reviewer\ndescription: Reviews diffs\ntools: Read, Grep ,Glob\nmodel: sonnet\ncolor: blue\npermissionMode: plan\n---\nYou review code.\n',
  );
  put(
    home,
    'agents/tester.md',
    '---\ndescription: Writes tests\ntools:\n  - Read\n  - " Bash "\n---\nbody\n',
  );
  put(home, 'agents/plain.md', 'No frontmatter here.\n');
  put(home, 'agents/notes.txt', 'not an agent');
  put(
    home,
    'skills/session-start-hook/SKILL.md',
    '---\nname: startup-hook-skill\ndescription: Hooks\n---\nbody\n',
  );
  put(home, 'skills/nodesc/SKILL.md', '---\nname: nodesc\n---\nbody\n');
  put(home, 'skills/empty-dir/README.md', 'no SKILL.md');
  put(
    home,
    'plugins/marketplaces/acme/plugins/doc-tools/skills/pdf/SKILL.md',
    '---\nname: pdf\ndescription: PDFs\n---\n',
  );
  put(
    home,
    'plugins/cache/acme/doc-tools/1.2.0/skills/pdf/SKILL.md',
    '---\nname: pdf\ndescription: PDFs\n---\n',
  );
  put(
    home,
    'plugins/cache/acme/renamed-dir/0.1.0/.claude-plugin/plugin.json',
    JSON.stringify({ name: 'fancy-plugin' }),
  );
  put(
    home,
    'plugins/cache/acme/renamed-dir/0.1.0/skills/xlsx/SKILL.md',
    '---\ndescription: Sheets\n---\n',
  );
  put(
    home,
    'settings.json',
    JSON.stringify({
      model: 'claude-opus-5-5',
      env: { ANTHROPIC_API_KEY: secret, OTHER: 'x' },
      apiKeyHelper: `echo ${secret}`,
      permissions: {
        allow: ['Bash(git status)', 'Read'],
        deny: ['Bash(rm:*)'],
        defaultMode: 'acceptEdits',
      },
      hooks: {
        PostToolUse: [
          {
            matcher: 'Write|Edit',
            hooks: [
              { type: 'command', command: 'pnpm lint', timeout: 60 },
              { type: 'command', command: hookCommand },
            ],
          },
        ],
        // Variant without the inner `hooks` wrapper.
        Stop: [{ type: 'prompt', prompt: 'Are you done?' }],
      },
    }),
  );
  const claudeJson = join(base, '.claude.json');
  writeFileSync(
    claudeJson,
    JSON.stringify({
      oauthAccount: { emailAddress: fakeEmail, accountUuid: 'decoy-uuid-1234' },
      userID: 'decoy-user-id-5678',
      mcpServers: {
        github: { command: 'gh-mcp', env: { GITHUB_TOKEN: secret } },
        remote: { url: 'https://mcp.example.invalid', headers: { Authorization: secret } },
      },
      projects: {
        [project]: {
          mcpServers: { localdb: { type: 'stdio', command: 'db', args: [secret] } },
          history: [{ display: fakeEmail }],
        },
      },
    }),
  );
  return { home, claudeJson, project };
}

describe('scanUserConfig', () => {
  const { home, claudeJson } = fakeClaudeHome();
  const c = scanUserConfig(home, claudeJson);

  it('reads CLAUDE.md as path/bytes/hash only', () => {
    expect(c.scope).toBe('user');
    expect(c.instructions).toHaveLength(1);
    expect(c.instructions[0]).toMatchObject({
      path: join(home, 'CLAUDE.md'),
      scope: 'user',
      bytes: 20,
    });
    expect(c.instructions[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('parses agents with string, array, and missing frontmatter', () => {
    expect(c.agents.map((a) => a.name)).toEqual(['code-reviewer', 'plain', 'tester']);
    const [reviewer, plain, tester] = c.agents;
    expect(reviewer).toMatchObject({
      description: 'Reviews diffs',
      tools: ['Read', 'Grep', 'Glob'],
      model: 'sonnet',
      scope: 'user',
      extraKeys: ['color', 'permissionMode'],
    });
    expect(tester?.tools).toEqual(['Read', 'Bash']);
    expect(plain).toMatchObject({ name: 'plain', extraKeys: [] });
    expect(plain?.description).toBeUndefined();
    expect(plain?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('parses skills: frontmatter name wins over dir name; plugin skills namespaced', () => {
    const summary = c.skills.map((s) => [s.scope, s.plugin, s.name, s.dirName]);
    expect(summary).toEqual([
      ['user', undefined, 'nodesc', 'nodesc'],
      ['plugin', 'doc-tools', 'pdf', 'pdf'],
      ['user', undefined, 'startup-hook-skill', 'session-start-hook'],
      ['plugin', 'fancy-plugin', 'xlsx', 'xlsx'],
    ]);
    expect(c.skills.find((s) => s.name === 'nodesc')?.description).toBeUndefined();
  });

  it('parses hooks in both shapes, keeping hashes only', () => {
    expect(c.hooks.map((h) => [h.event, h.matcher, h.type])).toEqual([
      ['PostToolUse', 'Write|Edit', 'command'],
      ['PostToolUse', 'Write|Edit', 'command'],
      ['Stop', undefined, 'prompt'],
    ]);
    for (const h of c.hooks) {
      expect(h.commandHash).toMatch(/^[0-9a-f]{64}$/);
      expect(h.scope).toBe('user');
      expect(h.sourcePath).toBe(join(home, 'settings.json'));
    }
  });

  it('parses permissions, model, settings hash, and user MCP names', () => {
    expect(c.permissions).toEqual({
      allow: ['Bash(git status)', 'Read'],
      deny: ['Bash(rm:*)'],
      defaultMode: 'acceptEdits',
    });
    expect(c.model).toBe('claude-opus-5-5');
    expect(c.settingsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(c.mcpServers.map((m) => [m.name, m.scope, m.transport])).toEqual([
      ['github', 'user', 'stdio'],
      ['remote', 'user', 'http'],
    ]);
    expect(c.warnings).toEqual([]);
  });

  it('never retains secrets, commands, or account identifiers', () => {
    const json = JSON.stringify(c);
    expect(json).not.toContain(secret);
    expect(json).not.toContain('pnpm lint');
    expect(json).not.toContain('Are you done');
    expect(json).not.toContain(fakeEmail);
    expect(json).not.toContain('oauthAccount');
    expect(json).not.toContain('decoy');
    expect(json).not.toContain('user instructions');
  });

  it('settings hash ignores env values but tracks env key names', () => {
    const other = fakeClaudeHome();
    const settingsPath = join(other.home, 'settings.json');
    const s = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      settingsPath,
      JSON.stringify({ ...s, env: { ANTHROPIC_API_KEY: 'different', OTHER: 'y' } }),
    );
    expect(scanUserConfig(other.home).settingsHash).toBe(c.settingsHash);
    writeFileSync(settingsPath, JSON.stringify({ ...s, env: { RENAMED: 'x' } }));
    expect(scanUserConfig(other.home).settingsHash).not.toBe(c.settingsHash);
  });

  it('handles a missing home directory', () => {
    const c2 = scanUserConfig(join(tmp(), 'nope'), join(tmp(), 'missing.json'));
    expect(c2).toMatchObject({
      instructions: [],
      agents: [],
      skills: [],
      hooks: [],
      mcpServers: [],
    });
    expect(c2.settingsHash).toBeUndefined();
  });
});

describe('scanProjectConfig', () => {
  const { claudeJson, project } = fakeClaudeHome();
  put(project, 'CLAUDE.md', '# project\n');
  put(project, '.claude/CLAUDE.md', '# dot claude\n');
  put(project, 'CLAUDE.local.md', '# local\n');
  put(project, 'packages/api/CLAUDE.md', '# api\n');
  put(project, 'a/b/c/CLAUDE.md', '# depth 3\n');
  put(project, 'a/b/c/d/CLAUDE.md', '# depth 4 (ignored)\n');
  put(project, 'node_modules/pkg/CLAUDE.md', '# ignored\n');
  put(project, 'dist/CLAUDE.md', '# ignored\n');
  put(project, '.claude/agents/release-manager.md', '---\nname: release-manager\n---\n');
  put(
    project,
    '.claude/skills/run-tests/SKILL.md',
    '---\nname: run-tests\ndescription: Run\n---\n',
  );
  put(
    project,
    '.claude/settings.json',
    JSON.stringify({
      model: 'claude-sonnet-5',
      permissions: { allow: ['Read'], defaultMode: 'default' },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'check.sh' }] }],
      },
    }),
  );
  put(
    project,
    '.claude/settings.local.json',
    JSON.stringify({
      model: 'claude-opus-5-5',
      permissions: { allow: ['Bash(ls)'], defaultMode: 'plan' },
      env: { TOKEN: secret },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }] },
    }),
  );
  put(
    project,
    '.mcp.json',
    JSON.stringify({
      mcpServers: {
        sentry: { url: 'https://sentry.example.invalid/mcp', type: 'sse', headers: { X: secret } },
        files: { command: 'npx', args: ['files-mcp'], env: { KEY: secret } },
      },
    }),
  );
  const c = scanProjectConfig(project, claudeJson);

  it('finds the CLAUDE.md chain incl. nested (depth ≤ 3, skipping node_modules/dist)', () => {
    expect(c.instructions.map((i) => [i.path.slice(project.length + 1), i.scope])).toEqual([
      ['.claude/CLAUDE.md', 'project'],
      ['CLAUDE.local.md', 'local'],
      ['CLAUDE.md', 'project'],
      ['a/b/c/CLAUDE.md', 'nested'],
      ['packages/api/CLAUDE.md', 'nested'],
    ]);
  });

  it('reads project agents, skills, settings (local overrides project), and MCP', () => {
    expect(c.agents.map((a) => [a.name, a.scope])).toEqual([['release-manager', 'project']]);
    expect(c.skills.map((s) => [s.name, s.scope])).toEqual([['run-tests', 'project']]);
    expect(c.hooks.map((h) => [h.event, h.scope])).toEqual([
      ['PreToolUse', 'project'],
      ['Stop', 'local'],
    ]);
    expect(c.permissions).toEqual({ allow: ['Bash(ls)', 'Read'], deny: [], defaultMode: 'plan' });
    expect(c.model).toBe('claude-opus-5-5');
    expect(c.mcpServers.map((m) => [m.name, m.scope, m.transport])).toEqual([
      ['files', 'project', 'stdio'],
      ['localdb', 'local', 'stdio'],
      ['sentry', 'project', 'sse'],
    ]);
    expect(c.warnings).toEqual([]);
  });

  it('never retains secrets or account identifiers', () => {
    const json = JSON.stringify(c);
    expect(json).not.toContain(secret);
    expect(json).not.toContain(fakeEmail);
    expect(json).not.toContain('github'); // user-scope MCP is not part of the project scan
    expect(json).not.toContain('check.sh');
  });
});

describe('malformed files', () => {
  it('records warnings and keeps going', () => {
    const base = tmp();
    const home = join(base, 'home');
    put(home, 'settings.json', `{ "model": "x", "env": { "K": "${secret}" `);
    put(home, 'agents/bad.md', '---\nname: [unclosed\ntools: : :\n---\nbody\n');
    put(home, 'agents/unterminated.md', '---\nname: x\nbody without closing\n');
    put(home, 'agents/list.md', '---\n- a\n- b\n---\n');
    put(home, 'skills/broken/SKILL.md', '---\nname: "oops\n---\n');
    const claudeJson = join(base, '.claude.json');
    writeFileSync(claudeJson, `{"oauthAccount": {"emailAddress": "${fakeEmail}"}, `);
    const c = scanUserConfig(home, claudeJson);
    expect(c.agents.map((a) => a.name)).toEqual(['bad', 'list', 'unterminated']);
    expect(c.skills.map((s) => s.name)).toEqual(['broken']);
    expect(c.settingsHash).toBeUndefined();
    expect(c.warnings.length).toBeGreaterThanOrEqual(5);
    const json = JSON.stringify(c);
    expect(json).not.toContain(secret);
    expect(json).not.toContain(fakeEmail);

    const proj = join(base, 'proj');
    put(proj, '.mcp.json', 'not json');
    put(
      proj,
      '.claude/settings.json',
      JSON.stringify({ hooks: { Stop: 'nope', Pre: [1, { foo: 1 }] }, permissions: 3 }),
    );
    const p = scanProjectConfig(proj, claudeJson);
    expect(p.mcpServers).toEqual([]);
    expect(p.hooks).toEqual([]);
    expect(p.permissions).toEqual({ allow: [], deny: [] });
    expect(p.warnings.length).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------------------------

function gitRun(cwd: string, args: string[], date?: string): string {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  if (date) Object.assign(env, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Garden Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function commitAll(cwd: string, msg: string, date: string): void {
  gitRun(cwd, ['add', '-A']);
  gitRun(cwd, ['commit', '-q', '-m', msg], date);
}

describe('gitRoot', () => {
  it('returns the top level inside a repo and undefined outside', () => {
    const repo = tmp();
    gitRun(repo, ['init', '-q']);
    mkdirSync(join(repo, 'sub dir'));
    expect(gitRoot(join(repo, 'sub dir'))).toBe(repo);
    expect(gitRoot(tmp())).toBeUndefined();
    expect(gitRoot(join(tmp(), 'missing'))).toBeUndefined();
  });
});

describe('gitHarnessHistory', () => {
  it('returns [] outside a repo and for a repo without commits', () => {
    expect(gitHarnessHistory(tmp())).toEqual([]);
    const empty = tmp();
    gitRun(empty, ['init', '-q']);
    expect(gitHarnessHistory(empty)).toEqual([]);
  });

  it('builds per-commit snapshots, oldest first, skipping non-harness commits', () => {
    const repo = tmp();
    gitRun(repo, ['init', '-q']);
    put(repo, 'CLAUDE.md', '# v1\n');
    put(repo, 'src/index.ts', 'export {};\n');
    commitAll(repo, 'Add CLAUDE.md', '2026-01-01T10:00:00+02:00');

    put(repo, '.claude/agents/test writer.md', '---\nname: test-writer\ntools: Read, Bash\n---\n');
    put(
      repo,
      '.claude/settings.json',
      JSON.stringify({
        hooks: {
          PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'pnpm test' }] }],
        },
      }),
    );
    commitAll(
      repo,
      'Add agent and hook\n\nLonger body that is not the subject.',
      '2026-01-02T10:00:00Z',
    );

    put(repo, 'src/index.ts', 'export const x = 1;\n');
    commitAll(repo, 'Non-harness change', '2026-01-03T10:00:00Z');

    put(repo, 'CLAUDE.md', '# v2 with more text\n');
    put(repo, 'docs/my notes/CLAUDE.md', '# nested\n');
    put(repo, 'node_modules/x/CLAUDE.md', '# ignored\n');
    commitAll(repo, 'Edit CLAUDE.md', '2026-01-04T10:00:00Z');

    rmSync(join(repo, '.claude/agents/test writer.md'));
    gitRun(repo, ['mv', 'docs/my notes', 'docs/notes']);
    commitAll(repo, 'Remove agent, rename notes dir', '2026-01-05T10:00:00Z');

    const h = gitHarnessHistory(repo);
    expect(h.map((c) => c.message)).toEqual([
      'Add CLAUDE.md',
      'Add agent and hook',
      'Edit CLAUDE.md',
      'Remove agent, rename notes dir',
    ]);
    expect(h[0]?.at).toBe('2026-01-01T08:00:00.000Z');
    expect(h[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(h.map((c) => c.changedPaths)).toEqual([
      ['CLAUDE.md'],
      ['.claude/agents/test writer.md', '.claude/settings.json'],
      ['CLAUDE.md', 'docs/my notes/CLAUDE.md'],
      ['.claude/agents/test writer.md', 'docs/my notes/CLAUDE.md', 'docs/notes/CLAUDE.md'],
    ]);

    const snaps = h.map((c) => c.snapshot);
    expect(snaps.map((s) => s.agents.map((a) => a.name))).toEqual([
      [],
      ['test-writer'],
      ['test-writer'],
      [],
    ]);
    expect(snaps[1]?.agents[0]?.tools).toEqual(['Read', 'Bash']);
    expect(snaps[1]?.agents[0]?.path).toBe(join(repo, '.claude/agents/test writer.md'));
    expect(snaps.map((s) => s.hooks.length)).toEqual([0, 1, 1, 1]);
    expect(snaps.map((s) => s.settingsHash === undefined)).toEqual([true, false, false, false]);
    const rootMd = (i: number) =>
      snaps[i]?.instructions.find((x) => x.path === join(repo, 'CLAUDE.md'));
    expect(rootMd(0)?.bytes).toBe(5);
    expect(rootMd(2)?.bytes).toBe(20);
    expect(rootMd(1)?.hash).toBe(rootMd(0)?.hash);
    expect(rootMd(2)?.hash).not.toBe(rootMd(1)?.hash);
    expect(snaps.map((s) => s.instructions.map((x) => x.path.slice(repo.length + 1)))).toEqual([
      ['CLAUDE.md'],
      ['CLAUDE.md'],
      ['CLAUDE.md', 'docs/my notes/CLAUDE.md'],
      ['CLAUDE.md', 'docs/notes/CLAUDE.md'],
    ]);
    for (const s of snaps) {
      expect(s.scope).toBe('project');
      expect(s.warnings).toEqual([]);
    }
    expect(JSON.stringify(h)).not.toContain('pnpm test');

    // The final snapshot matches a scan of the working copy.
    const live = scanProjectConfig(repo);
    const last = snaps[snaps.length - 1];
    expect(last?.instructions).toEqual(live.instructions);
    expect(last?.hooks).toEqual(live.hooks);
    expect(last?.settingsHash).toBe(live.settingsHash);
  });

  it('scopes history to a project in a subdirectory of the repo', () => {
    const repo = tmp();
    gitRun(repo, ['init', '-q']);
    put(repo, 'CLAUDE.md', '# top\n');
    commitAll(repo, 'top', '2026-02-01T00:00:00Z');
    put(repo, 'apps/web/CLAUDE.md', '# web\n');
    put(repo, 'apps/web/.mcp.json', JSON.stringify({ mcpServers: { db: {} } }));
    commitAll(repo, 'web', '2026-02-02T00:00:00Z');
    const h = gitHarnessHistory(join(repo, 'apps/web'));
    expect(h.map((c) => c.message)).toEqual(['web']);
    expect(h[0]?.changedPaths).toEqual(['apps/web/.mcp.json', 'apps/web/CLAUDE.md']);
    expect(h[0]?.snapshot.instructions.map((i) => i.path)).toEqual([
      join(repo, 'apps/web/CLAUDE.md'),
    ]);
    expect(h[0]?.snapshot.mcpServers.map((m) => m.name)).toEqual(['db']);
  });

  it('handles 200 harness commits quickly', () => {
    const repo = tmp();
    gitRun(repo, ['init', '-q']);
    const t0 = Date.now();
    for (let i = 0; i < 200; i++) {
      put(repo, 'CLAUDE.md', `# rev ${i}\n`);
      if (i % 10 === 0) put(repo, `.claude/skills/s${i}/SKILL.md`, `---\nname: s${i}\n---\n`);
      gitRun(repo, ['add', '-A']);
      gitRun(
        repo,
        ['commit', '-q', '-m', `rev ${i}`],
        `2026-03-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
      );
    }
    const setupMs = Date.now() - t0;
    const t1 = Date.now();
    const h = gitHarnessHistory(repo);
    const ms = Date.now() - t1;
    expect(h).toHaveLength(200);
    expect(h[199]?.snapshot.skills).toHaveLength(20);
    expect(ms).toBeLessThan(Math.max(8000, setupMs));
  }, 60_000);
});

describe('lenient frontmatter', () => {
  it('reads unquoted ": " inside values (common in hand-written agent files)', async () => {
    const { parseFrontmatter } = await import('./parse');
    const warnings: string[] = [];
    const fm = parseFrontmatter(
      '---\nname: release-manager\ndescription: Prepares a release: bump, changelog, tag.\ntools: Read, Bash\n---\nbody',
      'x.md',
      warnings,
    );
    expect(fm).toEqual({
      name: 'release-manager',
      description: 'Prepares a release: bump, changelog, tag.',
      tools: 'Read, Bash',
    });
    expect(warnings[0]).toMatch(/non-strict/);
  });
  it('still rejects frontmatter that is not flat key: value', async () => {
    const { parseFrontmatter } = await import('./parse');
    const warnings: string[] = [];
    expect(
      parseFrontmatter('---\nname: x: y\n  - [broken\n---\n', 'y.md', warnings),
    ).toBeUndefined();
    expect(warnings[0]).toMatch(/invalid YAML/);
  });
});
