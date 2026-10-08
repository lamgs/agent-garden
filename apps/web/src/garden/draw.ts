/**
 * Procedural, ink-line botanical drawing. Every function takes encoding LEVELS (from the registry's
 * `level()` functions) and maps them to geometry; no metric is binned here. The same functions draw
 * the garden (into Pixi Graphics → cached textures) and the legend swatches (into a 2D canvas).
 */
import {
  BLOOM,
  COST_RAMP,
  COST_UNKNOWN,
  INK,
  PAPER,
  SOIL,
  STALE,
  STATUS,
  WATER,
  WEED,
} from '@garden/core';
import { mix } from './color';
import type { Genotype } from './genotype';
import type { Pen } from './pen';

export const INK_LINE = { color: INK.primary, alpha: 0.7, width: 1.1 } as const;
const inkLine = (width: number = INK_LINE.width, alpha: number = INK_LINE.alpha) => ({
  color: INK.primary,
  width,
  alpha,
});

// ---- level → geometry tables (visual mapping only; bins live in the registry) -------------

/** Stem length (world px) per plant.height level. */
export const STEM_LENGTH = [20, 44, 70, 98, 128] as const;
/** Leaves per plant.height level. */
const LEAF_COUNT = [2, 3, 5, 7, 9] as const;
/** Total turning of the stem tip (radians from vertical) per plant.droop level. */
export const DROOP_TURN = [0.1, 0.8, 2.0] as const;
/** Flowers and openness per plant.bloom level (level 0 = hollow bud). */
export const BLOOM_FLOWERS = [0, 1, 1, 2, 3, 4] as const;
export const BLOOM_OPENNESS = [0, 0.12, 0.42, 0.65, 0.85, 1] as const;
/** Mix toward dry straw per plant.fade level. */
export const FADE_MIX = [0, 0.5, 0.82] as const;
/** Seed-packet width per care_card.size level. */
export const PACKET_WIDTH = [7, 9, 11.5, 14] as const;
/** Channel width and flow speed (px/s) per irrigation.flow level. */
export const CHANNEL_WIDTH = [1.6, 2.6, 3.8, 5.4] as const;
export const FLOW_SPEED = [6, 14, 28, 48] as const;
/** Soil speck density (specks per 1000 px²) per bed.texture level. */
export const SPECK_DENSITY = [0.4, 1.3, 2.8, 5.2] as const;

/** Plant texture frame, relative to the plant base at (0, 0). */
export const PLANT_FRAME = { x: -86, y: -182, w: 172, h: 198 } as const;

export function foliageColor(hue: number, fade: number): string {
  const base = hue === 0 ? COST_UNKNOWN : (COST_RAMP[hue - 1] ?? COST_RAMP[0]);
  return mix(base, STALE.straw, FADE_MIX[fade] ?? 0);
}

// ---- deterministic randomness ------------------------------------------------------------

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- geometry helpers --------------------------------------------------------------------

interface Pt {
  x: number;
  y: number;
}

/** Point at distance `d` from (x, y) in direction `a` (radians; 0 = up, positive = clockwise). */
function toward(x: number, y: number, a: number, d: number): Pt {
  return { x: x + Math.sin(a) * d, y: y - Math.cos(a) * d };
}

/** Stem as a curve whose bend concentrates near the top (drooping heads bend over). */
export function stemPoints(length: number, turn: number, segments = 14): (Pt & { a: number })[] {
  const pts: (Pt & { a: number })[] = [{ x: 0, y: 0, a: 0 }];
  const ds = length / segments;
  let x = 0;
  let y = 0;
  for (let i = 1; i <= segments; i++) {
    const s = (i - 0.5) / segments;
    const a = turn * Math.pow(s, 2.2);
    x += Math.sin(a) * ds;
    y -= Math.cos(a) * ds;
    pts.push({ x, y, a: turn * Math.pow(i / segments, 2.2) });
  }
  return pts;
}

function strokePolyline(pen: Pen, pts: Pt[]): void {
  pen.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i]!.x + pts[i + 1]!.x) / 2;
    const my = (pts[i]!.y + pts[i + 1]!.y) / 2;
    pen.quadraticCurveTo(pts[i]!.x, pts[i]!.y, mx, my);
  }
  const last = pts[pts.length - 1]!;
  pen.lineTo(last.x, last.y);
}

/** Dashed polyline: emits dash segments into the current path (caller strokes). */
export function dashPolyline(pen: Pen, pts: Pt[], dash: number, gap: number, offset = 0): void {
  const period = dash + gap;
  let pos = -(((offset % period) + period) % period);
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    let t = pos;
    while (t < len) {
      const s = Math.max(0, t);
      const e = Math.min(len, t + dash);
      if (e > s) {
        pen.moveTo(a.x + ux * s, a.y + uy * s);
        pen.lineTo(a.x + ux * e, a.y + uy * e);
      }
      t += period;
    }
    pos = t - len;
  }
}

