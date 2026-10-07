/** Exposes the validated palette (packages/core palette.ts) to CSS as custom properties. */
import { BLOOM, INK, PAPER, SOIL, STATUS, WATER } from '@garden/core';
import { hexToRgb } from './garden/color';
import { mulberry32 } from './garden/draw';

export const CSS_VARS: Record<string, string> = {
  '--paper': PAPER,
  '--ink': INK.primary,
  '--ink-2': INK.secondary,
  '--ink-3': INK.muted,
  '--hairline': INK.hairline,
  '--soil': SOIL.fill,
  '--soil-rim': SOIL.rim,
  '--water': WATER.flow,
  '--water-bed': WATER.bed,
  '--good': STATUS.good,
  '--warning': STATUS.warning,
  '--serious': STATUS.serious,
  '--critical': STATUS.critical,
  '--petal': BLOOM.petal,
};

/** Subtle paper grain: deterministic ink-colored noise rendered once into a data URL. */
function paperGrain(): string | null {
  const c = document.createElement('canvas');
  c.width = 160;
  c.height = 160;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(160, 160);
  const rnd = mulberry32(7);
  const [r, g, b] = hexToRgb(INK.primary);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = r;
    img.data[i + 1] = g;
    img.data[i + 2] = b;
    img.data[i + 3] = Math.floor(rnd() * rnd() * 34);
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

export function applyTheme(root: HTMLElement): void {
  for (const [k, v] of Object.entries(CSS_VARS)) root.style.setProperty(k, v);
  const grain = paperGrain();
  if (grain) root.style.setProperty('--grain', `url(${grain})`);
}
