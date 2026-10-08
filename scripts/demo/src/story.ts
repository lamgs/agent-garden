/**
 * Session scripts: turns the story (PLAN.md §6.3 signals, loops, playbook, seasons) into
 * transcript lines via TranscriptWriter.
 */
import { basename, dirname, join } from 'node:path';
import {
  BUILTIN_AGENT_TYPES,
  BUILTIN_TOOLS,
  MODEL_IDS,
  USER_AGENTS,
  USER_MCP,
  USER_SKILLS,
  type AgentDef,
  type McpDef,
  skillName,
} from './config';
import { knowledgeAttachments } from './knowledge';
import type { Era, ProjectSpec, Subject } from './projects';
import type { Rng } from './rng';
import type { DemoSecrets } from './secrets';
import { type TranscriptWriter, tokensOf } from './transcript';

export type Intent = 'success' | 'failure' | 'partial' | 'unknown';
type Kind = 'feature' | 'bugfix' | 'tests' | 'question' | 'refactor';

export interface Task {
  subject: Subject;
  kind: Kind;
  prompt: string;
}

export interface Globals {
  secrets: DemoSecrets;
  /** Local-scope MCP servers from ~/.claude.json, by project name. */
  localMcp: Record<string, McpDef[]>;
  interrupts: number;
  runs: number;
  subagentRuns: number;
  /** ~/.claude of the demo home, for the knowledge-map records (K). */
  claudeHome?: string;
}

export interface S {
  w: TranscriptWriter;
  p: ProjectSpec;
  era: Era;
  root: string;
  rng: Rng;
  g: Globals;
  /** Multiplier on file-read token counts (long sessions grow context faster). */
  readScale: number;
}

const abs = (s: S, rel: string) => join(s.root, rel);

// ---------------------------------------------------------------------------------------------
// Harness observation (session-start attachments)
// ---------------------------------------------------------------------------------------------

export function harnessListing(p: ProjectSpec, era: Era, g: Globals) {
  const servers = [...USER_MCP, ...era.mcp, ...(g.localMcp[p.name] ?? [])];
  const tools = [
    ...BUILTIN_TOOLS,
    ...servers.flatMap((m) => m.tools.map((t) => `mcp__${m.name}__${t}`)),
  ];
  const skills = [...USER_SKILLS, ...era.skills].map(skillName).sort();
  const agents = [...USER_AGENTS, ...era.agents].map((a) => a.name).sort();
  return { tools, skills, agents, servers: servers.map((m) => m.name).sort() };
}

export function startAttachments(s: S): void {
  const h = harnessListing(s.p, s.era, s.g);
  s.w.attachment({ type: 'deferred_tools_delta', addedNames: h.tools, removedNames: [] });
  s.w.attachment({
    type: 'agent_listing_delta',
    addedTypes: h.agents,
    builtInTypes: BUILTIN_AGENT_TYPES,
    isInitial: true,
  });
  s.w.attachment({ type: 'mcp_instructions_delta', addedNames: h.servers, removedNames: [] });
  s.w.attachment({
    type: 'skill_listing',
    names: h.skills,
    skillCount: h.skills.length,
    isInitial: true,
  });
  // Knowledge map (K): what was loaded at session start, plus nested loads and memory recalls.
  if (s.g.claudeHome)
    for (const a of knowledgeAttachments({
      claudeHome: s.g.claudeHome,
      root: s.root,
      project: s.p.name,
      claudeMd: s.era.claudeMd,
      sessionId: s.w.opts.sessionId,
    }))
      s.w.fixedAttachment(a);
}

/** Prompt tokens before the first message: system prompt, CLAUDE.md chain, tool definitions. */
export function baseContext(p: ProjectSpec, era: Era, g: Globals): number {
  const h = harnessListing(p, era, g);
  return (
    13_500 +
    tokensOf(era.claudeMd) +
    260 +
    h.tools.length * 420 +
    h.skills.length * 60 +
    h.agents.length * 90
  );
}

// ---------------------------------------------------------------------------------------------
// Tool helpers
// ---------------------------------------------------------------------------------------------

interface CallOpts {
  think?: string;
  text?: string;
  tokens?: number;
}

const FILLER = ['Checking that now.', 'Let me look.', 'Next step.', 'Now the file itself.'];

function call(s: S, name: string, input: Record<string, unknown>, o: CallOpts = {}) {
  const blocks: Parameters<TranscriptWriter['respond']>[0] = [];
  if (o.think) blocks.push({ type: 'thinking', text: o.think });
  if (o.text) blocks.push({ type: 'text', text: o.text });
  else if (!o.think && s.rng.chance(0.3)) blocks.push({ type: 'text', text: s.rng.pick(FILLER) });
  blocks.push({ type: 'tool_use', name, input, ...(o.tokens ? { tokens: o.tokens } : {}) });
  const r = s.w.respond(blocks, 'tool_use');
  return { uuid: r.uuid, id: r.toolUseIds[0] as string };
}

function bashResult(out: string) {
  return { stdout: out, stderr: '', interrupted: false, isImage: false, noOutputExpected: false };
}

export function bash(
  s: S,
  command: string,
  description: string,
  out: string,
  ok: boolean,
  durationMs: number,
  o: CallOpts = {},
): void {
  const c = call(s, 'Bash', { command, description }, o);
  if (ok) s.w.result(c.id, c.uuid, out, false, bashResult(out), durationMs);
  else
    s.w.result(c.id, c.uuid, `Exit code 1\n${out}`, true, `Error: Exit code 1\n${out}`, durationMs);
}

