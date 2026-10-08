import { describe, expect, it } from 'vitest';
import type { RouterResult } from '@garden/core';
import garden from '../fixtures/garden.demo.json';
import fixture from '../fixtures/router.demo.json';
import { formatConfidence, highlightFor, matchFixture, type RouterFixture } from './router';

const fx = fixture as unknown as RouterFixture;

describe('router fixture and highlight', () => {
  it('fixture results are real RouterResults whose plants exist in the demo garden', () => {
    const plants = new Set(garden.plants.map((p) => p.id));
    expect(fx.results.length).toBeGreaterThanOrEqual(3);
    for (const r of fx.results) {
      expect(r.method.weights).toEqual({ lexical: 0.45, embedding: 0.35, outcome: 0.2 });
      expect(r.method.calibration).toMatch(/Platt/);
      for (const c of r.candidates) for (const id of c.plantIds) expect(plants).toContain(id);
    }
  });

  it('matches fixture queries case- and whitespace-insensitively', () => {
    const q = fx.results[0]!.query;
    expect(matchFixture(fx, `  ${q.toUpperCase()} `)).toBe(fx.results[0]);
    expect(matchFixture(fx, 'something else')).toBeNull();
  });

  it('a plant shared by several candidates shows the highest confidence', () => {
    const r: RouterResult = {
      query: 'x',
      method: fx.results[0]!.method,
      candidates: [
        { ...fx.results[0]!.candidates[0]!, plantIds: ['a', 'b'], confidence: 0.2 },
        { ...fx.results[0]!.candidates[0]!, plantIds: ['b'], confidence: 0.7 },
      ],
    };
    expect(highlightFor(r)).toEqual({ plantIds: ['a', 'b'], badges: { a: '20%', b: '70%' } });
    expect(highlightFor(null)).toEqual({ plantIds: [], badges: {} });
  });

  it('formats confidence without claiming certainty', () => {
    expect(formatConfidence(0.999)).toBe('>99%');
    expect(formatConfidence(0.004)).toBe('<1%');
    expect(formatConfidence(0.614)).toBe('61%');
  });
});
