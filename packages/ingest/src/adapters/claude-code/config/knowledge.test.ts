import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { knowledgeFindings, type KnowledgeSourceFacts } from '@garden/core';
import { materializeKnowledgeFixture } from './knowledge-fixture';
import { projectSlug, scanKnowledge } from './knowledge';
import {
  extractImports,
  extractLinks,
  extractMentions,
  memoryIndexCut,
  passages,
  ruleGlobs,
  stripCode,
} from './knowledge-text';
import { scanProjectConfig, scanUserConfig } from './scan';
import { knowledgeEvents } from '../transcript';
import { parseSession } from '../transcript';

const dir = mkdtempSync(join(tmpdir(), 'garden-knowledge-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('knowledge text helpers', () => {
  it('finds @imports the way Claude Code does: not in code, comments, or packages', () => {
    const t = [
      'See @docs/a.md and @./b.md, @~/x.md, @/abs/c.md#section.',
      'Mail me at dev@example.com. Use `@docs/code.md` here.',
      '<!-- @docs/hidden.md -->',
      '```',
      '@docs/fenced.md',
      '```',
      'Escaped @my\\ file.md works. Ignore @@double and @ alone and @#tag.',
    ].join('\n');
    expect(extractImports(t).map((h) => h.target)).toEqual([
      'docs/a.md',
      './b.md,',
      '~/x.md,',
      '/abs/c.md',
      'my file.md',
    ]);
    expect(extractImports(t)[0]!.line).toBe(1);
    expect(stripCode('a `@x` b').includes('@x')).toBe(false);
  });

  it('finds markdown links and .md mentions, skipping URLs and globs', () => {
    expect(
      extractLinks('- [A](a.md) — x\n- [W](https://e.com/w.md)\n- [B](sub/b.md#h)').map(
        (h) => h.target,
      ),
    ).toEqual(['a.md', 'sub/b.md']);
    expect(
      extractMentions(
        'Read docs/schema.md, `PLAN.md`, agents/*.md, https://x.io/y.md and @imp.md',
      ).map((h) => h.target),
    ).toEqual(['docs/schema.md', 'PLAN.md']);
  });

  it('splits passages per list item, normalizes, and skips short ones', () => {
    const a = passages('# T\n\n- Run the relevant tests before saying something is done.\n- short');
    const b = passages('* run the relevant tests before saying   something is done');
    expect(a).toHaveLength(1);
    expect(b[0]!.hash).toBe(a[0]!.hash);
    expect(
      passages(
        '---\nname: x\ndescription: a long description that is clearly over forty chars\n---\n',
      ),
    ).toEqual([]);
  });

  it('cuts MEMORY.md at 200 lines or 25,000 bytes', () => {
    const lines = Array.from({ length: 230 }, (_, i) => `- line ${i}`).join('\n');
    const c = memoryIndexCut(lines, 200, 25_000);
    expect(c.loadedLines).toBe(200);
    expect(c.totalLines).toBe(230);
    const wide = Array.from({ length: 50 }, () => 'x'.repeat(999)).join('\n');
    const w = memoryIndexCut(wide, 200, 25_000);
    expect(w.loadedBytes).toBeLessThanOrEqual(25_000);
    expect(w.loadedLines).toBe(25);
  });

  it('reads rule paths: list, comma string, /** suffix, and all-** as unconditional', () => {
    expect(ruleGlobs(['src/**/*.ts', 'lib/**'])).toEqual(['src/**/*.ts', 'lib']);
    expect(ruleGlobs('a/*.ts, b/*.ts')).toEqual(['a/*.ts', 'b/*.ts']);
    expect(ruleGlobs(['**'])).toBeUndefined();
    expect(ruleGlobs(undefined)).toBeUndefined();
  });
});

