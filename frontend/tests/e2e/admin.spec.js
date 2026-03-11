import { expect, test } from "@playwright/test";

const BASE_URL = process.env.PW_BASE_URL || "http://127.0.0.1:5178";
const ADMIN_COOKIE = "eyJ1c2VyX2lkIjogIjFmZjAxODI3YTkxNzA3NjhkMjY1NmMwYyJ9.aa6-cA.CPyq2oqG6B0uzph_K7ogDfTJHC0";

function buildFixtures() {
  const providers = [
    {
      provider_id: "mmw",
      label: "MMW",
      adapter_type: "openai_chat_image",
      base_url: "https://api.mmw.ink",
      enabled: true,
      note: "main",
      supported_models: ["gemini-2.5-flash-image", "gemini-3-pro-image-preview"],
      cost_per_image_cny: 0.09,
      remaining_balance_cny: 21.5,
      quota_state: "HAS_QUOTA",
      quota_confidence: 1,
      quota_score: 1,
      success_count: 12,
      fail_count: 2,
      consecutive_failures: 0,
      last_fail_reason: null,
      last_success_time: "2026-03-10T12:00:00Z",
      last_fail_time: "2026-03-09T12:00:00Z",
      cooldown_until: null,
      cooldown_active: false,
      circuit_open_count: 0,
      success_rate_estimated: 0.82,
      recent_success_rate: 0.9,
      final_success_rate: 0.87,
      health_score: 0.87,
      effective_cost: 0.1034,
      active_requests: 0,
      max_concurrency: 1,
      latency_p50_ms: 32000,
      latency_p95_ms: 53000,
      timeout_rate: 0.05,
      total_spent_cny: 3.42,
      total_generated_images: 38,
      balance_updated_at: "2026-03-10T12:00:00Z",
      last_selected_time: "2026-03-10T12:30:00Z",
      recent_calls: [],
    },
    {
      provider_id: "zx2",
      label: "ZX2",
      adapter_type: "gemini_v1beta",
      base_url: "http://zx2.52youxi.cc:3000/v1beta",
      enabled: true,
      note: "cheap",
      supported_models: ["gemini-3.1-flash-image-preview"],
      cost_per_image_cny: 0.05,
      remaining_balance_cny: 10,
      quota_state: "HAS_QUOTA",
      quota_confidence: 1,
      quota_score: 0.8,
      success_count: 3,
      fail_count: 4,
      consecutive_failures: 1,
      last_fail_reason: "UPSTREAM_SERVER_ERROR",
      last_success_time: "2026-03-10T11:00:00Z",
      last_fail_time: "2026-03-10T11:20:00Z",
      cooldown_until: null,
      cooldown_active: false,
      circuit_open_count: 0,
      success_rate_estimated: 0.58,
      recent_success_rate: 0.52,
      final_success_rate: 0.54,
      health_score: 0.44,
      effective_cost: 0.0926,
      active_requests: 0,
      max_concurrency: 1,
      latency_p50_ms: 29000,
      latency_p95_ms: 61000,
      timeout_rate: 0.18,
      total_spent_cny: 1.25,
      total_generated_images: 25,
      balance_updated_at: "2026-03-10T11:20:00Z",
      last_selected_time: "2026-03-10T11:15:00Z",
      recent_calls: [],
    },
  ];

  const policy = {
    default_user_daily_image_limit: 100,
    default_user_extra_daily_image_limit: 50,
    default_user_concurrent_jobs_limit: 2,
    default_admin_concurrent_jobs_limit: 20,
    default_user_turnstile_job_count_threshold: 5,
    default_user_turnstile_daily_usage_threshold: 50,
    default_user_daily_image_access_limit: 200,
    default_user_image_access_turnstile_bonus_quota: 15,
    default_user_daily_image_access_hard_limit: 350,
  };

  const users = [
    {
      user_id: "admin-user",
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
      total_jobs: 0,
    },
  ];

  const makeProviderSummary = () => ({
    currency: "CNY",
    providers_total: providers.length,
    providers_enabled: providers.filter((item) => item.enabled).length,
    providers_healthy: providers.filter((item) => item.enabled && !item.cooldown_active && item.quota_state !== "NO_QUOTA").length,
    providers_cooldown: providers.filter((item) => item.cooldown_active).length,
    remaining_balance_cny: providers.reduce((sum, item) => sum + (item.remaining_balance_cny || 0), 0),
    spent_cny: providers.reduce((sum, item) => sum + (item.total_spent_cny || 0), 0),
    last_updated_at: "2026-03-10T12:40:00Z",
    providers,
  });

  return {
    providers,
    users,
    policy,
    overview() {
      return {
        system: {
          app_version: "1.0.0",
          deployed_at: "2026-03-10T00:00:00Z",
          now: "2026-03-10T12:40:00Z",
          uptime_sec: 3600,
          queue_size: 0,
          worker_count: 2,
          users_total: 1,
          users_enabled: 1,
          jobs_total: 0,
          queued_jobs: 0,
          running_jobs: 0,
          active_jobs: 0,
          succeeded_today: 0,
          failed_today: 0,
          images_generated_today: 0,
          image_accesses_today: 0,
        },
        policy,
        providers: makeProviderSummary(),
      };
    },
    providerSummary: makeProviderSummary,
  };
}

