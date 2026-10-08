import { describe, expect, it } from 'vitest';
import type { OutcomeLabel } from '@garden/core';
import { applyCalibration, fitLogistic, sigmoid, type CalibrationPoint } from './calibration';
import { mulberry32 } from './linalg';
import {
  buildRouterIndex,
  candidateKey,
  DEFAULT_WEIGHTS,
  margins,
  rank,
  route,
  type RouterInput,
} from './router';

const runs = (key: string, text: string, labels: OutcomeLabel[], start = 0): RouterInput['runs'] =>
  labels.map((label, i) => ({
    id: `${key}-${start + i}`,
    preview: text,
    label,
    candidateKeys: [key],
  }));

const A = candidateKey('agent', 'tw');
const B = candidateKey('agent', 'rev');
const C = candidateKey('agent', 'main');
const S = candidateKey('skill', 'mig');
const input: RouterInput = {
  candidates: [
    {
      kind: 'agent',
      id: 'tw',
      name: 'test-writer',
      description: 'Writes focused unit tests for a module.',
      plantIds: ['p1'],
    },
    {
      kind: 'agent',
      id: 'rev',
      name: 'code-reviewer',
      description: 'Reviews the current diff for correctness.',
      plantIds: ['p2'],
    },
    { kind: 'agent', id: 'main', name: 'main', plantIds: ['p3', 'p4'] },
    {
      kind: 'skill',
      id: 'mig',
      name: 'db-migrate',
      description: 'Create and roll back database migrations.',
      plantIds: [],
    },
  ],
  runs: [
    ...runs(A, 'Write unit tests for the cart totals module', [
      'success',
      'success',
      'success',
      'failure',
    ]),
    ...runs(A, 'Write unit tests for the invoice totals module', [
      'failure',
      'failure',
      'failure',
      'failure',
      'failure',
    ]),
    ...runs(B, 'Review the diff touching the refund flow', ['success', 'partial']),
    ...runs(C, 'Fix the crash in the coupon validation when the list is empty', [
      'success',
      'failure',
    ]),
    ...runs(C, 'thanks, commit it', ['success', 'success', 'success']),
    {
      id: 'both',
      preview: 'Write a migration that adds the late events partition',
      label: 'success',
      candidateKeys: [C, S],
    },
  ],
};
const index = buildRouterIndex(input);

describe('router index', () => {
  it('skips follow-up prompts that are not task statements', () => {
    expect(index.tasks.map((t) => t.text)).not.toContain('thanks, commit it');
    expect(index.runsIndexed).toBe(input.runs.length - 3);
  });
  it('is deterministic', () => {
    const again = buildRouterIndex(input);
    expect(route(again, 'write tests for totals')).toEqual(route(index, 'write tests for totals'));
  });
});

