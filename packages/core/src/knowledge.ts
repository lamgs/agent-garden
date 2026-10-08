/**
 * Knowledge map (milestone K): load-chain constants and the bloat / provenance checks.
 * Pure functions over derived facts (paths, sizes, keyed passage hashes, usage counts). No file
 * content ever reaches this module. Constants are verified in docs/sources.md ("Knowledge sources").
 */
import type {
  ID,
  KnowledgeEdgeKind,
  KnowledgeKind,
  KnowledgeLayer,
  KnowledgeLoadMode,
  KnowledgeScope,
} from './schema';
import type { KnowledgeAction, KnowledgeFinding, KnowledgeFindingKind } from './views';

// ---- verified load-chain constants (CC 2.1.293 binary; docs/sources.md) --------------------------

/** MEMORY.md is cut after 200 lines… */
export const MEMORY_INDEX_MAX_LINES = 200;
/** …or after 25,000 bytes (at the last newline before it), whichever comes first. */
export const MEMORY_INDEX_MAX_BYTES = 25_000;
/** A recalled memory topic file shows only its first 4,096 bytes (or 200 lines). */
export const MEMORY_TOPIC_RECALL_BYTES = 4096;
/** `@path` imports: files at depth ≥ 5 are not loaded (so at most 4 hops from the root file). */
export const IMPORT_MAX_DEPTH = 5;
/** Skill listing: per-skill description cap in characters (setting `skillListingMaxDescChars`). */
export const SKILL_LISTING_DESC_CHARS = 1536;
/** Approximate characters per token (Claude Code's own estimate is 4, or 3 for some models). */
export const CHARS_PER_TOKEN = 4;

// ---- check thresholds (ours; stated in every finding's evidence) --------------------------------

/**
 * Always-loaded budget per bed: 10k tokens ≈ 40,000 characters, the smallest per-file size at which
 * Claude Code itself recommends trimming instruction files (max(40,000, 5% of the context window)).
 */
export const KNOWLEDGE_BUDGET_TOKENS = 10_000;
/** The official guidance targets under 200 lines per CLAUDE.md. */
export const FILE_LINES_TARGET = 200;
/** Budget growth worth flagging: +50% and at least +1,000 tokens over the window. */
export const GROWTH_RATIO = 1.5;
export const GROWTH_MIN_TOKENS = 1000;
/** Stale: always-loaded file unchanged this many days while outcomes dropped. */
export const STALE_DAYS = 60;
export const STALE_DROP = 0.1;
export const STALE_MIN_N = 10;
/** Skill descriptions this similar (token Jaccard) compete for the same requests. */
export const SKILL_OVERLAP_SIMILARITY = 0.5;

export const approxTokens = (bytes: number): number => Math.ceil(bytes / CHARS_PER_TOKEN);

export const TOKEN_METHOD =
  'Tokens are estimated as bytes ÷ 4 (Claude Code’s own rule of thumb). Always-loaded = files in ' +
  'the session prompt of every session (managed/user/project/local CLAUDE.md, rules without ' +
  '`paths`, their @imports, MEMORY.md up to its 200-line / 25 KB cap) plus the skill and agent ' +
  'listing lines (name + description, capped at 1,536 characters).';

/** Always-loaded layer for a source, or null when it is not part of every session's prompt. */
export function layerOf(s: {
  kind: KnowledgeKind;
  loadMode: KnowledgeLoadMode;
  alwaysBytes: number;
}): KnowledgeLayer | null {
  if (s.kind === 'skill' || s.kind === 'agent_definition')
    return s.alwaysBytes > 0 ? 'listings' : null;
  if (s.loadMode !== 'always') return null;
  switch (s.kind) {
    case 'managed_claude_md':
      return 'managed';
    case 'user_claude_md':
      return 'user';
    case 'project_claude_md':
      return 'project';
    case 'local_claude_md':
      return 'local';
    case 'rule':
      return 'rules';
    case 'import':
      return 'imports';
    case 'memory_index':
      return 'memory';
    default:
      return null;
  }
}

export const LAYER_LABEL: Record<KnowledgeLayer, string> = {
  managed: 'Managed policy CLAUDE.md',
  user: 'User CLAUDE.md (~/.claude)',
  project: 'Project CLAUDE.md',
  local: 'CLAUDE.local.md',
  rules: 'Rules (.claude/rules)',
  imports: '@imports',
  memory: 'MEMORY.md index',
  listings: 'Skill & agent listings',
};