export function polylineLength(pts: Pt[]): number {
  let L = 0;
  for (let i = 0; i + 1 < pts.length; i++)
    L += Math.hypot(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.y - pts[i]!.y);
  return L;
}

export function pointAlong(pts: Pt[], d: number): Pt {
  let rem = d;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (rem <= len && len > 0)
      return { x: a.x + ((b.x - a.x) * rem) / len, y: a.y + ((b.y - a.y) * rem) / len };
    rem -= len;
  }
  return pts[pts.length - 1]!;
}

/** A pen that maps coordinates by translate + uniform scale (stroke widths unchanged). */
export function transformPen(pen: Pen, tx: number, ty: number, k: number): Pen {
  const X = (x: number) => tx + x * k;
  const Y = (y: number) => ty + y * k;
  return {
    moveTo: (x, y) => pen.moveTo(X(x), Y(y)),
    lineTo: (x, y) => pen.lineTo(X(x), Y(y)),
    quadraticCurveTo: (a, b, x, y) => pen.quadraticCurveTo(X(a), Y(b), X(x), Y(y)),
    bezierCurveTo: (a, b, c, d, x, y) => pen.bezierCurveTo(X(a), Y(b), X(c), Y(d), X(x), Y(y)),
    circle: (x, y, r) => pen.circle(X(x), Y(y), r * k),
    ellipse: (x, y, rx, ry) => pen.ellipse(X(x), Y(y), rx * k, ry * k),
    rect: (x, y, w, h) => pen.rect(X(x), Y(y), w * k, h * k),
    roundRect: (x, y, w, h, r) => pen.roundRect(X(x), Y(y), w * k, h * k, r * k),
    poly: (pts, close) =>
      pen.poly(
        pts.map((v, i) => (i % 2 === 0 ? X(v) : Y(v))),
        close,
      ),
    closePath: () => pen.closePath(),
    fill: (st) => pen.fill(st),
    stroke: (st) => pen.stroke(st),
  };
}

// ---- plant parts -------------------------------------------------------------------------

function leafPath(
  pen: Pen,
  x: number,
  y: number,
  a: number,
  len: number,
  w: number,
  from = 0,
  to = 1,
) {
  // Almond leaf from base (x,y) along angle a. Optionally only the segment [from, to] of its length.
  const tip = toward(x, y, a, len * to);
  const base = toward(x, y, a, len * from);
  const nx = Math.cos(a);
  const ny = Math.sin(a);
  const mid1 = toward(x, y, a, len * (from + (to - from) * 0.45));
  const half = (to - from < 1 ? 0.55 : 1) * w;
  pen.moveTo(base.x, base.y);
  pen.quadraticCurveTo(mid1.x + nx * half, mid1.y + ny * half, tip.x, tip.y);
  pen.quadraticCurveTo(mid1.x - nx * half, mid1.y - ny * half, base.x, base.y);
  pen.closePath();
}

export function drawLeaf(
  pen: Pen,
  x: number,
  y: number,
  a: number,
  len: number,
  color: string,
  opts: { tip?: number; hatch?: boolean } = {},
): void {
  const w = len * 0.36;
  leafPath(pen, x, y, a, len, w);
  pen.fill({ color, alpha: 0.95 });
  pen.stroke(inkLine());
  if (opts.tip && opts.tip > 0) {
    leafPath(pen, x, y, a, len, w, 1 - opts.tip, 1);
    pen.fill({ color: STALE.tip, alpha: 0.9 });
  }
  if (opts.hatch) {
    // Unpriced: diagonal hatch across the blade (non-color cue for "unknown cost").
    for (const f of [0.3, 0.5, 0.7]) {
      const c = toward(x, y, a, len * f);
      const h = w * 0.55;
      const d = a + Math.PI / 3;
      pen.moveTo(c.x - Math.cos(d) * h, c.y - Math.sin(d) * h);
      pen.lineTo(c.x + Math.cos(d) * h, c.y + Math.sin(d) * h);
    }
    pen.stroke({ color: INK.secondary, width: 0.8, alpha: 0.8 });
  }
  // midrib
  const m0 = toward(x, y, a, len * 0.12);
  const m1 = toward(x, y, a, len * 0.82);
  pen.moveTo(m0.x, m0.y);
  pen.lineTo(m1.x, m1.y);
  pen.stroke(inkLine(0.6, 0.45));
}

function petalPath(pen: Pen, cx: number, cy: number, a: number, len: number, w: number) {
  const tip = toward(cx, cy, a, len);
  const mid = toward(cx, cy, a, len * 0.55);
  const nx = Math.cos(a);
  const ny = Math.sin(a);
  pen.moveTo(cx, cy);
  pen.bezierCurveTo(
    mid.x + nx * w,
    mid.y + ny * w,
    tip.x + nx * w * 0.5,
    tip.y + ny * w * 0.5,
    tip.x,
    tip.y,
  );
  pen.bezierCurveTo(
    tip.x - nx * w * 0.5,
    tip.y - ny * w * 0.5,
    mid.x - nx * w,
    mid.y - ny * w,
    cx,
    cy,
  );
  pen.closePath();
}

