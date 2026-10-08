import { describe, expect, it } from 'vitest';
import { SIGNALS, ZERO_USAGE, scoreSignals, type OutcomeSignalResult } from '@garden/core';
import type { ParsedRun, ParsedSession, ParsedStep } from '../contracts';
import { detectSessionOutcomes } from './signals';
import { isAcknowledgement, isCorrection, similarity, truncate } from './text';

// ---------------------------------------------------------------------------------------------
// Factories: hand-built parsed data (independent of the transcript parser).
// ---------------------------------------------------------------------------------------------

const T0 = Date.parse('2026-10-01T10:00:00Z');
const iso = (minutes: number) => new Date(T0 + minutes * 60000).toISOString();

/** Builds the steps of one run with auto-incrementing seq, timestamps, and call ids. */
class Steps {
  steps: ParsedStep[] = [];
  private n = 0;
  constructor(
    private runKey: string,
    private startMin = 0,
  ) {}

  private add(step: Omit<ParsedStep, 'id' | 'seq' | 'at' | 'loopTier'>): ParsedStep {
    const seq = ++this.n;
    const s: ParsedStep = {
      id: `${this.runKey}-s${seq}`,
      seq,
      at: iso(this.startMin + seq * 0.1),
      loopTier: 'agent',
      ...step,
    };
    this.steps.push(s);
    return s;
  }
  user(text: string) {
    return this.add({ kind: 'user_message', preview: text, raw: {} });
  }
  say(text = 'ok', stopReason?: string) {
    return this.add({ kind: 'assistant_message', preview: text, raw: { stopReason } });
  }
  /** A tool call plus its result. */
  tool(
    name: string,
    input: { command?: string; filePath?: string },
    result: { isError?: boolean; preview?: string } = {},
  ) {
    const callId = `${this.runKey}-call${this.n + 1}`;
    this.add({ kind: 'tool_call', tool: { name, callId, category: 'builtin' }, raw: { ...input } });
    return this.add({
      kind: 'tool_result',
      preview: result.preview ?? '',
      tool: { name, callId, category: 'builtin', isError: result.isError ?? false },
      raw: { ...input, answersCallId: callId },
    });
  }
  /** A tool call with no result (run ended first). */
  dangling(name: string, input: { command?: string }) {
    const callId = `${this.runKey}-call${this.n + 1}`;
    return this.add({ kind: 'tool_call', tool: { name, callId, category: 'builtin' }, raw: input });
  }
  bash(command: string, result: { isError?: boolean; preview?: string } = {}) {
    return this.tool('Bash', { command }, result);
  }
  edit(filePath = 'src/app.ts') {
    return this.tool('Edit', { filePath });
  }
  apiError(message = 'overloaded') {
    return this.add({ kind: 'error', error: { kind: 'api', message }, raw: {} });
  }
  spawn(subagentType: string, prompt: string, childRunId?: string, atMin?: number) {
    const s = this.add({
      kind: 'subagent_spawn',
      tool: { name: 'Agent', callId: `${this.runKey}-call${this.n + 1}`, category: 'subagent' },
      childRunId,
      raw: { subagentType, subagentPrompt: prompt },
    });
    if (atMin !== undefined) s.at = iso(atMin);
    return s;
  }
}

function run(id: string, overrides: Partial<ParsedRun> & { steps?: ParsedStep[] } = {}): ParsedRun {
  const steps = overrides.steps ?? [];
  return {
    id,
    sessionId: 'ses1',
    agentName: 'main',
    kind: 'main',
    trigger: 'human',
    cwd: '/home/u/proj',
    startedAt: iso(0),
    endedAt: iso(5),
    taskText: 'fix the login redirect bug',
    models: ['claude-opus-5-5'],
    tokens: { ...ZERO_USAGE },
    stepCount: steps.length,
    toolCallCount: steps.filter((s) => s.kind === 'tool_call').length,
    errorCount: 0,
    compactionCount: 0,
    peakContextTokens: 0,
    observed: { tools: [], skills: [], subagentTypes: [], mcpServers: [] },
    finalStopReason: 'end_turn',
    interrupted: false,
    ...overrides,
    steps,
  };
}

function session(...runs: ParsedRun[]): ParsedSession {
  return {
    id: 'ses1',
    rawSessionId: 'raw1',
    path: '/tmp/x.jsonl',
    cwd: '/home/u/proj',
    startedAt: iso(0),
    endedAt: iso(60),
    runs,
    census: { recordTypes: {}, unknownFields: {}, versions: {} },
    warnings: [],
    bytesRead: 0,
    knowledge: [],
  };
}

