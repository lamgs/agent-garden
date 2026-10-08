/**
 * `pnpm router:eval [--db <garden.db>] [--fit] [--verbose]`
 * Prints the router eval: ablation table (top-1/top-3, all / calibration / holdout), calibration
 * quality, and with --fit the refitted Platt coefficients for packages/router/src/calibration.ts.
 * Without --db it generates the demo dataset (seed 42) into a temp dir and ingests it.
 */
import { writeFileSync } from 'node:fs';
import { Store } from '@garden/ingest';
import {
  ablationTable,
  calibrationReport,
  DEFAULT_CALIBRATION,
  evaluate,
  fitCalibration,
  route,
} from '@garden/router';
import { demoStore, windowIndex } from './route-eval';

/** Questions bundled into apps/web/src/fixtures/router.demo.json (not eval queries). */
const FIXTURE_QUERIES = [
  'write unit tests for the refund flow',
  'write unit tests for the invoice totals',
  'why does the old invoice code round taxes this way?',
  'show me the terraform plan for staging and flag risks',
  'draft the changelog since the last release tag',
];

const args = process.argv.slice(2);
const dbIdx = args.indexOf('--db');
const db = dbIdx >= 0 ? args[dbIdx + 1] : undefined;

const { store, dispose } = db
  ? { store: new Store(db), dispose: () => undefined }
  : await demoStore();
try {
  const t0 = performance.now();
  const index = windowIndex(store);
  console.log(
    `Index: ${index.candidates.length} candidates, ${index.runsIndexed} runs, ${index.tasks.length} unique tasks, ` +
      `LSA ${index.embedder.dims} dims over ${index.embedder.vocabSize} terms (${(performance.now() - t0).toFixed(0)} ms)\n`,
  );
  console.log(ablationTable(index));

  if (args.includes('--verbose')) {
    console.log('\nPer query (full router):');
    for (const r of evaluate(index)) {
      const mark = r.rank === 1 ? '✓' : r.rank !== null && r.rank <= 3 ? '~' : '✗';
      console.log(
        `${mark} [${r.split}] rank=${r.rank ?? '-'}  ${r.q}\n     expected ${r.expected.join(' | ')}; got ${r.top.slice(0, 3).join(', ')}`,
      );
    }
  }

  const fitted = fitCalibration(index, new Date().toISOString().slice(0, 10));
  const model = args.includes('--fit') ? fitted : DEFAULT_CALIBRATION;
  const rep = calibrationReport(index, model);
  console.log(
    `\nCalibration (${args.includes('--fit') ? 'refit' : 'recorded'}): ${model.text}\n` +
      `  Brier, calibration split: ${rep.calibration.brier.toFixed(3)} (n=${rep.calibration.n})\n` +
      `  Brier, holdout split:     ${rep.holdout.brier.toFixed(3)} (n=${rep.holdout.n})\n` +
      `  Holdout top-1: mean confidence ${(rep.holdoutTop1.meanConfidence * 100).toFixed(0)}% vs accuracy ${(rep.holdoutTop1.accuracy * 100).toFixed(0)}% (n=${rep.holdoutTop1.n})`,
  );
  if (args.includes('--fit'))
    console.log(
      `\nFitted: intercept ${fitted.intercept.toFixed(4)}, wScore ${fitted.wScore.toFixed(4)}, wMargin ${fitted.wMargin.toFixed(4)}`,
    );

  // --export <file>: RouterResults for the web app's `?fixture=demo` mode.
  const exIdx = args.indexOf('--export');
  if (exIdx >= 0) {
    const out = args[exIdx + 1];
    if (!out) throw new Error('--export needs a file path');
    const results = FIXTURE_QUERIES.map((q) => route(index, q, { limit: 3 }));
    writeFileSync(out, `${JSON.stringify({ results }, null, 2)}\n`);
    console.log(`\nWrote ${results.length} RouterResults to ${out}`);
  }
} finally {
  dispose();
}
