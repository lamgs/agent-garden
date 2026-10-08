import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GardenView, KnowledgeView } from '@garden/core';
import { ClaudeCodeAdapter, deriveAll, ingest, Redactor, Store } from '@garden/ingest';
import { materializeKnowledgeFixture } from '@garden/ingest/knowledge-fixture';
import { createApp } from './app';

const dir = mkdtempSync(join(tmpdir(), 'garden-knowledge-api-'));
let store: Store;
let famId: string;
beforeAll(async () => {
  const fx = materializeKnowledgeFixture(dir);
  store = new Store(join(dir, 'garden.db'));
  const a = new ClaudeCodeAdapter({
    claudeHome: fx.claudeHome,
    claudeJsonPath: fx.claudeJsonPath,
    managedDir: fx.managedDir,
  });
  await ingest(a, store, new Redactor(Buffer.alloc(32, 4)));
  deriveAll(store, a.garden);
  famId = (store.db.prepare('SELECT id FROM harness_families').get() as { id: string }).id;
});
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const app = () => createApp({ store, asOf: '2026-10-01T00:00:00Z' });

describe('GET /api/knowledge/:familyId', () => {
  let v: KnowledgeView;
  beforeAll(async () => {
    const r = await app().request(`/api/knowledge/${famId}`);
    expect(r.status).toBe(200);
    v = (await r.json()) as KnowledgeView;
  });

  it('describes the bed’s load chain with an always-loaded budget by layer', () => {
    expect(v.bed.id).toBe(famId);
    expect(v.scannedAt).not.toBeNull();
    expect(v.budget.layers.map((l) => l.layer)).toEqual([
      'user',
      'project',
      'local',
      'rules',
      'imports',
      'memory',
      'listings',
    ]);
    expect(v.budget.alwaysTokens).toBe(v.budget.layers.reduce((n, l) => n + l.tokens, 0));
    expect(v.history.at(-1)!.provenance).toBe('current');
  });

  it('joins transcript evidence to sources: session loads, recalls, nested loads, Reads', () => {
    const u = (p: string) => v.sources.find((s) => s.displayPath === p)!.usage;
    expect(u('CLAUDE.md')).toMatchObject({ count: 1, kinds: ['session_load'] });
    expect(u('memory/feedback_testing.md').kinds).toEqual(['read']);
    expect(u('memory/project_context.md').kinds).toEqual(['memory_recall']);
    expect(u('src/billing/CLAUDE.md').kinds).toEqual(['nested_load']);
    expect(v.sessions).toEqual({ total: 1, withLoadRecord: 1 });
  });

  it('lists findings with evidence and actions, linked from their sources', () => {
    const kinds = new Set(v.findings.map((f) => f.kind));
    for (const k of [
      'dangling_ref',
      'orphan_memory',
      'over_cap',
      'duplicate_passage',
      'not_loaded',
      'skill_overlap',
    ])
      expect(kinds.has(k as never), k).toBe(true);
    for (const f of v.findings) {
      expect(f.evidence.length).toBeGreaterThan(0);
      expect(f.actionText.length).toBeGreaterThan(0);
    }
    const orphan = v.findings.find(
      (f) => f.kind === 'orphan_memory' && f.title.includes('orphan_scratch'),
    )!;
    const src = v.sources.find((s) => s.id === orphan.sourceIds[0])!;
    expect(src.findingIds).toContain(orphan.id);
    // A memory file the agent read is not an orphan even without an index link.
    expect(
      v.findings.some((f) => f.kind === 'orphan_memory' && f.title.includes('feedback_testing')),
    ).toBe(false);
    expect(v.edges.some((e) => !e.resolved)).toBe(true);
  });

  it('404s an unknown bed and validates the window', async () => {
    expect((await app().request('/api/knowledge/fam_nope')).status).toBe(404);
    expect((await app().request(`/api/knowledge/${famId}?days=0`)).status).toBe(400);
  });
});

describe('garden integration', () => {
  it('soil carries always-loaded tokens by layer, and knowledge findings grow as weeds', async () => {
    const g = (await (await app().request('/api/garden')).json()) as GardenView;
    const bed = g.beds.find((b) => b.id === famId)!;
    expect(bed.soil.knowledge!.alwaysTokens).toBeGreaterThan(0);
    expect(bed.soil.knowledge!.layers.length).toBeGreaterThan(3);
    const weeds = g.weeds
      .filter((w) => w.subject.type === 'knowledge_source')
      .map((w) => w.kind)
      .sort();
    expect(weeds).toEqual(['dangling_ref', 'duplicate_passage', 'orphan_memory', 'over_cap']);
    for (const w of g.weeds.filter((x) => x.subject.type === 'knowledge_source'))
      expect(w.bedId).toBe(famId);
  });
});
