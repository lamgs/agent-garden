/**
 * Export demo fixtures for the knowledge map (K) from an ingested demo store:
 *   - knowledge.demo.json: the KnowledgeView of one bed (default legacy-monolith),
 *   - the knowledge parts of the garden (bed soil + knowledge weeds), keyed by bed name, so the
 *     bundled garden.demo.json can be patched without regenerating its ids.
 * Bed ids are remapped by bed name onto the ids already in garden.demo.json, and absolute paths in
 * the view (memoryDir) are reduced to `~/…`, so the fixture carries no machine-specific path.
 *
 * Run: tsx packages/server/src/export-knowledge-fixture.ts --data <demo>/data --as-of 2026-10-01T12:00:00Z \
 *        --garden apps/web/src/fixtures/garden.demo.json --out apps/web/src/fixtures
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { GardenView, KnowledgeView } from '@garden/core';
import { Store } from '@garden/ingest';
import { createApp } from './app';

const { values } = parseArgs({
  options: {
    data: { type: 'string' },
    'as-of': { type: 'string', default: '2026-10-01T12:00:00Z' },
    garden: { type: 'string' },
    out: { type: 'string' },
    bed: { type: 'string', default: 'legacy-monolith' },
  },
});
const store = new Store(join(values.data!, 'garden.db'));
const app = createApp({ store, asOf: values['as-of']! });
const live = (await (await app.request('/api/garden')).json()) as GardenView;
const fixture = JSON.parse(readFileSync(values.garden!, 'utf8')) as GardenView;
const idByName = new Map(fixture.beds.map((b) => [b.name, b.id]));
const liveName = new Map(live.beds.map((b) => [b.id, b.name]));
const mapId = (id: string) => idByName.get(liveName.get(id) ?? '') ?? id;

// Patch the garden fixture: soil.knowledge per bed, knowledge weeds appended (replacing old ones).
for (const b of fixture.beds) {
  const l = live.beds.find((x) => x.name === b.name);
  if (l?.soil.knowledge) b.soil.knowledge = l.soil.knowledge;
}
fixture.weeds = [
  ...fixture.weeds.filter((w) => w.subject.type !== 'knowledge_source'),
  ...live.weeds
    .filter((w) => w.subject.type === 'knowledge_source')
    .map((w) => ({ ...w, ...(w.bedId ? { bedId: mapId(w.bedId) } : {}) })),
];
writeFileSync(values.garden!, JSON.stringify(fixture, null, 1));

const liveBed = live.beds.find((b) => b.name === values.bed)!;
const v = (await (await app.request(`/api/knowledge/${liveBed.id}`)).json()) as KnowledgeView;
v.bed.id = mapId(v.bed.id);
// The slug encodes the generator's absolute path; keep only the shape.
if (v.memoryDir) v.memoryDir = '~/.claude/projects/<project-slug>/memory';
writeFileSync(join(values.out!, 'knowledge.demo.json'), JSON.stringify(v, null, 2) + '\n');
store.close();
console.log(
  `${values.bed}: ${v.sources.length} sources, ${v.edges.length} edges, ${v.findings.length} findings, ~${v.budget.alwaysTokens} always-loaded tokens`,
);
