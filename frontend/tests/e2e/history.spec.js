import { expect, test } from "@playwright/test";

const BASE_URL = process.env.PW_BASE_URL || "http://127.0.0.1:5178";
const ADMIN_COOKIE = "eyJ1c2VyX2lkIjogIjFmZjAxODI3YTkxNzA3NjhkMjY1NmMwYyJ9.aa6-cA.CPyq2oqG6B0uzph_K7ogDfTJHC0";
const ADMIN_USER_ID = "1ff01827a9170768d2656c0c";
const PNG_1X1_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7m6XQAAAAASUVORK5CYII=";

function jobId(index) {
  return String(index + 1).padStart(32, "0");
}

function buildHistoryFixtures(total = 30) {
  const base = Date.parse("2026-03-10T00:00:00Z");
  const metas = {};
  const requests = {};
  const responses = {};
  const jobs = [];
  const deletedJobIds = [];
  const cancelledJobIds = [];
  const runningRefreshId = jobId(1);
  const runningCancelId = jobId(2);
  const queuedDeleteId = jobId(3);
  const successDeleteId = jobId(6);

  for (let idx = 0; idx < total; idx += 1) {
    const id = jobId(idx);
    const createdAt = new Date(base - idx * 60_000).toISOString();
    const updatedAt = new Date(base - idx * 45_000).toISOString();

    let status = "SUCCEEDED";
    let promptText = `History prompt ${idx + 1}`;
    let promptPreview = promptText;
    let batchName = idx < 4 ? "Batch Alpha" : idx < 8 ? "Batch Beta" : "";
    let sectionTitle = idx < 4 ? `Slide ${idx + 1}` : "";
    let error = null;
    let result = {
      images: [
        {
          image_id: "image_0",
          filename: "result/image_0.png",
          mime: "image/png",
          width: 1,
          height: 1,
          sha256: `hash-${idx}`,
        },
      ],
    };
    let timing = {
      queued_at: createdAt,
      started_at: createdAt,
      finished_at: updatedAt,
      queue_wait_ms: 300 + idx * 10,
      run_duration_ms: 1200 + idx * 20,
    };

    if (idx === 0) {
      promptText = "Latest hero poster for keynote opening slide";
      promptPreview = "Latest hero poster for keynote opening slide";
      sectionTitle = "Intro";
    } else if (idx === 1) {
      status = "RUNNING";
      promptText = "Running progress shot";
      promptPreview = "Running progress shot";
      result = { images: [] };
      timing = {
        queued_at: createdAt,
        started_at: new Date(base - 20_000).toISOString(),
        finished_at: null,
        queue_wait_ms: 900,
        run_duration_ms: null,
      };
    } else if (idx === 2) {
      status = "RUNNING";
      promptText = "Running cancel shot";
      promptPreview = "Running cancel shot";
      result = { images: [] };
      timing = {
        queued_at: createdAt,
        started_at: new Date(base - 30_000).toISOString(),
        finished_at: null,
        queue_wait_ms: 1200,
        run_duration_ms: null,
      };
    } else if (idx === 3) {
      status = "QUEUED";
      promptText = "Queued storyboard task";
      promptPreview = "Queued storyboard task";
      result = { images: [] };
      timing = {
        queued_at: createdAt,
        started_at: null,
        finished_at: null,
        queue_wait_ms: 3200,
        run_duration_ms: null,
      };
    } else if (idx === 4) {
      status = "FAILED";
      promptText = "Failure policy test";
      promptPreview = "Failure policy test";
      error = {
        code: "POLICY_BLOCK",
        type: "UPSTREAM_ERROR",
        message: "Policy block reason",
        debug_id: "dbg-failed",
        retryable: false,
        details: { why: "policy" },
      };
      result = { images: [] };
    } else if (idx === 5) {
      status = "CANCELLED";
      promptText = "Cancelled deck frame";
      promptPreview = "Cancelled deck frame";
      error = {
        code: "JOB_CANCELLED",
        type: "USER_CANCELLED",
        message: "Cancelled by operator",
        debug_id: "dbg-cancelled",
        retryable: false,
        details: { cancelled_at: updatedAt },
      };
      result = { images: [] };
    } else if (idx === 6) {
      promptText = "Session linked success card";
      promptPreview = "Session linked success card";
    }

    const model = idx % 2 === 0 ? "gemini-3.1-flash-image-preview" : "gemini-3-pro-image-preview";
    const params = {
      aspect_ratio: idx % 3 === 0 ? "16:9" : "1:1",
      image_size: idx % 2 === 0 ? "1K" : "2K",
      thinking_level: idx % 2 === 0 ? "High" : null,
      temperature: 0.8,
      timeout_sec: 120,
      max_retries: 1,
    };
    metas[id] = {
      job_id: id,
      model,
      mode: "IMAGE_ONLY",
      status,
      created_at: createdAt,
      updated_at: updatedAt,
      timing,
      params,
      usage: {
        total_token_count: 160,
        input_token_count: 110,
        output_token_count: 50,
      },
      billing: {
        estimated_cost_usd: 0.031,
        image_output_cost_usd: 0.021,
        breakdown: {
          text_input_cost_usd: 0.004,
          text_output_cost_usd: 0.006,
          image_output_cost_usd: 0.021,
        },
      },
      result,
      error,
      response: { latency_ms: 980 },
    };
    requests[id] = {
      prompt: promptText,
      reference_images:
        idx === 0
          ? [
              { filename: "input/reference_0.png", mime: "image/png" },
              { filename: "input/reference_1.png", mime: "image/png" },
            ]
          : [],
    };
    responses[id] = { finish_reason: "STOP", latency_ms: 980 };
    jobs.push({
      job_id: id,
      job_access_token: `tok-${idx}`,
      model_cache: model,
      created_at: createdAt,
      status_cache: status,
      prompt_preview: promptPreview,
      prompt_text: promptText,
      params_cache: params,
      last_seen_at: updatedAt,
      first_image_id: status === "SUCCEEDED" ? "image_0" : undefined,
      image_count_cache: status === "SUCCEEDED" ? 1 : 0,
      error_code_cache: error?.code,
      error_message_cache: error?.message,
      batch_id: batchName ? `batch-${batchName}` : undefined,
      batch_name: batchName || undefined,
      batch_note: batchName ? "Batch note" : undefined,
      batch_size: batchName ? 4 : undefined,
      batch_index: batchName ? idx + 1 : undefined,
      section_index: batchName ? idx + 1 : undefined,
      section_title: sectionTitle || undefined,
      linked_session_ids: idx === 0 || idx === 6 ? ["pk_hist_a"] : idx === 7 ? ["pk_hist_b"] : [],
    });
  }

  const sessions = [
    {
      session_id: "pk_hist_a",
      name: "Deck Session A",
      created_at: new Date(base - 10_000).toISOString(),
      updated_at: new Date(base - 10_000).toISOString(),
      items: [
        {
          item_key: `${jobId(0)}::image_0`,
          job_id: jobId(0),
          job_access_token: "tok-0",
          image_id: "image_0",
          status: "SUCCEEDED",
          added_at: new Date(base - 10_000).toISOString(),
        },
        {
          item_key: `${successDeleteId}::image_0`,
          job_id: successDeleteId,
          job_access_token: "tok-6",
          image_id: "image_0",
          status: "SUCCEEDED",
          added_at: new Date(base - 9_000).toISOString(),
        },
      ],
      compare_mode: "TWO",
      layout_preset: "SYNC_ZOOM",
      ui: { background: "dark", showGrid: false, showInfo: false },
      slots: [`${jobId(0)}::image_0`, `${successDeleteId}::image_0`, null, null],
      focus_key: `${jobId(0)}::image_0`,
    },
    {
      session_id: "pk_hist_b",
      name: "Moodboard Session B",
      created_at: new Date(base - 8_000).toISOString(),
      updated_at: new Date(base - 8_000).toISOString(),
      items: [
        {
          item_key: `${jobId(7)}::image_0`,
          job_id: jobId(7),
          job_access_token: "tok-7",
          image_id: "image_0",
          status: "SUCCEEDED",
          added_at: new Date(base - 8_000).toISOString(),
        },
      ],
      compare_mode: "TWO",
      layout_preset: "SYNC_ZOOM",
      ui: { background: "dark", showGrid: false, showInfo: false },
      slots: [`${jobId(7)}::image_0`, null, null, null],
      focus_key: `${jobId(7)}::image_0`,
    },
  ];

  return {
    jobs,
    sessions,
    metas,
    requests,
    responses,
    deletedJobIds,
    cancelledJobIds,
    runningRefreshId,
    runningCancelId,
    queuedDeleteId,
    successDeleteId,
    activeCalls: 0,
    previewBatchCalls: 0,
    previewImageCalls: 0,
    originalImageCalls: 0,
    failPreviewBatch: false,
  };
}

