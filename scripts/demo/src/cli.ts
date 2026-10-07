/**
 * Usage: tsx scripts/demo/src/cli.ts --out .garden-demo [--seed N] [--now ISO] [--scale X]
 * Wipes the output directory, regenerates the demo dataset, and prints the manifest as JSON.
 */
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_NOW, DEFAULT_SEED, generateDemo } from './index';

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: '.garden-demo' },
    seed: { type: 'string' },
    now: { type: 'string' },
    scale: { type: 'string' },
  },
});

const out = resolve(values.out as string);
if (out === '/' || out === resolve(process.env.HOME ?? '/')) {
  throw new Error(`refusing to wipe ${out}`);
}
rmSync(out, { recursive: true, force: true });
const t0 = Date.now();
const manifest = await generateDemo(out, {
  seed: values.seed ? Number(values.seed) : DEFAULT_SEED,
  now: values.now ?? DEFAULT_NOW,
  scale: values.scale ? Number(values.scale) : 1,
});
console.log(JSON.stringify({ ...manifest, elapsedMs: Date.now() - t0 }, null, 2));
