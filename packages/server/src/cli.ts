#!/usr/bin/env -S npx tsx
/** `garden` CLI: ingest commands plus `serve` and `export`. */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { main, dataDir, dbPath, str, type Command } from '@garden/ingest/cli';
import { homedir } from 'node:os';
import {
  DemoLiveSource,
  LiveTailer,
  Redactor,
  Store,
  loadGardenConfig,
  type LiveHub,
} from '@garden/ingest';
import { plantId } from './garden';
import { storePlantLookup } from './live';
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
  const redactor = Redactor.fromKeyFile(join(dataDir(o), 'redaction.key'));
  return {
    store,
    pricing,
    redactor,
    ...(asOf ? { asOf } : {}),
    webDist: str(o, 'web') ?? WEB_DIST,
  };
}

/**
 * Live layer for `serve`. Default: tail the local transcripts (read-only, files already readable by
 * this user; nothing is written). `--live-demo` replays the store's runs instead; `--no-live` turns
 * it off.
 */
async function liveSource(
  o: Parameters<Command['run']>[0],
  c: ReturnType<typeof common>,
): Promise<{ hub: LiveHub; label: string } | undefined> {
  if (o.flags['no-live'] === true) return undefined;
  if (o.flags['live-demo'] !== undefined) {
    const seed = Number(str(o, 'live-seed') ?? 1);
    const speed = Number(str(o, 'live-speed') ?? 8);
    const demo = DemoLiveSource.fromStore(c.store, c.redactor, { seed, speed });
    demo.start();
    return { hub: demo.hub, label: `demo replay (seed ${seed}, ${speed}x)` };
  }
  const claudeHome = str(o, 'claude-home') ?? join(homedir(), '.claude');
  const projectsDir = str(o, 'live-projects') ?? join(claudeHome, 'projects');
  const tailer = new LiveTailer({
    redactor: c.redactor,
    projectsDir,
    sessionsDir: join(claudeHome, 'sessions'),
    recentMinutes: Number(str(o, 'live-minutes') ?? 30),
    plantExists: storePlantLookup(c.store, plantId),
  });
  await tailer.start();
  return { hub: tailer.hub, label: `tailing ${projectsDir} (read-only)` };
}

const extra: Record<string, Command> = {
  'live:probe': {
    help: 'Tail local transcripts for --seconds N (default 20) and print event shapes and latency (never content). --no-watch, --live-minutes N, --seed-kb N',
    run: async (o) => {
      const seconds = Number(str(o, 'seconds') ?? 20);
      const claudeHome = str(o, 'claude-home') ?? join(homedir(), '.claude');
      const tailer = new LiveTailer({
        redactor: Redactor.fromKeyFile(join(dataDir(o), 'redaction.key')),
        projectsDir: str(o, 'live-projects') ?? join(claudeHome, 'projects'),
        sessionsDir: join(claudeHome, 'sessions'),
        watch: o.flags['no-watch'] !== true,
        recentMinutes: Number(str(o, 'live-minutes') ?? 30),
        seedBytes: Number(str(o, 'seed-kb') ?? 256) * 1024,
      });
      const lat: number[] = [];
      let live = false;
      tailer.hub.subscribe((m) => {
        if (!live) return; // skip the startup seed
        if (m.type === 'event') {
          const ms = Date.now() - Date.parse(m.event.at);
          lat.push(ms);
          console.log(
            `${m.event.kind.padEnd(15)} ${(m.event.tool?.name ?? '').padEnd(14)} agent=${m.event.agentKey.slice(0, 12)}${m.event.agentKey.includes(':') ? ' (subagent)' : ''}  latency=${ms} ms`,
          );
        } else if (m.type === 'agent') {
          console.log(`  agent ${m.agent.agentName} → ${m.agent.activity}`);
        } else if (m.type === 'gone') console.log(`  gone ${m.agentKey.slice(0, 12)}`);
      });
      await tailer.start();
      live = true;
      console.log(
        `Tracking ${tailer.trackedFiles.length} files; seeded ${tailer.hub.snapshot().agents.length} agents. Watching ${seconds} s…`,
      );
      await new Promise((r) => setTimeout(r, seconds * 1000));
      tailer.hub.stop();
      const sorted = [...lat].sort((a, b) => a - b);
      const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
      console.log(
        `\nEvents: ${lat.length}; latency (line timestamp → emitted) p50=${q(0.5)} ms p90=${q(0.9)} ms max=${sorted.at(-1)} ms`,
      );
      console.log(`Stats: ${JSON.stringify(tailer.stats)}`);
      console.log(`Unknown shapes: ${JSON.stringify(tailer.census.unknownFields)}`);
    },
  },
  serve: {
    help: 'Serve the garden at http://127.0.0.1:<port> (local only). --port, --as-of <ISO>; live layer: on by default (tails transcripts), --no-live, --live-demo [--live-seed N --live-speed X], --live-projects <dir>, --live-minutes N',
    run: async (o) => {
      const port = Number(str(o, 'port') ?? DEFAULT_PORT);
      const c = common(o);
      const live = await liveSource(o, c);
      const { url } = await startServer({ ...c, port, ...(live ? { live: live.hub } : {}) });
      console.log(`Agent Garden: ${url}  (bound to 127.0.0.1 only; Ctrl+C to stop)`);
      console.log(`Live layer: ${live ? live.label : 'off'}`);
      if (!existsSync(c.webDist))
        console.warn(
          `Web app not built (${c.webDist} is missing): run \`pnpm build\`. The API works without it.`,
        );
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
