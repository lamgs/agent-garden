import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ZERO_USAGE, type Run } from '@garden/core';
import { Redactor } from '../redact';
import { MIGRATIONS } from './migrations';
import { Store } from './store';

const dir = mkdtempSync(join(tmpdir(), 'garden-store-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const red = new Redactor(Buffer.alloc(32, 1));

function seed(store: Store): void {
  const t = '2026-10-01T10:00:00.000Z';
  store.putSource({ id: 's', adapter: 'x', root: red.text('/r'), adapterVersion: '1' });
  store.putFamily({ id: 'f', name: 'bed', projectRoot: red.text('/r') });
  store.putAgent({ id: 'a', name: 'main', kind: 'main', firstSeenAt: t, lastSeenAt: t });
  store.putHarnessVersion({
    id: 'h',
    familyId: 'f',
    validFrom: t,
    provenance: 'observed',
    bundle: { instructions: [], tools: [], skills: [], subagents: [], mcpServers: [], hooks: [] },
  });
  store.putSession({
    id: 'se',
    sourceId: 's',
    familyId: 'f',
    path: red.text('/p'),
    startedAt: t,
    endedAt: t,
  });
  const run: Run = {
    id: 'r',
    sessionId: 'se',
    agentId: 'a',
    familyId: 'f',
    harnessVersionId: 'h',
    startedAt: t,
    endedAt: t,
    trigger: 'human',
    taskPreview: red.text('fix the flaky test'),
    models: ['claude-opus-5-5'],
    tokens: { ...ZERO_USAGE, input: 10, output: 5 },
    stepCount: 1,
    toolCallCount: 1,
    errorCount: 0,
    compactionCount: 0,
    peakContextTokens: 1234,
  };
  store.putRun(run);
  store.putStep({
    id: 'st',
    runId: 'r',
    seq: 0,
    at: t,
    kind: 'tool_call',
    loopTier: 'verification',
    preview: red.text('pnpm test'),
    tool: { name: 'Bash', callId: 'c', category: 'builtin', isError: false },
    apiMessageId: 'msg_1',
    tokens: { ...ZERO_USAGE, input: 10, output: 5 },
    contextTokens: 1234,
  });
  store.putHeuristicOutcome({
    runId: 'r',
    label: 'partial',
    score: 0.6,
    heuristicVersion: 'h1',
    signals: [],
  });
}

describe('Store', () => {
  it('migrates to the latest version and is idempotent on reopen', () => {
    const path = join(dir, 'm.db');
    new Store(path).close();
    const s = new Store(path);
    expect(s.schemaVersion()).toBe(MIGRATIONS.length);
    s.close();
  });

  it('round-trips runs and steps', () => {
    const s = new Store(join(dir, 'rt.db'));
    seed(s);
    expect(s.getRun('r')?.tokens.input).toBe(10);
    expect(s.getRun('r')?.peakContextTokens).toBe(1234);
    const [step] = s.getSteps('r');
    expect(step?.tool?.isError).toBe(false);
    expect(step?.loopTier).toBe('verification');
    expect(step?.tokens?.output).toBe(5);
    s.close();
  });

  it('manual labels override heuristics, survive re-ingestion, and keep the heuristic evidence', () => {
    const s = new Store(join(dir, 'label.db'));
    seed(s);
    s.putManualLabel('r', 'success', red.text('verified by hand'), '2026-10-02T00:00:00Z');
    seed(s); // re-ingest
    const o = s.getOutcome('r')!;
    expect(o.label).toBe('success');
    expect(o.source).toBe('manual');
    expect(o.score).toBe(0.6);
    expect(o.heuristicVersion).toBe('h1');
    s.clearManualLabel('r');
    expect(s.getOutcome('r')?.label).toBe('partial');
    s.close();
  });

  it('enforces referential integrity', () => {
    const s = new Store(join(dir, 'fk.db'));
    expect(() =>
      s.putStep({ id: 'x', runId: 'missing', seq: 0, at: 't', kind: 'error', loopTier: 'agent' }),
    ).toThrow();
    s.close();
  });

  it('tracks file state for incremental ingestion', () => {
    const s = new Store(join(dir, 'fs.db'));
    s.putFileState({
      path: '/a.jsonl',
      adapter: 'claude-code',
      size: 10,
      mtimeMs: 5,
      byteOffset: 10,
    });
    expect(s.getFileState('/a.jsonl')?.byteOffset).toBe(10);
    s.close();
  });
});
