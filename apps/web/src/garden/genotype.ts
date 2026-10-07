/**
 * A plant's "genotype" is the tuple of its encoding levels. Every visual parameter of a plant is a
 * function of the genotype only, so textures are cached per genotype (500 plants → a few dozen
 * textures). Levels always come from the registry's `level()` functions; nothing is re-binned here.
 */
import {
  plantBloom,
  plantDroop,
  plantFade,
  plantHeight,
  plantHue,
  type PlantSummary,
} from '@garden/core';

export interface Genotype {
  height: number;
  bloom: number;
  droop: number;
  fade: number;
  hue: number;
}

export function genotypeOf(p: PlantSummary): Genotype {
  return {
    height: plantHeight.level(p),
    bloom: plantBloom.level(p),
    droop: plantDroop.level(p),
    fade: plantFade.level(p),
    hue: plantHue.level(p),
  };
}

export function genotypeKey(g: Genotype): string {
  return `h${g.height}b${g.bloom}d${g.droop}f${g.fade}c${g.hue}`;
}

/** Generic memo keyed by genotype; the renderer stores Pixi textures in it. */
export class GenotypeCache<T> {
  private readonly map = new Map<string, T>();
  hits = 0;
  misses = 0;

  get(key: string, make: () => T): T {
    const found = this.map.get(key);
    if (found !== undefined) {
      this.hits++;
      return found;
    }
    this.misses++;
    const made = make();
    this.map.set(key, made);
    return made;
  }

  get size(): number {
    return this.map.size;
  }

  values(): IterableIterator<T> {
    return this.map.values();
  }

  clear(): void {
    this.map.clear();
  }
}
