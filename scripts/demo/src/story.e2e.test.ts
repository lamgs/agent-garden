/**
 * M2 gate: the demo dataset, ingested through the real Claude Code adapter, tells the intended
 * story, and none of the generator's planted secrets reach the store.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter, ingest, Redactor, Store, type IngestReport } from '@garden/ingest';
import { deriveAll } from '@garden/ingest/derive';
import { generateDemo, plantedSecretValues } from './index';

const SEED = 42;
const dir = mkdtempSync(join(tmpdir(), 'garden-story-'));
const dbPath = join(dir, 'data', 'garden.db');
let store: Store;
let report: IngestReport;

beforeAll(async () => {
  const m = await generateDemo(join(dir, 'demo'), { seed: SEED });
  store = new Store(dbPath);
  const adapter = new ClaudeCodeAdapter({
    claudeHome: m.claudeHome,
    claudeJsonPath: m.claudeJsonPath,
    gardenYamlPath: m.gardenYamlPath,
  });
  report = await ingest(adapter, store, new Redactor(Buffer.alloc(32, 9)));
  deriveAll(store, adapter.garden);
}, 120_000);
afterAll(() => {
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

const RATE = `SUM(CASE o.label WHEN 'success' THEN 1.0 WHEN 'partial' THEN 0.5 WHEN 'failure' THEN 0 END)
              / NULLIF(SUM(o.label != 'unknown'), 0)`;
function rate(where: string, ...params: string[]): { rate: number; n: number } {
  return store.db
    .prepare(
      `SELECT ${RATE} AS rate, COUNT(*) AS n FROM runs r
         JOIN agents a ON a.id = r.agent_id JOIN harness_families f ON f.id = r.family_id
         JOIN outcomes o ON o.run_id = r.id WHERE ${where}`,
    )
    .get(...params) as { rate: number; n: number };
}

describe('demo story (M2 gate)', () => {
  it('ingests cleanly', () => {
    expect(report.records.run).toBeGreaterThan(1500);
    expect(report.warnings.filter((w) => !/non-strict YAML/.test(w))).toEqual([]);
  });

  it('demo moment: the same test-writer thrives in shop-api and wilts in legacy-monolith', () => {
    const shop = rate(`a.name = 'test-writer' AND f.name = 'shop-api'`);
    const legacy = rate(`a.name = 'test-writer' AND f.name = 'legacy-monolith'`);
    expect(shop.n).toBeGreaterThan(50);
    expect(legacy.n).toBeGreaterThan(50);
    expect(shop.rate).toBeGreaterThan(0.8);
    expect(legacy.rate).toBeLessThan(0.4);
  });

  it('season: shop-api main improves after "Tighten CLAUDE.md and add test hook"', () => {
    const commit = store.db
      .prepare(
        `SELECT hv.valid_from AS at, hv.diff_json AS diff FROM harness_versions hv
                  JOIN harness_families f ON f.id = hv.family_id
                 WHERE f.name = 'shop-api' AND hv.commit_json LIKE '%Tighten CLAUDE.md%'
                 ORDER BY hv.valid_from LIMIT 1`,
      )
      .get() as { at: string; diff: string };
    expect(commit).toBeDefined();
    const diff = JSON.parse(commit.diff);
    expect(diff.instructionBytesDelta).toBeLessThan(-5000);
    expect(diff.hooksChanged).toBe(true);
    const where = `a.name = 'main' AND f.name = 'shop-api' AND r.loop_id IS NULL AND r.started_at`;
    const before = rate(`${where} < ?`, commit.at);
    const after = rate(`${where} >= ?`, commit.at);
    expect(after.rate - before.rate).toBeGreaterThan(0.2);
  });

  it('season: web-dashboard model switch shows up as a model change', () => {
    const diffs = store.db
      .prepare(
        `SELECT hv.diff_json AS d FROM harness_versions hv JOIN harness_families f ON f.id = hv.family_id
                 WHERE f.name = 'web-dashboard' AND hv.diff_json IS NOT NULL`,
      )
      .all() as { d: string }[];
    expect(diffs.some((x) => JSON.parse(x.d).modelChanged?.to === 'claude-sonnet-5-5')).toBe(true);
  });

  it('loops: declared nightly + weekly loops attributed; recurring backfill inferred', () => {
    const loops = store.db
      .prepare(
        `SELECT l.name, l.provenance, COUNT(r.id) AS n, MAX(r.started_at) AS last
                  FROM loops l LEFT JOIN runs r ON r.loop_id = l.id GROUP BY l.id`,
      )
      .all() as { name: string; provenance: string; n: number; last: string | null }[];
    const by = (name: string) => loops.find((l) => l.name === name);
    expect(by('nightly-flaky-triage')?.n).toBeGreaterThan(60);
    expect(by('dependency-update-sweep')?.last ?? '').toMatch(/^2026-08/);
    expect(loops.some((l) => l.provenance === 'inferred' && l.n >= 40)).toBe(true);
    expect(loops.some((l) => l.provenance === 'config')).toBe(true);
  });

  it('weeds are present in the data: an orphan agent with zero runs', () => {
    const orphan = store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM agents a WHERE a.name = 'perf-profiler'
                  AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.agent_id = a.id)`,
      )
      .get() as { n: number };
    expect(orphan.n).toBe(1);
  });

  it('redaction: planted demo secrets were redacted and never reach the database bytes', () => {
    expect(Object.values(report.redactions).reduce((n, v) => n + v, 0)).toBeGreaterThan(0);
    const bytes = [dbPath, `${dbPath}-wal`]
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p).toString('latin1'))
      .join('');
    for (const secret of plantedSecretValues(SEED))
      expect(bytes.includes(secret), 'secret leaked').toBe(false);
  });
});