// ---- check inputs ---------------------------------------------------------------------------------

export interface KnowledgeSourceFacts {
  id: ID;
  kind: KnowledgeKind;
  scope: KnowledgeScope;
  displayPath: string;
  name?: string;
  bytes: number;
  lines: number;
  alwaysBytes: number;
  loadMode: KnowledgeLoadMode;
  loadNote?: string;
  /** `<keyed hash>:<bytes>` per normalized passage. */
  passageHashes: string[];
  lastChangedAt?: string | null;
}

export interface KnowledgeEdgeFacts {
  id: ID;
  fromId: ID;
  toId?: ID | null;
  kind: KnowledgeEdgeKind;
  target: string;
  resolved: boolean;
  beyondCap: boolean;
  reason?: string;
}

export interface KnowledgeUsageFacts {
  count: number;
  sessions: number;
  lastAt: string | null;
  kinds: string[];
}

export interface KnowledgeCheckInput {
  sources: readonly KnowledgeSourceFacts[];
  edges: readonly KnowledgeEdgeFacts[];
  /** Usage in the window by source id. Missing = never used. */
  usage: ReadonlyMap<ID, KnowledgeUsageFacts>;
  /** Always-loaded tokens over time, oldest first (git commits, then the current scan). */
  history: readonly { at: string; tokens: number }[];
  window: { from: string; to: string };
  /** Main-thread success in the bed: the last 30 days of the window vs the rest. */
  outcomeTrend?: {
    recent: { value: number | null; n: number };
    prior: { value: number | null; n: number };
    splitAt: string;
  };
  /** Skill pairs with their description similarity (computed by the caller). */
  skillPairs: readonly { aId: ID; bId: ID; similarity: number }[];
  /** Passage hash → names of other beds whose project-level always-loaded files contain it. */
  otherBedPassages?: ReadonlyMap<string, readonly string[]>;
  /** Sessions in the window (usage checks need transcript evidence to say "never used"). */
  sessionsInWindow: number;
}

// ---- helpers ----------------------------------------------------------------------------------------

/** FNV-1a 32-bit, hex. Deterministic finding ids without node:crypto (runs in the browser too). */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const fid = (kind: KnowledgeFindingKind, ...parts: string[]): ID =>
  `kf_${kind}_${shortHash(parts.join('\u0000'))}`;

const fmtTokens = (t: number): string =>
  t >= 1000 ? `${(t / 1000).toFixed(t >= 10_000 ? 0 : 1)}k` : String(t);

const days = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / 86_400_000;

function passageParts(p: string): { hash: string; bytes: number } {
  const i = p.lastIndexOf(':');
  return i < 0
    ? { hash: p, bytes: 0 }
    : { hash: p.slice(0, i), bytes: Number(p.slice(i + 1)) || 0 };
}

const isFileKind = (k: KnowledgeKind) => k !== 'skill' && k !== 'agent_definition';

function finding(
  kind: KnowledgeFindingKind,
  idParts: string[],
  f: Omit<KnowledgeFinding, 'id' | 'kind' | 'edgeIds'> & { edgeIds?: ID[] },
): KnowledgeFinding {
  return { id: fid(kind, ...idParts), kind, edgeIds: [], ...f };
}

function action(a: KnowledgeAction, text: string): { action: KnowledgeAction; actionText: string } {
  return { action: a, actionText: text };
}

// ---- the checks -------------------------------------------------------------------------------------

export function alwaysLoadedTokens(sources: readonly KnowledgeSourceFacts[]): {
  total: number;
  layers: { layer: KnowledgeLayer; tokens: number; sources: number }[];
} {
  const by = new Map<KnowledgeLayer, { bytes: number; sources: number }>();
  for (const s of sources) {
    const l = layerOf(s);
    if (!l) continue;
    const e = by.get(l) ?? { bytes: 0, sources: 0 };
    e.bytes += s.alwaysBytes;
    e.sources++;
    by.set(l, e);
  }
  const order: KnowledgeLayer[] = [
    'managed',
    'user',
    'project',
    'local',
    'rules',
    'imports',
    'memory',
    'listings',
  ];
  const layers = order
    .filter((l) => by.has(l))
    .map((l) => ({
      layer: l,
      tokens: approxTokens(by.get(l)!.bytes),
      sources: by.get(l)!.sources,
    }));
  return { total: layers.reduce((n, l) => n + l.tokens, 0), layers };
}

