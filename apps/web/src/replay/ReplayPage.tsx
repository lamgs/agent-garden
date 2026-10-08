/**
 * Replay page (`#/replay/:runId`, or `#/replay?plant=<id>` for a plant's latest run): a scrubber
 * with play/pause and speeds, the timeline stage (lanes per run), a step panel, and a context
 * gauge. Playback walks every step of every lane in time order.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  PRICING_VERSION,
  replayContext,
  type ID,
  type LoopTier,
  type ReplayFrame,
  type ReplayView,
} from '@garden/core';
import { OutcomeBadge, ViewMessage } from '../components/ui';
import { formatDateTime, formatDuration, formatTokens } from '../compare-format';
import type { ViewResult } from '../data/views';
import { formatInt, formatUsd, pct, shortModel, truncate } from '../format';
import { contextColor } from '../garden/replay-draw';
import { plantHref } from '../route';
import { LoadingPage, PageShell } from '../views/PageShell';
import { buildModel, formatClock, stepAtDisplay, type ReplayModel } from './model';
import { latestRunOf, loadReplay } from './load';
import { GUTTER, ReplayStage } from './ReplayStage';
import './replay.css';

export const SPEEDS = [1, 4, 16] as const;

const TIER: Record<LoopTier, string> = {
  agent: 'Agent loop (seconds): an ordinary step',
  verification: 'Verification loop (minutes): tests, lint, hooks, reviewers',
  application: 'Application loop (hours): commit, push, PR, deploy',
  hill_climbing: 'Hill-climbing loop (days): edits to harness files',
};

const KIND: Record<ReplayFrame['kind'], string> = {
  user_message: 'Prompt',
  assistant_message: 'Reply',
  thinking: 'Thinking',
  tool_call: 'Tool call',
  tool_result: 'Tool result',
  subagent_spawn: 'Subagent spawn',
  subagent_return: 'Subagent return',
  compaction: 'Compaction',
  error: 'Error',
  hook: 'Hook',
};

export function ReplayRoute({
  runId,
  plantId,
  days,
}: {
  runId: ID | null;
  plantId: ID | null;
  days: number;
}) {
  const [result, setResult] = useState<ViewResult<ReplayView> | null>(null);
  useEffect(() => {
    let live = true;
    setResult(null);
    void (async () => {
      let id = runId;
      if (!id && plantId) {
        const r = await latestRunOf(plantId, days);
        if (r.status !== 'ok') {
          if (live) setResult(r);
          return;
        }
        id = r.data;
      }
      const v = await loadReplay(id ?? '');
      if (live) setResult(v);
    })();
    return () => {
      live = false;
    };
  }, [runId, plantId, days]);
  if (!result) return <LoadingPage crumb="Replay" />;
  if (result.status !== 'ok')
    return (
      <PageShell crumb="Replay">
        <ViewMessage
          title={result.status === 'error' ? 'Could not load the replay' : result.title}
          tone={result.status === 'error' ? 'error' : 'quiet'}
        >
          <p>{result.message}</p>
        </ViewMessage>
      </PageShell>
    );
  return <ReplayPage key={result.data.run.runId} replay={result.data} />;
}

function useWidth(ref: React.RefObject<HTMLElement | null>, fallback: number): number {
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth || fallback);
    const ro = new ResizeObserver(() => setW(el.clientWidth || fallback));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, fallback]);
  return w;
}

function defaultExpanded(v: ReplayView): Set<ID> {
  const direct = v.children.map((c) => c.run.runId);
  return new Set(direct.length <= 4 ? direct : []);
}

export function ReplayPage({ replay }: { replay: ReplayView }) {
  const model = useMemo(() => buildModel(replay), [replay]);
  const last = model.steps.length - 1;
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(4);
  const [expanded, setExpanded] = useState<Set<ID>>(() => defaultExpanded(replay));
  const wrap = useRef<HTMLDivElement>(null);
  const width = useWidth(wrap, 1312);
  const cursor = useRef(0);

  const displayOf = useCallback(
    (i: number) => (model.steps[i] ? model.timeline.toDisplay(model.steps[i].at) : 0),
    [model],
  );
  const seek = useCallback(
    (i: number) => {
      const j = Math.max(0, Math.min(last, i));
      cursor.current = displayOf(j);
      setIndex(j);
    },
    [last, displayOf],
  );

  // Playback: the cursor moves through display time (idle gaps already compressed).
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let prev = performance.now();
    const tick = (now: number) => {
      cursor.current += (now - prev) * speed;
      prev = now;
      const i = Math.max(0, stepAtDisplay(model, cursor.current));
      setIndex(i);
      if (cursor.current >= model.timeline.total) {
        setIndex(last);
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, model, last]);

  const togglePlay = useCallback(() => {
    setPlaying((p) => {
      if (!p && index >= last) {
        cursor.current = 0;
        setIndex(0);
      }
      return !p;
    });
  }, [index, last]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'))
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === ' ') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'ArrowRight') seek(index + 1);
      else if (e.key === 'ArrowLeft') seek(index - 1);
      else if (e.key === 'Home') seek(0);
      else if (e.key === 'End') seek(last);
      else return;
      if (e.key !== ' ') setPlaying(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, seek, index, last]);

  const toggleLane = useCallback(
    (id: ID) =>
      setExpanded((s) => {
        const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      }),
    [],
  );

  const cur = model.steps[index];
  const lane = cur ? model.lanes[cur.lane]! : model.lanes[0]!;
  const frame = cur ? lane.view.frames[cur.frame]! : undefined;
  const r = replay.run;
  const plotW = Math.max(100, width - GUTTER - 28);
  const realNow = cur ? new Date(cur.at).toISOString() : r.startedAt;

  return (
    <PageShell crumb={`Replay · ${replay.agent.name} in ${replay.bed.name}`}>
      <header className="replay-head">
        <div>
          <div className="kicker">
            Time-lapse replay · {replay.agent.kind === 'main' ? 'main run' : 'subagent run'}
          </div>
          <h2 className="replay-title">{truncate(r.taskPreview || '(no prompt)', 140)}</h2>
          <p className="replay-facts">
            <OutcomeBadge label={r.outcome.label} />
            {r.outcome.source === 'manual' ? (
              <span className="manual-chip">manual · heuristic {r.outcome.heuristicLabel}</span>
            ) : null}
            <span>{formatDateTime(r.startedAt)} UTC</span>
            <span>{formatDuration(r.durationMs)}</span>
            <span>{shortModel(r.model ?? undefined)}</span>
            <span>
              {formatInt(replay.frames.length)} steps · {r.toolCallCount} tool calls ·{' '}
              {r.errorCount} error{r.errorCount === 1 ? '' : 's'} · {replay.children.length}{' '}
              subagent runs · {replay.compactions} compaction{replay.compactions === 1 ? '' : 's'}
            </span>
            <span>
              {formatTokens(r.totalTokens)} tokens ·{' '}
              {r.costUsd === null ? 'unpriced' : formatUsd(r.costUsd)}
              {r.costEstimated ? ' (est.)' : ''}
            </span>
            <a href={plantHref(replay.plantId)} className="quiet-link">
              {replay.agent.name} in {replay.bed.name} →
            </a>
          </p>
        </div>
      </header>

      <section className="replay-timeline" aria-label="Timeline" ref={wrap}>
        <div className="replay-controls" role="toolbar" aria-label="Playback">
          <button
            type="button"
            className="play"
            onClick={togglePlay}
            aria-pressed={playing}
            aria-label={playing ? 'Pause (Space)' : 'Play (Space)'}
          >
            {playing ? '❚❚ Pause' : '▶ Play'}
          </button>
          <span className="speeds" role="group" aria-label="Speed">
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                className={s === speed ? 'on' : ''}
                aria-pressed={s === speed}
                onClick={() => setSpeed(s)}
              >
                {s}×
              </button>
            ))}
          </span>
          <button type="button" onClick={() => seek(index - 1)} aria-label="Previous step (←)">
            ‹
          </button>
          <button type="button" onClick={() => seek(index + 1)} aria-label="Next step (→)">
            ›
          </button>
          <span className="clock" aria-live="off">
            <b>{realNow.slice(11, 19)} UTC</b> · +
            {formatClock(cur ? cur.at - model.timeline.start : 0)} of{' '}
            {formatClock(model.timeline.end - model.timeline.start)} · step {index + 1} of{' '}
            {model.steps.length}
          </span>
          <span
            className="compress-note"
            data-tip={`Gaps longer than 15 s between steps are drawn 4 s wide and labeled with their real length. Playback moves through this compressed time at ${speed}× (real timestamps are shown).`}
            tabIndex={0}
          >
            {model.timeline.gaps.length
              ? `${model.timeline.gaps.length} idle gap${model.timeline.gaps.length === 1 ? '' : 's'} compressed (${formatClock(model.timeline.gaps.reduce((n, g) => n + g.realMs, 0))})`
              : 'no idle gaps'}
          </span>
        </div>
        <ReplayStage
          replay={replay}
          index={index}
          expanded={expanded}
          onSeek={(i) => {
            setPlaying(false);
            seek(i);
          }}
          onToggleLane={toggleLane}
          width={width}
        />
        <input
          type="range"
          className="scrubber"
          aria-label="Scrub through the run"
          aria-valuetext={`step ${index + 1} of ${model.steps.length}, ${realNow.slice(11, 19)} UTC`}
          min={0}
          max={Math.max(1, Math.round(model.timeline.total))}
          step={1}
          value={Math.round(displayOf(index))}
          style={{ marginLeft: GUTTER, width: plotW }}
          onChange={(e) => {
            setPlaying(false);
            const d = Number(e.target.value);
            cursor.current = d;
            setIndex(Math.max(0, stepAtDisplay(model, d)));
          }}
        />
      </section>

      <div className="replay-grid">
        <StepPanel
          model={model}
          index={index}
          frame={frame}
          laneView={lane.view}
          root={replay}
          onExpand={toggleLane}
          expanded={expanded}
        />
        <ContextGauge frame={frame} view={lane.view} />
      </div>
    </PageShell>
  );
}

function StepPanel({
  model,
  index,
  frame,
  laneView,
  root,
  onExpand,
  expanded,
}: {
  model: ReplayModel;
  index: number;
  frame: ReplayFrame | undefined;
  laneView: ReplayView;
  root: ReplayView;
  onExpand: (id: ID) => void;
  expanded: ReadonlySet<ID>;
}) {
  if (!frame) return <section className="card step-panel" aria-label="Step" />;
  const cur = model.steps[index]!;
  const child = frame.forkRunId
    ? laneView.children.find((c) => c.run.runId === frame.forkRunId)
    : undefined;
  const isSub = laneView !== root;
  const cost = frame.costUsdCum;
  return (
    <section className="card step-panel" aria-label="Step" aria-live="polite">
      <div className="card-kicker">
        Step {index + 1} of {model.steps.length} ·{' '}
        {isSub ? `subagent ${laneView.agent.name}` : `${laneView.agent.name} (main run)`} ·{' '}
        {new Date(cur.at).toISOString().replace('T', ' ').slice(0, 19)} UTC
      </div>
      <h3 className={`step-label${frame.isError ? ' is-error' : ''}`}>
        {frame.isError ? <span className="err-glyph">✕ </span> : null}
        {frame.label}
      </h3>
      <dl className="facts step-facts">
        <div>
          <dt>Kind</dt>
          <dd>{KIND[frame.kind]}</dd>
        </div>
        <div>
          <dt>Tool</dt>
          <dd>
            {frame.tool
              ? `${frame.tool.name} · ${frame.tool.category}${frame.tool.mcpServer ? ` · server ${frame.tool.mcpServer}` : ''}${frame.tool.skillName ? ` · skill ${frame.tool.skillName}` : ''}`
              : '—'}
          </dd>
        </div>
        <div>
          <dt>Loop tier</dt>
          <dd>{TIER[frame.loopTier]}</dd>
        </div>
        <div>
          <dt>Error</dt>
          <dd className={frame.isError ? 'is-error' : ''}>{frame.isError ? 'yes' : 'no'}</dd>
        </div>
        <div>
          <dt>Tokens so far</dt>
          <dd
            tabIndex={0}
            data-tip="Sum of input + output + cache read + cache write tokens over the API messages up to this step, each message counted once (lines that repeat a message are deduped by message id)."
          >
            {formatInt(frame.tokensCum)}
            {laneView.run.costEstimated ? ' (output under-reported, see cost)' : ''}
          </dd>
        </div>
        <div>
          <dt>Cost so far</dt>
          <dd
            tabIndex={0}
            data-tip={`Those tokens × the pricing table (${PRICING_VERSION}) for ${laneView.run.model ?? 'an unknown model'}, with cache read/write rates, computed now from stored tokens.`}
          >
            {cost === null || cost === undefined ? 'unpriced' : formatUsd(cost)}
            {laneView.run.costEstimated ? ' (estimated: stream-start usage only)' : ''}
          </dd>
        </div>
        {frame.compaction ? (
          <div>
            <dt>Compaction</dt>
            <dd>
              {frame.compaction.trigger}
              {frame.compaction.preTokens !== undefined
                ? `, ${formatInt(frame.compaction.preTokens)} tokens before`
                : ''}
            </dd>
          </div>
        ) : null}
        {child ? (
          <div>
            <dt>Subagent</dt>
            <dd>
              {child.agent.name}: {child.frames.length} steps, {child.run.errorCount} errors,{' '}
              <OutcomeBadge label={child.run.outcome.label} />{' '}
              <button type="button" className="linkish" onClick={() => onExpand(child.run.runId)}>
                {expanded.has(child.run.runId) ? 'collapse lane' : 'expand lane'}
              </button>
            </dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}

function ContextGauge({ frame, view }: { frame: ReplayFrame | undefined; view: ReplayView }) {
  const fill = frame?.contextFill ?? 0;
  const level = replayContext.level({ contextFill: fill });
  const peakFill = Math.min(1, view.peakContextTokens / view.contextWindow);
  return (
    <section className="card context-gauge" aria-label="Context">
      <div className="card-kicker">Context window · {view.agent.name}</div>
      <h3 className="card-title">
        {pct(fill, 1)} <span className="muted">of the window</span>
      </h3>
      <div
        className="gauge"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={view.contextWindow}
        aria-valuenow={frame?.contextTokens ?? 0}
        aria-label="Context used"
        tabIndex={0}
        data-tip={`${formatInt(frame?.contextTokens ?? 0)} ÷ ${formatInt(view.contextWindow)} tokens. ${replayContext.levels[level]}.`}
      >
        <div
          className="gauge-fill"
          style={{ width: `${fill * 100}%`, background: contextColor(level) }}
        />
        <div className="gauge-mark m50" />
        <div className="gauge-mark m80" />
        <div
          className="gauge-peak"
          style={{ left: `${peakFill * 100}%` }}
          title={`peak ${formatInt(view.peakContextTokens)}`}
        />
      </div>
      <p className="gauge-legend">
        <span>
          <b>{formatInt(frame?.contextTokens ?? 0)}</b> tokens in the prompt now
        </span>
        <span>peak {formatInt(view.peakContextTokens)}</span>
        <span>
          {view.compactions} compaction{view.compactions === 1 ? '' : 's'}
        </span>
      </p>
      <details className="legend-how">
        <summary>How computed</summary>
        <p>{replayContext.howComputed}</p>
        <p>Window: {view.contextWindowSource}</p>
        <p>
          Ticks at 50% and 80%. The thin line is this run’s peak. A compaction does not lower the
          gauge until the next API message reports the smaller prompt.
        </p>
      </details>
    </section>
  );
}
