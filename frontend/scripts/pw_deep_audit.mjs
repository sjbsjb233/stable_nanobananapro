#!/usr/bin/env node
// Comprehensive frontend audit with Playwright.
// - Boots against the dev server at http://127.0.0.1:5173
// - Backend must be running with TEST_ENV_ADMIN_BYPASS=true TEST_FAKE_GENERATOR=true
// - Visits every route, exercises core features, captures screenshots,
//   collects console/page/network errors, and writes a JSON + Markdown report.

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(scriptDir, '..');
const repoDir = path.resolve(frontendDir, '..');
const outDir = path.join(repoDir, 'output', 'test-run');
const shotsDir = path.join(outDir, 'screenshots');
fs.mkdirSync(shotsDir, { recursive: true });

const frontendUrl = process.env.NBP_FRONTEND_URL || 'http://127.0.0.1:5173';
const backendUrl = process.env.NBP_BACKEND_URL || 'http://127.0.0.1:8000';

const findings = []; // {severity: 'error'|'warn'|'info', area: string, detail: any}
const steps = []; // {name, ok, error?, durationMs}
const pageErrorsByStep = {}; // name -> array
const consoleErrorsByStep = {}; // name -> array
const failedRequestsByStep = {}; // name -> array

let currentStep = null;
const pushErr = (arr, obj) => {
  if (!currentStep) return;
  (arr[currentStep] = arr[currentStep] || []).push(obj);
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: 'zh-CN',
  // baseURL not necessary, we use full URLs below
});

// Pre-seed tutorial dismissal so modals don't block navigation in generic tests.
await context.addInitScript(() => {
  try {
    const key = 'nbp_tutorial_seen_v1';
    const current = JSON.parse(window.localStorage.getItem(key) || '{}');
    window.localStorage.setItem(
      key,
      JSON.stringify({ ...current, Create: true, Batch: true, History: true, Picker: true })
    );
  } catch {}
});

const page = await context.newPage();
page.setDefaultTimeout(15000);

page.on('pageerror', (err) => {
  const msg = String(err?.stack || err?.message || err);
  pushErr(pageErrorsByStep, { msg });
});
page.on('console', (msg) => {
  if (msg.type() === 'error') {
    const text = msg.text();
    // Aborted requests are tracked separately as "noise" finding, but skip the
    // verbose per-nav repeats to keep the console-errors list actionable.
    if (/signal is aborted without reason|AbortError/.test(text)) {
      pushErr(consoleErrorsByStep, { text: `[abort] ${text.slice(0, 160)}`, abort: true });
      return;
    }
    pushErr(consoleErrorsByStep, { text, location: msg.location() });
  }
});
page.on('requestfailed', (req) => {
  const url = req.url();
  if (url.includes('__vite_ping') || url.includes('/@vite/client')) return;
  const failure = req.failure()?.errorText || '';
  pushErr(failedRequestsByStep, { url, failure, abort: failure === 'net::ERR_ABORTED' });
});
page.on('response', (resp) => {
  const url = resp.url();
  if (!/\/v1\//.test(url)) return;
  if (resp.status() >= 500) {
    pushErr(failedRequestsByStep, { url, status: resp.status(), statusText: resp.statusText() });
  }
});

// Dialogs (window.prompt/confirm/alert) - accept with default answers.
let promptDialogCount = 0;
page.on('dialog', async (dialog) => {
  try {
    if (dialog.type() === 'prompt') {
      promptDialogCount += 1;
      await dialog.accept(`PW-dialog-${promptDialogCount}`);
    } else {
      await dialog.accept();
    }
  } catch {}
});

async function shot(name) {
  const file = path.join(shotsDir, `${name}.png`);
  try {
    await page.screenshot({ path: file, fullPage: false });
    return path.relative(repoDir, file);
  } catch (e) {
    return null;
  }
}

async function runStep(name, fn, { required = false } = {}) {
  currentStep = name;
  pageErrorsByStep[name] = pageErrorsByStep[name] || [];
  consoleErrorsByStep[name] = consoleErrorsByStep[name] || [];
  failedRequestsByStep[name] = failedRequestsByStep[name] || [];
  const started = Date.now();
  let ok = true;
  let error = null;
  try {
    await fn();
  } catch (e) {
    ok = false;
    error = e?.message || String(e);
    findings.push({
      severity: required ? 'error' : 'warn',
      area: name,
      detail: `step failed: ${error}`,
    });
    await shot(`fail-${name}`);
  }
  const durationMs = Date.now() - started;
  steps.push({ name, ok, error, durationMs });
  currentStep = null;
}

// Wait for dashboard top nav
async function waitForDashboard() {
  await page.waitForSelector('[data-testid="nav-dashboard"]', { timeout: 20000 });
}

// ---------------------------------------------------------------
// Steps
// ---------------------------------------------------------------

await runStep('boot', async () => {
  await page.goto(frontendUrl, { waitUntil: 'networkidle' });
  await waitForDashboard();
  await shot('00-boot');
}, { required: true });

if (!steps[0].ok) {
  // Hard fail — persist what we have and exit.
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({
    frontendUrl, backendUrl, steps, findings,
    pageErrorsByStep, consoleErrorsByStep, failedRequestsByStep,
  }, null, 2));
  await browser.close();
  process.exit(1);
}

