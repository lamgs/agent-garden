/**
 * Knowledge map (milestone K): SQL loader + pure builders for GET /api/knowledge/:familyId and for
 * the garden's soil strata and knowledge weeds. Every number comes from derived facts in the store
 * (paths, sizes, keyed hashes, usage counts); no file content exists to read.
 */
import {
  TOKEN_METHOD,
  USAGE_CAVEAT,
  KNOWLEDGE_BUDGET_TOKENS,
  WEED_FINDING_KINDS,
  alwaysLoadedTokens,
  approxTokens,
  knowledgeFindings,
  layerOf,
  type BedKnowledgeSoil,
  type GardenView,
  type KnowledgeCheckInput,
  type KnowledgeEdgeKind,
  type KnowledgeFinding,
  type KnowledgeKind,
  type KnowledgeLayer,
  type KnowledgeLoadMode,
  type KnowledgeScope,
  type KnowledgeSourceFacts,
  type KnowledgeUsageFacts,
  type KnowledgeView,
  type Weed,
} from '@garden/core';
import { similarity, stableId, type Store } from '@garden/ingest';
import type { GardenData } from './data';
import { rateOf } from './garden';

const DAY = 86_400_000;
/** Outcome trend for the stale check: the last 30 days of the window vs the rest. */
export const TREND_RECENT_DAYS = 30;

export interface KnowledgeSourceRowData extends KnowledgeSourceFacts {
  familyId: string;
  path: string;
  importDepth?: number;
  globs?: string[];
  memoryType?: string;
}

export interface KnowledgeData {
  scans: { familyId: string; scannedAt: string; memoryDir: string | null }[];
  sources: KnowledgeSourceRowData[];
  edges: {
    id: string;
    familyId: string;
    fromId: string;
    toId: string | null;
    kind: KnowledgeEdgeKind;
    target: string;
    resolved: boolean;
    beyondCap: boolean;
    reason?: string;
  }[];
  snapshots: {
    familyId: string;
    at: string;
    commitSha: string;
    provenance: 'git' | 'current';
    layers: Partial<Record<KnowledgeLayer, number>>;
  }[];
  /** Usage in the window by (familyId, path). */
  usage: {
    familyId: string;
    path: string;
    count: number;
    sessions: number;
    lastAt: string;
    kinds: string;
  }[];
  /** Sessions in the window per family, and how many carry a session-start load record. */
  sessions: { familyId: string; total: number; withLoad: number }[];
}

const str = (v: unknown): string | undefined =>
  v === null || v === undefined ? undefined : String(v);
const json = <T>(v: unknown, fallback: T): T =>
  typeof v === 'string' ? (JSON.parse(v) as T) : fallback;

