/**
 * Tails Claude Code transcripts as they grow and feeds live observations into a LiveHub.
 *
 * - Watches the projects dir with `fs.watch` (recursive) for low latency, and polls tracked files
 *   every `pollMs` (default 250 ms) as a fallback, since fs.watch is unreliable on some filesystems.
 * - Reads only appended bytes (per-file offsets). A trailing fragment without a newline is buffered
 *   until the rest arrives. Truncation or rotation (size shrinks, inode changes) restarts the file.
 * - On start, only files modified in the last `recentMinutes` are tracked, seeded from their last
 *   `seedBytes` (never the whole history). Files that become active later are read from the size
 *   they had when first seen; files created later are read from the start.
 * - Subagent files (`<session>/subagents/agent-<id>.jsonl`) become child agents, linked to the parent
 *   by the `.meta.json` sidecar (`toolUseId`), which can land after the first lines (retried).
 * Nothing is written to disk. Every emitted string has passed the Redactor (see preview.ts).
 */
import { watch, type FSWatcher } from 'node:fs';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { canonicalProjectRoot } from '../adapters/claude-code/adapter';
import { familyId } from '../adapters/claude-code/harness';
import { LineSchema } from '../adapters/claude-code/transcript/schema';
import type { Redactor } from '../redact';
import { LiveHub } from './hub';
import {
  LiveLineInterpreter,
  newLiveSession,
  newLiveThread,
  parseAgentMeta,
  type Bed,
  type LiveCensus,
  type LiveSession,
  type LiveThread,
} from './lines';
import { readRegistry } from './registry';

export interface LiveTailerOptions {
  redactor: Redactor;
  /** Default `~/.claude/projects`. */
  projectsDir?: string;
  /** Session registry dir (default `~/.claude/sessions`); null disables it. */
  sessionsDir?: string | null;
  /** Hub to feed; one is created (source 'transcripts') when omitted. */
  hub?: LiveHub;
  recentMinutes?: number;
  pollMs?: number;
  /** Interval of the directory scan that discovers new or re-activated files. */
  scanMs?: number;
  seedBytes?: number;
  /** Use fs.watch in addition to polling (default true). */
  watch?: boolean;
  activeWindowSec?: number;
  now?: () => number;
  /** cwd → bed; defaults to the history adapter's canonicalProjectRoot + familyId. */
  resolveBed?: (cwd: string) => Bed;
  plantExists?: (plantId: string) => boolean;
}

interface TailFile {
  path: string;
  thread: LiveThread;
  ino: number;
  offset: number;
  rest: Buffer;
  /** Discard bytes up to the first newline (seeded from the middle of a file). */
  skipPartial: boolean;
  metaPath?: string;
  metaTries: number;
}

const MAX_PARTIAL_BYTES = 32 * 1024 * 1024;
const READ_CHUNK = 8 * 1024 * 1024;
const META_RETRIES = 40;
const SUBAGENT_FILE = /^agent-(.+)\.jsonl$/;

export function defaultResolveBed(): (cwd: string) => Bed {
  const cache = new Map<string, Bed>();
  return (cwd) => {
    let bed = cache.get(cwd);
    if (!bed) {
      const root = canonicalProjectRoot(cwd);
      bed = { id: familyId(root), name: basename(root) || root };
      cache.set(cwd, bed);
    }
    return bed;
  };
}

export class LiveTailer {
  readonly hub: LiveHub;
  readonly projectsDir: string;
  private readonly sessionsDir: string | null;
  private readonly interp: LiveLineInterpreter;
  private readonly files = new Map<string, TailFile>();
  private readonly sessions = new Map<string, LiveSession>();
  /** Size of untracked files when last scanned (a file that turns active is read from here). */
  private readonly knownSizes = new Map<string, number>();
  private readonly now: () => number;
  private readonly recentMs: number;
  private readonly seedBytes: number;
  private watcher: FSWatcher | undefined;
  private timers: ReturnType<typeof setInterval>[] = [];
  private chain: Promise<void> = Promise.resolve();
  private started = false;
  private lastRegistry = '';
  /** Lines read and parse problems (shapes only). */
  readonly stats = { lines: 0, bytes: 0, malformed: 0, truncations: 0, watchEvents: 0 };

