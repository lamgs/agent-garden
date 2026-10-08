/**
 * Just enough dense/sparse linear algebra for a deterministic truncated SVD:
 * block subspace iteration on AᵀA, then Rayleigh–Ritz with a cyclic Jacobi eigensolver.
 */

/** Sparse row: parallel arrays of column indices and values. */
export interface SparseRow {
  idx: number[];
  val: number[];
}

/** Small seeded PRNG (mulberry32), so the starting subspace and therefore the result are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Column-major dense matrix: `cols` columns of length `rows`. */
export interface Dense {
  rows: number;
  cols: number;
  data: Float64Array;
}

const col = (m: Dense, j: number) => m.data.subarray(j * m.rows, (j + 1) * m.rows);

/** Modified Gram–Schmidt in place. Columns that collapse to ~0 are zeroed. */
export function orthonormalize(m: Dense): void {
  for (let j = 0; j < m.cols; j++) {
    const v = col(m, j);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < j; i++) {
        const u = col(m, i);
        let d = 0;
        for (let r = 0; r < m.rows; r++) d += u[r]! * v[r]!;
        for (let r = 0; r < m.rows; r++) v[r]! -= d * u[r]!;
      }
    }
    let n = 0;
    for (let r = 0; r < m.rows; r++) n += v[r]! * v[r]!;
    n = Math.sqrt(n);
    if (n < 1e-10) v.fill(0);
    else for (let r = 0; r < m.rows; r++) v[r]! /= n;
  }
}

/** Y = A·Q, A sparse (nDocs × nTerms), Q dense (nTerms × k) → Y (nDocs × k). */
function mulAQ(rows: readonly SparseRow[], q: Dense): Dense {
  const y: Dense = {
    rows: rows.length,
    cols: q.cols,
    data: new Float64Array(rows.length * q.cols),
  };
  for (let d = 0; d < rows.length; d++) {
    const { idx, val } = rows[d]!;
    for (let j = 0; j < q.cols; j++) {
      let s = 0;
      const off = j * q.rows;
      for (let t = 0; t < idx.length; t++) s += val[t]! * q.data[off + idx[t]!]!;
      y.data[j * y.rows + d] = s;
    }
  }
  return y;
}

/** Z = Aᵀ·Y → (nTerms × k). */
function mulAtY(rows: readonly SparseRow[], nTerms: number, y: Dense): Dense {
  const z: Dense = { rows: nTerms, cols: y.cols, data: new Float64Array(nTerms * y.cols) };
  for (let d = 0; d < rows.length; d++) {
    const { idx, val } = rows[d]!;
    for (let j = 0; j < y.cols; j++) {
      const yd = y.data[j * y.rows + d]!;
      if (yd === 0) continue;
      const off = j * nTerms;
      for (let t = 0; t < idx.length; t++) z.data[off + idx[t]!]! += val[t]! * yd;
    }
  }
  return z;
}

/** Symmetric eigen-decomposition (cyclic Jacobi). Returns eigenvalues and column eigenvectors. */
export function jacobiEigen(
  a: number[][],
  maxSweeps = 100,
): { values: number[]; vectors: number[][] } {
  const n = a.length;
  const m = a.map((r) => [...r]);
  const v: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += m[p]![q]! ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = m[p]![q]!;
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (m[q]![q]! - m[p]![p]!) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const mkp = m[k]![p]!;
          const mkq = m[k]![q]!;
          m[k]![p] = c * mkp - s * mkq;
          m[k]![q] = s * mkp + c * mkq;
        }
        for (let k = 0; k < n; k++) {
          const mpk = m[p]![k]!;
          const mqk = m[q]![k]!;
          m[p]![k] = c * mpk - s * mqk;
          m[q]![k] = s * mpk + c * mqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k]![p]!;
          const vkq = v[k]![q]!;
          v[k]![p] = c * vkp - s * vkq;
          v[k]![q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: m.map((r, i) => r[i]!), vectors: v };
}

export interface TruncatedSvd {
  /** Term basis U (nTerms × k), column-major, columns sorted by singular value (desc). */
  basis: Dense;
  singularValues: number[];
}

/**
 * Rank-k truncated SVD of a sparse nDocs × nTerms matrix. Deterministic for a given seed:
 * seeded start, fixed iteration count, sign-normalized vectors.
 */
export function truncatedSvd(
  rows: readonly SparseRow[],
  nTerms: number,
  k: number,
  opts: { iterations?: number; seed?: number; oversample?: number } = {},
): TruncatedSvd {
  const rank = Math.max(1, Math.min(k, nTerms, rows.length));
  const width = Math.min(nTerms, rank + (opts.oversample ?? 8));
  const rnd = mulberry32(opts.seed ?? 7);
  let q: Dense = { rows: nTerms, cols: width, data: new Float64Array(nTerms * width) };
  for (let i = 0; i < q.data.length; i++) q.data[i] = rnd() - 0.5;
  orthonormalize(q);
  for (let it = 0; it < (opts.iterations ?? 12); it++) {
    q = mulAtY(rows, nTerms, mulAQ(rows, q));
    orthonormalize(q);
  }
  // Rayleigh–Ritz: C = (AQ)ᵀ(AQ) = Wᵀ Λ W, then U = Q·W.
  const b = mulAQ(rows, q);
  const c = Array.from({ length: width }, (_, i) =>
    Array.from({ length: width }, (_, j) => {
      let s = 0;
      const ci = col(b, i);
      const cj = col(b, j);
      for (let r = 0; r < b.rows; r++) s += ci[r]! * cj[r]!;
      return s;
    }),
  );
  const { values, vectors } = jacobiEigen(c);
  const order = values
    .map((v, i) => [v, i] as const)
    .sort((x, y) => y[0] - x[0] || x[1] - y[1])
    .slice(0, rank)
    .filter(([v]) => v > 1e-9);
  const basis: Dense = {
    rows: nTerms,
    cols: order.length,
    data: new Float64Array(nTerms * order.length),
  };
  order.forEach(([, wi], j) => {
    const out = col(basis, j);
    for (let i = 0; i < width; i++) {
      const w = vectors[i]![wi]!;
      if (w === 0) continue;
      const qi = col(q, i);
      for (let r = 0; r < nTerms; r++) out[r]! += w * qi[r]!;
    }
    // Sign convention: the largest-magnitude component is positive.
    let big = 0;
    for (let r = 0; r < nTerms; r++) if (Math.abs(out[r]!) > Math.abs(big)) big = out[r]!;
    if (big < 0) for (let r = 0; r < nTerms; r++) out[r] = -out[r]!;
  });
  return { basis, singularValues: order.map(([v]) => Math.sqrt(v)) };
}

/** Project a sparse vector onto the basis: Uᵀx. */
export function project(basis: Dense, x: SparseRow): Float64Array {
  const out = new Float64Array(basis.cols);
  for (let j = 0; j < basis.cols; j++) {
    let s = 0;
    const off = j * basis.rows;
    for (let t = 0; t < x.idx.length; t++) s += x.val[t]! * basis.data[off + x.idx[t]!]!;
    out[j] = s;
  }
  return out;
}

export function normalize(v: Float64Array): Float64Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}

export function dot(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * (b[i] ?? 0);
  return s;
}
