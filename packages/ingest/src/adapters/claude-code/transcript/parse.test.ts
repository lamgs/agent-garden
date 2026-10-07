import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stableId } from '../../../ids';
import type { ParsedRun, ParsedSession } from '../contracts';
import { parseSession } from './index';

const FIXTURES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../fixtures/claude-code/projects/-home-dev-demo',
);
const sid = (n: number) => `0b5e0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const parse = (n: number): Promise<ParsedSession> =>
  parseSession(join(FIXTURES, `${sid(n)}.jsonl`));
const mainRuns = (s: ParsedSession): ParsedRun[] => s.runs.filter((r) => r.kind === 'main');

describe('parseSession: basic session', async () => {
  const s = await parse(1);
  const [r1, r2] = mainRuns(s);

  it('session fields and ids', () => {
    expect(s.rawSessionId).toBe(sid(1));
    expect(s.id).toBe(stableId('ses', sid(1)));
    expect(s.cwd).toBe('/home/dev/demo');
    expect(s.cliVersion).toBe('2.1.293');
    expect(s.entrypoint).toBe('cli');
    expect(s.gitBranch).toBe('main');
    expect(s.bytesRead).toBeGreaterThan(0);
    expect(s.startedAt <= s.endedAt).toBe(true);
  });

  it('two human prompts become two runs', () => {
    expect(s.runs).toHaveLength(2);
    expect(r1!.trigger).toBe('human');
    expect(r1!.taskText).toBe('Add a changelog entry and run the tests');
    expect(r2!.taskText).toContain('<command-name>/review</command-name>');
    expect(r2!.trigger).toBe('human');
    expect(r1!.steps.map((x) => x.seq)).toEqual(r1!.steps.map((_, i) => i));
    expect(r2!.steps[0]!.seq).toBe(0);
  });

  it('meta lines and task notifications are not prompts', () => {
    expect(r1!.steps.filter((x) => x.kind === 'user_message')).toHaveLength(1);
  });

  it('a message split across 3 lines counts its usage once', () => {
    const msgSteps = r1!.steps.filter((x) => x.apiMessageId === 'msg_basic_A');
    expect(msgSteps.map((x) => x.kind)).toEqual(['thinking', 'assistant_message', 'tool_call']);
    expect(msgSteps.filter((x) => x.tokens)).toHaveLength(1);
    expect(msgSteps[0]!.tokens).toEqual({
      input: 3,
      output: 120,
      cacheRead: 1000,
      cacheWrite5m: 0,
      cacheWrite1h: 500,
      thinking: 40,
    });
    expect(msgSteps[0]!.contextTokens).toBe(1503);
    expect(msgSteps[0]!.preview).toBe('[thinking: 40 chars]');
    // A + B (no breakdown → 5m) + C + D
    expect(r1!.tokens).toEqual({
      input: 9,
      output: 190,
      cacheRead: 6000,
      cacheWrite5m: 350,
      cacheWrite1h: 500,
      thinking: 40,
    });
    expect(r1!.peakContextTokens).toBe(1852);
  });

  it('run aggregates', () => {
    expect(r1!.toolCallCount).toBe(3);
    expect(r1!.errorCount).toBe(1);
    expect(r1!.compactionCount).toBe(0);
    expect(r1!.finalStopReason).toBe('end_turn');
    expect(r1!.models).toEqual(['claude-opus-5-5']);
    expect(r1!.stepCount).toBe(r1!.steps.length);
    expect(r1!.interrupted).toBe(false);
    expect(r2!.models).toEqual(['claude-sonnet-5-5']);
    expect(r1!.steps.some((x) => x.kind === 'hook')).toBe(true);
  });

  it('tool error, Bash command, MCP and Skill categories', () => {
    const call = r1!.steps.find((x) => x.tool?.name === 'Bash' && x.kind === 'tool_call')!;
    expect(call.raw.command).toBe('npm test');
    expect(call.tool!.category).toBe('builtin');
    const res = r1!.steps.find((x) => x.raw.answersCallId === 'toolu_bash1')!;
    expect(res.kind).toBe('tool_result');
    expect(res.tool).toMatchObject({ name: 'Bash', category: 'builtin', isError: true });
    expect(res.error?.kind).toBe('tool');
    expect(res.raw.command).toBe('npm test');
    expect(res.preview).toContain('1 test failed');

    const mcp = r1!.steps.find((x) => x.tool?.callId === 'toolu_mcp1' && x.kind === 'tool_call')!;
    expect(mcp.tool).toMatchObject({ category: 'mcp', mcpServer: 'github' });
    const mcpRes = r1!.steps.find((x) => x.raw.answersCallId === 'toolu_mcp1')!;
    expect(mcpRes.tool).toMatchObject({ category: 'mcp', mcpServer: 'github', isError: false });
    expect(mcpRes.preview).toBe('Issue #12 created');

    const skill = r1!.steps.find((x) => x.tool?.callId === 'toolu_skill1')!;
    expect(skill.tool).toMatchObject({ category: 'skill', skillName: 'changelog-writer' });
  });

  it('step ids follow the contract', () => {
    const first = r1!.steps[0]!;
    expect(first.kind).toBe('user_message');
    expect(r1!.id).toBe(stableId('run', sid(1), 'm-0001-0000-4000-8000-000000000000'));
    const ids = s.runs.flatMap((r) => r.steps.map((x) => x.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('observed harness from attachments, snapshotted per run', () => {
    expect(r1!.observed).toMatchObject({
      model: 'claude-opus-5-5',
      effort: 'high',
      permissionMode: 'default',
      entrypoint: 'cli',
      cliVersion: '2.1.293',
      tools: ['WebFetch', 'mcp__github__create_issue'],
      skills: ['changelog-writer', 'docs:pdf'],
      subagentTypes: ['Explore', 'general-purpose'],
      mcpServers: ['github'],
    });
    expect(r2!.observed.tools).toEqual(['mcp__github__create_issue', 'mcp__linear__list_issues']);
    expect(r2!.observed.mcpServers).toEqual(['github', 'linear']);
    expect(r2!.observed.model).toBe('claude-sonnet-5-5');
  });

  it('tolerates malformed and unknown lines, with census', () => {
    expect(s.warnings.some((w) => w.includes('malformed'))).toBe(true);
    expect(s.warnings.some((w) => w.includes('mystery-record'))).toBe(true);
    expect(s.census.unknownFields['line.type=mystery-record (unknown)']).toBe(1);
    expect(s.census.unknownFields['malformed JSON line']).toBe(1);
    expect(s.census.recordTypes['line.type=assistant']).toBe(7);
    expect(s.census.recordTypes['attachment.type=skill_listing']).toBe(1);
    expect(s.census.recordTypes['block.type=tool_use']).toBe(3);
    expect(s.census.recordTypes['system.subtype=stop_hook_summary']).toBe(1);
    expect(s.census.versions['2.1.293']).toBeGreaterThan(0);
  });
});

describe('parseSession: run id', async () => {
  it('main run id is derived from the prompt line uuid', async () => {
    const s = await parse(7);
    const promptUuid = 'm-0001-0000-4000-8000-000000000000';
    expect(s.runs[0]!.id).toBe(stableId('run', sid(7), promptUuid));
    expect(s.runs[0]!.steps[0]!.id).toBe(stableId('stp', sid(7), 'main', promptUuid, 0));
  });
});

describe('parseSession: sensitive paths and interrupt', async () => {
  const s = await parse(2);
  const r = s.runs[0]!;

  it('withholds tool results for sensitive paths and drops written content', () => {
    const readRes = r.steps.find((x) => x.raw.answersCallId === 'toolu_read1')!;
    expect(readRes.preview).toBe('[content withheld: sensitive path]');
    expect(readRes.raw.filePath).toBe('/home/dev/demo/.env');
    const write = r.steps.find((x) => x.tool?.callId === 'toolu_write1' && x.kind === 'tool_call')!;
    expect(write.preview).not.toContain('not-a-real-value');
    expect(write.preview).toContain('config/secrets.yaml');
    const writeRes = r.steps.find((x) => x.raw.answersCallId === 'toolu_write1')!;
    expect(writeRes.preview).toBe('[content withheld: sensitive path]');
    const all = JSON.stringify(s);
    expect(all).not.toContain('placeholder-value-not-secret');
    expect(all).not.toContain('not-a-real-value');
  });

  it('keeps content for non-sensitive edits', () => {
    const edit = r.steps.find((x) => x.tool?.callId === 'toolu_edit1' && x.kind === 'tool_call')!;
    expect(edit.preview).toContain('const a = 2');
  });

  it('marks the run interrupted', () => {
    expect(r.interrupted).toBe(true);
    const last = r.steps.at(-1)!;
    expect(last.kind).toBe('error');
    expect(last.error?.kind).toBe('interrupt');
    expect(r.errorCount).toBe(1);
  });
});

describe('parseSession: compaction and API error', async () => {
  const s = await parse(3);

  it('compact boundary becomes a compaction step; summary is not a prompt', () => {
    expect(s.runs).toHaveLength(1);
    const r = s.runs[0]!;
    expect(r.compactionCount).toBe(1);
    const c = r.steps.find((x) => x.kind === 'compaction')!;
    expect(c.compaction).toEqual({ trigger: 'auto', preTokens: 180000 });
    expect(r.steps.filter((x) => x.kind === 'user_message')).toHaveLength(1);
  });

  it('api error message becomes an error step; synthetic model ignored', () => {
    const r = s.runs[0]!;
    const e = r.steps.find((x) => x.error?.kind === 'api')!;
    expect(e.kind).toBe('error');
    expect(e.preview).toContain('529');
    expect(r.models).toEqual(['claude-opus-5-5']);
    expect(r.errorCount).toBe(1);
    expect(r.peakContextTokens).toBe(180002);
    expect(r.finalStopReason).toBe('end_turn');
  });
});

describe('parseSession: subagent file + meta', async () => {
  const s = await parse(4);
  const main = s.runs[0]!;
  const sub = s.runs[1]!;

  it('creates a linked subagent run', () => {
    expect(s.runs).toHaveLength(2);
    expect(sub.kind).toBe('subagent');
    expect(sub.trigger).toBe('subagent');
    expect(sub.agentName).toBe('Explore');
    expect(sub.id).toBe(stableId('run', sid(4), 'agent', 'a1b2c3d4e5f60718'));
    expect(sub.taskText).toBe('Find all TODO comments');
    const spawn = main.steps.find((x) => x.kind === 'subagent_spawn')!;
    expect(spawn.tool).toMatchObject({ name: 'Agent', category: 'subagent' });
    expect(spawn.raw.subagentType).toBe('Explore');
    expect(spawn.raw.subagentPrompt).toBe('Find all TODO comments');
    expect(spawn.childRunId).toBe(sub.id);
    expect(sub.parentStepId).toBe(spawn.id);
    expect(sub.parentRunId).toBe(main.id);
    const ret = main.steps.find((x) => x.raw.answersCallId === 'toolu_agent1')!;
    expect(ret.tool?.category).toBe('subagent');
    expect(ret.raw.subagentType).toBe('Explore');
  });

  it('subagent steps, tokens and harness', () => {
    expect(sub.steps[0]!.id).toBe(
      stableId('stp', sid(4), 'a1b2c3d4e5f60718', 'a1b2-0001-0000-4000-8000-000000000000', 0),
    );
    expect(sub.toolCallCount).toBe(1);
    expect(sub.tokens.output).toBe(12);
    expect(sub.models).toEqual(['claude-haiku-5-5']);
    expect(sub.observed.skills).toEqual(['changelog-writer']);
    expect(sub.finalStopReason).toBeUndefined();
    expect(s.bytesRead).toBeGreaterThan(0);
  });
});

describe('parseSession: inline sidechain (older format)', async () => {
  const s = await parse(5);

  it('groups sidechain lines into subagent runs and links them', () => {
    expect(s.runs.map((r) => r.kind)).toEqual(['main', 'subagent', 'subagent']);
    const main = s.runs[0]!;
    const [a, b] = [s.runs[1]!, s.runs[2]!];
    expect(main.steps.filter((x) => x.kind === 'user_message')).toHaveLength(1);
    const spawns = main.steps.filter((x) => x.kind === 'subagent_spawn');
    expect(spawns).toHaveLength(2);
    // no agentId: linked by prompt text
    expect(a.agentName).toBe('general-purpose');
    expect(a.parentStepId).toBe(spawns[0]!.id);
    expect(spawns[0]!.childRunId).toBe(a.id);
    // agentId reported in toolUseResult
    expect(b.agentName).toBe('doc-reviewer');
    expect(b.id).toBe(stableId('run', sid(5), 'agent', 'side2'));
    expect(spawns[1]!.childRunId).toBe(b.id);
    expect(b.parentRunId).toBe(main.id);
    expect(a.tokens.cacheWrite5m).toBe(300);
    expect(main.finalStopReason).toBe('end_turn');
    expect(s.warnings).toEqual([]);
  });
});

describe('parseSession: headless and automated sessions', () => {
  it('no human prompt → one automated run from the first user/assistant line', async () => {
    const s = await parse(6);
    expect(s.runs).toHaveLength(1);
    const r = s.runs[0]!;
    expect(r.trigger).toBe('automated');
    expect(r.taskText).toBe('');
    expect(r.toolCallCount).toBe(1);
    expect(r.tokens.output).toBe(9);
    expect(r.observed.entrypoint).toBe('sdk-cli');
  });

  it('prompt with non-human origin → automated trigger', async () => {
    const s = await parse(7);
    expect(s.runs).toHaveLength(1);
    expect(s.runs[0]!.trigger).toBe('automated');
    expect(s.runs[0]!.taskText).toBe('Nightly: triage flaky tests');
  });

  it('missing file → warning, no throw', async () => {
    const s = await parseSession(join(FIXTURES, 'does-not-exist.jsonl'));
    expect(s.runs).toEqual([]);
    expect(s.warnings.length).toBeGreaterThan(0);
  });
});