/** A flower facing direction `dir`; openness 0..1 spreads the petals from a closed bud to a disc. */
export function drawFlower(
  pen: Pen,
  cx: number,
  cy: number,
  dir: number,
  openness: number,
  size: number,
  petal: string = BLOOM.petal,
  center: string = BLOOM.center,
): void {
  const n = 5;
  const spread = 0.16 + (Math.PI * 2 * 0.2 - 0.16) * openness; // angle between petals
  const len = size * (0.62 + 0.38 * openness) * (openness < 0.3 ? 1.15 : 1);
  const w = size * (0.22 + 0.16 * openness);
  const order = [0, 4, 1, 3, 2];
  for (const i of order) {
    const a = dir + (i - (n - 1) / 2) * spread;
    petalPath(pen, cx, cy, a, len, w);
    pen.fill({ color: petal, alpha: 0.96 });
    pen.stroke(inkLine(0.9));
  }
  if (openness >= 0.35) {
    pen.circle(cx, cy, size * (0.14 + 0.12 * openness));
    pen.fill({ color: center });
    pen.stroke(inkLine(0.7, 0.6));
  } else {
    // sepal cup under a closed bud
    const s1 = toward(cx, cy, dir + 2.6, size * 0.35);
    const s2 = toward(cx, cy, dir - 2.6, size * 0.35);
    pen.moveTo(s1.x, s1.y);
    pen.quadraticCurveTo(cx, cy + 0.2, s2.x, s2.y);
    pen.stroke(inkLine(0.9, 0.6));
  }
}

/** Hollow bud: too few labeled runs to show a success rate. Outline only, no fill. */
export function drawHollowBud(pen: Pen, cx: number, cy: number, dir: number, size: number): void {
  const tip = toward(cx, cy, dir, size * 1.3);
  const mid = toward(cx, cy, dir, size * 0.6);
  const nx = Math.cos(dir);
  const ny = Math.sin(dir);
  const w = size * 0.55;
  pen.moveTo(cx, cy);
  pen.bezierCurveTo(
    mid.x + nx * w,
    mid.y + ny * w,
    tip.x + nx * w * 0.3,
    tip.y + ny * w * 0.3,
    tip.x,
    tip.y,
  );
  pen.bezierCurveTo(
    tip.x - nx * w * 0.3,
    tip.y - ny * w * 0.3,
    mid.x - nx * w,
    mid.y - ny * w,
    cx,
    cy,
  );
  pen.closePath();
  pen.fill({ color: PAPER, alpha: 0.9 });
  pen.stroke({ color: INK.primary, width: 1.1, alpha: 0.75 });
}

/** The whole plant for a genotype. Base at (0, 0); up is −y. */
export function drawPlant(pen: Pen, g: Genotype): void {
  const L = STEM_LENGTH[g.height] ?? STEM_LENGTH[0];
  const turn = DROOP_TURN[g.droop] ?? 0;
  const foliage = foliageColor(g.hue, g.fade);
  const fadeT = FADE_MIX[g.fade] ?? 0;
  const stemColor = mix(mix(foliage, INK.primary, 0.3), STALE.tip, fadeT * 0.4);
  const petal = mix(BLOOM.petal, STALE.straw, fadeT * 0.75);
  const center = mix(BLOOM.center, STALE.straw, fadeT * 0.6);
  const tipShare = g.fade === 0 ? 0 : g.fade === 1 ? 0.28 : 0.5;
  const hatch = g.hue === 0;
  const pts = stemPoints(L, turn);
  const at = (s: number) => {
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(s * (pts.length - 1))));
    return pts[i]!;
  };

  // ground shadow (constant, not an encoding)
  pen.ellipse(0, 1, 9 + g.height * 1.5, 2.2);
  pen.fill({ color: INK.primary, alpha: 0.08 });

  // stem
  const stemW = 1.6 + g.height * 0.4;
  strokePolyline(pen, pts);
  pen.stroke({ color: INK.primary, width: stemW + 1.4, alpha: 0.55 });
  strokePolyline(pen, pts);
  pen.stroke({ color: stemColor, width: stemW, alpha: 1 });

  // leaves
  const nLeaves = LEAF_COUNT[g.height] ?? 2;
  const leafLen = 12 + g.height * 3;
  if (g.height === 0) {
    drawLeaf(pen, 0, -L * 0.7, -1.05 - g.droop * 0.3, leafLen, foliage, { tip: tipShare, hatch });
    drawLeaf(pen, 0, -L * 0.7, 1.05 + g.droop * 0.3, leafLen, foliage, { tip: tipShare, hatch });
  } else {
    // basal rosette
    for (const side of [-1, 1]) {
      drawLeaf(pen, side * 1.5, -1, side * (1.32 + g.droop * 0.12), leafLen * 1.05, foliage, {
        tip: tipShare,
        hatch,
      });
    }
    for (let i = 0; i < nLeaves; i++) {
      const s = 0.16 + (0.6 * i) / Math.max(1, nLeaves - 1);
      const p = at(s);
      const side = i % 2 === 0 ? -1 : 1;
      const sag = g.droop * 0.32;
      const a = p.a + side * (0.95 + sag) + (side > 0 ? sag * 0.5 : 0);
      const len = leafLen * (1 - s * 0.35);
      drawLeaf(pen, p.x, p.y, a, len, foliage, { tip: tipShare, hatch });
    }
  }

  // flowers
  const tip = pts[pts.length - 1]!;
  const size = 7 + g.height * 1.8;
  if (g.bloom === 0) {
    drawHollowBud(pen, tip.x, tip.y, tip.a, Math.max(3.2, size * 0.7));
    return;
  }
  const open = BLOOM_OPENNESS[g.bloom] ?? 0;
  const count = BLOOM_FLOWERS[g.bloom] ?? 1;
  const extras = [0.72, 0.56, 0.84];
  for (let k = 1; k < count; k++) {
    const p = at(extras[k - 1]!);
    const side = k % 2 === 0 ? 1 : -1;
    const a = p.a + side * 0.9;
    const end = toward(p.x, p.y, a, 7 + g.height * 1.2);
    pen.moveTo(p.x, p.y);
    pen.quadraticCurveTo((p.x + end.x) / 2, (p.y + end.y) / 2 - 2, end.x, end.y);
    pen.stroke({ color: stemColor, width: Math.max(1, stemW * 0.6) });
    drawFlower(pen, end.x, end.y, a * 0.6 + p.a * 0.4, open, size * 0.75, petal, center);
  }
  drawFlower(pen, tip.x, tip.y, tip.a, open, size, petal, center);
}

