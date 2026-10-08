/**
 * M4 pages: plant view, bed compare, replant, and manual labeling.
 * Fixture mode (`?fixture=demo`) for the pages; a mocked local API (page.route) for the label
 * round trip, so the UI's write path (JSON POST → refetch → updated rate and row) is exercised.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page, type Request } from '@playwright/test';

const SHOTS = resolve(import.meta.dirname, '..', '..', '..', 'docs', 'screenshots');
const FIX = resolve(import.meta.dirname, '..', 'src', 'fixtures');
const readFix = (name: string): unknown => JSON.parse(readFileSync(`${FIX}/${name}`, 'utf8'));

const PLANT = 'plt_0afdf741a0daed53'; // test-writer in legacy-monolith
const SHOP = 'fam_77320afbea5626a6';
const LEGACY = 'fam_e4f77dae0177d5e5';
const TEST_WRITER = 'agt_c02389e440c4e177';

function watch(page: Page): string[] {
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

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

test('plant view from the garden panel: specimen, why-this-rate evidence, runs, read-only labels', async ({
  page,
}) => {
  const errors = watch(page);
  await page.goto('/?fixture=demo');
  await page.waitForFunction(() => window.__garden?.ready === true, undefined, { timeout: 60_000 });
  const pt = await page.evaluate(() =>
    window.__garden!.focusPlant('legacy-monolith', 'test-writer', 'mid'),
  );
  await page.mouse.click(pt!.x, pt!.y);
  const panel = page.getByRole('complementary', { name: 'Plant: test-writer' });
  await panel.getByRole('link', { name: 'Open plant view →' }).click();
  await expect(page).toHaveURL(new RegExp(`#/plant/${PLANT}$`));

  await expect(page.getByRole('heading', { name: 'test-writer', level: 2 })).toBeVisible();
  await expect(page.locator('.specimen')).toContainText('legacy-monolith · opus 5.5 · xhigh');
  await expect(page.locator('.specimen')).toContainText('Drooping (≥50%)');
  const why = page.getByRole('region', { name: 'Why this rate' });
  await expect(why).toContainText('26%');
  await expect(why).toContainText('95% Wilson interval 19%–36%');
  await expect(why).toContainText('n=102');
  await expect(why).toContainText('failure 75');
  await expect(why).toContainText('Tests failing at end');
  await expect(page.getByRole('region', { name: 'Harness (the soil)' })).toContainText(
    'mysql-legacy',
  );
  await expect(page.getByRole('region', { name: 'Loop tiers' })).toContainText('1,897');
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/m4-plant.png` });

  // T jumps to the runs table; expand the most recent run.
  await page.keyboard.press('t');
  const runs = page.getByRole('table', { name: 'Runs' });
  await expect(runs.locator('tbody tr[data-run-id]')).toHaveCount(40);
  await runs
    .getByRole('button', { name: /^Expand run/ })
    .first()
    .click();
  const detail = runs.locator('tr.run-detail');
  await expect(detail).toContainText('Last test command');
  await expect(detail).toContainText('n/a');
  // Read-only labels in fixture mode, with the reason.
  const success = detail.getByRole('button', { name: 'Success' });
  await expect(success).toBeDisabled();
  await expect(detail.getByRole('textbox')).toBeDisabled();
  await expect(detail).toContainText(
    'Labels are saved by the local server; run pnpm demo or garden serve.',
  );
  await page.locator('.runs-card').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.mouse.move(10, 10);
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/m4-plant-runs.png` });
  await detail.locator('.label-controls').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `${SHOTS}/m4-label-disabled.png`,
    clip: await detail.boundingBox().then((b) => ({
      x: 0,
      y: Math.max(0, b!.y - 120),
      width: 1440,
      height: Math.min(900 - Math.max(0, b!.y - 120), b!.height + 160),
    })),
  });

  // Legend stays one key away; Esc closes it first, then returns to the garden.
  await page.keyboard.press('l');
  await expect(page.getByRole('complementary', { name: 'Legend' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(new RegExp(`#/plant/${PLANT}$`));
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/#\/$/);
  expect(errors).toEqual([]);
});

test('other-bed link from the plant view, and ids outside the demo fixture show a clear state', async ({
  page,
}) => {
  const errors = watch(page);
  await page.goto(`/?fixture=demo#/plant/${PLANT}`);
  const other = page.getByRole('region', { name: 'Same agent, other beds' });
  await expect(other).toContainText('shop-api');
  await other.getByRole('link', { name: 'Compare in shop-api →' }).click();
  await expect(page).toHaveURL(
    new RegExp(`#/replant\\?agent=${TEST_WRITER}&from=${LEGACY}&to=${SHOP}$`),
  );
  await expect(page.getByRole('heading', { name: /not in the demo fixture/ })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'test-writer', level: 2 })).toBeVisible();
  await page.goto('/?fixture=demo#/plant/plt_nope');
  await expect(page.getByRole('heading', { name: /not in the demo fixture/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('compare beds via the picker, then the replant view (the demo moment)', async ({ page }) => {
  const errors = watch(page);
  await page.goto('/?fixture=demo');
  await page.waitForFunction(() => window.__garden?.ready === true, undefined, { timeout: 60_000 });

  // A bed label click opens the picker with that bed preselected.
  await page.evaluate(() => window.__garden!.focusPlant('shop-api', 'main', 'mid'));
  await page.waitForTimeout(200);
  const lp = await page.evaluate(() => window.__garden!.bedLabelPoint('shop-api'));
  expect(lp).not.toBeNull();
  await page.mouse.click(lp!.x, lp!.y);
  const picker = page.getByRole('dialog', { name: 'Compare beds' });
  await expect(picker).toBeVisible();
  await expect(picker.getByLabel('First bed')).toHaveValue(SHOP);
  await picker.getByLabel('Second bed').selectOption(LEGACY);
  await picker.getByRole('button', { name: 'Compare →' }).click();
  await expect(page).toHaveURL(new RegExp(`#/compare\\?left=${SHOP}&right=${LEGACY}$`));

  const soil = page.getByRole('region', { name: 'What differs in the soil' });
  await expect(soil).toContainText('Model: sonnet 5.5 → opus 5.5');
  await expect(soil).toContainText('+7 MCP servers');
  const shared = page.getByRole('table', { name: 'Shared agents' });
  await expect(shared).toContainText('−65 points');
  await expect(shared).toContainText('within noise');
  await expect(shared).toContainText('3.1×');
  await expect(page.getByText(/Correlation, not causation/)).toBeVisible();
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/m4-compare.png`, fullPage: false });

  await shared
    .getByRole('row', { name: /test-writer/ })
    .getByRole('link', { name: 'Replant view →' })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`#/replant\\?agent=${TEST_WRITER}&from=${SHOP}&to=${LEGACY}$`),
  );
  const verdict = page.locator('.verdict');
  await expect(verdict).toContainText('−65 points');
  await expect(verdict).toContainText('3.1×');
  await expect(verdict).toContainText('separated');
  await expect(verdict).toContainText('intervals don’t overlap');
  await expect(page.locator('.replant-mid')).toContainText('Correlation, not causation');
  await expect(page.locator('.replant-mid')).toContainText('Instructions +29.4 KB');
  await expect(page.locator('.plot-from')).toContainText('92%');
  await expect(page.locator('.plot-to')).toContainText('26%');
  await expect(page.getByRole('region', { name: 'Signals, side by side' })).toContainText(
    '8% → 74%',
  );
  await expect(page.getByRole('region', { name: 'Recent tasks in legacy-monolith' })).toContainText(
    'email templates',
  );
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/m4-replant.png` });

  // Hover a mark: tooltip with the numbers.
  const row = page.locator('.db-row').nth(2);
  await row.scrollIntoViewIfNeeded();
  const box = (await row.boundingBox())!;
  await page.mouse.move(box.x + 420, box.y + box.height / 2);
  await page.mouse.move(box.x + 430, box.y + box.height / 2, { steps: 3 });
  await expect(
    page.getByRole('tooltip').filter({ hasText: 'Tests failing at end (weight −0.35)' }),
  ).toBeVisible();

  // Back / forward through the hash history.
  await page.goBack();
  await expect(page).toHaveURL(/#\/compare/);
  await page.goForward();
  await expect(page).toHaveURL(/#\/replant/);
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/#\/$/);
  expect(errors).toEqual([]);
});

test('label round trip against a mocked local API: JSON POST, refetch, manual marker and rate update', async ({
  page,
}) => {
  const errors = watch(page);
  const garden = readFix('garden.demo.json');
  const plant = readFix('plant.demo.json') as {
    plant: { success: { value: number; nManual: number } };
    runs: {
      runId: string;
      outcome: { label: string; source: string; manual?: unknown; heuristicLabel: string };
    }[];
  };
  const runId = plant.runs[0]!.runId;
  const posts: { body: unknown; contentType: string | undefined }[] = [];
  let labeled = false;
  await page.route('**/api/**', async (route) => {
    const req: Request = route.request();
    const url = new URL(req.url());
    if (url.pathname === '/api/garden') return route.fulfill({ json: garden });
    if (url.pathname === `/api/plant/${PLANT}`) {
      if (!labeled) return route.fulfill({ json: plant });
      const next = structuredClone(plant);
      next.plant.success.value = 28 / 102;
      next.plant.success.nManual = 1;
      next.runs[0]!.outcome = {
        ...next.runs[0]!.outcome,
        label: 'success',
        source: 'manual',
        manual: { label: 'success', note: 'checked by hand', at: '2026-10-01T12:00:00.000Z' },
      };
      return route.fulfill({ json: next });
    }
    if (url.pathname === `/api/runs/${runId}/label` && req.method() === 'POST') {
      posts.push({ body: req.postDataJSON(), contentType: req.headers()['content-type'] });
      labeled = true;
      return route.fulfill({
        json: { runId, outcome: { label: 'success', source: 'manual' } },
      });
    }
    return route.fulfill({ status: 404, json: { error: 'not found' } });
  });
  await page.goto(`/#/plant/${PLANT}`);
  const why = page.getByRole('region', { name: 'Why this rate' });
  await expect(why).toContainText('26%');
  await expect(why).toContainText('0 manual labels');
  const runs = page.getByRole('table', { name: 'Runs' });
  await runs
    .getByRole('button', { name: /^Expand run/ })
    .first()
    .click();
  const detail = runs.locator('tr.run-detail');
  await expect(detail.getByRole('button', { name: 'Success' })).toBeEnabled();
  await detail.getByRole('textbox').fill('checked by hand');
  await detail.getByRole('button', { name: 'Success' }).click();
  await expect(detail).toContainText('Saved: success (manual).');
  expect(posts).toEqual([
    { body: { label: 'success', note: 'checked by hand' }, contentType: 'application/json' },
  ]);
  // Refetched: rate, manual count, and the row's manual marker (with the heuristic label) update.
  await expect(why).toContainText('27%');
  await expect(why).toContainText('1 manual label');
  await expect(runs.locator('tbody tr[data-run-id]').first()).toContainText(
    'manual · heuristic failure',
  );
  await expect(detail.getByRole('button', { name: 'Success' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(detail.getByRole('button', { name: 'Clear' })).toBeEnabled();
  await expect(detail).toContainText('Saved note (as stored, redacted): “checked by hand”');
  await expect(detail.getByRole('textbox')).toHaveValue('');
  expect(errors).toEqual([]);
});
