import { describe, expect, it } from 'vitest';
import type { GardenView, LiveMessage } from '@garden/core';
import { reduceAll } from '../studio/live-client';
import garden from './garden.demo.json';
import { activityForTool, createLiveDemo, DEMO_BEDS, DEMO_LOOPS } from './live-demo';

const run = (ms: number, opts = {}) => {
  const d = createLiveDemo(opts);
  const msgs: LiveMessage[] = [];
  for (let t = 0; t < ms; t += 250) msgs.push(...d.advance(250));
  return { d, msgs };
};

describe('live demo stream', () => {
  it('is deterministic: same seed and steps → identical messages', () => {
    expect(JSON.stringify(run(60_000).msgs)).toBe(JSON.stringify(run(60_000).msgs));
  });

  it('does not depend on step size', () => {
    const a = createLiveDemo();
    const b = createLiveDemo();
    const ma = a.advance(30_000);
    const mb: LiveMessage[] = [];
    for (let t = 0; t < 30_000; t += 1000) mb.push(...b.advance(1000));
    expect(JSON.stringify(mb)).toBe(JSON.stringify(ma));
  });

  it('a different seed changes the random turns', () => {
    expect(JSON.stringify(run(120_000, { seed: 1 }).msgs)).not.toBe(
      JSON.stringify(run(120_000, { seed: 2 }).msgs),
    );
  });

  it('joins the history layer: bed ids, names, and plant ids exist in garden.demo.json', () => {
    const g = garden as unknown as GardenView;
    for (const bed of DEMO_BEDS) {
      const b = g.beds.find((x) => x.id === bed.id);
      expect(b?.name, bed.id).toBe(bed.name);
      for (const [name, plantId] of Object.entries(bed.plants)) {
        const p = g.plants.find((x) => x.id === plantId);
        expect(p?.name, plantId).toBe(name);
        expect(p?.bedId).toBe(bed.id);
      }
    }
    for (const l of Object.values(DEMO_LOOPS))
      expect(g.loops.some((x) => x.loopId === l.id)).toBe(true);
  });

  it('covers the scripted moments within two minutes', () => {
    const { msgs } = run(120_000);
    const agents = msgs.flatMap((m) => (m.type === 'agent' ? [m.agent] : []));
    const events = msgs.flatMap((m) => (m.type === 'event' ? [m.event] : []));
    const acts = new Set(agents.map((a) => a.activity));
    for (const a of [
      'thinking',
      'reading',
      'searching',
      'editing',
      'running',
      'web',
      'mcp',
      'skill',
      'delegating',
      'waiting_permission',
      'waiting_input',
      'compacting',
      'errored',
      'done',
      'idle',
    ])
      expect(acts.has(a as never), a).toBe(true);
    const kinds = new Set(events.map((e) => e.kind));
    for (const k of [
      'session_seen',
      'turn_start',
      'thinking',
      'assistant_text',
      'tool_start',
      'tool_end',
      'subagent_start',
      'subagent_end',
      'compaction',
      'error',
      'turn_end',
      'hook',
    ])
      expect(kinds.has(k as never), k).toBe(true);
    expect(events.some((e) => e.kind === 'hook' && e.isError)).toBe(true);
    expect(events.some((e) => e.kind === 'tool_end' && e.isError)).toBe(true);
    // A loop-triggered headless run, and subagents that spawn under a parent then leave.
    expect(agents.some((a) => a.loop?.id === DEMO_LOOPS.backfill.id)).toBe(true);
    expect(agents.some((a) => a.agentKind === 'subagent' && a.parentKey)).toBe(true);
    expect(msgs.some((m) => m.type === 'gone')).toBe(true);
    // Skills and MCP calls name what they use.
    expect(events.some((e) => e.tool?.skillName === 'db-migrate')).toBe(true);
    expect(events.some((e) => e.tool?.mcpServer === 'mysql-legacy')).toBe(true);
  });

  it('keeps the stream well-formed: monotonic seq, previews ≤ 120 chars, gone agents stay gone', () => {
    const { d, msgs } = run(180_000);
    let seq = 0;
    for (const m of msgs) {
      if (m.type !== 'event') continue;
      expect(m.event.seq).toBe(seq + 1);
      seq = m.event.seq;
      expect((m.event.preview ?? '').length).toBeLessThanOrEqual(120);
    }
    const gone = new Set<string>();
    for (const m of msgs) {
      if (m.type === 'gone') gone.add(m.agentKey);
      else if (m.type === 'agent') expect(gone.has(m.agent.key), m.agent.key).toBe(false);
    }
    // Replaying the messages onto the t=0 snapshot gives the generator's own snapshot.
    const fresh = createLiveDemo();
    const replayed = reduceAll(
      fresh.snapshot(),
      (() => {
        const out: LiveMessage[] = [];
        for (let t = 0; t < 180_000; t += 250) out.push(...fresh.advance(250));
        return out;
      })(),
    );
    const own = d.snapshot();
    expect(replayed!.agents.map((a) => a.key).sort()).toEqual(own.agents.map((a) => a.key).sort());
    for (const a of own.agents) expect(replayed!.agents.find((x) => x.key === a.key)).toEqual(a);
    expect(replayed!.recent.map((e) => e.seq)).toEqual(own.recent.map((e) => e.seq));
  });

  it('context fill stays within the window and compaction empties it', () => {
    const { msgs } = run(60_000);
    for (const m of msgs)
      if (m.type === 'agent')
        expect(m.agent.contextTokens).toBeLessThanOrEqual(m.agent.contextWindow);
    const legacy = msgs.flatMap((m) =>
      m.type === 'agent' && m.agent.key === 'ses_demo_legacy_1' ? [m.agent] : [],
    );
    const i = legacy.findIndex((a) => a.activity === 'compacting');
    expect(i).toBeGreaterThan(0);
    const before = legacy[i]!.contextTokens / legacy[i]!.contextWindow;
    const after = legacy[i + 1]!.contextTokens / legacy[i + 1]!.contextWindow;
    expect(before).toBeGreaterThan(0.85);
    expect(after).toBeLessThan(0.2);
  });

  it('infers the permission wait only after 7 s of silence, with evidence saying so', () => {
    const { msgs } = run(60_000);
    const shop = msgs.flatMap((m) =>
      m.type === 'agent' && m.agent.key === 'ses_demo_shop_1' ? [m.agent] : [],
    );
    const wait = shop.find((a) => a.activity === 'waiting_permission')!;
    expect(wait.evidence).toMatch(/inferred/);
    const start = [...shop]
      .reverse()
      .find(
        (a) =>
          a.activity === 'running' && Date.parse(a.activitySince) <= Date.parse(wait.activitySince),
      )!;
    expect(Date.parse(wait.activitySince) - Date.parse(start.activitySince)).toBe(7000);
  });

  it('crowd mode holds 30+ agents', () => {
    const d = createLiveDemo({ crowd: true });
    d.advance(20_000);
    expect(d.snapshot().agents.length).toBeGreaterThanOrEqual(30);
  });
});

describe('activityForTool', () => {
  it('maps tools to activities', () => {
    const b = (name: string) => activityForTool({ name, category: 'builtin' });
    expect(b('Edit')).toBe('editing');
    expect(b('Write')).toBe('editing');
    expect(b('Read')).toBe('reading');
    expect(b('Grep')).toBe('searching');
    expect(b('Glob')).toBe('searching');
    expect(b('Bash')).toBe('running');
    expect(b('WebFetch')).toBe('web');
    expect(b('Task')).toBe('delegating');
    expect(activityForTool({ name: 'mcp__github__search', category: 'mcp' })).toBe('mcp');
    expect(activityForTool({ name: 'Skill', category: 'skill' })).toBe('skill');
  });
});
