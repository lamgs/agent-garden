import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RouterResult } from '@garden/core';
import { expect, test, type Page } from '@playwright/test';

const SHOTS = resolve(import.meta.dirname, '..', '..', '..', 'docs', 'screenshots');
const FIX = resolve(import.meta.dirname, '..', 'src', 'fixtures', 'router.demo.json');
const fixture = JSON.parse(readFileSync(FIX, 'utf8')) as { results: RouterResult[] };

function collectErrors(page: Page): string[] {
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

async function openGarden(page: Page) {
  await page.goto('/?fixture=demo');
  await page.waitForFunction(() => window.__garden?.ready === true, undefined, { timeout: 60_000 });
  await page.waitForTimeout(400);
}

test('router box: "/" focuses, results with confidence and reasons, candidates glow, Esc clears', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openGarden(page);
  const q = 'write unit tests for the invoice totals';
  const expected = fixture.results.find((r) => r.query === q)!;
  const top = expected.candidates[0]!;
  expect(top.name).toBe('test-writer');

  await page.mouse.move(700, 500);
  await page.keyboard.press('/');
  const box = page.getByRole('searchbox');
  await expect(box).toBeFocused();
  await box.fill(q);
  await page.keyboard.press('Enter');

  const list = page.locator('.router-list > li');
  await expect(list).toHaveCount(3);
  const first = list.first();
  await expect(first).toHaveAttribute('data-candidate', 'test-writer');
  await expect(first.locator('.router-conf')).toHaveText(`${Math.round(top.confidence * 100)}%`);
  await expect(first.locator('[data-reason="description_match"]')).toContainText('unit');
  await expect(first.locator('[data-reason="similar_past_task"]').first()).toContainText(
    'invoice totals',
  );
  await expect(first.locator('[data-reason="outcome_history"]')).toContainText('n=');

  // Garden: exactly the candidates' plants glow.
  const want = [...new Set(expected.candidates.slice(0, 3).flatMap((c) => c.plantIds))].sort();
  const lit = await page.evaluate(() => window.__garden!.highlighted!());
  expect([...lit].sort()).toEqual(want);

  await first.getByText('How computed').click();
  const how = first.locator('.router-how');
  await expect(how).toContainText('Lexical');
  await expect(how).toContainText('× 0.45');
  await expect(how).toContainText('Platt');
  await page.mouse.move(1300, 850);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/m6-router.png` });

  // Esc in the box clears the results and the highlight.
  await box.focus();
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  expect(await page.evaluate(() => window.__garden!.highlighted!())).toEqual([]);
  expect(errors).toEqual([]);
});

test('router box in fixture mode offers the bundled questions for anything else', async ({
  page,
}) => {
  await openGarden(page);
  await page.getByRole('searchbox').fill('rotate the staging database password');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toContainText('only has answers for a few questions');
  await page.getByRole('button', { name: fixture.results[2]!.query }).click();
  await expect(page.locator('.router-list > li').first()).toHaveAttribute(
    'data-candidate',
    fixture.results[2]!.candidates[0]!.name,
  );
});

test('legend lists the router highlight channel', async ({ page }) => {
  await openGarden(page);
  await page.keyboard.press('l');
  const entry = page.locator('[data-encoding-id="router.highlight"]');
  await expect(entry).toBeVisible();
  await expect(entry).toContainText('Suggested: glow + confidence %');
  await expect(entry).toContainText('Not suggested: dimmed');
});