describe('scanKnowledge on the synthetic fixture', () => {
  const fx = materializeKnowledgeFixture(join(dir, 'scan'), 'PLANTED-PLACEHOLDER');
  const user = scanUserConfig(fx.claudeHome);
  const project = scanProjectConfig(fx.root);
  const k = scanKnowledge({
    familyId: 'fam_x',
    root: fx.root,
    claudeHome: fx.claudeHome,
    managedDir: fx.managedDir,
    claudeJsonPath: fx.claudeJsonPath,
    user,
    project,
    commits: [],
    now: '2026-10-01T00:00:00.000Z',
  });
  const by = (p: string) => k.sources.find((s) => s.displayPath === p);

  it('places every source in the load chain with the right mode', () => {
    const modes = Object.fromEntries(
      k.sources.map((s) => [s.displayPath, `${s.kind}/${s.loadMode}`]),
    );
    expect(modes).toMatchObject({
      '~/.claude/CLAUDE.md': 'user_claude_md/always',
      '~/.claude/shared/style.md': 'import/always',
      '~/.claude/rules/tone.md': 'rule/always',
      'CLAUDE.md': 'project_claude_md/always',
      '.claude/CLAUDE.md': 'project_claude_md/always',
      'CLAUDE.local.md': 'local_claude_md/always',
      'AGENTS.md': 'project_claude_md/not_loaded',
      '.claude/rules/api.md': 'rule/path_scoped',
      '.claude/rules/general.md': 'rule/always',
      '.claude/rules/broken-frontmatter.md': 'rule/always',
      'docs/api.md': 'import/always',
      'docs/chain4.md': 'import/always',
      'docs/chain5.md': 'import/not_loaded',
      'docs/diagram.png': 'import/not_loaded',
      'src/billing/CLAUDE.md': 'nested_claude_md/on_demand',
      'memory/MEMORY.md': 'memory_index/always',
      'memory/feedback_testing.md': 'memory_topic/on_demand',
      'memory/orphan_scratch.md': 'memory_topic/on_demand',
      'docs/schema.md': 'referenced_doc/on_demand',
    });
    expect(by('docs/chain6.md')).toBeUndefined(); // never followed past the depth limit
    expect(by('docs/chain5.md')!.importDepth).toBe(5);
    expect(by('.claude/rules/api.md')!.globs).toEqual(['src/api/**/*.ts', 'src/routes']);
    expect(by('memory/feedback_testing.md')!.memoryType).toBe('feedback');
    expect(k.scan.memoryDir).toBe(join(fx.claudeHome, 'projects', projectSlug(fx.root), 'memory'));
  });

  it('caps MEMORY.md and marks links past the cap', () => {
    const idx = by('memory/MEMORY.md')!;
    expect(idx.lines).toBe(230);
    expect(idx.alwaysBytes).toBeLessThan(idx.bytes);
    const links = k.edges.filter((e) => e.kind === 'index_link');
    const t = (x: string) => links.find((e) => e.target === x)!;
    expect(t('feedback_testing.md')).toMatchObject({ resolved: true, beyondCap: false });
    expect(t('topic_beyond.md')).toMatchObject({ resolved: true, beyondCap: true });
    expect(t('missing_topic.md')).toMatchObject({ resolved: false });
  });

  it('records dangling imports and memory mentions, never package names or code', () => {
    const dangling = k.edges
      .filter((e) => !e.resolved)
      .map((e) => `${e.kind}:${e.target}`)
      .sort();
    expect(dangling).toEqual([
      'import:@docs/missing-release.md',
      'index_link:missing_topic.md',
      'mention:memory/old_notes.md',
    ]);
    const mention = k.edges.find((e) => e.target === 'memory/feedback_testing.md')!;
    expect(mention.toId).toBe(by('memory/feedback_testing.md')!.id);
  });

  it('lists skills and agents with their always-loaded listing bytes', () => {
    const skill = k.sources.find((s) => s.name === 'changelog-writer')!;
    expect(skill.kind).toBe('skill');
    expect(skill.alwaysBytes).toBeGreaterThan(50);
    expect(skill.alwaysBytes).toBeLessThan(skill.bytes);
    expect(k.sources.find((s) => s.kind === 'agent_definition')!.name).toBe('test-writer');
  });

  it('never carries file content: only hashes, sizes, and generated notes', () => {
    const json = JSON.stringify(k);
    expect(json.includes('PLANTED-PLACEHOLDER')).toBe(false);
    expect(json.includes('Never use floats')).toBe(false);
    for (const s of k.sources)
      for (const p of s.passageHashes) expect(p).toMatch(/^[0-9a-f]{64}:\d+$/);
  });

  it('feeds the core checks: duplicate rule, dangling refs, orphan memory, over cap, not loaded', () => {
    const facts: KnowledgeSourceFacts[] = k.sources.map((s) => ({ ...s }));
    const f = knowledgeFindings({
      sources: facts,
      edges: k.edges,
      usage: new Map(),
      history: [],
      window: { from: '2026-07-01T00:00:00Z', to: '2026-10-01T00:00:00Z' },
      skillPairs: [],
      sessionsInWindow: 1,
    });
    const kinds = new Set(f.map((x) => x.kind));
    for (const kind of [
      'duplicate_passage',
      'dangling_ref',
      'orphan_memory',
      'over_cap',
      'not_loaded',
    ])
      expect(kinds.has(kind as never), kind).toBe(true);
    const dup = f.find((x) => x.kind === 'duplicate_passage' && x.sourceIds.length === 2)!;
    expect(dup.actionText).toContain('Delete the copy in CLAUDE.md');
    const orphans = f.filter((x) => x.kind === 'orphan_memory').map((x) => x.title);
    expect(orphans.some((t) => t.includes('orphan_scratch.md'))).toBe(true);
    expect(orphans.some((t) => t.includes('topic_beyond.md') && t.includes('past'))).toBe(true);
  });
});

