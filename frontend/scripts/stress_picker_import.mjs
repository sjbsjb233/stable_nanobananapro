import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createStoredSettings, frontendDir, frontendPage, jobsDir } from './runtime.mjs';

function safeJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function extractImageIds(result) {
  if (!result) return [];
  if (Array.isArray(result.images)) {
    const first = result.images[0];
    if (typeof first === 'string') return result.images.filter((x) => typeof x === 'string' && x);
    if (first && typeof first === 'object') {
      return result.images.map((x) => x.image_id || x.id || x.imageId).filter((x) => typeof x === 'string' && x);
    }
  }
  if (Array.isArray(result.image_ids)) return result.image_ids.filter((x) => typeof x === 'string' && x);
  if (Array.isArray(result.imageIds)) return result.imageIds.filter((x) => typeof x === 'string' && x);
  return [];
}

const jobDirs = fs.readdirSync(jobsDir).filter((id) => fs.statSync(path.join(jobsDir, id)).isDirectory());
const jobs = [];
for (const id of jobDirs) {
  const meta = safeJson(path.join(jobsDir, id, 'meta.json'), {});
  const req = safeJson(path.join(jobsDir, id, 'request.json'), {});
  const imageIds = extractImageIds(meta.result);
  if (!imageIds.length) continue;
  jobs.push({
    job_id: id,
    created_at: meta.created_at || new Date().toISOString(),
    status_cache: meta.status || 'UNKNOWN',
    model_cache: meta.model || 'gemini-3-pro-image-preview',
    prompt_preview: (req.prompt || '').slice(0, 72) || id,
    params_cache: meta.params || {},
    last_seen_at: meta.updated_at || meta.created_at || new Date().toISOString(),
    pinned: false,
    tags: [],
  });
}

if (jobs.length < 3) throw new Error('Need at least 3 jobs with images for import stress.');
jobs.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

const now = new Date().toISOString();
const session = {
  session_id: 'pk_import_seed',
  name: 'Import Seed',
  created_at: now,
  updated_at: now,
  items: [],
  compare_mode: 'TWO',
  layout_preset: 'SYNC_ZOOM',
  ui: { background: 'dark', showGrid: false, showInfo: true },
  slots: [null, null, null, null],
  focus_key: null,
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1560, height: 960 } });
const page = await context.newPage();

const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (err) => pageErrors.push(String(err?.stack || err?.message || err)));
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('dialog', async (dialog) => {
  await dialog.accept(`Auto Session ${Date.now()}`);
});

const storedSettings = createStoredSettings();

await context.addInitScript(({ jobsIn, sessionIn, settingsIn }) => {
  localStorage.setItem('nbp_settings_v1', JSON.stringify(settingsIn));
  localStorage.setItem('nbp_jobs_v1', JSON.stringify(jobsIn));
  localStorage.setItem('nbp_picker_sessions_v1', JSON.stringify([sessionIn]));
  localStorage.setItem('nbp_picker_recent_v1', JSON.stringify({ last_session_id: sessionIn.session_id, last_opened_at: new Date().toISOString() }));
}, { jobsIn: jobs.slice(0, 80), sessionIn: session, settingsIn: storedSettings });

await page.goto(frontendPage('/picker?session=pk_import_seed'), { waitUntil: 'networkidle' });
await page.waitForSelector('text=Image Picker');

await page.evaluate(() => {
  const raw = JSON.parse(localStorage.getItem('nbp_picker_sessions_v1') || '[]');
  const now = new Date().toISOString();
  for (let i = 0; i < 6; i++) {
    raw.unshift({
      session_id: `pk_import_auto_${i}`,
      name: `Auto Session ${i}`,
      created_at: now,
      updated_at: now,
      items: [],
      compare_mode: 'TWO',
      layout_preset: 'SYNC_ZOOM',
      ui: { background: 'dark', showGrid: false, showInfo: true },
      slots: [null, null, null, null],
      focus_key: null,
    });
  }
  localStorage.setItem('nbp_picker_sessions_v1', JSON.stringify(raw));
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('text=Image Picker');

for (let i = 0; i < 8; i++) {
  const sessionSelect = page.locator('select').first();
  const options = await sessionSelect.locator('option').all();
  const pick = options[(i + 1) % options.length];
  const val = await pick.getAttribute('value');
  if (val) await sessionSelect.selectOption(val);

  await page.getByRole('button', { name: '从历史导入' }).first().click();
  await page.waitForSelector('text=导入图片');

  const readBtns = page.getByRole('button', { name: '读取图片' });
  const readCount = await readBtns.count();
  for (let r = 0; r < Math.min(4, readCount); r++) {
    await readBtns.nth(r).click();
    await page.waitForTimeout(120);
  }

  const importSelected = page.getByRole('button', { name: '导入选中' });
  if (await importSelected.isVisible().catch(() => false)) {
    await importSelected.click();
  }

  await page.waitForTimeout(120);
}

const pickerOk = await page.locator('text=Image Picker').first().isVisible().catch(() => false);
if (!pickerOk) {
  await page.screenshot({ path: path.join(frontendDir, 'screenshots', 'picker', 'stress-import-fail.png'), fullPage: true });
  throw new Error('Picker not visible after import stress');
}

console.log(JSON.stringify({
  ok: true,
  sessionsCreated: 6,
  importRounds: 8,
  pageErrors: pageErrors.length,
  consoleErrors: consoleErrors.length,
  pageErrorsSample: pageErrors.slice(0, 5),
  consoleErrorsSample: consoleErrors.slice(0, 8),
}, null, 2));

await browser.close();
