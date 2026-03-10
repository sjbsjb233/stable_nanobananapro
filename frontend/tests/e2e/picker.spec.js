import { expect, test } from "@playwright/test";

const BASE_URL = process.env.PW_BASE_URL || "http://127.0.0.1:5178";
const ADMIN_COOKIE = "eyJ1c2VyX2lkIjogIjFmZjAxODI3YTkxNzA3NjhkMjY1NmMwYyJ9.aa6-cA.CPyq2oqG6B0uzph_K7ogDfTJHC0";
const ADMIN_USER_ID = "1ff01827a9170768d2656c0c";
const PNG_1X1_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7m6XQAAAAASUVORK5CYII=";

function pickerJob(job_id, extra = {}) {
  return {
    job_id,
    job_access_token: `tok-${job_id}`,
    model_cache: "gemini-3-pro-image-preview",
    created_at: extra.created_at || "2026-03-10T00:00:00Z",
    status_cache: extra.status_cache || "SUCCEEDED",
    prompt_preview: extra.prompt_preview || job_id,
    prompt_text: extra.prompt_text || `${job_id} prompt`,
    params_cache: {
      aspect_ratio: "1:1",
      image_size: "1K",
      thinking_level: null,
      temperature: 1,
      timeout_sec: 120,
      max_retries: 0,
    },
    last_seen_at: extra.last_seen_at || "2026-03-10T00:00:00Z",
    first_image_id: extra.first_image_id,
    image_count_cache: extra.image_count_cache,
    linked_session_ids: extra.linked_session_ids || [],
  };
}

function pickerImageItem(job_id, extra = {}) {
  return {
    job_id,
    image_id: extra.image_id || "image_0",
    job_access_token: `tok-${job_id}`,
    status: extra.status || "SUCCEEDED",
    added_at: extra.added_at || "2026-03-10T00:00:00Z",
    bucket: extra.bucket || "FILMSTRIP",
    pool: extra.bucket === "PREFERRED" ? "PREFERRED" : "FILMSTRIP",
    rating: extra.rating,
    reviewed: extra.reviewed ?? false,
    picked: extra.picked ?? true,
  };
}

function pickerPendingItem(job_id, extra = {}) {
  return {
    item_key: `${job_id}::__pending__`,
    job_id,
    job_access_token: `tok-${job_id}`,
    status: extra.status || "RUNNING",
    added_at: extra.added_at || "2026-03-10T00:00:00Z",
    bucket: extra.bucket || "FILMSTRIP",
    pool: extra.bucket === "PREFERRED" ? "PREFERRED" : "FILMSTRIP",
    reviewed: extra.reviewed ?? false,
    picked: extra.picked ?? true,
  };
}

function buildPickerFixtures() {
  const jobs = [
    pickerJob("film_a", { first_image_id: "image_0", image_count_cache: 1 }),
    pickerJob("film_b", { first_image_id: "image_0", image_count_cache: 1 }),
    pickerJob("film_c", { first_image_id: "image_0", image_count_cache: 1 }),
    pickerJob("film_d", { first_image_id: "image_0", image_count_cache: 1 }),
    pickerJob("pref_a", { first_image_id: "image_0", image_count_cache: 1 }),
  ];

  return {
    jobs,
    metas: Object.fromEntries(
      jobs.map((job) => [
        job.job_id,
        {
          job_id: job.job_id,
          model: job.model_cache,
          status: job.status_cache,
          created_at: job.created_at,
          updated_at: job.last_seen_at,
          timing: {
            queued_at: job.created_at,
            started_at: job.created_at,
            finished_at: job.last_seen_at,
            queue_wait_ms: 300,
            run_duration_ms: 1500,
          },
          result: {
            images: [{ image_id: "image_0", mime: "image/png", width: 1, height: 1 }],
          },
        },
      ])
    ),
    sessions: [
      {
        session_id: "pk_picker_scheduler",
        name: "Picker Scheduler",
        created_at: "2026-03-10T00:00:00Z",
        updated_at: "2026-03-10T00:00:00Z",
        items: [
          pickerImageItem("film_a"),
          pickerImageItem("film_b"),
          pickerImageItem("film_c", { rating: 3, reviewed: true }),
          pickerImageItem("film_d", { rating: 5, reviewed: true }),
          pickerImageItem("pref_a", { bucket: "PREFERRED", rating: 5, reviewed: true }),
        ],
        compare_mode: "TWO",
        layout_preset: "SYNC_ZOOM",
        ui: { background: "dark", showGrid: false, showInfo: false },
        slots: [null, null, null, null],
        focus_key: null,
      },
    ],
    previewBatchCalls: 0,
    originalImageCalls: 0,
    previewImageCalls: 0,
    activeCalls: 0,
  };
}