export function checkBudget(input: KnowledgeCheckInput): KnowledgeFinding[] {
  const out: KnowledgeFinding[] = [];
  const { total, layers } = alwaysLoadedTokens(input.sources);
  if (total > KNOWLEDGE_BUDGET_TOKENS) {
    const top = input.sources
      .filter((s) => layerOf(s) && layerOf(s) !== 'listings')
      .sort((a, b) => b.alwaysBytes - a.alwaysBytes)
      .slice(0, 3);
    out.push(
      finding('over_budget', ['bed'], {
        severity: total > 2 * KNOWLEDGE_BUDGET_TOKENS ? 'high' : 'medium',
        title: `Every session starts with ~${fmtTokens(total)} tokens of instructions and memory`,
        sourceIds: top.map((s) => s.id),
        tokensAtStake: total - KNOWLEDGE_BUDGET_TOKENS,
        evidence: [
          `Always-loaded: ~${total.toLocaleString('en-US')} tokens (bytes ÷ 4) vs a budget of ${KNOWLEDGE_BUDGET_TOKENS.toLocaleString('en-US')}.`,
          `By layer: ${layers.map((l) => `${LAYER_LABEL[l.layer]} ${fmtTokens(l.tokens)}`).join(', ')}.`,
          `Largest: ${top.map((s) => `${s.displayPath} (~${fmtTokens(approxTokens(s.alwaysBytes))})`).join(', ')}.`,
        ],
        ...action(
          'move_to_on_demand',
          'Keep only what every task needs in CLAUDE.md. Move module-specific notes into `.claude/rules/*.md` with `paths:` globs, or into docs or memory files that CLAUDE.md points to, so they load only when relevant.',
        ),
      }),
    );
  }
  for (const s of input.sources) {
    if (!layerOf(s) || s.kind === 'memory_index' || !isFileKind(s.kind)) continue;
    if (s.lines <= FILE_LINES_TARGET) continue;
    out.push(
      finding('large_file', [s.id], {
        severity: 'medium',
        title: `${s.displayPath} is ${s.lines.toLocaleString('en-US')} lines, loaded in every session`,
        sourceIds: [s.id],
        tokensAtStake: approxTokens(s.alwaysBytes),
        evidence: [
          `${s.lines} lines, ${s.bytes.toLocaleString('en-US')} bytes (~${fmtTokens(approxTokens(s.bytes))} tokens); the official guidance targets under ${FILE_LINES_TARGET} lines per file.`,
        ],
        ...action(
          'move_to_on_demand',
          'Split it: keep the commands and hard rules, move the rest into path-scoped rules or referenced docs.',
        ),
      }),
    );
  }
  // Growth over the window: the last value at or before the window start vs now.
  const h = input.history;
  if (h.length >= 2) {
    const startIdx = h.findLastIndex((x) => x.at <= input.window.from);
    const start = h[Math.max(0, startIdx)]!;
    const end = h[h.length - 1]!;
    if (
      end.tokens >= start.tokens * GROWTH_RATIO &&
      end.tokens - start.tokens >= GROWTH_MIN_TOKENS
    ) {
      out.push(
        finding('budget_growth', ['bed'], {
          severity: 'low',
          title: `Always-loaded knowledge grew from ~${fmtTokens(start.tokens)} to ~${fmtTokens(end.tokens)} tokens`,
          sourceIds: [],
          tokensAtStake: end.tokens - start.tokens,
          evidence: [
            `${start.at.slice(0, 10)}: ~${start.tokens.toLocaleString('en-US')} tokens → ${end.at.slice(0, 10)}: ~${end.tokens.toLocaleString('en-US')} tokens (+${Math.round((end.tokens / Math.max(1, start.tokens) - 1) * 100)}%).`,
            `Threshold: ≥ ${GROWTH_RATIO}× and ≥ +${GROWTH_MIN_TOKENS.toLocaleString('en-US')} tokens.`,
          ],
          ...action('review', 'Check whether what was added still needs to be in every session.'),
        }),
      );
    }
  }
  return out;
}

