#!/usr/bin/env -S npx tsx
/** `garden` CLI: ingest commands plus `serve` and `export`. */
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { main, dataDir, dbPath, str, type Command } from '@garden/ingest/cli';
import { Store, loadGardenConfig } from '@garden/ingest';
import { DEFAULT_WINDOW_DAYS } from './app';
import { exportStatic } from './export';
import { DEFAULT_PORT, startServer } from './serve';

const WEB_DIST = fileURLToPath(new URL('../../../apps/web/dist', import.meta.url));

function common(o: Parameters<Command['run']>[0]) {
  const store = new Store(dbPath(o));
  const yamlPath = str(o, 'garden-yaml') ?? join(dataDir(o), 'garden.yaml');
  const pricing = loadGardenConfig(yamlPath).pricing;
  const asOf = str(o, 'as-of');
  if (asOf && Number.isNaN(Date.parse(asOf))) throw new Error('--as-of must be an ISO date');
  return { store, pricing, ...(asOf ? { asOf } : {}), webDist: str(o, 'web') ?? WEB_DIST };
}

const extra: Record<string, Command> = {
  serve: {
    help: 'Serve the garden at http://127.0.0.1:<port> (local only). --port, --as-of <ISO>',
    run: async (o) => {
      const port = Number(str(o, 'port') ?? DEFAULT_PORT);
      const { url } = await startServer({ ...common(o), port });
      console.log(`Agent Garden: ${url}  (bound to 127.0.0.1 only; Ctrl+C to stop)`);
      await new Promise(() => {}); // keep running
    },
  },
  export: {
    help: 'Write a static site (web app + view JSON) to --out <dir> for hosting a demo',
    run: (o) => {
      const out = str(o, 'out') ?? join(process.cwd(), 'garden-export');
      const days = Number(str(o, 'days') ?? DEFAULT_WINDOW_DAYS);
      const { files } = exportStatic(common(o), out, days);
      console.log(`Exported to ${out}\n${files.map((f) => `  ${f}`).join('\n')}`);
    },
  },
};

await main(process.argv.slice(2), extra);
