import { describe, expect, it } from 'vitest';
import type { Step } from '@garden/core';
import { Redactor } from '../redact';
import { buildDemoSchedule, DEMO_PERMISSION_STALL_MS, type DemoRun } from './demo';
import { LiveHub } from './hub';

const redactor = new Redactor(Buffer.alloc(32, 3));
const T = Date.parse('2026-09-01T10:00:00Z');
const iso = (s: number) => new Date(T + s * 1000).toISOString();
type S = DemoRun['steps'][number];
const red = (s: string) => redactor.text(s);

function mainRun(i: number, bed: number, extra: S[] = [], child?: string): DemoRun {
  const steps: S[] = [
    { kind: 'user_message', at: iso(0), preview: red(`task ${i}`) },
    { kind: 'thinking', at: iso(2), preview: red('[thinking: 900 chars]') },
    {
      kind: 'tool_call',
      at: iso(4),
      preview: red('{"file_path":"a.ts"}'),
      tool: { name: 'Read', callId: `r${i}`, category: 'builtin' },
    },
    {
      kind: 'tool_result',
      at: iso(5),
      tool: { name: 'Read', callId: `r${i}`, category: 'builtin' },
    },
    ...extra,
  ];
  if (child) {
    steps.push(
      {
        kind: 'subagent_spawn',
        at: iso(8),
        tool: { name: 'Agent', callId: `s${i}`, category: 'subagent' },
        childRunId: child,
      },
      {
        kind: 'tool_result',
        at: iso(30),
        tool: { name: 'Agent', callId: `s${i}`, category: 'subagent' },
      },
    );
  }
  steps.push({
    kind: 'assistant_message',
    at: iso(40),
    preview: red('done'),
    contextTokens: 12000,
    apiMessageId: `m${i}`,
  });
  return {
    id: `run${i}`,
    sessionId: `ses${i}`,
    agentId: 'agt_main',
    agentName: 'main',
    kind: 'main',
    familyId: `fam${bed}`,
    bedName: `bed-${bed}`,
    model: 'claude-opus-5-5',
    startedAt: iso(i * 100),
    compactions: extra.some((s) => s.kind === 'compaction') ? 1 : 0,
    errors: extra.some((s) => s.tool?.isError) ? 1 : 0,
    steps,
  };
}

const sub: DemoRun = {
  id: 'child1',
  sessionId: 'ses1',
  agentId: 'agt_explore',
  agentName: 'Explore',
  kind: 'subagent',
  familyId: 'fam0',
  bedName: 'bed-0',
  parentRunId: 'run1',
  startedAt: iso(108),
  compactions: 0,
  errors: 0,
  steps: [
    { kind: 'user_message', at: iso(9), preview: red('explore') },
    { kind: 'tool_call', at: iso(10), tool: { name: 'Grep', callId: 'g1', category: 'builtin' } },
    { kind: 'tool_result', at: iso(12), tool: { name: 'Grep', callId: 'g1', category: 'builtin' } },
  ] satisfies Partial<Step>[] as S[],
};

const runs: DemoRun[] = [
  mainRun(1, 0, [], 'child1'),
  sub,
  mainRun(2, 1, [
    { kind: 'tool_call', at: iso(6), tool: { name: 'Bash', callId: 'b2', category: 'builtin' } },
    {
      kind: 'tool_result',
      at: iso(7),
      tool: { name: 'Bash', callId: 'b2', category: 'builtin', isError: true },
      error: { kind: 'tool', message: red('exit 1') },
    },
  ]),
  mainRun(3, 2, [
    {
      kind: 'compaction',
      at: iso(6),
      preview: red('[compaction: auto]'),
      compaction: { trigger: 'auto' },
    } as S,
  ]),
  mainRun(4, 1),
  mainRun(5, 0),
];

describe('demo live schedule', () => {
  it('is deterministic for a seed and differs across seeds', () => {
    const a = buildDemoSchedule(runs, redactor, { seed: 7 });
    const b = buildDemoSchedule(runs, redactor, { seed: 7 });
    const c = buildDemoSchedule(runs, redactor, { seed: 8 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });

  it('runs several beds concurrently, forks subagents, and covers error + compaction', () => {
    const items = buildDemoSchedule(runs, redactor, { seed: 1 });
    const kinds = new Set(items.map((x) => x.obs.event.kind));
    for (const k of [
      'turn_start',
      'tool_start',
      'tool_end',
      'subagent_start',
      'subagent_end',
      'compaction',
      'turn_end',
    ])
      expect(kinds, k).toContain(k);
    expect(items.some((x) => x.obs.event.isError)).toBe(true);
    // Concurrency: within the first 3 s, turns start in more than one bed.
    const early = new Set(
      items
        .filter((x) => x.atMs < 3_000 && x.obs.event.kind === 'turn_start')
        .map((x) => x.obs.agent.bedId),
    );
    expect(early.size).toBeGreaterThan(1);
    // The child plays between the parent's spawn and its result.
    const at = (pred: (x: (typeof items)[number]) => boolean) => items.find(pred)!.atMs;
    const spawn = at((x) => x.obs.event.kind === 'subagent_start');
    const childFirst = at((x) => x.obs.agent.key === 'demo:ses1:child1');
    const ret = at((x) => x.obs.event.kind === 'subagent_end');
    expect(spawn).toBeLessThan(childFirst);
    expect(childFirst).toBeLessThan(ret);
    expect(items.find((x) => x.obs.agent.key === 'demo:ses1:child1')!.obs.agent).toMatchObject({
      parentKey: 'demo:ses1',
      agentName: 'Explore',
      spawnCallId: 's1',
    });
    // Thinking text is never emitted.
    expect(
      items
        .filter((x) => x.obs.event.kind === 'thinking')
        .every((x) => x.obs.event.preview === undefined),
    ).toBe(true);
  });

  it('includes a stalled call that trips waiting_permission when played', () => {
    const items = buildDemoSchedule(runs, redactor, { seed: 1 });
    let now = 0;
    const hub = new LiveHub({ source: 'demo', now: () => now, tickMs: 0 });
    let sawPermission = false;
    hub.subscribe((m) => {
      if (m.type === 'agent' && m.agent.activity === 'waiting_permission') sawPermission = true;
    });
    const end = items.at(-1)!.atMs;
    let i = 0;
    for (now = 0; now <= end + 1000; now += 250) {
      while (i < items.length && items[i]!.atMs <= now) {
        const { obs } = items[i++]!;
        hub.push({ ...obs, event: { ...obs.event, at: new Date(now).toISOString() } });
      }
      hub.tick();
    }
    expect(DEMO_PERMISSION_STALL_MS).toBeGreaterThan(6_000);
    expect(sawPermission).toBe(true);
    expect(hub.snapshot().source).toBe('demo');
  });
});
