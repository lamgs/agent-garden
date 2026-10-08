/**
 * "Which one do I call?" Ranks agents and skills for a task description.
 *
 *   score = 0.45·lexical + 0.35·embedding + 0.20·outcome
 *
 * - lexical: BM25 over one document per candidate (name, description, and the redacted task
 *   previews of its past runs; successful runs weigh more), divided by the best score for the query.
 * - embedding: TF-IDF + LSA cosine. Half against the candidate's name + description, half the mean
 *   of its 3 most similar past tasks (whichever exists when only one does). Negative cosines → 0.
 * - outcome: Beta(2,2)-smoothed success over the candidate's k most similar past runs
 *   (similarity ≥ `minSimilarity`); the prior mean 0.5 when it has none.
 *
 * Pure: the caller supplies candidates and runs (already redacted by ingestion).
 */
import {
  betaSmoothed,
  successCredit,
  type ID,
  type OutcomeLabel,
  type RouterCandidate,
  type RouterResult,
} from '@garden/core';
import { bm25Scores, buildBm25, normalizeByMax, type Bm25Index } from './bm25';
import { applyCalibration, DEFAULT_CALIBRATION, type CalibrationModel } from './calibration';
import { cosine, fitTfidfLsa, type TfidfLsaEmbedder } from './embed';
import { tokenize } from './text';

export interface RouterCandidateInput {
  kind: 'agent' | 'skill';
  id: ID;
  name: string;
  description?: string | null;
  plantIds: ID[];
}

export interface RouterRunInput {
  id: ID;
  /** Redacted, truncated task preview (from the store). */
  preview: string;
  label: OutcomeLabel;
  /** Candidate keys (`candidateKey(kind, id)`) this run counts for: its agent and any skill it invoked. */
  candidateKeys: string[];
}

export interface RouterInput {
  candidates: RouterCandidateInput[];
  runs: RouterRunInput[];
}

export interface Weights {
  lexical: number;
  embedding: number;
  outcome: number;
}

export const DEFAULT_WEIGHTS: Weights = { lexical: 0.45, embedding: 0.35, outcome: 0.2 };

/** Per-run weight in the candidate's lexical document and profile: successful runs weighted up. */
export const RUN_WEIGHT: Record<OutcomeLabel, number> = {
  success: 1,
  partial: 0.7,
  unknown: 0.6,
  failure: 0.35,
};

/** Name and description weight, in "runs". */
export const PROFILE_WEIGHT = 3;
/** Previews with fewer content tokens are follow-ups ("thanks, commit it"), not task statements. */
export const MIN_TASK_TOKENS = 3;

export const candidateKey = (kind: 'agent' | 'skill', id: ID): string => `${kind}:${id}`;

interface TaskDoc {
  text: string;
  vec: Float64Array;
}

interface CandidateTask {
  task: number;
  labels: OutcomeLabel[];
  weight: number;
}

interface CandidateEntry {
  key: string;
  input: RouterCandidateInput;
  profileVec: Float64Array | null;
  tasks: CandidateTask[];
  runsTotal: number;
  credit: { sum: number; n: number };
  descriptionWords: Map<string, string>;
}

export interface RouterIndex {
  candidates: CandidateEntry[];
  tasks: TaskDoc[];
  bm25: Bm25Index;
  embedder: TfidfLsaEmbedder;
  runsIndexed: number;
}

const profileText = (c: RouterCandidateInput) =>
  `${c.name.replace(/[-_:]/g, ' ')}. ${c.description ?? ''}`.trim();

