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
  page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()}`));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.hostname !== '127.0.0.1' && u.protocol !== 'data:' && u.protocol !== 'blob:')
      errors.push(`external request: ${r.url()}`);
  });
  return errors;
}

async function openLive(page: Page) {
  await page.goto('/?fixture=demo');
  await page.waitForFunction(() => window.__garden?.ready === true, undefined, { timeout: 60_000 });
  await page.waitForFunction(() => (window.__live?.stats().marks ?? 0) > 0, undefined, {
    timeout: 20_000,
  });
}

test('live overlay, Needs-you strip, ticker, panel Now section and legend in fixture mode', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await openLive(page);

  const pill = page.locator('[data-live-pill]');
  await expect(pill).toHaveAttribute('data-live-pill', 'fixture');
  await expect(pill).toContainText('Fixture · demo stream');
  await expect(pill).toContainText(/\d+ active/);

  const stats = await page.evaluate(() => window.__live!.stats());
  expect(stats.visible).toBe(true);
  expect(stats.marks).toBeGreaterThanOrEqual(6);

  // The ticker moves on as the stream plays.
  const list = page.locator('.ticker-list');
  const seq0 = Number(await list.getAttribute('data-latest-seq'));
  await page.waitForTimeout(2500);
  const seq1 = Number(await list.getAttribute('data-latest-seq'));
  expect(seq1).toBeGreaterThan(seq0);
  await page.getByRole('button', { name: /Events/ }).click();
  expect(await list.locator('li').count()).toBeGreaterThan(5);
  await page.getByRole('button', { name: /Events/ }).click();

  // The shop-api publish stalls: an inferred (dashed) permission wait, first in Needs you.
  const needs = page.getByRole('region', { name: 'Needs you' });
  const first = needs.locator('.needs-item').first();
  await expect(first).toHaveAttribute('data-reason', 'waiting_permission', { timeout: 30_000 });
  await expect(first).toHaveAttribute('data-inferred', 'true');
  await expect(first).toContainText('shop-api');
  await expect(first).toContainText('main');
  await expect(first).toContainText('inferred');
  await expect(first).toHaveAttribute('title', /inferred: transcripts do not record permission/);
  await expect(first.locator('.att-tag')).toHaveClass(/att-inferred/);
  const att = await page.evaluate(() => window.__live!.stats().attention);
  expect(att.some((a) => a.reason === 'waiting_permission' && a.inferred)).toBe(true);
  // Bees are hovering at children; a seedling marks the new cost-estimator agent.
  await page.waitForFunction(() => (window.__live?.stats().seedlings ?? 0) > 0, undefined, {
    timeout: 15_000,
  });
  const s2 = await page.evaluate(() => window.__live!.stats());
  expect(s2.bees.length).toBeGreaterThan(0);
  expect(s2.pulsesFired).toBeGreaterThanOrEqual(1);

  await page.getByRole('button', { name: /Fit garden/ }).click();
  await page.mouse.move(700, 20);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/live-garden.png` });

  await page.evaluate(() => window.__garden!.focusPlant('shop-api', 'main', 'near'));
  await first.hover();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/live-needs-you.png` });

  // Clicking the wait opens the plant panel with a "Now" section.
  await first.click();
  const panel = page.getByRole('complementary', { name: 'Plant: main' });
  await expect(panel).toBeVisible();
  const now = panel.getByRole('region', { name: 'Now' });
  await expect(now).toContainText('waiting for permission');
  await expect(now).toContainText('Context');
  await expect(now).toContainText(/\d+ tool calls/);
  await expect(now).toContainText('Bash');
  await expect(now.getByRole('link', { name: /Replay its latest stored run/ })).toBeVisible();
  await now.locator('summary', { hasText: 'How decided' }).click();
  await expect(now).toContainText('waiting_permission (inferred');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/live-panel.png` });
  await page.keyboard.press('Escape');

  // Legend lists every live channel with a swatch per level.
  await page.keyboard.press('l');
  const legend = page.getByRole('complementary', { name: 'Legend' });
  for (const e of ENCODINGS.filter((x) => x.element === 'live')) {
    const entry = legend.locator(`[data-encoding-id="${e.id}"]`);
    await expect(entry).toHaveCount(1);
    expect(await entry.locator('canvas').count()).toBe(e.levels.length);
  }
  await page.keyboard.press('l');

  // The pill switches the layer off and on.
  await pill.click();
  await expect(pill).toHaveAttribute('data-live-pill', 'off');
  expect(await page.evaluate(() => window.__live!.stats().visible)).toBe(false);
  await expect(needs).toHaveCount(0);
  await pill.click();
  await expect(pill).toHaveAttribute('data-live-pill', 'fixture');

  expect(errors).toEqual([]);
});

test('reduced motion: bees are placed, never flown; the overlay still shows state', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openLive(page);
  const phases = new Set<string>();
  for (let i = 0; i < 24; i++) {
    const s = await page.evaluate(() => window.__live!.stats());
    expect(s.reducedMotion).toBe(true);
    for (const b of s.bees) phases.add(b.phase);
    await page.waitForTimeout(500);
  }
  expect(phases.has('hover')).toBe(true);
  expect(phases.has('out')).toBe(false);
  expect(phases.has('back')).toBe(false);
  expect((await page.evaluate(() => window.__live!.stats())).marks).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('?live=off starts with the live layer off', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?fixture=demo&live=off');
  await page.waitForFunction(() => window.__garden?.ready === true, undefined, { timeout: 60_000 });
  await expect(page.locator('[data-live-pill]')).toHaveAttribute('data-live-pill', 'off');
  expect(await page.evaluate(() => window.__live!.stats().marks)).toBe(0);
  expect(errors).toEqual([]);
});