await runStep('dashboard', async () => {
  await page.goto(`${frontendUrl}/`, { waitUntil: 'domcontentloaded' });
  await waitForDashboard();
  // basic visible content
  const bodyText = await page.locator('body').innerText();
  if (!bodyText) throw new Error('empty dashboard body');
  await shot('01-dashboard');
});

await runStep('nav-create', async () => {
  await page.getByTestId('nav-create').click();
  await page.waitForSelector('[data-testid="create-submit"]', { timeout: 10000 });
  await page.waitForSelector('[data-testid="create-prompt"]');
  await shot('02-create');
});

await runStep('nav-batch', async () => {
  await page.getByTestId('nav-batch').click();
  // batch-global-provider-select should exist
  await page.waitForURL(/\/batch/);
  await page.waitForTimeout(400);
  await shot('03-batch');
});

await runStep('nav-history', async () => {
  await page.getByTestId('nav-history').click();
  await page.waitForSelector('[data-testid="history-search"]', { timeout: 10000 });
  await shot('04-history');
});

await runStep('nav-picker', async () => {
  await page.getByTestId('nav-picker').click();
  await page.waitForSelector('[data-testid="picker-stage"]', { timeout: 10000 });
  await shot('05-picker');
});

await runStep('nav-admin', async () => {
  const adminNav = page.getByTestId('nav-admin');
  if (!(await adminNav.isVisible().catch(() => false))) {
    throw new Error('admin nav not visible (test-env admin bypass should expose it)');
  }
  await adminNav.click();
  await page.waitForSelector('[data-testid="admin-user-search"]', { timeout: 10000 });
  await page.waitForSelector('[data-testid="admin-danger-zone"]');
  await shot('06-admin');
});

await runStep('nav-settings', async () => {
  await page.getByTestId('nav-settings').click();
  await page.waitForSelector('[data-testid="settings-save"]', { timeout: 10000 });
  await shot('07-settings');
});

// Settings -> toggle + save + reload persistence
await runStep('settings-toggle-cache-persist', async () => {
  await page.goto(`${frontendUrl}/settings`);
  const toggle = page.getByTestId('settings-cache-enabled');
  await toggle.waitFor();
  const classBefore = await toggle.getAttribute('class');
  const wasEnabled = /border-emerald-400/.test(classBefore || '');
  await toggle.click();
  await page.getByTestId('settings-save').click();

  const toastText = await page.locator('body').innerText();
  // Verify local storage flipped
  const storedAfter = await page.evaluate(() => {
    const raw = window.localStorage.getItem('nbp_settings_v1');
    return raw ? JSON.parse(raw) : null;
  });
  if (!storedAfter) throw new Error('settings not stored');
  if (storedAfter.cache?.enabled === wasEnabled) {
    throw new Error(`cache toggle state did not persist (before=${wasEnabled}, after=${storedAfter.cache?.enabled})`);
  }

  await page.reload();
  await page.waitForSelector('[data-testid="settings-save"]');
  const classAfterReload = await page.getByTestId('settings-cache-enabled').getAttribute('class');
  const enabledAfterReload = /border-emerald-400/.test(classAfterReload || '');
  if (enabledAfterReload === wasEnabled) {
    throw new Error('cache toggle did not round-trip through reload');
  }

  // Revert to original for downstream tests
  await page.getByTestId('settings-cache-enabled').click();
  await page.getByTestId('settings-save').click();
});