function buildStreamingFixtures() {
  const jobs = [
    pickerJob("anchor_a", { first_image_id: "image_0", image_count_cache: 1 }),
    pickerJob("stream_job", { status_cache: "RUNNING", first_image_id: undefined, image_count_cache: 0 }),
  ];

  return {
    jobs,
    metas: {
      anchor_a: {
        job_id: "anchor_a",
        model: "gemini-3-pro-image-preview",
        status: "SUCCEEDED",
        created_at: "2026-03-10T00:00:00Z",
        updated_at: "2026-03-10T00:00:00Z",
        timing: { queued_at: "2026-03-10T00:00:00Z", started_at: "2026-03-10T00:00:00Z", finished_at: "2026-03-10T00:00:00Z", queue_wait_ms: 200, run_duration_ms: 1200 },
        result: { images: [{ image_id: "image_0", mime: "image/png", width: 1, height: 1 }] },
      },
      stream_job: {
        job_id: "stream_job",
        model: "gemini-3-pro-image-preview",
        status: "RUNNING",
        created_at: "2026-03-10T00:00:00Z",
        updated_at: "2026-03-10T00:00:00Z",
        timing: { queued_at: "2026-03-10T00:00:00Z", started_at: "2026-03-10T00:00:01Z", finished_at: null, queue_wait_ms: 100, run_duration_ms: null },
        result: { images: [] },
      },
    },
    sessions: [
      {
        session_id: "pk_picker_streaming",
        name: "Picker Streaming",
        created_at: "2026-03-10T00:00:00Z",
        updated_at: "2026-03-10T00:00:00Z",
        items: [
          pickerImageItem("anchor_a"),
          pickerPendingItem("stream_job", { status: "RUNNING" }),
        ],
        compare_mode: "TWO",
        layout_preset: "SYNC_ZOOM",
        ui: { background: "dark", showGrid: false, showInfo: false },
        slots: [null, null, null, null],
        focus_key: null,
      },
    ],
    previewBatchCalls: 0,
    originalImageCalls: 0,
    previewImageCalls: 0,
    activeCalls: 0,
  };
}

function buildPressureFixtures(count = 84) {
  const jobs = [];
  const items = [];
  const metas = {};
  for (let idx = 0; idx < count; idx += 1) {
    const jobId = `stress_${String(idx).padStart(3, "0")}`;
    jobs.push(pickerJob(jobId, { first_image_id: "image_0", image_count_cache: 1, created_at: `2026-03-10T00:${String(idx % 60).padStart(2, "0")}:00Z` }));
    items.push(
      pickerImageItem(jobId, {
        rating: idx % 5 ? undefined : 5,
        reviewed: idx % 3 === 0,
        bucket: idx >= count - 8 ? "PREFERRED" : "FILMSTRIP",
      })
    );
    metas[jobId] = {
      job_id: jobId,
      model: "gemini-3-pro-image-preview",
      status: "SUCCEEDED",
      created_at: "2026-03-10T00:00:00Z",
      updated_at: "2026-03-10T00:00:00Z",
      timing: { queued_at: "2026-03-10T00:00:00Z", started_at: "2026-03-10T00:00:00Z", finished_at: "2026-03-10T00:00:00Z", queue_wait_ms: 200, run_duration_ms: 1200 },
      result: { images: [{ image_id: "image_0", mime: "image/png", width: 1, height: 1 }] },
    };
  }
  return {
    jobs,
    metas,
    sessions: [
      {
        session_id: "pk_picker_pressure",
        name: "Picker Pressure",
        created_at: "2026-03-10T00:00:00Z",
        updated_at: "2026-03-10T00:00:00Z",
        items,
        compare_mode: "FOUR",
        layout_preset: "SYNC_ZOOM",
        ui: { background: "dark", showGrid: false, showInfo: false },
        slots: [null, null, null, null],
        focus_key: null,
      },
    ],
    previewBatchCalls: 0,
    originalImageCalls: 0,
    previewImageCalls: 0,
    activeCalls: 0,
  };
}

