import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSession } from './index';

/** Mirrors CC 2.1.293 subagent files: stop_reason null everywhere, stream-start usage. */
function write(stopReason: string | null, outputTokens: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'garden-tok-'));
  const proj = join(dir, 'projects', '-x');
  mkdirSync(proj, { recursive: true });
  const sid = '11111111-0000-4000-8000-000000000001';
  const common = {
    sessionId: sid,
    cwd: '/x',
    version: '2.1.293',
    entrypoint: 'cli',
    isSidechain: false,
    userType: 'external',
  };
  const usage = {
    input_tokens: 10,
    output_tokens: outputTokens,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  const lines = [
    {
      ...common,
      type: 'user',
      uuid: 'u1',
      parentUuid: null,
      timestamp: '2026-10-01T00:00:00.000Z',
      origin: { kind: 'human' },
      message: { role: 'user', content: 'write the report' },
    },
    ...[0, 1].map((i) => ({
      ...common,
      type: 'assistant',
      uuid: `a${i}`,
      parentUuid: i ? 'a0' : 'u1',
      timestamp: `2026-10-01T00:00:0${i + 1}.000Z`,
      message: {
        id: `msg_${i}`,
        model: 'claude-opus-5-5',
        role: 'assistant',
        stop_reason: stopReason,
        usage,
        content: [{ type: 'text', text: 'x'.repeat(4000) }],
      },
    })),
  ];
  const path = join(proj, `${sid}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

describe('output token estimate for stream-start usage snapshots', () => {
  it('estimates (lower bound, ~4 chars/token) and flags the run', async () => {
    const run = (await parseSession(write(null, 3))).runs[0]!;
    expect(run.outputTokensEstimated).toBe(true);
    expect(run.tokens.output).toBe(2000);
    // Step-level tokens stay as recorded.
    expect(run.steps.filter((s) => s.tokens).map((s) => s.tokens!.output)).toEqual([3, 3]);
  });
  it('keeps reported numbers when the source reports a stop_reason', async () => {
    const run = (await parseSession(write('end_turn', 3))).runs[0]!;
    expect(run.outputTokensEstimated).toBeUndefined();
    expect(run.tokens.output).toBe(6);
  });
  it('keeps reported numbers when they are plausible', async () => {
    const run = (await parseSession(write(null, 1500))).runs[0]!;
    expect(run.outputTokensEstimated).toBeUndefined();
    expect(run.tokens.output).toBe(3000);
  });
});
