/**
 * Derivations computed over the whole store after each ingest, so incremental ingestion
 * (only changed sessions re-parsed) still yields globally correct results.
 */
import type { HarnessBundle, RedactedText } from '@garden/core';
import { median } from '@garden/core';
import { agentId, diffBundles } from '../adapters/claude-code/harness';
import { stableId as id } from '../ids';
import type { GardenConfig } from '../adapters/claude-code/garden-yaml';
import type { Store } from './store';

export interface DeriveReport {
  harnessVersions: number;
  loopsInferred: number;
  runsAttributedToLoops: number;
}

/** Normalized prompt fingerprint for spotting the same automated task repeated. */
export function promptFingerprint(preview: string): string {
  return preview
    .toLowerCase()
    .replace(/\[redacted:[^\]]*\]/g, '')
    .replace(/[0-9a-f]{7,}/g, '')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

export const MIN_RUNS_FOR_INFERRED_LOOP = 3;

export function deriveAll(store: Store, garden: GardenConfig): DeriveReport {
  return store.transaction(() => {
    const db = store.db;

    // 1. Agent seen ranges from runs.
    db.exec(`
      UPDATE agents SET
        first_seen_at = COALESCE((SELECT MIN(started_at) FROM runs WHERE runs.agent_id = agents.id), first_seen_at),
        last_seen_at  = COALESCE((SELECT MAX(ended_at)   FROM runs WHERE runs.agent_id = agents.id), last_seen_at)`);

    // 2. Harness validity windows and diffs. A harness is the environment one agent runs inside,
    //    so seasons form one chain per (family, primary agent): the agent with most runs on a version.
    //    Otherwise main-thread and subagent harnesses (which list different tools) would interleave.
    const versions = db
      .prepare(
        `SELECT hv.id, hv.family_id, hv.bundle_json,
                COALESCE((SELECT MIN(started_at) FROM runs r WHERE r.harness_version_id = hv.id), hv.valid_from) AS first_use,
                COALESCE((SELECT r.agent_id FROM runs r WHERE r.harness_version_id = hv.id
                           GROUP BY r.agent_id ORDER BY COUNT(*) DESC, MIN(r.started_at) LIMIT 1), '') AS primary_agent
           FROM harness_versions hv ORDER BY hv.family_id, primary_agent, first_use, hv.id`,
      )
      .all() as {
      id: string;
      family_id: string;
      bundle_json: string;
      first_use: string;
      primary_agent: string;
    }[];
    const update = db.prepare(
      'UPDATE harness_versions SET valid_from = ?, valid_to = ?, diff_json = ? WHERE id = ?',
    );
    const sameChain = (a?: (typeof versions)[number], b?: (typeof versions)[number]) =>
      !!a && !!b && a.family_id === b.family_id && a.primary_agent === b.primary_agent;
    for (let i = 0; i < versions.length; i++) {
      const v = versions[i]!;
      const prev = sameChain(versions[i - 1], v) ? versions[i - 1] : undefined;
      const next = sameChain(versions[i + 1], v) ? versions[i + 1] : undefined;
      const diff = prev
        ? JSON.stringify(
            diffBundles(
              JSON.parse(prev.bundle_json) as HarnessBundle,
              JSON.parse(v.bundle_json) as HarnessBundle,
            ),
          )
        : null;
      update.run(v.first_use, next?.first_use ?? null, diff, v.id);
    }

    // 3. Loops: reset attribution, then declared loops, then inferred recurring automated runs.
    db.exec(`UPDATE runs SET loop_id = NULL; DELETE FROM loops WHERE provenance = 'inferred';`);
    const famByName = new Map(
      (
        db.prepare('SELECT id, name FROM harness_families').all() as { id: string; name: string }[]
      ).map((f) => [f.name, f.id]),
    );
    const setLoop = db.prepare('UPDATE runs SET loop_id = ? WHERE id = ?');
    let attributed = 0;

    const candidates = db
      .prepare(
        `SELECT r.id, r.family_id, r.agent_id, r.started_at, r.task_preview, r.trigger, s.entrypoint
           FROM runs r JOIN sessions s ON s.id = r.session_id
          WHERE r.parent_run_id IS NULL ORDER BY r.started_at`,
      )
      .all() as {
      id: string;
      family_id: string;
      agent_id: string;
      started_at: string;
      task_preview: string;
      trigger: string;
      entrypoint: string | null;
    }[];
    const taken = new Set<string>();

    for (const l of garden.loops) {
      const loopId = id('loop', 'declared', l.name);
      const famId = l.project ? famByName.get(l.project) : undefined;
      const agentIdx = agentId(l.agent);
      for (const r of candidates) {
        if (taken.has(r.id)) continue;
        if (famId && r.family_id !== famId) continue;
        if (r.agent_id !== agentIdx) continue;
        if (
          l.match
            ? !r.task_preview.toLowerCase().includes(l.match.toLowerCase())
            : r.trigger !== 'automated'
        )
          continue;
        setLoop.run(loopId, r.id);
        taken.add(r.id);
        attributed++;
      }
    }

    const isAutomated = (r: (typeof candidates)[number]) =>
      r.trigger === 'automated' || (r.entrypoint !== null && /^sdk/.test(r.entrypoint));
    const groups = new Map<string, typeof candidates>();
    for (const r of candidates) {
      if (taken.has(r.id) || !isAutomated(r)) continue;
      const key = `${r.family_id}\u0000${r.agent_id}\u0000${promptFingerprint(r.task_preview)}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    const putLoop = db.prepare(
      `INSERT OR REPLACE INTO loops (id, name, tier, provenance, trigger_kind, trigger_detail, expected_interval_sec, targets_json)
       VALUES (?, ?, 'application', 'inferred', 'headless_repeat', ?, ?, ?)`,
    );
    let inferred = 0;
    for (const [key, runs] of groups) {
      if (runs.length < MIN_RUNS_FOR_INFERRED_LOOP) continue;
      const [famId, agId] = key.split('\u0000') as [string, string];
      const loopId = id('loop', 'inferred', key);
      const gaps = runs
        .slice(1)
        .map((r, i) => (Date.parse(r.started_at) - Date.parse(runs[i]!.started_at)) / 1000);
      const first = runs[0]!.task_preview as RedactedText; // already redacted in the store
      const name = first.replace(/\s+/g, ' ').slice(0, 48) + (first.length > 48 ? '…' : '');
      putLoop.run(
        loopId,
        name,
        `${runs.length} automated runs with the same prompt` as RedactedText,
        median(gaps),
        JSON.stringify({ agentIds: [agId], familyIds: [famId] }),
      );
      for (const r of runs) setLoop.run(loopId, r.id);
      attributed += runs.length;
      inferred++;
    }

    return {
      harnessVersions: versions.length,
      loopsInferred: inferred,
      runsAttributedToLoops: attributed,
    };
  });
}
