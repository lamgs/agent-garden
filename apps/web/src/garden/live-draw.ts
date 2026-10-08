/**
 * Live-layer ink marks (encodings `live.*`). Same pen interface as the garden and the legend, so a
 * legend swatch is exactly what the overlay draws. Abstract on purpose: thin ink lines, one accent
 * color per meaning (context bins from REPLAY.context, amber for "needs you", red for errors).
 */
import { INK, PAPER, REPLAY, STATUS, WATER } from '@garden/core';
import { mix } from './color';
import { dashPolyline, drawBee } from './draw';
import type { Pen } from './pen';
import type { Pt } from './layout';
import type { GlyphKind } from '../live/overlay-model';

const ink = (width = 1.1, alpha = 0.85) => ({
  color: INK.primary,
  width,
  alpha,
  cap: 'round' as const,
  join: 'round' as const,
});

/** Ring geometry around a plant base. */
export const RING = { rx: 31, ry: 9, dy: 1 } as const;
/** Tag (activity / attention) above the plant top. */
export const TAG = { r: 8.5, lift: 24 } as const;
export const ATTENTION_INK = mix(STATUS.warning, INK.primary, 0.45);
export const ATTENTION_FILL = mix(STATUS.warning, PAPER, 0.55);

/** Point on the ring at turn fraction t (0 = front center, clockwise on screen). */
export function ringPoint(
  cx: number,
  cy: number,
  t: number,
  rx: number = RING.rx,
  ry: number = RING.ry,
): Pt {
  const a = Math.PI / 2 + t * Math.PI * 2;
  return { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry };
}

function ringArc(cx: number, cy: number, t0: number, t1: number, rx: number, ry: number): Pt[] {
  const n = Math.max(2, Math.ceil(Math.abs(t1 - t0) * 64));
  return Array.from({ length: n + 1 }, (_, i) =>
    ringPoint(cx, cy, t0 + ((t1 - t0) * i) / n, rx, ry),
  );
}

function strokePts(pen: Pen, pts: Pt[]): void {
  pen.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) pen.lineTo(pts[i]!.x, pts[i]!.y);
}

/**
 * `live.ring`: hairline track + an arc of length `fill` (0..1) in the context-bin color.
 * Level 3 (idle or done) draws a faint track and a faint arc.
 */
export function drawLiveRing(
  pen: Pen,
  cx: number,
  cy: number,
  fill: number,
  level: number,
  rx: number = RING.rx,
  ry: number = RING.ry,
  lw = 1,
): void {
  const faint = level >= 3;
  strokePts(pen, ringArc(cx, cy, 0, 1, rx, ry));
  pen.stroke({ color: INK.primary, width: 0.7 * lw, alpha: faint ? 0.18 : 0.32 });
  const f = Math.max(0.015, Math.min(1, fill));
  const color = faint ? INK.muted : (REPLAY.context[Math.min(2, level)] ?? REPLAY.context[0]);
  strokePts(pen, ringArc(cx, cy, 0, f, rx, ry));
  pen.stroke({ color, width: (faint ? 1.4 : 2.4) * lw, alpha: faint ? 0.45 : 0.95, cap: 'round' });
  // start notch at the front, so the direction of growth reads
  const p = ringPoint(cx, cy, 0, rx, ry);
  pen.moveTo(p.x, p.y - 3 * lw);
  pen.lineTo(p.x, p.y + 3 * lw);
  pen.stroke({ color: INK.primary, width: 0.9 * lw, alpha: faint ? 0.3 : 0.7 });
}

/** `live.compaction`: a short cut across the ring where it stood before compaction. */
export function drawCompactionCut(
  pen: Pen,
  cx: number,
  cy: number,
  atFill: number,
  alpha = 1,
  rx: number = RING.rx,
  ry: number = RING.ry,
): void {
  const p = ringPoint(cx, cy, atFill, rx, ry);
  const dx = p.x - cx;
  const dy = (p.y - cy) * (rx / ry);
  const L = Math.hypot(dx, dy) || 1;
  const ux = dx / L;
  const uy = dy / L;
  pen.moveTo(p.x - ux * 6 - uy * 2, p.y - uy * 4 + ux * 1);
  pen.lineTo(p.x + ux * 6 + uy * 2, p.y + uy * 4 - ux * 1);
  pen.stroke({ color: INK.primary, width: 1.6, alpha: 0.9 * alpha, cap: 'round' });
  // the scissor-cut gap: a paper notch over the ring beside the cut
  pen.circle(p.x, p.y, 1.7);
  pen.fill({ color: PAPER, alpha });
}

