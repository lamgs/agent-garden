/**
 * Knowledge map (K) drawing: soil blocks per knowledge source, roots between them, and sprouts for
 * usage. Pen-based, so the knowledge page (via SvgPen) and the legend swatches (via CanvasPen) run
 * the same code. Levels come from the registry (knowledge.column / size / edge / usage).
 */
import { COST_RAMP, INK, PAPER, SOIL, STATUS } from '@garden/core';
import { mix } from './color';
import { dashPolyline } from './draw';
import type { Pen } from './pen';

export interface Pt {
  x: number;
  y: number;
}

/** Block height for a source of `tokens` approximate tokens (sqrt so small files stay visible). */
export function blockHeight(tokens: number): number {
  return Math.round(Math.max(16, Math.min(96, 8 + Math.sqrt(Math.max(0, tokens)) * 0.95)));
}

/**
 * One knowledge source as a block, by knowledge.column level:
 * 0 topsoil (always loaded): soil band, alternate shade by `band`;
 * 1 seed tray (on demand): paper with seed dots;
 * 2 seed tray, path-scoped rule: paper with a glob tag;
 * 3 compost (not loaded): hatched, muted.
 */
export function drawSourceBlock(
  pen: Pen,
  x: number,
  y: number,
  w: number,
  h: number,
  column: number,
  band = 0,
  highlight = false,
): void {
  if (column === 0) {
    pen.roundRect(x, y, w, h, 3);
    pen.fill({ color: band % 2 === 0 ? SOIL.strata : mix(SOIL.strata, INK.secondary, 0.14) });
    pen.stroke({ color: INK.primary, width: 0.9, alpha: 0.55 });
  } else if (column === 1 || column === 2) {
    pen.roundRect(x, y, w, h, 3);
    pen.fill({ color: PAPER });
    pen.stroke({ color: SOIL.rim, width: 1.1 });
    for (let i = 0; i < 3; i++) pen.circle(x + w - 40 + i * 4, y + h - 5, 1.1);
    pen.fill({ color: SOIL.speck });
    if (column === 2) {
      pen.poly([
        x + w - 16,
        y + 3,
        x + w - 5,
        y + 3,
        x + w - 3,
        y + 6,
        x + w - 5,
        y + 9,
        x + w - 16,
        y + 9,
      ]);
      pen.fill({ color: SOIL.fill });
      pen.stroke({ color: INK.secondary, width: 0.7 });
      pen.moveTo(x + w - 13, y + 6);
      pen.lineTo(x + w - 8, y + 6);
      pen.stroke({ color: INK.secondary, width: 0.7 });
    }
  } else {
    pen.roundRect(x, y, w, h, 3);
    pen.fill({ color: SOIL.fill, alpha: 0.7 });
    // Diagonal hatch: lines x' + y' = k clipped to the block.
    for (let k = 7; k < w + h; k += 7) {
      pen.moveTo(x + Math.max(0, k - h), y + Math.min(h, k));
      pen.lineTo(x + Math.min(w, k), y + Math.max(0, k - w));
    }
    pen.stroke({ color: SOIL.rim, width: 0.7, alpha: 0.8 });
    pen.roundRect(x, y, w, h, 3);
    pen.stroke({ color: INK.muted, width: 0.8, alpha: 0.7 });
  }
  if (highlight) {
    pen.roundRect(x - 2, y - 2, w + 4, h + 4, 4);
    pen.stroke({ color: STATUS.warning, width: 2.2 });
  }
}

/** Points along a horizontal S-curve from a to b (for roots). */
export function rootCurve(a: Pt, b: Pt, steps = 24): Pt[] {
  const mx = (a.x + b.x) / 2;
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push({
      x: u * u * u * a.x + 3 * u * u * t * mx + 3 * u * t * t * mx + t * t * t * b.x,
      y: u * u * u * a.y + 3 * u * u * t * a.y + 3 * u * t * t * b.y + t * t * t * b.y,
    });
  }
  return out;
}

/** A reference, by knowledge.edge level: 0 resolved (ink), 1 dangling (red dashed + ×), 2 past the MEMORY.md cap (faint dotted). */
export function drawRoot(pen: Pen, pts: readonly Pt[], level: number): void {
  if (pts.length < 2) return;
  if (level === 0) {
    pen.moveTo(pts[0]!.x, pts[0]!.y);
    for (const p of pts.slice(1)) pen.lineTo(p.x, p.y);
    pen.stroke({ color: INK.primary, width: 1.1, alpha: 0.55 });
    const e = pts[pts.length - 1]!;
    pen.circle(e.x, e.y, 2);
    pen.fill({ color: INK.primary, alpha: 0.55 });
  } else if (level === 1) {
    dashPolyline(pen, [...pts], 4, 3);
    pen.stroke({ color: STATUS.critical, width: 1.4 });
    const e = pts[pts.length - 1]!;
    pen.moveTo(e.x - 4, e.y - 4);
    pen.lineTo(e.x + 4, e.y + 4);
    pen.moveTo(e.x + 4, e.y - 4);
    pen.lineTo(e.x - 4, e.y + 4);
    pen.stroke({ color: STATUS.critical, width: 1.8 });
  } else {
    dashPolyline(pen, [...pts], 1.2, 3.2);
    pen.stroke({ color: INK.muted, width: 1.1, alpha: 0.6 });
  }
}

/** knowledge.usage level: 0 sprout (loaded in the window), 1 bare soil (no load seen), 2 always loaded (strata mark). */
export function drawSprout(pen: Pen, x: number, y: number, level: number): void {
  if (level === 0) {
    pen.moveTo(x, y);
    pen.lineTo(x, y - 9);
    pen.stroke({ color: COST_RAMP[2], width: 1.2 });
    for (const s of [-1, 1]) {
      pen.moveTo(x, y - 6);
      pen.quadraticCurveTo(x + s * 6, y - 11, x + s * 7, y - 6);
      pen.quadraticCurveTo(x + s * 3, y - 4, x, y - 6);
    }
    pen.fill({ color: COST_RAMP[1] });
    pen.stroke({ color: COST_RAMP[3], width: 0.6 });
  } else if (level === 1) {
    pen.ellipse(x, y - 2, 5, 2);
    pen.fill({ color: SOIL.speck, alpha: 0.6 });
    pen.stroke({ color: INK.muted, width: 0.8 });
  } else {
    for (let i = 0; i < 3; i++) {
      pen.moveTo(x - 5, y - 2 - i * 3);
      pen.lineTo(x + 5, y - 2 - i * 3);
    }
    pen.stroke({ color: INK.secondary, width: 1 });
  }
}
