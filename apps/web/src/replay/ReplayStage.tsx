/**
 * The replay stage: an abstract, time-centric drawing of one run. Narrow interface: the
 * ReplayView (frames, with child runs nested) plus the current playback index. Another renderer
 * can replace this component as long as it takes the same props.
 *
 * Lanes: main run on top, subagent runs below, branching off at their spawn step and merging back
 * when they end. x = time (idle gaps compressed and marked). Marks: shape = step kind, color =
 * tool category, red cross = error, dashed cut = compaction. Under the main lane, the context band
 * fills against the window line. Every channel is in the encodings registry (replay.*).
 */
import { useEffect, useMemo, useRef } from 'react';
import {
  INK,
  replayContext,
  replayMarkColor,
  replayMarkShape,
  type ID,
  type ReplayView,
} from '@garden/core';
import { CanvasPen } from '../garden/pen';
import {
  drawBranch,
  drawContextBand,
  drawCut,
  drawErrorMark,
  drawGapBreak,
  drawLaneLine,
  drawPlayhead,
  drawStepMark,
  SHAPE_ROW,
  type BandPoint,
} from '../garden/replay-draw';
import { buildModel, formatClock, type ReplayModel } from './model';

export interface ReplayStageProps {
  replay: ReplayView;
  /** Index into the time-ordered list of every step across lanes (see `buildModel`). */
  index: number;
  /** Subagent lanes drawn with all their marks; others show only their span and errors. */
  expanded?: ReadonlySet<ID>;
  onSeek?: (index: number) => void;
  onToggleLane?: (runId: ID) => void;
  width: number;
}

export const GUTTER = 188;
const RIGHT = 28;
const AXIS_H = 34;
const MAIN_H = 44;
const BAND_H = 56;
const BAND_GAP = 30;
const LANE_OPEN = 36;
const LANE_SHUT = 22;
const FONT = "12px 'Source Sans 3', system-ui, sans-serif";

export interface StageLayout {
  height: number;
  laneY: number[];
  bandTop: number;
  x: (display: number) => number;
  plotX0: number;
  plotX1: number;
}

export function stageLayout(
  m: ReplayModel,
  width: number,
  expanded: ReadonlySet<ID> = new Set(),
): StageLayout {
  const laneY: number[] = [];
  const mainY = AXIS_H + MAIN_H / 2 + 4;
  const bandTop = mainY + MAIN_H / 2 + 10;
  let y = bandTop + BAND_H + BAND_GAP;
  m.lanes.forEach((l, i) => {
    if (i === 0) {
      laneY.push(mainY);
      return;
    }
    const h = expanded.has(l.runId) ? LANE_OPEN : LANE_SHUT;
    laneY.push(y + h / 2);
    y += h;
  });
  const plotX0 = GUTTER;
  const plotX1 = Math.max(plotX0 + 100, width - RIGHT);
  const total = Math.max(1, m.timeline.total);
  return {
    height: Math.max(y, bandTop + BAND_H) + 30,
    laneY,
    bandTop,
    plotX0,
    plotX1,
    x: (d) => plotX0 + (d / total) * (plotX1 - plotX0),
  };
}