function buildSidebarFixtures() {
  const jobs = [
    pickerJob("sidebar_a", { first_image_id: "image_0", image_count_cache: 1 }),
    pickerJob("sidebar_archived", { first_image_id: "image_0", image_count_cache: 1 }),
  ];

  return {
    jobs,
    metas: Object.fromEntries(
      jobs.map((job) => [
        job.job_id,
        {
          job_id: job.job_id,
          model: job.model_cache,
          status: job.status_cache,
          created_at: job.created_at,
          updated_at: job.last_seen_at,
          timing: {
            queued_at: job.created_at,
            started_at: job.created_at,
            finished_at: job.last_seen_at,
            queue_wait_ms: 200,
            run_duration_ms: 1200,
          },
          result: {
            images: [{ image_id: "image_0", mime: "image/png", width: 1, height: 1 }],
          },
        },
      ])
    ),
    sessions: [
      {
        session_id: "pk_sidebar_primary",
        name: "Primary Review",
        created_at: "2026-03-10T00:00:00Z",
        updated_at: "2026-03-10T00:00:00Z",
        pinned: true,
        archived: false,
        items: [pickerImageItem("sidebar_a")],
        compare_mode: "FOUR",
        layout_preset: "SYNC_ZOOM",
        ui: { background: "light", showGrid: false, showInfo: false },
        slots: [null, null, null, null],
        focus_key: null,
      },
      {
        session_id: "pk_sidebar_archived",
        name: "Archived Review",
        created_at: "2026-03-09T00:00:00Z",
        updated_at: "2026-03-09T00:00:00Z",
        pinned: false,
        archived: true,
        items: [pickerImageItem("sidebar_archived")],
        compare_mode: "FOUR",
        layout_preset: "SYNC_ZOOM",
        ui: { background: "light", showGrid: false, showInfo: false },
        slots: [null, null, null, null],
        focus_key: null,
      },
    ],
    previewBatchCalls: 0,
    originalImageCalls: 0,
    previewImageCalls: 0,
    activeCalls: 0,
  };
}

function buildImportDrawerFixtures() {
  const jobs = [];
  const metas = {};
  const session = {
    session_id: "pk_picker_import",
    name: "Import Target",
    created_at: "2026-03-10T00:00:00Z",
    updated_at: "2026-03-10T00:00:00Z",
    pinned: false,
    archived: false,
    items: [],
    compare_mode: "FOUR",
    layout_preset: "SYNC_ZOOM",
    ui: { background: "light", showGrid: false, showInfo: false },
    slots: [null, null, null, null],
    focus_key: null,
  };

  const addJob = (job) => {
    jobs.push(job);
    metas[job.job_id] = {
      job_id: job.job_id,
      model: job.model_cache,
      status: job.status_cache,
      created_at: job.created_at,
      updated_at: job.last_seen_at,
      timing: { queued_at: job.created_at, started_at: job.created_at, finished_at: job.last_seen_at, queue_wait_ms: 200, run_duration_ms: 1200 },
      result: { images: [{ image_id: "image_0", mime: "image/png", width: 1, height: 1 }] },
    };
  };

  for (let idx = 0; idx < 11; idx += 1) {
    addJob(
      pickerJob(`import_single_${idx}`, {
        first_image_id: "image_0",
        image_count_cache: 1,
        created_at: `2026-03-10T00:${String(idx).padStart(2, "0")}:00Z`,
      })
    );
  }

  ["batch_a", "batch_b", "batch_c"].forEach((name, idx) => {
    addJob(
      pickerJob(name, {
        first_image_id: "image_0",
        image_count_cache: 1,
        created_at: `2026-03-10T00:${String(30 + idx).padStart(2, "0")}:00Z`,
        prompt_preview: `Batch member ${idx + 1}`,
      })
    );
    jobs[jobs.length - 1].batch_id = "import_batch_alpha";
    jobs[jobs.length - 1].batch_name = "Import Batch Alpha";
    jobs[jobs.length - 1].batch_size = 3;
    jobs[jobs.length - 1].batch_index = idx + 1;
  });

  return {
    jobs,
    metas,
    sessions: [session],
    previewBatchCalls: 0,
    originalImageCalls: 0,
    previewImageCalls: 0,
    activeCalls: 0,
  };
}

