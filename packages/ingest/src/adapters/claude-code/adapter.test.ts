import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ingest } from '../../pipeline';
import { Redactor } from '../../redact';
import { deriveAll } from '../../store/derive';
import { Store } from '../../store/store';
import { ClaudeCodeAdapter, canonicalProjectRoot } from './adapter';

const dir = mkdtempSync(join(tmpdir(), 'garden-adapter-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
    cwd,
    stdio: 'pipe',
  });

describe('canonicalProjectRoot', () => {
  it('folds a deleted Claude Code worktree path into its repo', () => {
    expect(canonicalProjectRoot('/home/u/app/.claude/worktrees/agent-123')).toBe('/home/u/app');
    expect(canonicalProjectRoot('/home/u/app/.claude/worktrees/agent-123/packages/x')).toBe(
      '/home/u/app',
    );
  });
  it('folds a live linked git worktree into the main repo, and keeps subdirs at the top level', () => {
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'README.md'), 'x');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    const wt = join(dir, 'elsewhere-wt');
    git(repo, 'worktree', 'add', '-q', wt);
    expect(canonicalProjectRoot(wt)).toBe(repo);
    expect(canonicalProjectRoot(join(repo, 'src'))).toBe(repo);
    expect(canonicalProjectRoot(join(dir, 'not-a-repo-' + Date.now()))).toMatch(/not-a-repo/);
  });
  it('keeps an independent repo nested under a worktree path as its own project', () => {
    // e.g. demo projects generated inside `.claude/worktrees/<name>/.garden-demo/`
    const nested = join(dir, 'outer', '.claude', 'worktrees', 'agent-9', 'demo', 'shop-api');
    mkdirSync(nested, { recursive: true });
    git(nested, 'init', '-q');
    writeFileSync(join(nested, 'README.md'), 'x');
    git(nested, 'add', '.');
    git(nested, 'commit', '-qm', 'init');
    expect(canonicalProjectRoot(nested)).toBe(nested);
    expect(canonicalProjectRoot(join(nested, 'src'))).toBe(join(dir, 'outer'));
  });
});

describe('ClaudeCodeAdapter end to end (synthetic fixtures)', () => {
  const home = join(dir, 'claude-home');
  cpSync(new URL('../../../../../fixtures/claude-code', import.meta.url), home, {
    recursive: true,
  });
  const dbPath = join(dir, 'garden.db');
  const make = (full = false) =>
    new ClaudeCodeAdapter({ claudeHome: home, claudeJsonPath: join(dir, 'none.json'), full });

  it('ingests every fixture session, scores every run, and derives without errors', async () => {
    const store = new Store(dbPath);
    const a = make();
    const report = await ingest(a, store, new Redactor(Buffer.alloc(32, 5)));
    deriveAll(store, a.garden);
    expect(report.records.session).toBeGreaterThanOrEqual(7);
    expect(report.records.run).toBe(report.records.outcome);
    expect(store.count('runs')).toBe(report.records.run);
    // Every run references existing agent, family and harness rows (FKs are enforced).
    const orphans = store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM runs r LEFT JOIN harness_versions h ON h.id = r.harness_version_id WHERE h.id IS NULL`,
      )
      .get() as { n: number };
    expect(orphans.n).toBe(0);
    // Subagent runs are linked to a spawn step in their parent.
    const linked = store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM runs c JOIN steps s ON s.id = c.parent_step_id AND s.child_run_id = c.id WHERE c.trigger = 'subagent'`,
      )
      .get() as { n: number };
    expect(linked.n).toBeGreaterThan(0);
    store.close();
  });

  it('skips unchanged files on re-ingest and re-reads changed ones; --full is idempotent', async () => {
    const store = new Store(dbPath);
    const before = store.count('steps');
    const again = await ingest(make(), store, new Redactor(Buffer.alloc(32, 5)));
    expect(again.records.session ?? 0).toBe(0);

    const anyFile = join(home, 'projects', '-home-dev-demo');
    const files = execFileSync('ls', [anyFile])
      .toString()
      .split('\n')
      .filter((f) => f.endsWith('.jsonl'));
    const t = new Date();
    utimesSync(join(anyFile, files[0]!), t, t);
    const touched = await ingest(make(), store, new Redactor(Buffer.alloc(32, 5)));
    expect(touched.records.session).toBe(1);

    await ingest(make(true), store, new Redactor(Buffer.alloc(32, 5)));
    expect(store.count('steps')).toBe(before);
    store.close();
  });
});
