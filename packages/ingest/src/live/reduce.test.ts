import { describe, expect, it } from 'vitest';
import type { LiveEventKind } from '@garden/core';
import { activityForTool } from './activity';
import { initialLiveState, reduceLive, setRegistry, tickLive, type LiveState } from './reduce';
import {
  LIVE_THRESHOLDS,
  type LiveAgentHints,
  type LiveObservation,
  type LiveToolRef,
} from './types';

const T0 = Date.parse('2026-10-08T10:00:00Z');
const main: LiveAgentHints = {
  key: 'ses_a',
  sessionId: 'ses_a',
  agentKind: 'main',
  agentName: 'main',
  bedId: 'fam_x',
  bedName: 'repo',
  model: 'claude-opus-5-5',
};
const child: LiveAgentHints = {
  ...main,
  key: 'ses_a:c1',
  agentKind: 'subagent',
  agentName: 'Explore',
  parentKey: 'ses_a',
  spawnCallId: 'spawn1',
};

function ob(
  kind: LiveEventKind,
  dt: number,
  extra: Partial<LiveObservation> & {
    tool?: LiveToolRef;
    isError?: boolean;
    contextTokens?: number;
  } = {},
  agent = main,
): LiveObservation {
  const { tool, isError, contextTokens, ...rest } = extra;
  return {
    event: {
      at: new Date(T0 + dt).toISOString(),
      kind,
      agentKey: agent.key,
      ...(tool ? { tool } : {}),
      ...(isError ? { isError } : {}),
      ...(contextTokens !== undefined ? { contextTokens } : {}),
    },
    agent,
    ...rest,
  };
}

function run(obs: LiveObservation[], state: LiveState = initialLiveState()): LiveState {
  for (const o of obs) state = reduceLive(state, o, Date.parse(o.event.at)).state;
  return state;
}
const agent = (s: LiveState, k = 'ses_a') => s.agents[k]!.agent;
const read: LiveToolRef = { name: 'Read', category: 'builtin' };
const bash: LiveToolRef = { name: 'Bash', category: 'builtin' };

describe('activityForTool', () => {
  it('maps tools to activities', () => {
    expect(activityForTool('Read', 'builtin')).toBe('reading');
    expect(activityForTool('Grep', 'builtin')).toBe('searching');
    expect(activityForTool('Glob', 'builtin')).toBe('searching');
    expect(activityForTool('Edit', 'builtin')).toBe('editing');
    expect(activityForTool('Write', 'builtin')).toBe('editing');
    expect(activityForTool('NotebookEdit', 'builtin')).toBe('editing');
    expect(activityForTool('Bash', 'builtin')).toBe('running');
    expect(activityForTool('WebFetch', 'builtin')).toBe('web');
    expect(activityForTool('WebSearch', 'builtin')).toBe('web');
    expect(activityForTool('mcp__jira__get', 'mcp')).toBe('mcp');
    expect(activityForTool('Skill', 'skill')).toBe('skill');
    expect(activityForTool('Agent', 'subagent')).toBe('delegating');
    expect(activityForTool('Task', 'subagent')).toBe('delegating');
  });
});

