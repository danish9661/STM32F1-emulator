// Headed full-firmware test through the real page (worker run-loop), in the
// exact end-user environment: load + run the periph37 preset and wait for
// SUMMARY. TARGET=local runs against localhost:8765, default is live Pages.
import { test, expect } from '@playwright/test';
const TARGETS = {
  live: 'https://danish9661.github.io/STM32F1-emulator',
  local: 'http://localhost:8765',
};
const which = process.env.TARGET === 'local' ? 'local' : 'live';
test(`periph37 via page, headed (${which})`, async ({ page }) => {
  page.on('pageerror', e => console.log('PAGEERROR:', String(e).slice(0, 200)));
  await page.goto(TARGETS[which] + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  await page.selectOption('#presetSelect', 'periph37');
  await page.click('#loadPresetBtn');
  await expect(page.locator('#runBtn')).toBeEnabled({ timeout: 60000 });
  await page.click('#runBtn');
  let summary = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 280000) {
    await page.waitForTimeout(10000);
    const term = await page.locator('#terminal').textContent();
    const m = term.match(/SUMMARY\s+pass=(\d+)\s+fail=(\d+)/);
    if (m) { summary = m[0]; break; }
  }
  const term = await page.locator('#terminal').textContent();
  const fails = term.split('\n').filter(s => s.includes('FAIL'));
  console.log('SUMMARY:', summary || '(missing after 280s)');
  console.log('FAIL lines:', fails.length ? fails.slice(0, 10).join(' | ') : '(none)');
  expect(summary).toMatch(/pass=39 fail=0/);
});