/** `live.error`: n red ticks on the ring's front-right, bold when the newest event was the error. */
export function drawErrorTicks(
  pen: Pen,
  cx: number,
  cy: number,
  n: number,
  bold: boolean,
  rx: number = RING.rx,
  ry: number = RING.ry,
  lw = 1,
): void {
  const k = Math.min(3, n);
  for (let i = 0; i < k; i++) {
    const p = ringPoint(cx, cy, 0.86 - i * 0.05, rx, ry);
    pen.moveTo(p.x - 1.6 * lw, p.y + 3.4 * lw);
    pen.lineTo(p.x + 1.6 * lw, p.y - 3.4 * lw);
  }
  pen.stroke({ color: STATUS.critical, width: (bold ? 2.1 : 1.5) * lw, alpha: 1, cap: 'round' });
}

/** Paper tag with a hairline rim (the activity mark sits inside). */
function tag(pen: Pen, x: number, y: number, r: number): void {
  pen.circle(x, y, r);
  pen.fill({ color: PAPER, alpha: 0.96 });
  pen.stroke({ color: INK.primary, width: 0.8, alpha: 0.55 });
}

/** `live.activity`: an ink mark in a small tag. `s` scales the mark (tag radius TAG.r × s). */
export function drawActivityGlyph(pen: Pen, x: number, y: number, kind: GlyphKind, s = 1): void {
  tag(pen, x, y, TAG.r * s);
  const P = (px: number, py: number): [number, number] => [x + px * s, y + py * s];
  const mv = (px: number, py: number) => pen.moveTo(...P(px, py));
  const ln = (px: number, py: number) => pen.lineTo(...P(px, py));
  const qd = (cx: number, cy: number, px: number, py: number) =>
    pen.quadraticCurveTo(...P(cx, cy), ...P(px, py));
  const w = 1.05 * s;
  switch (kind) {
    case 'thinking': {
      // a loose spiral
      const pts: Pt[] = [];
      for (let i = 0; i <= 28; i++) {
        const t = i / 28;
        const a = t * Math.PI * 3.2;
        const r = 0.6 + t * 4.4;
        pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
      }
      mv(pts[0]!.x, pts[0]!.y);
      for (const p of pts.slice(1)) ln(p.x, p.y);
      break;
    }
    case 'reading':
      // an open page: two leaves meeting at a spine
      mv(0, -3.2);
      qd(-2.6, -4.6, -5.2, -3.4);
      ln(-5.2, 3.4);
      qd(-2.6, 2.2, 0, 3.6);
      ln(0, -3.2);
      qd(2.6, -4.6, 5.2, -3.4);
      ln(5.2, 3.4);
      qd(2.6, 2.2, 0, 3.6);
      break;
    case 'searching':
      pen.circle(...P(-1, -1), 3.2 * s);
      pen.stroke(ink(w));
      mv(1.4, 1.4);
      ln(4.6, 4.6);
      break;
    case 'editing':
      // a nib: diagonal stroke with a split tip and a short written line
      mv(4.4, -4.4);
      ln(-2.4, 2.4);
      ln(-3.6, 3.6);
      mv(2.6, -5);
      ln(5, -2.6);
      mv(-4.6, 4.8);
      ln(0.6, 4.8);
      break;
    case 'running':
      // prompt chevron and cursor
      mv(-4.4, -3.2);
      ln(-1, 0);
      ln(-4.4, 3.2);
      mv(0.8, 3.4);
      ln(4.8, 3.4);
      break;
    case 'web':
      pen.circle(x, y, 4.8 * s);
      pen.stroke(ink(w));
      pen.ellipse(x, y, 2 * s, 4.8 * s);
      pen.stroke(ink(w * 0.8, 0.7));
      mv(-4.8, 0);
      ln(4.8, 0);
      break;
    case 'mcp':
      // a plug: two prongs, a body, a cord
      mv(-1.8, -5);
      ln(-1.8, -2.4);
      mv(1.8, -5);
      ln(1.8, -2.4);
      mv(-3.4, -2.4);
      ln(3.4, -2.4);
      ln(3.4, 0.4);
      qd(3.4, 2.4, 0, 2.6);
      qd(-3.4, 2.4, -3.4, 0.4);
      ln(-3.4, -2.4);
      mv(0, 2.6);
      qd(0, 5, 2.6, 5.2);
      break;
    case 'skill':
      // a tiny seed packet (the care-card shape)
      mv(-3.6, -4.2);
      ln(3.6, -4.2);
      ln(3.6, 4.4);
      ln(-3.6, 4.4);
      ln(-3.6, -4.2);
      mv(-3.6, -1.8);
      ln(3.6, -1.8);
      pen.stroke(ink(w));
      pen.circle(x, y + 1.4 * s, 1.1 * s);
      pen.fill({ color: INK.primary, alpha: 0.75 });
      return;
    case 'delegating':
      // a fork: one line splitting in two, the second ending in a dot
      mv(-4.6, 0);
      ln(-1, 0);
      qd(1, 0, 2.2, -3.2);
      ln(4.4, -3.6);
      mv(-1, 0);
      qd(1, 0, 2.2, 3.2);
      ln(4.4, 3.6);
      pen.stroke(ink(w));
      pen.circle(...P(4.6, 3.6), 1.2 * s);
      pen.fill({ color: INK.primary, alpha: 0.85 });
      return;
    case 'compacting':
      // two arrows closing on a bar
      mv(-5, 0);
      ln(-1.6, 0);
      mv(-3.4, -1.8);
      ln(-1.6, 0);
      ln(-3.4, 1.8);
      mv(5, 0);
      ln(1.6, 0);
      mv(3.4, -1.8);
      ln(1.6, 0);
      ln(3.4, 1.8);
      mv(0, -4);
      ln(0, 4);
      break;
    case 'done':
      mv(-3.8, 0.2);
      ln(-1, 3);
      ln(4, -3.2);
      break;
  }
  pen.stroke(ink(w));
}