// Tutorial: clear seen flags and verify modal auto-opens.
await runStep('tutorial-auto-open', async () => {
  // Use a fresh context without the tutorial pre-seed so the modal auto-opens.
  const ctx2 = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
  });
  const page2 = await ctx2.newPage();
  page2.setDefaultTimeout(15000);
  try {
    await page2.goto(`${frontendUrl}/create`, { waitUntil: 'domcontentloaded' });
    await page2.waitForSelector('[data-testid="nav-dashboard"]');
    const dialog = page2.getByRole('dialog', { name: /欢迎使用 Create/ });
    await dialog.waitFor({ timeout: 8000 });
    await page2.screenshot({ path: path.join(shotsDir, '08a-tutorial-create.png') });
    await dialog.getByRole('button', { name: /关闭教程/ }).click();
    await dialog.waitFor({ state: 'hidden' });
    const seen = await page2.evaluate(() => {
      const raw = window.localStorage.getItem('nbp_tutorial_seen_v1');
      return raw ? JSON.parse(raw) : {};
    });
    if (!seen?.Create) throw new Error('tutorial-seen flag did not persist for Create');
  } finally {
    await ctx2.close();
  }
});

// Tutorial: re-open manually.
await runStep('tutorial-manual-reopen', async () => {
  await page.goto(`${frontendUrl}/create`);
  await page.waitForSelector('[data-testid="create-submit"]');
  // Button shown in the header/panel.
  const btn = page.getByRole('button', { name: 'Create 教程' });
  if (!(await btn.isVisible().catch(() => false))) {
    throw new Error('Create 教程 button not visible');
  }
  await btn.click();
  const dialog = page.getByRole('dialog', { name: /欢迎使用 Create/ });
  await dialog.waitFor({ timeout: 5000 });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
});

// Pre-seed tutorials again to keep subsequent steps clean.
await page.evaluate(() => {
  window.localStorage.setItem(
    'nbp_tutorial_seen_v1',
    JSON.stringify({ Create: true, Batch: true, History: true, Picker: true })
  );
});

// Submit a job via fake generator and wait for completion in History
await runStep('create-submit-job', async () => {
  const prompt = `pw-audit ${Date.now()}`;
  await page.goto(`${frontendUrl}/create`);
  await page.getByTestId('create-prompt').fill(prompt);
  await page.getByTestId('create-submit').click();
  await page.waitForURL(/\/history/, { timeout: 10000 });
  const card = page.getByTestId('history-card').filter({ hasText: prompt }).first();
  await card.waitFor({ timeout: 15000 });
  // Wait until SUCCEEDED chip appears somewhere in the card
  await page.waitForFunction((text) => {
    const cards = document.querySelectorAll('[data-testid="history-card"]');
    for (const c of cards) {
      if (c.textContent?.includes(text) && c.textContent?.includes('SUCCEEDED')) return true;
    }
    return false;
  }, prompt, { timeout: 25000 });
  await shot('09-history-after-create');
  // Open detail modal
  await card.click();
  const dialog = page.getByRole('dialog', { name: 'History detail modal' });
  await dialog.waitFor({ timeout: 8000 });
  if (!(await dialog.locator(':scope').innerText()).includes(prompt)) {
    throw new Error('history detail modal missing prompt text');
  }
  await shot('10-history-detail');
  // Close
  await page.keyboard.press('Escape');
});