function buildLayoutRegressionFixtures() {
  const jobs = [];
  const metas = {};
  const pushJob = (job) => {
    jobs.push(job);
    metas[job.job_id] = {
      job_id: job.job_id,
      model: job.model_cache,
      status: job.status_cache,
      created_at: job.created_at,
      updated_at: job.last_seen_at,
      timing: { queued_at: job.created_at, started_at: job.created_at, finished_at: job.last_seen_at, queue_wait_ms: 200, run_duration_ms: 1200 },
      result: { images: [{ image_id: "image_0", mime: "image/png", width: 1, height: 1 }] },
    };
  };

  for (let idx = 0; idx < 10; idx += 1) {
    pushJob(
      pickerJob(`layout_film_${idx}`, {
        first_image_id: "image_0",
        image_count_cache: 1,
        created_at: `2026-03-10T00:${String(idx).padStart(2, "0")}:00Z`,
      })
    );
  }

  for (let idx = 0; idx < 5; idx += 1) {
    pushJob(
      pickerJob(`layout_pref_${idx}`, {
        first_image_id: "image_0",
        image_count_cache: 1,
        created_at: `2026-03-10T01:${String(idx).padStart(2, "0")}:00Z`,
      })
    );
  }

  return {
    jobs,
    metas,
    sidebarPinned: true,
    sessions: [
      {
        session_id: "pk_layout_a",
        name: "test123",
        created_at: "2026-03-10T00:00:00Z",
        updated_at: "2026-03-10T00:00:00Z",
        archived: false,
        pinned: false,
        items: [],
        compare_mode: "FOUR",
        layout_preset: "SYNC_ZOOM",
        ui: { background: "light", showGrid: false, showInfo: false },
        slots: [null, null, null, null],
        focus_key: null,
      },
      {
        session_id: "pk_layout_b",
        name: "789432523",
        created_at: "2026-03-10T00:00:00Z",
        updated_at: "2026-03-10T00:00:00Z",
        archived: false,
        pinned: false,
        items: [
          ...Array.from({ length: 10 }, (_, idx) =>
            pickerImageItem(`layout_film_${idx}`, {
              reviewed: idx >= 5,
              rating: idx >= 5 ? ((idx % 5) + 1) : undefined,
            })
          ),
          ...Array.from({ length: 5 }, (_, idx) =>
            pickerImageItem(`layout_pref_${idx}`, {
              bucket: "PREFERRED",
              reviewed: true,
              rating: idx % 2 ? 4 : 5,
            })
          ),
        ],
        compare_mode: "FOUR",
        layout_preset: "SYNC_ZOOM",
        ui: { background: "light", showGrid: false, showInfo: false },
        slots: [null, null, null, null],
        focus_key: null,
      },
      {
        session_id: "pk_layout_c",
        name: "默认挑选会话",
        created_at: "2026-03-09T00:00:00Z",
        updated_at: "2026-03-09T00:00:00Z",
        archived: false,
        pinned: false,
        items: [
          ...Array.from({ length: 7 }, (_, idx) =>
            pickerImageItem(`layout_film_${idx}`, {
              reviewed: idx >= 3,
              rating: idx >= 3 ? 4 : undefined,
            })
          ),
          ...Array.from({ length: 2 }, (_, idx) =>
            pickerImageItem(`layout_pref_${idx}`, {
              bucket: "PREFERRED",
              reviewed: true,
              rating: 5,
            })
          ),
        ],
        compare_mode: "FOUR",
        layout_preset: "SYNC_ZOOM",
        ui: { background: "light", showGrid: false, showInfo: false },
        slots: [null, null, null, null],
        focus_key: null,
      },
    ],
    previewBatchCalls: 0,
    originalImageCalls: 0,
    previewImageCalls: 0,
    activeCalls: 0,
  };
}

