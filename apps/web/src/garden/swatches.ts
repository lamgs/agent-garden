/**
 * Legend swatches: one per registry level, drawn by the SAME functions the garden uses.
 * Keyed by encoding id; `legend.test.ts` checks every registry entry has a swatch per level.
 */
import { INK, MODEL_FAMILY_COLORS, PAPER, SOIL_FAMILIES } from '@garden/core';
import {
  dashPolyline,
  drawBed,
  drawBee,
  drawChannel,
  drawFlow,
  drawGate,
  drawIcon,
  drawPacket,
  drawPlant,
  drawPuddle,
  drawStone,
  drawWeed,
} from './draw';
import type { Genotype } from './genotype';
import type { Pen } from './pen';

export interface Swatch {
  /** World-space frame drawn into the swatch canvas. */
  frame: { x: number; y: number; w: number; h: number };
  /** Display height in CSS px (default 44). */
  height?: number;
  draw: (pen: Pen, level: number) => void;
}

const BASE: Genotype = { height: 2, bloom: 4, droop: 0, fade: 0, hue: 2 };
const plantSwatch = (
  vary: (level: number) => Partial<Genotype>,
  frame: Swatch['frame'],
): Swatch => ({
  frame,
  height: 64,
  draw: (pen, level) => drawPlant(pen, { ...BASE, ...vary(level) }),
});

export function familyTone(level: number): string {
  const fam = SOIL_FAMILIES[level] ?? 'other';
  return MODEL_FAMILY_COLORS[fam];
}

const bedSwatch = (
  look: (level: number) => { tone: string; texture: number; strata: number },
): Swatch => ({
  frame: { x: -4, y: -4, w: 68, h: 52 },
  draw: (pen, level) => drawBed(pen, 0, 0, 60, 44, look(level), 7 + level),
});

export const SWATCHES: Record<string, Swatch> = {
  'plant.height': plantSwatch((l) => ({ height: l }), { x: -46, y: -150, w: 92, h: 158 }),
  'plant.bloom': {
    ...plantSwatch((l) => ({ bloom: l, height: 2 }), { x: -26, y: -94, w: 52, h: 52 }),
    height: 52,
  },
  'plant.droop': plantSwatch((l) => ({ droop: l, height: 3 }), { x: -42, y: -126, w: 112, h: 132 }),
  'plant.fade': plantSwatch((l) => ({ fade: l }), { x: -40, y: -96, w: 80, h: 102 }),
  'plant.hue': plantSwatch((l) => ({ hue: l, bloom: 3 }), { x: -40, y: -96, w: 80, h: 102 }),
  'bed.tone': bedSwatch((l) => ({ tone: familyTone(l), texture: 1, strata: 1 })),
  'bed.texture': bedSwatch((l) => ({ tone: MODEL_FAMILY_COLORS.other, texture: l, strata: 0 })),
  'bed.strata': bedSwatch((l) => ({ tone: MODEL_FAMILY_COLORS.other, texture: 0, strata: l })),
  'care_card.size': {
    frame: { x: -12, y: -22, w: 24, h: 26 },
    draw: (pen, l) => drawPacket(pen, 0, 0, l),
  },
  'irrigation.flow': {
    frame: { x: 0, y: -10, w: 64, h: 20 },
    draw: (pen, l) => {
      const pts = [
        { x: 4, y: 0 },
        { x: 60, y: 0 },
      ];
      drawChannel(pen, pts, l, 0);
      drawFlow(pen, pts, l, 0);
    },
  },
  'irrigation.state': {
    frame: { x: 0, y: -14, w: 72, h: 28 },
    draw: (pen, l) => {
      const pts = [
        { x: 4, y: 0 },
        { x: 46, y: 0 },
      ];
      drawChannel(pen, pts, 2, l);
      if (l === 0) drawFlow(pen, pts, 2, 0);
      if (l === 1) drawPuddle(pen, 54, 2, 8);
      if (l > 0) drawIcon(pen, 62, -6, l === 1 ? 'flood' : 'dry');
    },
  },
  'irrigation.observed': {
    frame: { x: 0, y: -10, w: 64, h: 20 },
    draw: (pen, l) => {
      const pts = [
        { x: 4, y: 0 },
        { x: 60, y: 0 },
      ];
      drawChannel(pen, pts, 1, 0, l === 0);
      if (l === 0) drawFlow(pen, pts, 1, 0);
    },
  },
  'bee.count': {
    frame: { x: 0, y: -22, w: 70, h: 30 },
    draw: (pen, l) => {
      const arc = Array.from({ length: 21 }, (_, i) => {
        const t = i / 20;
        return { x: 4 + 62 * t, y: 2 - Math.sin(Math.PI * t) * 18 };
      });
      dashPolyline(pen, arc, 1.5, 3);
      pen.stroke({ color: INK.muted, width: 0.8, alpha: 0.8 });
      const n = l + 1;
      for (let k = 0; k < n; k++) {
        const p = arc[Math.round(((k + 1) / (n + 1)) * 20)]!;
        drawBee(pen, p.x, p.y, 1.2);
      }
    },
  },
  'weed.kind': {
    frame: { x: -18, y: -30, w: 38, h: 34 },
    draw: (pen, l) => drawWeed(pen, 0, 0, l, 1.35),
  },
  'playbook.gate': {
    frame: { x: -26, y: -20, w: 62, h: 26 },
    draw: (pen, l) => {
      drawStone(pen, -18, 0, 3.2);
      drawStone(pen, 24, 0, 3.2);
      drawGate(pen, 0, 2, l);
    },
  },
  'season.band': {
    frame: { x: 0, y: 0, w: 60, h: 24 },
    draw: (pen) => {
      pen.rect(0, 0, 20, 24);
      pen.fill({ color: INK.hairline, alpha: 0.5 });
      pen.rect(20, 0, 20, 24);
      pen.fill({ color: PAPER });
      pen.rect(40, 0, 20, 24);
      pen.fill({ color: INK.hairline, alpha: 0.5 });
    },
  },
  // Mirrors the Seasons view's SVG: CI band, level line, marker (filled / hollow for small n).
  'season.rate': {
    frame: { x: 0, y: 0, w: 60, h: 24 },
    draw: (pen, level) => {
      pen.rect(2, 7, 56, 10);
      pen.fill({ color: INK.primary, alpha: 0.18 });
      pen.moveTo(2, 12);
      pen.lineTo(58, 12);
      pen.stroke({ color: INK.primary, width: 2 });
      pen.circle(30, 12, 4);
      if (level === 0) pen.fill({ color: INK.primary });
      else {
        pen.fill({ color: PAPER });
        pen.circle(30, 12, 4);
        pen.stroke({ color: INK.primary, width: 1.6 });
      }
    },
  },
  'ambient.sway': {
    frame: { x: -44, y: -100, w: 88, h: 106 },
    height: 64,
    draw: (pen) => {
      drawPlant(pen, BASE);
      for (const s of [-1, 1]) {
        pen.moveTo(s * 16, -92);
        pen.quadraticCurveTo(s * 30, -84, s * 34, -68);
      }
      pen.stroke({ color: INK.muted, width: 0.8, alpha: 0.7 });
    },
  },
};