function snippet(s: S, rel: string): string {
  const src = s.p.sourceFiles[rel];
  const lines = src
    ? src.split('\n').slice(0, 12)
    : [
        `// ${basename(rel)}`,
        `// ${s.p.name}: ${dirname(rel)}`,
        '',
        `export function handle(input) {`,
        `  if (!input) return null;`,
        `  // ...`,
        `}`,
      ];
  return lines.map((l, i) => `${String(i + 1).padStart(6, ' ')}\t${l}`).join('\n');
}

export function read(s: S, rel: string, o: CallOpts = {}): void {
  const c = call(s, 'Read', { file_path: abs(s, rel) }, o);
  const content = snippet(s, rel);
  const totalLines = s.rng.int(40, 420);
  s.w.result(
    c.id,
    c.uuid,
    content,
    false,
    {
      type: 'text',
      file: {
        filePath: abs(s, rel),
        content: content.slice(0, 200),
        numLines: totalLines,
        startLine: 1,
        totalLines,
      },
    },
    s.rng.int(20, 200),
    Math.round(s.rng.int(500, 4000) * s.readScale),
  );
}

function grep(s: S, pattern: string, files: string[], o: CallOpts = {}): void {
  const c = call(s, 'Grep', { pattern, output_mode: 'files_with_matches' }, o);
  const out = files.length ? `Found ${files.length} files\n${files.join('\n')}` : 'No files found';
  s.w.result(
    c.id,
    c.uuid,
    out,
    false,
    { mode: 'files_with_matches', filenames: files, numFiles: files.length },
    s.rng.int(30, 400),
  );
}

function glob(s: S, pattern: string, files: string[], o: CallOpts = {}): void {
  const c = call(s, 'Glob', { pattern }, o);
  const out = files.join('\n') || 'No files found';
  s.w.result(
    c.id,
    c.uuid,
    out,
    false,
    {
      filenames: files.map((f) => abs(s, f)),
      durationMs: s.rng.int(5, 80),
      numFiles: files.length,
      truncated: false,
    },
    s.rng.int(10, 120),
  );
}

const EDITS: [string, string][] = [
  ['return null;', 'return [];'],
  ['if (!input) return null;', "if (!input) throw new ValidationError('input required');"],
  ['total += line.amount', 'total += Math.round(line.amount)'],
  ['const limit = 50;', 'const limit = Math.min(Number(query.limit ?? 50), 200);'],
  ['logger.debug(', 'logger.info('],
  ['expiresAt < now', 'expiresAt <= now'],
];

export function edit(s: S, rel: string, ok = true, o: CallOpts = {}): void {
  const [oldString, newString] = s.rng.pick(EDITS);
  const c = call(
    s,
    'Edit',
    { file_path: abs(s, rel), old_string: oldString, new_string: newString, replace_all: false },
    o,
  );
  if (ok) {
    s.w.result(
      c.id,
      c.uuid,
      `The file ${abs(s, rel)} has been updated successfully.`,
      false,
      {
        filePath: abs(s, rel),
        oldString,
        newString,
        structuredPatch: [],
        userModified: false,
        replaceAll: false,
      },
      s.rng.int(20, 150),
    );
  } else {
    const msg = `String to replace not found in file.\nString: ${oldString}`;
    s.w.result(
      c.id,
      c.uuid,
      `<tool_use_error>${msg}</tool_use_error>`,
      true,
      `Error: ${msg}`,
      s.rng.int(10, 60),
    );
  }
}

function testContent(s: S, subj: Subject): string {
  const n = subj.name;
  switch (s.p.lang) {
    case 'ts':
      return `import { describe, expect, it } from 'vitest';\nimport * as mod from './${basename(subj.file).replace(/\.tsx?$/, '')}';\n\ndescribe('${n}', () => {\n  it('handles the empty case', () => {\n    expect(mod).toBeDefined();\n  });\n\n  it('rejects invalid input with a 422', async () => {\n    // arrange, act, assert\n  });\n});\n`;
    case 'js':
      return `'use strict';\nconst mod = require('../../${subj.file}');\n\ndescribe('${n}', function () {\n  it('handles an empty invoice', function () {\n    expect(mod).toBeDefined();\n  });\n});\n`;
    case 'py':
      return `from ${subj.file.replace(/\.py$/, '').replace(/\//g, '.')} import *  # noqa: F403\n\n\ndef test_handles_late_events():\n    assert True\n`;
    case 'go':
      return `package ${basename(dirname(subj.file))}\n\nimport "testing"\n\nfunc TestEdgeCases(t *testing.T) {\n\tt.Parallel()\n}\n`;
    default:
      return `# ${n}\n`;
  }
}

function writeFile(s: S, rel: string, content: string, o: CallOpts = {}): void {
  const c = call(
    s,
    'Write',
    { file_path: abs(s, rel), content },
    { ...o, tokens: tokensOf(content) + 40 },
  );
  s.w.result(
    c.id,
    c.uuid,
    `File created successfully at: ${abs(s, rel)}`,
    false,
    {
      type: 'create',
      filePath: abs(s, rel),
      content,
      structuredPatch: [],
    },
    s.rng.int(20, 120),
  );
}

export function test(s: S, rel: string | undefined, pass: boolean, o: CallOpts = {}): void {
  const t = s.p.test;
  if (!t) {
    bash(
      s,
      'npm run build',
      'Build the docs site',
      `astro build\n[build] ${s.rng.int(20, 60)} page(s) built in ${s.rng.int(3, 9)}.${s.rng.int(10, 99)}s\n[build] Complete!`,
      true,
      s.rng.int(8000, 20000),
      o,
    );
    return;
  }
  const file = rel ?? '';
  const out = pass
    ? t.pass(file || 'all', s.rng)
    : t.fail(file || 'src/payments/refunds.test.ts', s.rng);
  bash(
    s,
    t.cmd(rel),
    rel ? `Run ${basename(rel)}` : 'Run the test suite',
    out,
    pass,
    s.rng.int(4000, 40000),
    o,
  );
}