function signalsOf(ses: ParsedSession, runId: string): OutcomeSignalResult[] {
  const r = detectSessionOutcomes(ses).get(runId);
  if (r === undefined) throw new Error(`no outcomes for ${runId}`);
  return r;
}
function sig(results: OutcomeSignalResult[], id: string): OutcomeSignalResult {
  const r = results.find((x) => x.id === id);
  if (r === undefined) throw new Error(`no signal ${id}`);
  return r;
}
/** Detect one signal on a single-run session. */
function one(r: ParsedRun, id: string, ...more: ParsedRun[]): OutcomeSignalResult {
  return sig(signalsOf(session(r, ...more), r.id), id);
}

// ---------------------------------------------------------------------------------------------

describe('detectSessionOutcomes: shape', () => {
  it('returns one result per SIGNALS entry, in order, with weights copied', () => {
    const s = new Steps('r1');
    s.user('fix it');
    s.say();
    const results = signalsOf(session(run('r1', { steps: s.steps })), 'r1');
    expect(results.map((r) => r.id)).toEqual(SIGNALS.map((d) => d.id));
    expect(results.map((r) => r.weight)).toEqual(SIGNALS.map((d) => d.weight));
    for (const r of results) expect(r.detail.length).toBeGreaterThan(0);
  });

  it('marks main-only signals null on subagent runs and vice versa', () => {
    const main = run('m1');
    const sub = run('a1', { kind: 'subagent', agentName: 'Explore', trigger: 'subagent' });
    const out = detectSessionOutcomes(session(main, sub));
    expect(sig(out.get('a1') ?? [], 'user_retried').fired).toBeNull();
    expect(sig(out.get('a1') ?? [], 'user_moved_on').fired).toBeNull();
    expect(sig(out.get('m1') ?? [], 'parent_respawned').fired).toBeNull();
  });
});

describe('tests_passed_after_last_edit', () => {
  it('fires when a passing test follows the last edit', () => {
    const s = new Steps('r');
    s.edit();
    s.bash('cd app && pnpm test -- --run', { preview: 'Tests 12 passed' });
    const r = one(run('r', { steps: s.steps }), 'tests_passed_after_last_edit');
    expect(r.fired).toBe(true);
    expect(r.detail).toBe(
      '`cd app && pnpm test -- --run` passed at step 4, after last edit at step 1.',
    );
  });
  it('does not fire when the only passing test came before a later edit', () => {
    const s = new Steps('r');
    s.bash('pnpm test');
    s.edit();
    const r = one(run('r', { steps: s.steps }), 'tests_passed_after_last_edit');
    expect(r.fired).toBe(false);
    expect(r.detail).toContain('ran before the last edit at step 3');
  });
  it('does not fire when the test after the edit failed', () => {
    const s = new Steps('r');
    s.edit();
    s.bash('pytest -q', { isError: true, preview: '2 failed, 3 passed' });
    expect(one(run('r', { steps: s.steps }), 'tests_passed_after_last_edit').fired).toBe(false);
  });
  it('counts any passing test when the run made no edits', () => {
    const s = new Steps('r');
    s.bash('go test ./...');
    const r = one(run('r', { steps: s.steps }), 'tests_passed_after_last_edit');
    expect(r.fired).toBe(true);
    expect(r.detail).toContain('no file edits');
  });
  it('is null when no test command ran', () => {
    const s = new Steps('r');
    s.edit();
    s.bash('cat test.log');
    s.bash('echo "pnpm test"');
    expect(one(run('r', { steps: s.steps }), 'tests_passed_after_last_edit').fired).toBeNull();
  });
  it('treats exit-0 output that reports failures as not passing', () => {
    const s = new Steps('r');
    s.edit();
    s.bash('pnpm test || true', { preview: 'Tests: 1 failed, 9 passed' });
    expect(one(run('r', { steps: s.steps }), 'tests_passed_after_last_edit').fired).toBe(false);
  });
});