async function seedLocalState(page, fixtures) {
  await page.addInitScript(
    ([adminUserId, jobs, sessions]) => {
      window.localStorage.setItem("nbp_jobs_by_user_v2", JSON.stringify({ [adminUserId]: jobs }));
      window.localStorage.setItem("nbp_picker_sessions_v1", JSON.stringify(sessions));
      window.localStorage.setItem("nbp_picker_recent_v1", JSON.stringify({ last_session_id: "pk_hist_a", last_opened_at: new Date().toISOString() }));
      window.localStorage.setItem("nbp_history_auto_refresh_pref_v1", JSON.stringify(false));
      window.localStorage.setItem(
        "nbp_settings_v1",
        JSON.stringify({
          cache: {
            enabled: true,
            ttlDays: 3,
            maxBytes: 2147483648,
          },
        })
      );
    },
    [ADMIN_USER_ID, fixtures.jobs, fixtures.sessions]
  );
}

async function loginWithCookie(page, path = "/history") {
  await page.context().addCookies([{ name: "nbp_session", value: ADMIN_COOKIE, url: BASE_URL }]);
  await page.goto(`${BASE_URL}${path}`);
  await expect(page.getByText("Search & Filter")).toBeVisible();
}

async function installHistoryMocks(page, fixtures) {
  await page.route("**/v1/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        user: {
          user_id: ADMIN_USER_ID,
          username: "admin",
          role: "ADMIN",
          enabled: true,
          created_at: "2026-03-01T00:00:00Z",
          updated_at: "2026-03-10T00:00:00Z",
          last_login_at: "2026-03-10T00:00:00Z",
          policy: {
            daily_image_limit: null,
            concurrent_jobs_limit: 20,
            turnstile_job_count_threshold: null,
            turnstile_daily_usage_threshold: null,
            daily_image_access_limit: null,
            image_access_turnstile_bonus_quota: null,
            daily_image_access_hard_limit: null,
          },
        },
        usage: {
          date: "2026-03-10",
          jobs_created_today: 0,
          jobs_succeeded_today: 0,
          jobs_failed_today: 0,
          images_generated_today: 0,
          quota_consumed_today: 0,
          quota_resets_today: 0,
          active_jobs: 0,
          running_jobs: 0,
          queued_jobs: 0,
          remaining_images_today: null,
          image_accesses_today: 0,
          image_access_bonus_quota_today: 0,
        },
        generation_turnstile_verified_until: null,
      }),
    });
  });

  await page.route("**/v1/jobs/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path.endsWith("/v1/jobs/active")) {
      fixtures.activeCalls += 1;
      if (fixtures.activeCalls >= 2) {
        const meta = fixtures.metas[fixtures.runningRefreshId];
        meta.status = "SUCCEEDED";
        meta.updated_at = new Date("2026-03-10T00:00:20Z").toISOString();
        meta.timing.finished_at = meta.updated_at;
        meta.timing.run_duration_ms = 2400;
        meta.result = {
          images: [
            {
              image_id: "image_0",
              filename: "result/image_0.png",
              mime: "image/png",
              width: 1,
              height: 1,
              sha256: "hash-running-refresh",
            },
          ],
        };
      }

      const active = [];
      const settled = [];
      Object.values(fixtures.metas).forEach((meta) => {
        const firstImage = Array.isArray(meta.result?.images) && meta.result.images.length ? meta.result.images[0] : null;
        const snap = {
          job_id: meta.job_id,
          status: meta.status,
          model: meta.model,
          updated_at: meta.updated_at,
          timing: meta.timing,
          first_image_id: firstImage?.image_id,
          image_count: Array.isArray(meta.result?.images) ? meta.result.images.length : 0,
        };
        if (meta.status === "RUNNING" || meta.status === "QUEUED") active.push(snap);
        else settled.push(snap);
      });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ active, settled, requested: active.length + settled.length, active_count: active.length, settled_count: settled.length, forbidden: [], not_found: [], failed: [] }) });
      return;
    }

    if (path.endsWith("/v1/jobs/batch-meta")) {
      const body = request.postDataJSON();
      const items = (body.jobs || []).map((job) => ({ job_id: job.job_id, meta: fixtures.metas[job.job_id] })).filter((item) => item.meta);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items, forbidden: [], not_found: [], failed: [], requested: body.jobs.length, ok: items.length }) });
      return;
    }

    if (path.endsWith("/v1/jobs/previews/batch")) {
      fixtures.previewBatchCalls += 1;
      if (fixtures.failPreviewBatch) {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "PREVIEW_DOWN", message: "preview disabled for test" } }) });
        return;
      }
      const body = request.postDataJSON();
      const items = (body.images || [])
        .filter((item) => fixtures.metas[item.job_id])
        .map((item) => ({
          job_id: item.job_id,
          image_id: item.image_id,
          mime: "image/png",
          size_bytes: Buffer.from(PNG_1X1_BASE64, "base64").length,
          data_base64: PNG_1X1_BASE64,
        }));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items, forbidden: [], not_found: [], failed: [], requested: (body.images || []).length, ok: items.length, limit: 72 }),
      });
      return;
    }

    const match = path.match(/\/v1\/jobs\/([^/]+)(?:\/(.*))?$/);
    if (!match) {
      await route.fallback();
      return;
    }

    const currentJobId = decodeURIComponent(match[1]);
    const suffix = match[2] || "";

    if (method === "DELETE" && !suffix) {
      fixtures.deletedJobIds.push(currentJobId);
      delete fixtures.metas[currentJobId];
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ job_id: currentJobId, deleted: true }) });
      return;
    }

    if (method === "POST" && suffix === "cancel") {
      fixtures.cancelledJobIds.push(currentJobId);
      fixtures.metas[currentJobId].status = "CANCELLED";
      fixtures.metas[currentJobId].error = {
        code: "JOB_CANCELLED",
        type: "USER_CANCELLED",
        message: "Job was cancelled by user while running. Any later worker result will be discarded.",
        debug_id: "dbg-cancel-request",
        retryable: false,
        details: {},
      };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ job_id: currentJobId, cancelled: true, status: "CANCELLED" }) });
      return;
    }

    if (method === "POST" && suffix === "retry") {
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ new_job_id: jobId(99), new_job_access_token: "tok-retry" }) });
      return;
    }

    if (method === "GET" && !suffix) {
      const meta = fixtures.metas[currentJobId];
      if (!meta) {
        await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "JOB_NOT_FOUND", message: "Job not found" } }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(meta) });
      return;
    }

    if (method === "GET" && suffix === "request") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ job_id: currentJobId, request: fixtures.requests[currentJobId] }) });
      return;
    }

    if (method === "GET" && suffix === "response") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ job_id: currentJobId, response: fixtures.responses[currentJobId] }) });
      return;
    }

    if (method === "GET" && suffix.startsWith("images/") && suffix.endsWith("/preview")) {
      fixtures.previewImageCalls += 1;
      await route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(PNG_1X1_BASE64, "base64") });
      return;
    }

    if (method === "GET" && suffix.startsWith("images/")) {
      fixtures.originalImageCalls += 1;
      if (currentJobId === jobId(0)) {
        await new Promise((resolve) => setTimeout(resolve, 1800));
      }
      await route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(PNG_1X1_BASE64, "base64") });
      return;
    }

    if (method === "GET" && suffix.startsWith("references/")) {
      await route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(PNG_1X1_BASE64, "base64") });
      return;
    }

    await route.fallback();
  });
}

