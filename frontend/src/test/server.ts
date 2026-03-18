import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

const now = "2026-03-18T12:00:00Z";
const anyApiPath = (path: string) =>
  new RegExp(`^https?://(?:127\\.0\\.0\\.1|localhost):\\d+/v1${path.replaceAll("/", "\\/")}$`);

const providerSummary = {
  currency: "CNY",
  providers_total: 1,
  providers_enabled: 1,
  providers_healthy: 1,
  providers_cooldown: 0,
  remaining_balance_cny: 88.8,
  spent_cny: 0,
  last_updated_at: now,
  providers: [
    {
      provider_id: "ci-fake",
      label: "CI Fake Generator",
      adapter_type: "ci_fake",
      base_url: "test://ci-fake-generator",
      enabled: true,
      note: "test provider",
      supported_models: [
        "gemini-3-pro-image-preview",
        "gemini-2.5-flash-image",
        "gemini-3.1-flash-image-preview",
      ],
      cost_per_image_cny: 0,
      remaining_balance_cny: 88.8,
      quota_state: "HAS_QUOTA",
      quota_confidence: 1,
      quota_score: 1,
      success_count: 3,
      fail_count: 0,
      consecutive_failures: 0,
      last_fail_reason: null,
      last_success_time: now,
      last_fail_time: null,
      cooldown_until: null,
      cooldown_active: false,
      circuit_open_count: 0,
      last_circuit_open_time: null,
      last_circuit_open_reason: null,
      last_circuit_open_until: null,
      last_circuit_open_duration_sec: null,
      forced_activation_count: 0,
      last_forced_activation_time: null,
      last_forced_activation_reason: null,
      last_forced_activation_mode: null,
      success_rate_estimated: 1,
      recent_success_rate: 1,
      final_success_rate: 1,
      health_score: 1,
      effective_cost: 0,
      active_requests: 0,
      max_concurrency: 1,
      latency_p50_ms: 120,
      latency_p95_ms: 150,
      timeout_rate: 0,
      total_spent_cny: 0,
      total_generated_images: 3,
      balance_updated_at: now,
      last_selected_time: now,
      recent_calls: [],
    },
  ],
};

const sessionPayload = {
  authenticated: true,
  user: {
    user_id: "admin-user",
    username: "admin",
    role: "ADMIN",
    enabled: true,
    created_at: now,
    updated_at: now,
    last_login_at: now,
    policy: {
      daily_image_limit: 100,
      extra_daily_image_limit: 50,
      concurrent_jobs_limit: 20,
      turnstile_job_count_threshold: 5,
      turnstile_daily_usage_threshold: 50,
      daily_image_access_limit: 200,
      image_access_turnstile_bonus_quota: 15,
      daily_image_access_hard_limit: 350,
    },
  },
  usage: {
    quota_consumed_today: 0,
    remaining_images_today: 100,
    image_accesses_today: 0,
    remaining_image_accesses_today: 200,
    generation_turnstile_required: false,
    image_access_turnstile_required: false,
  },
  generation_turnstile_verified_until: null,
};

const modelsPayload = {
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
      supported_image_sizes: ["1K", "2K"],
      supported_thinking_levels: ["Minimal", "High"],
      default_params: { aspect_ratio: "1:1", image_size: "1K", thinking_level: "High", temperature: 1, timeout_sec: 400, max_retries: 0 },
    },
    {
      model_id: "gemini-2.5-flash-image",
      label: "Nano Banana",
      description: "Gemini 2.5 Flash Image",
      supports_text_output: true,
      supports_image_size: false,
      supports_thinking_level: false,
      supported_modes: ["IMAGE_ONLY", "TEXT_AND_IMAGE"],
      supported_aspect_ratios: ["1:1", "16:9"],
      supported_image_sizes: [],
      supported_thinking_levels: [],
      default_params: { aspect_ratio: "1:1", image_size: "AUTO", thinking_level: null, temperature: 1, timeout_sec: 400, max_retries: 0 },
    },
  ],
};

const emptyDashboardStats = {
  today_count: 0,
  today_success: 0,
  today_failed: 0,
  today_success_rate: 0,
  today_total_tokens: 0,
  today_total_cost_usd: 0,
  today_avg_latency_ms: 0,
  today_p95_latency_ms: 0,
  recent10_success_rate: 0,
  recent10_avg_latency_ms: 0,
  recent10_avg_cost_usd: 0,
  recent10_avg_image_cost_usd: 0,
  failure_top: [],
  image_size_dist: [],
  aspect_ratio_dist: [],
  temperature_dist: [],
  trend_tokens: [],
  trend_cost: [],
};

export const handlers = [
  http.get(anyApiPath("/auth/me"), () => HttpResponse.json(sessionPayload)),
  http.get(anyApiPath("/models"), () => HttpResponse.json(modelsPayload)),
  http.post(anyApiPath("/dashboard/summary"), () =>
    HttpResponse.json({ stats: emptyDashboardStats, updates: [], forbidden: [], not_found: [], failed: [], requested: 0, ok: 0 })
  ),
  http.get(anyApiPath("/admin/providers"), () => HttpResponse.json(providerSummary)),
  http.get(anyApiPath("/announcements/active"), () => HttpResponse.json({ server_time: now, items: [] })),
];

export const server = setupServer(...handlers);