function skill(s: S, name: string, o: CallOpts = {}): void {
  const c = call(s, 'Skill', { skill: name }, o);
  s.w.result(
    c.id,
    c.uuid,
    `Launching skill: ${name}`,
    false,
    { success: true, commandName: name },
    s.rng.int(20, 80),
    400,
  );
}

function mcpCall(
  s: S,
  server: string,
  tool: string,
  input: Record<string, unknown>,
  ok: boolean,
  out: string,
  o: CallOpts = {},
): void {
  const c = call(s, `mcp__${server}__${tool}`, input, o);
  if (ok)
    s.w.result(
      c.id,
      c.uuid,
      [{ type: 'text', text: out }],
      false,
      [{ type: 'text', text: out }],
      s.rng.int(300, 3000),
    );
  else
    s.w.result(
      c.id,
      c.uuid,
      `MCP error -32001: Request timed out`,
      true,
      'Error: MCP error -32001: Request timed out',
      s.rng.int(30000, 60000),
    );
}

export function final(s: S, text: string, think?: string): void {
  const blocks: Parameters<TranscriptWriter['respond']>[0] = [];
  if (think) blocks.push({ type: 'thinking', text: think });
  blocks.push({ type: 'text', text });
  s.w.respond(blocks, 'end_turn');
}

// ---------------------------------------------------------------------------------------------
// Subagents
// ---------------------------------------------------------------------------------------------

function agentDef(s: S, type: string): AgentDef | undefined {
  return [...USER_AGENTS, ...s.era.agents].find((a) => a.name === type);
}

function subagentModel(s: S, type: string): string {
  if (type === 'Explore') return MODEL_IDS.haiku;
  const def = agentDef(s, type);
  if (!def || def.model === 'inherit') return s.w.model;
  return MODEL_IDS[def.model];
}

/** Spawn a subagent via the Agent tool; `script` fills its transcript and returns its final text. */
export function spawn(
  s: S,
  type: string,
  description: string,
  prompt: string,
  script: (c: S) => string,
  o: CallOpts = {},
): string {
  const c = call(
    s,
    'Agent',
    { description, prompt, subagent_type: type, run_in_background: false },
    o,
  );
  const t0 = s.w.t;
  const model = subagentModel(s, type);
  const childBase = 6_000 + tokensOf(s.era.claudeMd) + 2_400 + (type === 'Explore' ? 0 : 1_200);
  const child = s.w.child(type, model, childBase);
  child.subagentPrompt(prompt);
  const cs: S = { ...s, w: child };
  const text = script(cs);
  s.w.addSubagent(child, description, c.id);
  s.g.subagentRuns++;
  s.w.result(
    c.id,
    c.uuid,
    [{ type: 'text', text }],
    false,
    {
      agentId: child.opts.agentId,
      status: 'completed',
      isAsync: false,
      description,
      prompt,
      resolvedModel: model,
      totalDurationMs: child.t - t0,
      canContinueAgent: true,
      canReadOutputFile: false,
    },
    s.rng.int(200, 900),
  );
  return text;
}

const testerSummary = (subj: Subject, n: number) =>
  `Added ${n} tests in ${subj.testFile}, all passing:\n- handles the empty case\n- rejects invalid input\n- keeps existing behaviour for the happy path`;

function testWriterScript(subj: Subject, pass: boolean) {
  return (c: S): string => {
    read(c, subj.file, {
      think: `I need to understand the ${subj.name} before writing tests.`,
      text: `I'll read ${subj.file} first.`,
    });
    glob(
      c,
      `${dirname(subj.testFile)}/**/*${c.p.lang === 'py' ? '.py' : c.p.lang === 'go' ? '_test.go' : '.test.*'}`,
      [subj.testFile],
    );
    if (c.p.lang === 'js') read(c, 'test/helpers/fixtures.js');
    writeFile(c, subj.testFile, testContent(c, subj), {
      text: `Writing tests for the ${subj.name}.`,
    });
    if (pass) {
      if (c.rng.chance(0.3)) {
        test(c, subj.testFile, false);
        edit(c, subj.testFile, true, { think: 'The fixture is missing a required field.' });
      }
      test(c, subj.testFile, true);
      const n = c.rng.int(3, 9);
      final(c, testerSummary(subj, n));
      return testerSummary(subj, n);
    }
    test(c, subj.testFile, false);
    edit(c, subj.testFile, true, { think: 'Maybe the setup is wrong. Let me adjust the fixture.' });
    if (c.rng.chance(0.5)) {
      bash(
        c,
        'npm run db:seed',
        'Seed the local database',
        'Error: connect ECONNREFUSED 127.0.0.1:3306\n    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1611:16)',
        false,
        c.rng.int(2000, 8000),
      );
    } else {
      edit(c, subj.file, false, { think: 'The module itself may need a guard.' });
    }
    test(c, subj.testFile, false);
    const text = `I added tests in ${subj.testFile}, but 2 of them still fail. The failures look related to shared global state in the ${subj.name} (the module reads config at require time), so I could not isolate it without changing production code.`;
    final(c, text);
    return text;
  };
}

function exploreScript(subj: Subject) {
  return (c: S): string => {
    glob(c, `${dirname(subj.file)}/**/*`, [subj.file, subj.testFile].filter(Boolean));
    grep(c, basename(subj.file).split('.')[0] as string, [subj.file]);
    read(c, subj.file);
    const text = `The ${subj.name} lives in ${subj.file}. It is called from the route handlers and from one background job. The main entry point validates input, then delegates to a pure helper that is easy to test.`;
    final(c, text);
    return text;
  };
}

