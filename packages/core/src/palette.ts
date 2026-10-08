/**
 * The garden's color system ("botanical field guide" on warm paper). Validated with the dataviz
 * skill's validate_palette.js against the paper surface; results in docs/design.md. Every channel
 * that uses color here also has a non-color cue (labels, shape, icons) — see docs/design.md.
 */
export const PAPER = '#f6f1e7';

export const INK = {
  primary: '#2b2a26',
  secondary: '#6b665b',
  muted: '#8f897b',
  hairline: '#d9cfbc',
} as const;

/** Foliage = median cost per run. Ordinal single-hue ramp, light (cheap) → dark (expensive). Index = level − 1. */
export const COST_RAMP = ['#7fb383', '#5c9b66', '#3d7f4e', '#25633b', '#124628'] as const;
/** Foliage when the model has no price (cost level 0): neutral, drawn hatched. */
export const COST_UNKNOWN = '#b9b4a6';

/** Bed edging = model family. Categorical, all-pairs validated; order matches SOIL_FAMILIES. "Other" is neutral by rule. */
export const MODEL_FAMILY_COLORS = {
  fable: '#8a3fa0',
  opus: '#eb6834',
  sonnet: '#2a78d6',
  haiku: '#1baf7a',
  other: '#9a978d',
} as const;

/** Soil fill is deliberately neutral so plants stay readable; texture and strata carry harness size. */
export const SOIL = {
  fill: '#e6dcc8',
  speck: '#c9b99a',
  strata: '#cdbf9f',
  rim: '#b8a888',
} as const;

/** Fixed bloom color: bloom encodes success by count and openness, never by hue. */
export const BLOOM = { petal: '#e58fa8', center: '#f2c14e', bud: '#c98a9c' } as const;

/** Staleness shifts foliage toward dry straw and adds brown tips (desaturation channel). */
export const STALE = { straw: '#b7ad96', tip: '#a07a4f' } as const;

/** Water (irrigation). Distinguished from the sonnet edging by form (channel + flow), not hue alone. */
export const WATER = { flow: '#5aa9c9', bed: '#cfe3e8' } as const;

/** Status colors are reserved for state and always ship with an icon + label. */
export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const;

export const WEED = { leaf: '#6f7a3a', mark: '#4f5629' } as const;

/** Router highlight: a warm sunlight halo (not a data hue; the confidence badge carries the number). */
export const HIGHLIGHT = { glow: '#f3c64f', veilAlpha: 0.62 } as const;