// ---- other garden elements ----------------------------------------------------------------

/** Seed packet (care card) with its bottom-center at (x, y). */
export function drawPacket(pen: Pen, x: number, y: number, level: number): void {
  const w = PACKET_WIDTH[level] ?? PACKET_WIDTH[0];
  const h = w * 1.3;
  const l = x - w / 2;
  const t = y - h;
  pen.poly([l, t + 2, l + w * 0.5, t, l + w, t + 2, l + w, y, l, y]);
  pen.fill({ color: PAPER });
  pen.stroke(inkLine(0.9, 0.75));
  pen.rect(l + 1.2, t + h * 0.42, w - 2.4, h * 0.3);
  pen.fill({ color: INK.hairline });
  // seed glyph
  pen.circle(x, t + h * 0.57, Math.max(0.9, w * 0.09));
  pen.fill({ color: INK.secondary, alpha: 0.9 });
}

export function drawBee(pen: Pen, x: number, y: number, s = 1, heading = 0): void {
  const c = Math.cos(heading);
  const d = Math.sin(heading);
  const P = (px: number, py: number): [number, number] => [
    x + (px * c - py * d) * s,
    y + (px * d + py * c) * s,
  ];
  const [w1x, w1y] = P(-0.6, -2.3);
  const [w2x, w2y] = P(1.2, -2.1);
  pen.ellipse(w1x, w1y, 1.9 * s, 1.3 * s);
  pen.fill({ color: PAPER, alpha: 0.9 });
  pen.stroke(inkLine(0.6, 0.6));
  pen.ellipse(w2x, w2y, 1.7 * s, 1.2 * s);
  pen.fill({ color: PAPER, alpha: 0.9 });
  pen.stroke(inkLine(0.6, 0.6));
  const [bx, by] = P(0, 0);
  pen.ellipse(bx, by, 3.2 * s, 2.1 * s);
  pen.fill({ color: BLOOM.center });
  pen.stroke(inkLine(0.8, 0.85));
  for (const k of [-0.8, 0.8]) {
    const [ax, ay] = P(k, -1.9);
    const [bx2, by2] = P(k, 1.9);
    pen.moveTo(ax, ay);
    pen.lineTo(bx2, by2);
  }
  pen.stroke({ color: INK.primary, width: 0.9 * s, alpha: 0.85 });
}

