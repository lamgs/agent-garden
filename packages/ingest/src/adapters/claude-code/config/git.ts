import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import type { HarnessCommit } from '../contracts';
import { isNestedInstruction, scanProjectTree } from './scan';
import { listedTree } from './tree';

const MAX_BUFFER = 512 * 1024 * 1024;

function git(
  cwd: string,
  args: string[],
  opts: { input?: string; literal?: boolean } = {},
): Buffer {
  return execFileSync('git', ['-C', cwd, '-c', 'core.quotepath=off', ...args], {
    input: opts.input,
    stdio: ['pipe', 'pipe', 'ignore'],
    maxBuffer: MAX_BUFFER,
    env: opts.literal ? { ...process.env, GIT_LITERAL_PATHSPECS: '1' } : process.env,
  });
}

/** Git top-level for a directory, or undefined if not inside a repo (or git is missing). */
export function gitRoot(dir: string): string | undefined {
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** Harness files (relative to the project root) that are tracked as exact paths. */
const HARNESS_FILES = [
  'CLAUDE.md',
  'CLAUDE.local.md',
  '.claude/CLAUDE.md',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.mcp.json',
];
const HARNESS_DIRS = ['.claude/agents', '.claude/skills'];

function isHarnessPath(rel: string): boolean {
  return (
    HARNESS_FILES.includes(rel) ||
    HARNESS_DIRS.some((d) => rel.startsWith(`${d}/`)) ||
    isNestedInstruction(rel)
  );
}

/** Files whose content the project scanner reads (everything else only needs to be listed). */
function needsContent(rel: string): boolean {
  if (HARNESS_FILES.includes(rel) || isNestedInstruction(rel)) return true;
  const segs = rel.split('/');
  if (rel.startsWith('.claude/agents/')) return segs.length === 3 && /\.md$/i.test(rel);
  if (rel.startsWith('.claude/skills/')) return segs.length === 4 && segs[3] === 'SKILL.md';
  return false;
}

interface RawCommit {
  sha: string;
  at: string;
  message: string;
  files: string[];
}

function parseLog(out: string): RawCommit[] {
  const commits: RawCommit[] = [];
  for (const chunk of out.split('\x1e')) {
    if (!chunk) continue;
    const parts = chunk.split('\0');
    const [sha, date, subject] = parts;
    if (!sha || !date) continue;
    const files = parts
      .slice(3)
      .map((f) => f.replace(/^\n/, ''))
      .filter((f) => f.length > 0);
    const d = new Date(date);
    commits.push({
      sha,
      at: Number.isNaN(d.getTime()) ? date : d.toISOString(),
      message: subject ?? '',
      files,
    });
  }
  return commits;
}

/** Parse `git ls-tree -r -z` output into path → blob id (regular files only; no symlinks/submodules). */
function parseLsTree(out: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const rec of out.split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, oid] = rec.slice(0, tab).split(' ');
    if (type !== 'blob' || mode === '120000' || !oid) continue;
    m.set(rec.slice(tab + 1), oid);
  }
  return m;
}

/** Read many blobs with one `git cat-file --batch`. */
function readBlobs(top: string, oids: string[]): Map<string, Buffer> {
  const blobs = new Map<string, Buffer>();
  if (oids.length === 0) return blobs;
  const out = git(top, ['cat-file', '--batch'], { input: oids.join('\n') + '\n' });
  let pos = 0;
  while (pos < out.length) {
    const nl = out.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = out.subarray(pos, nl).toString('utf8');
    pos = nl + 1;
    const [oid, type, sizeStr] = header.split(' ');
    if (type === 'missing' || !oid || sizeStr === undefined) continue;
    const size = Number(sizeStr);
    blobs.set(oid, out.subarray(pos, pos + size));
    pos += size + 1; // content is followed by a newline
  }
  return blobs;
}

const escapeGlob = (s: string) => s.replace(/[*?[\]\\]/g, '\\$&');

/** Commits that touched harness files in the git repo at `root`, oldest first. [] if not a repo. */
export function gitHarnessHistory(root: string): HarnessCommit[] {
  const rootAbs = resolve(root);
  const top = gitRoot(rootAbs);
  if (!top) return [];
  let prefix: string;
  try {
    prefix = relative(realpathSync(top), realpathSync(rootAbs)).split(sep).join('/');
  } catch {
    return [];
  }
  if (prefix.startsWith('..')) return [];
  const toRepo = (rel: string) => (prefix ? `${prefix}/${rel}` : rel);
  const toRoot = (repoRel: string): string | undefined =>
    !prefix
      ? repoRel
      : repoRel.startsWith(`${prefix}/`)
        ? repoRel.slice(prefix.length + 1)
        : undefined;

  const pathspecs = [
    ...[...HARNESS_FILES, ...HARNESS_DIRS].map((p) => `:(literal)${toRepo(p)}`),
    `:(glob)${prefix ? `${escapeGlob(prefix)}/` : ''}**/CLAUDE.md`,
  ];
  let log: string;
  try {
    log = git(top, [
      'log',
      '--reverse',
      '--no-renames',
      '--diff-merges=first-parent',
      '--format=%x1e%H%x00%cI%x00%s',
      '--name-only',
      '-z',
      '--',
      ...pathspecs,
    ]).toString('utf8');
  } catch {
    return []; // no commits yet, or git failed
  }

  const commits = parseLog(log)
    .map((c) => ({
      ...c,
      files: c.files.filter((f) => {
        const r = toRoot(f);
        return r !== undefined && isHarnessPath(r);
      }),
    }))
    .filter((c) => c.files.length > 0);
  if (commits.length === 0) return [];

  // Every nested CLAUDE.md that ever existed was added by one of these commits, so listing just
  // these paths (plus the fixed harness locations) avoids a full recursive tree listing per commit.
  const nested = new Set<string>();
  for (const c of commits)
    for (const f of c.files) if (isNestedInstruction(toRoot(f) ?? '')) nested.add(f);
  const lsSpecs = [
    ...['.claude', 'CLAUDE.md', 'CLAUDE.local.md', '.mcp.json'].map(toRepo),
    ...[...nested].sort(),
  ];

  const trees = commits.map((c) => {
    let entries: Map<string, string>;
    try {
      entries = parseLsTree(
        git(top, ['ls-tree', '-r', '-z', '--full-tree', c.sha, '--', ...lsSpecs], {
          literal: true,
        }).toString('utf8'),
      );
    } catch {
      entries = new Map();
    }
    const files = new Map<string, string>();
    for (const [repoRel, oid] of entries) {
      const r = toRoot(repoRel);
      if (r !== undefined && isHarnessPath(r)) files.set(r, oid);
    }
    return files;
  });

  const wanted = new Set<string>();
  for (const files of trees) for (const [rel, oid] of files) if (needsContent(rel)) wanted.add(oid);
  let blobs: Map<string, Buffer>;
  try {
    blobs = readBlobs(top, [...wanted].sort());
  } catch {
    blobs = new Map();
  }

  return commits.map((c, i) => {
    const files = trees[i] ?? new Map<string, string>();
    const tree = listedTree([...files.keys()], (rel) => {
      const oid = files.get(rel);
      return oid ? blobs.get(oid) : undefined;
    });
    return {
      sha: c.sha,
      at: c.at,
      message: c.message,
      changedPaths: [...c.files].sort(),
      snapshot: scanProjectTree(rootAbs, tree),
    };
  });
}
