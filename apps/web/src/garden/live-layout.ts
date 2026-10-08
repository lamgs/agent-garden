/**
 * Pure placement for live marks that have no plant: seedlings take free slots of their bed (the
 * same slot grid as plants), so a new agent sits where its plant will grow.
 */
import type { ID } from '@garden/core';
import {
  BED_PAD_TOP,
  BED_PAD_X,
  SLOT_BASE,
  SLOT_H,
  SLOT_W,
  type GardenLayout,
  type Pt,
} from './layout';

/** The first `n` free slot positions (plant base points) in a bed, in slot order. */
export function freeSlots(layout: GardenLayout, bedId: ID, n: number): Pt[] {
  const bed = layout.beds.find((b) => b.bedId === bedId);
  if (!bed || n <= 0) return [];
  const used = new Set<number>();
  for (const p of layout.plants.values()) if (p.bedId === bedId) used.add(p.slot);
  const out: Pt[] = [];
  const capacity = bed.rows * layout.cols;
  for (let slot = 0; slot < capacity && out.length < n; slot++) {
    if (used.has(slot)) continue;
    const col = slot % layout.cols;
    const row = Math.floor(slot / layout.cols);
    out.push({
      x: bed.x + BED_PAD_X + col * SLOT_W + SLOT_W / 2,
      y: bed.y + BED_PAD_TOP + row * SLOT_H + SLOT_BASE,
    });
  }
  // A full bed: line the extra seedlings up along the front edge of the soil.
  for (let k = 0; out.length < n; k++) {
    out.push({
      x: bed.x + bed.w - BED_PAD_X - 24 - k * 46,
      y: bed.soil.y + bed.soil.h - 14,
    });
  }
  return out;
}
