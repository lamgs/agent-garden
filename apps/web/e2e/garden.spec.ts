import { ENCODINGS } from '@garden/core';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const SHOTS = resolve(import.meta.dirname, '..', '..', '..', 'docs', 'screenshots');

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    if (/Content Security Policy|Refused to/i.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('requestfailed', (r) => {
    // the static-export probe is allowed to 404 in fixture mode; anything else is a failure
    errors.push(`request failed: ${r.url()}`);
  });
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.hostname !== '127.0.0.1' && u.protocol !== 'data:' && u.protocol !== 'blob:')
      errors.push(`external request: ${r.url()}`);
  });
  return errors;
}

async function openGarden(page: Page, fixture: string) {
  await page.goto(`/?fixture=${fixture}`);
  await page.waitForFunction(() => window.__garden?.ready === true, undefined, { timeout: 60_000 });
  await page.waitForTimeout(400);
}

test('demo garden renders under the production CSP at three zoom levels', async ({ page }) => {
  const errors = collectErrors(page);
  await openGarden(page, 'demo');
  expect(await page.evaluate(() => window.__garden!.plants)).toBe(25);
  await expect(page.getByRole('heading', { name: 'Agent Garden' })).toBeVisible();
  await expect(page.getByText('fixture · demo fixture')).toBeVisible();

  await page.evaluate(() => window.__garden!.setZoom('far'));
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__garden!.zoomLevel())).toBe('far');
  await page.screenshot({ path: `${SHOTS}/m3-garden-far.png` });

  await page.evaluate(() => window.__garden!.setZoom('mid'));
  await page.getByRole('button', { name: /Fit garden/ }).click();
  await page.mouse.move(700, 20);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__garden!.zoomLevel())).toBe('mid');
  await page.screenshot({ path: `${SHOTS}/m3-garden-mid.png` });

  await page.evaluate(() => window.__garden!.focusPlant('shop-api', 'main', 'near'));
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__garden!.zoomLevel())).toBe('near');
  await page.screenshot({ path: `${SHOTS}/m3-garden-near.png` });

  expect(errors).toEqual([]);
});

test('tooltip on the legacy-monolith test-writer plant shows rate, n, CI and how computed', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openGarden(page, 'demo');
  const pt = await page.evaluate(() =>
    window.__garden!.focusPlant('legacy-monolith', 'test-writer', 'mid'),
  );
  expect(pt).not.toBeNull();
  await page.mouse.move(pt!.x - 40, pt!.y - 40);
  await page.mouse.move(pt!.x, pt!.y, { steps: 6 });
  const tip = page.getByRole('tooltip');
  await expect(tip).toContainText('test-writer');
  await expect(tip).toContainText('95% CI');
  await expect(tip).toContainText('n=102');
  await expect(tip).toContainText('How computed');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/m3-tooltip.png` });

  // Click opens the plant panel; Esc closes it.
  await page.mouse.click(pt!.x, pt!.y);
  await expect(page.getByRole('complementary', { name: 'Plant: test-writer' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('complementary', { name: 'Plant: test-writer' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('legend (L) lists every encoding with swatches; table (T) shows the same numbers', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openGarden(page, 'demo');
  await page.keyboard.press('l');
  const legend = page.getByRole('complementary', { name: 'Legend' });
  await expect(legend).toBeVisible();
  expect(await legend.locator('[data-encoding-id]').count()).toBe(ENCODINGS.length);
  await expect(legend).toContainText('ambient, no meaning');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/m3-legend.png` });
  await page.keyboard.press('l');

  await page.keyboard.press('t');
  const table = page.getByRole('region', { name: 'Garden as tables' });
  await expect(table).toBeVisible();
  await expect(table).toContainText('legacy-monolith');
  await expect(table).toContainText('26% (95% CI');
  await expect(table).toContainText('Flooding'.toLowerCase());
  await page.screenshot({ path: `${SHOTS}/m3-table.png` });
  await page.keyboard.press('Escape');
  await expect(table).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('keyboard: Tab focuses plants with a ring over the canvas, Enter opens the panel', async ({
  page,
}) => {
  await openGarden(page, 'demo');
  await page.locator('.sr-plant').first().focus();
  await expect(page.locator('.focus-ring')).toBeVisible();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.locator('.plant-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.plant-panel')).toHaveCount(0);
});

test('prefers-reduced-motion: no sway, bees, or water animation; state still drawn', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // Live state changes are not motion but would change pixels; live.spec.ts covers live + reduced motion.
  await openGarden(page, 'demo&live=off');
  await page.mouse.move(700, 20);
  const canvas = page.locator('.canvas-host canvas');
  const a = await canvas.screenshot();
  await page.waitForTimeout(700);
  const b = await canvas.screenshot();
  expect(Buffer.compare(a, b)).toBe(0);
  expect(errors).toEqual([]);
});

test('500-plant synthetic garden renders; frame stats reported', async ({ page }) => {
  const errors = collectErrors(page);
  await openGarden(page, 'synthetic500');
  expect(await page.evaluate(() => window.__garden!.plants)).toBe(500);
  await page.evaluate(() => window.__garden!.setZoom('mid'));
  await page.evaluate(() => window.__garden!.resetFrameStats());
  await page.waitForTimeout(3000);
  const stats = await page.evaluate(() => ({
    ...window.__garden!.frameStats(),
    textures: window.__garden!.textures,
  }));
  console.log(`synthetic500 frameStats (mid zoom, 3 s): ${JSON.stringify(stats)}`);
  await page.getByRole('button', { name: /Fit garden/ }).click();
  await page.evaluate(() => window.__garden!.resetFrameStats());
  await page.waitForTimeout(3000);
  const fit = await page.evaluate(() => window.__garden!.frameStats());
  console.log(`synthetic500 frameStats (fit, 3 s): ${JSON.stringify(fit)}`);
  await page.screenshot({ path: `${SHOTS}/m3-synthetic500.png` });
  expect(stats.frames).toBeGreaterThan(10);
  expect(errors).toEqual([]);
});