function reviewerScript(subj: Subject) {
  return (c: S): string => {
    bash(
      c,
      'git diff --stat && git diff',
      'Show the working-tree diff',
      ` ${subj.file} | 12 ++++++++----\n 1 file changed, 8 insertions(+), 4 deletions(-)`,
      true,
      c.rng.int(100, 600),
    );
    read(c, subj.file);
    const text = `Review of ${subj.file}:\n1. The new branch does not handle a missing tenant id. Add a guard and a test.\n2. Minor: the error message is not from the translations file.\nOtherwise looks good.`;
    final(c, text);
    return text;
  };
}

function planScript(subj: Subject) {
  return (c: S): string => {
    read(c, subj.file);
    grep(c, 'TODO', [subj.file]);
    const text = `Plan:\n1. Extract the ${subj.name} logic into a pure function.\n2. Add tests for the current behaviour.\n3. Change the behaviour behind a flag.\n4. Remove the old path after one release.`;
    final(c, text);
    return text;
  };
}

function archaeologistScript(subj: Subject) {
  return (c: S): string => {
    bash(
      c,
      `git log --follow --oneline -- ${subj.file} | tail -5`,
      'History of the file',
      `9a1c2e4 BILL-1182 hotfix rounding\n41bd007 move to lib/\n0c3f9aa initial import from svn`,
      true,
      c.rng.int(200, 900),
    );
    mcpCall(
      c,
      'confluence',
      'search_pages',
      { query: subj.name },
      true,
      `2 pages: "Billing rules (2019)", "Why invoices round twice"`,
    );
    read(c, subj.file);
    const text = `The odd behaviour in ${subj.file} dates from an SVN import in 2017. "Why invoices round twice" explains that downstream reports expect the double rounding, so changing it needs the reports team.`;
    final(c, text);
    return text;
  };
}

function plannerScript() {
  return (c: S): string => {
    bash(
      c,
      'terraform -chdir=envs/staging plan -no-color | tail -15',
      'Plan staging',
      `  # aws_s3_bucket_lifecycle_configuration.logs will be updated in-place\n\nPlan: 0 to add, 2 to change, 0 to destroy.`,
      true,
      c.rng.int(20000, 60000),
    );
    const text =
      'Staging plan: 0 to add, 2 to change, 0 to destroy. Both changes are lifecycle rules on the logs bucket. Nothing stateful is replaced.';
    final(c, text);
    return text;
  };
}

function docsWriterScript(subj: Subject, useSkill: boolean) {
  return (c: S): string => {
    if (useSkill) skill(c, 'api-docs', { text: 'Using the api-docs skill.' });
    read(c, subj.file);
    const page = subj.file.endsWith('.md')
      ? subj.file
      : `docs/${basename(subj.file).replace(/\.\w+$/, '')}.md`;
    edit(c, page);
    const text = `Updated ${page} with a curl example and a response example.`;
    final(c, text);
    return text;
  };
}

function migrationScript(subj: Subject) {
  return (c: S): string => {
    skill(c, 'db-migrate', { text: 'Using the db-migrate skill.' });
    bash(
      c,
      'uv run alembic revision -m "add late_events partition"',
      'Create a migration',
      'Generating migrations/versions/7f3a_add_late_events_partition.py ...  done',
      true,
      c.rng.int(800, 3000),
    );
    edit(c, 'migrations/versions/7f3a_add_late_events_partition.py');
    bash(
      c,
      'uv run alembic upgrade head',
      'Apply migrations',
      'INFO  [alembic.runtime.migration] Running upgrade 6e21 -> 7f3a, add late_events partition',
      true,
      c.rng.int(1500, 5000),
    );
    const pass = c.rng.chance(0.8);
    test(c, subj.testFile, pass);
    const text = pass
      ? 'Migration 7f3a adds the late_events partition with a down migration. Applied locally; tests pass.'
      : 'Migration 7f3a is written and applies locally, but tests/test_sessions.py fails on the new column.';
    final(c, text);
    return text;
  };
}

function releaseManagerScript() {
  return (c: S): string => {
    const v = `v0.${c.rng.int(5, 9)}.0`;
    bash(
      c,
      'pnpm version minor --no-git-tag-version',
      'Bump version',
      v,
      true,
      c.rng.int(500, 2000),
    );
    edit(c, 'CHANGELOG.md');
    bash(
      c,
      `git tag -a ${v} -m "${v}" && git push origin ${v}`,
      'Tag and push',
      `To github.com:acme/web-dashboard.git\n * [new tag]         ${v} -> ${v}`,
      true,
      c.rng.int(800, 3000),
    );
    const text = `Released ${v}: version bumped, changelog updated, tag pushed.`;
    final(c, text);
    return text;
  };
}

function genericScript(subj: Subject) {
  return (c: S): string => {
    grep(c, subj.name.split(' ')[0] as string, [subj.file]);
    read(c, subj.file);
    const text = `Found it: the ${subj.name} reads its settings from ${subj.file} and the environment. No other callers.`;
    final(c, text);
    return text;
  };
}

