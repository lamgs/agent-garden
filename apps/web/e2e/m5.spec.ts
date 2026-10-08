/**
 * M5 replay page. Fixture mode (`?fixture=demo`) for the demo replays; a real-session replay is
 * served through a mocked local API when GARDEN_REAL_REPLAY points at a ReplayView JSON built from
 * this machine's transcripts (never committed; the test is skipped without it).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const SHOTS = resolve(import.meta.dirname, '..', '..', '..', 'docs', 'screenshots');
const FIX = resolve(import.meta.dirname, '..', 'src', 'fixtures');
const PLANT = 'plt_0afdf741a0daed53'; // test-writer in legacy-monolith
const LATEST_TW = 'run_1b1209c5f6183de0'; // its most recent run
const DEMO_RUN = 'run_8308c289de49b5b3'; // legacy-monolith main: 2 test-writer forks + a compaction

function watch(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.hostname !== '127.0.0.1' && u.protocol !== 'data:' && u.protocol !== 'blob:')
      errors.push(`external request: ${r.url()}`);
  });
  return errors;
}

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(2, 2);
  await page.waitForTimeout(250);
}

const stepPanel = (page: Page) => page.getByRole('region', { name: 'Step' });

test('replay is reached from the garden panel and from the plant view runs table', async ({
  page,
}) => {
  const errors = watch(page);
  await page.goto('/?fixture=demo');
  await page.waitForFunction(() => window.__garden?.ready === true, undefined, { timeout: 60_000 });
  const pt = await page.evaluate(() =>
    window.__garden!.focusPlant('legacy-monolith', 'test-writer', 'mid'),
  );
  await page.mouse.click(pt!.x, pt!.y);
  await page
    .getByRole('complementary', { name: 'Plant: test-writer' })
    .getByRole('link', { name: 'Replay its latest run →' })
    .click();
  await expect(page).toHaveURL(new RegExp(`#/replay\\?plant=${PLANT}$`));
  await expect(stepPanel(page)).toContainText('Step 1 of 23');
  await expect(page.locator('.replay-head')).toContainText(
    'Write unit tests for the email templates',
  );

  await page.goto(`/?fixture=demo#/plant/${PLANT}`);
  const runs = page.getByRole('table', { name: 'Runs' });
  await runs
    .getByRole('link', { name: /^Replay run/ })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`#/replay/${LATEST_TW}$`));
  await page.keyboard.press('End');
  await expect(stepPanel(page)).toContainText('Step 23 of 23');
  await expect(page.locator('.lane-label')).toHaveCount(1);
  // Errors show as red crosses and in the step panel.
  await page.keyboard.press('Home');
  for (let i = 0; i < 13; i++) await page.keyboard.press('ArrowRight');
  await expect(stepPanel(page)).toContainText('Bash failed: Exit code 1');
  await expect(stepPanel(page).locator('dd.is-error')).toHaveText('yes');

  // Unknown runs get a clear state.
  await page.goto('/?fixture=demo#/replay/run_nope');
  await expect(
    page.getByRole('heading', { name: 'This run is not in the demo fixture' }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('demo replay: start, middle, end, playback, lanes, legend', async ({ page }) => {
  const errors = watch(page);
  await page.goto(`/?fixture=demo#/replay/${DEMO_RUN}`);
  const panel = stepPanel(page);
  const total = 22 + 23 + 22; // main + two test-writer runs
  await expect(panel).toContainText(`Step 1 of ${total}`);
  await expect(page.locator('.lane-label')).toHaveCount(3);
  await expect(page.locator('.replay-head')).toContainText('2 subagent runs · 1 compaction');
  await expect(page.getByRole('region', { name: 'Context' })).toContainText('1,000,000 tokens');
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/m5-replay-start.png` });

  // Middle: the scrubber is in compressed display time; halfway lands inside the first subagent.
  const scrub = page.getByRole('slider', { name: 'Scrub through the run' });
  const max = Number(await scrub.getAttribute('max'));
  await scrub.fill(String(Math.round(max * 0.45)));
  await expect(panel).toContainText('subagent test-writer');
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/m5-replay-mid.png` });

  await page.keyboard.press('End');
  await expect(panel).toContainText(`Step ${total} of ${total}`);
  await expect(panel).toContainText('Compaction');
  await expect(page.getByRole('region', { name: 'Context' })).toContainText('1 compaction');
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/m5-replay-end.png` });

  // Collapse a subagent lane; play at 16× from the start and see the step advance.
  await page
    .getByRole('button', { name: /^Collapse subagent lane/ })
    .first()
    .click();
  await expect(page.getByRole('button', { name: /^Expand subagent lane test-writer/ })).toHaveCount(
    1,
  );
  await page.keyboard.press('Home');
  await page.getByRole('button', { name: '16×' }).click();
  await page.getByRole('button', { name: 'Play (Space)' }).click();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Pause (Space)' }).click();
  const txt = (await panel.locator('.card-kicker').textContent()) ?? '';
  expect(Number(/Step (\d+)/.exec(txt)?.[1])).toBeGreaterThan(1);

  // The legend (L) lists the replay channels.
  await page.keyboard.press('l');
  const legend = page.getByRole('complementary', { name: 'Legend' });
  for (const id of ['replay.mark_shape', 'replay.mark_color', 'replay.context', 'replay.lane'])
    await expect(legend.locator(`[data-encoding-id="${id}"]`)).toBeVisible();
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

const REAL = process.env.GARDEN_REAL_REPLAY;
test('real session replay (this machine, via a mocked local API)', async ({ page }) => {
  test.skip(!REAL || !existsSync(REAL), 'GARDEN_REAL_REPLAY not set');
  const body = readFileSync(REAL!, 'utf8');
  const runId = (JSON.parse(body) as { run: { runId: string } }).run.runId;
  await page.route('**/api/replay/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body }),
  );
  await page.route('**/api/garden**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: readFileSync(`${FIX}/garden.demo.json`, 'utf8'),
    }),
  );
  const errors = watch(page);
  await page.goto(`/#/replay/${runId}`);
  await expect(stepPanel(page)).toContainText('Step 1 of');
  const scrub = page.getByRole('slider', { name: 'Scrub through the run' });
  const max = Number(await scrub.getAttribute('max'));
  await scrub.fill(String(Math.round(max * 0.5)));
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/m5-replay-real.png` });
  expect(errors).toEqual([]);
});
