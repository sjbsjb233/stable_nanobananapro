import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createStoredSettings, frontendDir, frontendPage, jobsDir } from './runtime.mjs';

const outDir = path.join(frontendDir, 'videos');
const tmpDir = path.join(frontendDir, 'tmp');
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(tmpDir, { recursive: true });

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

function toJobRecord(jobId, meta, req) {
  const timing = meta?.timing || {};
  return {
    job_id: jobId,
    job_access_token: null,
    created_at: meta?.created_at || new Date().toISOString(),
    status_cache: meta?.status || 'UNKNOWN',
    model_cache: meta?.model || 'gemini-3-pro-image-preview',
    prompt_preview: (req?.prompt || '').slice(0, 90) || jobId,
    params_cache: {
      aspect_ratio: meta?.params?.aspect_ratio,
      image_size: meta?.params?.image_size,
      thinking_level: meta?.params?.thinking_level ?? null,
      temperature: meta?.params?.temperature,
      timeout_sec: meta?.params?.timeout_sec,
      max_retries: meta?.params?.max_retries,
    },
    last_seen_at: meta?.updated_at || meta?.created_at || new Date().toISOString(),
    pinned: false,
    tags: [],
    run_started_at: timing?.started_at || undefined,
    run_finished_at: timing?.finished_at || undefined,
    queue_wait_ms: typeof timing?.queue_wait_ms === 'number' ? timing.queue_wait_ms : undefined,
    run_duration_ms: typeof timing?.run_duration_ms === 'number' ? timing.run_duration_ms : undefined,
  };
}

function collectJobsData() {
  const dirs = fs
    .readdirSync(jobsDir)
    .filter((id) => fs.statSync(path.join(jobsDir, id)).isDirectory())
    .sort((a, b) => b.localeCompare(a));

  const records = [];
  const importable = [];
  for (const id of dirs) {
    const meta = safeJson(path.join(jobsDir, id, 'meta.json'), {});
    const req = safeJson(path.join(jobsDir, id, 'request.json'), {});
    const rec = toJobRecord(id, meta, req);
    records.push(rec);
    const imageIds = extractImageIds(meta?.result);
    if (imageIds.length > 0 && (meta?.status || '') === 'SUCCEEDED') {
      importable.push({
        job_id: id,
        image_ids: imageIds,
        created_at: meta?.created_at || new Date().toISOString(),
        prompt_preview: rec.prompt_preview,
      });
    }
  }

  records.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  importable.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return { records, importable };
}

function findAnyImageFile() {
  const candidates = [];
  const jobFolders = fs.readdirSync(jobsDir);
  for (const jid of jobFolders) {
    const dir = path.join(jobsDir, jid, 'result');
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (/\.(png|jpg|jpeg|webp)$/i.test(f)) candidates.push(path.join(dir, f));
      if (candidates.length >= 3) return candidates[0];
    }
  }
  return candidates[0] || null;
}

const tinyPngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a7sAAAAASUVORK5CYII=';

const { records: jobs, importable } = collectJobsData();
if (!jobs.length) throw new Error('本地 jobs 数据为空，无法录制演示');
if (!importable.length) throw new Error('没有可导入图片的成功任务，无法完整演示 Picker');

const localImagePath = findAnyImageFile();
const fallbackImagePath = path.join(tmpDir, 'demo_ref.png');
if (!localImagePath) {
  fs.writeFileSync(fallbackImagePath, Buffer.from(tinyPngBase64, 'base64'));
}
const uploadImagePath = localImagePath || fallbackImagePath;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1560, height: 980 },
  recordVideo: { dir: outDir, size: { width: 1560, height: 980 } },
});
const page = await context.newPage();
page.setDefaultTimeout(25000);

let promptDialogCount = 0;
const pageErrors = [];
const consoleErrors = [];
const warnings = [];
const stepLog = [];