export function checkDuplicates(input: KnowledgeCheckInput): KnowledgeFinding[] {
  const out: KnowledgeFinding[] = [];
  const files = input.sources.filter((s) => isFileKind(s.kind));
  const byHash = new Map<string, { src: KnowledgeSourceFacts; bytes: number }[]>();
  for (const s of files)
    for (const p of s.passageHashes) {
      const { hash, bytes } = passageParts(p);
      byHash.set(hash, [...(byHash.get(hash) ?? []), { src: s, bytes }]);
    }
  // Pairs of distinct sources sharing passages; repeats within one file.
  const pairs = new Map<
    string,
    { a: KnowledgeSourceFacts; b: KnowledgeSourceFacts; n: number; bytes: number; hashes: string[] }
  >();
  const within = new Map<ID, { src: KnowledgeSourceFacts; n: number; bytes: number }>();
  for (const [hash, occ] of byHash) {
    const seen = new Map<ID, number>();
    for (const o of occ) seen.set(o.src.id, (seen.get(o.src.id) ?? 0) + 1);
    for (const [id, n] of seen)
      if (n > 1) {
        const o = occ.find((x) => x.src.id === id)!;
        const w = within.get(id) ?? { src: o.src, n: 0, bytes: 0 };
        w.n += n - 1;
        w.bytes += (n - 1) * o.bytes;
        within.set(id, w);
      }
    const uniq = [...new Map(occ.map((o) => [o.src.id, o])).values()].sort((x, y) =>
      x.src.id.localeCompare(y.src.id),
    );
    for (let i = 0; i < uniq.length; i++)
      for (let j = i + 1; j < uniq.length; j++) {
        const key = `${uniq[i]!.src.id}|${uniq[j]!.src.id}`;
        const e = pairs.get(key) ?? {
          a: uniq[i]!.src,
          b: uniq[j]!.src,
          n: 0,
          bytes: 0,
          hashes: [],
        };
        e.n++;
        e.bytes += uniq[i]!.bytes;
        e.hashes.push(hash);
        pairs.set(key, e);
      }
  }
  const always = (s: KnowledgeSourceFacts) => layerOf(s) !== null;
  for (const p of [...pairs.values()].sort((x, y) => y.bytes - x.bytes)) {
    const both = always(p.a) && always(p.b);
    const user = [p.a, p.b].find((s) => s.scope === 'user');
    const other = user === p.a ? p.b : p.a;
    const act = user
      ? action(
          'dedupe',
          `Delete the copy in ${other.displayPath}: ${user.displayPath} already loads it in every bed.`,
        )
      : action(
          'dedupe',
          `Keep it in one place: ${p.a.displayPath} or ${p.b.displayPath}, not both.`,
        );
    out.push(
      finding('duplicate_passage', [p.a.id, p.b.id], {
        severity: both ? 'medium' : 'low',
        title: `${p.n} passage${p.n === 1 ? ' appears' : 's appear'} in both ${p.a.displayPath} and ${p.b.displayPath}`,
        sourceIds: [p.a.id, p.b.id],
        tokensAtStake: both ? approxTokens(p.bytes) : 0,
        evidence: [
          `${p.n} identical passages after normalization (case, whitespace, list markers), ~${p.bytes.toLocaleString('en-US')} bytes. Compared by keyed hash; no text is stored.`,
          both
            ? 'Both files are always loaded, so these tokens are paid twice in every session.'
            : 'At least one copy loads on demand; the cost is a second source of truth more than tokens.',
        ],
        ...act,
      }),
    );
  }
  for (const w of within.values()) {
    out.push(
      finding('duplicate_passage', [w.src.id, 'within'], {
        severity: 'low',
        title: `${w.n} passage${w.n === 1 ? ' is' : 's are'} repeated inside ${w.src.displayPath}`,
        sourceIds: [w.src.id],
        tokensAtStake: always(w.src) ? approxTokens(w.bytes) : 0,
        evidence: [
          `${w.n} repeats, ~${w.bytes.toLocaleString('en-US')} bytes, by keyed passage hash.`,
        ],
        ...action('dedupe', 'Say it once.'),
      }),
    );
  }
  // Same passage in other beds' project files: belongs in the user CLAUDE.md.
  if (input.otherBedPassages) {
    const shared = new Map<
      ID,
      { src: KnowledgeSourceFacts; n: number; bytes: number; beds: Set<string> }
    >();
    for (const s of files) {
      if (s.scope !== 'project' && s.scope !== 'local') continue;
      if (!always(s)) continue;
      for (const p of s.passageHashes) {
        const { hash, bytes } = passageParts(p);
        const beds = input.otherBedPassages.get(hash);
        if (!beds?.length) continue;
        const e = shared.get(s.id) ?? { src: s, n: 0, bytes: 0, beds: new Set<string>() };
        e.n++;
        e.bytes += bytes;
        beds.forEach((b) => e.beds.add(b));
        shared.set(s.id, e);
      }
    }
    for (const e of shared.values()) {
      const beds = [...e.beds].sort();
      out.push(
        finding('duplicate_passage', [e.src.id, 'cross-bed'], {
          severity: 'low',
          title: `${e.n} passage${e.n === 1 ? '' : 's'} in ${e.src.displayPath} also appear in ${beds.length} other bed${beds.length === 1 ? '' : 's'}`,
          sourceIds: [e.src.id],
          tokensAtStake: 0,
          evidence: [
            `Shared with: ${beds.join(', ')}. ~${e.bytes.toLocaleString('en-US')} bytes, by keyed passage hash.`,
          ],
          ...action(
            'dedupe_into_user',
            'If it applies to all your projects, move it into ~/.claude/CLAUDE.md once and delete the copies.',
          ),
        }),
      );
    }
  }
  return out;
}

