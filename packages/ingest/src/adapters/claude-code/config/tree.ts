/**
 * A minimal read-only file tree, so the same scanners run over the working copy (disk) and over a
 * git commit (blobs from `git cat-file`). Paths are POSIX, relative to the tree root, no leading `./`.
 */
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface TreeEntry {
  name: string;
  isDir: boolean;
  /** The entry itself is a symlink (isDir/isFile describe the target). */
  isSymlink: boolean;
}

export interface FileTree {
  /** File content, or undefined when missing, unreadable, or not a regular file. */
  read(rel: string): Buffer | undefined;
  /** Directory entries sorted by name; [] when missing or not a directory. */
  list(rel: string): TreeEntry[];
}

/** Files larger than this are skipped with a warning by the scanners. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

const byName = (a: TreeEntry, b: TreeEntry) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export function diskTree(root: string): FileTree {
  const abs = (rel: string) => (rel === '' ? root : join(root, ...rel.split('/')));
  return {
    read(rel) {
      try {
        const p = abs(rel);
        const st = statSync(p);
        if (!st.isFile() || st.size > MAX_FILE_BYTES) return undefined;
        return readFileSync(p);
      } catch {
        return undefined;
      }
    },
    list(rel) {
      const dir = abs(rel);
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return [];
      }
      const out: TreeEntry[] = [];
      for (const name of names) {
        const p = join(dir, name);
        try {
          const l = lstatSync(p);
          const isSymlink = l.isSymbolicLink();
          const isDir = isSymlink ? statSync(p).isDirectory() : l.isDirectory();
          out.push({ name, isDir, isSymlink });
        } catch {
          // dangling symlink or permission problem: skip
        }
      }
      return out.sort(byName);
    },
  };
}

/** Tree over a fixed list of file paths whose contents are resolved lazily. */
export function listedTree(paths: string[], read: (rel: string) => Buffer | undefined): FileTree {
  const dirs = new Map<string, Map<string, boolean>>();
  const add = (dir: string, name: string, isDir: boolean) => {
    let m = dirs.get(dir);
    if (!m) dirs.set(dir, (m = new Map()));
    if (!m.get(name)) m.set(name, isDir);
  };
  const files = new Set(paths);
  for (const p of paths) {
    const segs = p.split('/');
    for (let i = 0; i < segs.length; i++) {
      add(segs.slice(0, i).join('/'), segs[i] ?? '', i < segs.length - 1);
    }
  }
  return {
    read: (rel) => (files.has(rel) ? read(rel) : undefined),
    list: (rel) =>
      [...(dirs.get(rel) ?? new Map<string, boolean>())]
        .map(([name, isDir]) => ({ name, isDir, isSymlink: false }))
        .sort(byName),
  };
}