function spawnByType(s: S, type: string, subj: Subject): void {
  const prompts: Record<string, [string, string, (c: S) => string]> = {
    Explore: [
      `Explore ${subj.name}`,
      `Find where the ${subj.name} is implemented and who calls it. Report file paths and a short summary.`,
      exploreScript(subj),
    ],
    'code-reviewer': [
      `Review ${subj.name} diff`,
      `Review the current diff touching ${subj.file}. Focus on correctness and missing tests.`,
      reviewerScript(subj),
    ],
    Plan: [
      `Plan ${subj.name} change`,
      `Plan how to change the ${subj.name} safely. List steps.`,
      planScript(subj),
    ],
    'legacy-archaeologist': [
      `History of ${subj.name}`,
      `Why does ${subj.file} behave this way? Check git history and Confluence.`,
      archaeologistScript(subj),
    ],
    'terraform-planner': [
      'Plan staging',
      'Run terraform plan for staging and summarize the changes and risks.',
      plannerScript(),
    ],
    'docs-writer': [
      `Docs for ${subj.name}`,
      `Update the documentation for the ${subj.name} to match the current behaviour.`,
      docsWriterScript(
        subj,
        s.era.skills.some((k) => k.dir === 'api-docs'),
      ),
    ],
    'migration-helper': [
      `Migration for ${subj.name}`,
      `Write a migration that adds a late_events partition used by the ${subj.name}. Include the down migration.`,
      migrationScript(subj),
    ],
    'release-manager': [
      'Release dashboard',
      'Cut a minor release of the dashboard.',
      releaseManagerScript(),
    ],
    'general-purpose': [
      `Investigate ${subj.name}`,
      `Find how the ${subj.name} is configured in this repo.`,
      genericScript(subj),
    ],
  };
  const spec = prompts[type];
  if (!spec) return;
  spawn(s, type, spec[0], spec[1], spec[2], { text: `I'll use the ${type} agent for this.` });
}

/** test-writer spawn, plus a re-spawn with a near-identical prompt when it failed (parent_respawned). */
function spawnTestWriter(s: S, subj: Subject): boolean {
  const tw = s.p.testWriter ?? { success: 0.7, respawn: 0.2 };
  const prompt = `Write unit tests for the ${subj.name} in ${subj.file}. Cover the edge cases and run them until they pass.`;
  let pass = s.rng.chance(tw.success);
  spawn(s, 'test-writer', `Tests for ${subj.name}`, prompt, testWriterScript(subj, pass), {
    think: 'This is test coverage work; delegating to test-writer.',
    text: 'Delegating the tests to the test-writer agent.',
  });
  if (!pass && s.rng.chance(tw.respawn)) {
    pass = s.rng.chance(tw.success);
    spawn(
      s,
      'test-writer',
      `Tests for ${subj.name} (retry)`,
      `${prompt} The previous attempt left failing tests.`,
      testWriterScript(subj, pass),
      { text: 'The tests are still failing. Let me try the test-writer again.' },
    );
  }
  return pass;
}

// ---------------------------------------------------------------------------------------------
// Tasks and prompts
// ---------------------------------------------------------------------------------------------

const TEMPLATES: Record<Kind, ((n: string) => string)[]> = {
  feature: [
    (n) => `Add input validation to the ${n} and return a 422 with field errors`,
    (n) => `Add structured logging to the ${n}`,
    (n) => `Support pagination in the ${n}`,
    (n) => `Put the new ${n} behaviour behind a feature flag`,
  ],
  bugfix: [
    (n) => `Fix the bug in the ${n}: it throws on an empty list`,
    (n) => `The ${n} double-counts items when the same SKU appears twice, fix it`,
    (n) => `Fix the off-by-one-day timezone issue in the ${n}`,
    (n) => `The ${n} returns null instead of an empty array, fix it`,
  ],
  tests: [
    (n) => `Add tests for the ${n}, cover the edge cases`,
    (n) => `Write unit tests for the ${n}`,
    (n) => `We have no tests for the ${n} error paths, add some`,
  ],
  question: [
    (n) => `Why is the ${n} slow on large inputs?`,
    (n) => `Explain how the ${n} works`,
    (n) => `Where is the ${n} configured?`,
  ],
  refactor: [
    (n) => `Refactor the ${n} to remove the duplicated branching`,
    (n) => `Split the ${n} into smaller functions`,
  ],
};

const DOC_TEMPLATES: ((n: string) => string)[] = [
  (n) => `Update the ${n} for the new pagination params`,
  (n) => `Add a curl example to the ${n}`,
  (n) => `Fix the broken links in the ${n}`,
  (n) => `Rewrite the intro of the ${n}, it is too long`,
];

export function newTask(s: S): Task {
  const subject = s.rng.pick(s.p.subjects);
  if (s.p.lang === 'docs') {
    const kind: Kind = s.rng.chance(0.15) ? 'question' : 'feature';
    const prompt =
      kind === 'question'
        ? `Is the ${subject.name} still accurate?`
        : s.rng.pick(DOC_TEMPLATES)(subject.name);
    return { subject, kind, prompt };
  }
  const testsWeight = s.p.testWriter ? 0.34 : 0.15;
  const kind = s.rng.weighted<Kind>([
    ['feature', 0.24],
    ['bugfix', 0.24],
    ['tests', testsWeight],
    ['question', 0.1],
    ['refactor', 0.08],
  ]);
  return { subject, kind, prompt: s.rng.pick(TEMPLATES[kind])(subject.name) };
}

export const CORRECTIONS = [
  "that's still failing",
  'no, revert that and try again',
  'still broken, same error as before',
  "that's not what I asked, try again",
];

// ---------------------------------------------------------------------------------------------
// Main-thread runs
// ---------------------------------------------------------------------------------------------

const THINK = [
  (n: string) => `Let me look at how the ${n} is structured before changing anything.`,
  (n: string) => `The ${n} probably has a guard missing. I'll search for the entry point.`,
  (n: string) => `I should find the call sites of the ${n} first.`,
];

