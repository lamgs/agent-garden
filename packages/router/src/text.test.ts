import { describe, expect, it } from 'vitest';
import { bm25Scores, buildBm25, normalizeByMax } from './bm25';
import { stem, termCounts, tokenize } from './text';

describe('tokenize / stem', () => {
  it('joins common inflections', () => {
    const same = (a: string, b: string) => expect(stem(a), `${a} vs ${b}`).toBe(stem(b));
    same('tests', 'testing');
    same('test', 'tested');
    same('migrate', 'migrations');
    same('plan', 'planner');
    same('review', 'reviewer');
    same('profile', 'profiler');
    same('queries', 'query');
    same('changes', 'changed');
  });
  it('drops stopwords, numbers, extensions and splits paths and camelCase', () => {
    expect(
      tokenize('Please fix the RevenueChart in src/components/RevenueChart.tsx v2 2026'),
    ).toEqual(['fix', 'revenu', 'chart', 'component', 'revenu', 'chart', 'v2']);
    expect(tokenize("it's what we need")).toEqual([]);
  });
  it('counts terms', () => {
    expect([...termCounts(['a', 'b', 'a'])]).toEqual([
      ['a', 2],
      ['b', 1],
    ]);
  });
});

describe('BM25', () => {
  const docs = [
    termCounts(tokenize('writes unit tests and runs them')),
    termCounts(tokenize('reviews the diff for bugs')),
    termCounts(tokenize('terraform plan for staging')),
  ];
  const idx = buildBm25(docs);
  it('ranks the matching document first and scores non-matches zero', () => {
    const s = bm25Scores(idx, tokenize('write tests'));
    expect(s[0]).toBeGreaterThan(0);
    expect(s[1]).toBe(0);
    expect(s[2]).toBe(0);
  });
  it('normalizes by the best score, all zeros when nothing matches', () => {
    expect(Math.max(...normalizeByMax(bm25Scores(idx, tokenize('review diff'))))).toBe(1);
    expect(normalizeByMax(bm25Scores(idx, tokenize('zebra')))).toEqual([0, 0, 0]);
  });
  it('accepts fractional term weights (weighted-up successful tasks score higher)', () => {
    const w = buildBm25([new Map([['x', 2]]), new Map([['x', 0.5]])]);
    const [a, b] = bm25Scores(w, ['x']);
    expect(a!).toBeGreaterThan(b!);
  });
});
