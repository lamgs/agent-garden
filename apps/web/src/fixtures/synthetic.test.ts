import { describe, expect, it } from 'vitest';
import { syntheticGarden } from './synthetic';

describe('synthetic garden', () => {
  it('is deterministic for a seed and differs across seeds', () => {
    expect(syntheticGarden({ plants: 500, seed: 42 })).toEqual(
      syntheticGarden({ plants: 500, seed: 42 }),
    );
    expect(syntheticGarden({ seed: 1 })).not.toEqual(syntheticGarden({ seed: 2 }));
  });

  it('has 500 plants with consistent references', () => {
    const v = syntheticGarden({ plants: 500 });
    expect(v.plants).toHaveLength(500);
    const plantIds = new Set(v.plants.map((p) => p.id));
    const bedIds = new Set(v.beds.map((b) => b.id));
    for (const p of v.plants) expect(bedIds.has(p.bedId)).toBe(true);
    for (const b of v.beds) for (const id of b.plantIds) expect(plantIds.has(id)).toBe(true);
    for (const s of v.skills) expect(plantIds.has(s.plantId)).toBe(true);
    for (const l of v.loops) for (const id of l.targetPlantIds) expect(plantIds.has(id)).toBe(true);
    for (const b of v.bees)
      expect(plantIds.has(b.fromPlantId) && plantIds.has(b.toPlantId)).toBe(true);
    expect(new Set(v.loops.map((l) => l.state))).toEqual(new Set(['flowing', 'flooding', 'dry']));
  });
});
