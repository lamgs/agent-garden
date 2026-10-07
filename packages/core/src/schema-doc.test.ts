import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SIGNALS } from './heuristics';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p: string) => readFileSync(root + p, 'utf8');

describe('docs/schema.md stays in sync', () => {
  const doc = read('docs/schema.md');

  it('documents every exported interface in schema.ts', () => {
    const names = [...read('packages/core/src/schema.ts').matchAll(/export interface (\w+)/g)].map(
      (m) => m[1]!,
    );
    expect(names.length).toBeGreaterThan(10);
    const missing = names.filter((n) => !doc.includes(n) && n !== 'OutcomeSignalResult');
    expect(missing).toEqual([]);
  });

  it('documents every SQLite table', () => {
    const tables = [
      ...read('packages/ingest/src/store/migrations.ts').matchAll(/CREATE TABLE (\w+)/g),
    ].map((m) => m[1]!);
    expect(tables.filter((t) => !doc.includes(`\`${t}\``))).toEqual([]);
  });

  it('documents every heuristic signal with its current weight', () => {
    for (const s of SIGNALS) {
      const w = (s.weight > 0 ? '+' : '−') + Math.abs(s.weight).toFixed(2);
      expect(doc).toMatch(new RegExp(`\\| ${s.id} \\| ${w.replace('+', '\\+')} \\|`));
    }
  });
});