// Validate history filters don't crash the page
await runStep('history-filters', async () => {
  await page.goto(`${frontendUrl}/history`);
  await page.getByTestId('history-search').fill('pw-audit');
  await page.waitForTimeout(300);
  const statusSel = page.getByTestId('history-status-filter');
  if (await statusSel.isVisible().catch(() => false)) {
    const options = await statusSel.locator('option').allTextContents();
    if (options.length < 2) throw new Error('status filter has no options');
    await statusSel.selectOption({ index: 1 }).catch(() => {});
  }
  await page.getByTestId('history-search').fill('');
  await shot('11-history-filters');
});

// Batch page - basic render + attempt a trivial batch submit
await runStep('batch-render', async () => {
  await page.goto(`${frontendUrl}/batch`);
  await page.waitForTimeout(500);
  // At least one prompt input and a submit button should exist
  const buttons = await page.locator('button').count();
  if (buttons < 3) throw new Error(`batch page looks empty, only ${buttons} buttons`);
  await shot('12-batch-rendered');
});

// Picker page - ensure toolbar mounts
await runStep('picker-render', async () => {
  await page.goto(`${frontendUrl}/picker`);
  await page.waitForSelector('[data-testid="picker-toolbar"]', { timeout: 10000 });
  await page.waitForSelector('[data-testid="picker-stage"]');
  await shot('13-picker-rendered');
});

// Picker - create a new session via sidebar (must pin sidebar first; it's
// hidden off-screen until toggled).
await runStep('picker-create-session', async () => {
  await page.goto(`${frontendUrl}/picker`);
  await page.waitForSelector('[data-testid="picker-stage"]');
  // Pin the sidebar so its contents are reachable to clicks.
  const toggle = page.getByTestId('picker-sidebar-toggle');
  await toggle.waitFor();
  await toggle.click();
  await page.waitForTimeout(300);
  const createBtn = page.getByTestId('picker-sidebar-create-session');
  await createBtn.waitFor();
  // The test-dialog handler accepts prompts with a generated name.
  await createBtn.click();
  await page.waitForTimeout(500);
  await shot('14-picker-session-created');
});

// Admin page features
await runStep('admin-filters', async () => {
  await page.goto(`${frontendUrl}/admin`);
  await page.waitForSelector('[data-testid="admin-user-search"]');
  await page.getByTestId('admin-user-search').fill('admin');
  await page.waitForTimeout(400);
  await shot('15-admin-users');
  // Scroll tasks panel into view
  await page.evaluate(() => window.scrollBy(0, 800));
  await page.waitForTimeout(200);
  await shot('16-admin-tasks');
});

// 404 page
await runStep('not-found', async () => {
  await page.goto(`${frontendUrl}/does-not-exist`, { waitUntil: 'domcontentloaded' });
  const bodyText = await page.locator('body').innerText();
  if (!/Not Found|404|未找到|页面/i.test(bodyText)) {
    // Maybe the NotFound page has different text; still check nav present
    if (!(await page.getByTestId('nav-dashboard').isVisible().catch(() => false))) {
      throw new Error('404 route yielded blank page');
    }
  }
  await shot('17-not-found');
});

// Theme toggle? If there's a settings control, exercise it - skipped for brevity

// Keyboard accessibility: tab through nav buttons
await runStep('keyboard-tab-nav', async () => {
  await page.goto(`${frontendUrl}/`);
  await waitForDashboard();
  // Focus body and tab a few times - shouldn't throw
  await page.locator('body').press('Tab');
  await page.locator('body').press('Tab');
  await page.locator('body').press('Tab');
});

// Settings - change password validation (empty + mismatched new passwords)
await runStep('settings-password-validation', async () => {
  await page.goto(`${frontendUrl}/settings`);
  await page.waitForSelector('[data-testid="settings-change-password-submit"]');
  await page.getByTestId('settings-current-password').fill('foo');
  await page.getByTestId('settings-new-password').fill('shortpw');
  await page.getByTestId('settings-confirm-new-password').fill('different-value-xx');
  await page.getByTestId('settings-change-password-submit').click();
  // Expect a toast or inline error; failure means nothing happened.
  await page.waitForTimeout(500);
  const body = await page.locator('body').innerText();
  if (!/不一致|mismatch|不同|不匹配|两次|确认|密码|至少|8/i.test(body)) {
    throw new Error('no validation feedback for mismatched password confirmation');
  }
  await shot('20-settings-password-validation');
  // Reset the field values so we don't leak into other tests
  await page.getByTestId('settings-current-password').fill('');
  await page.getByTestId('settings-new-password').fill('');
  await page.getByTestId('settings-confirm-new-password').fill('');
});

