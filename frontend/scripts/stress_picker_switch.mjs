import path from 'node:path';
import { chromium } from 'playwright';
import { createStoredSettings, frontendDir, frontendPage } from './runtime.mjs';

const SESSION_COUNT = 24;
const ITEMS_PER_SESSION = 16;

function makeData() {
  const now = new Date().toISOString();
  const jobs = [];
  const sessions = [];

  for (let s = 0; s < SESSION_COUNT; s++) {
    const items = [];
    const slots = [null, null, null, null];
    for (let i = 0; i < ITEMS_PER_SESSION; i++) {
      const jobId = `job_${String(s).padStart(2, '0')}_${String(i).padStart(2, '0')}`;
      const imageId = `image_${i}`;
      jobs.push({
        job_id: jobId,
        created_at: now,
        status_cache: 'SUCCEEDED',
        model_cache: 'gemini-3-pro-image-preview',
        prompt_preview: `session-${s}-item-${i}`,
        params_cache: { aspect_ratio: '1:1', image_size: '1K', temperature: 0.7, timeout_sec: 120, max_retries: 1 },
        last_seen_at: now,
        pinned: false,
        tags: [],
      });
      const item = {
        job_id: jobId,
        image_id: imageId,
        added_at: now,
        picked: true,
        rating: (i % 5) + 1,
      };
      items.push(item);
      if (i < 4) slots[i] = `${jobId}::${imageId}`;
    }

    const first = items[0];
    const second = items[1];
    sessions.push({
      session_id: `pk_stress_${s}`,
      name: `Stress Session ${s}`,
      created_at: now,
      updated_at: now,
      cover: { job_id: first.job_id, image_id: first.image_id },
      items,
      best_image: { job_id: second.job_id, image_id: second.image_id },
      compare_mode: s % 3 === 0 ? 'FOUR' : s % 3 === 1 ? 'TWO' : 'FILMSTRIP',
      layout_preset: 'SYNC_ZOOM',
      ui: { background: 'dark', showGrid: false, showInfo: true },
      slots,
      focus_key: slots[0],
    });
  }

  return { jobs, sessions };
}

const { jobs, sessions } = makeData();
const firstSession = sessions[0].session_id;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 960 } });
const page = await context.newPage();

const pageErrors = [];
const consoleErrors = [];

page.on('pageerror', (err) => {
  pageErrors.push(String(err?.stack || err?.message || err));
});
page.on('console', (msg) => {
  if (msg.type() === 'error') {
    consoleErrors.push(msg.text());
  }
});

const storedSettings = createStoredSettings({
  polling: {
    concurrency: 3,
  },
});

await context.addInitScript(({ jobsIn, sessionsIn, firstIn, settingsIn }) => {
  localStorage.setItem('nbp_settings_v1', JSON.stringify(settingsIn));
  localStorage.setItem('nbp_jobs_v1', JSON.stringify(jobsIn));
  localStorage.setItem('nbp_picker_sessions_v1', JSON.stringify(sessionsIn));
  localStorage.setItem('nbp_picker_recent_v1', JSON.stringify({ last_session_id: firstIn, last_opened_at: new Date().toISOString() }));
}, { jobsIn: jobs, sessionsIn: sessions, firstIn: firstSession, settingsIn: storedSettings });

const assertAppVisible = async (step) => {
  await page.waitForTimeout(50);
  const ok = await page.locator('text=Image Picker').first().isVisible().catch(() => false);
  if (!ok) {
    await page.screenshot({ path: path.join(frontendDir, 'screenshots', 'picker', `stress-fail-${step}.png`), fullPage: true });
    throw new Error(`Picker header not visible at step ${step}`);
  }
};

await page.goto(frontendPage(`/picker?session=${encodeURIComponent(firstSession)}`), { waitUntil: 'networkidle' });
await assertAppVisible('init');

for (let i = 0; i < 240; i++) {
  const sid = sessions[i % sessions.length].session_id;
  await page.locator('select').first().selectOption(sid);

  if (i % 15 === 0) {
    await page.getByRole('button', { name: '4-up' }).click().catch(() => {});
  }
  if (i % 20 === 0) {
    await page.getByRole('button', { name: 'Filmstrip' }).click().catch(() => {});
  }
  if (i % 24 === 0) {
    await page.getByRole('button', { name: '2-up' }).click().catch(() => {});
  }

  if (i % 30 === 0) {
    await page.goto(frontendPage('/history'), { waitUntil: 'networkidle' });
    const historyOk = await page.locator('text=History').first().isVisible().catch(() => false);
    if (!historyOk) {
      await page.screenshot({ path: path.join(frontendDir, 'screenshots', 'picker', `stress-history-fail-${i}.png`), fullPage: true });
      throw new Error(`History page not visible at loop ${i}`);
    }
    await page.goto(frontendPage(`/picker?session=${encodeURIComponent(sid)}`), { waitUntil: 'networkidle' });
  }

  await assertAppVisible(i);
}

console.log(JSON.stringify({
  ok: true,
  loops: 240,
  pageErrors: pageErrors.length,
  consoleErrors: consoleErrors.length,
  pageErrorsSample: pageErrors.slice(0, 5),
  consoleErrorsSample: consoleErrors.slice(0, 5),
}, null, 2));

await browser.close();