async function installMocks(page, fixtures) {
  await page.route("**/v1/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        user: {
          user_id: "admin-user",
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
        generation_turnstile_verified_until: "2026-03-11T00:00:00Z",
      }),
    });
  });

  await page.route("**/v1/models", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        default_model: "gemini-3.1-flash-image-preview",
        models: [
          {
            model_id: "gemini-3.1-flash-image-preview",
            label: "Nano Banana 2",
            description: "Gemini 3.1 Flash Image Preview",
            supports_text_output: false,
            supports_image_size: true,
            supports_thinking_level: true,
            supported_modes: ["IMAGE_ONLY"],
            supported_aspect_ratios: ["1:1", "16:9"],
            supported_image_sizes: ["1K", "2K", "4K"],
            supported_thinking_levels: ["Minimal", "High"],
            default_params: { aspect_ratio: "1:1", image_size: "1K", thinking_level: "High", temperature: 1, timeout_sec: 120, max_retries: 0 },
          },
        ],
      }),
    });
  });

  await page.route("**/v1/admin/overview", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixtures.overview()) });
  });

  await page.route("**/v1/admin/users", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ users: fixtures.users }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixtures.users[0]) });
  });

  await page.route("**/v1/admin/policy", async (route) => {
    if (route.request().method() === "PATCH") {
      fixtures.policy = { ...fixtures.policy, ...(route.request().postDataJSON() || {}) };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ policy: fixtures.policy }) });
  });

  await page.route("**/v1/admin/providers", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixtures.providerSummary()) });
  });

  await page.route("**/v1/admin/providers/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const parts = path.split("/").filter(Boolean);
    const providerId = parts[3];
    const provider = fixtures.providers.find((item) => item.provider_id === providerId);
    if (!provider) {
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Provider not found" } }) });
      return;
    }

    if (request.method() === "PATCH") {
      const body = request.postDataJSON();
      provider.enabled = body.enabled;
      provider.note = body.note || "";
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ provider }) });
      return;
    }

    if (request.method() === "POST" && path.endsWith("/balance/set")) {
      const body = request.postDataJSON();
      provider.remaining_balance_cny = body.amount_cny;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ provider }) });
      return;
    }

    if (request.method() === "POST" && path.endsWith("/balance/add")) {
      const body = request.postDataJSON();
      provider.remaining_balance_cny = Number(((provider.remaining_balance_cny || 0) + body.delta_cny).toFixed(4));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ provider }) });
      return;
    }

    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Unhandled" } }) });
  });
}

test.describe.serial("Admin page", () => {
  test("renders provider details and supports note/balance operations", async ({ page }) => {
    const fixtures = buildFixtures();
    await installMocks(page, fixtures);
    await page.context().addCookies([{ name: "nbp_session", value: ADMIN_COOKIE, url: BASE_URL }]);
    await page.goto(`${BASE_URL}/admin`);

    await expect(page.getByText("中转站状态")).toBeVisible();
    await expect(page.getByText("MMW", { exact: true })).toBeVisible();
    await expect(page.getByText("ZX2", { exact: true })).toBeVisible();

    const mmwCard = page.getByText("https://api.mmw.ink", { exact: true }).locator("xpath=ancestor::div[contains(@class,'rounded-2xl')][1]");
    await mmwCard.getByPlaceholder("备注").fill("primary lane");
    await mmwCard.getByRole("button", { name: "保存 Provider" }).click();
    await expect(mmwCard.getByPlaceholder("备注")).toHaveValue("primary lane");

    await mmwCard.getByPlaceholder("可留空设为 unknown").fill("18.5");
    await mmwCard.getByRole("button", { name: "设置" }).click();
    await expect(mmwCard).toContainText("18.5 CNY");

    await mmwCard.getByPlaceholder("充值金额").fill("1.5");
    await mmwCard.getByRole("button", { name: "增加" }).click();
    await expect(mmwCard).toContainText("20 CNY");
  });

  test("create page no longer exposes max_retries control", async ({ page }) => {
    const fixtures = buildFixtures();
    await installMocks(page, fixtures);
    await page.context().addCookies([{ name: "nbp_session", value: ADMIN_COOKIE, url: BASE_URL }]);
    await page.goto(`${BASE_URL}/create`);

    await expect(page.getByText("Create Job")).toBeVisible();
    await expect(page.getByText("max_retries")).toHaveCount(0);
  });
});