/**
 * `live.attention`: amber tag with "!" (permission) or "?" (input). Solid rim when recorded,
 * dashed when inferred. Slightly larger than the activity tag so it wins at a glance.
 */
export function drawAttentionTag(
  pen: Pen,
  x: number,
  y: number,
  reason: 'waiting_permission' | 'waiting_input',
  inferred: boolean,
  s = 1,
): void {
  const r = 10.5 * s;
  pen.circle(x, y, r);
  pen.fill({ color: ATTENTION_FILL, alpha: 0.95 });
  if (inferred) {
    const pts = Array.from({ length: 49 }, (_, i) => {
      const a = (i / 48) * Math.PI * 2;
      return { x: x + Math.cos(a) * r, y: y + Math.sin(a) * r };
    });
    dashPolyline(pen, pts, 3.2 * s, 2.4 * s);
    pen.stroke({ color: ATTENTION_INK, width: 1.6, alpha: 1, cap: 'butt' });
  } else {
    pen.circle(x, y, r);
    pen.stroke({ color: ATTENTION_INK, width: 1.8, alpha: 1 });
  }
  if (reason === 'waiting_permission') {
    pen.moveTo(x, y - 5.4 * s);
    pen.lineTo(x, y + 1.6 * s);
    pen.stroke({ color: INK.primary, width: 1.7 * s, alpha: 0.95, cap: 'round' });
  } else {
    pen.moveTo(x - 3 * s, y - 2.8 * s);
    pen.quadraticCurveTo(x - 2.6 * s, y - 6 * s, x, y - 6 * s);
    pen.quadraticCurveTo(x + 3.2 * s, y - 6 * s, x + 3 * s, y - 2.8 * s);
    pen.quadraticCurveTo(x + 2.6 * s, y - 0.9 * s, x, y + 0.2 * s);
    pen.lineTo(x, y + 1.6 * s);
    pen.stroke({ color: INK.primary, width: 1.5 * s, alpha: 0.95, cap: 'round' });
  }
  pen.circle(x, y + 4.6 * s, 1.15 * s);
  pen.fill({ color: INK.primary, alpha: 0.95 });
}

/** `live.count`: pips to the right of the tag, one per extra live run (max three). */
export function drawCountPips(pen: Pen, x: number, y: number, count: number): void {
  const n = Math.min(3, Math.max(0, count - 1));
  for (let i = 0; i < n; i++) {
    pen.circle(x, y - 4 + i * 4, 1.4);
    pen.fill({ color: INK.primary, alpha: 0.8 });
  }
}

