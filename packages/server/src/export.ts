import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { legend } from '@garden/core';
import { gardenView, type AppOptions } from './app';

/**
 * Static export: the built web app plus view JSON in `<out>/data/`, for hosting the demo anywhere
 * (no server). The web app falls back to these files when /api is unavailable.
 */
export function exportStatic(opts: AppOptions, outDir: string, days = 90): { files: string[] } {
  if (opts.webDist && existsSync(opts.webDist)) {
    cpSync(opts.webDist, outDir, { recursive: true });
    // Tell the app it is a static export so it reads data/ directly instead of probing /api.
    const index = join(outDir, 'index.html');
    if (existsSync(index)) {
      const html = readFileSync(index, 'utf8');
      if (!html.includes('agent-garden-source'))
        writeFileSync(
          index,
          html.replace(
            '<head>',
            '<head>\n    <meta name="agent-garden-source" content="static" />',
          ),
        );
    }
  }
  const dataDir = join(outDir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const files = [join(dataDir, 'garden.json'), join(dataDir, 'legend.json')];
  writeFileSync(files[0]!, JSON.stringify(gardenView(opts, days)));
  writeFileSync(files[1]!, JSON.stringify(legend()));
  return { files };
}