async function seedPickerState(page, fixtures, sessionId) {
  await page.addInitScript(
    ([adminUserId, jobs, sessions, seedSessionId, sidebarPinned]) => {
      window.localStorage.setItem("nbp_jobs_by_user_v2", JSON.stringify({ [adminUserId]: jobs }));
      window.localStorage.setItem("nbp_picker_sessions_v1", JSON.stringify(sessions));
      window.localStorage.setItem("nbp_picker_recent_v1", JSON.stringify({ last_session_id: seedSessionId, last_opened_at: new Date().toISOString() }));
      if (sidebarPinned !== undefined) {
        window.localStorage.setItem("nbp_picker_sidebar_pref_v1", JSON.stringify({ pinned: sidebarPinned }));
      }
      window.localStorage.setItem(
        "nbp_settings_v1",
        JSON.stringify({
          jobAuthMode: "TOKEN",
          cache: {
            enabled: true,
            ttlDays: 3,
            maxBytes: 2147483648,
          },
        })
      );
    },
    [ADMIN_USER_ID, fixtures.jobs, fixtures.sessions, sessionId, fixtures.sidebarPinned]
  );
}

async function installPickerMocks(page, fixtures) {
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

  await page.route("**/v1/models", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        default_model: "gemini-3-pro-image-preview",
        models: [
          {
            model_id: "gemini-3-pro-image-preview",
            label: "Nano Banana Pro",
            description: "Gemini 3 Pro Image Preview",
            supports_text_output: true,
            supports_image_size: true,
            supports_thinking_level: false,
            supported_modes: ["IMAGE_ONLY", "TEXT_AND_IMAGE"],
            supported_aspect_ratios: ["1:1", "16:9"],
            supported_image_sizes: ["1K", "2K", "4K"],
            supported_thinking_levels: [],
            default_params: { aspect_ratio: "1:1", image_size: "1K", thinking_level: null, temperature: 1, timeout_sec: 120, max_retries: 0 },
          },
        ],
      }),
    });
  });

  await page.route("**/v1/jobs/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path.endsWith("/v1/jobs/previews/batch")) {
      fixtures.previewBatchCalls += 1;
      const body = request.postDataJSON();
      const items = (body.images || []).map((item) => ({
        job_id: item.job_id,
        image_id: item.image_id,
        mime: "image/png",
        size_bytes: Buffer.from(PNG_1X1_BASE64, "base64").length,
        data_base64: PNG_1X1_BASE64,
      }));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items, forbidden: [], not_found: [], failed: [], requested: items.length, ok: items.length, limit: 72 }),
      });
      return;
    }

    if (path.endsWith("/v1/jobs/active")) {
      fixtures.activeCalls += 1;
      if (fixtures.metas.stream_job && fixtures.activeCalls >= 2) {
        fixtures.metas.stream_job = {
          ...fixtures.metas.stream_job,
          status: "SUCCEEDED",
          updated_at: "2026-03-10T00:00:08Z",
          timing: {
            ...fixtures.metas.stream_job.timing,
            finished_at: "2026-03-10T00:00:08Z",
            run_duration_ms: 2200,
          },
          result: { images: [{ image_id: "image_0", mime: "image/png", width: 1, height: 1 }] },
        };
      }
      const active = [];
      const settled = [];
      Object.values(fixtures.metas).forEach((meta) => {
        const snap = {
          job_id: meta.job_id,
          status: meta.status,
          model: meta.model,
          updated_at: meta.updated_at,
          timing: meta.timing,
          first_image_id: meta.result?.images?.[0]?.image_id,
          image_count: meta.result?.images?.length || 0,
        };
        if (meta.status === "RUNNING" || meta.status === "QUEUED") active.push(snap);
        else settled.push(snap);
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ active, settled, forbidden: [], not_found: [], failed: [], requested: active.length + settled.length, active_count: active.length, settled_count: settled.length }),
      });
      return;
    }

    const match = path.match(/\/v1\/jobs\/([^/]+)(?:\/(.*))?$/);
    if (!match) {
      await route.fallback();
      return;
    }

    const jobId = decodeURIComponent(match[1]);
    const suffix = match[2] || "";

    if (method === "GET" && !suffix) {
      const meta = fixtures.metas[jobId];
      await route.fulfill({
        status: meta ? 200 : 404,
        contentType: "application/json",
        body: JSON.stringify(meta || { error: { code: "JOB_NOT_FOUND", message: "Job not found" } }),
      });
      return;
    }

    if (method === "GET" && suffix.startsWith("images/") && suffix.endsWith("/preview")) {
      fixtures.previewImageCalls += 1;
      await route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(PNG_1X1_BASE64, "base64") });
      return;
    }

    if (method === "GET" && suffix.startsWith("images/")) {
      fixtures.originalImageCalls += 1;
      await route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(PNG_1X1_BASE64, "base64") });
      return;
    }

    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Unhandled in test" } }) });
  });
}

