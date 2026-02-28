import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(process.cwd(), '..');
const jobsDir = path.join(root, 'backend', 'data', 'jobs');
const outDir = path.join(process.cwd(), 'videos');
fs.mkdirSync(outDir, { recursive: true });

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
    prompt_preview: (req.prompt || '').slice(0, 70) || id,
    params_cache: meta.params || {},
    last_seen_at: meta.updated_at || meta.created_at || new Date().toISOString(),
    pinned: false,
    tags: [],
  });
  for (const imageId of imageIds) refs.push({ job_id: id, image_id: imageId });
}

if (refs.length < 4) throw new Error('Need at least 4 images for video demo.');

const now = new Date().toISOString();
const session = {
  session_id: 'pk_video_demo',
  name: 'Video Demo',
  created_at: now,
  updated_at: now,
  items: refs.slice(0, 10).map((r, idx) => ({
    job_id: r.job_id,
    image_id: r.image_id,
    pool: idx < 8 ? 'FILMSTRIP' : 'PREFERRED',
    picked: true,
    rating: (idx % 5) + 1,
    added_at: now,
  })),
  compare_mode: 'FOUR',
  layout_preset: 'SYNC_ZOOM',
  ui: { background: 'dark', showGrid: false, showInfo: true },
  slots: refs.slice(0, 4).map((r) => `${r.job_id}::${r.image_id}`),
  focus_key: `${refs[0].job_id}::${refs[0].image_id}`,
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1560, height: 960 },
  recordVideo: { dir: outDir, size: { width: 1560, height: 960 } },
});
const page = await context.newPage();

await context.addInitScript(({ jobsIn, sessionIn }) => {
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
  localStorage.setItem('nbp_picker_sessions_v1', JSON.stringify([sessionIn]));
  localStorage.setItem('nbp_picker_recent_v1', JSON.stringify({ last_session_id: sessionIn.session_id, last_opened_at: new Date().toISOString() }));
}, { jobsIn: jobs.slice(0, 80), sessionIn: session });

await page.goto('http://127.0.0.1:5173/picker?session=pk_video_demo', { waitUntil: 'networkidle' });
await page.waitForSelector('text=Image Picker');
await page.waitForTimeout(900);

await page.getByRole('button', { name: 'Filmstrip' }).first().click();
await page.waitForTimeout(700);
await page.getByRole('button', { name: '切换下一组' }).first().click();
await page.waitForTimeout(700);

const preferBtn = page.getByRole('button', { name: '优选' }).first();
if (await preferBtn.isVisible().catch(() => false)) {
  await preferBtn.click();
}
await page.waitForTimeout(700);

await page.getByRole('button', { name: '全屏审阅' }).first().click();
await page.waitForTimeout(800);
await page.waitForTimeout(1000);
await page.getByRole('button', { name: '退出全屏' }).first().click();
await page.waitForTimeout(700);

await page.getByRole('button', { name: '从历史导入' }).first().click();
await page.waitForSelector('text=导入图片');
const readBtns = page.getByRole('button', { name: '读取图片' });
if (await readBtns.count() > 0) {
  await readBtns.first().click();
  await page.waitForTimeout(800);
}
const importBtn = page.getByRole('button', { name: '导入选中' }).first();
if (await importBtn.isVisible().catch(() => false)) {
  await importBtn.click();
}
await page.waitForTimeout(900);

const rawVideoPath = await page.video().path();
await context.close();
await browser.close();

const target = path.join(outDir, 'picker_after_fix_demo.webm');
fs.copyFileSync(rawVideoPath, target);
console.log(target);
