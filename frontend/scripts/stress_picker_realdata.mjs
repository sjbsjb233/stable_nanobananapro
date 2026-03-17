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
      return result.images
        .map((x) => x.image_id || x.id || x.imageId)
        .filter((x) => typeof x === 'string' && x);
    }
  }
  if (Array.isArray(result.image_ids)) return result.image_ids.filter((x) => typeof x === 'string' && x);
  if (Array.isArray(result.imageIds)) return result.imageIds.filter((x) => typeof x === 'string' && x);
  return [];
}

const jobDirs = fs.readdirSync(jobsDir).filter((id) => fs.statSync(path.join(jobsDir, id)).isDirectory());
const refs = [];
const jobs = [];

for (const id of jobDirs) {
  const meta = safeJson(path.join(jobsDir, id, 'meta.json'), {});
  const req = safeJson(path.join(jobsDir, id, 'request.json'), {});
  const imageIds = extractImageIds(meta.result);
  jobs.push({
    job_id: id,
    created_at: meta.created_at || new Date().toISOString(),
    status_cache: meta.status || 'UNKNOWN',
    model_cache: meta.model || 'gemini-3-pro-image-preview',
    prompt_preview: (req.prompt || '').slice(0, 80) || id,
    params_cache: meta.params || {},
    last_seen_at: meta.updated_at || meta.created_at || new Date().toISOString(),
    pinned: false,
    tags: [],
  });

  for (const imageId of imageIds) {
    refs.push({ job_id: id, image_id: imageId, created_at: meta.created_at || new Date().toISOString() });
  }
}

if (!refs.length) {
  throw new Error(`No renderable images found in ${jobsDir}`);
}

jobs.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
refs.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

const sessionCount = Math.min(20, Math.max(8, refs.length));
const itemsPerSession = Math.min(18, Math.max(8, refs.length));
const sessions = [];
const now = new Date().toISOString();

for (let s = 0; s < sessionCount; s++) {
  const items = [];
  const slots = [null, null, null, null];
  for (let i = 0; i < itemsPerSession; i++) {
    const ref = refs[(s * 7 + i) % refs.length];
    const item = {
      job_id: ref.job_id,
      image_id: ref.image_id,
      added_at: now,
      picked: i % 3 !== 0,
      rating: (i % 5) + 1,
    };
    items.push(item);
    if (i < 4) slots[i] = `${ref.job_id}::${ref.image_id}`;
  }
  sessions.push({
    session_id: `pk_real_${s}`,
    name: `Real Stress ${s}`,
    created_at: now,
    updated_at: now,
    cover: { job_id: items[0].job_id, image_id: items[0].image_id },
    items,
    best_image: { job_id: items[1].job_id, image_id: items[1].image_id },
    compare_mode: s % 3 === 0 ? 'FOUR' : s % 3 === 1 ? 'TWO' : 'FILMSTRIP',
    layout_preset: 'SYNC_ZOOM',
    ui: { background: 'dark', showGrid: s % 2 === 0, showInfo: true },
    slots,
    focus_key: slots[0],
  });
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 980 } });
const page = await context.newPage();

const pageErrors = [];
const consoleErrors = [];

page.on('pageerror', (err) => pageErrors.push(String(err?.stack || err?.message || err)));
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});

const firstSession = sessions[0].session_id;

const storedSettings = createStoredSettings({
  polling: {
    concurrency: 5,
  },
});

await context.addInitScript(({ jobsIn, sessionsIn, firstIn, settingsIn }) => {
  localStorage.setItem('nbp_settings_v1', JSON.stringify(settingsIn));
  localStorage.setItem('nbp_jobs_v1', JSON.stringify(jobsIn));
  localStorage.setItem('nbp_picker_sessions_v1', JSON.stringify(sessionsIn));
  localStorage.setItem('nbp_picker_recent_v1', JSON.stringify({ last_session_id: firstIn, last_opened_at: new Date().toISOString() }));
  localStorage.setItem('nbp_history_auto_refresh_pref_v1', JSON.stringify(false));
}, { jobsIn: jobs.slice(0, 240), sessionsIn: sessions, firstIn: firstSession, settingsIn: storedSettings });

const mustSee = async (label) => {
  const ok = await page.locator('text=Image Picker').first().isVisible().catch(() => false);
  if (!ok) {
    await page.screenshot({ path: path.join(frontendDir, 'screenshots', 'picker', `stress-real-fail-${label}.png`), fullPage: true });
    throw new Error(`White screen or picker missing at ${label}`);
  }
};

await page.goto(frontendPage(`/picker?session=${encodeURIComponent(firstSession)}`), { waitUntil: 'networkidle' });
await mustSee('init');

for (let i = 0; i < 260; i++) {
  const sid = sessions[i % sessions.length].session_id;
  await page.locator('select').first().selectOption(sid);

  if (i % 8 === 0) await page.getByRole('button', { name: '4-up' }).click().catch(() => {});
  if (i % 11 === 0) await page.getByRole('button', { name: 'Filmstrip' }).click().catch(() => {});
  if (i % 17 === 0) await page.getByRole('button', { name: '2-up' }).click().catch(() => {});
  if (i % 23 === 0) {
    await page.getByRole('button', { name: '全屏审阅' }).click().catch(() => {});
    await page.waitForTimeout(80);
    await page.getByRole('button', { name: '退出全屏' }).click().catch(() => {});
  }

  if (i % 25 === 0) {
    await page.goto(frontendPage('/history'), { waitUntil: 'networkidle' });
    const h = await page.locator('text=History').first().isVisible().catch(() => false);
    if (!h) throw new Error(`History missing at ${i}`);
    await page.goto(frontendPage(`/picker?session=${encodeURIComponent(sid)}`), { waitUntil: 'networkidle' });
  }

  if (i % 7 === 0) {
    await page.waitForTimeout(30);
  }

  await mustSee(i);
}

console.log(JSON.stringify({
  ok: true,
  loops: 260,
  sessions: sessions.length,
  jobs: jobs.length,
  refs: refs.length,
  pageErrors: pageErrors.length,
  consoleErrors: consoleErrors.length,
  pageErrorsSample: pageErrors.slice(0, 5),
  consoleErrorsSample: consoleErrors.slice(0, 8),
}, null, 2));

await browser.close();