describe('tests_failing_at_end', () => {
  it('fires when the last test command errored', () => {
    const s = new Steps('r');
    s.bash('pnpm test');
    s.edit();
    s.bash('pnpm test', { isError: true });
    const r = one(run('r', { steps: s.steps }), 'tests_failing_at_end');
    expect(r.fired).toBe(true);
    expect(r.detail).toBe('Last test command `pnpm test` returned an error at step 6.');
  });
  it('fires on failing output even without isError', () => {
    const s = new Steps('r');
    s.bash('pytest | tail -5', { preview: 'FAILED tests/test_x.py::test_a - assert 1 == 2' });
    const r = one(run('r', { steps: s.steps }), 'tests_failing_at_end');
    expect(r.fired).toBe(true);
    expect(r.detail).toContain('reported failures');
  });
  it('does not fire when an earlier failure was fixed', () => {
    const s = new Steps('r');
    s.bash('pnpm test', { isError: true });
    s.edit();
    s.bash('pnpm test', { preview: '0 failed' });
    expect(one(run('r', { steps: s.steps }), 'tests_failing_at_end').fired).toBe(false);
  });
  it('ignores a trailing test call without a result', () => {
    const s = new Steps('r');
    s.bash('pnpm test', { preview: 'ok' });
    s.dangling('Bash', { command: 'pnpm test' });
    expect(one(run('r', { steps: s.steps }), 'tests_failing_at_end').fired).toBe(false);
  });
  it('is null when no test command ran', () => {
    expect(one(run('r'), 'tests_failing_at_end').fired).toBeNull();
  });
});

describe('clean_finish', () => {
  it('fires on end_turn without interrupt', () => {
    expect(one(run('r'), 'clean_finish').fired).toBe(true);
  });
  it('does not fire when interrupted', () => {
    expect(one(run('r', { interrupted: true }), 'clean_finish').fired).toBe(false);
  });
  it.each(['tool_use', 'max_tokens', 'refusal'])('does not fire on %s', (reason) => {
    const r = one(run('r', { finalStopReason: reason }), 'clean_finish');
    expect(r.fired).toBe(false);
    expect(r.detail).toContain(reason);
  });
  it('is null when no stop reason was recorded', () => {
    expect(one(run('r', { finalStopReason: undefined }), 'clean_finish').fired).toBeNull();
  });
});

describe('errors_in_tail', () => {
  it('fires on an unrecovered tool error near the end', () => {
    const s = new Steps('r');
    s.bash('ls');
    s.tool('Read', { filePath: 'missing.ts' }, { isError: true, preview: 'File does not exist' });
    s.say('I could not find it', 'end_turn');
    const r = one(run('r', { steps: s.steps }), 'errors_in_tail');
    expect(r.fired).toBe(true);
    expect(r.detail).toContain('Read error at step 4');
  });
  it('does not fire when the same tool later succeeded', () => {
    const s = new Steps('r');
    s.tool('Read', { filePath: 'missing.ts' }, { isError: true });
    s.tool('Read', { filePath: 'src/real.ts' });
    s.say();
    expect(one(run('r', { steps: s.steps }), 'errors_in_tail').fired).toBe(false);
  });
  it('ignores errors older than the last 5 steps', () => {
    const s = new Steps('r');
    s.tool('Grep', { command: undefined }, { isError: true });
    for (let i = 0; i < 3; i++) s.bash('ls');
    expect(one(run('r', { steps: s.steps }), 'errors_in_tail').fired).toBe(false);
  });
  it('fires on a trailing API error, not on one followed by an assistant message', () => {
    const a = new Steps('a');
    a.say();
    a.apiError('overloaded_error');
    expect(one(run('a', { steps: a.steps }), 'errors_in_tail').fired).toBe(true);
    const b = new Steps('b');
    b.apiError();
    b.say('retrying worked');
    expect(one(run('b', { steps: b.steps }), 'errors_in_tail').fired).toBe(false);
  });
  it('does not fire on an empty run', () => {
    expect(one(run('r'), 'errors_in_tail').fired).toBe(false);
  });
});

