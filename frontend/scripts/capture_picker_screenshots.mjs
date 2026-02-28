import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const frontendDir = process.cwd();
const repoDir = path.resolve(frontendDir, "..");
const jobsDir = path.join(repoDir, "backend", "data", "jobs");

function safeReadJson(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function extractImageIds(result) {
  if (!result) return [];
  if (Array.isArray(result.images)) {
    const first = result.images[0];
    if (typeof first === "string") return result.images.filter((x) => typeof x === "string" && x);
    if (first && typeof first === "object") {
      return result.images
        .map((x) => x.image_id || x.id || x.imageId)
        .filter((x) => typeof x === "string" && x);
    }
  }
  if (Array.isArray(result.image_ids)) return result.image_ids.filter((x) => typeof x === "string" && x);
  if (Array.isArray(result.imageIds)) return result.imageIds.filter((x) => typeof x === "string" && x);
  return [];
}

const jobDirs = fs.readdirSync(jobsDir).filter((n) => fs.statSync(path.join(jobsDir, n)).isDirectory());

const jobRecords = jobDirs
  .map((jobId) => {
    const meta = safeReadJson(path.join(jobsDir, jobId, "meta.json"), {});
    const req = safeReadJson(path.join(jobsDir, jobId, "request.json"), {});
    return {
      job_id: jobId,
      created_at: meta.created_at || new Date().toISOString(),
      status_cache: meta.status || "UNKNOWN",
      model_cache: meta.model || "gemini-3-pro-image-preview",
      prompt_preview: (req.prompt || "").slice(0, 72) || jobId,
      params_cache: meta.params || {},
      last_seen_at: meta.updated_at || meta.created_at || new Date().toISOString(),
      pinned: false,
      tags: [],
      image_ids: extractImageIds(meta.result),
    };
  })
  .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

const running = jobRecords.find((j) => j.status_cache === "RUNNING" || j.status_cache === "QUEUED");
const imageJobs = jobRecords.filter((j) => j.image_ids.length > 0);
if (!imageJobs.length) {
  throw new Error("No image jobs found in backend/data/jobs.");
}

const selectedForPicker = imageJobs.slice(0, Math.min(8, imageJobs.length));
const now = new Date().toISOString();

const pickerItems = selectedForPicker.flatMap((j, idx) =>
  j.image_ids.slice(0, 1).map((imageId) => ({
    job_id: j.job_id,
    image_id: imageId,
    label: String.fromCharCode(65 + (idx % 4)),
    rating: ((idx % 5) + 1),
    picked: true,
    notes: idx % 2 === 0 ? "构图稳定" : "细节更好",
    added_at: now,
  }))
);

const sessionId = `pk_demo_${Date.now()}`;
const pickerSession = {
  session_id: sessionId,
  name: "海报挑选-演示",
  created_at: now,
  updated_at: now,
  cover: pickerItems[0] ? { job_id: pickerItems[0].job_id, image_id: pickerItems[0].image_id } : undefined,
  items: pickerItems,
  best_image: pickerItems[1] ? { job_id: pickerItems[1].job_id, image_id: pickerItems[1].image_id } : undefined,
  compare_mode: "TWO",
  layout_preset: "SYNC_ZOOM",
  ui: { background: "dark", showGrid: true, showInfo: true },
  slots: [
    pickerItems[0] ? `${pickerItems[0].job_id}::${pickerItems[0].image_id}` : null,
    pickerItems[1] ? `${pickerItems[1].job_id}::${pickerItems[1].image_id}` : null,
    pickerItems[2] ? `${pickerItems[2].job_id}::${pickerItems[2].image_id}` : null,
    pickerItems[3] ? `${pickerItems[3].job_id}::${pickerItems[3].image_id}` : null,
  ],
  focus_key: pickerItems[0] ? `${pickerItems[0].job_id}::${pickerItems[0].image_id}` : null,
};

const settings = {
  baseUrl: "http://127.0.0.1:8000",
  defaultModel: "gemini-3-pro-image-preview",
  jobAuthMode: "ID_ONLY",
  adminModeEnabled: false,
  adminKey: "",
  defaultParams: {
    aspect_ratio: "1:1",
    image_size: "1K",
    thinking_level: null,
    temperature: 0.7,
    timeout_sec: 120,
    max_retries: 1,
  },
  defaultParamsByModel: {
    "gemini-3-pro-image-preview": {
      aspect_ratio: "1:1",
      image_size: "1K",
      thinking_level: null,
      temperature: 0.7,
      timeout_sec: 120,
      max_retries: 1,
    },
  },
  ui: {
    theme: "dark",
    language: "zh-CN",
    reduceMotion: false,
  },
  polling: {
    intervalMs: 1200,
    maxIntervalMs: 5000,
    concurrency: 5,
  },
};

const localJobs = jobRecords.slice(0, 30).map((j) => ({
  job_id: j.job_id,
  created_at: j.created_at,
  status_cache: j.status_cache,
  model_cache: j.model_cache,
  prompt_preview: j.prompt_preview,
  params_cache: j.params_cache,
  last_seen_at: j.last_seen_at,
  pinned: false,
  tags: [],
}));
if (running && !localJobs.find((j) => j.job_id === running.job_id)) {
  localJobs.unshift({
    job_id: running.job_id,
    created_at: running.created_at,
    status_cache: running.status_cache,
    model_cache: running.model_cache,
    prompt_preview: running.prompt_preview,
    params_cache: running.params_cache,
    last_seen_at: running.last_seen_at,
    pinned: true,
    tags: ["running"],
  });
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1720, height: 1020 } });

