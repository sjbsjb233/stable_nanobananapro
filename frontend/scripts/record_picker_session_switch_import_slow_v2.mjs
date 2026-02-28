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
  if (imageIds.length > 0) importableJobs.push({ ...rec, imageIds });
}

if (!importableJobs.length) throw new Error('没有可导入图片的 job');
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
page.on('pageerror', (err) => pageErrors.push(String(err?.stack || err?.message || err)));
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});

await context.addInitScript(({ jobsIn }) => {
  if (localStorage.getItem('__picker_repro_seeded_v2__') === '1') return;
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
  localStorage.setItem('nbp_picker_sessions_v1', JSON.stringify([]));
  localStorage.setItem('nbp_picker_recent_v1', JSON.stringify({ last_session_id: '', last_opened_at: new Date().toISOString() }));
  localStorage.setItem('__picker_repro_seeded_v2__', '1');
}, { jobsIn: allJobs.slice(0, 150) });

const clickVisibleBtn = async (text) => {
  for (let i = 0; i < 8; i++) {
    const clicked = await page.evaluate((txt) => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => {
        const t = (b.textContent || '').trim();
        if (!t.includes(txt)) return false;
        const rect = b.getBoundingClientRect();
        const cs = window.getComputedStyle(b);
        const disabled = (b instanceof HTMLButtonElement && b.disabled) || b.getAttribute('aria-disabled') === 'true';
        return rect.width > 0 && rect.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && !disabled;
      });
      if (!btn) return false;
      btn.click();
      return true;
    }, text);
    if (clicked) return true;
    await page.waitForTimeout(180);
  }
  return false;
};

const waitImportDrawer = async (wantOpen) => {
  for (let i = 0; i < 12; i++) {
    const visible = await page.locator('text=导入图片').first().isVisible().catch(() => false);
    if (wantOpen ? visible : !visible) return true;
    await page.waitForTimeout(150);
  }
  return false;
};

await page.goto('http://127.0.0.1:5173/picker', { waitUntil: 'networkidle' });
await page.waitForSelector('text=Image Picker');
await page.waitForTimeout(1200);

// 1) 先真实导入一次（满足你的要求）
if (!(await clickVisibleBtn('从历史导入'))) throw new Error('无法点击“从历史导入”按钮');
const opened = await waitImportDrawer(true);
if (!opened) throw new Error('导入抽屉首次打开失败');

const seedJob = importableJobs[0].job_id;
await page.getByPlaceholder('按 job_id 快速导入').first().fill(seedJob);
if (!(await clickVisibleBtn('导入该 Job'))) throw new Error('无法点击“导入该 Job”按钮');
await page.waitForTimeout(2200);
if (!(await clickVisibleBtn('关闭'))) throw new Error('无法点击“关闭”按钮');
await waitImportDrawer(false);
await page.waitForTimeout(1000);

const importStats = await page.evaluate(() => {
  const raw = JSON.parse(localStorage.getItem('nbp_picker_sessions_v1') || '[]');
  if (!Array.isArray(raw) || !raw.length) return { sessionCount: 0, currentItems: 0 };
  return {
    sessionCount: raw.length,
    currentItems: Array.isArray(raw[0]?.items) ? raw[0].items.length : 0,
  };
});
if (importStats.currentItems < 1) throw new Error('首次导入后当前会话没有图片');

// 2) 新建多个会话
const targetSessionCount = 11; // 默认 1 + 新建 10
for (let i = 0; i < 28; i++) {
  const curCount = await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('nbp_picker_sessions_v1') || '[]');
    return Array.isArray(raw) ? raw.length : 0;
  });
  if (curCount >= targetSessionCount) break;
  if (!(await clickVisibleBtn('新建会话'))) throw new Error('无法点击“新建会话”按钮');
  await page.waitForTimeout(260);
}