describe('user_retried / user_moved_on', () => {
  const next = (taskText: string, startMin: number, extra: Partial<ParsedRun> = {}) =>
    run('next', { taskText, startedAt: iso(startMin), endedAt: iso(startMin + 2), ...extra });

  it('retried: correction within 10 minutes', () => {
    const r = run('r');
    const out = signalsOf(session(r, next("no, it's still redirecting to /home", 7)), 'r');
    expect(sig(out, 'user_retried').fired).toBe(true);
    expect(sig(out, 'user_retried').detail).toContain('correction');
    expect(sig(out, 'user_moved_on').fired).toBe(false);
  });
  it('retried: correction phrase anywhere in the prompt', () => {
    expect(
      one(run('r'), 'user_retried', next('hmm ok but same error in the console', 6)).fired,
    ).toBe(true);
  });
  it('retried: near-identical prompt within 10 minutes', () => {
    const r = one(run('r'), 'user_retried', next('fix the login redirect bug please!', 6));
    expect(r.fired).toBe(true);
    expect(r.detail).toContain('similarity');
  });
  it('not retried: correction after more than 10 minutes, and not moved on either', () => {
    const r = run('r');
    const out = signalsOf(session(r, next('still broken', 30)), 'r');
    expect(sig(out, 'user_retried').fired).toBe(false);
    expect(sig(out, 'user_moved_on').fired).toBe(false);
  });
  it('retried: interrupt counts even without a next prompt', () => {
    const r = run('r', { interrupted: true });
    const out = signalsOf(session(r), 'r');
    expect(sig(out, 'user_retried').fired).toBe(true);
    expect(sig(out, 'user_moved_on').fired).toBeNull();
  });
  it('both null when there is no next human prompt', () => {
    const r = run('r');
    const auto = next('fix the login redirect bug', 6, { trigger: 'automated' });
    const out = signalsOf(session(r, auto), 'r');
    expect(sig(out, 'user_retried').fired).toBeNull();
    expect(sig(out, 'user_moved_on').fired).toBeNull();
  });
  it('skips automated runs and subagent runs to find the next human prompt', () => {
    const r = run('r');
    const auto = run('auto', { trigger: 'automated', taskText: 'stop hook continuation' });
    const human = next('thanks! now add a test for logout', 8);
    const sub = run('sub', { kind: 'subagent', trigger: 'subagent', agentName: 'Explore' });
    const out = signalsOf(session(r, auto, human, sub), 'r');
    expect(sig(out, 'user_moved_on').fired).toBe(true);
  });
  it('moved on: acknowledgement', () => {
    const r = one(run('r'), 'user_moved_on', next('lgtm, commit it', 3));
    expect(r.fired).toBe(true);
    expect(r.detail).toContain('acknowledgement');
  });
  it('moved on: new topic', () => {
    const r = one(run('r'), 'user_moved_on', next('write a README section on deployment', 4));
    expect(r.fired).toBe(true);
    expect(r.detail).toContain('new topic');
  });
  it('not moved on: same topic, not a correction', () => {
    const r = run('r', { taskText: 'add pagination to the users table' });
    const out = signalsOf(session(r, next('add pagination to the orders table too', 4)), 'r');
    expect(sig(out, 'user_retried').fired).toBe(false);
    expect(sig(out, 'user_moved_on').fired).toBe(false);
  });
});

describe('shipped', () => {
  it('fires on a successful git commit', () => {
    const s = new Steps('r');
    s.bash('git add -A && git commit -m "fix: redirect"');
    const r = one(run('r', { steps: s.steps }), 'shipped');
    expect(r.fired).toBe(true);
    expect(r.detail).toContain('succeeded at step 2');
  });
  it('fires on gh pr create', () => {
    const s = new Steps('r');
    s.bash('gh pr create --fill');
    expect(one(run('r', { steps: s.steps }), 'shipped').fired).toBe(true);
  });
  it('does not fire when the push failed', () => {
    const s = new Steps('r');
    s.bash('git push', { isError: true, preview: 'rejected' });
    const r = one(run('r', { steps: s.steps }), 'shipped');
    expect(r.fired).toBe(false);
    expect(r.detail).toContain('did not succeed');
  });
  it('does not fire for status-only git commands', () => {
    const s = new Steps('r');
    s.bash('git status && git diff');
    expect(one(run('r', { steps: s.steps }), 'shipped').fired).toBe(false);
  });
});

describe('parent_respawned', () => {
  const prompt = 'Find every place the session cookie is read in src/auth';
  function family(secondPrompt: string | null, secondType = 'Explore', secondAtMin = 10) {
    const p = new Steps('p');
    p.user('fix auth');
    const first = p.spawn('Explore', prompt, 'child');
    if (secondPrompt !== null) p.spawn(secondType, secondPrompt, 'child2', secondAtMin);
    const parent = run('p', { steps: p.steps, endedAt: iso(20) });
    const child = run('child', {
      kind: 'subagent',
      trigger: 'subagent',
      agentName: 'Explore',
      parentRunId: 'p',
      parentStepId: first.id,
      taskText: prompt,
      startedAt: iso(1),
      endedAt: iso(5),
    });
    return session(parent, child);
  }

  it('fires when the parent spawns the same type with a similar prompt after it returned', () => {
    const r = sig(
      signalsOf(
        family('Find every place the session cookie is read in src/auth and src/api'),
        'child',
      ),
      'parent_respawned',
    );
    expect(r.fired).toBe(true);
    expect(r.detail).toContain('Explore again at step 3');
  });
  it('does not fire for a different prompt', () => {
    const r = sig(signalsOf(family('List the database migrations'), 'child'), 'parent_respawned');
    expect(r.fired).toBe(false);
  });
  it('does not fire for a different subagent type', () => {
    const r = sig(signalsOf(family(prompt, 'general-purpose'), 'child'), 'parent_respawned');
    expect(r.fired).toBe(false);
  });
  it('does not treat a parallel spawn (before this run ended) as a respawn', () => {
    const r = sig(signalsOf(family(prompt, 'Explore', 2), 'child'), 'parent_respawned');
    expect(r.fired).toBe(false);
  });
  it('is null when the parent run is missing', () => {
    const child = run('c', { kind: 'subagent', trigger: 'subagent', parentRunId: 'gone' });
    expect(one(child, 'parent_respawned').fired).toBeNull();
  });
});

