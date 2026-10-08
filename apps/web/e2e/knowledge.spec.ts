/**
 * K: knowledge map page (fixture mode) and its garden integration (soil strata, knowledge weeds).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const SHOTS = resolve(import.meta.dirname, '..', '..', '..', 'docs', 'screenshots');
const FIX = resolve(import.meta.dirname, '..', 'src', 'fixtures');
const knowledge = JSON.parse(readFileSync(`${FIX}/knowledge.demo.json`, 'utf8')) as {
  bed: { id: string; name: string };
  findings: { title: string }[];
};

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

test('knowledge map: provenance map, findings with evidence, budget, sources table', async ({
  page,
}) => {
  const errors = watch(page);
  await page.setViewportSize({ width: 1440, height: 2300 });
  await page.goto(`/?fixture=demo#/knowledge/${knowledge.bed.id}`);
  await expect(page.getByRole('heading', { name: knowledge.bed.name, level: 2 })).toBeVisible();
  const map = page.getByRole('region', { name: 'Provenance map' });
  await expect(map.locator('svg.knowledge-map')).toBeVisible();
  await expect(map).toContainText('Topsoil · always loaded');
  await expect(map).toContainText('Compost · not loaded');
  await expect(map).toContainText('missing');
  const findings = page.getByRole('region', { name: 'Findings' });
  await expect(findings.locator('li.k-finding')).toHaveCount(knowledge.findings.length);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/k-knowledge.png` });
  await expect(findings).toContainText('MEMORY.md is 260 lines');
  await expect(findings).toContainText('legacy-runbook.md');
  // Clicking a finding highlights its sources on the map.
  await findings.getByRole('button', { name: /not referenced from MEMORY\.md/ }).click();
  await expect(findings.locator('li.k-finding.on')).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Always-loaded budget' })).toContainText(
    'MEMORY.md index',
  );
  await page.screenshot({ path: `${SHOTS}/k-knowledge-focus.png` });
  // T jumps to the sources table; L opens the legend with the knowledge channels.
  await page.keyboard.press('t');
  await expect(page.getByRole('table', { name: 'Knowledge sources' })).toBeVisible();
  await page.keyboard.press('l');
  await expect(page.locator('[data-encoding-id="knowledge.edge"]')).toBeVisible();
  expect(errors).toEqual([]);
});

test('garden: knowledge weeds in the legacy bed, strata bands, link from the bed picker', async ({
  page,
}) => {
  const errors = watch(page);
  await page.goto('/?fixture=demo');
  await page.waitForFunction(() => window.__garden?.ready === true, undefined, { timeout: 60_000 });
  await page.evaluate(() => window.__garden!.focusPlant('legacy-monolith', 'test-writer', 'near'));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/k-garden-weeds.png` });
  await page.getByRole('button', { name: 'Compare beds' }).click();
  const picker = page.getByRole('dialog', { name: 'Compare beds' });
  await picker.locator('select').first().selectOption(knowledge.bed.id);
  await picker.getByRole('link', { name: /Knowledge map of legacy-monolith/ }).click();
  await expect(page).toHaveURL(new RegExp(`#/knowledge/${knowledge.bed.id}$`));
  expect(errors).toEqual([]);
});