function historyCards(page) {
  return page.getByTestId("history-card");
}

test.describe.serial("History page", () => {
  test("shows the gallery layout, default sort, search, filters, and pagination", async ({ page }) => {
    const fixtures = buildHistoryFixtures();
    await seedLocalState(page, fixtures);
    await installHistoryMocks(page, fixtures);
    await loginWithCookie(page);
    await expect(page.getByText("Search & Filter")).toBeVisible();
    await expect(page.getByText("Page Controls")).toBeVisible();
    await expect(historyCards(page)).toHaveCount(24);
    await expect(historyCards(page).first()).toContainText("Latest hero poster for keynote opening slide");
    await expect(historyCards(page).first()).toContainText("Batch Alpha");
    await expect(page.getByText("Total 30")).toBeVisible();
    await expect(page.getByText("Page 1 / 2")).toBeVisible();

    await page.getByTestId("history-search").fill("Policy block reason");
    await page.waitForTimeout(400);
    await expect(historyCards(page).first()).toContainText("Failure policy test");

    await page.getByTestId("history-search").fill("gemini-3-pro-image-preview");
    await page.waitForTimeout(400);

    await page.getByTestId("history-search").fill("");
    await page.getByTestId("history-status-filter").selectOption("FAILED");
    await expect(historyCards(page)).toHaveCount(1);
    await expect(historyCards(page).first()).toContainText("Failed");

    await page.getByTestId("history-status-filter").selectOption("ALL");
    await page.getByTestId("history-batch-filter").selectOption("Batch Alpha");
    await expect(historyCards(page)).toHaveCount(4);

    await page.getByTestId("history-batch-filter").selectOption("ALL");
    await page.getByTestId("history-session-filter").selectOption("pk_hist_a");
    await expect(historyCards(page)).toHaveCount(2);

    await page.getByTestId("history-session-filter").selectOption("ALL");
    await page.getByTestId("history-failed-only").click();
    await expect(historyCards(page)).toHaveCount(2);

    await page.getByTestId("history-failed-only").click();
    await page.getByTestId("history-page-size").selectOption("48");
    await expect(page.getByText("Total pages: 1")).toBeVisible();
    expect(fixtures.previewBatchCalls).toBeGreaterThanOrEqual(1);
    expect(fixtures.originalImageCalls).toBe(0);
  });

  test("opens the notion-style detail modal, shows preview-first loading, supports overlay/esc close, session actions, and clone-to-create", async ({ page }) => {
    const fixtures = buildHistoryFixtures();
    await seedLocalState(page, fixtures);
    await installHistoryMocks(page, fixtures);
    await loginWithCookie(page);
    await historyCards(page).first().click();
    const dialog = page.getByRole("dialog", { name: "History detail modal" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Loading original")).toBeVisible();
    await expect(dialog.getByText("Prompt")).toBeVisible();
    await expect(dialog.getByText("Batch Info")).toBeVisible();
    await expect(dialog.getByText("Status Timeline")).toBeVisible();
    await expect(dialog.getByText("Reference Images")).toBeVisible();
    await expect(dialog.getByText("Add To Session")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "下载选中" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "复制参数并前往快速生成" })).toBeVisible();
    await expect(dialog.getByText("#1")).toBeVisible();
    await expect(dialog.getByText("#2")).toBeVisible();
    await expect.poll(() => fixtures.originalImageCalls >= 1, { timeout: 5000 }).toBeTruthy();

    await page.getByTestId("history-detail-backdrop").click({ position: { x: 20, y: 20 } });
    await expect(dialog).toBeHidden();

    await historyCards(page).first().click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    await historyCards(page).first().click();
    await dialog.getByText("Moodboard Session B").click();
    await dialog.getByRole("button", { name: "加入选中 Session" }).click();
    await expect.poll(async () => {
      return page.evaluate(() => {
        const sessions = JSON.parse(localStorage.getItem("nbp_picker_sessions_v1") || "[]");
        return sessions.find((session) => session.session_id === "pk_hist_b")?.items.length || 0;
      });
    }).toBe(2);

    await dialog.getByPlaceholder("Create session now").fill("History Modal New Session");
    await dialog.getByRole("button", { name: "新建 Session 并加入" }).click();
    await expect.poll(async () => {
      return page.evaluate(() => {
        const sessions = JSON.parse(localStorage.getItem("nbp_picker_sessions_v1") || "[]");
        return sessions.some((session) => session.name === "History Modal New Session");
      });
    }).toBeTruthy();

    await dialog.getByRole("button", { name: "复制参数并前往快速生成" }).click();
    await expect(page).toHaveURL(/\/create$/);
  });

  test("reuses cached previews, preserves page state, and exposes cache controls in settings", async ({ page }) => {
    const fixtures = buildHistoryFixtures();
    await seedLocalState(page, fixtures);
    await installHistoryMocks(page, fixtures);
    await loginWithCookie(page);

    await page.getByTestId("history-next-page").click();
    await expect(page.getByText("Page 2 / 2")).toBeVisible();
    await historyCards(page).first().click();
    await page.getByRole("dialog", { name: "History detail modal" }).getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByText("Page 2 / 2")).toBeVisible();

    fixtures.failPreviewBatch = true;
    await page.getByRole("link", { name: "Settings" }).click();
    await page.goBack();
    await expect(page.getByText("Page 2 / 2")).toBeVisible();
    await expect(historyCards(page)).toHaveCount(6);
    await expect(historyCards(page).first().locator("img").first()).toBeVisible();

    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page.getByText("图片缓存")).toBeVisible();
    await page.getByTestId("settings-cache-enabled").click();
    await page.getByTestId("settings-cache-ttl").evaluate((el) => {
      el.value = "5";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.getByTestId("settings-cache-max").evaluate((el) => {
      el.value = "1";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.getByRole("button", { name: "保存" }).click();
    await page.getByTestId("settings-clear-cache").click();
    await expect(page.getByText("Used 0 B")).toBeVisible();
  });

  test("uses one batched preview request for a 72-card page without hitting original images", async ({ page }) => {
    const fixtures = buildHistoryFixtures(96);
    await seedLocalState(page, fixtures);
    await installHistoryMocks(page, fixtures);
    await loginWithCookie(page);

    await page.getByTestId("history-page-size").selectOption("72");
    await expect(historyCards(page)).toHaveCount(72);
    expect(fixtures.previewBatchCalls).toBeLessThanOrEqual(3);
    expect(fixtures.originalImageCalls).toBe(0);
  });

  test("keeps running cards refreshed and supports queued delete, running cancel, and success delete cleanup", async ({ page }) => {
    const fixtures = buildHistoryFixtures();
    await seedLocalState(page, fixtures);
    await installHistoryMocks(page, fixtures);
    page.on("dialog", (dialog) => dialog.accept());
    await loginWithCookie(page);

    const runningRefreshCard = historyCards(page).filter({ hasText: "Running progress shot" });
    await expect(runningRefreshCard).toContainText("Running");
    await expect
      .poll(async () => {
        return runningRefreshCard.textContent();
      }, { timeout: 8000 })
      .toContain("SUCCEEDED");
    await expect(runningRefreshCard.locator("img").first()).toBeVisible();

    await historyCards(page).filter({ hasText: "Queued storyboard task" }).click();
    await page.getByRole("dialog", { name: "History detail modal" }).getByRole("button", { name: "Delete" }).click();
    await expect(historyCards(page).filter({ hasText: "Queued storyboard task" })).toHaveCount(0);
    expect(fixtures.deletedJobIds).toContain(fixtures.queuedDeleteId);

    await historyCards(page).filter({ hasText: "Running cancel shot" }).click();
    const cancelDialog = page.getByRole("dialog", { name: "History detail modal" });
    await cancelDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(cancelDialog.locator("span").filter({ hasText: /^CANCELLED$/ })).toBeVisible();
    expect(fixtures.cancelledJobIds).toContain(fixtures.runningCancelId);

    await cancelDialog.getByRole("button", { name: "Close", exact: true }).click();
    await historyCards(page).filter({ hasText: "Session linked success card" }).first().click();
    await page.getByRole("dialog", { name: "History detail modal" }).getByRole("button", { name: "Delete" }).click();
    await expect(historyCards(page).filter({ hasText: "Session linked success card" })).toHaveCount(0);
    expect(fixtures.deletedJobIds).toContain(fixtures.successDeleteId);
    await page.waitForTimeout(1200);
    await expect.poll(async () => {
      return page.evaluate((deletedId) => {
        const sessions = JSON.parse(localStorage.getItem("nbp_picker_sessions_v1") || "[]");
        return sessions.some((session) => (session.items || []).some((item) => item.job_id === deletedId));
      }, fixtures.successDeleteId);
    }).toBeFalsy();
  });
});