page.on('dialog', async (dialog) => {
  if (dialog.type() === 'prompt') {
    promptDialogCount += 1;
    await dialog.accept(`演示会话-${promptDialogCount}`);
    return;
  }
  await dialog.accept();
});
page.on('pageerror', (err) => pageErrors.push(String(err?.stack || err?.message || err)));
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});

const sleep = (ms) => page.waitForTimeout(ms);

const runStep = async (name, fn, required = true) => {
  try {
    await fn();
    stepLog.push({ name, ok: true });
  } catch (err) {
    const message = String(err?.message || err);
    stepLog.push({ name, ok: false, message });
    if (required) throw err;
    warnings.push(`${name}: ${message}`);
  }
};

const setFieldSelect = async (labelNeedle, value) => {
  const ok = await page.evaluate(({ labelNeedle: needle, value: next }) => {
    const labels = Array.from(document.querySelectorAll('div')).filter((el) => {
      const txt = (el.textContent || '').trim();
      return txt.startsWith(needle);
    });
    for (const label of labels) {
      const wrap = label.parentElement;
      const sel = wrap ? wrap.querySelector('select') : null;
      if (sel instanceof HTMLSelectElement) {
        sel.value = next;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  }, { labelNeedle, value });
  if (!ok) throw new Error(`未找到字段 select: ${labelNeedle}`);
};

const setFieldRange = async (labelNeedle, value) => {
  const ok = await page.evaluate(({ labelNeedle: needle, value: next }) => {
    const labels = Array.from(document.querySelectorAll('div')).filter((el) => {
      const txt = (el.textContent || '').trim();
      return txt.startsWith(needle);
    });
    for (const label of labels) {
      const wrap = label.parentElement;
      const input = wrap ? wrap.querySelector('input[type="range"]') : null;
      if (input instanceof HTMLInputElement) {
        input.value = String(next);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  }, { labelNeedle, value });
  if (!ok) throw new Error(`未找到字段 range: ${labelNeedle}`);
};

const clickVisibleBtn = async (text) => {
  for (let i = 0; i < 10; i++) {
    const ok = await page.evaluate((txt) => {
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
    if (ok) return true;
    await sleep(180);
  }
  return false;
};

const selectSessionDropdown = async (index) => {
  await page.evaluate((idx) => {
    const selects = Array.from(document.querySelectorAll('select'));
    const sessionSelect = selects.find((s) =>
      Array.from(s.querySelectorAll('option')).some((o) => /^pk_/.test(o.getAttribute('value') || ''))
    );
    if (!sessionSelect) return;
    const opts = Array.from(sessionSelect.querySelectorAll('option'));
    const target = opts[Math.max(0, Math.min(idx, opts.length - 1))];
    if (!target) return;
    (sessionSelect).value = target.getAttribute('value') || '';
    sessionSelect.dispatchEvent(new Event('change', { bubbles: true }));
  }, index);
};

const storedSettings = createStoredSettings({
  ui: { reduceMotion: false },
});

await context.addInitScript(({ jobsIn, settingsIn }) => {
  localStorage.setItem('nbp_settings_v1', JSON.stringify(settingsIn));
  localStorage.setItem('nbp_jobs_v1', JSON.stringify(jobsIn));
  localStorage.setItem('nbp_picker_sessions_v1', JSON.stringify([]));
  localStorage.setItem('nbp_picker_recent_v1', JSON.stringify({ last_session_id: '', last_opened_at: new Date().toISOString() }));
  localStorage.setItem('nbp_history_auto_refresh_pref_v1', JSON.stringify(false));
}, { jobsIn: jobs.slice(0, 200), settingsIn: storedSettings });

await runStep('进入 Create 页', async () => {
  await page.goto(frontendPage('/create'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=Create Job');
  await sleep(1200);
});

await runStep('填写 prompt 与参数', async () => {
  const prompt = [
    'A cinematic portrait of a cyberpunk fox architect in rainy Tokyo night',
    'neon reflections, volumetric light, shallow depth of field, ultra detailed',
    'color grading: teal and amber, 35mm lens, editorial style',
  ].join('\n');
  await page.locator('textarea').first().fill(prompt);
  await sleep(900);

  await setFieldSelect('aspect_ratio', '16:9');
  await sleep(500);
  await setFieldSelect('image_size', '1K');
  await sleep(500);
  await setFieldRange('temperature', 0.88);
  await sleep(400);
  await setFieldRange('timeout_sec', 180);
  await sleep(400);
  await setFieldRange('max_retries', 1);
  await sleep(400);
  await setFieldRange('job_count', 3);
  await sleep(900);
});

await runStep('本地导入与粘贴参考图', async () => {
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(uploadImagePath);
  await sleep(1200);
  await page.evaluate(({ base64 }) => {
    const raw = atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/png' });
    const file = new File([blob], `pasted_${Date.now()}.png`, { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const evt = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    window.dispatchEvent(evt);
  }, { base64: tinyPngBase64 });
  await sleep(1500);
});

let createdJobId = null;
await runStep('提交生成任务并跳转 History', async () => {
  await page.getByRole('button', { name: '生成' }).click();
  await page.waitForURL(/\/history\?job=/, { timeout: 45000 });
  await page.waitForSelector('text=History');
  await sleep(1500);
  const current = page.url();
  const m = current.match(/[?&]job=([a-f0-9]{32})/);
  createdJobId = m ? m[1] : null;
});

await runStep('展示分页与平均耗时', async () => {
  await page.waitForSelector('text=平均耗时(近10成功)');
  await sleep(1000);
  await page.evaluate(() => {
    const selects = Array.from(document.querySelectorAll('select'));
    const pager = selects.find((s) => Array.from(s.options).some((o) => (o.textContent || '').includes('/ 页')));
    if (!pager) return;
    pager.value = '10';
    pager.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(800);
  await page.getByRole('button', { name: '下一页' }).click();
  await sleep(1000);
  await page.getByRole('button', { name: '上一页' }).click();
  await sleep(1200);
}, false);

await runStep('观察运行态进度条', async () => {
  if (createdJobId) {
    await page.goto(frontendPage(`/history?job=${createdJobId}`), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=History');
    await sleep(700);
  }
  const start = Date.now();
  while (Date.now() - start < 30000) {
    const seen = await page.evaluate(() => {
      const txt = document.body?.innerText || '';
      return txt.includes('运行中') || txt.includes('排队中') || txt.includes('进度');
    });
    if (seen) break;
    await sleep(800);
  }
  await sleep(2200);
});

const previewJob = importable[0];
await runStep('切换到成功任务并展示预览图', async () => {
  await page.goto(frontendPage(`/history?job=${previewJob.job_id}`), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=结果预览');
  await sleep(1500);
  const copyBtn = page.getByRole('button', { name: '复制 image_id' });
  if (await copyBtn.count()) {
    await copyBtn.first().click({ timeout: 8000 });
  }
  await sleep(800);
});

await runStep('进入 Picker', async () => {
  const toPicker = page.getByRole('button', { name: '去挑选对比' });
  if (await toPicker.count()) {
    await toPicker.first().click();
    await page.waitForURL(/\/picker/);
  } else {
    await page.goto(frontendPage(`/picker?job=${previewJob.job_id}`), { waitUntil: 'domcontentloaded' });
  }
  await page.waitForSelector('text=Image Picker');
  await sleep(1500);
});

await runStep('批量导入多任务图片', async () => {
  await page.getByRole('button', { name: '从历史导入' }).click();
  await page.waitForSelector('text=导入图片');
  await sleep(700);
  const ids = importable.slice(0, 8).map((x) => x.job_id);
  for (const id of ids) {
    await page.getByPlaceholder('按 job_id 快速导入').fill(id);
    await page.getByRole('button', { name: '导入该 Job' }).click();
    await sleep(1200);
  }
  await page.getByRole('button', { name: '关闭' }).click();
  await sleep(1400);
});

await runStep('会话创建与慢速切换', async () => {
  await page.getByRole('button', { name: '新建会话' }).click();
  await sleep(900);
  await selectSessionDropdown(1);
  await sleep(1600);
  await selectSessionDropdown(0);
  await sleep(1600);
}, false);

await runStep('模式与展示控制', async () => {
  await clickVisibleBtn('4-up');
  await sleep(900);
  await clickVisibleBtn('2-up');
  await sleep(900);
  await clickVisibleBtn('Filmstrip');
  await sleep(900);
  await clickVisibleBtn('4-up');
  await sleep(700);
  await clickVisibleBtn('Info');
  await sleep(700);
  await clickVisibleBtn('Grid');
  await sleep(700);
  if (!(await clickVisibleBtn('Dark BG'))) await clickVisibleBtn('Light BG');
  await sleep(900);
  await clickVisibleBtn('切换下一组');
  await sleep(1300);
}, false);

await runStep('Filmstrip 与优选池交互', async () => {
  const bestBtns = page.getByRole('button', { name: '优选' });
  const bestCount = await bestBtns.count();
  if (bestCount > 0) {
    await bestBtns.nth(0).click();
    await sleep(900);
  }
  if (bestCount > 1) {
    await bestBtns.nth(1).click();
    await sleep(900);
  }

  const stars = page.locator('button[title="评分 5"]');
  if (await stars.count()) {
    await stars.first().click();
    await sleep(600);
  }
  const mapA = page.getByRole('button', { name: 'A' });
  if (await mapA.count()) {
    await mapA.first().click();
    await sleep(700);
  }
  const backBtns = page.getByRole('button', { name: '移回片池' });
  if (await backBtns.count()) {
    await backBtns.first().click();
    await sleep(1000);
  }
}, false);

await runStep('全屏审阅功能演示', async () => {
  await clickVisibleBtn('全屏审阅');
  await page.waitForSelector('text=沉浸式审阅');
  await sleep(1200);
  await clickVisibleBtn('切换下一组');
  await sleep(1200);
  await page.mouse.move(360, 360);
  await sleep(500);
  const immersiveBest = page.getByRole('button', { name: '移入优选' });
  if (await immersiveBest.count()) {
    await immersiveBest.first().click();
    await sleep(700);
  }
  const immersiveStars = page.locator('button[title="评分 4"]');
  if (await immersiveStars.count()) {
    await immersiveStars.first().click();
    await sleep(700);
  }
  await clickVisibleBtn('Filmstrip');
  await sleep(900);
  await clickVisibleBtn('4-up');
  await sleep(900);
  await clickVisibleBtn('退出全屏');
  await sleep(1200);
}, false);

await runStep('返回 History 并进入 Dashboard', async () => {
  await page.goto(frontendPage('/history'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=History');
  await sleep(1100);
  await page.goto(frontendPage('/'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=Dashboard');
  await sleep(2200);
}, false);

const rawVideo = await page.video().path();
await context.close();
await browser.close();

const target = path.join(outDir, 'full_flow_create_history_picker_showcase.webm');
fs.copyFileSync(rawVideo, target);

console.log(
  JSON.stringify(
    {
      ok: true,
      video: target,
      created_job_id: createdJobId,
      preview_job_id: previewJob.job_id,
      imported_jobs_count: Math.min(8, importable.length),
      prompt_dialog_count: promptDialogCount,
      pageErrors: pageErrors.length,
      consoleErrors: consoleErrors.length,
      pageErrorsSample: pageErrors.slice(0, 8),
      consoleErrorsSample: consoleErrors.slice(0, 8),
      warnings,
      steps: stepLog,
    },
    null,
    2
  )
);