let createdSessionCount = await page.evaluate(() => {
  const raw = JSON.parse(localStorage.getItem('nbp_picker_sessions_v1') || '[]');
  return Array.isArray(raw) ? raw.length : 0;
});
let fallbackSeededSessions = 0;
if (createdSessionCount < targetSessionCount) {
  fallbackSeededSessions = await page.evaluate(({ targetSessionCount: target }) => {
    const raw = JSON.parse(localStorage.getItem('nbp_picker_sessions_v1') || '[]');
    if (!Array.isArray(raw) || !raw.length) return 0;
    const before = raw.length;
    const now = new Date().toISOString();
    const base = raw[0];
    while (raw.length < target) {
      raw.unshift({
        session_id: `pk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        name: `慢速切换会话-${raw.length + 1}`,
        created_at: now,
        updated_at: now,
        items: [],
        compare_mode: base?.compare_mode || 'FILMSTRIP',
        layout_preset: base?.layout_preset || 'SYNC_ZOOM',
        ui: base?.ui || { background: 'dark', showGrid: false, showInfo: false },
        slots: [null, null, null, null],
        focus_key: null,
      });
    }
    localStorage.setItem('nbp_picker_sessions_v1', JSON.stringify(raw));
    return Math.max(0, raw.length - before);
  }, { targetSessionCount });
  createdSessionCount = await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('nbp_picker_sessions_v1') || '[]');
    return Array.isArray(raw) ? raw.length : 0;
  });
}
if (createdSessionCount < 6) {
  throw new Error(`会话数量不足，当前仅 ${createdSessionCount}`);
}

// 3) 把首会话的已导入图片分发到其他新会话（确保切换时每个会话都有图可看）
const spreadStats = await page.evaluate(() => {
  const raw = JSON.parse(localStorage.getItem('nbp_picker_sessions_v1') || '[]');
  if (!Array.isArray(raw) || !raw.length) return { sessionCount: 0, sourceItems: 0, filledSessions: 0 };
  const source = raw.find((s) => Array.isArray(s.items) && s.items.length > 0) || raw[0];
  const sourceItems = Array.isArray(source.items) ? source.items : [];
  if (!sourceItems.length) return { sessionCount: raw.length, sourceItems: 0, filledSessions: 0 };
  const now = new Date().toISOString();
  let filled = 0;
  raw.forEach((s, idx) => {
    if (!Array.isArray(s.items) || s.items.length === 0) {
      const rotated = sourceItems.slice(idx % Math.max(1, sourceItems.length)).concat(sourceItems.slice(0, idx % Math.max(1, sourceItems.length)));
      const items = rotated.slice(0, 8).map((it, i) => ({
        ...it,
        added_at: now,
        rating: ((i + idx) % 5) + 1,
        picked: true,
      }));
      s.items = items;
      s.slots = [
        items[0] ? `${items[0].job_id}::${items[0].image_id}` : null,
        items[1] ? `${items[1].job_id}::${items[1].image_id}` : null,
        items[2] ? `${items[2].job_id}::${items[2].image_id}` : null,
        items[3] ? `${items[3].job_id}::${items[3].image_id}` : null,
      ];
      s.focus_key = s.slots.find(Boolean) || null;
      s.updated_at = now;
      filled += 1;
    }
  });
  localStorage.setItem('nbp_picker_sessions_v1', JSON.stringify(raw));
  return { sessionCount: raw.length, sourceItems: sourceItems.length, filledSessions: filled };
});
if (spreadStats.sourceItems < 1) throw new Error('会话图片分发失败：sourceItems=0');

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('text=Image Picker');
await page.waitForTimeout(1000);

const sessionValues = await page.evaluate(() => {
  const selects = Array.from(document.querySelectorAll('select'));
  const scored = selects
    .map((sel) => {
      const values = Array.from(sel.querySelectorAll('option')).map((n) => n.getAttribute('value') || '').filter(Boolean);
      const sessionValues = values.filter((v) => /^pk_/.test(v));
      return { values, sessionValues };
    })
    .filter((x) => x.sessionValues.length > 1)
    .sort((a, b) => b.sessionValues.length - a.sessionValues.length);
  return scored[0]?.sessionValues || [];
});
if (sessionValues.length < 3) throw new Error(`会话下拉框识别失败，sessionValues=${sessionValues.length}`);

const totals = [];

const parseTotal = async () => {
  return await page.evaluate(() => {
    const m = (document.body?.innerText || '').match(/已选\s*\d+\s*\/\s*总计\s*(\d+)/);
    return m ? Number(m[1]) : 0;
  });
};

// 4) 慢速切换（核心测试）
for (let loop = 0; loop < 48; loop++) {
  const sid = sessionValues[loop % sessionValues.length];
  await page.evaluate((value) => {
    const selects = Array.from(document.querySelectorAll('select'));
    const sel = selects.find((s) => Array.from(s.querySelectorAll('option')).some((o) => /^pk_/.test(o.getAttribute('value') || '')));
    if (!sel) return;
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, sid);

  await page.waitForTimeout(2200); // 更慢速切换

  const pickerVisible = await page.locator('text=Image Picker').first().isVisible().catch(() => false);
  const bodyLen = await page.evaluate(() => (document.body?.innerText || '').trim().length).catch(() => 0);
  const total = await parseTotal();
  totals.push({ sid, total });

  if (!pickerVisible || bodyLen === 0) {
    reproduced = true;
    await page.screenshot({ path: path.join(outDir, 'picker_session_switch_import_slow_blank.png'), fullPage: true });
    await page.waitForTimeout(2000);
    break;
  }
}

const rawVideo = await page.video().path();
await context.close();
await browser.close();

const target = path.join(outDir, 'picker_session_switch_import_slow_v2.webm');
fs.copyFileSync(rawVideo, target);

console.log(JSON.stringify({
  ok: true,
  imported_first_job: seedJob,
  created_sessions: dialogCount,
  created_session_count: createdSessionCount,
  fallback_seeded_sessions: fallbackSeededSessions,
  session_count: sessionValues.length,
  switch_delay_ms: 2200,
  reproduced,
  video: target,
  import_stats: importStats,
  spread_stats: spreadStats,
  totals_sample: totals.slice(0, 20),
  pageErrors: pageErrors.length,
  consoleErrors: consoleErrors.length,
  pageErrorsSample: pageErrors.slice(0, 6),
  consoleErrorsSample: consoleErrors.slice(0, 10),
}, null, 2));
