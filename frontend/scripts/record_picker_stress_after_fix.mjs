import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const outDir = path.join(process.cwd(), 'videos');
fs.mkdirSync(outDir, { recursive: true });

const sessions = [];
const jobs = [];
const now = new Date().toISOString();
for (let s = 0; s < 12; s++) {
  const items = [];
  const slots = [null, null, null, null];
  for (let i = 0; i < 10; i++) {
    const job = `stress_job_${s}_${i}`;
    const image = `image_${i}`;
    jobs.push({
      job_id: job,
      created_at: now,
      status_cache: 'SUCCEEDED',
      model_cache: 'gemini-3-pro-image-preview',
      prompt_preview: `${job}`,
      params_cache: { aspect_ratio: '1:1', image_size: '1K', temperature: 0.7, timeout_sec: 120, max_retries: 1 },
      last_seen_at: now,
      pinned: false,
      tags: [],
      run_duration_ms: 38000 + i * 1000,
      run_started_at: now,
      run_finished_at: now,
    });
    const item = { job_id: job, image_id: image, added_at: now, picked: true, rating: (i % 5) + 1, pool: i < 8 ? 'FILMSTRIP' : 'PREFERRED' };
    items.push(item);
    if (i < 4) slots[i] = `${job}::${image}`;
  }
  sessions.push({
    session_id: `pk_stress_video_${s}`,
    name: `Stress Video ${s}`,
    created_at: now,
    updated_at: now,
    items,
    compare_mode: s % 2 === 0 ? 'FOUR' : 'TWO',
    layout_preset: 'SYNC_ZOOM',
    ui: { background: 'dark', showGrid: false, showInfo: true },
    slots,
    focus_key: slots[0],
  });
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1560, height: 960 },
  recordVideo: { dir: outDir, size: { width: 1560, height: 960 } },
});
const page = await context.newPage();

await context.addInitScript(({ jobsIn, sessionsIn }) => {
  localStorage.setItem('nbp_settings_v1', JSON.stringify({
    baseUrl: 'http://127.0.0.1:8000',
    defaultModel: 'gemini-3-pro-image-preview',
    jobAuthMode: 'ID_ONLY',
    adminModeEnabled: false,
    adminKey: '',
    defaultParams: {
      aspect_ratio: '1:1',
      image_size: '1K',
      thinking_level: null,
      temperature: 0.7,
      timeout_sec: 120,
      max_retries: 1,
    },
    defaultParamsByModel: {
      'gemini-3-pro-image-preview': {
        aspect_ratio: '1:1',
        image_size: '1K',
        thinking_level: null,
        temperature: 0.7,
        timeout_sec: 120,
        max_retries: 1,
      },
    },
    ui: { theme: 'dark', language: 'zh-CN', reduceMotion: true },
    polling: { intervalMs: 1200, maxIntervalMs: 5000, concurrency: 4 },
  }));
  localStorage.setItem('nbp_jobs_v1', JSON.stringify(jobsIn));
  localStorage.setItem('nbp_picker_sessions_v1', JSON.stringify(sessionsIn));
  localStorage.setItem('nbp_picker_recent_v1', JSON.stringify({ last_session_id: sessionsIn[0].session_id, last_opened_at: new Date().toISOString() }));
}, { jobsIn: jobs, sessionsIn: sessions });

await page.goto(`http://127.0.0.1:5173/picker?session=${encodeURIComponent(sessions[0].session_id)}`, { waitUntil: 'networkidle' });
await page.waitForSelector('text=Image Picker');
await page.waitForTimeout(900);

for (let i = 0; i < 24; i++) {
  const sid = sessions[i % sessions.length].session_id;
  await page.locator('select').first().selectOption(sid);
  if (i % 6 === 0) await page.getByRole('button', { name: '切换下一组' }).first().click();
  if (i % 8 === 0) await page.getByRole('button', { name: 'Filmstrip' }).first().click();
  if (i % 10 === 0) await page.getByRole('button', { name: '4-up' }).first().click();
  if (i % 12 === 0) {
    await page.goto('http://127.0.0.1:5173/history', { waitUntil: 'networkidle' });
    await page.waitForTimeout(350);
    await page.goto(`http://127.0.0.1:5173/picker?session=${encodeURIComponent(sid)}`, { waitUntil: 'networkidle' });
  }
  await page.waitForTimeout(320);
}

const videoPath = await page.video().path();
await context.close();
await browser.close();

const target = path.join(outDir, 'picker_stress_after_fix.webm');
fs.copyFileSync(videoPath, target);
console.log(target);