describe('reduceLive', () => {
  it('walks a turn: prompt → thinking → tool → result → end of turn', () => {
    let s = run([ob('turn_start', 0, { detail: 'fix it' })]);
    expect(agent(s)).toMatchObject({ activity: 'thinking', toolCalls: 0, detail: 'fix it' });
    s = run([ob('tool_start', 1000, { tool: read, callId: 'c1', detail: 'a.ts' })], s);
    expect(agent(s)).toMatchObject({
      activity: 'reading',
      toolCalls: 1,
      currentTool: read,
      detail: 'a.ts',
    });
    s = run([ob('tool_end', 1500, { tool: read, callId: 'c1' })], s);
    expect(agent(s).activity).toBe('thinking');
    expect(agent(s).currentTool).toBeUndefined();
    s = run([ob('thinking', 2000, { stopReason: 'end_turn' })], s);
    expect(agent(s).activity).toBe('waiting_input');
    s = run(
      [
        ob('assistant_text', 2100, { stopReason: 'end_turn' }),
        ob('turn_end', 2100, { stopReason: 'end_turn' }),
      ],
      s,
    );
    expect(agent(s)).toMatchObject({
      activity: 'waiting_input',
      turnStartedAt: new Date(T0).toISOString(),
    });
    expect(agent(s).evidence).toContain('end_turn');
  });

  it('parallel calls: the newest open call decides the activity, results pair by id', () => {
    const s = run([
      ob('tool_start', 0, { tool: read, callId: 'r' }),
      ob('tool_start', 100, { tool: bash, callId: 'b' }),
      ob('tool_end', 200, { tool: bash, callId: 'b' }),
    ]);
    expect(agent(s).activity).toBe('reading');
    expect(s.agents.ses_a!.open.map((c) => c.callId)).toEqual(['r']);
  });

  it('dedupes context tokens by API message id', () => {
    let s = run([ob('thinking', 0, { apiMessageId: 'm1', contextTokens: 5000 })]);
    s = run([ob('assistant_text', 10, { apiMessageId: 'm1', contextTokens: 9999 })], s);
    expect(agent(s).contextTokens).toBe(5000);
    s = run([ob('assistant_text', 20, { apiMessageId: 'm2', contextTokens: 7000 })], s);
    expect(agent(s)).toMatchObject({ contextTokens: 7000, contextWindow: 1_000_000 });
  });

  it('maps compaction, tool errors, API errors and interrupts', () => {
    expect(agent(run([ob('compaction', 0)])).activity).toBe('compacting');
    const err = run([
      ob('tool_start', 0, { tool: bash, callId: 'b' }),
      ob('tool_end', 10, { tool: bash, callId: 'b', isError: true }),
    ]);
    expect(agent(err)).toMatchObject({ activity: 'errored', errors: 1 });
    expect(agent(run([ob('error', 0, { isError: true })])).activity).toBe('errored');
    expect(agent(run([ob('error', 0, { interrupt: true })]))).toMatchObject({
      activity: 'waiting_input',
      errors: 0,
    });
  });

  it('subagent: links to parent, ends done on the parent result', () => {
    let s = run([
      ob('subagent_start', 0, { tool: { name: 'Agent', category: 'subagent' }, callId: 'spawn1' }),
      ob('turn_start', 100, {}, child),
      ob('tool_start', 200, { tool: read, callId: 'x' }, child),
    ]);
    expect(agent(s)).toMatchObject({ activity: 'delegating' });
    expect(agent(s, 'ses_a:c1')).toMatchObject({
      activity: 'reading',
      parentKey: 'ses_a',
      agentName: 'Explore',
    });
    s = run([ob('subagent_end', 900, { callId: 'spawn1', childOutcome: 'done' })], s);
    expect(agent(s, 'ses_a:c1').activity).toBe('done');
    expect(agent(s).activity).toBe('thinking');
  });

  it('does not mutate the input state', () => {
    const s0 = run([ob('turn_start', 0)]);
    const frozen = JSON.stringify(s0);
    reduceLive(s0, ob('tool_start', 10, { tool: read, callId: 'c' }), T0 + 10);
    tickLive(s0, T0 + 3600_000);
    expect(JSON.stringify(s0)).toBe(frozen);
  });
});