/** Weed glyph by weed.kind level: 0 orphan (gone-to-seed rosette), 1 duplicate (twin sprouts), 2 unowned (blank tag). */
export function drawWeed(outer: Pen, x0: number, y0: number, level: number, scale = 1): void {
  // drawn at unit size around the origin, mapped to (x0, y0) × scale
  const pen = transformPen(outer, x0, y0, scale);
  const x = 0;
  const y = 0;
  const leaf = (lx: number, ly: number, a: number, len: number) => {
    const tip = toward(lx, ly, a, len);
    const n = Math.cos(a) * len * 0.3;
    const m = Math.sin(a) * len * 0.3;
    const mid = toward(lx, ly, a, len * 0.5);
    pen.moveTo(lx, ly);
    pen.lineTo(mid.x + n, mid.y + m);
    pen.lineTo(toward(lx, ly, a, len * 0.62).x, toward(lx, ly, a, len * 0.62).y);
    pen.lineTo(tip.x, tip.y);
    pen.lineTo(mid.x - n, mid.y - m);
    pen.closePath();
    pen.fill({ color: WEED.leaf });
    pen.stroke({ color: WEED.mark, width: 0.8, alpha: 0.9 });
  };
  if (level >= 3) {
    drawKnowledgeWeed(pen, level, leaf);
    return;
  }
  if (level === 1) {
    for (const dx of [-3.5, 3.5]) {
      leaf(x + dx, y, -0.5, 7);
      leaf(x + dx, y, 0.5, 7);
      pen.moveTo(x + dx, y);
      pen.lineTo(x + dx, y - 6);
      pen.stroke({ color: WEED.mark, width: 0.9 });
    }
    return;
  }
  for (const a of [-1.25, -0.45, 0.45, 1.25]) leaf(x, y, a, 7.5);
  if (level === 0) {
    pen.moveTo(x, y);
    pen.lineTo(x, y - 12);
    pen.stroke({ color: WEED.mark, width: 0.9 });
    pen.circle(x, y - 14, 3.2);
    pen.fill({ color: PAPER, alpha: 0.9 });
    pen.stroke({ color: WEED.mark, width: 0.7, alpha: 0.9 });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      pen.moveTo(x, y - 14);
      pen.lineTo(x + Math.sin(a) * 3.2, y - 14 - Math.cos(a) * 3.2);
    }
    pen.stroke({ color: WEED.mark, width: 0.4, alpha: 0.7 });
  } else {
    // a blank tag on a stick: nobody wrote what this is for
    pen.moveTo(x + 3, y);
    pen.lineTo(x + 3, y - 11);
    pen.stroke({ color: INK.secondary, width: 0.9 });
    pen.poly([x + 3, y - 15, x + 9, y - 15, x + 11, y - 12.5, x + 9, y - 10, x + 3, y - 10]);
    pen.fill({ color: PAPER });
    pen.stroke(inkLine(0.7, 0.8));
  }
}

/**
 * Knowledge weeds (K), weed.kind levels 3–6, at unit size around the origin:
 * 3 dangling reference: a sprout whose root runs out into a red dashed line ending in ×.
 * 4 orphan memory: an uprooted seedling lying on its side, roots in the air.
 * 5 duplicate passage: two identical rosettes with an = between them.
 * 6 over cap: a rosette whose leaves grow through a dashed cap line, tips past it faded.
 */
function drawKnowledgeWeed(
  pen: Pen,
  level: number,
  leaf: (lx: number, ly: number, a: number, len: number) => void,
): void {
  // Each glyph stays within x ∈ [-7, 7] so weeds fit their 20 px slot at scale 1.35.
  if (level === 3) {
    leaf(-1, 0, -0.7, 6);
    leaf(-1, 0, 0.7, 6);
    pen.moveTo(-1, 0);
    pen.lineTo(-1, -5);
    pen.stroke({ color: WEED.mark, width: 0.9 });
    dashPolyline(
      pen,
      [
        { x: -1, y: 1 },
        { x: 2, y: 3.5 },
        { x: 4, y: 4 },
      ],
      1.4,
      1.2,
    );
    pen.stroke({ color: STATUS.critical, width: 1 });
    pen.moveTo(4, 2.5);
    pen.lineTo(7, 5.5);
    pen.moveTo(7, 2.5);
    pen.lineTo(4, 5.5);
    pen.stroke({ color: STATUS.critical, width: 1.2 });
  } else if (level === 4) {
    pen.moveTo(-6, 0);
    pen.lineTo(4, -1);
    pen.stroke({ color: WEED.mark, width: 0.9 });
    leaf(-2, -0.4, -2.2, 5);
    leaf(1, -0.7, -1.0, 5);
    for (const a of [-0.5, 0, 0.5]) {
      pen.moveTo(4, -1);
      pen.lineTo(4 + Math.cos(a) * 3, -1 + Math.sin(a) * 3 - 1.5);
    }
    pen.stroke({ color: INK.secondary, width: 0.7 });
  } else if (level === 5) {
    for (const dx of [-4, 4]) for (const a of [-0.9, 0, 0.9]) leaf(dx, 0, a, 4.5);
    pen.moveTo(-1.4, -8);
    pen.lineTo(1.4, -8);
    pen.moveTo(-1.4, -6.2);
    pen.lineTo(1.4, -6.2);
    pen.stroke({ color: INK.primary, width: 0.9 });
  } else {
    for (const a of [-1.0, -0.4, 0.4, 1.0]) leaf(0, 0, a, 8.5);
    pen.moveTo(0, 0);
    pen.lineTo(0, -13);
    pen.stroke({ color: WEED.mark, width: 0.9 });
    dashPolyline(
      pen,
      [
        { x: -7, y: -6 },
        { x: 7, y: -6 },
      ],
      1.8,
      1.3,
    );
    pen.stroke({ color: INK.primary, width: 0.9 });
    pen.circle(0, -14, 1.8);
    pen.fill({ color: PAPER, alpha: 0.6 });
    pen.stroke({ color: WEED.mark, width: 0.6, alpha: 0.5 });
  }
}

