/**
 * Okapi BM25 over weighted bag-of-words documents (term frequencies may be fractional, so
 * successful past tasks can count more than failed ones).
 */

export interface Bm25Options {
  k1?: number;
  b?: number;
}

export interface Bm25Index {
  docs: Map<string, number>[];
  lengths: number[];
  avgLength: number;
  df: Map<string, number>;
  k1: number;
  b: number;
}

export function buildBm25(docs: Map<string, number>[], opts: Bm25Options = {}): Bm25Index {
  const df = new Map<string, number>();
  const lengths = docs.map((d) => {
    let len = 0;
    for (const [t, tf] of d) {
      if (tf <= 0) continue;
      len += tf;
      df.set(t, (df.get(t) ?? 0) + 1);
    }
    return len;
  });
  const avgLength = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
  return { docs, lengths, avgLength, df, k1: opts.k1 ?? 1.2, b: opts.b ?? 0.75 };
}

/** BM25+-style non-negative idf (Lucene's): ln(1 + (N − df + 0.5) / (df + 0.5)). */
export function idf(index: Bm25Index, term: string): number {
  const n = index.docs.length;
  const df = index.df.get(term) ?? 0;
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

/** Raw BM25 score of every document for the (deduplicated) query terms. */
export function bm25Scores(index: Bm25Index, queryTerms: readonly string[]): number[] {
  const terms = [...new Set(queryTerms)];
  const { k1, b, avgLength } = index;
  return index.docs.map((d, i) => {
    let s = 0;
    const norm = 1 - b + b * ((index.lengths[i] ?? 0) / (avgLength || 1));
    for (const t of terms) {
      const tf = d.get(t) ?? 0;
      if (tf <= 0) continue;
      s += idf(index, t) * ((tf * (k1 + 1)) / (tf + k1 * norm));
    }
    return s;
  });
}

/** Scores divided by the best score for this query (0..1; all zero when nothing matches). */
export function normalizeByMax(scores: readonly number[]): number[] {
  const max = Math.max(0, ...scores);
  return scores.map((s) => (max > 0 ? s / max : 0));
}