describe('tickLive heuristics (injected clock)', () => {
  const open = (tool: LiveToolRef, extra: Partial<LiveObservation> = {}) =>
    run([ob('turn_start', 0), ob('tool_start', 1000, { tool, callId: 'c1', ...extra })]);

  it('fast tool open > 6 s with no newer line → possibly waiting_permission (with evidence)', () => {
    const s = open(read);
    expect(tickLive(s, T0 + 1000 + 5_000).changed).toHaveLength(0);
    const u = tickLive(s, T0 + 1000 + LIVE_THRESHOLDS.permissionMs + 1000);
    expect(agent(u.state).activity).toBe('waiting_permission');
    expect(agent(u.state).evidence).toMatch(
      /possibly waiting for permission: Read tool_use without tool_result for 7 s/,
    );
    expect(agent(u.state).evidence).toContain('a slow tool looks the same');
    // Ticking again does not re-announce.
    expect(tickLive(u.state, T0 + 9000).changed).toHaveLength(0);
    // The result arrives: back to thinking, and the guess is reconciled in the evidence.
    const r = reduceLive(
      u.state,
      ob('tool_end', 9500, {
        tool: read,
        callId: 'c1',
        permissionDecision: { decision: 'accept', source: 'config', reasonType: 'rule' },
      }),
      T0 + 9500,
    );
    expect(agent(r.state).activity).toBe('thinking');
    expect(agent(r.state).evidence).toContain('was a false positive (auto-approved: rule)');
  });

  it('Bash gets the longer threshold', () => {
    const s = open(bash);
    expect(agent(tickLive(s, T0 + 1000 + 10_000).state).activity).toBe('running');
    const u = tickLive(s, T0 + 1000 + LIVE_THRESHOLDS.slowToolPermissionMs + 1000);
    expect(agent(u.state).activity).toBe('waiting_permission');
    expect(agent(u.state).evidence).toContain('a long-running command looks the same');
  });

  it('never flags delegation, background calls, or auto-approving sessions', () => {
    const agentCall = open({ name: 'Agent', category: 'subagent' });
    expect(agent(tickLive(agentCall, T0 + 60_000).state).activity).toBe('delegating');
    const bg = open(bash, { background: true });
    expect(agent(tickLive(bg, T0 + 120_000).state).activity).toBe('running');
    let auto = run([ob('turn_start', 0)]);
    const pd = { decision: 'accept', source: 'config', reasonType: 'classifier' };
    for (let i = 0; i < 3; i++) {
      auto = run(
        [
          ob('tool_start', 10 + i * 10, { tool: read, callId: `a${i}` }),
          ob('tool_end', 15 + i * 10, { tool: read, callId: `a${i}`, permissionDecision: pd }),
        ],
        auto,
      );
    }
    auto = run([ob('tool_start', 1000, { tool: read, callId: 'slow' })], auto);
    const u = tickLive(auto, T0 + 1000 + 8000);
    expect(agent(u.state).activity).toBe('reading');
    expect(agent(u.state).evidence).toContain('not flagged as a permission wait');
    expect(tickLive(u.state, T0 + 1000 + 9000).changed).toHaveLength(0);
  });

  it('a newer line resets the timer', () => {
    let s = open(read);
    s = run([ob('hook', 6500)], s);
    expect(agent(tickLive(s, T0 + 8000).state).activity).toBe('reading');
  });

  it('session registry "waiting" with an open call → waiting_permission at once', () => {
    let s = open(read);
    s = setRegistry(s, {
      ses_a: { status: 'waiting', waitingFor: 'tool permission', alive: true },
    });
    const u = tickLive(s, T0 + 1200);
    expect(agent(u.state)).toMatchObject({ activity: 'waiting_permission' });
    expect(agent(u.state).evidence).toBe(
      'session registry status waiting (waitingFor: tool permission) while Read tool_use is open',
    );
  });

  it('no line for > 5 min → idle; past the active window → gone (parents kept while children live)', () => {
    let s = run([ob('turn_start', 0), ob('turn_start', 0, {}, child)]);
    s = run([ob('tool_start', 25 * 60_000, { tool: read, callId: 'x' }, child)], s);
    const idle = tickLive(s, T0 + 6 * 60_000);
    expect(agent(idle.state).activity).toBe('idle');
    expect(agent(idle.state).evidence).toBe('no transcript line for 6 min');
    const later = tickLive(idle.state, T0 + 31 * 60_000);
    expect(later.gone).toEqual([]); // child active at 25 min keeps the parent
    const end = tickLive(later.state, T0 + 56 * 60_000);
    expect(end.gone.sort()).toEqual(['ses_a', 'ses_a:c1']);
    expect(Object.keys(end.state.agents)).toEqual([]);
  });

  it('a session whose process exited is gone', () => {
    let s = run([ob('turn_start', 0), ob('turn_start', 0, {}, child)]);
    s = setRegistry(s, { ses_a: { status: 'idle', alive: false } });
    expect(tickLive(s, T0 + 1000).gone.sort()).toEqual(['ses_a', 'ses_a:c1']);
  });
});