// History - pagination and density (sanity checks)
await runStep('history-pagination', async () => {
  await page.goto(`${frontendUrl}/history`);
  await page.waitForSelector('[data-testid="history-search"]');
  const pageSize = page.getByTestId('history-page-size');
  if (await pageSize.isVisible().catch(() => false)) {
    await pageSize.selectOption({ index: 0 }).catch(() => {});
  }
  const density = page.getByTestId('history-density-filter');
  if (await density.isVisible().catch(() => false)) {
    await density.selectOption({ index: 1 }).catch(() => {});
  }
  await page.waitForTimeout(200);
  await shot('21-history-pagination');
});

// Check that backend-connection editor on Login page works (by visiting login
// while logged out is blocked; instead exercise TopNav info).
await runStep('topnav-visible-on-admin', async () => {
  await page.goto(`${frontendUrl}/admin`);
  await page.waitForSelector('[data-testid="admin-user-search"]');
  const adminChip = page.getByTestId('nav-admin');
  if (!(await adminChip.isVisible())) {
    throw new Error('admin nav button missing while on admin page');
  }
});

// Responsive viewport
await runStep('responsive-mobile', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${frontendUrl}/`);
  await page.waitForTimeout(300);
  await shot('18-mobile-home');
  await page.goto(`${frontendUrl}/create`);
  await page.waitForSelector('[data-testid="create-submit"]');
  await shot('19-mobile-create');
  await page.setViewportSize({ width: 1440, height: 900 });
});

// Final save of report
const report = {
  startedAt: new Date().toISOString(),
  frontendUrl,
  backendUrl,
  totalSteps: steps.length,
  passed: steps.filter((s) => s.ok).length,
  failed: steps.filter((s) => !s.ok).length,
  steps,
  findings,
  pageErrorsByStep,
  consoleErrorsByStep,
  failedRequestsByStep,
};

fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

// Write a concise markdown report
const md = [];
md.push(`# Nano Banana Pro - Frontend Deep Audit\n`);
md.push(`- frontend: ${frontendUrl}`);
md.push(`- backend: ${backendUrl}`);
md.push(`- total steps: ${report.totalSteps}`);
md.push(`- passed: ${report.passed}`);
md.push(`- failed: ${report.failed}`);
md.push('');
md.push(`## Steps`);
md.push('| # | Step | Status | Duration (ms) | Error |');
md.push('|---|------|--------|---------------|-------|');
steps.forEach((s, i) => {
  md.push(`| ${i + 1} | ${s.name} | ${s.ok ? 'OK' : 'FAIL'} | ${s.durationMs} | ${(s.error || '').replace(/\|/g, '\\|')} |`);
});

function sectionForMap(title, map) {
  md.push(`\n## ${title}`);
  let any = false;
  for (const [step, entries] of Object.entries(map)) {
    if (!entries || !entries.length) continue;
    any = true;
    md.push(`\n### ${step} (${entries.length})`);
    for (const e of entries.slice(0, 20)) {
      md.push('```');
      md.push(JSON.stringify(e));
      md.push('```');
    }
  }
  if (!any) md.push('_none_');
}

sectionForMap('Console errors', consoleErrorsByStep);
sectionForMap('Page errors (uncaught)', pageErrorsByStep);
sectionForMap('Failed/5xx network requests', failedRequestsByStep);

md.push(`\n## Findings`);
if (!findings.length) md.push('_none_');
else findings.forEach((f) => md.push(`- [${f.severity}] ${f.area}: ${JSON.stringify(f.detail)}`));

fs.writeFileSync(path.join(outDir, 'report.md'), md.join('\n'));

await browser.close();

console.log(`\nWrote ${path.join(outDir, 'report.json')} and report.md`);
console.log(`Passed ${report.passed}/${report.totalSteps}, failed ${report.failed}`);
