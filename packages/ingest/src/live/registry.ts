/**
 * Optional session registry: `~/.claude/sessions/<pid>.json`, one small file per running Claude Code
 * process (main thread only; shapes in docs/sources.md). Only `<digits>.json` files are read, and only
 * the keys below. The sibling `*.key` files hold credential material and are never opened.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { stableId } from '../ids';
import type { RegistryStatus } from './types';

const REGISTRY_FILE = /^\d+\.json$/;

const RegistrySchema = z.looseObject({
  pid: z.number().optional().catch(undefined),
  sessionId: z.string().optional().catch(undefined),
  status: z.string().optional().catch(undefined),
  waitingFor: z.string().optional().catch(undefined),
});

/** True unless the process is known to be gone (ESRCH). EPERM means it exists. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Registry status by store session id (`ses_…`). Missing directory → empty map. */
export async function readRegistry(
  dir: string,
  alive: (pid: number) => boolean = pidAlive,
): Promise<Record<string, RegistryStatus>> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return {};
  }
  const out: Record<string, RegistryStatus> = {};
  for (const name of names) {
    if (!REGISTRY_FILE.test(name)) continue; // never *.key
    let json: unknown;
    try {
      json = JSON.parse(await readFile(join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    const r = RegistrySchema.safeParse(json);
    if (!r.success || !r.data.sessionId || !r.data.status) continue;
    const s: RegistryStatus = {
      status: /^[a-z_-]{1,20}$/.test(r.data.status) ? r.data.status : 'other',
      alive: r.data.pid === undefined ? true : alive(r.data.pid),
    };
    // Dialog labels such as "tool permission"; anything that is not a short plain label is dropped.
    if (r.data.waitingFor && /^[A-Za-z _-]{1,60}$/.test(r.data.waitingFor))
      s.waitingFor = r.data.waitingFor;
    out[stableId('ses', r.data.sessionId)] = s;
  }
  return out;
}
