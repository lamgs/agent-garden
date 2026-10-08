/**
 * Record docs/screenshots/live-garden.gif for the README: the built app in fixture mode
 * (`?fixture=demo`, the deterministic demo live stream), captured as PNG frames with Playwright
 * and assembled with ffmpeg (palettegen/paletteuse). Synthetic data only.
 * Run after `pnpm build`: node apps/web/scripts/readme-gif.ts [--ffmpeg /usr/bin/ffmpeg]
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const here = import.meta.dirname;
const out = resolve(here, '..', '..', '..', 'docs', 'screenshots', 'live-garden.gif');
const ffArg = process.argv.indexOf('--ffmpeg');
const ffmpeg = ffArg > 0 ? process.argv[ffArg + 1]! : 'ffmpeg';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PORT = 4493;
const FRAMES = 40;
const EVERY_MS = 300;

const server = spawn(process.execPath, [join(here, 'preview.ts'), String(PORT)], {
  stdio: 'ignore',
});
const frames = mkdtempSync(join(tmpdir(), 'garden-gif-'));
try {
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch(existsSync(CHROME) ? { executablePath: CHROME } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${PORT}/?fixture=demo`);
  await page.waitForFunction(() => window.__garden?.ready === true, undefined, { timeout: 60_000 });
  await page.waitForFunction(() => (window.__live?.stats().marks ?? 0) > 0, undefined, {
    timeout: 20_000,
  });
  await page.getByRole('button', { name: /Fit garden/ }).click();
  await page.mouse.move(700, 20);
  await page.waitForTimeout(1500);
  for (let i = 0; i < FRAMES; i++) {
    await page.screenshot({ path: join(frames, `f${String(i).padStart(3, '0')}.png`) });
    await page.waitForTimeout(EVERY_MS);
  }
  await browser.close();
  const r = spawnSync(
    ffmpeg,
    [
      '-y',
      '-loglevel',
      'error',
      '-framerate',
      String(Math.round(1000 / EVERY_MS)),
      '-i',
      join(frames, 'f%03d.png'),
      '-vf',
      'scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
      out,
    ],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) throw new Error(`ffmpeg failed (${r.status})`);
  console.log(`${out}: ${(statSync(out).size / 1e6).toFixed(2)} MB, ${FRAMES} frames`);
} finally {
  server.kill();
  rmSync(frames, { recursive: true, force: true });
}
