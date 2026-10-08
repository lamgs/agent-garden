/**
 * Embedders. The default is TF-IDF + LSA (truncated SVD), fitted on the user's own corpus at
 * index time: deterministic, offline, no model download. MiniLM is an opt-in interface only.
 */
import { dot, normalize, project, truncatedSvd, type Dense, type SparseRow } from './linalg';
import { termCounts, tokenize } from './text';

export type EmbedderId = 'tfidf-lsa' | 'minilm';

export interface Embedder {
  readonly id: EmbedderId;
  /** Embedding size. */
  readonly dims: number;
  /** Unit-length vector, or all zeros when the text shares no vocabulary with the corpus. */
  embed(text: string): Float64Array;
}

export function cosine(a: Float64Array, b: Float64Array): number {
  return dot(a, b);
}

export interface LsaOptions {
  /** Target rank (capped by corpus size). */
  dims?: number;
  iterations?: number;
  seed?: number;
}

export interface TfidfLsaEmbedder extends Embedder {
  readonly id: 'tfidf-lsa';
  readonly vocabSize: number;
  readonly corpusSize: number;
  readonly singularValues: readonly number[];
}

/** Fit TF-IDF (sublinear tf, smoothed idf, l2) + rank-k LSA on `corpus`. */
export function fitTfidfLsa(corpus: readonly string[], opts: LsaOptions = {}): TfidfLsaEmbedder {
  const vocab = new Map<string, number>();
  const docCounts = corpus.map((text) => termCounts(tokenize(text)));
  // Vocabulary in first-seen order: deterministic for a given corpus order.
  for (const c of docCounts) for (const t of c.keys()) if (!vocab.has(t)) vocab.set(t, vocab.size);
  const df = new Float64Array(vocab.size);
  for (const c of docCounts) for (const t of c.keys()) df[vocab.get(t)!]! += 1;
  const n = corpus.length;
  const idf = Array.from(df, (d) => Math.log((1 + n) / (1 + d)) + 1);

  const vectorize = (counts: Map<string, number>): SparseRow => {
    const idx: number[] = [];
    const val: number[] = [];
    for (const [t, c] of counts) {
      const i = vocab.get(t);
      if (i === undefined) continue;
      idx.push(i);
      val.push((1 + Math.log(c)) * idf[i]!);
    }
    const norm = Math.sqrt(val.reduce((s, v) => s + v * v, 0));
    return { idx, val: norm > 0 ? val.map((v) => v / norm) : val };
  };
  const rows = docCounts.map(vectorize);
  const svd = vocab.size
    ? truncatedSvd(rows, vocab.size, opts.dims ?? 64, {
        iterations: opts.iterations ?? 12,
        seed: opts.seed ?? 7,
      })
    : { basis: { rows: 0, cols: 0, data: new Float64Array(0) } as Dense, singularValues: [] };

  return {
    id: 'tfidf-lsa',
    dims: svd.basis.cols,
    vocabSize: vocab.size,
    corpusSize: n,
    singularValues: svd.singularValues,
    embed: (text) => normalize(project(svd.basis, vectorize(termCounts(tokenize(text))))),
  };
}

export class EmbedderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbedderUnavailableError';
  }
}

/**
 * Opt-in MiniLM sentence embedder: NOT enabled. Agent Garden never downloads models or calls a
 * remote API at runtime, and no MiniLM weights ship with the repo, so this always throws.
 * The interface exists so a user who vendors weights locally can plug one in later.
 */
export function createMiniLmEmbedder(_opts: { modelPath?: string } = {}): Embedder {
  throw new EmbedderUnavailableError(
    'MiniLM embeddings are not available offline: no model weights are bundled and Agent Garden ' +
      'never downloads models. The router uses TF-IDF + LSA (embedding: "tfidf-lsa") instead.',
  );
}