export function ReplayStage({
  replay,
  index,
  expanded = new Set(),
  onSeek,
  onToggleLane,
  width,
}: ReplayStageProps) {
  const model = useMemo(() => buildModel(replay), [replay]);
  const layout = useMemo(() => stageLayout(model, width, expanded), [model, width, expanded]);
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    c.width = Math.round(width * dpr);
    c.height = Math.round(layout.height * dpr);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, layout.height);
    drawStage(ctx, model, layout, index, expanded);
  }, [model, layout, index, expanded, width]);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onSeek) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    // Nearest lane by y (the context band belongs to the main lane), then nearest step by x.
    let lane = 0;
    let best = Infinity;
    layout.laneY.forEach((y, i) => {
      const d = i === 0 && py < layout.bandTop + BAND_H ? 0 : Math.abs(py - y);
      if (d < best) {
        best = d;
        lane = i;
      }
    });
    let pick = -1;
    let dx = Infinity;
    model.steps.forEach((s, i) => {
      if (s.lane !== lane) return;
      const d = Math.abs(layout.x(model.timeline.toDisplay(s.at)) - px);
      if (d < dx) {
        dx = d;
        pick = i;
      }
    });
    if (pick >= 0) onSeek(pick);
  };

  return (
    <div className="replay-stage" style={{ width, height: layout.height }}>
      <canvas
        ref={ref}
        style={{ width, height: layout.height }}
        role="img"
        aria-label={`Timeline of ${model.steps.length} steps across ${model.lanes.length} lane${model.lanes.length === 1 ? '' : 's'}; click a mark to jump to it`}
        onClick={onClick}
      />
      {model.lanes.map((l, i) => {
        const errors = l.view.frames.filter((f) => f.isError).length;
        // Subagent lanes are named by what they were asked to do (the spawn's description).
        const spawn =
          l.parent !== null && l.spawnFrame !== null
            ? model.lanes[l.parent]!.view.frames[l.spawnFrame]!.label
            : '';
        const task = /^Spawn [^:]+: (.+)$/.exec(spawn)?.[1];
        const y = layout.laneY[i]!;
        const open = i === 0 || expanded.has(l.runId);
        return (
          <div
            key={l.runId}
            className={`lane-label depth-${Math.min(l.depth, 3)}`}
            style={{ top: y - 11, paddingLeft: 8 + l.depth * 12 }}
            data-run-id={l.runId}
            title={`${l.view.agent.name}${task ? `: ${task}` : ''}\n${l.view.run.taskPreview}`}
          >
            {i === 0 ? (
              <span className="lane-name">{l.view.agent.name}</span>
            ) : (
              <button
                type="button"
                className="lane-toggle"
                aria-expanded={open}
                onClick={() => onToggleLane?.(l.runId)}
                aria-label={`${open ? 'Collapse' : 'Expand'} subagent lane ${l.view.agent.name}`}
              >
                {open ? '▾' : '▸'} <span className="lane-name">{task ?? l.view.agent.name}</span>
              </button>
            )}
            <span className="lane-meta">
              {l.view.frames.length} steps
              {errors ? <span className="lane-err"> · {errors} err</span> : null}
            </span>
          </div>
        );
      })}
      {model.lanes.length > 0 ? (
        <div className="band-label" style={{ top: layout.bandTop - 2 }}>
          <span>context</span>
          <span className="lane-meta">window {formatTokensShort(replay.contextWindow)}</span>
        </div>
      ) : null}
    </div>
  );
}

const formatTokensShort = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
    : `${Math.round(n / 1000)}k`;

