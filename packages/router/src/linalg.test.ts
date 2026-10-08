import { describe, expect, it } from 'vitest';
import { createMiniLmEmbedder, EmbedderUnavailableError, fitTfidfLsa, cosine } from './embed';
import { jacobiEigen, truncatedSvd, type SparseRow } from './linalg';

const dense = (m: number[][]): SparseRow[] =>
  m.map((r) => {
    const idx: number[] = [];
    const val: number[] = [];
    r.forEach((v, i) => {
      if (v !== 0) {
        idx.push(i);
        val.push(v);
      }
    });
    return { idx, val };
  });

describe('jacobiEigen', () => {
  it('diagonalizes a symmetric matrix', () => {
    const { values } = jacobiEigen([
      [2, 1, 0],
      [1, 2, 0],
      [0, 0, 5],
    ]);
    expect([...values].sort((a, b) => a - b).map((v) => +v.toFixed(9))).toEqual([1, 3, 5]);
  });
});

describe('truncatedSvd', () => {
  // Singular values of this 4×3 matrix (numpy.linalg.svd): 5.4650, 3.0000(ish), …
  const a = [
    [3, 1, 1],
    [-1, 3, 1],
    [1, 1, 3],
    [0, 2, 0],
  ];
  it('recovers singular values (checked against AᵀA eigenvalues)', () => {
    const ata = [0, 1, 2].map((i) =>
      [0, 1, 2].map((j) => a.reduce((s, r) => s + r[i]! * r[j]!, 0)),
    );
    const expected = jacobiEigen(ata)
      .values.sort((x, y) => y - x)
      .map((v) => Math.sqrt(v));
    const svd = truncatedSvd(dense(a), 3, 2, { iterations: 30 });
    expect(svd.singularValues).toHaveLength(2);
    svd.singularValues.forEach((s, i) => expect(s).toBeCloseTo(expected[i]!, 6));
  });
  it('is deterministic', () => {
    const x = truncatedSvd(dense(a), 3, 2);
    const y = truncatedSvd(dense(a), 3, 2);
    expect(Array.from(x.basis.data)).toEqual(Array.from(y.basis.data));
  });
});

describe('TF-IDF + LSA embedder', () => {
  const corpus = [
    'write unit tests for the cart totals',
    'add tests for the coupon validation edge cases',
    'run terraform plan for staging and summarize risks',
    'terraform plan production infrastructure changes',
    'review the diff for correctness and missing tests',
  ];
  const e = fitTfidfLsa(corpus, { dims: 3 });
  it('puts related texts closer than unrelated ones', () => {
    const q = e.embed('tests for refunds');
    expect(cosine(q, e.embed(corpus[0]!))).toBeGreaterThan(cosine(q, e.embed(corpus[2]!)));
    const t = e.embed('terraform staging');
    expect(cosine(t, e.embed(corpus[3]!))).toBeGreaterThan(cosine(t, e.embed(corpus[1]!)));
  });
  it('returns a zero vector for out-of-vocabulary text and unit vectors otherwise', () => {
    expect(e.embed('zebra quokka').every((x) => x === 0)).toBe(true);
    expect(cosine(e.embed(corpus[0]!), e.embed(corpus[0]!))).toBeCloseTo(1, 9);
  });
  it('MiniLM is an opt-in stub that refuses to run offline', () => {
    expect(() => createMiniLmEmbedder()).toThrow(EmbedderUnavailableError);
    expect(() => createMiniLmEmbedder()).toThrow(/not available offline/);
  });
});
