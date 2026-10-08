/**
 * M7: the Seasons page and scrub-to-date. Fixture mode (`?fixture=demo`) for navigation into the
 * page; a mocked local API (page.route, serving real exported demo responses) for the
 * "View garden as of this date" round trip, which only the local server can compute.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const SHOTS = resolve(import.meta.dirname, '..', '..', '..', 'docs', 'screenshots');
const FIX = resolve(import.meta.dirname, '..', 'src', 'fixtures');
const readFix = (name: string): unknown => JSON.parse(readFileSync(`${FIX}/${name}`, 'utf8'));

const SHOP = 'fam_77320afbea5626a6';
const LEGACY = 'fam_e4f77dae0177d5e5';
const PLANT = 'plt_0afdf741a0daed53'; // test-writer in legacy-monolith

function watch(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    if (/Content Security Policy|Refused to/i.test(m.text())) errors.push(m.text());
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
  await page.waitForTimeout(250);
}

test('seasons are reachable from the bed label, the compare page, and the plant view', async ({
  page,
}) => {
  const errors = watch(page);
  await page.goto('/?fixture=demo');
  await page.waitForFunction(() => window.__garden?.ready === true, undefined, { timeout: 60_000 });
  await page.evaluate(() => window.__garden!.focusPlant('shop-api', 'main', 'mid'));
  await page.waitForTimeout(200);
  const lp = await page.evaluate(() => window.__garden!.bedLabelPoint('shop-api'));
  await page.mouse.click(lp!.x, lp!.y);
  const picker = page.getByRole('dialog', { name: 'Compare beds' });
  await picker.getByRole('link', { name: 'Seasons of shop-api →' }).click();
  await expect(page).toHaveURL(new RegExp(`#/seasons/${SHOP}$`));
  await expect(picker).toBeHidden();
  await expect(page.getByRole('heading', { name: 'shop-api', level: 2 })).toBeVisible();
  await expect(page.getByText(/Correlation, not causation/)).toBeVisible();
  // Fixture mode: the as-of garden needs the local server, and says so.
  await expect(page.getByRole('button', { name: /View garden as of/ })).toBeDisabled();
  await expect(page.locator('.scrub-readout')).toContainText('computed by the local server');

  await page.goto(`/?fixture=demo#/compare?left=${SHOP}&right=${LEGACY}`);
  await page.getByRole('link', { name: 'Seasons of legacy-monolith →' }).click();
  await expect(page).toHaveURL(new RegExp(`#/seasons/${LEGACY}$`));
  await expect(page.getByRole('region', { name: 'What changed at each boundary' })).toContainText(
    'One harness for the whole window',
  );

  await page.goto(`/?fixture=demo#/plant/${PLANT}`);
  await page.getByRole('link', { name: /Seasons of legacy-monolith/ }).click();
  await expect(page).toHaveURL(new RegExp(`#/seasons/${LEGACY}$`));
  // T jumps to the numbers table; Esc returns to the garden.
  await expect(page.getByRole('heading', { name: 'legacy-monolith', level: 2 })).toBeVisible();
  await page.keyboard.press('t');
  await expect(page.getByRole('table', { name: 'Seasons table' })).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/#\/$/);
  expect(errors).toEqual([]);
});

test('shop-api seasons: before/after, separated delta, then the garden as of a scrubbed date', async ({
  page,
}) => {
  const errors = watch(page);
  await page.setViewportSize({ width: 1440, height: 1640 });
  const garden = readFix('garden.demo.json');
  const gardenAsOf = readFix('garden-asof-2026-08-10.demo.json');
  const seasons = readFix('seasons.demo.json') as Record<string, unknown>;
  const asOfRequests: string[] = [];
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/garden') {
      const asOf = url.searchParams.get('asOf');
      if (!asOf) return route.fulfill({ json: garden });
      asOfRequests.push(asOf);
      return asOf === '2026-08-10T23:59:59.999Z'
        ? route.fulfill({ json: gardenAsOf })
        : route.fulfill({ status: 500, json: { error: `no mock for ${asOf}` } });
    }
    const m = /^\/api\/seasons\/([^/]+)$/.exec(url.pathname);
    if (m && seasons[m[1]!]) return route.fulfill({ json: seasons[m[1]!] });
    return route.fulfill({ status: 404, json: { error: 'not found' } });
  });

  await page.goto(`/#/seasons/${SHOP}`);
  const band = page.getByRole('region', { name: 'Harness seasons' });
  await expect(band).toContainText('2 seasons');
  const boundary = page.getByRole('region', { name: 'What changed at each boundary' });
  await expect(boundary).toContainText('Tighten CLAUDE.md and add test hook');
  await expect(boundary).toContainText('Hooks changed');
  await expect(boundary).toContainText('Instructions −10,581 bytes');
  await expect(boundary).toContainText('51% → 87% +36 points');
  await expect(boundary).toContainText('separated');
  const rows = page.getByRole('region', { name: 'Outcomes per season' });
  await expect(rows.locator('.row-stat').first()).toContainText('51% n=226');
  await expect(rows.locator('.row-stat').nth(1)).toContainText('87% n=204');
  await expect(rows.locator('.row-stat').nth(1)).toContainText('+36 pts');
  await expect(rows).toContainText('loop · nightly-flaky-triage');
  await expect(rows).toContainText('within noise');
  await expect(page.getByText(/Correlation, not causation/)).toBeVisible();
  // Every encoded number has a "how computed" tooltip.
  await rows.locator('.row-stat').nth(1).hover();
  await expect(page.getByRole('tooltip')).toContainText('95% CI 81%–91%, n=204 labeled');

  // Scrub to 2026-08-10 (before the change).
  const scrub = page.getByLabel('Scrub to date');
  await expect(scrub).toHaveAttribute('aria-valuetext', '2026-08-16');
  await scrub.fill('38');
  await expect(page.locator('.scrub-date')).toHaveText('2026-08-10');
  await expect(page.locator('.scrub-readout')).toContainText('season 1 of 2: “Initial commit”');
  await page.mouse.move(5, 5);
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/m7-seasons.png` });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'View garden as of 2026-08-10 →' }).click();
  await expect(page).toHaveURL(/#\/\?asOf=2026-08-10T23%3A59%3A59.999Z$/);
  const banner = page.getByRole('status').filter({ hasText: 'Garden as of' });
  await expect(banner).toContainText('Garden as of 2026-08-10');
  await expect(page.locator('.window-dates')).toHaveText('2026-05-12 → 2026-08-10');
  await page.waitForFunction(() => window.__garden?.ready === true, undefined, { timeout: 60_000 });
  expect(asOfRequests).toEqual(['2026-08-10T23:59:59.999Z']);
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/m7-garden-asof.png` });

  await banner.getByRole('button', { name: 'Back to now' }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(banner).toBeHidden();
  await expect(page.locator('.window-dates')).toHaveText('2026-07-03 → 2026-10-01');
  expect(errors).toEqual([]);
});
