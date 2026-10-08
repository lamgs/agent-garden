/**
 * Router eval harness over the demo dataset: generate (or open) a demo store, build the same
 * window index the server builds, and report accuracy, the ablation, and calibration.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter, ingest, Redactor, Store } from '@garden/ingest';
import { deriveAll } from '@garden/ingest/derive';
import type { RouterIndex } from '@garden/router';
import { DEFAULT_WINDOW_DAYS, windowData } from './app';
import { buildWindowIndex } from './route';

export const DEMO_AS_OF = '2026-10-01T12:00:00Z';

/** Index for the default 90-day window ending at the demo's "now". */
export function windowIndex(
  store: Store,
  asOf = DEMO_AS_OF,
  days = DEFAULT_WINDOW_DAYS,
): RouterIndex {
  const { data, garden } = windowData({ store, asOf }, days, asOf);
  return buildWindowIndex(data, garden);
}

/**
 * Generate the demo (seed 42) into a fresh temp dir OUTSIDE any git worktree, ingest it, and
 * return the store. `dispose()` closes it and deletes the directory.
 */
export async function demoStore(seed = 42): Promise<{ store: Store; dispose: () => void }> {
  const { generateDemo } = await import('@garden/demo');
  const dir = mkdtempSync(join(tmpdir(), 'garden-router-eval-'));
  const m = await generateDemo(join(dir, 'demo'), { seed });
  const store = new Store(join(dir, 'data', 'garden.db'));
  const adapter = new ClaudeCodeAdapter({
    claudeHome: m.claudeHome,
    claudeJsonPath: m.claudeJsonPath,
    gardenYamlPath: m.gardenYamlPath,
  });
  await ingest(adapter, store, new Redactor(Buffer.alloc(32, 9)));
  deriveAll(store, adapter.garden);
  return {
    store,
    dispose: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