function drawStage(
  ctx: CanvasRenderingContext2D,
  m: ReplayModel,
  L: StageLayout,
  index: number,
  expanded: ReadonlySet<ID>,
): void {
  const pen = new CanvasPen(ctx);
  const tl = m.timeline;
  const X = (abs: number) => L.x(tl.toDisplay(abs));
  const reachedAt = new Map<string, number>();
  m.steps.forEach((s, i) => reachedAt.set(`${s.lane}:${s.frame}`, i));
  const reached = (lane: number, frame: number) =>
    (reachedAt.get(`${lane}:${frame}`) ?? Infinity) <= index;
  const playX = index >= 0 && m.steps[index] ? X(m.steps[index].at) : L.plotX0 - 0.0001;
  const bottom = L.height - 12;

  // ---- axis: real elapsed time at evenly spaced display positions --------------------------------
  ctx.font = FONT;
  ctx.fillStyle = INK.muted;
  ctx.textBaseline = 'alphabetic';
  const ticks = 6;
  for (let k = 0; k <= ticks; k++) {
    const d = (tl.total * k) / ticks;
    const x = L.x(d);
    const label = `+${formatClock(tl.toAbs(d) - tl.start)}`;
    ctx.textAlign = k === 0 ? 'left' : k === ticks ? 'right' : 'center';
    ctx.fillText(label, x, 14);
    pen.moveTo(x, 18);
    pen.lineTo(x, 22);
  }
  pen.stroke({ color: INK.muted, width: 1 });
  pen.moveTo(L.plotX0, 22);
  pen.lineTo(L.plotX1, 22);
  pen.stroke({ color: INK.hairline, width: 1 });

  // ---- lanes, branches -----------------------------------------------------------------------------
  m.lanes.forEach((l, i) => {
    const y = L.laneY[i]!;
    const x0 = X(l.start);
    const x1 = Math.max(X(l.end), x0 + 2);
    if (l.parent !== null) {
      const py = L.laneY[l.parent]!;
      const fork =
        l.spawnFrame !== null
          ? m.lanes[l.parent]!.start + m.lanes[l.parent]!.view.frames[l.spawnFrame]!.t
          : l.start;
      drawBranch(pen, X(fork), py, x0, y);
      drawBranch(pen, x1, y, x1 + Math.min(10, (L.plotX1 - x1) / 2), py);
    }
    drawLaneLine(pen, x0, x1, y, l.depth);
  });

  // ---- context band (main lane) ---------------------------------------------------------------------
  const main = m.lanes[0];
  if (main) {
    const pts: BandPoint[] = main.view.frames.map((f) => ({
      x: X(main.start + f.t),
      fill: f.contextFill,
      level: replayContext.level(f),
    }));
    const bx1 = X(main.end);
    drawContextBand(pen, L.plotX0, L.plotX1, L.bandTop, BAND_H, pts, 0.3);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, L.bandTop - 2, playX, BAND_H + 4);
    ctx.clip();
    drawContextBand(
      pen,
      L.plotX0,
      L.plotX1,
      L.bandTop,
      BAND_H,
      pts.filter((p) => p.x <= bx1),
    );
    ctx.restore();
  }

  // ---- idle gaps -----------------------------------------------------------------------------------
  ctx.font = FONT;
  ctx.textAlign = 'center';
  for (const g of tl.gaps) {
    const x = L.x(g.at) + (L.x(g.at + 4000) - L.x(g.at)) / 2;
    drawGapBreak(pen, x, 24, bottom - 14);
    ctx.fillStyle = INK.secondary;
    ctx.fillText(`idle ${formatClock(g.realMs)}`, x, bottom - 2);
  }

  // ---- marks -----------------------------------------------------------------------------------------
  m.lanes.forEach((l, li) => {
    const y = L.laneY[li]!;
    const open = li === 0 || expanded.has(l.runId);
    const size = li === 0 ? 4.2 : open ? 3.6 : 3;
    const rowGap = li === 0 ? 10 : 7;
    l.view.frames.forEach((f, fi) => {
      const x = X(l.start + f.t);
      const a = reached(li, fi) ? 1 : 0.22;
      const shape = replayMarkShape.level(f);
      if (f.compaction) {
        drawCut(pen, x, y, y - 16, li === 0 ? L.bandTop + BAND_H : y + 12);
        if (li === 0) {
          ctx.fillStyle = INK.primary;
          const pre = f.compaction.preTokens;
          const text = `compaction${pre ? ` · ${formatTokensShort(pre)} before` : ''}`;
          const right = x + 6 + ctx.measureText(text).width > L.plotX1 + RIGHT - 4;
          ctx.textAlign = right ? 'right' : 'left';
          ctx.fillText(text, right ? x - 6 : x + 6, L.bandTop + 12);
        }
        return;
      }
      const yy = y + SHAPE_ROW[shape]! * rowGap;
      if (f.isError) {
        drawErrorMark(pen, x, yy, size + 0.6, a);
        return;
      }
      if (!open) return;
      drawStepMark(pen, x, yy, shape, replayMarkColor.level(f), size, a);
    });
  });

  // ---- current step + playhead -------------------------------------------------------------------
  const cur = m.steps[index];
  if (cur) {
    const f = m.lanes[cur.lane]!.view.frames[cur.frame]!;
    const shape = replayMarkShape.level(f);
    const y = L.laneY[cur.lane]! + SHAPE_ROW[shape]! * (cur.lane === 0 ? 10 : 7);
    pen.circle(playX, y, 8);
    pen.stroke({ color: INK.primary, width: 1.6 });
  }
  drawPlayhead(pen, Math.max(L.plotX0, playX), 28, bottom);
}
