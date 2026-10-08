/**
 * Replay timeline marks, drawn through the shared `Pen` so the stage and the legend swatches use
 * one code path. Every function takes encoding LEVELS (from the registry), never raw metrics.
 */
import { INK, PAPER, REPLAY, STATUS } from '@garden/core';
import { dashPolyline } from './draw';
import type { Pen } from './pen';

export const categoryColor = (level: number): string =>
  REPLAY.category[level] ?? REPLAY.category[4];
export const contextColor = (level: number): string => REPLAY.context[level] ?? REPLAY.context[0];

/** Vertical offset of a mark from its lane line, per shape level (calls above, results below). */
export const SHAPE_ROW = [-1, 1, 0, 0, 0, 0] as const;

/** A step mark centered at (x, y). `shape` = replay.mark_shape level, `category` = replay.mark_color level. */
export function drawStepMark(
  pen: Pen,
  x: number,
  y: number,
  shape: number,
  category: number,
  size = 4,
  alpha = 1,
): void {
  const color = categoryColor(category);
  const ink = { color: INK.primary, width: 0.8, alpha: 0.55 * alpha };
  switch (shape) {
    case 0: // tool call: filled dot
      pen.circle(x, y, size);
      pen.fill({ color, alpha });
      pen.stroke(ink);
      break;
    case 1: // tool result: ring
      pen.circle(x, y, size * 0.85);
      pen.fill({ color: PAPER, alpha });
      pen.stroke({ color, width: 1.6, alpha });
      break;
    case 2: // thinking: hollow diamond
      pen.poly([x, y - size, x + size * 0.8, y, x, y + size, x - size * 0.8, y]);
      pen.fill({ color: PAPER, alpha });
      pen.stroke({ color: INK.secondary, width: 1.1, alpha });
      break;
    case 3: // message: square
      pen.rect(x - size * 0.75, y - size * 0.75, size * 1.5, size * 1.5);
      pen.fill({ color, alpha: 0.85 * alpha });
      pen.stroke(ink);
      break;
    case 4: // subagent spawn / return: triangle
      pen.poly([x - size, y - size * 0.8, x + size, y - size * 0.8, x, y + size * 0.9]);
      pen.fill({ color, alpha });
      pen.stroke(ink);
      break;
    default: // tick
      pen.moveTo(x, y - size);
      pen.lineTo(x, y + size);
      pen.stroke({ color: INK.secondary, width: 1.4, alpha });
  }
}

/** Error: a red cross with a paper halo, drawn over (or instead of) the step's mark. */
export function drawErrorMark(pen: Pen, x: number, y: number, size = 4.5, alpha = 1): void {
  pen.circle(x, y, size + 1.6);
  pen.fill({ color: PAPER, alpha: 0.9 * alpha });
  pen.moveTo(x - size, y - size);
  pen.lineTo(x + size, y + size);
  pen.moveTo(x + size, y - size);
  pen.lineTo(x - size, y + size);
  pen.stroke({ color: STATUS.critical, width: 2.2, alpha, cap: 'round' });
}

/** Compaction: a double slash on the lane and a dashed vertical cut from y0 to y1. */
export function drawCut(pen: Pen, x: number, laneY: number, y0: number, y1: number): void {
  dashPolyline(
    pen,
    [
      { x, y: y0 },
      { x, y: y1 },
    ],
    4,
    3,
  );
  pen.stroke({ color: INK.primary, width: 1.2, alpha: 0.75 });
  for (const dx of [-3, 2]) {
    pen.moveTo(x + dx - 3, laneY + 7);
    pen.lineTo(x + dx + 3, laneY - 7);
  }
  pen.stroke({ color: INK.primary, width: 1.8, alpha: 0.9 });
}

/** Idle gap: a zigzag break across the axis between y0 and y1. */
export function drawGapBreak(pen: Pen, x: number, y0: number, y1: number): void {
  pen.rect(x - 3, y0, 6, y1 - y0);
  pen.fill({ color: PAPER, alpha: 0.95 });
  const n = Math.max(2, Math.round((y1 - y0) / 6));
  for (const dx of [-2.5, 2.5]) {
    pen.moveTo(x + dx, y0);
    for (let i = 1; i <= n; i++) pen.lineTo(x + dx + (i % 2 ? 2 : -2), y0 + ((y1 - y0) * i) / n);
  }
  pen.stroke({ color: INK.muted, width: 0.9, alpha: 0.9 });
}

export interface BandPoint {
  x: number;
  /** 0..1 */
  fill: number;
  /** replay.context level */
  level: number;
}

/**
 * Context band: a step area of fill (0..1) between y = top (the window) and y = top + h (zero),
 * colored per segment by its level, with the window line drawn on top.
 */
export function drawContextBand(
  pen: Pen,
  x0: number,
  x1: number,
  top: number,
  h: number,
  pts: readonly BandPoint[],
  alpha = 1,
): void {
  const base = top + h;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const nx = pts[i + 1]?.x ?? x1;
    if (p.fill <= 0 || nx <= p.x) continue;
    const y = base - p.fill * h;
    pen.rect(p.x, y, nx - p.x, base - y);
    pen.fill({ color: contextColor(p.level), alpha: 0.55 * alpha });
    pen.moveTo(p.x, y);
    pen.lineTo(nx, y);
    pen.stroke({ color: contextColor(p.level), width: 1.2, alpha });
  }
  pen.moveTo(x0, base);
  pen.lineTo(x1, base);
  pen.stroke({ color: INK.hairline, width: 1 });
  // 50% and 80% guides (the gauge's ticks), then the window line itself.
  for (const g of [0.5, 0.8])
    dashPolyline(
      pen,
      [
        { x: x0, y: base - g * h },
        { x: x1, y: base - g * h },
      ],
      2,
      4,
    );
  pen.stroke({ color: INK.muted, width: 0.8, alpha: 0.6 });
  dashPolyline(
    pen,
    [
      { x: x0, y: top },
      { x: x1, y: top },
    ],
    7,
    3,
  );
  pen.stroke({ color: REPLAY.window, width: 1.3, alpha: 0.85 });
}

/** A lane's line from x0 to x1; subagent lanes are thinner. */
export function drawLaneLine(pen: Pen, x0: number, x1: number, y: number, depth: number): void {
  pen.moveTo(x0, y);
  pen.lineTo(x1, y);
  pen.stroke({
    color: INK.primary,
    width: depth === 0 ? 1.6 : 1.1,
    alpha: depth === 0 ? 0.7 : 0.5,
  });
}

/** Branch from the parent lane at (x0, y0) down to a child lane at (x1, y1), as an ink curve. */
export function drawBranch(pen: Pen, x0: number, y0: number, x1: number, y1: number): void {
  const mid = (y0 + y1) / 2;
  pen.moveTo(x0, y0);
  pen.bezierCurveTo(x0, mid, x1, mid, x1, y1);
  pen.stroke({ color: INK.primary, width: 1, alpha: 0.45 });
}

export function drawPlayhead(pen: Pen, x: number, y0: number, y1: number): void {
  pen.moveTo(x, y0);
  pen.lineTo(x, y1);
  pen.stroke({ color: INK.primary, width: 1.6, alpha: 0.9 });
  pen.poly([x - 5, y0 - 6, x + 5, y0 - 6, x, y0]);
  pen.fill({ color: INK.primary });
}