/** `live.seedling`: a two-leaf sprout in ink with a small soil mound. */
export function drawSeedling(pen: Pen, x: number, y: number, s = 1): void {
  pen.ellipse(x, y + 1, 9 * s, 2.4 * s);
  pen.fill({ color: INK.hairline, alpha: 0.8 });
  pen.moveTo(x, y);
  pen.quadraticCurveTo(x - 1 * s, y - 7 * s, x, y - 13 * s);
  pen.stroke(ink(1.2 * s));
  pen.moveTo(x, y - 11 * s);
  pen.quadraticCurveTo(x - 7 * s, y - 16 * s, x - 9 * s, y - 11 * s);
  pen.quadraticCurveTo(x - 5 * s, y - 8 * s, x, y - 11 * s);
  pen.fill({ color: PAPER, alpha: 0.95 });
  pen.stroke(ink(1 * s));
  pen.moveTo(x, y - 12 * s);
  pen.quadraticCurveTo(x + 6 * s, y - 19 * s, x + 9 * s, y - 15 * s);
  pen.quadraticCurveTo(x + 5 * s, y - 10 * s, x, y - 12 * s);
  pen.fill({ color: PAPER, alpha: 0.95 });
  pen.stroke(ink(1 * s));
}

/** A small "new" flag beside a seedling (the overlay adds the text label). */
export function drawNewFlag(pen: Pen, x: number, y: number, w = 24): void {
  pen.roundRect(x, y - 6, w, 12, 6);
  pen.fill({ color: PAPER, alpha: 0.95 });
  dashPolyline(
    pen,
    [
      { x: x + 6, y: y - 6 },
      { x: x + w - 6, y: y - 6 },
    ],
    2,
    2,
  );
  pen.stroke({ color: INK.primary, width: 0.8, alpha: 0.5 });
  pen.roundRect(x, y - 6, w, 12, 6);
  pen.stroke({ color: INK.primary, width: 0.8, alpha: 0.55 });
}

/** Quadratic flight arc between two points (bulging upward). */
export function flightControl(a: Pt, b: Pt): Pt {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  return { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - Math.max(24, d * 0.32) };
}

export function quadPoint(a: Pt, c: Pt, b: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
  };
}

/** `live.bee`: the bee plus a thin trail of where it has flown (out or back). */
export function drawLiveBee(
  pen: Pen,
  a: Pt,
  b: Pt,
  t: number,
  phase: 'out' | 'hover' | 'back',
  s = 1.45,
): Pt {
  const c = flightControl(a, b);
  // `t` is 0 at the parent, 1 at the child.
  const p = quadPoint(a, c, b, t);
  if (phase !== 'hover') {
    const from = phase === 'out' ? 0 : 1;
    const n = 16;
    const pts = Array.from({ length: n + 1 }, (_, i) =>
      quadPoint(a, c, b, from + ((t - from) * i) / n),
    );
    dashPolyline(pen, pts, 1.4, 2.8);
    pen.stroke({ color: INK.primary, width: 0.9, alpha: 0.55 });
  } else {
    // a hover halo: a small hairline circle under the bee
    pen.circle(p.x, p.y + 1, 6.5);
    pen.stroke({ color: INK.primary, width: 0.7, alpha: 0.4 });
  }
  const q = quadPoint(a, c, b, Math.min(1, Math.max(0, t + (phase === 'back' ? -0.02 : 0.02))));
  const heading = phase === 'hover' ? 0 : Math.atan2(q.y - p.y, q.x - p.x) * 0.25;
  drawBee(pen, p.x, p.y, s, heading);
  return p;
}

/** `live.loop_pulse`: a bright segment of water travelling along a channel at distance `d`. */
export function drawPulseSegment(pen: Pen, pts: Pt[], d: number, len: number, alpha = 1): void {
  const seg: Pt[] = [];
  let acc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    const s0 = Math.max(d - len, acc);
    const s1 = Math.min(d, acc + L);
    if (s1 > s0 && L > 0) {
      const f0 = (s0 - acc) / L;
      const f1 = (s1 - acc) / L;
      if (!seg.length) seg.push({ x: a.x + (b.x - a.x) * f0, y: a.y + (b.y - a.y) * f0 });
      seg.push({ x: a.x + (b.x - a.x) * f1, y: a.y + (b.y - a.y) * f1 });
    }
    acc += L;
  }
  if (seg.length < 2) return;
  strokePts(pen, seg);
  pen.stroke({ color: WATER.flow, width: 7, alpha: 0.35 * alpha, cap: 'round' });
  strokePts(pen, seg);
  pen.stroke({ color: PAPER, width: 2.4, alpha: 0.95 * alpha, cap: 'round' });
}

/** Reduced-motion pulse: the whole channel lit once. */
export function drawChannelLit(pen: Pen, pts: Pt[], alpha = 1): void {
  strokePts(pen, pts);
  pen.stroke({ color: WATER.flow, width: 7, alpha: 0.3 * alpha, cap: 'round' });
  strokePts(pen, pts);
  pen.stroke({ color: PAPER, width: 1.6, alpha: 0.8 * alpha, cap: 'round' });
}
