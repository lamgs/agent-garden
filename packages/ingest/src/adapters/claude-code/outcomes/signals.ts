/**
 * Outcome detectors: one function per heuristic signal in packages/core SIGNALS. Each returns
 * `fired` (true / false / null = not applicable) plus a short human-readable `detail` that the UI
 * shows as evidence. Pure functions over parsed runs.
 */
import { SIGNALS, type OutcomeSignalResult, type SignalDef } from '@garden/core';
import type { ParsedRun, ParsedSession, ParsedStep, SessionOutcomes } from '../contracts';
import { isCommitOrPrCommand, isTestCommand } from './commands';
import { EDIT_TOOLS } from './tier';
import { isAcknowledgement, isCorrection, similarity, truncate } from './text';

export const TAIL_STEPS = 5;
export const RETRY_WINDOW_MS = 10 * 60 * 1000;
export const RETRY_SIMILARITY = 0.6;
export const MOVED_ON_SIMILARITY = 0.3;
export const RESPAWN_SIMILARITY = 0.6;

/** Test-runner output that reports failures even when the command exited 0 (piped, `|| true`). */
export const FAILING_OUTPUT =
  /\b([1-9]\d* (failed|failing|failures?|errors?)\b|FAIL\b|FAILED\b|Tests?:.*\b[1-9]\d* failed)/;

type Verdict = { fired: boolean | null; detail: string };

/** Everything a detector needs about one run, computed once. */
export interface RunContext {
  session: ParsedSession;
  run: ParsedRun;
  steps: ParsedStep[];
  resultFor: (call: ParsedStep) => ParsedStep | undefined;
  nextHumanRun: ParsedRun | undefined;
}

function cmd(step: ParsedStep): string {
  return `\`${truncate(step.raw.command ?? '')}\``;
}

function resultFailed(result: ParsedStep): boolean {
  return result.tool?.isError === true || FAILING_OUTPUT.test(result.preview ?? '');
}

function testCalls(ctx: RunContext): ParsedStep[] {
  return ctx.steps.filter((s) => s.kind === 'tool_call' && isTestCommand(s.raw.command));
}

function lastEdit(ctx: RunContext): ParsedStep | undefined {
  let last: ParsedStep | undefined;
  for (const s of ctx.steps) {
    if (s.kind === 'tool_call' && s.tool !== undefined && EDIT_TOOLS.has(s.tool.name)) last = s;
  }
  return last;
}

export function testsPassedAfterLastEdit(ctx: RunContext): Verdict {
  const tests = testCalls(ctx);
  if (tests.length === 0) return { fired: null, detail: 'No test command ran in this run.' };
  const edit = lastEdit(ctx);
  const candidates = edit === undefined ? tests : tests.filter((t) => t.seq > edit.seq);
  const editNote =
    edit === undefined ? 'no file edits in the run' : `last edit at step ${edit.seq}`;
  for (const t of [...candidates].reverse()) {
    const r = ctx.resultFor(t);
    if (r !== undefined && !resultFailed(r)) {
      return { fired: true, detail: `${cmd(t)} passed at step ${r.seq}, after ${editNote}.` };
    }
  }
  if (candidates.length === 0) {
    const t = tests[tests.length - 1] as ParsedStep;
    return {
      fired: false,
      detail: `Last test command ${cmd(t)} (step ${t.seq}) ran before the ${editNote}.`,
    };
  }
  return {
    fired: false,
    detail: `No test command after the ${editNote} returned without error (${candidates.length} tried).`,
  };
}

export function testsFailingAtEnd(ctx: RunContext): Verdict {
  const tests = testCalls(ctx);
  if (tests.length === 0) return { fired: null, detail: 'No test command ran in this run.' };
  for (const t of [...tests].reverse()) {
    const r = ctx.resultFor(t);
    if (r === undefined) continue;
    if (!resultFailed(r)) {
      return { fired: false, detail: `Last test command ${cmd(t)} passed at step ${r.seq}.` };
    }
    const why = r.tool?.isError === true ? 'returned an error' : 'reported failures';
    return { fired: true, detail: `Last test command ${cmd(t)} ${why} at step ${r.seq}.` };
  }
  return { fired: false, detail: 'No test command returned a result.' };
}