  constructor(private readonly opts: LiveTailerOptions) {
    const claude = join(homedir(), '.claude');
    this.projectsDir = opts.projectsDir ?? join(claude, 'projects');
    this.sessionsDir = opts.sessionsDir === undefined ? join(claude, 'sessions') : opts.sessionsDir;
    this.now = opts.now ?? Date.now;
    this.recentMs = (opts.recentMinutes ?? 30) * 60_000;
    this.seedBytes = opts.seedBytes ?? 256 * 1024;
    this.hub =
      opts.hub ??
      new LiveHub({
        source: 'transcripts',
        now: this.now,
        ...(opts.activeWindowSec ? { activeWindowSec: opts.activeWindowSec } : {}),
      });
    const interpOpts: ConstructorParameters<typeof LiveLineInterpreter>[0] = {
      redactor: opts.redactor,
      resolveBed: opts.resolveBed ?? defaultResolveBed(),
    };
    if (opts.plantExists) interpOpts.plantExists = opts.plantExists;
    this.interp = new LiveLineInterpreter(interpOpts);
    this.hub.onStop(() => this.stop());
  }

  get census(): LiveCensus {
    return this.interp.census;
  }

  get trackedFiles(): string[] {
    return [...this.files.keys()].sort();
  }

  /** Initial scan + seed, then start watching and polling. */
  async start(): Promise<void> {
    await this.scan();
    this.started = true;
    if (this.opts.watch !== false) this.startWatch();
    const pollMs = this.opts.pollMs ?? 250;
    const scanMs = this.opts.scanMs ?? 2000;
    if (pollMs > 0) this.timers.push(setInterval(() => void this.poll(), pollMs));
    if (scanMs > 0) this.timers.push(setInterval(() => void this.scan(), scanMs));
    for (const t of this.timers) t.unref?.();
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = undefined;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Read new bytes of every tracked file. Serialized with scans. */
  poll(): Promise<void> {
    return this.serial(async () => {
      for (const f of [...this.files.values()]) await this.readFile(f);
    });
  }

  /** Discover new or re-activated transcripts (and refresh the registry), then read them. */
  scan(): Promise<void> {
    return this.serial(async () => {
      await this.discover();
      for (const f of [...this.files.values()]) await this.readFile(f);
      await this.refreshRegistry();
    });
  }

  private serial(fn: () => Promise<void>): Promise<void> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private startWatch(): void {
    try {
      this.watcher = watch(this.projectsDir, { recursive: true }, (_ev, name) => {
        this.stats.watchEvents++;
        const n = typeof name === 'string' ? name : '';
        if (!n.endsWith('.jsonl') && !n.endsWith('.meta.json')) return;
        const path = join(this.projectsDir, n);
        void (this.files.has(path) ? this.poll() : this.scan());
      });
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = undefined; // polling continues
      });
    } catch {
      this.watcher = undefined; // recursive watch unsupported: polling only
    }
  }

  private async discover(): Promise<void> {
    const now = this.now();
    let projects: string[];
    try {
      projects = await readdir(this.projectsDir);
    } catch {
      return;
    }
    for (const proj of projects.sort()) {
      const dir = join(this.projectsDir, proj);
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue; // not a directory, or gone
      }
      for (const name of names.sort()) {
        if (!name.endsWith('.jsonl')) continue;
        const path = join(dir, name);
        const rawSessionId = name.slice(0, -'.jsonl'.length);
        if (!this.files.has(path)) {
          const st = await statOrUndefined(path);
          if (!st) continue;
          if (now - st.mtimeMs > this.recentMs) {
            this.knownSizes.set(path, st.size);
            continue;
          }
          const session = this.session(proj, rawSessionId);
          this.track(path, newLiveThread(session, 'main'), st);
        }
        const session = this.sessions.get(`${proj}${sep}${rawSessionId}`);
        if (session) await this.discoverSubagents(join(dir, rawSessionId, 'subagents'), session);
      }
    }
  }

  private async discoverSubagents(dir: string, session: LiveSession): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    const now = this.now();
    for (const name of names.sort()) {
      const m = SUBAGENT_FILE.exec(name);
      if (!m?.[1]) continue;
      const path = join(dir, name);
      if (this.files.has(path)) continue;
      const st = await statOrUndefined(path);
      if (!st) continue;
      session.subagentFiles.add(m[1]);
      if (now - st.mtimeMs > this.recentMs) {
        this.knownSizes.set(path, st.size);
        continue;
      }
      const f = this.track(path, newLiveThread(session, 'subagent', m[1]), st);
      f.metaPath = join(dir, `agent-${m[1]}.meta.json`);
      await this.loadMeta(f);
    }
  }

  private session(projectDir: string, rawSessionId: string): LiveSession {
    const k = `${projectDir}${sep}${rawSessionId}`;
    let s = this.sessions.get(k);
    if (!s) {
      s = newLiveSession(rawSessionId, projectDir);
      this.sessions.set(k, s);
    }
    return s;
  }

  private track(path: string, thread: LiveThread, st: { size: number; ino: number }): TailFile {
    const known = this.knownSizes.get(path);
    this.knownSizes.delete(path);
    // Re-activated file: only bytes after the size we last saw. Otherwise (initial seed, or a file
    // created after start) read at most the last seedBytes.
    const offset =
      known !== undefined && known <= st.size && this.started
        ? known
        : Math.max(0, st.size - this.seedBytes);
    const f: TailFile = {
      path,
      thread,
      ino: st.ino,
      offset,
      rest: Buffer.alloc(0),
      skipPartial: offset > 0 && offset !== known,
      metaTries: 0,
    };
    this.files.set(path, f);
    return f;
  }

  private async loadMeta(f: TailFile): Promise<void> {
    if (!f.metaPath || f.thread.meta || f.metaTries >= META_RETRIES) return;
    f.metaTries++;
    try {
      const meta = parseAgentMeta(await readFile(f.metaPath, 'utf8'));
      if (meta) f.thread.meta = meta;
    } catch {
      // not written yet; retried on the next read
    }
  }

  private async readFile(f: TailFile): Promise<void> {
    await this.loadMeta(f);
    const st = await statOrUndefined(f.path);
    if (!st) {
      this.files.delete(f.path);
      return;
    }
    if (st.size < f.offset || st.ino !== f.ino) {
      this.stats.truncations++;
      this.interp.unknown('file truncated or rotated (re-read)');
      f.ino = st.ino;
      f.offset = Math.max(0, st.size - this.seedBytes);
      f.skipPartial = f.offset > 0;
      f.rest = Buffer.alloc(0);
    }
    if (st.size === f.offset) return;
    let fh;
    try {
      fh = await open(f.path, 'r');
    } catch {
      return;
    }
    try {
      while (f.offset < st.size) {
        const len = Math.min(READ_CHUNK, st.size - f.offset);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, f.offset);
        if (bytesRead === 0) break;
        f.offset += bytesRead;
        this.stats.bytes += bytesRead;
        this.consume(f, buf.subarray(0, bytesRead));
      }
    } finally {
      await fh.close();
    }
  }

  private consume(f: TailFile, chunk: Buffer): void {
    let data = f.rest.length > 0 ? Buffer.concat([f.rest, chunk]) : chunk;
    if (f.skipPartial) {
      const nl = data.indexOf(0x0a);
      if (nl === -1) {
        f.rest = Buffer.alloc(0);
        return;
      }
      data = data.subarray(nl + 1);
      f.skipPartial = false;
    }
    const last = data.lastIndexOf(0x0a);
    if (last === -1) {
      f.rest = Buffer.from(data);
    } else {
      // 0x0a never occurs inside a UTF-8 multibyte sequence, so this split is safe.
      f.rest = Buffer.from(data.subarray(last + 1));
      for (const text of data.subarray(0, last).toString('utf8').split('\n')) this.line(f, text);
    }
    if (f.rest.length > MAX_PARTIAL_BYTES) {
      this.interp.unknown('oversized partial line dropped');
      f.rest = Buffer.alloc(0);
      f.skipPartial = true;
    }
  }

  private line(f: TailFile, text: string): void {
    if (text.trim() === '') return;
    this.stats.lines++;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      this.stats.malformed++;
      this.interp.unknown('malformed JSON line');
      return;
    }
    const r = LineSchema.safeParse(json);
    if (!r.success) {
      this.interp.unknown('non-object line');
      return;
    }
    let observations;
    try {
      observations = this.interp.interpret(f.thread, r.data, this.now());
    } catch {
      this.interp.unknown('line could not be interpreted');
      return;
    }
    for (const o of observations) this.hub.push(o);
  }

  private async refreshRegistry(): Promise<void> {
    if (!this.sessionsDir) return;
    const reg = await readRegistry(this.sessionsDir);
    const key = JSON.stringify(reg);
    if (key === this.lastRegistry) return;
    this.lastRegistry = key;
    this.hub.setRegistry(reg);
  }
}

async function statOrUndefined(
  path: string,
): Promise<{ size: number; ino: number; mtimeMs: number } | undefined> {
  try {
    const st = await stat(path);
    return st.isFile() ? { size: st.size, ino: st.ino, mtimeMs: st.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}