/** One main-thread work run. `failVariant` picks how a failure intent shows up. */
export function workRun(s: S, task: Task, intent: Intent): 'interrupted' | 'done' {
  const { subject, kind } = task;
  const rng = s.rng;
  const think = rng.pick(THINK)(subject.name);

  if (s.p.name === 'legacy-monolith' && rng.chance(0.3)) {
    const key = `BILL-${rng.int(1800, 2600)}`;
    const ok = !rng.chance(0.15);
    mcpCall(
      s,
      'jira',
      'get_issue',
      { issue_key: key },
      ok,
      `${key}: ${task.prompt} (reported by support)`,
      { think, text: `Checking ${key} first.` },
    );
    if (!ok) mcpCall(s, 'jira', 'get_issue', { issue_key: key }, true, `${key}: ${task.prompt}`);
  } else {
    grep(
      s,
      subject.name.split(' ')[0] as string,
      [subject.file, subject.testFile].filter(Boolean),
      { think, text: `I'll find the ${subject.name} code.` },
    );
  }

  // Exploratory subagents before the change.
  for (const [type, p] of s.p.subagents) {
    if (
      ['Explore', 'Plan', 'legacy-archaeologist', 'general-purpose', 'terraform-planner'].includes(
        type,
      ) &&
      rng.chance(p)
    ) {
      spawnByType(s, type, subject);
      break;
    }
  }

  read(s, subject.file);

  if (kind === 'question') {
    if (intent === 'unknown') return 'done';
    if (rng.chance(0.5)) read(s, subject.testFile || subject.file);
    final(
      s,
      `The ${subject.name} is implemented in ${subject.file}. ${task.prompt.startsWith('Why') ? 'Most of the time goes into an N+1 query inside the loop; batching the lookups would fix it.' : 'It validates the input, applies the rules in order, and returns a typed result. Configuration comes from environment variables loaded at startup.'}`,
    );
    return 'done';
  }

  // Interrupt: the user stops the agent going to the wrong place (capped at a few in the dataset).
  if (intent === 'failure' && s.g.interrupts < 3 && rng.chance(0.06)) {
    s.g.interrupts++;
    if (s.g.interrupts === 2) {
      // Stopped mid-response: the partial message has no stop_reason.
      s.w.respond(
        [
          {
            type: 'thinking',
            text: `The ${subject.name} module is tangled. Restructuring it first would make the change easier.`,
          },
          {
            type: 'text',
            text: `I'll restructure the whole ${subject.name} module first so the change is easier. Starting by moving`,
          },
        ],
        null,
      );
      s.w.interrupt('[Request interrupted by user]');
    } else {
      const wrong = subject.file.replace(
        /\/[^/]+$/,
        '/index' + subject.file.slice(subject.file.lastIndexOf('.')),
      );
      const c = call(
        s,
        'Edit',
        {
          file_path: abs(s, wrong),
          old_string: 'export',
          new_string: 'export default',
          replace_all: false,
        },
        { text: 'Updating the module entry point.' },
      );
      s.w.result(
        c.id,
        c.uuid,
        "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
        true,
        'User rejected tool use',
        rng.int(3000, 20000),
      );
      s.w.interrupt('[Request interrupted by user for tool use]');
    }
    return 'interrupted';
  }

  if (rng.chance(0.08)) {
    edit(s, subject.file, false);
    read(s, subject.file, { text: 'The file changed since I read it. Re-reading.' });
  }
  edit(s, subject.file, true, { text: `Making the change in ${subject.file}.` });
  if (rng.chance(0.4)) edit(s, subject.file);

  let testsPass = intent === 'success';
  if (kind === 'tests' && s.p.testWriter && rng.chance(0.85)) {
    const twPass = spawnTestWriter(s, subject);
    // A failing test-writer usually drags the run down with it.
    if (!twPass && rng.chance(0.6)) testsPass = false;
  } else if (kind === 'tests' && subject.testFile) {
    writeFile(s, subject.testFile, testContent(s, subject));
  }

  for (const [type, p] of s.p.subagents) {
    if (
      ['code-reviewer', 'docs-writer', 'migration-helper', 'release-manager'].includes(type) &&
      rng.chance(p)
    ) {
      spawnByType(s, type, subject);
      break;
    }
  }

  if (intent === 'unknown') return 'done';

  if (intent === 'partial' || (intent === 'failure' && rng.chance(0.3))) {
    // No verification at all.
    final(s, `Done: updated ${subject.file}. I haven't run the tests.`);
    return 'done';
  }

  const testFile = subject.testFile || undefined;
  if (testsPass) {
    if (rng.chance(0.25)) {
      test(s, testFile, false, { text: 'Running the tests.' });
      edit(s, subject.file, true, { think: 'The assertion shows the rounding is applied twice.' });
    }
    test(s, testFile, true, { text: 'Running the tests.' });
    final(
      s,
      `Done. ${task.kind === 'bugfix' ? 'Fixed' : 'Updated'} the ${subject.name} in ${subject.file}; the tests pass.`,
    );
  } else {
    test(s, testFile, false, { text: 'Running the tests.' });
    edit(s, subject.file, true, { think: 'Still failing. Maybe the fixture is stale.' });
    test(s, testFile, false);
    final(
      s,
      `I changed ${subject.file}, but the tests still fail. The remaining failure seems to come from a fixture that assumes the old behaviour.`,
    );
  }
  return 'done';
}

const COMMIT_MSGS: Record<Kind, string> = {
  feature: 'feat',
  bugfix: 'fix',
  tests: 'test',
  question: 'docs',
  refactor: 'refactor',
};