export function cleanFinish(ctx: RunContext): Verdict {
  const { run } = ctx;
  if (run.interrupted) return { fired: false, detail: 'The user interrupted the run.' };
  if (run.finalStopReason === 'end_turn') {
    return { fired: true, detail: 'Final assistant message ended with end_turn.' };
  }
  if (run.finalStopReason === undefined) {
    return { fired: null, detail: 'No stop reason recorded for the final assistant message.' };
  }
  return { fired: false, detail: `Final assistant message ended with ${run.finalStopReason}.` };
}

function isErrorStep(s: ParsedStep): boolean {
  if (s.kind === 'error') return s.error?.kind !== 'interrupt';
  return s.kind === 'tool_result' && s.tool?.isError === true;
}

export function errorsInTail(ctx: RunContext): Verdict {
  const { steps } = ctx;
  const tail = steps.slice(-TAIL_STEPS);
  for (const e of tail.filter(isErrorStep)) {
    const name = e.tool?.name;
    const later = steps.filter((s) => s.seq > e.seq);
    const recovered =
      name !== undefined
        ? later.some((s) => s.kind === 'tool_result' && s.tool?.name === name && !s.tool.isError)
        : later.some((s) => s.kind === 'assistant_message' && s.error === undefined);
    if (!recovered) {
      const what = name !== undefined ? `${name} error` : `${e.error?.kind ?? 'unknown'} error`;
      const msg = e.error?.message ?? e.preview;
      const suffix = msg !== undefined && msg !== '' ? `: ${truncate(msg, 60)}` : '';
      const tailNote =
        name !== undefined ? `never followed by a successful ${name}` : 'never recovered';
      return { fired: true, detail: `${what} at step ${e.seq}${suffix} (${tailNote}).` };
    }
  }
  return {
    fired: false,
    detail: `No unrecovered error in the last ${Math.min(TAIL_STEPS, steps.length)} steps.`,
  };
}

function minutesBetween(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / 60000;
}

export function userRetried(ctx: RunContext): Verdict {
  const { run, nextHumanRun: next } = ctx;
  if (run.interrupted) return { fired: true, detail: 'The user interrupted the run.' };
  if (next === undefined) return { fired: null, detail: 'No later human prompt in the session.' };
  const gapMs = Date.parse(next.startedAt) - Date.parse(run.endedAt);
  const gap = `${Math.max(0, Math.round(minutesBetween(run.endedAt, next.startedAt)))} min later`;
  const quoted = `"${truncate(next.taskText, 60)}"`;
  if (!(gapMs <= RETRY_WINDOW_MS)) {
    return { fired: false, detail: `Next human prompt came ${gap} (window is 10 min).` };
  }
  if (isCorrection(next.taskText)) {
    return { fired: true, detail: `Next prompt ${gap} reads as a correction: ${quoted}.` };
  }
  const sim = similarity(next.taskText, run.taskText);
  if (sim >= RETRY_SIMILARITY) {
    return {
      fired: true,
      detail: `Next prompt ${gap} repeats this task (similarity ${sim.toFixed(2)}): ${quoted}.`,
    };
  }
  return {
    fired: false,
    detail: `Next prompt ${gap} is not a correction (similarity ${sim.toFixed(2)}).`,
  };
}

export function userMovedOn(ctx: RunContext, retried: Verdict): Verdict {
  const { run, nextHumanRun: next } = ctx;
  if (next === undefined) return { fired: null, detail: 'No later human prompt in the session.' };
  if (retried.fired === true) return { fired: false, detail: 'The user retried instead.' };
  const quoted = `"${truncate(next.taskText, 60)}"`;
  if (isCorrection(next.taskText)) {
    return { fired: false, detail: `Next prompt reads as a correction: ${quoted}.` };
  }
  if (isAcknowledgement(next.taskText)) {
    return { fired: true, detail: `Next prompt is an acknowledgement: ${quoted}.` };
  }
  const sim = similarity(next.taskText, run.taskText);
  if (sim < MOVED_ON_SIMILARITY) {
    return { fired: true, detail: `Next prompt is a new topic (similarity ${sim.toFixed(2)}).` };
  }
  return { fired: false, detail: `Next prompt stays on this task (similarity ${sim.toFixed(2)}).` };
}

export function shipped(ctx: RunContext): Verdict {
  const ships = ctx.steps.filter(
    (s) => s.kind === 'tool_call' && isCommitOrPrCommand(s.raw.command),
  );
  for (const s of [...ships].reverse()) {
    const r = ctx.resultFor(s);
    if (r !== undefined && r.tool?.isError !== true) {
      return { fired: true, detail: `${cmd(s)} succeeded at step ${r.seq}.` };
    }
  }
  if (ships.length > 0) {
    return {
      fired: false,
      detail: `${cmd(ships[ships.length - 1] as ParsedStep)} did not succeed.`,
    };
  }
  return { fired: false, detail: 'No git commit, git push, or gh pr create in this run.' };
}

