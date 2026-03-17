import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createStoredSettings, frontendDir, frontendPage, jobsDir } from './runtime.mjs';

const outDir = path.join(frontendDir, 'videos');
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
const allJobs = [];
const importableJobs = [];

for (const id of jobDirs) {
  const meta = safeJson(path.join(jobsDir, id, 'meta.json'), {});
  const req = safeJson(path.join(jobsDir, id, 'request.json'), {});
  const imageIds = extractImageIds(meta.result);
  const rec = {
    job_id: id,
    created_at: meta.created_at || new Date().toISOString(),
    status_cache: meta.status || 'UNKNOWN',
    model_cache: meta.model || 'gemini-3-pro-image-preview',
    prompt_preview: (req.prompt || '').slice(0, 80) || id,
    params_cache: meta.params || {},
    last_seen_at: meta.updated_at || meta.created_at || new Date().toISOString(),
    pinned: false,
    tags: [],
  };
  allJobs.push(rec);
  if (imageIds.length > 0) importableJobs.push(rec);
}

if (importableJobs.length < 2) {
  throw new Error('至少需要 2 个有图片结果的 job 才能完成导入+切换测试。');
}

allJobs.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
importableJobs.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1560, height: 960 },
  recordVideo: { dir: outDir, size: { width: 1560, height: 960 } },
});
const page = await context.newPage();

let dialogCount = 0;
const pageErrors = [];
const consoleErrors = [];
let reproduced = false;

page.on('dialog', async (dialog) => {
  dialogCount += 1;
  await dialog.accept(`慢速切换会话-${dialogCount}`);
});
page.on('pageerror', (err) => {
  pageErrors.push(String(err?.stack || err?.message || err));
});
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});

const storedSettings = createStoredSettings();

await context.addInitScript(({ jobsIn, settingsIn }) => {
  localStorage.setItem('nbp_settings_v1', JSON.stringify(settingsIn));
  localStorage.setItem('nbp_jobs_v1', JSON.stringify(jobsIn));
  localStorage.setItem('nbp_picker_sessions_v1', JSON.stringify([]));
  localStorage.setItem('nbp_picker_recent_v1', JSON.stringify({ last_session_id: '', last_opened_at: new Date().toISOString() }));
}, { jobsIn: allJobs.slice(0, 120), settingsIn: storedSettings });

const clickBtn = async (containsText) => {
  await page.evaluate((txt) => {
    const btn = Array.from(document.querySelectorAll('button')).find((x) => {
      const text = (x.textContent || '').trim();
      if (!text.includes(txt)) return false;
      const rect = x.getBoundingClientRect();
      const style = window.getComputedStyle(x);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    });
    if (btn) btn.click();
  }, containsText);
};

const openImportDrawer = async () => {
  for (let i = 0; i < 12; i++) {
    await clickBtn('从历史导入');
    const visible = await page.locator('text=导入图片').first().isVisible().catch(() => false);
    if (visible) return true;
    await page.waitForTimeout(220);
  }
  return false;
};

const closeImportDrawer = async () => {
  for (let i = 0; i < 8; i++) {
    await clickBtn('关闭');
    const visible = await page.locator('text=导入图片').first().isVisible().catch(() => false);
    if (!visible) return true;
    await page.waitForTimeout(150);
  }
  return false;
};

const parseTotalCount = async () => {
  return await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('*'));
    for (const n of nodes) {
      const t = (n.textContent || '').trim();
      const m = t.match(/已选\s*\d+\s*\/\s*总计\s*(\d+)/);
      if (m) return Number(m[1] || 0);
    }
    return 0;
  });
};

await page.goto(frontendPage('/picker'), { waitUntil: 'networkidle' });
await page.waitForSelector('text=Image Picker');
await page.waitForTimeout(1200);

for (let i = 0; i < 10; i++) {
  await clickBtn('新建会话');
  await page.waitForTimeout(280);
}

const sessionValues = await page.evaluate(() => {
  const sel = document.querySelector('select');
  if (!sel) return [];
  return Array.from(sel.querySelectorAll('option')).map((n) => n.getAttribute('value') || '').filter(Boolean);
});

for (let i = 0; i < sessionValues.length; i++) {
  const sid = sessionValues[i];
  await page.evaluate((value) => {
    const sel = document.querySelector('select');
    if (!sel) return;
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, sid);
  await page.waitForTimeout(1200);

  const opened = await openImportDrawer();
  if (!opened) throw new Error('导入抽屉打开失败');
  await page.waitForSelector('text=导入图片');
  await page.waitForTimeout(300);

  const jobId = importableJobs[i % importableJobs.length].job_id;
  const quickInput = page.getByPlaceholder('按 job_id 快速导入').first();
  await quickInput.fill(jobId);
  await clickBtn('导入该 Job');
  await page.waitForTimeout(2000);

  await closeImportDrawer();
  await page.waitForTimeout(500);
}

const perSessionTotals = [];
for (let i = 0; i < sessionValues.length; i++) {
  const sid = sessionValues[i];
  await page.evaluate((value) => {
    const sel = document.querySelector('select');
    if (!sel) return;
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, sid);

  await page.waitForTimeout(1600);

  const pickerVisible = await page.locator('text=Image Picker').first().isVisible().catch(() => false);
  const bodyTextLen = await page.evaluate(() => (document.body?.innerText || '').trim().length).catch(() => 0);
  const total = await parseTotalCount();
  perSessionTotals.push({ sid, total });

  if (!pickerVisible || bodyTextLen === 0) {
    reproduced = true;
    await page.screenshot({ path: path.join(outDir, 'picker_session_switch_import_blank.png'), fullPage: true });
    await page.waitForTimeout(2000);
    break;
  }
}

for (let loop = 0; loop < 40 && !reproduced; loop++) {
  const sid = sessionValues[loop % sessionValues.length];
  await page.evaluate((value) => {
    const sel = document.querySelector('select');
    if (!sel) return;
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, sid);
  await page.waitForTimeout(1600);
}

const rawVideoPath = await page.video().path();
await context.close();
await browser.close();

const target = path.join(outDir, 'picker_session_switch_import_slow.webm');
fs.copyFileSync(rawVideoPath, target);

console.log(JSON.stringify({
  ok: true,
  created_sessions: dialogCount,
  session_count: sessionValues.length,
  reproduced,
  video: target,
  imported_jobs_used: importableJobs.slice(0, 6).map((x) => x.job_id),
  perSessionTotals,
  pageErrors: pageErrors.length,
  consoleErrors: consoleErrors.length,
  pageErrorsSample: pageErrors.slice(0, 6),
  consoleErrorsSample: consoleErrors.slice(0, 10),
}, null, 2));
