import fs from "node:fs/promises";
import path from "node:path";
import { chromium, request } from "../frontend/node_modules/playwright/index.mjs";

const BASE_URL = process.env.PW_BASE_URL || "http://127.0.0.1:5178";
const API_BASE_URL = process.env.PW_API_BASE_URL || "http://127.0.0.1:8000";
const USERNAME = process.env.PW_USERNAME || "admin";
const PASSWORD = process.env.PW_PASSWORD || "admin123456";
const OUTPUT_DIR = path.resolve(process.cwd(), "output/playwright");

const CASES = [
  {
    name: "pro_1k_square",
    model: "gemini-3-pro-image-preview",
    aspectRatio: "1:1",
    imageSize: "1K",
    expectedWidth: 1024,
    expectedHeight: 1024,
  },
  {
    name: "pro_2k_square",
    model: "gemini-3-pro-image-preview",
    aspectRatio: "1:1",
    imageSize: "2K",
    expectedWidth: 2048,
    expectedHeight: 2048,
  },
  {
    name: "pro_4k_square",
    model: "gemini-3-pro-image-preview",
    aspectRatio: "1:1",
    imageSize: "4K",
    minWidth: 3072,
    minHeight: 3072,
    square: true,
  },
  {
    name: "pro_1k_wide",
    model: "gemini-3-pro-image-preview",
    aspectRatio: "16:9",
    imageSize: "1K",
    expectedWidth: 1376,
    expectedHeight: 768,
  },
  {
    name: "flash31_2k_square",
    model: "gemini-3.1-flash-image-preview",
    aspectRatio: "1:1",
    imageSize: "2K",
    expectedWidth: 2048,
    expectedHeight: 2048,
  },
  {
    name: "flash25_wide",
    model: "gemini-2.5-flash-image",
    aspectRatio: "16:9",
    imageSize: null,
    expectedWidth: 1344,
    expectedHeight: 768,
  },
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePngDimensions(buffer) {
  if (buffer.length < 24) return null;
  const signature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== signature) return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function parseJpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2 || offset + 2 + segmentLength > buffer.length) break;
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + segmentLength;
  }
  return null;
}

function getImageDimensions(buffer) {
  return parsePngDimensions(buffer) || parseJpegDimensions(buffer);
}

async function fetchJson(api, url, options = {}) {
  const resp = await api.fetch(url, options);
  const body = await resp.text();
  let json = null;
  try {
    json = body ? JSON.parse(body) : null;
  } catch {
    json = body;
  }
  if (!resp.ok()) {
    throw new Error(`HTTP ${resp.status()} for ${url}: ${typeof json === "string" ? json : JSON.stringify(json)}`);
  }
  return json;
}

async function pollJob(api, jobId, timeoutMs = 300000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const meta = await fetchJson(api, `/v1/jobs/${jobId}`);
      if (meta.status === "SUCCEEDED" || meta.status === "FAILED" || meta.status === "CANCELLED") {
        return meta;
      }
    } catch (error) {
      const message = String(error?.message || error);
      if (!message.includes("HTTP 429")) {
        throw error;
      }
    }
    await sleep(3000);
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