export function parentRespawned(ctx: RunContext): Verdict {
  const { session, run } = ctx;
  const parent = session.runs.find((r) => r.id === run.parentRunId);
  if (parent === undefined) return { fired: null, detail: 'Parent run not found.' };
  const spawn = parent.steps.find(
    (s) => s.id === run.parentStepId || (s.childRunId !== undefined && s.childRunId === run.id),
  );
  const type = spawn?.raw.subagentType ?? run.agentName;
  const ended = Date.parse(run.endedAt);
  for (const s of parent.steps) {
    if (s.kind !== 'subagent_spawn' || s === spawn || s.childRunId === run.id) continue;
    if (spawn !== undefined && s.seq <= spawn.seq) continue;
    // Parallel spawns are not respawns: the new spawn must come after this run ended.
    if (Date.parse(s.at) < ended) continue;
    if (s.raw.subagentType !== type) continue;
    const sim = similarity(s.raw.subagentPrompt ?? '', run.taskText);
    if (sim >= RESPAWN_SIMILARITY) {
      return {
        fired: true,
        detail: `Parent spawned ${type} again at step ${s.seq} with a similar prompt (similarity ${sim.toFixed(2)}).`,
      };
    }
  }
  return { fired: false, detail: `Parent did not respawn ${type} with a similar prompt.` };
}

function notApplicable(def: SignalDef, run: ParsedRun): Verdict {
  return {
    fired: null,
    detail: `Applies to ${def.appliesTo} runs only; this is a ${run.kind} run.`,
  };
}

/** Run every signal for one run, in SIGNALS order. */
export function detectRunOutcomes(ctx: RunContext): OutcomeSignalResult[] {
  let retried: Verdict | undefined;
  const getRetried = () => (retried ??= userRetried(ctx));
  return SIGNALS.map((def) => {
    let v: Verdict;
    if (def.appliesTo !== 'all' && def.appliesTo !== ctx.run.kind) {
      v = notApplicable(def, ctx.run);
    } else {
      switch (def.id) {
        case 'tests_passed_after_last_edit':
          v = testsPassedAfterLastEdit(ctx);
          break;
        case 'tests_failing_at_end':
          v = testsFailingAtEnd(ctx);
          break;
        case 'clean_finish':
          v = cleanFinish(ctx);
          break;
        case 'errors_in_tail':
          v = errorsInTail(ctx);
          break;
        case 'user_retried':
          v = getRetried();
          break;
        case 'user_moved_on':
          v = userMovedOn(ctx, getRetried());
          break;
        case 'shipped':
          v = shipped(ctx);
          break;
        case 'parent_respawned':
          v = parentRespawned(ctx);
          break;
        default:
          v = { fired: null, detail: `No detector for signal ${def.id}.` };
      }
    }
    return { id: def.id, fired: v.fired, weight: def.weight, detail: v.detail };
  });
}

/** Build the per-run context: steps in seq order, call → result pairing, next human prompt. */
export function runContext(session: ParsedSession, run: ParsedRun): RunContext {
  const steps = [...run.steps].sort((a, b) => a.seq - b.seq);
  const results = new Map<string, ParsedStep>();
  for (const s of steps) {
    const id = s.raw.answersCallId;
    if (s.kind === 'tool_result' && id !== undefined && !results.has(id)) results.set(id, s);
  }
  let nextHumanRun: ParsedRun | undefined;
  if (run.kind === 'main') {
    const idx = session.runs.indexOf(run);
    nextHumanRun = session.runs
      .slice(idx + 1)
      .find((r) => r.kind === 'main' && r.trigger === 'human');
  }
  return {
    session,
    run,
    steps,
    resultFor: (call) => (call.tool === undefined ? undefined : results.get(call.tool.callId)),
    nextHumanRun,
  };
}

/** Run every heuristic signal (packages/core SIGNALS) for every run in the session. */
export function detectSessionOutcomes(session: ParsedSession): SessionOutcomes {
  const out: SessionOutcomes = new Map();
  for (const run of session.runs) out.set(run.id, detectRunOutcomes(runContext(session, run)));
  return out;
}