export type IconKind = 'flood' | 'dry' | 'open' | 'closed' | 'unknown';

/** Status icons always accompany status colors (never color alone). Centered at (x, y), ~10px. */
export function drawIcon(pen: Pen, x: number, y: number, kind: IconKind, s = 1): void {
  if (kind === 'flood') {
    pen.poly([x, y - 5.5 * s, x + 5.5 * s, y + 4.5 * s, x - 5.5 * s, y + 4.5 * s]);
    pen.fill({ color: STATUS.critical });
    pen.stroke({ color: INK.primary, width: 0.8, alpha: 0.6 });
    pen.moveTo(x, y - 2 * s);
    pen.lineTo(x, y + 1.2 * s);
    pen.stroke({ color: PAPER, width: 1.4 * s });
    pen.circle(x, y + 2.9 * s, 0.75 * s);
    pen.fill({ color: PAPER });
  } else if (kind === 'dry') {
    // empty droplet with a crack
    pen.moveTo(x, y - 5.5 * s);
    pen.bezierCurveTo(x + 5 * s, y, x + 5 * s, y + 5 * s, x, y + 5 * s);
    pen.bezierCurveTo(x - 5 * s, y + 5 * s, x - 5 * s, y, x, y - 5.5 * s);
    pen.closePath();
    pen.fill({ color: PAPER });
    pen.stroke({ color: STATUS.serious, width: 1.4 * s });
    pen.moveTo(x - 1 * s, y - 2 * s);
    pen.lineTo(x + 1 * s, y);
    pen.lineTo(x - 1 * s, y + 1.6 * s);
    pen.lineTo(x + 0.6 * s, y + 3.5 * s);
    pen.stroke({ color: STATUS.serious, width: 1 * s });
  } else {
    const color = kind === 'open' ? STATUS.good : kind === 'closed' ? STATUS.critical : INK.muted;
    pen.circle(x, y, 5 * s);
    pen.fill({ color: kind === 'unknown' ? PAPER : color });
    pen.stroke({ color: kind === 'unknown' ? INK.muted : INK.primary, width: 0.8, alpha: 0.7 });
    if (kind === 'open') {
      pen.moveTo(x - 2.4 * s, y);
      pen.lineTo(x - 0.6 * s, y + 2 * s);
      pen.lineTo(x + 2.6 * s, y - 2 * s);
      pen.stroke({ color: PAPER, width: 1.5 * s });
    } else if (kind === 'closed') {
      pen.moveTo(x - 2.2 * s, y - 2.2 * s);
      pen.lineTo(x + 2.2 * s, y + 2.2 * s);
      pen.moveTo(x + 2.2 * s, y - 2.2 * s);
      pen.lineTo(x - 2.2 * s, y + 2.2 * s);
      pen.stroke({ color: PAPER, width: 1.5 * s });
    } else {
      // question mark
      pen.moveTo(x - 1.8 * s, y - 1.6 * s);
      pen.bezierCurveTo(x - 1.8 * s, y - 4 * s, x + 2 * s, y - 4 * s, x + 1.9 * s, y - 1.7 * s);
      pen.bezierCurveTo(x + 1.8 * s, y - 0.3 * s, x, y - 0.2 * s, x, y + 1.3 * s);
      pen.stroke({ color: INK.secondary, width: 1.2 * s });
      pen.circle(x, y + 3 * s, 0.7 * s);
      pen.fill({ color: INK.secondary });
    }
  }
}