/** Knowledge rows for every bed (cross-bed duplicate checks need them all). Empty before migration 3 data. */
export function loadKnowledgeData(store: Store, from: string, to: string): KnowledgeData {
  const db = store.db;
  const all = <T>(sql: string, ...p: string[]) => db.prepare(sql).all(...p) as T[];
  return {
    scans: all<Record<string, unknown>>('SELECT * FROM knowledge_scans').map((r) => ({
      familyId: String(r.family_id),
      scannedAt: String(r.scanned_at),
      memoryDir: str(r.memory_dir) ?? null,
    })),
    sources: all<Record<string, unknown>>(
      'SELECT * FROM knowledge_sources ORDER BY display_path',
    ).map((r) => {
      const s: KnowledgeSourceRowData = {
        id: String(r.id),
        familyId: String(r.family_id),
        kind: r.kind as KnowledgeKind,
        scope: r.scope as KnowledgeScope,
        path: String(r.path),
        displayPath: String(r.display_path),
        bytes: Number(r.bytes),
        lines: Number(r.lines),
        alwaysBytes: Number(r.always_bytes),
        loadMode: r.load_mode as KnowledgeLoadMode,
        passageHashes: json<string[]>(r.passage_hashes_json, []),
        lastChangedAt: str(r.last_changed_at) ?? null,
      };
      if (r.name !== null) s.name = String(r.name);
      if (r.load_note !== null) s.loadNote = String(r.load_note);
      if (r.import_depth !== null) s.importDepth = Number(r.import_depth);
      if (r.globs_json !== null) s.globs = json<string[]>(r.globs_json, []);
      if (r.memory_type !== null) s.memoryType = String(r.memory_type);
      return s;
    }),
    edges: all<Record<string, unknown>>('SELECT * FROM knowledge_edges ORDER BY id').map((r) => ({
      id: String(r.id),
      familyId: String(r.family_id),
      fromId: String(r.from_id),
      toId: str(r.to_id) ?? null,
      kind: r.kind as KnowledgeEdgeKind,
      target: String(r.target),
      resolved: Boolean(r.resolved),
      beyondCap: Boolean(r.beyond_cap),
      ...(r.reason !== null ? { reason: String(r.reason) } : {}),
    })),
    snapshots: all<Record<string, unknown>>('SELECT * FROM knowledge_snapshots ORDER BY at').map(
      (r) => ({
        familyId: String(r.family_id),
        at: String(r.at),
        commitSha: String(r.commit_sha),
        provenance: r.provenance as 'git' | 'current',
        layers: json(r.layers_json, {}),
      }),
    ),
    usage: all<{
      familyId: string;
      path: string;
      count: number;
      sessions: number;
      lastAt: string;
      kinds: string;
    }>(
      `SELECT family_id AS familyId, path, SUM(count) AS count, COUNT(DISTINCT session_id) AS sessions,
              MAX(last_at) AS lastAt, GROUP_CONCAT(DISTINCT kind) AS kinds
         FROM knowledge_usage WHERE last_at >= ? AND first_at <= ? GROUP BY family_id, path`,
      from,
      to,
    ),
    sessions: all<{ familyId: string; total: number; withLoad: number }>(
      `SELECT s.family_id AS familyId, COUNT(*) AS total,
              SUM(EXISTS (SELECT 1 FROM knowledge_usage u WHERE u.session_id = s.id AND u.kind = 'session_load')) AS withLoad
         FROM sessions s WHERE s.started_at >= ? AND s.started_at <= ? GROUP BY s.family_id`,
      from,
      to,
    ),
  };
}

export interface KnowledgeBuildOptions {
  window: { from: string; to: string };
  now?: string;
}

/** Usage per source id: file paths from transcripts, skill invocations, subagent runs. */
function usageFor(
  familyId: string,
  k: KnowledgeData,
  data: GardenData,
): Map<string, KnowledgeUsageFacts> {
  const out = new Map<string, KnowledgeUsageFacts>();
  const byPath = new Map(k.usage.filter((u) => u.familyId === familyId).map((u) => [u.path, u]));
  const famRuns = data.runs.filter((r) => r.familyId === familyId);
  const runIds = new Set(famRuns.map((r) => r.id));
  const runAt = new Map(famRuns.map((r) => [r.id, r.startedAt]));
  for (const s of k.sources) {
    if (s.familyId !== familyId) continue;
    const u = byPath.get(s.path);
    let f: KnowledgeUsageFacts | undefined = u
      ? {
          count: Number(u.count),
          sessions: Number(u.sessions),
          lastAt: u.lastAt,
          kinds: u.kinds.split(','),
        }
      : undefined;
    if (s.kind === 'skill' && s.name) {
      const sid = stableId('skl', s.name);
      const calls = data.skillCalls.filter((c) => c.skillId === sid && runIds.has(c.runId));
      if (calls.length) {
        const last = calls.reduce(
          (m, c) => ((runAt.get(c.runId) ?? '') > m ? (runAt.get(c.runId) ?? '') : m),
          '',
        );
        f = {
          count: (f?.count ?? 0) + calls.length,
          sessions: f?.sessions ?? 0,
          lastAt: f?.lastAt && f.lastAt > last ? f.lastAt : last,
          kinds: [...(f?.kinds ?? []), 'skill_invoke'],
        };
      }
    }
    if (s.kind === 'agent_definition' && s.name) {
      const aid = stableId('agt', s.name);
      const runs = famRuns.filter((r) => r.agentId === aid);
      if (runs.length) {
        const last = runs.reduce((m, r) => (r.startedAt > m ? r.startedAt : m), '');
        f = {
          count: (f?.count ?? 0) + runs.length,
          sessions: f?.sessions ?? 0,
          lastAt: f?.lastAt && f.lastAt > last ? f.lastAt : last,
          kinds: [...(f?.kinds ?? []), 'agent_run'],
        };
      }
    }
    if (f) out.set(s.id, f);
  }
  return out;
}