export function buildRouterIndex(input: RouterInput): RouterIndex {
  const byKey = new Map<string, CandidateEntry>();
  const candidates = [...input.candidates].sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  for (const c of candidates) {
    const words = new Map<string, string>();
    for (const w of profileText(c).match(/[A-Za-z][A-Za-z0-9]*/g) ?? []) {
      const s = tokenize(w)[0];
      if (s && !words.has(s)) words.set(s, w.toLowerCase());
    }
    byKey.set(candidateKey(c.kind, c.id), {
      key: candidateKey(c.kind, c.id),
      input: c,
      profileVec: null,
      tasks: [],
      runsTotal: 0,
      credit: { sum: 0, n: 0 },
      descriptionWords: words,
    });
  }

  // Unique task texts (stable order: first seen in the input order of runs, which is by start time).
  const taskIdx = new Map<string, number>();
  const taskTexts: string[] = [];
  const perCandidate = new Map<string, Map<number, OutcomeLabel[]>>();
  let runsIndexed = 0;
  for (const r of input.runs) {
    const owners = r.candidateKeys.map((k) => byKey.get(k)).filter((c) => c !== undefined);
    for (const c of owners) {
      c.runsTotal++;
      const cr = successCredit(r.label);
      if (cr !== null) {
        c.credit.sum += cr;
        c.credit.n++;
      }
    }
    const text = r.preview.trim();
    if (!owners.length || tokenize(text).length < MIN_TASK_TOKENS) continue;
    runsIndexed++;
    let ti = taskIdx.get(text);
    if (ti === undefined) {
      ti = taskTexts.length;
      taskIdx.set(text, ti);
      taskTexts.push(text);
    }
    for (const c of owners) {
      const m = perCandidate.get(c.key) ?? new Map<number, OutcomeLabel[]>();
      perCandidate.set(c.key, m);
      m.set(ti, [...(m.get(ti) ?? []), r.label]);
    }
  }

  const entries = [...byKey.values()];
  const profiles = entries.map((c) => profileText(c.input));
  const embedder = fitTfidfLsa([...profiles, ...taskTexts]);
  const tasks: TaskDoc[] = taskTexts.map((text) => ({ text, vec: embedder.embed(text) }));

  const docs = entries.map((c, i) => {
    const tf = new Map<string, number>();
    const add = (tokens: string[], w: number) => {
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + w);
    };
    add(tokenize(profiles[i]!), PROFILE_WEIGHT);
    const vec = embedder.embed(profiles[i]!);
    c.profileVec = vec.some((x) => x !== 0) ? vec : null;
    for (const [task, labels] of perCandidate.get(c.key) ?? []) {
      const mean = labels.reduce((s, l) => s + RUN_WEIGHT[l], 0) / labels.length;
      const weight = mean * (1 + Math.log(labels.length));
      c.tasks.push({ task, labels, weight });
      add(tokenize(taskTexts[task]!), weight);
    }
    return tf;
  });

  return { candidates: entries, tasks, bm25: buildBm25(docs), embedder, runsIndexed };
}

export interface RouteOptions {
  weights?: Weights;
  /** Nearest past runs per candidate for the outcome component. */
  k?: number;
  /** Cosine at or above which a past run counts as "similar". */
  minSimilarity?: number;
  /** Candidates returned. */
  limit?: number;
  calibration?: CalibrationModel;
}

export const DEFAULT_K = 10;
export const DEFAULT_MIN_SIMILARITY = 0.3;

interface Scored {
  entry: CandidateEntry;
  lexical: number;
  embedding: number;
  outcome: number;
  score: number;
  neighbors: { task: number; sim: number; labels: OutcomeLabel[] }[];
  knn: { sum: number; n: number; counts: Record<OutcomeLabel, number> };
}

/** Score every candidate (unsorted order = index order). Exposed for evaluation. */
export function scoreAll(index: RouterIndex, query: string, opts: RouteOptions = {}): Scored[] {
  const w = opts.weights ?? DEFAULT_WEIGHTS;
  const k = opts.k ?? DEFAULT_K;
  const minSim = opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const terms = tokenize(query);
  const lexical = normalizeByMax(bm25Scores(index.bm25, terms));
  const q = index.embedder.embed(query);

  return index.candidates.map((entry, i) => {
    const sims = entry.tasks
      .map((t) => ({ task: t.task, sim: cosine(q, index.tasks[t.task]!.vec), labels: t.labels }))
      .sort((a, b) => b.sim - a.sim || a.task - b.task);
    const top3 = sims.slice(0, 3);
    const taskSim = top3.length ? top3.reduce((s, x) => s + x.sim, 0) / top3.length : null;
    const profSim = entry.profileVec ? cosine(q, entry.profileVec) : null;
    const embRaw =
      taskSim !== null && profSim !== null ? (taskSim + profSim) / 2 : (taskSim ?? profSim ?? 0);
    const embedding = Math.max(0, Math.min(1, embRaw));

    // Outcome kNN: walk the most similar tasks, expanding to runs, until k runs.
    const counts: Record<OutcomeLabel, number> = { success: 0, partial: 0, failure: 0, unknown: 0 };
    let sum = 0;
    let n = 0;
    let taken = 0;
    const neighbors: Scored['neighbors'] = [];
    for (const s of sims) {
      if (taken >= k || s.sim < minSim) break;
      neighbors.push(s);
      for (const l of s.labels) {
        if (taken >= k) break;
        taken++;
        counts[l]++;
        const c = successCredit(l);
        if (c !== null) {
          sum += c;
          n++;
        }
      }
    }
    const outcome = betaSmoothed(sum, n);
    const lex = lexical[i] ?? 0;
    return {
      entry,
      lexical: lex,
      embedding,
      outcome,
      score: w.lexical * lex + w.embedding * embedding + w.outcome * outcome,
      neighbors,
      knn: { sum, n, counts },
    };
  });
}

