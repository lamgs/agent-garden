#!/usr/bin/env -S npx tsx
/** `garden` CLI. Everything stays local: reads ~/.claude, writes ~/.agent-garden. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OUTCOME_LABELS, type OutcomeLabel } from '@garden/core';
import { ClaudeCodeAdapter } from './adapters/claude-code/adapter';
import { ingest } from './pipeline';
import { Redactor } from './redact';
import { deriveAll } from './store/derive';
import { Store } from './store/store';

export interface Opts {
  flags: Record<string, string | true>;
  positional: string[];
}

export function parseArgs(argv: string[]): Opts {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) positional.push(a);
    else if (a.includes('=')) flags[a.slice(2, a.indexOf('='))] = a.slice(a.indexOf('=') + 1);
    else if (argv[i + 1] && !argv[i + 1]!.startsWith('--')) flags[a.slice(2)] = argv[++i]!;
    else flags[a.slice(2)] = true;
  }
  return { flags, positional };
}

export const str = (o: Opts, k: string): string | undefined =>
  typeof o.flags[k] === 'string' ? (o.flags[k] as string) : undefined;
export const dataDir = (o: Opts) =>
  str(o, 'data') ?? process.env.GARDEN_HOME ?? join(homedir(), '.agent-garden');
export const dbPath = (o: Opts) =>
  str(o, 'db') ?? process.env.GARDEN_DB ?? join(dataDir(o), 'garden.db');

function adapter(o: Opts): ClaudeCodeAdapter {
  const claudeHome = str(o, 'claude-home');
  const claudeJsonPath = str(o, 'claude-json');
  const managedDir = str(o, 'managed-dir');
  const ancestorBoundary = str(o, 'knowledge-boundary');
  return new ClaudeCodeAdapter({
    ...(claudeHome ? { claudeHome } : {}),
    ...(claudeJsonPath ? { claudeJsonPath } : {}),
    ...(managedDir ? { managedDir } : {}),
    ...(ancestorBoundary ? { ancestorBoundary } : {}),
    gardenYamlPath: str(o, 'garden-yaml') ?? join(dataDir(o), 'garden.yaml'),
    full: o.flags.full === true,
  });
}

const table = (rows: Record<string, number>, indent = '  ') =>
  Object.entries(rows)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${indent}${k.padEnd(46)} ${v}`)
    .join('\n');

export interface Command {
  help: string;
  run: (o: Opts) => Promise<void> | void;
}

export const commands: Record<string, Command> = {
  inspect: {
    help: 'Census of local Claude Code data: shapes and counts only, never content',
    run: async (o) => {
      const c = await adapter(o).inspect();
      console.log(`Adapter: ${c.adapter}\n\nRoots:`);
      for (const r of c.roots)
        console.log(
          `  ${r.exists ? '✓' : '✗'} ${r.path}${r.files ? `  (${r.files} entries${r.bytes ? `, ${(r.bytes / 1e6).toFixed(1)} MB` : ''})` : ''}`,
        );
      console.log(`\nRecord types:\n${table(c.recordTypes)}`);
      console.log(`\nCLI versions:\n${table(c.versions)}`);
      const unknown = Object.keys(c.unknownFields).length;
      console.log(
        `\nUnknown shapes (${unknown}):${unknown ? `\n${table(c.unknownFields)}` : ' none'}`,
      );
      console.log(
        `\nWarnings (${c.warnings.length}):${c.warnings
          .slice(0, 20)
          .map((w) => `\n  ${w}`)
          .join('')}`,
      );
      if (c.warnings.length > 20) console.log(`  … ${c.warnings.length - 20} more`);
    },
  },
  ingest: {
    help: 'Read local data, redact, and write the store (--full re-parses everything)',
    run: async (o) => {
      const t0 = Date.now();
      const store = new Store(dbPath(o));
      const redactor = Redactor.fromKeyFile(join(dataDir(o), 'redaction.key'));
      const a = adapter(o);
      const report = await ingest(a, store, redactor);
      const derived = deriveAll(store, a.garden);
      console.log(`Ingested into ${dbPath(o)} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      console.log(`\nRecords written:\n${table(report.records)}`);
      console.log(`\nDerived:\n${table({ ...derived })}`);
      const red = Object.values(report.redactions).reduce((n, v) => n + v, 0);
      console.log(`\nRedactions: ${red}${red ? `\n${table(report.redactions)}` : ''}`);
      if (report.warnings.length) {
        console.log(
          `\nWarnings (${report.warnings.length}):${report.warnings
            .slice(0, 15)
            .map((w) => `\n  ${w}`)
            .join('')}`,
        );
      }
      store.close();
    },
  },
  label: {
    help: 'Manually label a run: label <runId> <success|partial|failure|unknown|clear> [--note "..."]',
    run: (o) => {
      const [runId, label] = o.positional;
      if (
        !runId ||
        !label ||
        (label !== 'clear' && !OUTCOME_LABELS.includes(label as OutcomeLabel))
      ) {
        throw new Error(
          'usage: garden label <runId> <success|partial|failure|unknown|clear> [--note "..."]',
        );
      }
      const store = new Store(dbPath(o));
      if (!store.getRun(runId)) throw new Error(`no run ${runId}`);
      if (label === 'clear') store.clearManualLabel(runId);
      else {
        const note = str(o, 'note');
        const redactor = Redactor.fromKeyFile(join(dataDir(o), 'redaction.key'));
        store.putManualLabel(
          runId,
          label as OutcomeLabel,
          note ? redactor.text(note, 2000) : undefined,
          new Date().toISOString(),
        );
      }
      const out = store.getOutcome(runId);
      console.log(`${runId}: ${out?.label} (${out?.source})`);
      store.close();
    },
  },
  stats: {
    help: 'Row counts and outcome mix in the store',
    run: (o) => {
      const store = new Store(dbPath(o));
      const counts: Record<string, number> = {};
      for (const t of [
        'harness_families',
        'harness_versions',
        'agents',
        'skills',
        'loops',
        'playbooks',
        'sessions',
        'runs',
        'steps',
        'manual_labels',
      ])
        counts[t] = store.count(t);
      console.log(`${dbPath(o)}\n${table(counts)}`);
      const mix = store.db
        .prepare('SELECT label, COUNT(*) AS n FROM outcomes GROUP BY label')
        .all() as { label: string; n: number }[];
      console.log(
        `\nHeuristic outcomes:\n${table(Object.fromEntries(mix.map((m) => [m.label, m.n])))}`,
      );
      store.close();
    },
  },
  'db:init': {
    help: 'Create or migrate the local store',
    run: (o) => {
      const store = new Store(dbPath(o));
      console.log(`garden.db ready at ${dbPath(o)} (schema v${store.schemaVersion()})`);
      store.close();
    },
  },
};

function usage(all: Record<string, Command>): void {
  console.log('garden <command> [options]\n');
  for (const [name, c] of Object.entries(all)) console.log(`  ${name.padEnd(10)} ${c.help}`);
  console.log(`
Options:
  --claude-home <dir>    Claude Code data dir (default ~/.claude)
  --claude-json <file>   ~/.claude.json (only MCP server names are read)
  --garden-yaml <file>   playbooks / declared loops (default <data>/garden.yaml)
  --managed-dir <dir>    managed-policy dir for CLAUDE.md (default /etc/claude-code on Linux)
  --knowledge-boundary <dir>  do not read ancestor CLAUDE.md files above <dir> (the demo uses it)
  --data <dir>           Agent Garden data dir (default ~/.agent-garden, or $GARDEN_HOME)
  --db <file>            store path (default <data>/garden.db)`);
}

/** Run the CLI with the ingest commands plus any extra ones (the server package adds serve/export). */
export async function main(argv: string[], extra: Record<string, Command> = {}): Promise<void> {
  const all = { ...commands, ...extra };
  const opts = parseArgs(argv);
  const [cmd] = opts.positional.splice(0, 1);
  const command = cmd ? all[cmd] : undefined;
  if (!command) {
    usage(all);
    process.exitCode = cmd && cmd !== 'help' ? 1 : 0;
    return;
  }
  try {
    await command.run(opts);
  } catch (e) {
    console.error(`garden ${cmd}: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
