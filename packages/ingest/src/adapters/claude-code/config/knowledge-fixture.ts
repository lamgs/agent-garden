/**
 * Test support: materialize fixtures/knowledge into a temp dir with real absolute paths, the memory
 * folder at its Claude Code location, and planted secrets (assembled at runtime) in the files.
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectSlug } from './knowledge';

export interface KnowledgeFixture {
  home: string;
  claudeHome: string;
  root: string;
  memoryDir: string;
  managedDir: string;
  claudeJsonPath: string;
}

function fill(dir: string, vars: Record<string, string>): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      fill(p, vars);
      continue;
    }
    const buf = readFileSync(p);
    if (buf.includes(0)) continue; // binary
    let text = buf.toString('utf8');
    for (const [k, v] of Object.entries(vars)) {
      // JSONL needs the value JSON-escaped (paths and multi-line secrets).
      const val = p.endsWith('.jsonl') ? JSON.stringify(v).slice(1, -1) : v;
      text = text.replaceAll(`{{${k}}}`, val);
    }
    writeFileSync(p, text);
  }
}

export function materializeKnowledgeFixture(dir: string, planted = ''): KnowledgeFixture {
  const src = new URL('../../../../../../fixtures/knowledge/', import.meta.url);
  const home = join(dir, 'home');
  const claudeHome = join(home, '.claude');
  const root = join(dir, 'work', 'shop-api');
  cpSync(new URL('home/', src), home, { recursive: true });
  cpSync(new URL('project/', src), root, { recursive: true });
  const slugDir = join(claudeHome, 'projects', projectSlug(root));
  const memoryDir = join(slugDir, 'memory');
  cpSync(new URL('memory/', src), memoryDir, { recursive: true });
  cpSync(new URL('transcript/', src), slugDir, { recursive: true });
  const managedDir = join(dir, 'managed');
  mkdirSync(managedDir, { recursive: true });
  const claudeJsonPath = join(home, '.claude.json');
  writeFileSync(claudeJsonPath, JSON.stringify({ projects: { [root]: { mcpServers: {} } } }));
  const vars = { ROOT: root, HOME: home, MEMORY: memoryDir, PLANTED: planted };
  fill(home, vars);
  fill(root, vars);
  return { home, claudeHome, root, memoryDir, managedDir, claudeJsonPath };
}