export function checkReferences(input: KnowledgeCheckInput): KnowledgeFinding[] {
  const out: KnowledgeFinding[] = [];
  const byId = new Map(input.sources.map((s) => [s.id, s]));
  for (const e of input.edges) {
    if (e.resolved) continue;
    const from = byId.get(e.fromId);
    const fromAlways = from ? layerOf(from) !== null : false;
    out.push(
      finding('dangling_ref', [e.id], {
        severity: fromAlways ? 'high' : 'medium',
        title: `${from?.displayPath ?? 'A knowledge file'} points to ${e.target}, which does not exist`,
        sourceIds: from ? [from.id] : [],
        edgeIds: [e.id],
        tokensAtStake: 0,
        evidence: [
          `${e.kind === 'import' ? '@import' : e.kind === 'index_link' ? 'MEMORY.md link' : 'Mention'} \`${e.target}\`: ${e.reason ?? 'no such file'}.`,
          fromAlways
            ? 'The referring file is loaded in every session, so the agent is told about knowledge it cannot find.'
            : 'The referring file loads on demand.',
        ],
        ...action('fix_reference', 'Fix the path or remove the reference.'),
      }),
    );
  }
  // Memory topics nobody points to (or only past the index cap) and nobody read.
  const incoming = new Map<ID, KnowledgeEdgeFacts[]>();
  for (const e of input.edges)
    if (e.resolved && e.toId) incoming.set(e.toId, [...(incoming.get(e.toId) ?? []), e]);
  for (const s of input.sources) {
    if (s.kind !== 'memory_topic') continue;
    const inc = incoming.get(s.id) ?? [];
    const visible = inc.filter((e) => !e.beyondCap);
    const used = (input.usage.get(s.id)?.count ?? 0) > 0;
    if (visible.length > 0 || used) continue;
    const onlyBeyond = inc.length > 0;
    out.push(
      finding('orphan_memory', [s.id], {
        severity: 'medium',
        title: onlyBeyond
          ? `${s.displayPath} is linked only past MEMORY.md's load cap`
          : `${s.displayPath} is not referenced from MEMORY.md or any CLAUDE.md`,
        sourceIds: [s.id],
        edgeIds: inc.map((e) => e.id),
        tokensAtStake: 0,
        evidence: [
          onlyBeyond
            ? `Its pointer sits after line ${MEMORY_INDEX_MAX_LINES} / byte ${MEMORY_INDEX_MAX_BYTES.toLocaleString('en-US')} of MEMORY.md, which the agent never sees.`
            : 'No MEMORY.md link, @import, or mention resolves to it.',
          input.sessionsInWindow > 0
            ? `Not recalled or read in ${input.sessionsInWindow} session${input.sessionsInWindow === 1 ? '' : 's'} in the window.`
            : 'No sessions in the window to check usage against.',
        ],
        ...(onlyBeyond
          ? action(
              'shorten_index',
              'Move its pointer above the cap (shorten the index), or delete the file.',
            )
          : action(
              'add_reference',
              'Add a one-line pointer to MEMORY.md (`- [Title](file.md) — hook`) or to the CLAUDE.md that needs it, or delete it.',
            )),
      }),
    );
  }
  for (const s of input.sources) {
    if (s.kind !== 'memory_index') continue;
    const overLines = s.lines > MEMORY_INDEX_MAX_LINES;
    const overBytes = s.bytes > MEMORY_INDEX_MAX_BYTES;
    if (!overLines && !overBytes) continue;
    const beyond = input.edges.filter((e) => e.fromId === s.id && e.beyondCap);
    out.push(
      finding('over_cap', [s.id], {
        severity: beyond.length > 0 ? 'high' : 'medium',
        title: `MEMORY.md is ${overLines ? `${s.lines} lines` : `${s.bytes.toLocaleString('en-US')} bytes`}; only the first part is loaded`,
        sourceIds: [s.id],
        edgeIds: beyond.map((e) => e.id),
        tokensAtStake: approxTokens(Math.max(0, s.bytes - s.alwaysBytes)),
        evidence: [
          `Claude Code loads MEMORY.md up to ${MEMORY_INDEX_MAX_LINES} lines or ${MEMORY_INDEX_MAX_BYTES.toLocaleString('en-US')} bytes. This one: ${s.lines} lines, ${s.bytes.toLocaleString('en-US')} bytes; ~${(s.bytes - s.alwaysBytes).toLocaleString('en-US')} bytes are cut.`,
          `${beyond.length} pointer${beyond.length === 1 ? '' : 's'} to topic files sit past the cap and are invisible to the agent.`,
        ],
        ...action(
          'shorten_index',
          'One short line per memory (`- [Title](file.md) — hook`); move detail into the topic files.',
        ),
      }),
    );
  }
  return out;
}