await context.addInitScript(
  ({ settingsIn, jobsIn, sessionIn }) => {
    localStorage.setItem("nbp_settings_v1", JSON.stringify(settingsIn));
    localStorage.setItem("nbp_jobs_v1", JSON.stringify(jobsIn));
    localStorage.setItem("nbp_picker_sessions_v1", JSON.stringify([sessionIn]));
    localStorage.setItem(
      "nbp_picker_recent_v1",
      JSON.stringify({ last_session_id: sessionIn.session_id, last_opened_at: new Date().toISOString() })
    );
    localStorage.setItem("nbp_history_auto_refresh_pref_v1", JSON.stringify(false));
  },
  { settingsIn: settings, jobsIn: localJobs, sessionIn: pickerSession }
);

const page = await context.newPage();

async function shot(name) {
  await page.waitForTimeout(900);
  await page.screenshot({
    path: path.join(frontendDir, "screenshots", "picker", name),
    fullPage: true,
  });
}

await page.goto(`http://127.0.0.1:5173/picker?session=${encodeURIComponent(sessionId)}`, { waitUntil: "networkidle" });
await page.waitForSelector("text=Image Picker", { timeout: 15000 });
await shot("01-picker-two-up.png");

await page.getByRole("button", { name: "全屏审阅" }).click();
await page.waitForSelector("text=沉浸式审阅");
await shot("08-picker-immersive-fullscreen.png");
await page.getByRole("button", { name: "退出全屏" }).click();
await page.waitForTimeout(500);

await page.getByRole("button", { name: "4-up" }).click();
await shot("02-picker-four-up.png");

await page.getByRole("button", { name: "Filmstrip" }).click();
await shot("03-picker-filmstrip.png");

await page.getByRole("button", { name: "从历史导入" }).click();
await page.waitForSelector("text=导入图片");
if (await page.getByRole("button", { name: "读取图片" }).first().isVisible().catch(() => false)) {
  await page.getByRole("button", { name: "读取图片" }).first().click();
  await page.waitForTimeout(1600);
}
await shot("04-picker-import-drawer.png");

await page.getByRole("button", { name: "关闭" }).click();
await page.waitForTimeout(500);

await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem("nbp_settings_v1") || "{}");
  s.jobAuthMode = "TOKEN";
  localStorage.setItem("nbp_settings_v1", JSON.stringify(s));
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector("text=Image Picker");
await shot("05-picker-token-locked.png");

await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem("nbp_settings_v1") || "{}");
  s.jobAuthMode = "ID_ONLY";
  localStorage.setItem("nbp_settings_v1", JSON.stringify(s));
});
await page.goto("http://127.0.0.1:5173/history", { waitUntil: "networkidle" });
await page.waitForSelector("text=History");
await shot("06-history-auto-refresh-running.png");

await page.goto("http://127.0.0.1:5173/history?job=" + encodeURIComponent(selectedForPicker[0].job_id), { waitUntil: "networkidle" });
await page.waitForSelector("text=任务操作");
await shot("07-history-detail-picker-entry.png");

await browser.close();
console.log("Screenshots generated in frontend/screenshots/picker");