/** Ranked, best first; ties broken by kind then name (deterministic). */
export function rank(index: RouterIndex, query: string, opts: RouteOptions = {}): Scored[] {
  return scoreAll(index, query, opts).sort(
    (a, b) =>
      b.score - a.score ||
      a.entry.input.kind.localeCompare(b.entry.input.kind) ||
      a.entry.input.name.localeCompare(b.entry.input.name),
  );
}

/** Score minus the best other candidate's score (positive only for the top candidate). */
export function margins(ranked: readonly { score: number }[]): number[] {
  return ranked.map((c, i) => c.score - (i === 0 ? (ranked[1]?.score ?? 0) : ranked[0]!.score));
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function outcomeText(labels: readonly OutcomeLabel[]): string {
  const c = { success: 0, partial: 0, failure: 0, unknown: 0 };
  for (const l of labels) c[l]++;
  const parts = (['success', 'partial', 'failure', 'unknown'] as const)
    .filter((k) => c[k] > 0)
    .map((k) => `${c[k]} ${k}`);
  return `${labels.length} run${labels.length === 1 ? '' : 's'}: ${parts.join(', ')}`;
}

function reasonsFor(
  s: Scored,
  queryTerms: Set<string>,
  index: RouterIndex,
): RouterCandidate['reasons'] {
  const reasons: RouterCandidate['reasons'] = [];
  const matched = [...s.entry.descriptionWords]
    .filter(([st]) => queryTerms.has(st))
    .map(([, w]) => w);
  if (matched.length) {
    reasons.push({
      kind: 'description_match',
      text: `Name/description matches ${matched.map((w) => `“${w}”`).join(', ')}${
        s.entry.input.description ? `: “${clip(s.entry.input.description, 110)}”` : ''
      }`,
    });
  }
  for (const nb of s.neighbors.slice(0, 3)) {
    reasons.push({
      kind: 'similar_past_task',
      text: `“${clip(index.tasks[nb.task]!.text)}” (similarity ${nb.sim.toFixed(2)}): ${outcomeText(nb.labels)}`,
    });
  }
  const { n, counts } = s.knn;
  const all = s.entry.credit;
  const overall = all.n
    ? ` All runs in the window: ${s.entry.runsTotal}, ${pct(all.sum / all.n)} success (n=${all.n}).`
    : s.entry.runsTotal
      ? ` All runs in the window: ${s.entry.runsTotal}, none with a known outcome.`
      : ' No runs in the window.';
  reasons.push({
    kind: 'outcome_history',
    text:
      (n > 0
        ? `Similar past runs: ${counts.success} success, ${counts.partial} partial, ${counts.failure} failure` +
          `${counts.unknown ? `, ${counts.unknown} unknown (excluded)` : ''} → ${pct(s.outcome)} Beta(2,2)-smoothed (n=${n}).`
        : `No similar past runs with a known outcome: outcome is the Beta(2,2) prior, 50% (n=0).`) +
      overall,
  });
  return reasons;
}

/** Full RouterResult for a query. */
export function route(index: RouterIndex, query: string, opts: RouteOptions = {}): RouterResult {
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const cal = opts.calibration ?? DEFAULT_CALIBRATION;
  // A candidate the query shares no words or meaning with is not a suggestion, whatever its prior.
  const ranked = rank(index, query, opts).filter((s) => s.lexical > 0 || s.embedding > 0);
  const m = margins(ranked);
  const terms = new Set(tokenize(query));
  const limit = opts.limit ?? 5;
  return {
    query,
    method: {
      lexical: 'bm25',
      embedding: weights.embedding > 0 ? 'tfidf-lsa' : 'none',
      weights,
      calibration: cal.text,
      corpusSize: index.runsIndexed,
    },
    candidates: ranked.slice(0, limit).map((s, i) => ({
      kind: s.entry.input.kind,
      id: s.entry.input.id,
      name: s.entry.input.name,
      plantIds: s.entry.input.plantIds,
      score: s.score,
      components: { lexical: s.lexical, embedding: s.embedding, outcome: s.outcome },
      confidence: applyCalibration(cal, s.score, m[i] ?? 0),
      reasons: reasonsFor(s, terms, index),
    })),
  };
}