async function loginToPicker(page, sessionId) {
  await page.context().addCookies([{ name: "nbp_session", value: ADMIN_COOKIE, url: BASE_URL }]);
  await page.goto(`${BASE_URL}/picker?session=${encodeURIComponent(sessionId)}`);
  await expect(page.getByText("Image Picker")).toBeVisible();
}

test.describe.serial("Picker page", () => {
  test("keeps rated images on screen, removes hard actions immediately, and prioritizes filmstrip before picked", async ({ page }) => {
    const fixtures = buildPickerFixtures();
    await seedPickerState(page, fixtures, "pk_picker_scheduler");
    await installPickerMocks(page, fixtures);
    await loginToPicker(page, "pk_picker_scheduler");

    const slotAText = await page.getByTestId("picker-slot-A").textContent();
    const slotBText = await page.getByTestId("picker-slot-B").textContent();
    expect(`${slotAText} ${slotBText}`).toContain("film_a");
    expect(`${slotAText} ${slotBText}`).toContain("film_b");

    const beforeRateA = await page.getByTestId("picker-name-A").textContent();
    await page.getByTestId("picker-slot-A").getByTitle("评分 5").click();
    await expect(page.getByTestId("picker-name-A")).toHaveText(beforeRateA || "");

    await page.getByTestId("picker-slot-B").getByTitle("评分 4").click();
    await page.getByTestId("picker-next-batch").click();

    const nextStage = `${await page.getByTestId("picker-slot-A").textContent()} ${await page.getByTestId("picker-slot-B").textContent()}`;
    expect(nextStage).toContain("film_c");
    expect(nextStage).toContain("film_d");
    expect(nextStage).not.toContain("pref_a");

    await page.getByTestId("picker-best-A").click();
    const afterPromote = await page.getByTestId("picker-slot-A").textContent();
    expect(afterPromote).not.toContain("film_c");
    expect(afterPromote).not.toContain("pref_a");
    await expect(page.getByTestId("picker-stat-filmstrip")).toHaveText("Filmstrip 3");
    await expect(page.getByTestId("picker-stat-preferred")).toHaveText("优选池 2");
  });

  test("hydrates a running placeholder in place and uses preview-first loading until explicit download", async ({ page }) => {
    const fixtures = buildStreamingFixtures();
    await seedPickerState(page, fixtures, "pk_picker_streaming");
    await installPickerMocks(page, fixtures);
    await loginToPicker(page, "pk_picker_streaming");

    await expect(page.getByTestId("picker-slot-A")).toContainText("anchor_a");
    await expect(page.getByTestId("picker-slot-B")).toContainText("stream_job");
    expect(fixtures.originalImageCalls).toBe(0);
    await expect(page.getByTestId("picker-slot-A").locator("img")).toBeVisible();

    await expect
      .poll(() => page.getByTestId("picker-slot-B").textContent(), { timeout: 10000 })
      .toContain("stream_job");
    await expect(page.getByTestId("picker-slot-B").locator("img")).toBeVisible({ timeout: 10000 });
    expect(fixtures.originalImageCalls).toBe(0);

    await page.keyboard.press("d");
    await expect
      .poll(() => fixtures.originalImageCalls, { timeout: 5000 })
      .toBeGreaterThanOrEqual(1);
  });

  test("stays interactive across next-group cycles under picker pressure and avoids original-image fetches before download", async ({ page }) => {
    const fixtures = buildPressureFixtures();
    await seedPickerState(page, fixtures, "pk_picker_pressure");
    await installPickerMocks(page, fixtures);
    await loginToPicker(page, "pk_picker_pressure");

    await page.getByRole("button", { name: "4-up" }).click();
    await expect(page.getByTestId("picker-slot-D")).toBeVisible();
    expect(fixtures.originalImageCalls).toBe(0);

    for (let step = 0; step < 6; step += 1) {
      await page.getByTestId("picker-next-batch").click();
    }

    await expect(page.getByTestId("picker-stage")).toBeVisible();
    await expect(page.getByTestId("picker-slot-A")).not.toContainText("空槽位");
    await expect(page.getByTestId("picker-slot-A").locator("img")).toBeVisible();
    expect(fixtures.originalImageCalls).toBe(0);
  });

  test("opens the sidebar from the left edge, creates default light 4-up sessions, and archives sessions from the menu", async ({ page }) => {
    const fixtures = buildSidebarFixtures();
    await seedPickerState(page, fixtures, "pk_sidebar_primary");
    await installPickerMocks(page, fixtures);
    await loginToPicker(page, "pk_sidebar_primary");

    await page.mouse.move(2, 240);
    await expect(page.getByTestId("picker-session-item-pk_sidebar_primary")).toBeVisible();
    await expect(page.getByTestId("picker-session-item-pk_sidebar_archived")).toHaveCount(0);

    await page.getByPlaceholder("新建会话名称").fill("Focus Session");
    await page.getByTestId("picker-sidebar-create-session").click();

    const created = await page.evaluate(() => {
      const sessions = JSON.parse(localStorage.getItem("nbp_picker_sessions_v1") || "[]");
      return sessions.find((session) => session.name === "Focus Session");
    });
    expect(created.compare_mode).toBe("FOUR");
    expect(created.ui.background).toBe("light");

    await page.getByTestId(`picker-session-menu-${created.session_id}`).click();
    await page.getByTestId(`picker-session-menu-panel-${created.session_id}`).getByRole("button", { name: "归档会话" }).click();
    await page.getByTestId("picker-sidebar-archived-toggle").click();
    await expect(page.getByTestId(`picker-session-item-${created.session_id}`)).toBeVisible();
  });

  test("groups import drawer batches, keeps batch groups collapsed by default, paginates groups, and imports an entire batch", async ({ page }) => {
    const fixtures = buildImportDrawerFixtures();
    await seedPickerState(page, fixtures, "pk_picker_import");
    await installPickerMocks(page, fixtures);
    await loginToPicker(page, "pk_picker_import");

    await page.getByRole("button", { name: "从历史导入" }).click();
    await expect(page.getByTestId("picker-import-page")).toHaveText("第 1 / 2 页");
    await expect(page.getByTestId("picker-import-group")).toHaveCount(10);

    const batchGroup = page.getByTestId("picker-import-group").filter({ hasText: "批次 · Import Batch Alpha" }).first();
    await expect(batchGroup).toContainText("已自动折叠该批次");
    await batchGroup.getByRole("button", { name: "整组导入" }).click();

    await expect
      .poll(() =>
        page.evaluate(() => {
          const sessions = JSON.parse(localStorage.getItem("nbp_picker_sessions_v1") || "[]");
          return sessions.find((session) => session.session_id === "pk_picker_import")?.items?.length || 0;
        })
      )
      .toBe(3);

    await page.getByRole("button", { name: "下一页" }).click();
    await expect(page.getByTestId("picker-import-page")).toHaveText("第 2 / 2 页");
  });

  test("fits the toolbar and 4-up stage above the fold and keeps filmstrip/preferred as equal horizontal scrollers", async ({ page }) => {
    const fixtures = buildLayoutRegressionFixtures();
    await page.setViewportSize({ width: 1366, height: 1100 });
    await seedPickerState(page, fixtures, "pk_layout_b");
    await installPickerMocks(page, fixtures);
    await loginToPicker(page, "pk_layout_b");

    const stageBox = await page.getByTestId("picker-stage").boundingBox();
    expect(stageBox).toBeTruthy();
    expect(stageBox.y + stageBox.height).toBeLessThanOrEqual(1100);

    const filmPanel = await page.getByTestId("picker-filmstrip-panel").boundingBox();
    const preferredPanel = await page.getByTestId("picker-preferred-panel").boundingBox();
    expect(filmPanel).toBeTruthy();
    expect(preferredPanel).toBeTruthy();
    expect(Math.abs(filmPanel.width - preferredPanel.width)).toBeLessThanOrEqual(40);
    expect(filmPanel.y).toBeGreaterThan(stageBox.y + stageBox.height - 4);
    expect(preferredPanel.y).toBeGreaterThan(stageBox.y + stageBox.height - 4);

    const filmScroll = await page.getByTestId("picker-filmstrip-scroll").evaluate((node) => ({
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      scrollHeight: node.scrollHeight,
    }));
    expect(filmScroll.scrollWidth).toBeGreaterThan(filmScroll.clientWidth);

    const preferredScroll = await page.getByTestId("picker-preferred-scroll").evaluate((node) => ({
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      scrollHeight: node.scrollHeight,
    }));
    expect(preferredScroll.scrollWidth).toBeGreaterThan(preferredScroll.clientWidth);
    expect(preferredScroll.scrollWidth).toBeGreaterThan(preferredScroll.scrollHeight);
  });

  test("switches sessions from the full card area and keeps the menu and sidebar toggle above surrounding cards", async ({ page }) => {
    const fixtures = buildLayoutRegressionFixtures();
    await seedPickerState(page, fixtures, "pk_layout_b");
    await installPickerMocks(page, fixtures);
    await loginToPicker(page, "pk_layout_b");

    await page.getByTestId("picker-session-item-pk_layout_a").click({ position: { x: 48, y: 34 } });
    await expect(page.getByText("当前会话 · test123")).toBeVisible();

    await page.getByTestId("picker-session-item-pk_layout_b").click({ position: { x: 56, y: 72 } });
    await expect(page.getByText("当前会话 · 789432523")).toBeVisible();

    await page.getByTestId("picker-session-menu-pk_layout_b").click();
    const menuPanel = page.getByTestId("picker-session-menu-panel-pk_layout_b");
    await expect(menuPanel).toBeVisible();
    await expect(menuPanel.getByRole("button", { name: "重命名" })).toBeVisible();
    await expect(menuPanel.getByRole("button", { name: "置顶" })).toBeVisible();
    await expect(menuPanel.getByRole("button", { name: "归档会话" })).toBeVisible();
    await expect(menuPanel.getByRole("button", { name: "删除" })).toBeVisible();
    await menuPanel.getByRole("button", { name: "置顶" }).click();
    await expect(page.getByTestId("picker-session-item-pk_layout_b")).toContainText("置顶");

    const layering = await page.evaluate(() => {
      const toggle = document.querySelector('[data-testid="picker-sidebar-toggle"]');
      if (!toggle) return { toggleOwnsCenter: false };
      const toggleRect = toggle.getBoundingClientRect();
      const toggleElement = document.elementFromPoint(toggleRect.left + toggleRect.width / 2, toggleRect.top + toggleRect.height / 2);
      return {
        toggleOwnsCenter: Boolean(
          toggleElement && (toggle.contains(toggleElement) || toggleElement.contains(toggle))
        ),
      };
    });
    expect(layering.toggleOwnsCenter).toBe(true);
  });
});
