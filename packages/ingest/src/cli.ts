#!/usr/bin/env -S npx tsx
/** `garden` CLI. Commands are added per milestone (see PLAN.md §10). */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store/store';

const DATA_DIR = process.env.GARDEN_HOME ?? join(homedir(), '.agent-garden');
const DB_PATH = process.env.GARDEN_DB ?? join(DATA_DIR, 'garden.db');

const commands: Record<string, { help: string; run: (args: string[]) => Promise<void> | void }> = {
  'db:init': {
    help: 'Create or migrate the local store',
    run: () => {
      const store = new Store(DB_PATH);
      console.log(`garden.db ready at ${DB_PATH} (schema v${store.schemaVersion()})`);
      store.close();
    },
  },
};

function usage(): void {
  console.log('garden <command>\n');
  for (const [name, c] of Object.entries(commands)) console.log(`  ${name.padEnd(12)} ${c.help}`);
  console.log(
    '\nMore commands (inspect, ingest, serve, label, export) arrive in later milestones.',
  );
}

const [cmd, ...rest] = process.argv.slice(2);
const command = cmd ? commands[cmd] : undefined;
if (!command) {
  usage();
  process.exitCode = cmd && cmd !== 'help' ? 1 : 0;
} else {
  await command.run(rest);
}
