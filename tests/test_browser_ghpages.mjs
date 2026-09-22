import { test, expect } from '@playwright/test';
// Live-deployment tests against GitHub Pages (NOT localhost): validates what
// is actually deployed, including COOP/COEP-less SAB fallback + worker boot.
const BASE = 'https://danish9661.github.io/STM32F1-emulator';

test('gh-pages: echo preset UART round-trip (headed)', async ({ page }) => {
  page.on('console', m => { if (m.type() === 'error') console.log('BROWSER ERR:', m.text().slice(0,150)); });
  page.on('pageerror', e => console.log('PAGEERROR:', String(e).slice(0,200)));
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.selectOption('#presetSelect', 'echo');
  await page.click('#loadPresetBtn');
  await expect(page.locator('#runBtn')).toBeEnabled({ timeout: 60000 });
  await page.click('#runBtn');
  await page.waitForTimeout(4000);
  await page.fill('#uartInput', 'Hi');
  await page.click('#sendBtn');
  await page.waitForTimeout(5000);
  const term = await page.locator('#terminal').textContent();
  console.log('TERMINAL:', JSON.stringify(term.slice(-300)));
  await page.screenshot({ path: '/tmp/gh_echo.png' });
  expect(term).toContain('Hi');
});

test('gh-pages: GPIO grid renders on blink', async ({ page }) => {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.selectOption('#presetSelect', 'blink');
  await page.click('#loadPresetBtn');
  await expect(page.locator('#runBtn')).toBeEnabled({ timeout: 60000 });
  await page.click('#runBtn');
  await expect.poll(async () => page.locator('.gpio-port').count(), { timeout: 45000 }).toBeGreaterThanOrEqual(3);
});
