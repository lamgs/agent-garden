import { describe, expect, it } from 'vitest';
import { BLOOM, plantBloom, plantHeight, type GardenView } from '@garden/core';
import demo from '../fixtures/garden.demo.json';
import { syntheticGarden } from '../fixtures/synthetic';
import { drawPlant } from './draw';
import { GenotypeCache, genotypeKey, genotypeOf, type Genotype } from './genotype';
import { RecordingPen } from './pen';

const view = demo as GardenView;

describe('genotype', () => {
  it('is the tuple of registry levels', () => {
    const p = view.plants.find((x) => x.name === 'test-writer' && x.success.value! < 0.3)!;
    const g = genotypeOf(p);
    expect(g.height).toBe(plantHeight.level(p));
    expect(g.bloom).toBe(plantBloom.level(p));
    expect(g.droop).toBe(2); // 88% failure share in the last 14 days
    expect(genotypeKey(g)).toBe(`h${g.height}b${g.bloom}d${g.droop}f${g.fade}c${g.hue}`);
  });

  it('caches one texture per genotype (500 plants → far fewer textures)', () => {
    const cache = new GenotypeCache<string>();
    const big = syntheticGarden({ plants: 500 });
    let made = 0;
    for (const p of big.plants) cache.get(genotypeKey(genotypeOf(p)), () => `tex${made++}`);
    expect(cache.misses).toBe(cache.size);
    expect(made).toBe(cache.size);
    expect(cache.hits + cache.misses).toBe(500);
    expect(cache.size).toBeLessThan(500);
    const demoCache = new GenotypeCache<number>();
    for (const p of view.plants) demoCache.get(genotypeKey(genotypeOf(p)), () => 1);
    expect(demoCache.size).toBeLessThan(view.plants.length);
  });

  it('draws deterministically, and differently per channel level', () => {
    const base: Genotype = { height: 3, bloom: 4, droop: 0, fade: 0, hue: 2 };
    const draw = (g: Genotype) => {
      const pen = new RecordingPen();
      drawPlant(pen, g);
      return pen.ops.join('\n');
    };
    expect(draw(base)).toBe(draw(base));
    for (const k of Object.keys(base) as (keyof Genotype)[]) {
      expect(draw({ ...base, [k]: base[k] === 0 ? 1 : 0 })).not.toBe(draw(base));
    }
    // hollow bud: outline only, no petal fill
    expect(draw({ ...base, bloom: 0 })).not.toContain(BLOOM.petal);
    expect(draw(base)).toContain(BLOOM.petal);
  });
});