const UNUSED_KINDS: readonly KnowledgeKind[] = [
  'nested_claude_md',
  'rule',
  'memory_topic',
  'referenced_doc',
  'skill',
  'agent_definition',
];

export const USAGE_CAVEAT =
  'Usage comes from transcripts: session-start instructions records, nested_memory attachments ' +
  '(subdirectory CLAUDE.md and path-scoped rules), relevant_memories recalls, Read calls on the ' +
  'file, Skill calls, and subagent runs. A file read some other way (cat in Bash) is not counted.';

export function checkUsage(
  input: KnowledgeCheckInput,
  alreadyFlagged: ReadonlySet<ID>,
): KnowledgeFinding[] {
  if (input.sessionsInWindow === 0) return [];
  const out: KnowledgeFinding[] = [];
  const groups = new Map<KnowledgeKind, KnowledgeSourceFacts[]>();
  for (const s of input.sources) {
    if (!UNUSED_KINDS.includes(s.kind)) continue;
    if (s.loadMode !== 'on_demand' && s.loadMode !== 'path_scoped') continue;
    if (alreadyFlagged.has(s.id)) continue;
    if ((input.usage.get(s.id)?.count ?? 0) > 0) continue;
    groups.set(s.kind, [...(groups.get(s.kind) ?? []), s]);
  }
  const noun: Record<string, string> = {
    nested_claude_md: 'subdirectory CLAUDE.md file',
    rule: 'path-scoped rule',
    memory_topic: 'memory topic file',
    referenced_doc: 'referenced doc',
    skill: 'skill',
    agent_definition: 'agent definition',
  };
  const span = Math.round(days(input.window.from, input.window.to));
  for (const [kind, list] of groups) {
    const n = list.length;
    out.push(
      finding('unused_on_demand', [kind], {
        severity: 'low',
        title: `${n} ${noun[kind]}${n === 1 ? '' : 's'} never loaded in ${span} days`,
        sourceIds: list.map((s) => s.id),
        tokensAtStake: approxTokens(list.reduce((a, s) => a + s.alwaysBytes, 0)),
        evidence: [
          `${list
            .slice(0, 6)
            .map((s) => s.name ?? s.displayPath)
            .join(
              ', ',
            )}${n > 6 ? `, +${n - 6} more` : ''}: 0 loads across ${input.sessionsInWindow} sessions.`,
          USAGE_CAVEAT,
        ],
        ...action(
          kind === 'skill' || kind === 'agent_definition' ? 'review' : 'delete',
          kind === 'skill' || kind === 'agent_definition'
            ? 'Its listing line still costs tokens in every session. Delete it, or sharpen its description so the agent knows when to use it.'
            : 'Delete or archive it if nothing needs it; if something should, reference it from the CLAUDE.md for that area.',
        ),
      }),
    );
  }
  return out;
}