describe('route', () => {
  it('ranks by description and past tasks', () => {
    expect(route(index, 'add unit tests for the cart').candidates[0]?.name).toBe('test-writer');
    expect(route(index, 'review my diff').candidates[0]?.name).toBe('code-reviewer');
    expect(route(index, 'roll back a database migration').candidates[0]?.name).toBe('db-migrate');
    expect(route(index, 'coupon validation crashes on an empty list').candidates[0]?.name).toBe(
      'main',
    );
  });

  it('combines components with the documented weights', () => {
    const r = route(index, 'unit tests for cart totals');
    expect(r.method.weights).toEqual({ lexical: 0.45, embedding: 0.35, outcome: 0.2 });
    for (const c of r.candidates) {
      const { lexical, embedding, outcome } = c.components;
      for (const v of [lexical, embedding, outcome]) expect(v).toBeGreaterThanOrEqual(0);
      for (const v of [lexical, embedding, outcome]) expect(v).toBeLessThanOrEqual(1);
      expect(c.score).toBeCloseTo(0.45 * lexical + 0.35 * embedding + 0.2 * outcome, 12);
    }
  });

  it('outcome is the Beta(2,2)-smoothed success over the k most similar runs', () => {
    // k = 4: the four most similar test-writer runs. "cart totals" runs are most similar (3 of 4 succeeded).
    const [cart] = rank(index, 'unit tests for the cart totals module', { k: 4 }).filter(
      (s) => s.entry.input.name === 'test-writer',
    );
    expect(cart!.knn.n).toBe(4);
    expect(cart!.outcome).toBeCloseTo((3 + 2) / (4 + 4), 12);
    const [inv] = rank(index, 'unit tests for the invoice totals module', { k: 4 }).filter(
      (s) => s.entry.input.name === 'test-writer',
    );
    expect(inv!.outcome).toBeCloseTo((0 + 2) / (4 + 4), 12);
  });

  it('outcome falls back to the 0.5 prior with no similar runs', () => {
    const s = rank(index, 'roll back a database migration').find(
      (x) => x.entry.input.name === 'code-reviewer',
    )!;
    expect(s.knn.n).toBe(0);
    expect(s.outcome).toBe(0.5);
  });

  it('gives reasons: description terms, similar tasks with outcomes, history with n', () => {
    const top = route(index, 'write unit tests for the invoice totals').candidates[0]!;
    expect(top.name).toBe('test-writer');
    const kinds = top.reasons.map((r) => r.kind);
    expect(kinds).toContain('description_match');
    expect(kinds).toContain('similar_past_task');
    expect(kinds.at(-1)).toBe('outcome_history');
    expect(top.reasons.find((r) => r.kind === 'description_match')!.text).toMatch(/“unit”/);
    expect(top.reasons.find((r) => r.kind === 'similar_past_task')!.text).toMatch(
      /invoice totals.*5 failure/,
    );
    expect(top.reasons.at(-1)!.text).toMatch(/n=\d+/);
    expect(top.reasons.filter((r) => r.kind === 'similar_past_task').length).toBeLessThanOrEqual(3);
  });

  it('returns no candidates for a query that matches nothing', () => {
    expect(route(index, 'zebra quokka').candidates).toEqual([]);
  });

  it('carries plant ids and reports the method', () => {
    const r = route(index, 'review the diff');
    expect(r.candidates[0]!.plantIds).toEqual(['p2']);
    expect(r.method).toMatchObject({
      lexical: 'bm25',
      embedding: 'tfidf-lsa',
      corpusSize: index.runsIndexed,
    });
    expect(
      route(index, 'review', { weights: { lexical: 1, embedding: 0, outcome: 0 } }).method
        .embedding,
    ).toBe('none');
  });

  it('confidence is the calibrated logistic of score and margin, highest for the top candidate', () => {
    const r = route(index, 'add unit tests for the cart');
    const m = margins(r.candidates);
    expect(m[0]).toBeGreaterThan(0);
    r.candidates.slice(1).forEach((_, i) => expect(m[i + 1]).toBeLessThanOrEqual(0));
    expect(r.candidates[0]!.confidence).toBeGreaterThan(r.candidates[1]!.confidence);
    const cal = { intercept: -1, wScore: 2, wMargin: 3, text: 't' };
    const r2 = route(index, 'add unit tests for the cart', { calibration: cal });
    expect(r2.candidates[0]!.confidence).toBeCloseTo(
      sigmoid(-1 + 2 * r2.candidates[0]!.score + 3 * m[0]!),
      12,
    );
    expect(r2.method.calibration).toBe('t');
    expect(
      DEFAULT_WEIGHTS.lexical + DEFAULT_WEIGHTS.embedding + DEFAULT_WEIGHTS.outcome,
    ).toBeCloseTo(1, 12);
  });
});

describe('fitLogistic', () => {
  it('recovers the parameters of a known logistic model', () => {
    const rnd = mulberry32(3);
    const truth = { intercept: -2, wScore: 3, wMargin: 5 };
    const pts: CalibrationPoint[] = Array.from({ length: 4000 }, () => {
      const score = rnd();
      const margin = rnd() - 0.5;
      const p = applyCalibration({ ...truth, text: '' }, score, margin);
      return { score, margin, y: rnd() < p ? 1 : 0 };
    });
    const fit = fitLogistic(pts, 0);
    expect(fit.intercept).toBeCloseTo(truth.intercept, 0);
    expect(fit.wScore).toBeCloseTo(truth.wScore, 0);
    expect(fit.wMargin).toBeCloseTo(truth.wMargin, 0);
  });
});

describe('per-planting outcome', () => {
  it('gives each bed its own outcome and confidence from that bed’s similar runs only', () => {
    const tw = candidateKey('agent', 'tw');
    const mk = (bed: string, labels: OutcomeLabel[]) =>
      labels.map((label, i) => ({
        id: `${bed}-${i}`,
        preview: 'Write unit tests for the invoice totals module',
        label,
        plantId: bed,
        candidateKeys: [tw],
      }));
    const idx = buildRouterIndex({
      candidates: [
        {
          kind: 'agent',
          id: 'tw',
          name: 'test-writer',
          description: 'Writes focused unit tests for a module.',
          plantIds: ['shop', 'legacy'],
        },
      ],
      runs: [
        ...mk('shop', ['success', 'success', 'success', 'success']),
        ...mk('legacy', ['failure', 'failure', 'failure', 'failure']),
      ],
    });
    const [c] = route(idx, 'write unit tests for invoice totals').candidates;
    const shop = c!.plantings!.find((p) => p.plantId === 'shop')!;
    const legacy = c!.plantings!.find((p) => p.plantId === 'legacy')!;
    expect(shop.n).toBe(4);
    expect(legacy.n).toBe(4);
    expect(shop.outcome).toBeCloseTo((4 + 2) / (4 + 4)); // Beta(2,2)
    expect(legacy.outcome).toBeCloseTo(2 / 8);
    expect(shop.confidence).toBeGreaterThan(c!.confidence);
    expect(legacy.confidence).toBeLessThan(c!.confidence);
  });
});
