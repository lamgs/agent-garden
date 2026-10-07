/**
 * Redaction proof: secrets planted in every free-text field of every record type must not appear
 * anywhere in the bytes of the SQLite database (main file, WAL, and SHM), not even as fragments.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { ZERO_USAGE } from '@garden/core';
import type { Adapter, NormalizedRecord } from './adapter';
import { ingest } from './pipeline';
import { Redactor } from './redact';
import { plantedSecrets } from './redact/planted-secrets';
import { Store } from './store/store';

const dir = mkdtempSync(join(tmpdir(), 'garden-proof-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const secrets = plantedSecrets('proof');
/** All planted contexts joined: every field below carries every secret kind. */
const all = secrets.map((s) => s.context).join('\n');
const pick = (i: number) => secrets[i % secrets.length]!.context;

function fakeAdapter(): Adapter {
  const t = '2026-10-01T10:00:00.000Z';
  const records: NormalizedRecord[] = [
    {
      type: 'source',
      value: { id: 'src', adapter: 'fake', root: `/home/u/${pick(0)}`, adapterVersion: '1' },
    },
    {
      type: 'agent',
      value: {
        id: 'ag',
        name: 'test-writer',
        kind: 'subagent',
        definition: {
          scope: 'project',
          path: `/repo/.claude/agents/${pick(1)}.md`,
          description: all,
          tools: ['Bash'],
          contentHash: 'h',
        },
        firstSeenAt: t,
        lastSeenAt: t,
      },
    },
    { type: 'family', value: { id: 'fam', name: 'shop-api', projectRoot: `/repo?${pick(2)}` } },
    {
      type: 'harness_version',
      value: {
        id: 'hv',
        familyId: 'fam',
        validFrom: t,
        provenance: 'git',
        bundle: {
          instructions: [{ path: `/repo/CLAUDE.md#${pick(3)}`, hash: 'abc', bytes: 10 }],
          tools: ['Bash'],
          skills: [],
          subagents: [],
          mcpServers: ['github'],
          hooks: [{ event: 'Stop', commandHash: 'def' }],
        },
        commit: { sha: 'a1b2c3', message: all },
      },
    },
    {
      type: 'skill',
      value: {
        id: 'sk',
        name: 'deploy',
        dirName: 'deploy',
        scope: 'user',
        path: `/home/u/.claude/skills/${pick(4)}`,
        description: all,
        contentHash: 'h',
      },
    },
    {
      type: 'playbook',
      value: {
        id: 'pb',
        name: 'release',
        source: 'garden.yaml',
        steps: [{ id: 's1', gate: { kind: 'command_ok', pattern: pick(5) } }],
      },
    },
    {
      type: 'loop',
      value: {
        id: 'lp',
        name: 'nightly',
        tier: 'verification',
        provenance: 'config',
        trigger: { kind: 'hook', detail: all },
        targets: { agentIds: ['ag'], familyIds: ['fam'] },
      },
    },
    {
      type: 'session',
      value: {
        id: 'se',
        sourceId: 'src',
        familyId: 'fam',
        path: `/home/u/.claude/projects/x/${pick(6)}.jsonl`,
        startedAt: t,
        endedAt: t,
      },
    },
    {
      type: 'run',
      value: {
        id: 'ru',
        sessionId: 'se',
        agentId: 'ag',
        familyId: 'fam',
        harnessVersionId: 'hv',
        startedAt: t,
        endedAt: t,
        trigger: 'human',
        taskPreview: all,
        models: ['claude-opus-5-5'],
        tokens: { ...ZERO_USAGE },
        stepCount: 3,
        toolCallCount: 1,
        errorCount: 1,
        compactionCount: 0,
        peakContextTokens: 0,
      },
    },
    // Secrets placed at the very end of a long preview, where truncation happens.
    ...['tool_call', 'tool_result', 'error'].map((kind, i): NormalizedRecord => ({
      type: 'step',
      value: {
        id: `st${i}`,
        runId: 'ru',
        seq: i,
        at: t,
        kind: kind as 'tool_call',
        loopTier: 'agent',
        preview: 'x'.repeat(1995) + ' ' + all,
        tool: { name: 'Bash', callId: `c${i}`, category: 'builtin', isError: kind === 'error' },
        ...(kind === 'error' ? { error: { kind: 'tool' as const, message: all } } : {}),
      },
    })),
    {
      type: 'outcome',
      value: {
        runId: 'ru',
        label: 'failure',
        score: 0.2,
        heuristicVersion: 'h1',
        signals: [{ id: 'errors_in_tail', fired: true, weight: -0.2, detail: all }],
      },
    },
  ];
  return {
    id: 'fake',
    version: '1',
    async *read() {
      yield* records;
    },
    async inspect() {
      return {
        adapter: 'fake',
        roots: [],
        recordTypes: {},
        unknownFields: {},
        versions: {},
        warnings: [],
      };
    },
  };
}

function dbBytes(path: string): string {
  return [path, `${path}-wal`, `${path}-shm`]
    .filter((p) => existsSync(p))
    .map((p) => readFileSync(p).toString('latin1'))
    .join('\n');
}

function leaks(bytes: string): string[] {
  const found: string[] = [];
  for (const s of secrets) {
    const core = s.secret.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');
    for (let i = 0; i + 12 <= core.length; i += 4) {
      if (bytes.includes(core.slice(i, i + 12))) {
        found.push(s.kind);
        break;
      }
    }
  }
  return found;
}

describe('redaction proof', () => {
  it('negative control: the byte scan detects a secret written without redaction', () => {
    const path = join(dir, 'control.db');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE t (v TEXT)');
    db.prepare('INSERT INTO t VALUES (?)').run(all);
    db.close();
    expect(leaks(dbBytes(path)).length).toBe(secrets.length);
  });

  it('no planted secret (or 12-char fragment) appears in the database bytes', async () => {
    const path = join(dir, 'garden.db');
    const store = new Store(path);
    const report = await ingest(fakeAdapter(), store, new Redactor(Buffer.alloc(32, 3)));
    // Inspect while the WAL may still hold pages, then again after a checkpoint on close.
    expect(leaks(dbBytes(path))).toEqual([]);
    store.close();
    expect(leaks(dbBytes(path))).toEqual([]);

    expect(Object.keys(report.redactions).length).toBeGreaterThanOrEqual(15);
    expect(report.records.step).toBe(3);
  });

  it('data is still useful after redaction', () => {
    const store = new Store(join(dir, 'garden.db'));
    const run = store.getRun('ru')!;
    expect(run.taskPreview).toContain('[REDACTED:');
    expect(run.taskPreview).toContain('DATABASE_URL=postgres://app_user:');
    expect(store.getSteps('ru')).toHaveLength(3);
    expect(store.getOutcome('ru')?.label).toBe('failure');
    store.close();
  });
});