/** A garden gate on a playbook path, by playbook.gate level: 0 open, 1 closed, 2 unknown. Base-center at (x, y). */
export function drawGate(pen: Pen, x: number, y: number, level: number): void {
  const color = level === 0 ? STATUS.good : level === 1 ? STATUS.critical : INK.muted;
  const w = 18;
  const h = 13;
  const l = x - w / 2;
  const r = x + w / 2;
  // posts with caps
  for (const px of [l, r]) {
    pen.rect(px - 1.5, y - h - 3, 3, h + 3);
    pen.fill({ color: PAPER });
    pen.stroke(inkLine(1, 0.8));
  }
  if (level === 0) {
    // swung open toward the viewer: a foreshortened door hanging off the left post
    const dx = 6;
    pen.poly([l + 1.5, y - h, l + 1.5 + dx, y - h + 3, l + 1.5 + dx, y + 1.5, l + 1.5, y - 1.5]);
    pen.moveTo(l + 1.5, y - h / 2 - 0.5);
    pen.lineTo(l + 1.5 + dx, y - h / 2 + 2.2);
    pen.stroke({ color, width: 1.8 });
  } else if (level === 1) {
    // shut: rails + diagonal brace across the opening
    pen.moveTo(l + 1.5, y - h + 1.5);
    pen.lineTo(r - 1.5, y - h + 1.5);
    pen.moveTo(l + 1.5, y - 2);
    pen.lineTo(r - 1.5, y - 2);
    pen.moveTo(l + 1.5, y - 2);
    pen.lineTo(r - 1.5, y - h + 1.5);
    pen.stroke({ color, width: 2 });
  } else {
    dashPolyline(
      pen,
      [
        { x: l + 1.5, y: y - h + 1.5 },
        { x: r - 1.5, y: y - h + 1.5 },
        { x: r - 1.5, y: y - 2 },
        { x: l + 1.5, y: y - 2 },
        { x: l + 1.5, y: y - h + 1.5 },
      ],
      2,
      1.8,
    );
    pen.stroke({ color, width: 1.3 });
  }
  drawIcon(pen, r + 7, y - h + 1, level === 0 ? 'open' : level === 1 ? 'closed' : 'unknown', 0.85);
}

export function drawStone(pen: Pen, x: number, y: number, r: number): void {
  pen.ellipse(x, y, r, r * 0.62);
  pen.fill({ color: INK.hairline });
  pen.stroke({ color: SOIL.rim, width: 0.8 });
}

/** Static channel for a loop by irrigation.flow and irrigation.state levels (0 flowing, 1 flooding, 2 dry). */
export function drawChannel(
  pen: Pen,
  pts: Pt[],
  flowLevel: number,
  stateLevel: number,
  observed = true,
): void {
  const w = CHANNEL_WIDTH[flowLevel] ?? CHANNEL_WIDTH[0];
  if (!observed) {
    // configured but unmeasured: a thin dotted water line, no flow claimed
    dashPolyline(pen, pts, 2, 4);
    pen.stroke({ color: WATER.flow, width: 1.6, alpha: 0.85, cap: 'round' });
    return;
  }
  if (stateLevel === 2) {
    // dry: an empty, cracked ditch with no water
    strokePolyline(pen, pts);
    pen.stroke({ color: SOIL.fill, width: w + 3, alpha: 1 });
    dashPolyline(pen, pts, 5, 3.5);
    pen.stroke({ color: STALE.tip, width: Math.max(1.2, w * 0.55), alpha: 0.9, cap: 'butt' });
    // crack ticks
    const L = polylineLength(pts);
    for (let d = 6; d < L; d += 17) {
      const p = pointAlong(pts, d);
      pen.moveTo(p.x - 1.6, p.y - 2.4);
      pen.lineTo(p.x + 0.6, p.y);
      pen.lineTo(p.x - 0.4, p.y + 2.6);
    }
    pen.stroke({ color: INK.secondary, width: 0.7, alpha: 0.7 });
    return;
  }
  strokePolyline(pen, pts);
  pen.stroke({ color: WATER.bed, width: w + 3.5, alpha: 1 });
  strokePolyline(pen, pts);
  pen.stroke({ color: WATER.flow, width: w, alpha: stateLevel === 1 ? 1 : 0.85 });
}

/** Moving highlights on flowing water. `phase` in px; static when reduced motion is on. */
export function drawFlow(pen: Pen, pts: Pt[], flowLevel: number, phase: number): void {
  const w = CHANNEL_WIDTH[flowLevel] ?? CHANNEL_WIDTH[0];
  dashPolyline(pen, pts, 3 + flowLevel, 7 + flowLevel * 2, -phase);
  pen.stroke({ color: PAPER, width: Math.max(0.8, w * 0.4), alpha: 0.6 });
}

/** Overflow puddle at a flooded target, rimmed with the critical status color. */
export function drawPuddle(pen: Pen, x: number, y: number, r: number): void {
  const k = 9;
  const pts: number[] = [];
  for (let i = 0; i < k; i++) {
    const a = (i / k) * Math.PI * 2;
    const rr = r * (0.82 + 0.18 * Math.sin(i * 2.7));
    pts.push(x + Math.cos(a) * rr * 1.5, y + Math.sin(a) * rr * 0.6);
  }
  pen.poly(pts);
  pen.fill({ color: WATER.flow, alpha: 0.55 });
  pen.stroke({ color: STATUS.critical, width: 1.4, alpha: 0.9 });
}

export interface BedLook {
  tone: string;
  texture: number;
  strata: number;
  /**
   * Knowledge map (K): strata band shares, top to bottom (bedStrataShares). When present, the face
   * is drawn as one band per always-loaded layer instead of `strata` evenly spaced lines.
   */
  bands?: readonly number[];
  /** bed.strata_weight level: ink weight of the band boundaries (total always-loaded tokens). */
  weight?: number;
}

