/**
 * M6 gate: the router eval over the demo dataset (seed 42), the ablation, calibration, and the
 * /api/route endpoint. The demo is generated into a temp dir outside any git worktree.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RouterResult } from '@garden/core';
import type { Store } from '@garden/ingest';
import {
  ABLATIONS,
  ablationTable,
  bySplit,
  calibrationReport,
  DEFAULT_CALIBRATION,
  evaluate,
  EVAL_QUERIES,
  fitCalibration,
  type RouterIndex,
} from '@garden/router';
import { createApp, gardenView } from './app';
import { DEMO_AS_OF, demoStore, windowIndex } from './route-eval';

let store: Store;
let dispose: () => void;
let index: RouterIndex;

beforeAll(async () => {
  ({ store, dispose } = await demoStore());
  index = windowIndex(store);
}, 180_000);
afterAll(() => dispose?.());

describe('router eval (M6 gate)', () => {
  it('has ~30 hand-written queries that do not copy demo task previews', () => {
    expect(EVAL_QUERIES.length).toBeGreaterThanOrEqual(30);
    const previews = (
      store.db.prepare('SELECT DISTINCT task_preview AS p FROM runs').all() as { p: string }[]
    ).map((r) => r.p.toLowerCase().replace(/[^a-z0-9 ]/g, ''));
    for (const { q } of EVAL_QUERIES) {
      const n = q.toLowerCase().replace(/[^a-z0-9 ]/g, '');
      for (const p of previews) {
        expect(p === n || p.includes(n) || (p.length > 20 && n.includes(p)), `${q} ≈ ${p}`).toBe(
          false,
        );
      }
    }
    // Every expected answer is a real candidate in the demo index.
    const names = new Set(index.candidates.map((c) => `${c.input.kind}:${c.input.name}`));
    for (const q of EVAL_QUERIES)
      for (const e of q.expect) expect(names).toContain(`${e.kind}:${e.name}`);
  });

  it('top-3 accuracy ≥ 80% overall and on the holdout third', () => {
    const s = bySplit(evaluate(index));
    console.log(`\n${ablationTable(index)}\n`);
    expect(s.all.top3).toBeGreaterThanOrEqual(0.8);
    expect(s.holdout.top3).toBeGreaterThanOrEqual(0.8);
    expect(s.holdout.n).toBe(Math.floor(EVAL_QUERIES.length / 3));
  });

  it('reports the ablation for every stage', () => {
    for (const a of ABLATIONS) {
      const s = bySplit(evaluate(index, a.weights));
      expect(s.all.n).toBe(EVAL_QUERIES.length);
      expect(s.all.top3).toBeGreaterThanOrEqual(s.all.top1);
    }
  });

  it('the recorded calibration matches a refit on the calibration split', () => {
    const refit = fitCalibration(index, 'test');
    expect(DEFAULT_CALIBRATION.intercept).toBeCloseTo(refit.intercept, 2);
    expect(DEFAULT_CALIBRATION.wScore).toBeCloseTo(refit.wScore, 2);
    expect(DEFAULT_CALIBRATION.wMargin).toBeCloseTo(refit.wMargin, 2);
    const rep = calibrationReport(index, DEFAULT_CALIBRATION);
    // Better than always predicting the base rate (1 correct in 5 → Brier 0.16).
    expect(rep.holdout.brier).toBeLessThan(0.16);
    expect(DEFAULT_CALIBRATION.text).toContain(`holdout Brier ${rep.holdout.brier.toFixed(3)}`);
  });
});

describe('GET /api/route', () => {
  const app = () => createApp({ store, asOf: DEMO_AS_OF });

  it('returns a RouterResult whose plant ids are plants in the garden', async () => {
    const a = app();
    const r = await a.request(
      `/api/route?q=${encodeURIComponent('write unit tests for the refund flow')}&days=90`,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as RouterResult;
    expect(body.query).toBe('write unit tests for the refund flow');
    expect(body.method.calibration).toBe(DEFAULT_CALIBRATION.text);
    expect(body.candidates[0]?.name).toBe('test-writer');
    const plants = new Set(gardenView({ store, asOf: DEMO_AS_OF }).plants.map((p) => p.id));
    for (const c of body.candidates) {
      expect(c.confidence).toBeGreaterThanOrEqual(0);
      expect(c.confidence).toBeLessThanOrEqual(1);
      for (const id of c.plantIds) expect(plants).toContain(id);
    }
  });

  it('validates q (1..500 chars), limit, and days', async () => {
    const a = app();
    expect((await a.request('/api/route')).status).toBe(400);
    expect((await a.request('/api/route?q=%20%20')).status).toBe(400);
    expect((await a.request(`/api/route?q=${'a'.repeat(501)}`)).status).toBe(400);
    expect((await a.request(`/api/route?q=${'a'.repeat(500)}`)).status).toBe(200);
    expect((await a.request('/api/route?q=tests&limit=0')).status).toBe(400);
    expect((await a.request('/api/route?q=tests&days=0')).status).toBe(400);
    const one = (await (await a.request('/api/route?q=tests&limit=1')).json()) as RouterResult;
    expect(one.candidates).toHaveLength(1);
  });

  it('caches the index per window (second request is fast) and answers gibberish with no candidates', async () => {
    const a = app();
    await a.request('/api/route?q=warm&days=90');
    const t = performance.now();
    const r = (await (await a.request('/api/route?q=zzqx+vvbn&days=90')).json()) as RouterResult;
    expect(performance.now() - t).toBeLessThan(150);
    expect(r.candidates).toEqual([]);
  });
});
