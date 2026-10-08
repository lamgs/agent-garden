/**
 * Confidence calibration: a Platt-style logistic model over (candidate score, margin), fitted on
 * the calibration split of the router eval (packages/router/src/eval-queries.ts). The fitted
 * coefficients are recorded below; `route-eval.test.ts` in packages/server refits them on the
 * demo dataset and fails if these drift.
 */

export interface CalibrationModel {
  /** p = σ(intercept + score·wScore + margin·wMargin). */
  intercept: number;
  wScore: number;
  wMargin: number;
  /** Human-readable provenance, copied into `RouterResult.method.calibration`. */
  text: string;
}

export const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

export function applyCalibration(m: CalibrationModel, score: number, margin: number): number {
  return sigmoid(m.intercept + m.wScore * score + m.wMargin * margin);
}

export interface CalibrationPoint {
  score: number;
  margin: number;
  /** 1 when this candidate is a correct answer for the query. */
  y: 0 | 1;
}

/**
 * L2-regularized logistic regression by Newton's method (3 parameters, so the Hessian is 3×3).
 * Deterministic; the intercept is not penalized.
 */
export function fitLogistic(
  points: readonly CalibrationPoint[],
  l2 = 0.1,
  iterations = 50,
): { intercept: number; wScore: number; wMargin: number } {
  let w = [0, 0, 0];
  for (let it = 0; it < iterations; it++) {
    const g = [0, l2 * w[1]!, l2 * w[2]!];
    const h = [
      [0, 0, 0],
      [0, l2, 0],
      [0, 0, l2],
    ];
    for (const p of points) {
      const x = [1, p.score, p.margin];
      const pr = sigmoid(w[0]! + w[1]! * p.score + w[2]! * p.margin);
      const r = pr - p.y;
      const s = pr * (1 - pr);
      for (let i = 0; i < 3; i++) {
        g[i]! += r * x[i]!;
        for (let j = 0; j < 3; j++) h[i]![j]! += s * x[i]! * x[j]!;
      }
    }
    const step = solve3(h, g);
    w = w.map((v, i) => v - step[i]!);
    if (Math.max(...step.map(Math.abs)) < 1e-10) break;
  }
  return { intercept: w[0]!, wScore: w[1]!, wMargin: w[2]! };
}

function solve3(a: number[][], b: number[]): number[] {
  const m = a.map((r, i) => [...r, b[i]!]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    [m[c], m[p]] = [m[p]!, m[c]!];
    const d = m[c]![c]! || 1e-12;
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = m[r]![c]! / d;
      for (let k = c; k < 4; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  return m.map((r, i) => r[3]! / (r[i]! || 1e-12));
}

/** Mean squared error of the probabilities (lower is better). */
export function brier(points: readonly CalibrationPoint[], m: CalibrationModel): number {
  if (!points.length) return 0;
  return (
    points.reduce((s, p) => s + (applyCalibration(m, p.score, p.margin) - p.y) ** 2, 0) /
    points.length
  );
}

/**
 * Fitted with `pnpm router:eval --fit` on the demo dataset (seed 42, 90-day window ending
 * 2026-10-01T12:00Z): calibration split only, top-5 candidates per query.
 */
export const DEFAULT_CALIBRATION: CalibrationModel = {
  intercept: -2.9807,
  wScore: 4.2622,
  wMargin: 7.6643,
  text:
    'Platt (logistic) fit of p(correct) on score and margin over #2: 21 demo eval queries × top-5 ' +
    'candidates (n=105), 10 queries held out (holdout Brier 0.043); demo seed 42, fitted 2026-10-08.',
};
