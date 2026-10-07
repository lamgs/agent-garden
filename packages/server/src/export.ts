import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { legend } from '@garden/core';
import { gardenView, type AppOptions } from './app';

/**
 * Static export: the built web app plus view JSON in `<out>/data/`, for hosting the demo anywhere
 * (no server). The web app falls back to these files when /api is unavailable.
 */
export function exportStatic(opts: AppOptions, outDir: string, days = 90): { files: string[] } {
  if (opts.webDist && existsSync(opts.webDist)) cpSync(opts.webDist, outDir, { recursive: true });
  const dataDir = join(outDir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const files = [join(dataDir, 'garden.json'), join(dataDir, 'legend.json')];
  writeFileSync(files[0]!, JSON.stringify(gardenView(opts, days)));
  writeFileSync(files[1]!, JSON.stringify(legend()));
  return { files };
}
