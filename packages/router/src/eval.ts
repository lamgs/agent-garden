/** Router evaluation: top-1/top-3 accuracy, the ablation, and confidence calibration. Pure. */
import {
  applyCalibration,
  brier,
  fitLogistic,
  type CalibrationModel,
  type CalibrationPoint,
} from './calibration';
import { EVAL_QUERIES, splitOf, type EvalQuery, type Split } from './eval-queries';
import { DEFAULT_WEIGHTS, margins, rank, type RouterIndex, type Weights } from './router';

export interface Ablation {
  name: string;
  weights: Weights;
}

/** Lexical only → + embedding → + outcomes (the full router). Partial weights renormalized to 1. */
export const ABLATIONS: Ablation[] = [
  { name: 'lexical (BM25) only', weights: { lexical: 1, embedding: 0, outcome: 0 } },
  {
    name: '+ embedding (TF-IDF+LSA)',
    weights: { lexical: 0.45 / 0.8, embedding: 0.35 / 0.8, outcome: 0 },
  },
  { name: '+ outcome kNN (full)', weights: DEFAULT_WEIGHTS },
];

export interface EvalRow {
  q: string;
  split: Split;
  expected: string[];
  top: string[];
  /** 1-based rank of the first acceptable answer; null if not in the ranking. */
  rank: number | null;
}

export interface Accuracy {
  n: number;
  top1: number;
  top3: number;
}

const label = (c: { kind: string; name: string }) => `${c.kind}:${c.name}`;

export function evaluate(
  index: RouterIndex,
  weights: Weights = DEFAULT_WEIGHTS,
  queries: readonly EvalQuery[] = EVAL_QUERIES,
): EvalRow[] {
  return queries.map((q, i) => {
    const ranked = rank(index, q.q, { weights }).map((s) => label(s.entry.input));
    const expected = q.expect.map(label);
    const r = ranked.findIndex((x) => expected.includes(x));
    return {
      q: q.q,
      split: splitOf(i),
      expected,
      top: ranked.slice(0, 5),
      rank: r < 0 ? null : r + 1,
    };
  });
}

export function accuracy(rows: readonly EvalRow[]): Accuracy {
  const n = rows.length;
  const at = (k: number) => (n ? rows.filter((r) => r.rank !== null && r.rank <= k).length / n : 0);
  return { n, top1: at(1), top3: at(3) };
}

export function bySplit(rows: readonly EvalRow[]): Record<'all' | Split, Accuracy> {
  return {
    all: accuracy(rows),
    calibration: accuracy(rows.filter((r) => r.split === 'calibration')),
    holdout: accuracy(rows.filter((r) => r.split === 'holdout')),
  };
}

/** One point per (query, top-N candidate): its score, its margin, and whether it is correct. */
export function calibrationPoints(
  index: RouterIndex,
  split: Split | 'all',
  topN = 5,
  queries: readonly EvalQuery[] = EVAL_QUERIES,
): CalibrationPoint[] {
  const out: CalibrationPoint[] = [];
  queries.forEach((q, i) => {
    if (split !== 'all' && splitOf(i) !== split) return;
    const all = rank(index, q.q);
    const m = margins(all);
    const ranked = all.slice(0, topN);
    const ok = new Set(q.expect.map(label));
    ranked.forEach((s, j) =>
      out.push({ score: s.score, margin: m[j] ?? 0, y: ok.has(label(s.entry.input)) ? 1 : 0 }),
    );
  });
  return out;
}

export function fitCalibration(index: RouterIndex, date: string): CalibrationModel {
  const pts = calibrationPoints(index, 'calibration');
  const nQueries = EVAL_QUERIES.filter((_, i) => splitOf(i) === 'calibration').length;
  const w = fitLogistic(pts);
  return {
    ...w,
    text:
      `Platt (logistic) fit of p(correct) on score and margin over #2, ${nQueries} demo eval queries ` +
      `× top-5 candidates (n=${pts.length}), ${EVAL_QUERIES.length - nQueries} queries held out; ${date}.`,
  };
}

export interface CalibrationReport {
  calibration: { n: number; brier: number };
  holdout: { n: number; brier: number };
  /** Mean predicted confidence of the top-1 candidate vs its observed top-1 accuracy, holdout. */
  holdoutTop1: { meanConfidence: number; accuracy: number; n: number };
}

export function calibrationReport(index: RouterIndex, model: CalibrationModel): CalibrationReport {
  const cal = calibrationPoints(index, 'calibration');
  const hold = calibrationPoints(index, 'holdout');
  const top1 = calibrationPoints(index, 'holdout', 1);
  return {
    calibration: { n: cal.length, brier: brier(cal, model) },
    holdout: { n: hold.length, brier: brier(hold, model) },
    holdoutTop1: {
      n: top1.length,
      meanConfidence: top1.length
        ? top1.reduce((s, p) => s + applyCalibration(model, p.score, p.margin), 0) / top1.length
        : 0,
      accuracy: top1.length ? top1.filter((p) => p.y === 1).length / top1.length : 0,
    },
  };
}

const p = (x: number) => `${(x * 100).toFixed(0)}%`;

/** Markdown table: one row per ablation, all / calibration / holdout. */
export function ablationTable(index: RouterIndex): string {
  const lines = [
    '| Router | top-1 (all) | top-3 (all) | top-1 (calib.) | top-3 (calib.) | top-1 (holdout) | top-3 (holdout) |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const a of ABLATIONS) {
    const s = bySplit(evaluate(index, a.weights));
    lines.push(
      `| ${a.name} | ${p(s.all.top1)} | ${p(s.all.top3)} | ${p(s.calibration.top1)} | ${p(s.calibration.top3)} | ${p(s.holdout.top1)} | ${p(s.holdout.top3)} |`,
    );
  }
  const s = bySplit(evaluate(index));
  lines.push(
    '',
    `n = ${s.all.n} queries (${s.calibration.n} calibration, ${s.holdout.n} holdout).`,
  );
  return lines.join('\n');
}