describe('pipeline into scoreSignals', () => {
  it('edit → passing tests → commit → thanks is success', () => {
    const s = new Steps('r');
    s.user('fix the login redirect bug');
    s.tool('Read', { filePath: 'src/auth.ts' });
    s.edit('src/auth.ts');
    s.bash('pnpm test', { preview: 'Test Files 4 passed (4)' });
    s.bash('git commit -am "fix: login redirect"');
    s.say('Fixed and committed.', 'end_turn');
    const r = run('r', { steps: s.steps });
    const out = signalsOf(session(r, run('n', { taskText: 'thanks!', startedAt: iso(6) })), 'r');
    expect(scoreSignals(out)).toEqual({ label: 'success', score: 1 });
  });

  it('edit → failing tests at the end is failure', () => {
    const s = new Steps('r');
    s.edit();
    s.bash('pnpm test', { isError: true, preview: '1 failed' });
    s.edit();
    s.bash('pnpm test', { isError: true, preview: '1 failed' });
    s.say('Tests still fail; I need more info.', 'end_turn');
    const r = run('r', { steps: s.steps });
    const out = signalsOf(
      session(r, run('n', { taskText: 'still failing', startedAt: iso(7) })),
      'r',
    );
    // -0.35 (failing) + 0.1 (clean) - 0.2 (Bash error unrecovered) - 0.3 (retried)
    expect(scoreSignals(out).label).toBe('failure');
  });

  it('clean finish alone is partial', () => {
    const s = new Steps('r');
    s.user('explain this module');
    s.tool('Read', { filePath: 'src/x.ts' });
    s.say('It does X.', 'end_turn');
    const out = signalsOf(session(run('r', { steps: s.steps })), 'r');
    expect(scoreSignals(out)).toEqual({ label: 'partial', score: 0.6 });
  });

  it('nothing fired is unknown', () => {
    const s = new Steps('r');
    s.user('explain this module');
    s.say('...');
    const out = signalsOf(session(run('r', { steps: s.steps, finalStopReason: undefined })), 'r');
    expect(scoreSignals(out)).toEqual({ label: 'unknown', score: null });
  });
});

describe('text helpers', () => {
  it('similarity is token Jaccard without stopwords', () => {
    expect(similarity('fix the bug', 'fix a bug')).toBe(1);
    expect(similarity('fix login', 'fix logout')).toBeCloseTo(1 / 3);
    expect(similarity('', 'anything')).toBe(0);
  });
  it.each([
    'no, that is wrong',
    "it's still failing",
    "That didn't work",
    'revert that',
    'why did you delete the file?',
    'the build is still broken',
    'same error as before',
    'you broke the header',
  ])('correction: %s', (t) => {
    expect(isCorrection(t)).toBe(true);
  });
  it.each(['now add a logout button', 'thanks, looks good', 'write docs for the API'])(
    'not a correction: %s',
    (t) => {
      expect(isCorrection(t)).toBe(false);
    },
  );
  it.each(['thanks!', 'Perfect. Now add tests', 'lgtm', 'ok, now deploy it', 'commit this'])(
    'acknowledgement: %s',
    (t) => {
      expect(isAcknowledgement(t)).toBe(true);
    },
  );
  it('a "thanks but still broken" is not an acknowledgement', () => {
    expect(isAcknowledgement('thanks, but it is still broken')).toBe(false);
  });
  it('truncate collapses whitespace and caps length', () => {
    expect(truncate('a\n  b')).toBe('a b');
    expect(truncate('x'.repeat(100))).toHaveLength(80);
  });
});