function checkInput(
  familyId: string,
  k: KnowledgeData,
  data: GardenData,
  opts: KnowledgeBuildOptions,
): KnowledgeCheckInput {
  const sources = k.sources.filter((s) => s.familyId === familyId);
  const to = Date.parse(opts.window.to);
  const split = new Date(to - TREND_RECENT_DAYS * DAY).toISOString();
  const main = data.agents.find((a) => a.name === 'main')?.id;
  const mainRuns = data.runs.filter(
    (r) => r.familyId === familyId && r.agentId === main && !r.loopId,
  );
  const recent = rateOf(mainRuns.filter((r) => r.startedAt >= split));
  const prior = rateOf(mainRuns.filter((r) => r.startedAt < split));
  // Passages in other beds' project-level always-loaded files.
  const famName = new Map(data.families.map((f) => [f.id, f.name]));
  const other = new Map<string, string[]>();
  for (const s of k.sources) {
    if (s.familyId === familyId || (s.scope !== 'project' && s.scope !== 'local') || !layerOf(s))
      continue;
    for (const p of s.passageHashes) {
      const h = p.slice(0, p.lastIndexOf(':'));
      const bed = famName.get(s.familyId) ?? s.familyId;
      const list = other.get(h) ?? [];
      if (!list.includes(bed)) other.set(h, [...list, bed]);
    }
  }
  const desc = new Map(data.skills.map((s) => [s.name, s.description ?? '']));
  const skills = sources.filter((s) => s.kind === 'skill' && s.name && desc.get(s.name));
  const skillPairs: { aId: string; bId: string; similarity: number }[] = [];
  for (let i = 0; i < skills.length; i++)
    for (let j = i + 1; j < skills.length; j++)
      skillPairs.push({
        aId: skills[i]!.id,
        bId: skills[j]!.id,
        similarity: similarity(desc.get(skills[i]!.name!)!, desc.get(skills[j]!.name!)!),
      });
  return {
    sources,
    edges: k.edges.filter((e) => e.familyId === familyId),
    usage: usageFor(familyId, k, data),
    history: historyOf(familyId, k, opts).map((h) => ({ at: h.at, tokens: h.tokens })),
    window: opts.window,
    outcomeTrend: { recent, prior, splitAt: split },
    skillPairs,
    otherBedPassages: other,
    sessionsInWindow: k.sessions.find((s) => s.familyId === familyId)?.total ?? 0,
  };
}