/** "thanks, commit it" */
export function commitRun(s: S, task: Task, intent: Intent): void {
  const rng = s.rng;
  if (intent === 'failure' && s.p.test) {
    test(s, undefined, false, { text: 'Running the full suite before committing.' });
    final(
      s,
      'The full suite has a failure outside the files I touched, so I did not commit. Want me to look into it?',
    );
    return;
  }
  const scope = basename(dirname(task.subject.file));
  const msg = `${COMMIT_MSGS[task.kind]}(${scope}): ${task.prompt.toLowerCase().slice(0, 50).replace(/[",]/g, '')}`;
  const sha = rng.hex(7);
  bash(
    s,
    `git add -A && git commit -m "${msg}"`,
    'Commit the change',
    `[${s.w.opts.gitBranch} ${sha}] ${msg}\n 2 files changed, ${rng.int(4, 60)} insertions(+), ${rng.int(0, 20)} deletions(-)`,
    true,
    rng.int(400, 3000),
    { text: 'Committing.' },
  );
  if (rng.chance(0.3)) {
    const pr = rng.int(120, 620);
    bash(
      s,
      `gh pr create --fill --base main`,
      'Open a pull request',
      `https://github.com/acme/${s.p.name}/pull/${pr}`,
      true,
      rng.int(1500, 5000),
    );
    final(s, `Committed ${sha} and opened PR #${pr}.`);
  } else {
    final(s, `Committed as ${sha}.`);
  }
}

// ---------------------------------------------------------------------------------------------
// Headless loops, playbook runs, secrets
// ---------------------------------------------------------------------------------------------

export const NIGHTLY_PROMPT = "Triage flaky tests from last night's CI and open fixes";
export const BACKFILL_PROMPT = "Backfill yesterday's events partition and fix any failures";
export const SWEEP_PROMPT =
  'Dependency update sweep: bump Go modules and Terraform providers, run the tests, and open a PR';

export function nightlyRun(s: S, date: string): void {
  const rng = s.rng;
  const roll = rng.next();
  if (roll < 0.12) {
    bash(
      s,
      `gh run list --workflow ci.yml --status failure --created ">=${date}" --json databaseId,displayTitle --limit 5`,
      'List failed CI runs',
      '[]',
      true,
      rng.int(800, 2500),
      { think: 'Start by listing failed CI runs since yesterday.' },
    );
    final(s, 'No failed CI runs since yesterday. Nothing to triage.');
    return;
  }
  const subj = rng.pick(s.p.subjects);
  const id = rng.int(18_000_000, 19_000_000);
  bash(
    s,
    `gh run list --workflow ci.yml --status failure --created ">=${date}" --json databaseId,displayTitle --limit 5`,
    'List failed CI runs',
    `[{"databaseId":${id},"displayTitle":"ci: main"}]`,
    true,
    rng.int(800, 2500),
    { think: 'Start by listing failed CI runs since yesterday.' },
  );
  bash(
    s,
    `gh run view ${id} --log-failed | grep -E "FAIL|×" | head -20`,
    'Show failing tests',
    ` × ${subj.testFile} > times out waiting for the retry timer (flaky: passed on re-run)`,
    true,
    rng.int(1500, 4000),
  );
  read(s, subj.testFile);
  edit(s, subj.testFile, true, {
    think: 'The test waits on a real timer. Switching to fake timers removes the race.',
    text: 'Replacing the real timer with vi.useFakeTimers().',
  });
  const ok = roll < 0.92;
  test(s, subj.testFile, ok);
  if (!ok) {
    final(
      s,
      `I could not make ${subj.testFile} pass reliably. Leaving it quarantined and noting it on the flaky-tests issue.`,
    );
    return;
  }
  const slug = basename(subj.testFile).replace(/\.test\.ts$/, '');
  bash(
    s,
    `git checkout -b fix/flaky-${slug}-${date} && git commit -am "test: deflake ${slug}" && git push -u origin HEAD`,
    'Commit and push the fix',
    `[fix/flaky-${slug}-${date} ${rng.hex(7)}] test: deflake ${slug}\n 1 file changed, 6 insertions(+), 3 deletions(-)`,
    true,
    rng.int(2000, 6000),
  );
  const pr = rng.int(300, 700);
  bash(
    s,
    `gh pr create --title "test: deflake ${slug}" --body "Nightly flaky-test triage: replace real timers with fake timers."`,
    'Open a pull request',
    `https://github.com/acme/shop-api/pull/${pr}`,
    true,
    rng.int(1500, 4000),
  );
  final(
    s,
    `Opened PR #${pr}: deflaked ${subj.testFile} by switching to fake timers. Tests pass locally.`,
  );
}

export function backfillRun(s: S, date: string): void {
  const rng = s.rng;
  const n = rng.int(900_000, 1_400_000).toLocaleString('en-US');
  bash(
    s,
    `uv run python -m pipeline.backfill --date ${date}`,
    'Run the backfill',
    `backfilling ${date}\nloaded ${n} events (late: ${rng.int(0, 400)})`,
    true,
    rng.int(60_000, 240_000),
    { think: 'Run the backfill for yesterday.' },
  );
  mcpCall(
    s,
    'warehouse',
    'query',
    { sql: `select count(*) from events where event_date = '${date}'` },
    true,
    `count\n${n}`,
  );
  final(s, `Backfill for ${date} complete: ${n} events loaded, counts match the warehouse.`);
}

