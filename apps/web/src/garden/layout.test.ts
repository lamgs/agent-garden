import { describe, expect, it } from 'vitest';
import type { GardenView } from '@garden/core';
import demo from '../fixtures/garden.demo.json';
import { syntheticGarden } from '../fixtures/synthetic';
import { agentOrder, computeLayout, rectsOverlap, SLOT_BASE, SLOT_H, SLOT_W } from './layout';

const view = demo as GardenView;

describe('layout', () => {
  it('orders agents main first, then alphabetically', () => {
    const names = agentOrder(view.plants).map((a) => a.name);
    expect(names[0]).toBe('main');
    const rest = names.slice(1);
    expect(rest).toEqual([...rest].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
    expect(new Set(names).size).toBe(names.length);
  });

  it('puts each agent in the same slot (same offset) in every bed', () => {
    const L = computeLayout(view);
    const bedById = new Map(L.beds.map((b) => [b.bedId, b]));
    const offsets = new Map<string, string>();
    let shared = 0;
    for (const pp of L.plants.values()) {
      const bed = bedById.get(pp.bedId)!;
      const off = `${pp.x - bed.x},${pp.y - bed.y}`;
      const prev = offsets.get(pp.agentId);
      if (prev !== undefined) {
        shared++;
        expect(off).toBe(prev);
      } else offsets.set(pp.agentId, off);
    }
    expect(shared).toBeGreaterThan(5); // main, Explore, test-writer... appear in several beds
  });

  it('places every plant inside its bed in a distinct slot; beds never overlap', () => {
    for (const v of [view, syntheticGarden({ plants: 500 })]) {
      const L = computeLayout(v);
      expect(L.plants.size).toBe(v.plants.length);
      for (let i = 0; i < L.beds.length; i++)
        for (let j = i + 1; j < L.beds.length; j++)
          expect(rectsOverlap(L.beds[i]!, L.beds[j]!)).toBe(false);
      if (L.compost) for (const b of L.beds) expect(rectsOverlap(b, L.compost)).toBe(false);
      const slots: { bedId: string; r: { x: number; y: number; w: number; h: number } }[] = [];
      for (const pp of L.plants.values()) {
        const bed = L.beds.find((b) => b.bedId === pp.bedId)!;
        const r = { x: pp.x - SLOT_W / 2, y: pp.y - SLOT_BASE, w: SLOT_W, h: SLOT_H };
        expect(r.x).toBeGreaterThanOrEqual(bed.x);
        expect(r.x + r.w).toBeLessThanOrEqual(bed.x + bed.w);
        expect(r.y).toBeGreaterThanOrEqual(bed.y);
        expect(r.y + r.h).toBeLessThanOrEqual(bed.soil.y + bed.soil.h);
        for (const s of slots) if (s.bedId === pp.bedId) expect(rectsOverlap(s.r, r)).toBe(false);
        slots.push({ bedId: pp.bedId, r });
      }
      for (const b of L.beds) expect(b.x + b.w).toBeLessThanOrEqual(L.width);
    }
  });

  it('routes loops to deduplicated targets; weeds go to bed corners or the compost corner', () => {
    const L = computeLayout(view);
    for (const loop of view.loops) {
      const route = L.loops.find((r) => r.loopId === loop.loopId)!;
      expect(route.ends.map((e) => e.plantId).sort()).toEqual(
        [...new Set(loop.targetPlantIds)].sort(),
      );
    }
    const unassigned = view.weeds.filter((w) => !w.bedId).length;
    expect(L.weeds.filter((w) => w.inCompost)).toHaveLength(unassigned);
    expect(L.compost).not.toBeNull();
    for (const w of L.weeds.filter((x) => !x.inCompost)) {
      const weed = view.weeds.find((x) => x.id === w.weedId)!;
      const bed = L.beds.find((b) => b.bedId === weed.bedId)!;
      expect(w.x).toBeGreaterThan(bed.x + bed.w / 2);
      expect(w.y).toBeGreaterThan(bed.y + bed.h / 2);
    }
    expect(L.playbooks[0]!.gates).toHaveLength(3);
    expect(L.focusOrder).toHaveLength(view.plants.length);
  });

  it('is deterministic', () => {
    const a = computeLayout(view);
    const b = computeLayout(view);
    expect([...a.plants.values()]).toEqual([...b.plants.values()]);
    expect(a.loops).toEqual(b.loops);
  });
});