async function setProviderEnabled(api, providerId, enabled, note) {
  return fetchJson(api, `/v1/admin/providers/${encodeURIComponent(providerId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    data: JSON.stringify({ enabled, note }),
  });
}

async function loginViaUi(page) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
  await page.getByText("Password Login").waitFor({ timeout: 30000 });
  await page.getByRole("textbox", { name: "请输入账号" }).fill(USERNAME);
  await page.getByRole("textbox", { name: "请输入密码" }).fill(PASSWORD);
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL(/\/$/, { timeout: 30000 });
  await page.getByRole("link", { name: "Create" }).waitFor({ timeout: 30000 });
}

async function verifyAdminPage(page) {
  await page.goto(`${BASE_URL}/admin`, { waitUntil: "domcontentloaded" });
  await page.getByText("BLTCY", { exact: true }).waitFor({ timeout: 30000 });
  await page.getByText("0.1 CNY").waitFor({ timeout: 30000 });
}

async function configureCreatePage(page, testCase) {
  await page.goto(`${BASE_URL}/create`, { waitUntil: "domcontentloaded" });
  await page.getByText("Create Job").waitFor({ timeout: 30000 });
  await page.getByTestId("create-prompt").fill(
    `BLTCY Playwright verification ${testCase.name}. A centered single red apple icon on a plain white background, minimal design, one object only, no text.`
  );
  const selects = page.locator("select");
  await selects.nth(0).selectOption(testCase.model);
  await page.waitForTimeout(150);
  await page.locator("select").nth(1).selectOption(testCase.aspectRatio);
  if (testCase.imageSize) {
    await page.locator("select").nth(2).selectOption(testCase.imageSize);
  }
}

async function submitCase(page, api, testCase) {
  console.log(`CASE_START ${testCase.name}`);
  await configureCreatePage(page, testCase);
  const createResponsePromise = page.waitForResponse((resp) => {
    const url = new URL(resp.url());
    return url.pathname === "/v1/jobs" && resp.request().method() === "POST";
  });
  await page.getByRole("button", { name: "生成" }).click();
  const createResponse = await createResponsePromise;
  const createPayload = await createResponse.json();
  assert(createResponse.ok(), `Create request failed for ${testCase.name}: ${JSON.stringify(createPayload)}`);
  const jobId = createPayload.job_id;
  assert(jobId, `Missing job_id for ${testCase.name}`);
  await page.waitForURL(/\/history/, { timeout: 30000 });
  await page.goto("about:blank");

  const meta = await pollJob(api, jobId);
  console.log(`CASE_JOB_DONE ${testCase.name} ${jobId} ${meta.status}`);

  const response = await fetchJson(api, `/v1/jobs/${jobId}/response`);
  const providerId = response?.response?.provider?.provider_id || meta?.response?.provider?.provider_id || null;
  const upstreamModel = response?.response?.upstream_model || response?.response?.upstream_response_model || null;
  const requestPayload = await fetchJson(api, `/v1/jobs/${jobId}/request`);
  const params = requestPayload?.request?.params || {};

  if (meta.status !== "SUCCEEDED") {
    return {
      name: testCase.name,
      job_id: jobId,
      status: meta.status,
      provider_id: providerId,
      upstream_model: upstreamModel,
      aspect_ratio: params.aspect_ratio,
      image_size: params.image_size,
      error_code: meta?.error?.code || null,
      error_message: meta?.error?.message || null,
      created_at: meta.created_at,
      updated_at: meta.updated_at,
    };
  }

  const imageResp = await api.fetch(`/v1/jobs/${jobId}/images/image_0`);
  assert(imageResp.ok(), `Failed to fetch image for ${jobId}`);
  const imageBuffer = Buffer.from(await imageResp.body());
  const dimensions = getImageDimensions(imageBuffer);
  assert(dimensions, `Unable to parse image dimensions for ${jobId}`);

  assert(providerId === "bltcy", `Expected provider bltcy for ${testCase.name}, got ${providerId}`);
  if (typeof testCase.expectedWidth === "number") {
    assert(dimensions.width === testCase.expectedWidth, `Expected width ${testCase.expectedWidth} for ${testCase.name}, got ${dimensions.width}`);
  }
  if (typeof testCase.expectedHeight === "number") {
    assert(dimensions.height === testCase.expectedHeight, `Expected height ${testCase.expectedHeight} for ${testCase.name}, got ${dimensions.height}`);
  }
  if (typeof testCase.minWidth === "number") {
    assert(dimensions.width >= testCase.minWidth, `Expected width >= ${testCase.minWidth} for ${testCase.name}, got ${dimensions.width}`);
  }
  if (typeof testCase.minHeight === "number") {
    assert(dimensions.height >= testCase.minHeight, `Expected height >= ${testCase.minHeight} for ${testCase.name}, got ${dimensions.height}`);
  }
  if (testCase.square) {
    assert(dimensions.width === dimensions.height, `Expected square output for ${testCase.name}, got ${dimensions.width}x${dimensions.height}`);
  }

  return {
    name: testCase.name,
    job_id: jobId,
    status: meta.status,
    model: meta.model,
    provider_id: providerId,
    upstream_model: upstreamModel,
    aspect_ratio: params.aspect_ratio,
    image_size: params.image_size,
    width: dimensions.width,
    height: dimensions.height,
    created_at: meta.created_at,
    updated_at: meta.updated_at,
  };
}

async function runCaseWithRetries(page, api, testCase, maxAttempts = 3) {
  let lastResult = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      console.log(`CASE_RETRY ${testCase.name} attempt=${attempt}`);
      await sleep(15000);
    }
    lastResult = await submitCase(page, api, testCase);
    if (lastResult.status === "SUCCEEDED") {
      return lastResult;
    }
    if (lastResult.error_code !== "UPSTREAM_RATE_LIMIT") {
      return lastResult;
    }
  }
  return lastResult;
}

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  console.log(`OUTPUT_DIR ${OUTPUT_DIR}`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  let originalProviders = [];
  const results = [];

  try {
    await loginViaUi(page);
    console.log("LOGIN_OK");

    const api = await request.newContext({
      baseURL: API_BASE_URL,
      storageState: await context.storageState(),
      extraHTTPHeaders: { Accept: "application/json" },
    });

    const providersPayload = await fetchJson(api, "/v1/admin/providers");
    originalProviders = providersPayload.providers.map((item) => ({
      provider_id: item.provider_id,
      enabled: Boolean(item.enabled),
      note: item.note || "",
    }));

    await verifyAdminPage(page);
    console.log("ADMIN_PAGE_OK");
    await page.screenshot({ path: path.join(OUTPUT_DIR, "bltcy-admin-before.png"), fullPage: true });

    await setProviderEnabled(api, "mmw", false, originalProviders.find((item) => item.provider_id === "mmw")?.note || "main provider");
    await setProviderEnabled(api, "zx2", false, originalProviders.find((item) => item.provider_id === "zx2")?.note || "cheap backup");
    await setProviderEnabled(api, "bltcy", true, originalProviders.find((item) => item.provider_id === "bltcy")?.note || "official-style gemini v1beta upstream");
    console.log("PROVIDERS_CONFIGURED");

    for (const testCase of CASES) {
      const result = await runCaseWithRetries(page, api, testCase);
      assert(result?.status === "SUCCEEDED", `Case ${testCase.name} failed: ${result?.error_code || result?.status} ${result?.error_message || ""}`);
      results.push(result);
    }

    const providersAfter = await fetchJson(api, "/v1/admin/providers");
    const bltcy = providersAfter.providers.find((item) => item.provider_id === "bltcy") || null;
    const summary = {
      base_url: BASE_URL,
      api_base_url: API_BASE_URL,
      executed_at: new Date().toISOString(),
      results,
      bltcy_provider: bltcy,
    };
    const summaryPath = path.join(OUTPUT_DIR, "bltcy-playwright-summary.json");
    await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    console.log(`SUMMARY_PATH ${summaryPath}`);
    console.log(JSON.stringify(summary, null, 2));

    await api.dispose();
  } finally {
    if (originalProviders.length) {
      const restoreApi = await request.newContext({
        baseURL: API_BASE_URL,
        storageState: await context.storageState(),
        extraHTTPHeaders: { Accept: "application/json" },
      });
      for (const item of originalProviders) {
        await setProviderEnabled(restoreApi, item.provider_id, item.enabled, item.note);
      }
      await restoreApi.dispose();
    }
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