export function runawayRun(s: S, date: string): void {
  const rng = s.rng;
  const err = `Traceback (most recent call last):\n  File "pipeline/backfill.py", line 41, in main\npsycopg.OperationalError: connection to server at "warehouse.acme.internal" (10.20.3.14), port 5432 failed: FATAL:  password authentication failed for user "etl_user"\n(dsn: ${s.g.secrets.dbUrl})`;
  bash(
    s,
    `uv run python -m pipeline.backfill --date ${date}`,
    'Run the backfill',
    err,
    false,
    rng.int(3000, 9000),
    { think: 'Run the backfill for yesterday.' },
  );
  bash(
    s,
    `uv run python -m pipeline.backfill --date ${date} --retry`,
    'Retry the backfill',
    err,
    false,
    rng.int(3000, 9000),
    { think: 'Authentication failed. Maybe transient; retrying once.' },
  );
  final(
    s,
    'The backfill failed: the warehouse rejected the credentials for etl_user. I did not change any files. Someone needs to rotate the credentials.',
  );
}

export function sweepRun(s: S): void {
  const rng = s.rng;
  bash(
    s,
    'go get -u ./... && go mod tidy',
    'Upgrade Go modules',
    `go: upgraded golang.org/x/net v0.4${rng.int(0, 3)}.0 => v0.4${rng.int(4, 6)}.0\ngo: upgraded github.com/aws/aws-sdk-go-v2 v1.3${rng.int(0, 5)}.0 => v1.3${rng.int(6, 9)}.0`,
    true,
    rng.int(8000, 30000),
    { think: 'Bump Go modules first, then providers.' },
  );
  edit(s, 'envs/staging/versions.tf', true, { text: 'Bumping the AWS provider constraint.' });
  test(s, undefined, true);
  bash(
    s,
    'git checkout -b deps/weekly && git commit -am "chore(deps): weekly dependency sweep" && git push -u origin HEAD',
    'Commit and push',
    `[deps/weekly ${rng.hex(7)}] chore(deps): weekly dependency sweep`,
    true,
    rng.int(2000, 5000),
  );
  const pr = rng.int(80, 200);
  bash(
    s,
    'gh pr create --title "chore(deps): weekly dependency sweep" --body "Automated weekly sweep."',
    'Open a pull request',
    `https://github.com/acme/infra/pull/${pr}`,
    true,
    rng.int(1500, 4000),
  );
  final(s, `Opened PR #${pr} with the weekly dependency bumps. go test ./... passes.`);
}

/** Release playbook: changelog-writer -> run-tests -> tag-release. */
export function releaseRun(s: S, version: string, prev: string, pass: boolean): void {
  const rng = s.rng;
  skill(s, 'changelog-writer', {
    think: 'Follow the release playbook: changelog, tests, tag.',
    text: 'Starting with the changelog.',
  });
  bash(
    s,
    `git log ${prev}..HEAD --oneline`,
    'Commits since the last tag',
    `${rng.hex(7)} feat(cart): percentage discounts\n${rng.hex(7)} fix(coupons): expiry is exclusive\n${rng.hex(7)} test: deflake refunds`,
    true,
    rng.int(100, 500),
  );
  edit(s, 'CHANGELOG.md', true, { text: `Adding the ${version} section.` });
  skill(s, 'run-tests', { text: 'Running the suite before tagging.' });
  test(s, undefined, pass);
  if (!pass) {
    final(
      s,
      `Stopping before tagging ${version}: the suite has failures in src/payments/refunds.test.ts. The changelog entry is written but not committed.`,
    );
    return;
  }
  skill(s, 'tag-release', { text: 'Tests are green. Tagging.' });
  bash(
    s,
    `git tag -a ${version} -m "${version}" && git push origin ${version}`,
    'Tag and push the release',
    `To github.com:acme/shop-api.git\n * [new tag]         ${version} -> ${version}`,
    true,
    rng.int(800, 3000),
  );
  final(s, `Released ${version}: changelog updated, tests green, tag pushed.`);
}

export function envSecretRun(s: S): void {
  const sec = s.g.secrets;
  const out = `WAREHOUSE_URL=${sec.dbUrl}\nPAYMENTS_API_KEY=${sec.paymentKey}\nLOG_LEVEL=info\n`;
  bash(s, 'cat .env', 'Show the local env file', out, true, s.rng.int(50, 200), {
    think: 'Check which warehouse the local env points at.',
  });
  final(
    s,
    'Your WAREHOUSE_URL points at the shared warehouse host instead of the local Docker one (localhost:5433). Switch it to the local URL from the README and the backfill will connect. Also: that file holds a live payments key; consider moving it to the secrets manager.',
  );
}

export function curlSecretRun(s: S): void {
  const out = `{\n  "id": "ord_8812",\n  "total_cents": 4599,\n  "discount": { "type": "percent", "value": 10 }\n}`;
  bash(
    s,
    `curl -s -H "Authorization: Bearer ${s.g.secrets.bearerToken}" "https://staging-api.acme.test/v1/orders?limit=1" | jq '.data[0]'`,
    'Fetch one staging order',
    out,
    true,
    s.rng.int(400, 1500),
    { think: 'Use the staging token from the shell history to fetch one order.' },
  );
  final(
    s,
    'Yes: staging returns the new `discount` object on orders (`{"type":"percent","value":10}`).',
  );
}

export function remoteSecretRun(s: S): void {
  const url = `https://x-access-token:${s.g.secrets.githubToken}@github.com/acme/infra.git`;
  bash(
    s,
    'git remote -v',
    'Show remotes',
    `origin\t${url} (fetch)\norigin\t${url} (push)`,
    true,
    s.rng.int(30, 120),
    { think: 'Check how origin is configured.' },
  );
  final(
    s,
    'Your origin URL embeds an old access token, which has expired, so git falls back to asking for credentials. Switch to SSH with `git remote set-url origin git@github.com:acme/infra.git` and revoke that token.',
  );
}
