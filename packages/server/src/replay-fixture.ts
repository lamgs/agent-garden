/**
 * Writes ReplayViews for chosen runs as a web fixture:
 *   tsx packages/server/src/replay-fixture.ts --db <garden.db> --out <file.json> [--note <text>] <runId>...
 * Used for apps/web/src/fixtures/replay.demo.json (demo data only; never real transcripts).
 */
import { writeFileSync } from 'node:fs';
import { Store } from '@garden/ingest';
import { buildReplayView } from './replay';

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const db = opt('db');
const out = opt('out');
const note = opt('note') ?? 'packages/server/src/replay-fixture.ts';
if (!db || !out || args.length === 0) {
  console.error('usage: replay-fixture --db <garden.db> --out <file.json> <runId>...');
  process.exit(2);
}
const store = new Store(db);
const runs: Record<string, unknown> = {};
for (const id of args) {
  const v = buildReplayView(store, id);
  if (!v) throw new Error(`no such run: ${id}`);
  runs[id] = v;
}
writeFileSync(out, `${JSON.stringify({ generatedBy: note, runs }, null, 2)}\n`);
console.log(`wrote ${Object.keys(runs).length} replays to ${out}`);