function historyOf(
  familyId: string,
  k: KnowledgeData,
  opts: KnowledgeBuildOptions,
): KnowledgeView['history'] {
  const tokens = (layers: Partial<Record<KnowledgeLayer, number>>) =>
    approxTokens(Object.values(layers).reduce((a, b) => a + (b ?? 0), 0));
  return k.snapshots
    .filter((s) => s.familyId === familyId)
    .map((s) => ({
      // The current scan happened at ingest time; on a fixed-date window draw it at the window end.
      at: s.provenance === 'current' && s.at > opts.window.to ? opts.window.to : s.at,
      // Same layers for commits and the current scan, so the series is comparable.
      tokens: tokens({
        project: s.layers.project ?? 0,
        local: s.layers.local ?? 0,
        rules: s.layers.rules ?? 0,
      }),
      provenance: s.provenance,
      ...(s.commitSha ? { commit: s.commitSha.slice(0, 7) } : {}),
    }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

export function findingsForBed(
  familyId: string,
  k: KnowledgeData,
  data: GardenData,
  opts: KnowledgeBuildOptions,
): KnowledgeFinding[] {
  if (!k.scans.some((s) => s.familyId === familyId)) return [];
  return knowledgeFindings(checkInput(familyId, k, data, opts));
}

export function buildKnowledgeView(
  familyId: string,
  k: KnowledgeData,
  data: GardenData,
  opts: KnowledgeBuildOptions,
): KnowledgeView | null {
  const fam = data.families.find((f) => f.id === familyId);
  if (!fam) return null;
  const scan = k.scans.find((s) => s.familyId === familyId);
  const input = checkInput(familyId, k, data, opts);
  const findings = scan ? knowledgeFindings(input) : [];
  const findingIds = new Map<string, string[]>();
  for (const f of findings)
    for (const id of f.sourceIds) findingIds.set(id, [...(findingIds.get(id) ?? []), f.id]);
  const budget = alwaysLoadedTokens(input.sources);
  const sess = k.sessions.find((s) => s.familyId === familyId);
  const caveats = [
    TOKEN_METHOD,
    USAGE_CAVEAT,
    'Load chain verified against Claude Code 2.1.293 (docs/sources.md). Other versions may load differently.',
  ];
  if (!scan)
    caveats.unshift(
      'This bed has no knowledge scan yet: run `garden ingest --full` to scan its files.',
    );
  if (sess && sess.withLoad === 0)
    caveats.push(
      'No session in the window carries an instructions record, so always-loaded files are inferred from the load chain, not observed.',
    );
  return {
    bed: { id: fam.id, name: fam.name },
    window: opts.window,
    generatedAt: new Date(opts.now ?? opts.window.to).toISOString(),
    scannedAt: scan?.scannedAt ?? null,
    memoryDir: scan?.memoryDir ?? null,
    budget: {
      alwaysTokens: budget.total,
      layers: budget.layers,
      budgetTokens: KNOWLEDGE_BUDGET_TOKENS,
      method: TOKEN_METHOD,
    },
    history: historyOf(familyId, k, opts),
    historyMethod:
      'Project layers (CLAUDE.md, .claude/CLAUDE.md, CLAUDE.local.md if committed, rules without `paths`) at each commit that touched them, from git; imports and user-level files are not versioned and are left out of the series. Tokens ≈ bytes ÷ 4.',
    sources: k.sources
      .filter((s) => s.familyId === familyId)
      .map((s) => {
        const u = input.usage.get(s.id);
        return {
          id: s.id,
          kind: s.kind,
          scope: s.scope,
          layer: layerOf(s),
          displayPath: s.displayPath,
          ...(s.name ? { name: s.name } : {}),
          bytes: s.bytes,
          lines: s.lines,
          tokens: approxTokens(s.bytes),
          alwaysTokens: approxTokens(s.alwaysBytes),
          loadMode: s.loadMode,
          ...(s.loadNote ? { loadNote: s.loadNote } : {}),
          ...(s.importDepth !== undefined ? { importDepth: s.importDepth } : {}),
          ...(s.globs ? { globs: s.globs } : {}),
          ...(s.memoryType ? { memoryType: s.memoryType } : {}),
          lastChangedAt: s.lastChangedAt ?? null,
          usage: u
            ? { count: u.count, sessions: u.sessions, lastAt: u.lastAt, kinds: u.kinds }
            : { count: 0, sessions: 0, lastAt: null, kinds: [] },
          findingIds: findingIds.get(s.id) ?? [],
        };
      }),
    edges: input.edges.map((e) => ({
      id: e.id,
      fromId: e.fromId,
      toId: e.toId ?? null,
      kind: e.kind,
      target: e.target,
      resolved: e.resolved,
      beyondCap: e.beyondCap,
      ...(e.reason ? { reason: e.reason } : {}),
    })),
    findings,
    sessions: { total: sess?.total ?? 0, withLoadRecord: sess?.withLoad ?? 0 },
    caveats,
  };
}

const WEED_KINDS: ReadonlySet<string> = new Set(WEED_FINDING_KINDS);

/**
 * Garden integration: soil strata per bed (always-loaded tokens by layer) and knowledge findings as
 * weeds. Mutates and returns `view`.
 */
export function withKnowledge(
  view: GardenView,
  k: KnowledgeData,
  data: GardenData,
  opts: KnowledgeBuildOptions,
): GardenView {
  for (const bed of view.beds) {
    if (!k.scans.some((s) => s.familyId === bed.id)) continue;
    const findings = findingsForBed(bed.id, k, data, opts);
    const { total, layers } = alwaysLoadedTokens(k.sources.filter((s) => s.familyId === bed.id));
    const soil: BedKnowledgeSoil = {
      alwaysTokens: total,
      layers: layers.map((l) => ({ layer: l.layer, tokens: l.tokens })),
      findingCount: findings.length,
    };
    bed.soil.knowledge = soil;
    // One weed per finding kind per bed, so a bloated bed reads as weedy without burying its plants.
    const byKind = new Map<string, KnowledgeFinding[]>();
    for (const f of findings)
      if (WEED_KINDS.has(f.kind)) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f]);
    for (const [kind, list] of byKind) {
      const first = list[0]!;
      const more = list.length > 1 ? ` (+${list.length - 1} more like it)` : '';
      const weed: Weed = {
        id: stableId('weed', 'knowledge', bed.id, kind),
        kind: kind as Weed['kind'],
        subject: { type: 'knowledge_source', id: first.sourceIds[0] ?? first.id },
        bedId: bed.id,
        reason: `${first.title}${more}. ${first.actionText} Open the bed’s knowledge map for the evidence.`,
      };
      view.weeds.push(weed);
    }
  }
  return view;
}