export const BED_FACE = 18;

/** bed.strata_weight level → band-boundary stroke width / alpha, and band shading strength. */
export const STRATA_WEIGHT = [
  { width: 0.6, alpha: 0.4, shade: 0.06 },
  { width: 0.9, alpha: 0.55, shade: 0.12 },
  { width: 1.4, alpha: 0.7, shade: 0.2 },
  { width: 2.1, alpha: 0.9, shade: 0.32 },
] as const;

/** Bands of a bed's front face: alternating soil tones with wavy boundaries (shares sum to 1). */
export function drawStrataBands(
  pen: Pen,
  x: number,
  top: number,
  w: number,
  h: number,
  bands: readonly number[],
  weight: number,
  seed: number,
): void {
  const wt = STRATA_WEIGHT[Math.max(0, Math.min(3, weight))]!;
  const rnd = mulberry32(seed);
  const total = bands.reduce((a, b) => a + b, 0) || 1;
  const min = bands.length ? Math.min(3, h / bands.length) : 0;
  // Minimum visible thickness per band, the rest proportional to the share.
  const free = Math.max(0, h - min * bands.length);
  let y0 = top;
  const bounds: number[] = [];
  bands.forEach((b, i) => {
    const bh = min + (free * b) / total;
    pen.rect(x, y0, w, bh);
    pen.fill({ color: i % 2 === 0 ? SOIL.strata : mix(SOIL.strata, INK.secondary, wt.shade) });
    y0 += bh;
    if (i < bands.length - 1) bounds.push(y0);
  });
  for (const sy of bounds) {
    const amp = 0.5 + rnd() * 0.6;
    const ph = rnd() * 6;
    pen.moveTo(x, sy);
    for (let sx = x; sx <= x + w; sx += 8) pen.lineTo(sx, sy + Math.sin(sx * 0.05 + ph) * amp);
  }
  if (bounds.length) pen.stroke({ color: INK.secondary, width: wt.width, alpha: wt.alpha });
  else if (bands.length) {
    pen.moveTo(x, top + h - 1);
    pen.lineTo(x + w, top + h - 1);
    pen.stroke({ color: INK.secondary, width: wt.width, alpha: wt.alpha });
  }
}

/** A raised allotment bed: soil top (texture), front face (strata), edging boards (model family). */
export function drawBed(
  pen: Pen,
  x: number,
  y: number,
  w: number,
  h: number,
  look: BedLook,
  seed: number,
): void {
  // front face with strata
  pen.roundRect(x, y + h - BED_FACE - 4, w, BED_FACE + 4, 5);
  pen.fill({ color: SOIL.strata });
  const rnd = mulberry32(seed);
  if (look.bands)
    drawStrataBands(
      pen,
      x + 3,
      y + h - BED_FACE,
      w - 6,
      BED_FACE - 3,
      look.bands,
      look.weight ?? 0,
      seed,
    );
  const strata = look.bands ? 0 : look.strata;
  for (let i = 0; i < strata; i++) {
    const sy = y + h - BED_FACE + ((i + 1) * BED_FACE) / (strata + 1);
    const amp = 0.8 + rnd() * 0.8;
    const ph = rnd() * 6;
    pen.moveTo(x + 4, sy);
    for (let sx = x + 4; sx <= x + w - 4; sx += 8)
      pen.lineTo(sx, sy + Math.sin(sx * 0.05 + ph) * amp);
  }
  if (strata > 0) pen.stroke({ color: INK.secondary, width: 0.9, alpha: 0.55 });
  // soil top
  pen.roundRect(x, y, w, h - BED_FACE, 6);
  pen.fill({ color: SOIL.fill });
  // specks
  const density = SPECK_DENSITY[look.texture] ?? SPECK_DENSITY[0];
  const n = Math.round(((w * (h - BED_FACE)) / 1000) * density);
  for (let i = 0; i < n; i++) {
    const sx = x + 5 + rnd() * (w - 10);
    const sy = y + 5 + rnd() * (h - BED_FACE - 10);
    const r = 0.8 + rnd() * 0.9;
    pen.poly([sx - r, sy, sx, sy - r * 0.8, sx + r, sy, sx, sy + r * 0.8]);
  }
  if (n > 0) pen.fill({ color: SOIL.speck, alpha: 0.95 });
  // edging boards in the model-family tone + ink outline
  pen.roundRect(x, y, w, h, 7);
  pen.stroke({ color: look.tone, width: 4, alpha: 0.95 });
  pen.roundRect(x - 2, y - 2, w + 4, h + 4, 8);
  pen.stroke(inkLine(1, 0.55));
  pen.moveTo(x + 2, y + h - BED_FACE - 2);
  pen.lineTo(x + w - 2, y + h - BED_FACE - 2);
  pen.stroke({ color: SOIL.rim, width: 1 });
}