describe('knowledge usage from transcripts', () => {
  const fx = materializeKnowledgeFixture(join(dir, 'usage'), 'PLANTED-PLACEHOLDER');
  it('reads paths from instructions / nested_memory / relevant_memories / Read, never content', async () => {
    const path = join(
      fx.claudeHome,
      'projects',
      projectSlug(fx.root),
      '0b5e0000-0000-4000-8000-00000000c0de.jsonl',
    );
    const s = await parseSession(path);
    const ev = s.knowledge.map(
      (e) =>
        `${e.kind}:${e.path.replace(fx.root, 'ROOT').replace(fx.memoryDir, 'MEM').replace(fx.home, 'HOME')}`,
    );
    expect(ev).toEqual([
      'session_load:HOME/.claude/CLAUDE.md',
      'session_load:ROOT/CLAUDE.md',
      'session_load:ROOT/.claude/rules/general.md',
      'session_load:MEM/MEMORY.md',
      'read:MEM/feedback_testing.md',
      'nested_load:ROOT/src/billing/CLAUDE.md',
      'memory_recall:MEM/project_context.md',
    ]);
    expect(JSON.stringify(s.knowledge).includes('PLANTED')).toBe(false);
    expect(Object.keys(s.census.unknownFields).filter((k) => k.startsWith('attachment'))).toEqual(
      [],
    );
    expect(
      knowledgeEvents({
        type: 'attachment',
        attachment: { type: 'instructions', files: [{ content: 'x' }] },
      } as never),
    ).toEqual([]);
  });
});

describe('scanKnowledge ancestor boundary', () => {
  it('does not read ancestor CLAUDE.md files above the boundary', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const outer = join(dir, 'boundary');
    const demo = join(outer, 'demo');
    const proj = join(demo, 'projects', 'p');
    const home = join(demo, 'home', '.claude');
    mkdirSync(proj, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(outer, 'CLAUDE.md'), '# outer repo instructions\n');
    writeFileSync(join(demo, 'CLAUDE.md'), '# demo root instructions\n');
    writeFileSync(join(proj, 'CLAUDE.md'), '# project\n');
    const scan = (ancestorBoundary?: string) =>
      scanKnowledge({
        familyId: 'fam_b',
        root: proj,
        claudeHome: home,
        managedDir: join(demo, 'managed'),
        user: scanUserConfig(home),
        project: scanProjectConfig(proj),
        commits: [],
        now: '2026-10-01T00:00:00.000Z',
        ...(ancestorBoundary ? { ancestorBoundary } : {}),
      }).sources.map((s) => s.path);
    expect(scan()).toContain(join(outer, 'CLAUDE.md'));
    const bounded = scan(demo);
    expect(bounded).not.toContain(join(outer, 'CLAUDE.md'));
    expect(bounded).toContain(join(demo, 'CLAUDE.md'));
    expect(bounded).toContain(join(proj, 'CLAUDE.md'));
    // A boundary the project is not inside is ignored (the full walk applies).
    expect(scan(join(dir, 'elsewhere'))).toContain(join(outer, 'CLAUDE.md'));
  });
});