export function checkStale(input: KnowledgeCheckInput): KnowledgeFinding[] {
  const t = input.outcomeTrend;
  if (!t || t.recent.value === null || t.prior.value === null) return [];
  if (t.recent.n < STALE_MIN_N || t.prior.n < STALE_MIN_N) return [];
  const drop = t.prior.value - t.recent.value;
  if (drop < STALE_DROP) return [];
  const stale = input.sources.filter(
    (s) =>
      layerOf(s) !== null &&
      isFileKind(s.kind) &&
      s.lastChangedAt &&
      days(s.lastChangedAt, input.window.to) >= STALE_DAYS,
  );
  if (stale.length === 0) return [];
  return [
    finding('stale', ['bed'], {
      severity: 'low',
      title: `${stale.length} always-loaded file${stale.length === 1 ? '' : 's'} unchanged for ${STALE_DAYS}+ days while outcomes dropped`,
      sourceIds: stale.map((s) => s.id),
      tokensAtStake: 0,
      evidence: [
        `Main-thread success ${Math.round(t.prior.value * 100)}% (n=${t.prior.n}) before ${t.splitAt.slice(0, 10)} → ${Math.round(t.recent.value * 100)}% (n=${t.recent.n}) after.`,
        `Unchanged since: ${stale.map((s) => `${s.displayPath} ${s.lastChangedAt!.slice(0, 10)}`).join(', ')}.`,
      ],
      ...action(
        'review',
        'Re-read them against how the project works today; outdated instructions are a common cause.',
      ),
      caveat: 'Correlation, not causation: the drop may have nothing to do with these files.',
    }),
  ];
}

export function checkSkills(input: KnowledgeCheckInput): KnowledgeFinding[] {
  const byId = new Map(input.sources.map((s) => [s.id, s]));
  const out: KnowledgeFinding[] = [];
  for (const p of input.skillPairs) {
    if (p.similarity < SKILL_OVERLAP_SIMILARITY) continue;
    const a = byId.get(p.aId);
    const b = byId.get(p.bId);
    if (!a || !b) continue;
    out.push(
      finding('skill_overlap', [a.id, b.id], {
        severity: 'low',
        title: `Skills ${a.name ?? a.displayPath} and ${b.name ?? b.displayPath} have near-identical descriptions`,
        sourceIds: [a.id, b.id],
        tokensAtStake: approxTokens(Math.min(a.alwaysBytes, b.alwaysBytes)),
        evidence: [
          `Description similarity ${p.similarity.toFixed(2)} (threshold ${SKILL_OVERLAP_SIMILARITY}). The model picks between them from the description alone.`,
        ],
        ...action(
          'differentiate',
          'Merge them, or rewrite one description so each says when to use it and when not to.',
        ),
      }),
    );
  }
  return out;
}

export function checkNotLoaded(input: KnowledgeCheckInput): KnowledgeFinding[] {
  return input.sources
    .filter((s) => s.loadMode === 'not_loaded')
    .map((s) =>
      finding('not_loaded', [s.id], {
        severity: 'low',
        title: `${s.displayPath} never reaches the model`,
        sourceIds: [s.id],
        tokensAtStake: 0,
        evidence: [s.loadNote ?? 'Not part of the load chain.'],
        ...action(
          'review',
          'Fix what keeps it out, or delete it so nobody edits it expecting an effect.',
        ),
      }),
    );
}

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

/** Every check, sorted by severity then tokens at stake. */
export function knowledgeFindings(input: KnowledgeCheckInput): KnowledgeFinding[] {
  const refs = checkReferences(input);
  const flagged = new Set(
    refs.filter((f) => f.kind === 'orphan_memory').flatMap((f) => f.sourceIds),
  );
  const all = [
    ...checkBudget(input),
    ...checkDuplicates(input),
    ...refs,
    ...checkUsage(input, flagged),
    ...checkStale(input),
    ...checkSkills(input),
    ...checkNotLoaded(input),
  ];
  return all.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      b.tokensAtStake - a.tokensAtStake ||
      a.id.localeCompare(b.id),
  );
}

/** Findings drawn as weeds in the garden (the rest show in the soil strata and on the knowledge page). */
export const WEED_FINDING_KINDS = [
  'dangling_ref',
  'orphan_memory',
  'duplicate_passage',
  'over_cap',
] as const;
