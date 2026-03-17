import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createStoredSettings, frontendDir, frontendPage } from './runtime.mjs';

const outDir = path.join(frontendDir, 'videos');
fs.mkdirSync(outDir, { recursive: true });

let dialogCount = 0;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1560, height: 960 },
  recordVideo: { dir: outDir, size: { width: 1560, height: 960 } },
});
const page = await context.newPage();

const pageErrors = [];
const consoleErrors = [];
let reproduced = false;

page.on('pageerror', (err) => {
  pageErrors.push(String(err?.stack || err?.message || err));
});
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('dialog', async (dialog) => {
  dialogCount += 1;
  await dialog.accept(`切换测试会话-${dialogCount}`);
});

const storedSettings = createStoredSettings();

await context.addInitScript(({ settingsIn }) => {
  localStorage.setItem('nbp_settings_v1', JSON.stringify(settingsIn));
  localStorage.setItem('nbp_jobs_v1', JSON.stringify([]));
  localStorage.setItem('nbp_picker_sessions_v1', JSON.stringify([]));
  localStorage.setItem('nbp_picker_recent_v1', JSON.stringify({ last_session_id: '', last_opened_at: new Date().toISOString() }));
}, { settingsIn: storedSettings });

await page.goto(frontendPage('/picker'), { waitUntil: 'networkidle' });
await page.waitForSelector('text=Image Picker');
await page.waitForTimeout(800);

for (let i = 0; i < 14; i++) {
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const btn = btns.find((b) => (b.textContent || '').includes('新建会话'));
    if (btn) (btn).click();
  });
  await page.waitForTimeout(180);
}

const sessionValues = await page.evaluate(() => {
  const sel = document.querySelector('select');
  if (!sel) return [];
  return Array.from(sel.querySelectorAll('option'))
    .map((n) => n.getAttribute('value') || '')
    .filter(Boolean);
});

for (let i = 0; i < 320; i++) {
  const sid = sessionValues[i % sessionValues.length];
  await page.evaluate((value) => {
    const sel = document.querySelector('select');
    if (!sel) return;
    (sel).value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, sid);
  await page.waitForTimeout(80);

  const pickerVisible = await page.locator('text=Image Picker').first().isVisible().catch(() => false);
  const bodyTextLen = await page.evaluate(() => (document.body?.innerText || '').trim().length).catch(() => 0);

  if (!pickerVisible || bodyTextLen === 0) {
    reproduced = true;
    await page.screenshot({ path: path.join(outDir, 'picker_session_switch_blank.png'), fullPage: true });
    await page.waitForTimeout(1800);
    break;
  }

  if (i % 40 === 0) {
    await page.waitForTimeout(200);
  }
}

const videoPath = await page.video().path();
await context.close();
await browser.close();

const target = path.join(outDir, 'picker_session_switch_repro.webm');
fs.copyFileSync(videoPath, target);

console.log(JSON.stringify({
  ok: true,
  created_sessions: dialogCount,
  switched_sessions: sessionValues.length,
  switch_loops: reproduced ? 'stopped_on_repro' : 320,
  reproduced,
  video: target,
  pageErrors: pageErrors.length,
  consoleErrors: consoleErrors.length,
  pageErrorsSample: pageErrors.slice(0, 6),
  consoleErrorsSample: consoleErrors.slice(0, 10),
}, null, 2));
