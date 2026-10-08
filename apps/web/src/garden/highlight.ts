/**
 * Router highlight drawing (encoding `router.highlight`): a sunlight halo behind a suggested
 * plant, the badge plaque its confidence sits on, and the veil that dims everything else.
 * Pen-based, so the legend swatch is drawn by the same code as the garden.
 */
import { HIGHLIGHT, INK, PAPER } from '@garden/core';
import type { Pen } from './pen';

/** Halo around a plant whose base is at (x, y) and whose top is `height` above it. */
export function drawGlow(pen: Pen, x: number, y: number, height: number): void {
  const cy = y - height * 0.45;
  const rx = 30;
  const ry = Math.max(30, height * 0.62);
  for (const [k, a] of [
    [1.25, 0.12],
    [1, 0.2],
    [0.72, 0.28],
  ] as const) {
    pen.ellipse(x, cy, rx * k, ry * k);
    pen.fill({ color: HIGHLIGHT.glow, alpha: a });
  }
  pen.ellipse(x, y + 1, 30, 8);
  pen.stroke({ color: HIGHLIGHT.glow, width: 2.2, alpha: 0.95 });
}

/** Badge plaque centered at (x, y): ink pill with a glow rim. The text is drawn on top by the caller. */
export function drawBadge(pen: Pen, x: number, y: number, w: number, h = 15): void {
  pen.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
  pen.fill({ color: INK.primary, alpha: 0.92 });
  pen.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
  pen.stroke({ color: HIGHLIGHT.glow, width: 1.4 });
}

/** The dimming veil over a rectangle (everything that is not a suggestion). */
export function drawVeil(pen: Pen, x: number, y: number, w: number, h: number): void {
  pen.rect(x, y, w, h);
  pen.fill({ color: PAPER, alpha: HIGHLIGHT.veilAlpha });
}
