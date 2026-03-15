import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  BrowserRouter,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import { create } from "zustand";
import { logDebug, logError, logInfo, logWarn } from "./logger";

// =========================================================
// Nano Banana Pro - Single file demo (React + Tailwind + TS)
// - Routes: /, /create, /history, /settings
// - Local-first storage (localStorage): settings + jobs
// - API client with cookie session auth + optional X-Job-Token compatibility
// - Dashboard stats computed from local job list + per-job fetch
// - Create job (JSON or multipart) with drag-drop images
// - History list with search/filter/sort + detail panel
// - Settings page for baseUrl / defaults / admin / polling / UI
// =========================================================

// -----------------------------
// Types
// -----------------------------

type JobAuthMode = "TOKEN" | "ID_ONLY";

type ThemeMode = "system" | "dark" | "light";

type JobStatus = "QUEUED" | "RUNNING" | "CANCELLED" | "SUCCEEDED" | "FAILED" | "UNKNOWN";

type ModelId =
  | "gemini-3-pro-image-preview"
  | "gemini-2.5-flash-image"
  | "gemini-3.1-flash-image-preview"
  | string;

type JobMode = "IMAGE_ONLY" | "TEXT_AND_IMAGE";

type ImageSize = "1K" | "2K" | "4K" | string;

type AspectRatio =
  | "1:1"
  | "4:3"
  | "3:4"
  | "16:9"
  | "9:16"
  | "2:3"
  | "3:2"
  | string;

type DefaultParams = {
  aspect_ratio: AspectRatio;
  image_size: ImageSize;
  thinking_level: string | null;
  provider_id: string | null;
  temperature: number;
  timeout_sec: number;
  max_retries: number;
};

type PickerCompareMode = "ONE" | "TWO" | "FOUR";

type PickerBucket = "FILMSTRIP" | "PREFERRED" | "DELETED";

type PickerScheduleMode = "REVIEW_NEW" | "RESOLVE_FILMSTRIP" | "POLISH_PICKED" | "EMPTY";

type PickerGenStatus = "succeeded" | "running" | "queued" | "failed";

type SettingsV1 = {
  baseUrl: string;
  defaultModel: ModelId;
  jobAuthMode: JobAuthMode;
  adminModeEnabled: boolean;
  adminKey: string;
  defaultParams: DefaultParams;
  defaultParamsByModel: Record<string, DefaultParams>;
  ui: {
    theme: ThemeMode;
    language: string;
    reduceMotion: boolean;
  };
  polling: {
    intervalMs: number;
    maxIntervalMs: number;
    concurrency: number;
  };
  cache: {
    enabled: boolean;
    ttlDays: number;
    maxBytes: number;
  };
  pickerScheduler: {
    moveCooldownTurns: number;
    recentHistory: Record<PickerCompareMode, number>;
    newArrivalBonus: number;
    justCompletedBonus: number;
    unseenBonus: number;
    resolveUrgencyWeight: number;
    polishRatingWeight: number;
  };
};

type JobRecord = {
  job_id: string;
  job_access_token?: string;
  model_cache?: ModelId;
  created_at: string; // ISO
  status_cache?: JobStatus;
  prompt_preview?: string;
  prompt_text?: string;
  params_cache?: Partial<DefaultParams>;
  run_started_at?: string;
  run_finished_at?: string;
  queue_wait_ms?: number;
  run_duration_ms?: number;
  last_seen_at?: string;
  first_image_id?: string;
  image_count_cache?: number;
  error_code_cache?: string;
  error_message_cache?: string;
  pinned?: boolean;
  tags?: string[];
  batch_id?: string;
  batch_name?: string;
  batch_note?: string;
  batch_size?: number;
  batch_index?: number;
  section_index?: number;
  section_title?: string;
  linked_session_ids?: string[];
  auto_remove_failed_from_picker?: boolean;
  deleted?: boolean;
};

type ImageVariant = "preview" | "original";

type PreviewBatchItem = {
  job_id: string;
  image_id: string;
  mime: string;
  size_bytes: number;
  data_base64: string;
};

type PreviewBatchResponse = {
  items: PreviewBatchItem[];
  forbidden: Array<{ job_id: string; image_id: string }>;
  not_found: Array<{ job_id: string; image_id: string }>;
  failed: Array<{ job_id: string; image_id: string; message: string }>;
  requested: number;
  ok: number;
  limit: number;
};

type BatchCollectionMode = "NONE" | "EXISTING" | "AUTO_NEW" | "AUTO_BATCH";

type BatchSubmitMode = "IMMEDIATE" | "STAGGERED";

type BatchSection = {
  id: string;
  section_title: string;
  section_prompt: string;
  section_reference_images: File[];
  section_model: ModelId;
  section_aspect_ratio: AspectRatio;
  section_image_size: ImageSize;
  section_provider_id: string | null;
  section_temperature: number;
  section_job_count: number;
  collection_mode: BatchCollectionMode;
  collection_name: string;
  existing_session_ids: string[];
  inherit_previous_settings: boolean;
  enabled: boolean;
};

type PickerLayoutPreset = "SYNC_ZOOM" | "FREE_ZOOM";

type PickerItemRef = {
  job_id: string;
  image_id: string;
};

type PickerSessionItem = {
  item_key?: string;
  job_id: string;
  job_access_token?: string;
  image_id?: string;
  bucket?: PickerBucket;
  pool?: "FILMSTRIP" | "PREFERRED";
  label?: string;
  rating?: number;
  reviewed?: boolean;
  picked?: boolean;
  notes?: string;
  status?: JobStatus;
  added_at: string;
  show_count_total?: number;
  show_count_by_mode?: Partial<Record<PickerCompareMode, number>>;
  last_shown_at?: string | null;
  first_shown_at?: string | null;
  last_rated_at?: string | null;
  last_hard_action_at?: string | null;
  cooldown_until_turn?: number | null;
  arrival_seq?: number;
  arrival_turn?: number;
  last_status_changed_at?: string | null;
  just_completed_at?: string | null;
  just_completed_turn?: number | null;
  cluster_id?: string | null;
};

type PickerSession = {
  session_id: string;
  name: string;
  created_at: string;
  updated_at: string;
  archived?: boolean;
  pinned?: boolean;
  cover?: PickerItemRef;
  items: PickerSessionItem[];
  best_image?: PickerItemRef;
  compare_mode: PickerCompareMode;
  layout_preset: PickerLayoutPreset;
  ui: {
    background: "dark" | "light";
    showGrid: boolean;
    showInfo: boolean;
  };
  slots: Array<string | null>;
  focus_key?: string | null;
  scheduler: {
    turn: number;
    next_arrival_seq: number;
    recent_history: Record<PickerCompareMode, string[]>;
    last_mode: PickerScheduleMode;
    last_boundary_at?: string | null;
  };
};

// Back-end meta (best-effort typing; adapt if your API differs)

type ApiError = {
  error?: {
    code?: string;
    message?: string;
    details?: any;
  };
};

type UsageMeta = {
  total_token_count?: number;
  input_token_count?: number;
  output_token_count?: number;
  [k: string]: any;
};

type BillingMeta = {
  estimated_cost_usd?: number;
  image_output_cost_usd?: number;
  breakdown?: Record<string, number>;
  [k: string]: any;
};

type JobResultImage = {
  image_id: string;
  mime_type?: string;
  width?: number;
  height?: number;
};

type JobResult = {
  images?: JobResultImage[];
  [k: string]: any;
};

type JobError = {
  code?: string;
  type?: string;
  message?: string;
  debug_id?: string;
  details?: Record<string, any>;
  [k: string]: any;
};

type JobMeta = {
  job_id: string;
  model?: ModelId;
  mode?: JobMode;
  status?: JobStatus;
  created_at?: string;
  updated_at?: string;
  timing?: {
    queued_at?: string;
    started_at?: string;
    finished_at?: string;
    queue_wait_ms?: number;
    run_duration_ms?: number;
    upstream_latency_ms?: number;
    [k: string]: any;
  };
  params?: DefaultParams & Record<string, any>;
  usage?: UsageMeta;
  billing?: BillingMeta;
  result?: JobResult;
  error?: JobError;
  response?: { latency_ms?: number } & Record<string, any>;
  [k: string]: any;
};

type JobAccessRef = {
  job_id: string;
  job_access_token?: string;
};

type JobStatusSnapshot = {
  job_id: string;
  status?: JobStatus;
  model?: ModelId;
  updated_at?: string;
  timing?: JobMeta["timing"];
  error?: JobError | null;
  first_image_id?: string;
  image_count?: number;
};

type BatchMetaResponse = {
  items: Array<{ job_id: string; meta: JobMeta }>;
  forbidden: string[];
  not_found: string[];
  failed: Array<{ job_id: string; message: string }>;
  requested: number;
  ok: number;
};

type ActiveJobsResponse = {
  active: JobStatusSnapshot[];
  settled: JobStatusSnapshot[];
  forbidden: string[];
  not_found: string[];
  failed: Array<{ job_id: string; message: string }>;
  requested: number;
  active_count: number;
  settled_count: number;
};

type DashboardSummaryResponse = {
  stats: DashboardStat;
  updates: JobStatusSnapshot[];
  forbidden: string[];
  not_found: string[];
  failed: Array<{ job_id: string; message: string }>;
  requested: number;
  ok: number;
};

type ModelCapability = {
  model_id: ModelId;
  label: string;
  description: string;
  supports_text_output: boolean;
  supports_image_size: boolean;
  supports_thinking_level: boolean;
  supported_modes: JobMode[];
  supported_aspect_ratios: AspectRatio[];
  supported_image_sizes: ImageSize[];
  supported_thinking_levels: string[];
  default_params: DefaultParams;
};

type ModelsPayload = {
  default_model: ModelId;
  models: ModelCapability[];
};

type UserRole = "ADMIN" | "USER";

type UserPolicy = {
  daily_image_limit?: number | null;
  concurrent_jobs_limit: number;
  turnstile_job_count_threshold?: number | null;
  turnstile_daily_usage_threshold?: number | null;
  daily_image_access_limit?: number | null;
  image_access_turnstile_bonus_quota?: number | null;
  daily_image_access_hard_limit?: number | null;
};

type UserPolicyOverrides = {
  daily_image_limit?: number | null;
  concurrent_jobs_limit?: number | null;
  turnstile_job_count_threshold?: number | null;
  turnstile_daily_usage_threshold?: number | null;
  daily_image_access_limit?: number | null;
  image_access_turnstile_bonus_quota?: number | null;
  daily_image_access_hard_limit?: number | null;
};

type SessionUsage = {
  date: string;
  jobs_created_today: number;
  jobs_succeeded_today: number;
  jobs_failed_today: number;
  images_generated_today: number;
  quota_consumed_today: number;
  quota_resets_today: number;
  active_jobs: number;
  running_jobs?: number;
  queued_jobs?: number;
  remaining_images_today?: number | null;
  image_accesses_today?: number;
  image_access_bonus_quota_today?: number;
  image_access_limit_today?: number | null;
  image_access_hard_limit_today?: number | null;
};

type SessionUser = {
  user_id: string;
  username: string;
  role: UserRole;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  last_login_at?: string | null;
  policy: UserPolicy;
};

type AuthSession = {
  authenticated: true;
  user: SessionUser;
  usage: SessionUsage;
  generation_turnstile_verified_until?: string | null;
};

type SystemPolicy = {
  default_user_daily_image_limit: number;
  default_user_extra_daily_image_limit: number;
  default_user_concurrent_jobs_limit: number;
  default_admin_concurrent_jobs_limit: number;
  default_user_turnstile_job_count_threshold: number;
  default_user_turnstile_daily_usage_threshold: number;
  default_user_daily_image_access_limit: number;
  default_user_image_access_turnstile_bonus_quota: number;
  default_user_daily_image_access_hard_limit: number;
};

type AdminSystemOverview = {
  app_version: string;
  deployed_at: string;
  now: string;
  uptime_sec: number;
  queue_size: number;
  worker_count: number;
  users_total: number;
  users_enabled: number;
  jobs_total: number;
  queued_jobs: number;
  running_jobs: number;
  active_jobs: number;
  succeeded_today: number;
  failed_today: number;
  images_generated_today: number;
  image_accesses_today: number;
};

type AdminOverviewResponse = {
  system: AdminSystemOverview;
  policy: SystemPolicy;
  providers: ProviderSummary;
};

type ProviderCallSample = {
  ts: string;
  success: boolean;
  latency_ms: number;
  error_code?: string | null;
};

type ProviderSnapshot = {
  provider_id: string;
  label: string;
  adapter_type: string;
  base_url: string;
  enabled: boolean;
  note: string;
  supported_models: string[];
  cost_per_image_cny: number;
  remaining_balance_cny?: number | null;
  quota_state: string;
  quota_confidence: number;
  quota_score: number;
  success_count: number;
  fail_count: number;
  consecutive_failures: number;
  last_fail_reason?: string | null;
  last_success_time?: string | null;
  last_fail_time?: string | null;
  cooldown_until?: string | null;
  cooldown_active: boolean;
  circuit_open_count: number;
  last_circuit_open_time?: string | null;
  last_circuit_open_reason?: string | null;
  last_circuit_open_until?: string | null;
  last_circuit_open_duration_sec?: number | null;
  forced_activation_count: number;
  last_forced_activation_time?: string | null;
  last_forced_activation_reason?: string | null;
  last_forced_activation_mode?: string | null;
  success_rate_estimated: number;
  recent_success_rate: number;
  final_success_rate: number;
  health_score: number;
  effective_cost: number;
  active_requests: number;
  max_concurrency: number;
  latency_p50_ms?: number | null;
  latency_p95_ms?: number | null;
  timeout_rate: number;
  total_spent_cny: number;
  total_generated_images: number;
  balance_updated_at?: string | null;
  last_selected_time?: string | null;
  recent_calls: ProviderCallSample[];
};

type ProviderSummary = {
  currency: string;
  providers_total: number;
  providers_enabled: number;
  providers_healthy: number;
  providers_cooldown: number;
  remaining_balance_cny: number;
  spent_cny: number;
  last_updated_at?: string;
  providers: ProviderSnapshot[];
};

type AdminUserItem = {
  user_id: string;
  username: string;
  role: UserRole;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  last_login_at?: string | null;
  policy: UserPolicy;
  policy_overrides?: UserPolicyOverrides;
  usage: SessionUsage;
  total_jobs: number;
};

type AdminUserJobSummary = {
  job_id: string;
  created_at: string;
  updated_at?: string | null;
  status: JobStatus;
  model?: ModelId;
  prompt_preview?: string;
  batch_id?: string | null;
  batch_name?: string | null;
  batch_note?: string | null;
  batch_size?: number | null;
  batch_index?: number | null;
  section_index?: number | null;
  section_title?: string | null;
  timing?: JobMeta["timing"];
  error?: {
    code?: string | null;
    message?: string | null;
  } | null;
  first_image_id?: string | null;
  image_count?: number;
  owner?: {
    user_id?: string | null;
    username?: string | null;
    role?: UserRole | null;
  };
};

type AdminUserJobsStats = {
  total: number;
  active: number;
  running: number;
  queued: number;
  succeeded: number;
  failed: number;
  cancelled: number;
};

type AdminUserJobsResponse = {
  user: {
    user_id: string;
    username: string;
    role: UserRole;
    enabled: boolean;
  };
  items: AdminUserJobSummary[];
  next_cursor?: string | null;
  stats: AdminUserJobsStats;
  requested_limit: number;
};

declare global {
  interface Window {
    __NBP_RUNTIME_CONFIG__?: {
      apiBaseUrl?: string;
      turnstileSiteKey?: string;
    };
    turnstile?: {
      render: (container: HTMLElement, options: Record<string, any>) => string | number;
      remove?: (widgetId: string | number) => void;
    };
  }
}

// -----------------------------
// Storage keys
// -----------------------------

const KEY_SETTINGS = "nbp_settings_v1";
const KEY_JOBS = "nbp_jobs_by_user_v2";
const KEY_JOBS_LEGACY = "nbp_jobs_v1";
const KEY_DASH_CACHE = "nbp_dashboard_cache_v1";
const KEY_PICKER_SESSIONS = "nbp_picker_sessions_v1";
const KEY_PICKER_RECENT = "nbp_picker_recent_v1";
const KEY_PICKER_SIDEBAR_PREF = "nbp_picker_sidebar_pref_v1";
const KEY_HISTORY_AUTO_REFRESH_PREF = "nbp_history_auto_refresh_pref_v1";
const KEY_CREATE_CLONE_DRAFT = "nbp_create_clone_draft_v1";
const KEY_CREATE_PAGE_DRAFT = "nbp_create_page_draft_v1";
const KEY_BATCH_PAGE_DRAFT = "nbp_batch_page_draft_v1";
const IMAGE_CACHE_DB = "nbp_image_cache_v1";
const IMAGE_CACHE_STORE = "images";
const DRAFT_BLOB_BASE_URL = "__draft__";
const DRAFT_CACHE_CONFIG = {
  enabled: true,
  ttlDays: 30,
  maxBytes: 512 * 1024 * 1024,
} satisfies SettingsV1["cache"];

// -----------------------------
// Utils
// -----------------------------

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function safeJsonParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function storageGet(key: string) {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string) {
  if (typeof window === "undefined") return false;
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function storageRemove(key: string) {
  if (typeof window === "undefined") return false;
  try {
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function loadJobsBag() {
  const bag = safeJsonParse<Record<string, JobRecord[]>>(storageGet(KEY_JOBS), {});
  if (bag && typeof bag === "object" && !Array.isArray(bag)) return bag;
  const legacy = safeJsonParse<JobRecord[]>(storageGet(KEY_JOBS_LEGACY), []);
  if (Array.isArray(legacy) && legacy.length) {
    const migrated = { __legacy__: legacy };
    storageSet(KEY_JOBS, JSON.stringify(migrated));
    storageRemove(KEY_JOBS_LEGACY);
    return migrated;
  }
  return {};
}

function saveJobsBag(bag: Record<string, JobRecord[]>) {
  storageSet(KEY_JOBS, JSON.stringify(bag));
}

function isoNow() {
  return new Date().toISOString();
}

function isSameDayISO(aISO: string, bISO: string) {
  const a = new Date(aISO);
  const b = new Date(bISO);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function daysAgoISO(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function formatLocal(ts?: string) {
  if (!ts) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

function providerSupportsModel(provider: ProviderSnapshot, modelId: string) {
  return provider.supported_models.includes(modelId);
}

function providerOptionLabel(provider: ProviderSnapshot) {
  const tags: string[] = [];
  if (!provider.enabled) tags.push("disabled");
  if (provider.cooldown_active) tags.push("cooldown");
  if (provider.quota_state === "NO_QUOTA") tags.push("no quota");
  return `${provider.label} (${provider.provider_id})${tags.length ? ` · ${tags.join(", ")}` : ""}`;
}

function providerSelectOptions(providers: ProviderSnapshot[], modelId: string) {
  return [
    { value: AUTO_PROVIDER_VALUE, label: "Auto Select" },
    ...providers
      .filter((provider) => providerSupportsModel(provider, modelId))
      .map((provider) => ({
        value: provider.provider_id,
        label: providerOptionLabel(provider),
      })),
  ];
}

const EMPTY_PROVIDER_LIST: ProviderSnapshot[] = [];
const EMPTY_REFERENCE_LIST: Array<{ filename?: string | null }> = [];

function shortId(id: string, keep = 8) {
  if (!id) return "";
  if (id.length <= keep * 2) return id;
  return `${id.slice(0, keep)}…${id.slice(-keep)}`;
}

function currency(n?: number) {
  if (n === undefined || n === null || Number.isNaN(n)) return "-";
  return `$${n.toFixed(4)}`;
}

function numberish(n?: number) {
  if (n === undefined || n === null || Number.isNaN(n)) return "-";
  if (Math.abs(n) >= 1000) return n.toLocaleString();
  return String(n);
}

function formatDurationMs(ms?: number | null) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s}s`;
}

function formatLatencyAdaptive(ms?: number | null) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec >= 10 ? sec.toFixed(1) : sec.toFixed(2)}s`;
  const min = sec / 60;
  return `${min >= 10 ? min.toFixed(1) : min.toFixed(2)}min`;
}

function createBatchId() {
  return `batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

type CreateCloneDraft = {
  prompt: string;
  model: ModelId;
  mode: JobMode;
  params: Partial<DefaultParams>;
};

type PersistedDraftFileMeta = {
  id: string;
  name: string;
  type: string;
  size: number;
  lastModified: number;
};

type CreatePageDraft = {
  scope: string;
  prompt: string;
  model: ModelId;
  mode: CreateMode;
  sessionSearch: string;
  newSessionName: string;
  boundSessionIds: string[];
  aspect: AspectRatio;
  size: ImageSize;
  thinkingLevel: string | null;
  providerId: string | null;
  temperature: number;
  timeoutSec: number;
  maxRetries: number;
  jobCount: number;
  files: PersistedDraftFileMeta[];
  updated_at: string;
};

type BatchSectionDraftPersisted = {
  id: string;
  section_title: string;
  section_prompt: string;
  section_model: ModelId;
  section_aspect_ratio: AspectRatio;
  section_image_size: ImageSize;
  section_provider_id: string | null;
  section_temperature: number;
  section_job_count: number;
  collection_mode: BatchCollectionMode;
  collection_name: string;
  existing_session_ids: string[];
  inherit_previous_settings: boolean;
  enabled: boolean;
  section_reference_images: PersistedDraftFileMeta[];
};

type BatchPageDraft = {
  scope: string;
  batchName: string;
  batchNote: string;
  defaultCollectionStrategy: BatchCollectionMode;
  submitMode: BatchSubmitMode;
  globalPrompt: string;
  globalFiles: PersistedDraftFileMeta[];
  globalModel: ModelId;
  globalAspect: AspectRatio;
  globalSize: ImageSize;
  globalProviderId: string | null;
  globalTemperature: number;
  globalJobCount: number;
  namingTemplate: string;
  submitEnabledOnly: boolean;
  submitStartFrom: string;
  autoInjectPageNo: boolean;
  removeFailedFromSession: boolean;
  selectedSectionIds: string[];
  sections: BatchSectionDraftPersisted[];
  updated_at: string;
};

type DraftFileEntry = {
  namespace: string;
  meta: PersistedDraftFileMeta;
};

function createDraftId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const BATCH_NAME_TEMPLATE_DEFAULT = "{{batch_name}}-P{{page_no}}-{{section_title}}";

const BATCH_COLLECTION_MODE_OPTIONS: Array<{ value: BatchCollectionMode; label: string }> = [
  { value: "AUTO_BATCH", label: "Auto New Session (Batch Named)" },
  { value: "AUTO_NEW", label: "Auto New Session" },
  { value: "EXISTING", label: "Existing Session" },
  { value: "NONE", label: "No Session" },
];

const BATCH_SUBMIT_MODE_OPTIONS: Array<{ value: BatchSubmitMode; label: string }> = [
  { value: "IMMEDIATE", label: "Queue All Now" },
  { value: "STAGGERED", label: "Queue Per Section" },
];

const AUTO_PROVIDER_VALUE = "__AUTO_PROVIDER__";

function renderTemplate(
  template: string,
  vars: {
    batch_name: string;
    page_no: string;
    section_title: string;
  }
) {
  const safeTitle = vars.section_title.trim() || "untitled";
  return (template || "")
    .replace(/\{\{\s*batch_name\s*\}\}/gi, vars.batch_name.trim() || "batch")
    .replace(/\{\{\s*page_no\s*\}\}/gi, vars.page_no)
    .replace(/\{\{\s*section_title\s*\}\}/gi, safeTitle);
}

function estimateBatchUnitCost(model: ModelId, size: ImageSize) {
  const normalizedModel = String(model || "").toLowerCase();
  const normalizedSize = String(size || "AUTO").toUpperCase();
  const modelBase = normalizedModel.includes("3-pro")
    ? 0.065
    : normalizedModel.includes("3.1-flash-image-preview")
      ? 0.035
      : normalizedModel.includes("2.5-flash-image")
        ? 0.028
        : 0.032;
  const sizeFactor =
    normalizedSize === "512"
      ? 0.7
      : normalizedSize === "2K"
        ? 1.5
        : normalizedSize === "4K"
          ? 2.2
          : 1;
  return modelBase * sizeFactor;
}

function batchPromptPreview(
  globalPrompt: string,
  sectionPrompt: string,
  vars: {
    batch_name: string;
    page_no: string;
    section_title: string;
  },
  autoInjectPageNo: boolean
) {
  const parts = [
    renderTemplate(sectionPrompt, vars).trim(),
    renderTemplate(globalPrompt, vars).trim(),
    autoInjectPageNo ? `Page number: ${vars.page_no}` : "",
  ].filter(Boolean);
  return parts.join("\n\n");
}

function extractRunDurationMs(meta?: JobMeta | null, rec?: JobRecord | null) {
  const fromMeta = meta?.timing?.run_duration_ms;
  if (typeof fromMeta === "number" && Number.isFinite(fromMeta) && fromMeta >= 0) return fromMeta;
  const fromRec = rec?.run_duration_ms;
  if (typeof fromRec === "number" && Number.isFinite(fromRec) && fromRec >= 0) return fromRec;
  const latency = meta?.response?.latency_ms;
  if (typeof latency === "number" && Number.isFinite(latency) && latency >= 0) return latency;
  return undefined;
}

function jobTimingPatch(meta?: JobMeta | null): Partial<JobRecord> {
  if (!meta) return {};
  const t = meta.timing;
  const patch: Partial<JobRecord> = {};
  if (typeof t?.started_at === "string" && t.started_at) patch.run_started_at = t.started_at;
  if (typeof t?.finished_at === "string" && t.finished_at) patch.run_finished_at = t.finished_at;
  if (typeof t?.queue_wait_ms === "number" && Number.isFinite(t.queue_wait_ms) && t.queue_wait_ms >= 0) {
    patch.queue_wait_ms = t.queue_wait_ms;
  }
  const runDuration = extractRunDurationMs(meta, null);
  if (typeof runDuration === "number") patch.run_duration_ms = runDuration;
  return patch;
}

function jobMetaCachePatch(meta?: JobMeta | null): Partial<JobRecord> {
  if (!meta) return {};
  const imageIds = extractImageIdsFromResult(meta.result);
  return {
    model_cache: (meta.model as ModelId) || undefined,
    status_cache: (meta.status || "UNKNOWN") as JobStatus,
    params_cache: meta.params ? { ...meta.params } : undefined,
    first_image_id: imageIds[0],
    image_count_cache: imageIds.length,
    error_code_cache: meta.error?.code,
    error_message_cache: meta.error?.message,
    ...jobTimingPatch(meta),
  };
}

function computeFakeProgressPercent(job: JobRecord, nowMs: number, avgDurationMs: number) {
  const status = job.status_cache || "UNKNOWN";
  if (status === "SUCCEEDED") return 100;
  const duration = typeof job.run_duration_ms === "number" && Number.isFinite(job.run_duration_ms) ? job.run_duration_ms : null;
  if (status === "FAILED") {
    if (duration === null) return 0;
    const pct = Math.floor((duration / Math.max(1, avgDurationMs)) * 99);
    return clamp(pct, 1, 99);
  }
  if (status === "QUEUED") return 0;
  if (status !== "RUNNING") return null;

  const startedAtMs = job.run_started_at ? new Date(job.run_started_at).getTime() : NaN;
  if (!Number.isFinite(startedAtMs)) return 1;
  const elapsed = Math.max(0, nowMs - startedAtMs);
  const pct = Math.floor((elapsed / Math.max(1, avgDurationMs)) * 99);
  return clamp(pct, 1, 99);
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function formatBytes(bytes?: number | null) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[idx]}`;
}

function base64ToBlob(base64: string, mime: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

type CachedImageRecord = {
  key: string;
  scope: string;
  job_id: string;
  image_id: string;
  variant: ImageVariant;
  mime: string;
  size: number;
  created_at: number;
  last_accessed_at: number;
  expires_at: number;
  blob: Blob;
};

type ImageCacheStats = {
  count: number;
  size: number;
};

let imageCacheDbPromise: Promise<IDBDatabase> | null = null;

function openImageCacheDb() {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB unavailable"));
  }
  if (!imageCacheDbPromise) {
    imageCacheDbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(IMAGE_CACHE_DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IMAGE_CACHE_STORE)) {
          const store = db.createObjectStore(IMAGE_CACHE_STORE, { keyPath: "key" });
          store.createIndex("scope", "scope", { unique: false });
          store.createIndex("expires_at", "expires_at", { unique: false });
          store.createIndex("last_accessed_at", "last_accessed_at", { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("Failed to open image cache"));
    });
  }
  return imageCacheDbPromise;
}

function imageCacheKey(scope: string, baseUrl: string, jobId: string, imageId: string, variant: ImageVariant) {
  return `${scope}::${baseUrl.replace(/\/$/, "")}::${jobId}::${imageId}::${variant}`;
}

function imageCacheRecordScope(scope: string) {
  return scope || "__guest__";
}

function imageCacheGet(
  scope: string,
  baseUrl: string,
  jobId: string,
  imageId: string,
  variant: ImageVariant
): Promise<Blob | null> {
  const normalizedScope = imageCacheRecordScope(scope);
  return openImageCacheDb()
    .then(
      (db) =>
        new Promise<Blob | null>((resolve, reject) => {
          const tx = db.transaction(IMAGE_CACHE_STORE, "readwrite");
          const store = tx.objectStore(IMAGE_CACHE_STORE);
          const key = imageCacheKey(normalizedScope, baseUrl, jobId, imageId, variant);
          const req = store.get(key);
          req.onsuccess = () => {
            const row = req.result as CachedImageRecord | undefined;
            if (!row || row.expires_at <= Date.now()) {
              if (row) store.delete(key);
              resolve(null);
              return;
            }
            row.last_accessed_at = Date.now();
            store.put(row);
            resolve(row.blob);
          };
          req.onerror = () => reject(req.error || new Error("Failed to read image cache"));
        })
    )
    .catch(() => null);
}

async function imageCacheStats(scope: string): Promise<ImageCacheStats> {
  try {
    const db = await openImageCacheDb();
    return await new Promise<ImageCacheStats>((resolve, reject) => {
      const tx = db.transaction(IMAGE_CACHE_STORE, "readonly");
      const store = tx.objectStore(IMAGE_CACHE_STORE);
      const index = store.index("scope");
      const req = index.getAll(IDBKeyRange.only(imageCacheRecordScope(scope)));
      req.onsuccess = () => {
        const rows = (req.result as CachedImageRecord[]) || [];
        resolve({
          count: rows.length,
          size: rows.reduce((sum, row) => sum + (row.size || 0), 0),
        });
      };
      req.onerror = () => reject(req.error || new Error("Failed to read cache stats"));
    });
  } catch {
    return { count: 0, size: 0 };
  }
}

async function imageCacheTrim(scope: string, ttlDays: number, maxBytes: number) {
  try {
    const db = await openImageCacheDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IMAGE_CACHE_STORE, "readwrite");
      const store = tx.objectStore(IMAGE_CACHE_STORE);
      const index = store.index("scope");
      const req = index.getAll(IDBKeyRange.only(imageCacheRecordScope(scope)));
      req.onsuccess = () => {
        const now = Date.now();
        const minCreatedAt = now - ttlDays * 24 * 3600 * 1000;
        const rows = ((req.result as CachedImageRecord[]) || []).sort((a, b) => a.last_accessed_at - b.last_accessed_at);
        rows
          .filter((row) => row.expires_at <= now || row.created_at < minCreatedAt)
          .forEach((row) => store.delete(row.key));
        const kept = rows.filter((row) => row.expires_at > now && row.created_at >= minCreatedAt);
        let total = kept.reduce((sum, row) => sum + (row.size || 0), 0);
        for (const row of kept) {
          if (total <= maxBytes) break;
          store.delete(row.key);
          total -= row.size || 0;
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Failed to trim image cache"));
      tx.onabort = () => reject(tx.error || new Error("Failed to trim image cache"));
    });
  } catch {
    // ignore
  }
}

async function imageCachePut(
  scope: string,
  baseUrl: string,
  jobId: string,
  imageId: string,
  variant: ImageVariant,
  blob: Blob,
  config: SettingsV1["cache"]
) {
  if (!config.enabled) return;
  const normalizedScope = imageCacheRecordScope(scope);
  const now = Date.now();
  const record: CachedImageRecord = {
    key: imageCacheKey(normalizedScope, baseUrl, jobId, imageId, variant),
    scope: normalizedScope,
    job_id: jobId,
    image_id: imageId,
    variant,
    mime: blob.type || "application/octet-stream",
    size: blob.size || 0,
    created_at: now,
    last_accessed_at: now,
    expires_at: now + config.ttlDays * 24 * 3600 * 1000,
    blob,
  };
  try {
    const db = await openImageCacheDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IMAGE_CACHE_STORE, "readwrite");
      tx.objectStore(IMAGE_CACHE_STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Failed to write image cache"));
      tx.onabort = () => reject(tx.error || new Error("Failed to write image cache"));
    });
  } catch {
    // ignore write errors
  }
  await imageCacheTrim(normalizedScope, config.ttlDays, config.maxBytes);
}

async function imageCacheClear(scope?: string) {
  try {
    const db = await openImageCacheDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IMAGE_CACHE_STORE, "readwrite");
      const store = tx.objectStore(IMAGE_CACHE_STORE);
      if (!scope) {
        store.clear();
      } else {
        const index = store.index("scope");
        const req = index.getAllKeys(IDBKeyRange.only(imageCacheRecordScope(scope)));
        req.onsuccess = () => {
          for (const key of req.result as IDBValidKey[]) store.delete(key);
        };
        req.onerror = () => reject(req.error || new Error("Failed to clear image cache"));
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Failed to clear image cache"));
      tx.onabort = () => reject(tx.error || new Error("Failed to clear image cache"));
    });
  } catch {
    // ignore
  }
}

type SharedPreviewState = {
  key: string;
  scope: string;
  baseUrl: string;
  job_id: string;
  image_id: string;
  loading: boolean;
  url?: string;
  error?: string;
  code?: string;
  updated_at: number;
};

type SharedPreviewTarget = {
  localKey: string;
  job_id: string;
  image_id: string;
  job_access_token?: string;
};

const sharedPreviewStore = new Map<string, SharedPreviewState>();
const sharedPreviewSubscribers = new Set<() => void>();
const sharedPreviewInflight = new Map<string, Promise<void>>();

function sharedPreviewResourceKey(scope: string, baseUrl: string, jobId: string, imageId: string) {
  return imageCacheKey(imageCacheRecordScope(scope), baseUrl, jobId, imageId, "preview");
}

function notifySharedPreviewSubscribers() {
  sharedPreviewSubscribers.forEach((listener) => listener());
}

function sharedPreviewSubscribe(listener: () => void) {
  sharedPreviewSubscribers.add(listener);
  return () => {
    sharedPreviewSubscribers.delete(listener);
  };
}

function sharedPreviewGet(scope: string, baseUrl: string, jobId: string, imageId: string) {
  return sharedPreviewStore.get(sharedPreviewResourceKey(scope, baseUrl, jobId, imageId));
}

function sharedPreviewSet(next: SharedPreviewState) {
  const previous = sharedPreviewStore.get(next.key);
  if (previous?.url && previous.url !== next.url) {
    URL.revokeObjectURL(previous.url);
  }
  sharedPreviewStore.set(next.key, next);
}

function sharedPreviewPatchMany(entries: SharedPreviewState[]) {
  if (!entries.length) return;
  entries.forEach((entry) => sharedPreviewSet(entry));
  notifySharedPreviewSubscribers();
}

function clearSharedPreviewMemory(scope?: string) {
  const normalizedScope = scope ? imageCacheRecordScope(scope) : null;
  let changed = false;
  Array.from(sharedPreviewStore.entries()).forEach(([key, entry]) => {
    if (normalizedScope && entry.scope !== normalizedScope) return;
    if (entry.url) URL.revokeObjectURL(entry.url);
    sharedPreviewStore.delete(key);
    sharedPreviewInflight.delete(key);
    changed = true;
  });
  if (changed) notifySharedPreviewSubscribers();
}

function sharedPreviewRemember(scope: string, baseUrl: string, jobId: string, imageId: string, blob: Blob) {
  const key = sharedPreviewResourceKey(scope, baseUrl, jobId, imageId);
  const existing = sharedPreviewStore.get(key);
  if (existing?.url) return existing.url;
  const next: SharedPreviewState = {
    key,
    scope: imageCacheRecordScope(scope),
    baseUrl,
    job_id: jobId,
    image_id: imageId,
    loading: false,
    url: URL.createObjectURL(blob),
    updated_at: Date.now(),
  };
  sharedPreviewSet(next);
  notifySharedPreviewSubscribers();
  return next.url as string;
}

async function readCachedImageOrFetch(args: {
  scope: string;
  baseUrl: string;
  jobId: string;
  imageId: string;
  variant: ImageVariant;
  config: SettingsV1["cache"];
  fetcher: () => Promise<Blob>;
}) {
  if (args.config.enabled) {
    const cached = await imageCacheGet(args.scope, args.baseUrl, args.jobId, args.imageId, args.variant);
    if (cached) return { blob: cached, fromCache: true };
  }
  const blob = await args.fetcher();
  if (args.config.enabled) {
    await imageCachePut(args.scope, args.baseUrl, args.jobId, args.imageId, args.variant, blob, args.config);
  }
  return { blob, fromCache: false };
}

function pickStatus(meta?: JobMeta, rec?: JobRecord): JobStatus {
  return (meta?.status || rec?.status_cache || "UNKNOWN") as JobStatus;
}

function mean(arr: number[]) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function percentile(arr: number[], p: number) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  const w = idx - lo;
  return s[lo] * (1 - w) + s[hi] * w;
}

function toPreview(prompt: string, max = 80) {
  const t = (prompt || "").trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  return t.slice(0, max) + "…";
}

function pickerPendingItemKey(job_id: string) {
  return `${job_id}::__pending__`;
}

function pickerItemKey(item: { job_id: string; image_id?: string; item_key?: string }) {
  if (item.item_key) return item.item_key;
  if (item.image_id) return `${item.job_id}::${item.image_id}`;
  return pickerPendingItemKey(item.job_id);
}

function pickerItemKeyFrom(job_id: string, image_id: string) {
  return `${job_id}::${image_id}`;
}

function pickerItemHasImage(item?: { image_id?: string | null } | null): item is { image_id: string } {
  return Boolean(item?.image_id);
}

function pickerItemRefFromKey(key?: string | null): PickerItemRef | undefined {
  if (!key || !key.includes("::")) return undefined;
  const [job_id, image_id] = key.split("::");
  if (!job_id || !image_id || image_id === "__pending__") return undefined;
  return { job_id, image_id };
}

function isActiveJobStatus(status?: string) {
  return status === "RUNNING" || status === "QUEUED";
}

function extractImageIdsFromResult(result?: JobResult | Record<string, any> | null) {
  const r: any = result;
  if (!r) return [] as string[];
  if (Array.isArray(r.images)) {
    const a: any[] = r.images;
    if (!a.length) return [] as string[];
    if (typeof a[0] === "string") return a.filter((x) => typeof x === "string" && x.length);
    if (typeof a[0] === "object" && a[0]) {
      return a
        .map((x: any) => x.image_id || x.id || x.imageId)
        .filter((x: any) => typeof x === "string" && x.length);
    }
  }
  if (Array.isArray(r.image_ids)) return r.image_ids.filter((x: any) => typeof x === "string" && x.length);
  if (Array.isArray(r.imageIds)) return r.imageIds.filter((x: any) => typeof x === "string" && x.length);
  return [] as string[];
}

function formatCompactLocalTime(ts?: string) {
  if (!ts) return "unknown-time";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "unknown-time";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${y}${m}${day}-${h}${min}${s}`;
}

function pickerDisplayName(item: PickerSessionItem, rec?: JobRecord) {
  const base = shortId(item.job_id, 5).replace("…", "-");
  const t = formatCompactLocalTime(rec?.created_at || item.added_at);
  return `${base}-${t}`;
}

function pickerItemJobStatus(item: PickerSessionItem, rec?: JobRecord): JobStatus {
  return (rec?.status_cache || item.status || (pickerItemHasImage(item) ? "SUCCEEDED" : "UNKNOWN")) as JobStatus;
}

function extractErrorSummary(meta?: JobMeta | null, rec?: JobRecord | null) {
  return meta?.error?.message || rec?.error_message_cache || "";
}

function extractErrorCode(meta?: JobMeta | null, rec?: JobRecord | null) {
  return meta?.error?.code || rec?.error_code_cache || "";
}

function extractFirstImageId(meta?: JobMeta | null, rec?: JobRecord | null) {
  const fromMeta = extractImageIdsFromResult(meta?.result)[0];
  if (fromMeta) return fromMeta;
  return rec?.first_image_id;
}

function summarizeQueueOrFailure(meta?: JobMeta | null, rec?: JobRecord | null) {
  const status = pickStatus(meta || undefined, rec || undefined);
  if (status === "FAILED") return extractErrorSummary(meta, rec) || "任务失败";
  if (status === "CANCELLED") return extractErrorSummary(meta, rec) || "任务已取消";
  if (status === "QUEUED") {
    const queueWait = meta?.timing?.queue_wait_ms ?? rec?.queue_wait_ms;
    return typeof queueWait === "number" ? `排队中，已等待 ${formatDurationMs(queueWait)}` : "队列中，等待空闲 worker";
  }
  if (status === "RUNNING") return "图像生成中";
  return "";
}

function saveCreateCloneDraft(draft: CreateCloneDraft) {
  storageSet(KEY_CREATE_CLONE_DRAFT, JSON.stringify(draft));
}

function loadCreateCloneDraft(): CreateCloneDraft | null {
  return safeJsonParse<CreateCloneDraft | null>(storageGet(KEY_CREATE_CLONE_DRAFT), null);
}

function clearCreateCloneDraft() {
  storageRemove(KEY_CREATE_CLONE_DRAFT);
}

function draftBlobScope(scope: string) {
  return `draft:${scope || "__guest__"}`;
}

function draftBlobJobId(draftKey: string, namespace: string) {
  return `${draftKey}:${namespace}`;
}

function persistedDraftFileId(file: Pick<File, "name" | "size" | "type" | "lastModified">) {
  return `${file.name}::${file.size}::${file.type || "application/octet-stream"}::${file.lastModified}`;
}

function toPersistedDraftFileMeta(file: File): PersistedDraftFileMeta {
  return {
    id: persistedDraftFileId(file),
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    lastModified: file.lastModified || Date.now(),
  };
}

async function imageCacheDelete(scope: string, baseUrl: string, jobId: string, imageId: string, variant: ImageVariant) {
  try {
    const db = await openImageCacheDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IMAGE_CACHE_STORE, "readwrite");
      tx.objectStore(IMAGE_CACHE_STORE).delete(imageCacheKey(imageCacheRecordScope(scope), baseUrl, jobId, imageId, variant));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Failed to delete image cache entry"));
      tx.onabort = () => reject(tx.error || new Error("Failed to delete image cache entry"));
    });
  } catch {
    // ignore
  }
}

async function putDraftFileBlob(scope: string, draftKey: string, namespace: string, file: File, meta: PersistedDraftFileMeta) {
  await imageCachePut(
    draftBlobScope(scope),
    DRAFT_BLOB_BASE_URL,
    draftBlobJobId(draftKey, namespace),
    meta.id,
    "original",
    file,
    DRAFT_CACHE_CONFIG
  );
}

async function deleteDraftFileBlob(scope: string, draftKey: string, namespace: string, meta: PersistedDraftFileMeta) {
  await imageCacheDelete(
    draftBlobScope(scope),
    DRAFT_BLOB_BASE_URL,
    draftBlobJobId(draftKey, namespace),
    meta.id,
    "original"
  );
}

async function restoreDraftFiles(scope: string, draftKey: string, namespace: string, metas: PersistedDraftFileMeta[]) {
  const files = await Promise.all(
    (metas || []).map(async (meta) => {
      const blob = await imageCacheGet(
        draftBlobScope(scope),
        DRAFT_BLOB_BASE_URL,
        draftBlobJobId(draftKey, namespace),
        meta.id,
        "original"
      );
      if (!blob) return null;
      return new File([blob], meta.name, {
        type: meta.type || blob.type || "application/octet-stream",
        lastModified: meta.lastModified || Date.now(),
      });
    })
  );
  return files.filter((file): file is File => Boolean(file));
}

function saveCreatePageDraft(draft: CreatePageDraft) {
  storageSet(KEY_CREATE_PAGE_DRAFT, JSON.stringify(draft));
}

function loadCreatePageDraft(): CreatePageDraft | null {
  return safeJsonParse<CreatePageDraft | null>(storageGet(KEY_CREATE_PAGE_DRAFT), null);
}

function clearCreatePageDraft() {
  storageRemove(KEY_CREATE_PAGE_DRAFT);
}

function saveBatchPageDraft(draft: BatchPageDraft) {
  storageSet(KEY_BATCH_PAGE_DRAFT, JSON.stringify(draft));
}

function loadBatchPageDraft(): BatchPageDraft | null {
  return safeJsonParse<BatchPageDraft | null>(storageGet(KEY_BATCH_PAGE_DRAFT), null);
}

function clearBatchPageDraft() {
  storageRemove(KEY_BATCH_PAGE_DRAFT);
}

function invalidatePickerEntriesForDeletedJob(jobId: string) {
  const picker = usePickerStore.getState();
  const affected = picker.sessions.filter((session) => session.items.some((item) => item.job_id === jobId));
  affected.forEach((session) => {
    picker.patchSession(session.session_id, (current) => ({
      ...current,
      items: current.items.map((item) =>
        item.job_id === jobId
          ? {
              ...item,
              status: "FAILED",
              notes: "源任务已删除，条目将自动清理",
            }
          : item
      ),
    }));
  });
  window.setTimeout(() => {
    const latest = usePickerStore.getState();
    latest.sessions
      .filter((session) => session.items.some((item) => item.job_id === jobId))
      .forEach((session) => {
        session.items
          .filter((item) => item.job_id === jobId)
          .forEach((item) => latest.removeItem(session.session_id, pickerItemKey(item)));
      });
  }, 900);
}

function getPickerSessionCounts(session: PickerSession) {
  return session.items.reduce(
    (acc, item) => {
      const bucket = pickerBucketOf(item);
      if (bucket === "DELETED") {
        return acc;
      }
      if (bucket === "PREFERRED") {
        acc.preferred += 1;
      } else {
        acc.filmstrip += 1;
      }
      return acc;
    },
    { filmstrip: 0, preferred: 0 }
  );
}

async function blobToDataURL(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

const ADMIN_USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,32}$/;

function toValidationFieldLabel(path: string) {
  switch (path) {
    case "username":
      return "用户名";
    case "password":
      return "密码";
    case "role":
      return "角色";
    case "enabled":
      return "启用状态";
    case "policy_overrides.daily_image_limit":
      return "daily_image_limit";
    case "policy_overrides.concurrent_jobs_limit":
      return "concurrent_jobs_limit";
    case "policy_overrides.turnstile_job_count_threshold":
      return "turnstile_job_count_threshold";
    case "policy_overrides.turnstile_daily_usage_threshold":
      return "turnstile_daily_usage_threshold";
    case "policy_overrides.daily_image_access_limit":
      return "daily_image_access_limit";
    case "policy_overrides.image_access_turnstile_bonus_quota":
      return "image_access_turnstile_bonus_quota";
    case "policy_overrides.daily_image_access_hard_limit":
      return "daily_image_access_hard_limit";
    default:
      return path || "字段";
  }
}

function formatValidationIssues(details: any) {
  const issues = Array.isArray(details?.issues) ? details.issues : [];
  if (!issues.length) return null;
  const messages = issues
    .map((issue: any) => {
      const path = Array.isArray(issue?.loc)
        ? issue.loc.filter((part: unknown) => part !== "body").map(String).join(".")
        : "";
      const label = toValidationFieldLabel(path);
      const message = String(issue?.msg || issue?.message || "输入不合法");
      return `${label}: ${message}`;
    })
    .filter(Boolean);
  return messages.length ? messages.join("；") : null;
}

function getApiErrorMessage(error: any, fallback: string) {
  const validationMessage = formatValidationIssues(error?.error?.details);
  if (validationMessage) return validationMessage;
  return error?.error?.message || fallback;
}

// concurrency-limited map
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let idx = 0;
  const workers = new Array(Math.max(1, limit)).fill(0).map(async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) break;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function useOnlineStatus() {
  const [online, setOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// -----------------------------
// Default settings
// -----------------------------

const ENV_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").trim();
const RUNTIME_BASE_URL =
  typeof window !== "undefined" ? (window.__NBP_RUNTIME_CONFIG__?.apiBaseUrl || "").trim() : "";
const RUNTIME_TURNSTILE_SITE_KEY =
  typeof window !== "undefined" ? (window.__NBP_RUNTIME_CONFIG__?.turnstileSiteKey || "").trim() : "";
const TURNSTILE_SITE_KEY = (
  RUNTIME_TURNSTILE_SITE_KEY ||
  import.meta.env.VITE_TURNSTILE_SITE_KEY ||
  "0x4AAAAAACoBxRJwxj2oUZDc"
).trim();
const FALLBACK_BASE_URL =
  typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.hostname}:8000`
    : "http://127.0.0.1:8000";

const DEFAULT_PARAMS_TEMPLATE: DefaultParams = {
  aspect_ratio: "1:1",
  image_size: "1K",
  thinking_level: null,
  provider_id: null,
  temperature: 1,
  timeout_sec: 400,
  max_retries: 0,
};

const DEFAULT_SETTINGS: SettingsV1 = {
  baseUrl: RUNTIME_BASE_URL || ENV_BASE_URL || FALLBACK_BASE_URL,
  defaultModel: "gemini-3.1-flash-image-preview",
  jobAuthMode: "TOKEN",
  adminModeEnabled: false,
  adminKey: "",
  defaultParams: { ...DEFAULT_PARAMS_TEMPLATE },
  defaultParamsByModel: {
    "gemini-3-pro-image-preview": { ...DEFAULT_PARAMS_TEMPLATE },
  },
  ui: {
    theme: "system",
    language: "zh-CN",
    reduceMotion: false,
  },
  polling: {
    intervalMs: 1200,
    maxIntervalMs: 5000,
    concurrency: 5,
  },
  cache: {
    enabled: true,
    ttlDays: 3,
    maxBytes: 2 * 1024 * 1024 * 1024,
  },
  pickerScheduler: {
    moveCooldownTurns: 2,
    recentHistory: {
      ONE: 5,
      TWO: 8,
      FOUR: 12,
    },
    newArrivalBonus: 40,
    justCompletedBonus: 35,
    unseenBonus: 100,
    resolveUrgencyWeight: 30,
    polishRatingWeight: 12,
  },
};

const FALLBACK_MODEL_CATALOG: ModelsPayload = {
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
      supported_aspect_ratios: ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"],
      supported_image_sizes: ["512", "1K", "2K", "4K"],
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
      supported_aspect_ratios: ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"],
      supported_image_sizes: [],
      supported_thinking_levels: [],
      default_params: { aspect_ratio: "1:1", image_size: "AUTO", thinking_level: null, temperature: 1, timeout_sec: 400, max_retries: 0 },
    },
    {
      model_id: "gemini-3-pro-image-preview",
      label: "Nano Banana Pro",
      description: "Gemini 3 Pro Image Preview",
      supports_text_output: true,
      supports_image_size: true,
      supports_thinking_level: false,
      supported_modes: ["IMAGE_ONLY", "TEXT_AND_IMAGE"],
      supported_aspect_ratios: ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"],
      supported_image_sizes: ["1K", "2K", "4K"],
      supported_thinking_levels: [],
      default_params: { aspect_ratio: "1:1", image_size: "1K", thinking_level: null, temperature: 1, timeout_sec: 400, max_retries: 0 },
    },
  ],
};

function normalizeDefaultParams(raw: any): DefaultParams {
  return {
    ...DEFAULT_PARAMS_TEMPLATE,
    ...(raw || {}),
  };
}

function coerceSettings(raw: any): SettingsV1 {
  const base = {
    ...DEFAULT_SETTINGS,
    ...(raw || {}),
    defaultParams: normalizeDefaultParams((raw || {}).defaultParams),
    ui: { ...DEFAULT_SETTINGS.ui, ...((raw || {}).ui || {}) },
    polling: { ...DEFAULT_SETTINGS.polling, ...((raw || {}).polling || {}) },
    cache: { ...DEFAULT_SETTINGS.cache, ...((raw || {}).cache || {}) },
    pickerScheduler: {
      ...DEFAULT_SETTINGS.pickerScheduler,
      ...((raw || {}).pickerScheduler || {}),
      recentHistory: {
        ...DEFAULT_SETTINGS.pickerScheduler.recentHistory,
        ...(((raw || {}).pickerScheduler || {}).recentHistory || {}),
      },
    },
  } as SettingsV1;

  const rawByModel = (raw || {}).defaultParamsByModel;
  const defaultParamsByModel: Record<string, DefaultParams> = {};
  if (rawByModel && typeof rawByModel === "object") {
    for (const [modelId, params] of Object.entries(rawByModel as Record<string, any>)) {
      if (!modelId) continue;
      defaultParamsByModel[modelId] = normalizeDefaultParams(params);
    }
  }

  if (!defaultParamsByModel[base.defaultModel]) {
    defaultParamsByModel[base.defaultModel] = normalizeDefaultParams(base.defaultParams);
  }

  const effectiveDefaultParams = normalizeDefaultParams(defaultParamsByModel[base.defaultModel]);
  return {
    ...base,
    defaultParams: effectiveDefaultParams,
    defaultParamsByModel,
    cache: {
      enabled: Boolean(base.cache?.enabled ?? DEFAULT_SETTINGS.cache.enabled),
      ttlDays: clamp(Number(base.cache?.ttlDays || DEFAULT_SETTINGS.cache.ttlDays), 1, 30),
      maxBytes: clamp(
        Number(base.cache?.maxBytes || DEFAULT_SETTINGS.cache.maxBytes),
        128 * 1024 * 1024,
        8 * 1024 * 1024 * 1024
      ),
    },
  };
}

function getParamsForModel(settings: SettingsV1, modelId: ModelId, modelDefaults?: Partial<DefaultParams>): DefaultParams {
  return normalizeDefaultParams({
    ...DEFAULT_PARAMS_TEMPLATE,
    ...(modelDefaults || {}),
    ...(settings.defaultModel === modelId ? settings.defaultParams : {}),
    ...(settings.defaultParamsByModel?.[modelId] || {}),
  });
}

function createBatchSectionDraft(args: {
  fallbackModel: ModelId;
  settings: SettingsV1;
  defaultCollectionMode: BatchCollectionMode;
  previous?: BatchSection | null;
}): BatchSection {
  const source = args.previous || null;
  const sourceModel = source?.section_model || args.fallbackModel;
  const params = getParamsForModel(args.settings, sourceModel);
  return {
    id: createDraftId("sec"),
    section_title: "",
    section_prompt: "",
    section_reference_images: [],
    section_model: source?.section_model || args.fallbackModel,
    section_aspect_ratio: source?.section_aspect_ratio || params.aspect_ratio,
    section_image_size: source?.section_image_size || params.image_size,
    section_provider_id: source?.section_provider_id || params.provider_id || null,
    section_temperature: source?.section_temperature ?? params.temperature,
    section_job_count: source?.section_job_count || 1,
    collection_mode: source?.collection_mode || args.defaultCollectionMode,
    collection_name: "",
    existing_session_ids: [],
    inherit_previous_settings: false,
    enabled: true,
  };
}

// -----------------------------
// Zustand stores (persisted)
// -----------------------------

type SettingsStore = {
  settings: SettingsV1;
  setSettings: (patch: Partial<SettingsV1>) => void;
  updateDefaultParams: (model: ModelId, patch: Partial<DefaultParams>) => void;
  resetSettings: () => void;
};

const useSettingsStore = create<SettingsStore>((set, get) => {
  const persisted = safeJsonParse<any>(storageGet(KEY_SETTINGS), DEFAULT_SETTINGS);
  const merged = coerceSettings(persisted);
  storageSet(KEY_SETTINGS, JSON.stringify(merged));

  return {
    settings: merged,
    setSettings: (patch) => {
      const cur = get().settings;
      const next = coerceSettings({
        ...cur,
        ...patch,
        defaultParams: { ...cur.defaultParams, ...(patch as any).defaultParams },
        defaultParamsByModel: { ...cur.defaultParamsByModel, ...((patch as any).defaultParamsByModel || {}) },
        ui: { ...cur.ui, ...(patch as any).ui },
        polling: { ...cur.polling, ...(patch as any).polling },
        cache: { ...cur.cache, ...(patch as any).cache },
      });
      storageSet(KEY_SETTINGS, JSON.stringify(next));
      set({ settings: next });
    },
    updateDefaultParams: (model, patch) => {
      const cur = get().settings;
      const currentModelParams = getParamsForModel(cur, model);
      const nextModelParams = normalizeDefaultParams({ ...currentModelParams, ...patch });
      const next = coerceSettings({
        ...cur,
        defaultParamsByModel: {
          ...cur.defaultParamsByModel,
          [model]: nextModelParams,
        },
        defaultParams: cur.defaultModel === model ? nextModelParams : cur.defaultParams,
      });
      storageSet(KEY_SETTINGS, JSON.stringify(next));
      set({ settings: next });
    },
    resetSettings: () => {
      const next = coerceSettings(DEFAULT_SETTINGS);
      storageSet(KEY_SETTINGS, JSON.stringify(next));
      set({ settings: next });
    },
  };
});

type AuthStore = {
  loading: boolean;
  session: AuthSession | null;
  setLoading: (loading: boolean) => void;
  setSession: (session: AuthSession | null) => void;
  clearSession: () => void;
};

const useAuthStore = create<AuthStore>((set) => ({
  loading: true,
  session: null,
  setLoading: (loading) => set({ loading }),
  setSession: (session) => set({ session, loading: false }),
  clearSession: () => set({ session: null, loading: false }),
}));

type JobsStore = {
  ownerKey: string;
  jobs: JobRecord[];
  scopeJobs: (ownerKey: string | null) => void;
  setJobs: (jobs: JobRecord[]) => void;
  upsertJob: (rec: JobRecord) => void;
  updateJob: (job_id: string, patch: Partial<JobRecord>) => void;
  removeJob: (job_id: string) => void;
  clearJobs: () => void;
};

const useJobsStore = create<JobsStore>((set, get) => {
  const initialOwnerKey = "__legacy__";
  const initialBag = loadJobsBag();
  const initialJobs = Array.isArray(initialBag[initialOwnerKey]) ? initialBag[initialOwnerKey] : [];
  const setAndPersist = (next: JobRecord[]) => {
    const bag = loadJobsBag();
    bag[get().ownerKey || initialOwnerKey] = next;
    saveJobsBag(bag);
    set({ jobs: next });
  };

  return {
    ownerKey: initialOwnerKey,
    jobs: initialJobs,
    scopeJobs: (ownerKey) => {
      const key = ownerKey || "__legacy__";
      const bag = loadJobsBag();
      if (!bag[key] && bag.__legacy__?.length) {
        bag[key] = bag.__legacy__;
        delete bag.__legacy__;
        saveJobsBag(bag);
      }
      const scopedJobs = Array.isArray(bag[key]) ? bag[key] : [];
      set({ ownerKey: key, jobs: scopedJobs });
    },
    setJobs: (next) => setAndPersist(next),
    upsertJob: (rec) => {
      const cur = get().jobs;
      const idx = cur.findIndex((j) => j.job_id === rec.job_id);
      let next: JobRecord[];
      if (idx >= 0) {
        next = [...cur];
        next[idx] = { ...next[idx], ...rec };
      } else {
        next = [rec, ...cur];
      }
      // keep pinned on top, then by created_at desc
      next.sort((a, b) => {
        const ap = a.pinned ? 1 : 0;
        const bp = b.pinned ? 1 : 0;
        if (ap !== bp) return bp - ap;
        return (new Date(b.created_at).getTime() || 0) - (new Date(a.created_at).getTime() || 0);
      });
      setAndPersist(next);
    },
    updateJob: (job_id, patch) => {
      const next = get().jobs.map((j) => (j.job_id === job_id ? { ...j, ...patch } : j));
      setAndPersist(next);
    },
    removeJob: (job_id) => {
      const next = get().jobs.filter((j) => j.job_id !== job_id);
      setAndPersist(next);
    },
    clearJobs: () => setAndPersist([]),
  };
});

type PickerRecent = {
  last_session_id: string;
  last_opened_at: string;
};

function createEmptyPickerRecentHistory(): Record<PickerCompareMode, string[]> {
  return {
    ONE: [],
    TWO: [],
    FOUR: [],
  };
}

function pickerCompareModeSlotCount(mode: PickerCompareMode) {
  return mode === "FOUR" ? 4 : mode === "TWO" ? 2 : 1;
}

function pickerBucketOf(item?: PickerSessionItem | null): PickerBucket {
  if (!item) return "FILMSTRIP";
  if (item.bucket === "DELETED") return "DELETED";
  if (item.bucket === "PREFERRED") return "PREFERRED";
  if (item.bucket === "FILMSTRIP") return "FILMSTRIP";
  return item.pool === "PREFERRED" ? "PREFERRED" : "FILMSTRIP";
}

function pickerGenStatusFromJobStatus(status?: JobStatus): PickerGenStatus {
  if (status === "SUCCEEDED") return "succeeded";
  if (status === "RUNNING") return "running";
  if (status === "QUEUED") return "queued";
  return "failed";
}

function createEmptyPickerScheduler() {
  return {
    turn: 0,
    next_arrival_seq: 1,
    recent_history: createEmptyPickerRecentHistory(),
    last_mode: "EMPTY" as PickerScheduleMode,
    last_boundary_at: null,
  };
}

function normalizePickerItem(raw: any, nextArrivalSeq: () => number): PickerSessionItem | null {
  if (!raw?.job_id) return null;
  const now = isoNow();
  const image_id = raw?.image_id ? String(raw.image_id) : undefined;
  const item_key =
    typeof raw?.item_key === "string" && raw.item_key
      ? String(raw.item_key)
      : image_id
        ? undefined
        : pickerPendingItemKey(String(raw.job_id));
  if (!image_id && !item_key) return null;
  const rawStatus = String(raw?.status || "");
  const status = (["QUEUED", "RUNNING", "CANCELLED", "SUCCEEDED", "FAILED", "UNKNOWN"] as const).includes(rawStatus as any)
    ? (rawStatus as JobStatus)
    : image_id
      ? "SUCCEEDED"
      : "UNKNOWN";
  const bucket = raw?.bucket === "DELETED" ? "DELETED" : raw?.bucket === "PREFERRED" || raw?.pool === "PREFERRED" ? "PREFERRED" : "FILMSTRIP";
  const arrivalSeq =
    typeof raw?.arrival_seq === "number" && Number.isFinite(raw.arrival_seq) && raw.arrival_seq > 0
      ? Math.floor(raw.arrival_seq)
      : nextArrivalSeq();
  const reviewed =
    typeof raw?.reviewed === "boolean"
      ? raw.reviewed
      : typeof raw?.rating === "number" && Number.isFinite(raw.rating)
        ? true
        : false;
  const showCountByMode = raw?.show_count_by_mode && typeof raw.show_count_by_mode === "object"
    ? {
        ONE: Math.max(0, Number(raw.show_count_by_mode.ONE || 0) || 0),
        TWO: Math.max(0, Number(raw.show_count_by_mode.TWO || 0) || 0),
        FOUR: Math.max(0, Number(raw.show_count_by_mode.FOUR || 0) || 0),
      }
    : undefined;
  return {
    item_key,
    job_id: String(raw.job_id),
    job_access_token: raw.job_access_token ? String(raw.job_access_token) : undefined,
    image_id,
    bucket,
    pool: bucket === "PREFERRED" ? "PREFERRED" : "FILMSTRIP",
    label: raw.label ? String(raw.label) : undefined,
    rating: typeof raw.rating === "number" ? clamp(Math.round(raw.rating), 1, 5) : undefined,
    reviewed,
    picked: raw.picked !== undefined ? Boolean(raw.picked) : true,
    notes: raw.notes ? String(raw.notes) : undefined,
    status,
    added_at: String(raw.added_at || now),
    show_count_total: Math.max(0, Number(raw.show_count_total || 0) || 0),
    show_count_by_mode: showCountByMode,
    last_shown_at: raw.last_shown_at ? String(raw.last_shown_at) : null,
    first_shown_at: raw.first_shown_at ? String(raw.first_shown_at) : null,
    last_rated_at: raw.last_rated_at ? String(raw.last_rated_at) : null,
    last_hard_action_at: raw.last_hard_action_at ? String(raw.last_hard_action_at) : null,
    cooldown_until_turn:
      typeof raw.cooldown_until_turn === "number" && Number.isFinite(raw.cooldown_until_turn)
        ? Math.floor(raw.cooldown_until_turn)
        : null,
    arrival_seq: arrivalSeq,
    arrival_turn:
      typeof raw.arrival_turn === "number" && Number.isFinite(raw.arrival_turn)
        ? Math.floor(raw.arrival_turn)
        : 0,
    last_status_changed_at: raw.last_status_changed_at ? String(raw.last_status_changed_at) : null,
    just_completed_at: raw.just_completed_at ? String(raw.just_completed_at) : null,
    just_completed_turn:
      typeof raw.just_completed_turn === "number" && Number.isFinite(raw.just_completed_turn)
        ? Math.floor(raw.just_completed_turn)
        : null,
    cluster_id: raw.cluster_id === null ? null : raw.cluster_id ? String(raw.cluster_id) : null,
  } satisfies PickerSessionItem;
}

function createPickerSession(name?: string): PickerSession {
  const now = isoNow();
  return {
    session_id: `pk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name: (name || "").trim() || `挑选会话 ${new Date().toLocaleDateString()}`,
    created_at: now,
    updated_at: now,
    archived: false,
    pinned: false,
    items: [],
    compare_mode: "FOUR",
    layout_preset: "SYNC_ZOOM",
    ui: {
      background: "light",
      showGrid: false,
      showInfo: false,
    },
    slots: [null, null, null, null],
    focus_key: null,
    scheduler: createEmptyPickerScheduler(),
  };
}

function normalizePickerSession(raw: any): PickerSession {
  const now = isoNow();
  let nextArrivalSeq = 1;
  const claimArrivalSeq = () => nextArrivalSeq++;
  const items = Array.isArray(raw?.items)
    ? raw.items
        .map((it: any) => normalizePickerItem(it, claimArrivalSeq))
        .filter(Boolean) as PickerSessionItem[]
    : [];
  const maxArrivalSeq = items.reduce((max, item) => Math.max(max, item.arrival_seq || 0), 0);
  const rawRecentHistory = raw?.scheduler?.recent_history || {};
  const scheduler = {
    ...createEmptyPickerScheduler(),
    ...(raw?.scheduler || {}),
    turn:
      typeof raw?.scheduler?.turn === "number" && Number.isFinite(raw.scheduler.turn)
        ? Math.max(0, Math.floor(raw.scheduler.turn))
        : 0,
    next_arrival_seq:
      typeof raw?.scheduler?.next_arrival_seq === "number" && Number.isFinite(raw.scheduler.next_arrival_seq)
        ? Math.max(maxArrivalSeq + 1, Math.floor(raw.scheduler.next_arrival_seq))
        : Math.max(maxArrivalSeq + 1, nextArrivalSeq),
    recent_history: {
      ONE: Array.isArray(rawRecentHistory.ONE) ? rawRecentHistory.ONE.filter((x: unknown) => typeof x === "string") : [],
      TWO: Array.isArray(rawRecentHistory.TWO) ? rawRecentHistory.TWO.filter((x: unknown) => typeof x === "string") : [],
      FOUR: Array.isArray(rawRecentHistory.FOUR) ? rawRecentHistory.FOUR.filter((x: unknown) => typeof x === "string") : [],
    },
    last_mode: (["REVIEW_NEW", "RESOLVE_FILMSTRIP", "POLISH_PICKED", "EMPTY"] as const).includes(raw?.scheduler?.last_mode)
      ? raw.scheduler.last_mode
      : "EMPTY",
    last_boundary_at: raw?.scheduler?.last_boundary_at ? String(raw.scheduler.last_boundary_at) : null,
  };
  const session: PickerSession = {
    session_id: String(raw?.session_id || `pk_${Math.random().toString(36).slice(2, 10)}`),
    name: String(raw?.name || "未命名会话"),
    created_at: String(raw?.created_at || now),
    updated_at: String(raw?.updated_at || raw?.created_at || now),
    archived: Boolean(raw?.archived),
    pinned: Boolean(raw?.pinned),
    cover:
      raw?.cover?.job_id && raw?.cover?.image_id
        ? { job_id: String(raw.cover.job_id), image_id: String(raw.cover.image_id) }
        : undefined,
    items,
    best_image:
      raw?.best_image?.job_id && raw?.best_image?.image_id
        ? { job_id: String(raw.best_image.job_id), image_id: String(raw.best_image.image_id) }
        : undefined,
    compare_mode: raw?.compare_mode === "FOUR" || raw?.compare_mode === "ONE" ? raw.compare_mode : raw?.compare_mode === "FILMSTRIP" ? "ONE" : "TWO",
    layout_preset: raw?.layout_preset === "FREE_ZOOM" ? "FREE_ZOOM" : "SYNC_ZOOM",
    ui: {
      background: raw?.ui?.background === "light" ? "light" : "dark",
      showGrid: Boolean(raw?.ui?.showGrid),
      showInfo: Boolean(raw?.ui?.showInfo),
    },
    slots: Array.isArray(raw?.slots)
      ? raw.slots.slice(0, 4).map((x: any) => (typeof x === "string" && x.includes("::") ? x : null))
      : [null, null, null, null],
    focus_key: typeof raw?.focus_key === "string" ? raw.focus_key : null,
    scheduler,
  };
  while (session.slots.length < 4) session.slots.push(null);
  return session;
}

function normalizePickerSessions(raw: any): PickerSession[] {
  const list = Array.isArray(raw) ? raw : [];
  const sessions = list.map((x) => normalizePickerSession(x));
  return sessions.sort((a, b) => {
    const aArchived = a.archived ? 1 : 0;
    const bArchived = b.archived ? 1 : 0;
    if (aArchived !== bArchived) return aArchived - bArchived;
    const aPinned = a.pinned ? 1 : 0;
    const bPinned = b.pinned ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;
    const updatedDelta = (new Date(b.updated_at).getTime() || 0) - (new Date(a.updated_at).getTime() || 0);
    if (updatedDelta !== 0) return updatedDelta;
    const createdDelta = (new Date(b.created_at).getTime() || 0) - (new Date(a.created_at).getTime() || 0);
    if (createdDelta !== 0) return createdDelta;
    return (new Date(b.updated_at).getTime() || 0) - (new Date(a.updated_at).getTime() || 0);
  });
}

function compactPickerSessionsForStorage(sessions: PickerSession[]) {
  const MAX_SESSIONS = 20;
  const MAX_ITEMS_PER_SESSION = 120;

  return sessions.slice(0, MAX_SESSIONS).map((session) => {
    const items = session.items.slice(-MAX_ITEMS_PER_SESSION).map((it) => ({
      ...it,
      notes: it.notes ? it.notes.slice(0, 200) : undefined,
    }));
    const itemKeySet = new Set(items.map((it) => pickerItemKey(it)));
    const slots = session.slots.map((slot) => (slot && itemKeySet.has(slot) ? slot : null));
    const focus_key = session.focus_key && itemKeySet.has(session.focus_key) ? session.focus_key : slots.find(Boolean) || null;
    const best_image =
      session.best_image && itemKeySet.has(pickerItemKey(session.best_image))
        ? session.best_image
        : undefined;
    return {
      ...session,
      items,
      slots,
      focus_key,
      best_image,
      scheduler: {
        ...session.scheduler,
        recent_history: {
          ONE: session.scheduler.recent_history.ONE.slice(0, 24),
          TWO: session.scheduler.recent_history.TWO.slice(0, 24),
          FOUR: session.scheduler.recent_history.FOUR.slice(0, 24),
        },
      },
    };
  });
}

function persistPickerData(sessions: PickerSession[], currentSessionId: string | null) {
  const raw = JSON.stringify(sessions);
  if (!storageSet(KEY_PICKER_SESSIONS, raw)) {
    const compacted = compactPickerSessionsForStorage(sessions);
    storageSet(KEY_PICKER_SESSIONS, JSON.stringify(compacted));
  }
  if (currentSessionId) {
    const recent: PickerRecent = {
      last_session_id: currentSessionId,
      last_opened_at: isoNow(),
    };
    storageSet(KEY_PICKER_RECENT, JSON.stringify(recent));
  }
}

type PickerStore = {
  sessions: PickerSession[];
  currentSessionId: string | null;
  setCurrentSession: (session_id: string) => void;
  createSession: (name?: string) => string;
  renameSession: (session_id: string, name: string) => void;
  deleteSession: (session_id: string) => void;
  patchSession: (session_id: string, updater: (s: PickerSession) => PickerSession) => void;
  addItems: (session_id: string, items: PickerSessionItem[]) => void;
  updateItem: (session_id: string, key: string, patch: Partial<PickerSessionItem>) => void;
  removeItem: (session_id: string, key: string) => void;
  reorderItem: (session_id: string, from: number, to: number) => void;
  setSlot: (session_id: string, slotIndex: number, key: string | null) => void;
  setBest: (session_id: string, key: string | null) => void;
  setFocus: (session_id: string, key: string | null) => void;
};

const usePickerStore = create<PickerStore>((set, get) => {
  const sessions = normalizePickerSessions(safeJsonParse<any>(storageGet(KEY_PICKER_SESSIONS), []));
  const recent = safeJsonParse<PickerRecent | null>(storageGet(KEY_PICKER_RECENT), null);
  const currentSessionId =
    (recent?.last_session_id && sessions.some((s) => s.session_id === recent.last_session_id) && recent.last_session_id) ||
    sessions[0]?.session_id ||
    null;
  persistPickerData(sessions, currentSessionId);

  const apply = (updater: (state: { sessions: PickerSession[]; currentSessionId: string | null }) => { sessions: PickerSession[]; currentSessionId: string | null }) => {
    const current = { sessions: get().sessions, currentSessionId: get().currentSessionId };
    const next = updater(current);
    const normalizedSessions = normalizePickerSessions(next.sessions);
    const nextCurrent =
      next.currentSessionId && normalizedSessions.some((s) => s.session_id === next.currentSessionId)
        ? next.currentSessionId
        : normalizedSessions[0]?.session_id || null;
    persistPickerData(normalizedSessions, nextCurrent);
    set({ sessions: normalizedSessions, currentSessionId: nextCurrent });
  };

  return {
    sessions,
    currentSessionId,
    setCurrentSession: (session_id) => {
      apply((state) => ({ ...state, currentSessionId: session_id }));
    },
    createSession: (name) => {
      const created = createPickerSession(name);
      apply((state) => ({ sessions: [created, ...state.sessions], currentSessionId: created.session_id }));
      return created.session_id;
    },
    renameSession: (session_id, name) => {
      apply((state) => ({
        ...state,
        sessions: state.sessions.map((s) =>
          s.session_id === session_id
            ? { ...s, name: name.trim() || s.name, updated_at: isoNow() }
            : s
        ),
      }));
    },
    deleteSession: (session_id) => {
      apply((state) => {
        const sessionsNext = state.sessions.filter((s) => s.session_id !== session_id);
        return {
          sessions: sessionsNext,
          currentSessionId: state.currentSessionId === session_id ? sessionsNext[0]?.session_id || null : state.currentSessionId,
        };
      });
    },
    patchSession: (session_id, updater) => {
      apply((state) => ({
        ...state,
        sessions: state.sessions.map((s) => {
          if (s.session_id !== session_id) return s;
          const patched = updater(s);
          return normalizePickerSession({ ...patched, session_id: s.session_id, updated_at: isoNow() });
        }),
      }));
    },
    addItems: (session_id, items) => {
      if (!items.length) return;
      get().patchSession(session_id, (session) => {
        const existing = new Set(session.items.map((it) => pickerItemKey(it)));
        let nextArrivalSeq = Math.max(1, session.scheduler?.next_arrival_seq || 1);
        const normalizedNew = items
          .map((it) =>
            normalizePickerItem(
              {
                ...it,
                bucket: it.bucket || (it.pool === "PREFERRED" ? "PREFERRED" : "FILMSTRIP"),
                reviewed:
                  typeof it.reviewed === "boolean"
                    ? it.reviewed
                    : typeof it.rating === "number" && Number.isFinite(it.rating)
                      ? true
                      : false,
                picked: it.picked !== undefined ? it.picked : true,
                status: it.status || (pickerItemHasImage(it) ? "SUCCEEDED" : "UNKNOWN"),
                item_key: it.item_key || (!pickerItemHasImage(it) ? pickerPendingItemKey(it.job_id) : undefined),
                added_at: it.added_at || isoNow(),
                arrival_seq: it.arrival_seq || nextArrivalSeq,
                arrival_turn: it.arrival_turn ?? (session.scheduler?.turn || 0),
              },
              () => nextArrivalSeq++
            )
          )
          .filter(Boolean)
          .map((it) => it as PickerSessionItem)
          .filter((it) => !existing.has(pickerItemKey(it)));
        if (!normalizedNew.length) return session;
        const focus_key = session.focus_key || pickerItemKey(normalizedNew[0]);
        const firstImageItem = normalizedNew.find((item) => pickerItemHasImage(item));
        const cover = session.cover || (firstImageItem ? { job_id: firstImageItem.job_id, image_id: firstImageItem.image_id } : undefined);
        return {
          ...session,
          items: [...session.items, ...normalizedNew],
          cover,
          focus_key,
          scheduler: {
            ...(session.scheduler || createEmptyPickerScheduler()),
            next_arrival_seq: Math.max(nextArrivalSeq, (session.scheduler?.next_arrival_seq || 1) + normalizedNew.length),
          },
        };
      });
    },
    updateItem: (session_id, key, patch) => {
      get().patchSession(session_id, (session) => ({
        ...session,
        items: session.items.map((it) => (pickerItemKey(it) === key ? { ...it, ...patch } : it)),
      }));
    },
    removeItem: (session_id, key) => {
      get().patchSession(session_id, (session) => {
        const items = session.items.filter((it) => pickerItemKey(it) !== key);
        const slots = session.slots.map((x) => (x === key ? null : x));
        const bestKey = session.best_image ? pickerItemKey(session.best_image) : null;
        const best_image = bestKey === key ? undefined : session.best_image;
        const focus_key = session.focus_key === key ? slots.find(Boolean) || (items[0] ? pickerItemKey(items[0]) : null) : session.focus_key;
        return { ...session, items, slots, best_image, focus_key };
      });
    },
    reorderItem: (session_id, from, to) => {
      get().patchSession(session_id, (session) => {
        if (from === to || from < 0 || to < 0 || from >= session.items.length || to >= session.items.length) return session;
        const next = [...session.items];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        return { ...session, items: next };
      });
    },
    setSlot: (session_id, slotIndex, key) => {
      get().patchSession(session_id, (session) => {
        if (slotIndex < 0 || slotIndex > 3) return session;
        const slots = [...session.slots];
        slots[slotIndex] = key;
        return { ...session, slots };
      });
    },
    setBest: (session_id, key) => {
      get().patchSession(session_id, (session) => ({
        ...session,
        best_image: key ? pickerItemRefFromKey(key) : undefined,
      }));
    },
    setFocus: (session_id, key) => {
      get().patchSession(session_id, (session) => ({ ...session, focus_key: key || null }));
    },
  };
});

type PickerSchedulerSettings = SettingsV1["pickerScheduler"];

type PickerCandidate = {
  key: string;
  item: PickerSessionItem;
  bucket: PickerBucket;
  genStatus: PickerGenStatus;
  layer: number;
  score: number;
};

function pickerShowCountInMode(item: PickerSessionItem, mode: PickerCompareMode) {
  return Math.max(0, Number(item.show_count_by_mode?.[mode] || 0) || 0);
}

function pickerItemsEqualBucket(item: PickerSessionItem, bucket: PickerBucket) {
  return pickerBucketOf(item) === bucket;
}

function pickerVisibleCandidateItems(items: PickerSessionItem[]) {
  return items.filter((item) => pickerBucketOf(item) !== "DELETED");
}

function pickerScheduleMode(items: PickerSessionItem[]): PickerScheduleMode {
  const filmstrip = items.filter((item) => pickerItemsEqualBucket(item, "FILMSTRIP"));
  if (filmstrip.some((item) => !item.reviewed)) return "REVIEW_NEW";
  if (filmstrip.length) return "RESOLVE_FILMSTRIP";
  if (items.some((item) => pickerItemsEqualBucket(item, "PREFERRED"))) return "POLISH_PICKED";
  return "EMPTY";
}

function pickerLayerForItem(item: PickerSessionItem, mode: PickerScheduleMode) {
  const bucket = pickerBucketOf(item);
  const reviewed = Boolean(item.reviewed);
  const statusRank = {
    succeeded: 0,
    running: 1,
    queued: 2,
    failed: 3,
  }[pickerGenStatusFromJobStatus(item.status)];

  if (mode === "REVIEW_NEW") {
    if (bucket === "FILMSTRIP" && !reviewed) return statusRank;
    if (bucket === "FILMSTRIP") return 4 + statusRank;
    if (bucket === "PREFERRED") return 8 + statusRank;
    return 99;
  }
  if (mode === "RESOLVE_FILMSTRIP") {
    if (bucket === "FILMSTRIP") return statusRank;
    if (bucket === "PREFERRED") return 4 + statusRank;
    return 99;
  }
  if (mode === "POLISH_PICKED") {
    if (bucket === "PREFERRED") return statusRank;
    return 99;
  }
  return 99;
}

function pickerRecentPenalty(key: string, recentHistory: string[]) {
  const idx = recentHistory.indexOf(key);
  if (idx < 0) return 0;
  if (idx < 4) return 100;
  if (idx < 10) return 50;
  return 20;
}

function pickerStaleBonus(lastShownAt?: string | null) {
  if (!lastShownAt) return 12;
  const elapsedMs = Date.now() - new Date(lastShownAt).getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return Math.min(elapsedMs / 1000 / 60 / 2, 30);
}

function pickerScoreItem(args: {
  item: PickerSessionItem;
  mode: PickerScheduleMode;
  compareMode: PickerCompareMode;
  currentTurn: number;
  schedulerSettings: PickerSchedulerSettings;
  recentHistory: string[];
  selectedClusterIds: Set<string>;
  currentStageSet: Set<string>;
}) {
  const { item, mode, compareMode, currentTurn, schedulerSettings, recentHistory, selectedClusterIds, currentStageSet } = args;
  const key = pickerItemKey(item);
  let score = 0;
  if ((currentTurn - (item.arrival_turn || 0)) <= 2) score += schedulerSettings.newArrivalBonus;
  if (item.just_completed_turn !== null && item.just_completed_turn !== undefined && currentTurn - item.just_completed_turn <= 2) {
    score += schedulerSettings.justCompletedBonus;
  }
  if (!item.reviewed) score += schedulerSettings.unseenBonus;
  score += Math.max(0, 50 - pickerShowCountInMode(item, compareMode) * 10);

  if (mode === "REVIEW_NEW") {
    score += item.reviewed ? 0 : 20;
  }
  if (mode === "RESOLVE_FILMSTRIP" && item.rating != null) {
    score += Math.abs(item.rating - 3) * schedulerSettings.resolveUrgencyWeight;
  }
  if (mode === "POLISH_PICKED" && item.rating != null) {
    score += item.rating * schedulerSettings.polishRatingWeight;
  }

  score += pickerStaleBonus(item.last_shown_at);
  score -= pickerRecentPenalty(key, recentHistory);

  if (item.cooldown_until_turn != null && currentTurn < item.cooldown_until_turn) score -= 9999;
  if (currentStageSet.has(key)) score -= 9999;
  if (item.cluster_id && selectedClusterIds.has(item.cluster_id)) score -= mode === "POLISH_PICKED" ? 40 : mode === "RESOLVE_FILMSTRIP" ? 65 : 90;

  return score;
}

function pickerValidSlots(session: PickerSession) {
  const itemMap = new Map(session.items.map((item) => [pickerItemKey(item), item]));
  const seen = new Set<string>();
  const slots = [...session.slots].slice(0, 4).map((key) => {
    if (!key || seen.has(key)) return null;
    const item = itemMap.get(key);
    if (!item || pickerBucketOf(item) === "DELETED") return null;
    seen.add(key);
    return key;
  });
  while (slots.length < 4) slots.push(null);
  return slots;
}

function pickerSelectKeys(args: {
  items: PickerSessionItem[];
  compareMode: PickerCompareMode;
  mode: PickerScheduleMode;
  currentTurn: number;
  schedulerSettings: PickerSchedulerSettings;
  recentHistory: string[];
  currentStageKeys: string[];
  preservedKeys: string[];
}) {
  const {
    items,
    compareMode,
    mode,
    currentTurn,
    schedulerSettings,
    recentHistory,
    currentStageKeys,
    preservedKeys,
  } = args;
  const slotCount = pickerCompareModeSlotCount(compareMode);
  const preservedSet = new Set(preservedKeys);
  const currentStageSet = new Set(currentStageKeys);
  const buildCandidates = (allowCooldown: boolean) => {
    const selectedClusterIds = new Set<string>(
      preservedKeys
        .map((key) => items.find((item) => pickerItemKey(item) === key)?.cluster_id || null)
        .filter(Boolean) as string[]
    );
    return items
      .filter((item) => !preservedSet.has(pickerItemKey(item)))
      .filter((item) => pickerBucketOf(item) !== "DELETED")
      .filter((item) => (allowCooldown ? true : item.cooldown_until_turn == null || currentTurn >= item.cooldown_until_turn))
      .map((item) => {
        const layer = pickerLayerForItem(item, mode);
        return {
          key: pickerItemKey(item),
          item,
          bucket: pickerBucketOf(item),
          genStatus: pickerGenStatusFromJobStatus(item.status),
          layer,
          score: pickerScoreItem({
            item,
            mode,
            compareMode,
            currentTurn,
            schedulerSettings,
            recentHistory,
            selectedClusterIds,
            currentStageSet,
          }),
        } satisfies PickerCandidate;
      })
      .filter((candidate) => candidate.layer < 99)
      .sort((a, b) => {
        if (a.layer !== b.layer) return a.layer - b.layer;
        if (a.score !== b.score) return b.score - a.score;
        return (b.item.arrival_seq || 0) - (a.item.arrival_seq || 0);
      });
  };

  const selected = [...preservedKeys];
  const chosen = new Set(selected);
  const takeBest = (predicate: (candidate: PickerCandidate) => boolean, pool: PickerCandidate[]) => {
    const found = pool.find((candidate) => !chosen.has(candidate.key) && predicate(candidate));
    if (!found) return false;
    selected.push(found.key);
    chosen.add(found.key);
    return true;
  };

  const fillFrom = (pool: PickerCandidate[]) => {
    while (selected.length < slotCount) {
      const runningCount = selected.filter((key) => pickerGenStatusFromJobStatus(items.find((item) => pickerItemKey(item) === key)?.status) === "running").length;
      const queuedCount = selected.filter((key) => pickerGenStatusFromJobStatus(items.find((item) => pickerItemKey(item) === key)?.status) === "queued").length;
      const candidate = pool.find((entry) => {
        if (chosen.has(entry.key)) return false;
        if (compareMode === "FOUR") {
          if (entry.genStatus === "failed") {
            return !pool.some((other) => !chosen.has(other.key) && other.genStatus !== "failed");
          }
          if (entry.genStatus === "queued" && queuedCount >= 1) {
            return !pool.some((other) => !chosen.has(other.key) && other.genStatus !== "queued");
          }
          if (entry.genStatus === "running" && runningCount >= 2) {
            return !pool.some((other) => !chosen.has(other.key) && other.genStatus !== "running");
          }
        }
        return true;
      });
      if (!candidate) break;
      selected.push(candidate.key);
      chosen.add(candidate.key);
    }
  };

  const primaryPool = buildCandidates(false);
  const fallbackPool = buildCandidates(true);

  if (selected.length < slotCount && compareMode !== "ONE") {
    if (mode === "REVIEW_NEW") {
      takeBest((candidate) => candidate.bucket === "FILMSTRIP" && !candidate.item.reviewed, primaryPool);
    }
    takeBest((candidate) => candidate.genStatus === "succeeded", primaryPool);
  }
  if (selected.length < slotCount && compareMode === "FOUR") {
    if (mode === "REVIEW_NEW") {
      while (
        selected.length < slotCount &&
        selected.filter((key) => {
          const item = items.find((entry) => pickerItemKey(entry) === key);
          return item && pickerItemsEqualBucket(item, "FILMSTRIP") && !item.reviewed;
        }).length < 4 &&
        takeBest((candidate) => candidate.bucket === "FILMSTRIP" && !candidate.item.reviewed, primaryPool)
      ) {
        // keep filling new filmstrip first
      }
    }
    while (
      selected.filter((key) => {
        const item = items.find((entry) => pickerItemKey(entry) === key);
        return item && pickerGenStatusFromJobStatus(item.status) === "succeeded";
      }).length < 2 &&
      takeBest((candidate) => candidate.genStatus === "succeeded", primaryPool)
    ) {
      // ensure at least two succeeded cards when available
    }
  }

  fillFrom(primaryPool);
  if (selected.length < slotCount) fillFrom(fallbackPool);
  return selected.slice(0, slotCount);
}

function pickerUpdateBestImage(items: PickerSessionItem[]) {
  const preferred = items.find((item) => pickerItemsEqualBucket(item, "PREFERRED") && pickerItemHasImage(item));
  return preferred ? { job_id: preferred.job_id, image_id: preferred.image_id } : undefined;
}

function pickerRecordExposure(args: {
  session: PickerSession;
  compareMode: PickerCompareMode;
  visibleKeys: string[];
  markOnlyNew?: boolean;
}) {
  const { session, compareMode, visibleKeys, markOnlyNew } = args;
  const visibleSet = new Set(visibleKeys);
  const previousVisible = new Set(pickerValidSlots(session).slice(0, pickerCompareModeSlotCount(compareMode)).filter(Boolean) as string[]);
  const now = isoNow();
  const items = session.items.map((item) => {
    const key = pickerItemKey(item);
    if (!visibleSet.has(key)) return item;
    if (markOnlyNew && previousVisible.has(key)) return item;
    return {
      ...item,
      show_count_total: (item.show_count_total || 0) + 1,
      show_count_by_mode: {
        ONE: item.show_count_by_mode?.ONE || 0,
        TWO: item.show_count_by_mode?.TWO || 0,
        FOUR: item.show_count_by_mode?.FOUR || 0,
        [compareMode]: pickerShowCountInMode(item, compareMode) + 1,
      },
      first_shown_at: item.first_shown_at || now,
      last_shown_at: now,
    };
  });
  return items;
}

function pickerScheduleSession(args: {
  session: PickerSession;
  compareMode: PickerCompareMode;
  schedulerSettings: PickerSchedulerSettings;
  reason: "init" | "next" | "layout" | "fill";
  preserveKeys?: string[];
  fillSlotIndex?: number;
}) {
  const { session, compareMode, schedulerSettings, reason, preserveKeys = [], fillSlotIndex } = args;
  const visibleItems = pickerVisibleCandidateItems(session.items);
  const mode = pickerScheduleMode(visibleItems);
  const slotCount = pickerCompareModeSlotCount(compareMode);
  const currentTurn = (session.scheduler?.turn || 0) + 1;
  const recentHistory = session.scheduler?.recent_history?.[compareMode] || [];
  const currentSlots = pickerValidSlots(session);
  const currentVisible = currentSlots.slice(0, slotCount).filter(Boolean) as string[];

  let nextVisible: string[] = [];
  if (reason === "fill" && typeof fillSlotIndex === "number") {
    nextVisible = currentVisible.filter((key, index) => index !== fillSlotIndex);
  } else if (reason === "layout") {
    nextVisible = preserveKeys.filter(Boolean).slice(0, slotCount);
  }

  const selected = pickerSelectKeys({
    items: visibleItems,
    compareMode,
    mode,
    currentTurn,
    schedulerSettings,
    recentHistory,
    currentStageKeys: reason === "next" ? currentVisible : [],
    preservedKeys: nextVisible,
  });
  const visibleKeys = reason === "fill" && typeof fillSlotIndex === "number"
    ? (() => {
        const merged = [...currentVisible];
        while (merged.length < slotCount) merged.push("");
        merged[fillSlotIndex] = selected.find((key) => !merged.includes(key)) || merged[fillSlotIndex] || "";
        return merged.filter(Boolean);
      })()
    : selected;

  const slots = [null, null, null, null] as Array<string | null>;
  visibleKeys.slice(0, slotCount).forEach((key, idx) => {
    slots[idx] = key;
  });
  const items = pickerRecordExposure({
    session: { ...session, slots: currentSlots },
    compareMode,
    visibleKeys,
    markOnlyNew: reason === "fill",
  });
  const historyLimit = schedulerSettings.recentHistory[compareMode];
  const mergedRecent = [...visibleKeys, ...recentHistory.filter((key) => !visibleKeys.includes(key))].slice(0, historyLimit);
  const focusKey =
    session.focus_key && visibleKeys.includes(session.focus_key)
      ? session.focus_key
      : visibleKeys[0] || null;

  return {
    ...session,
    compare_mode: compareMode,
    items,
    slots,
    focus_key: focusKey,
    best_image: pickerUpdateBestImage(items),
    scheduler: {
      ...(session.scheduler || createEmptyPickerScheduler()),
      turn: currentTurn,
      last_mode: mode,
      last_boundary_at: isoNow(),
      recent_history: {
        ...(session.scheduler?.recent_history || createEmptyPickerRecentHistory()),
        [compareMode]: mergedRecent,
      },
    },
  };
}

function pickerFillSlot(args: {
  session: PickerSession;
  compareMode: PickerCompareMode;
  schedulerSettings: PickerSchedulerSettings;
  fillSlotIndex: number;
}) {
  const { session, compareMode, schedulerSettings, fillSlotIndex } = args;
  const visibleItems = pickerVisibleCandidateItems(session.items);
  const mode = pickerScheduleMode(visibleItems);
  const slotCount = pickerCompareModeSlotCount(compareMode);
  const currentTurn = (session.scheduler?.turn || 0) + 1;
  const recentHistory = session.scheduler?.recent_history?.[compareMode] || [];
  const currentSlots = pickerValidSlots(session);
  const visibleSlotKeys = currentSlots.slice(0, slotCount);
  const preservedKeys = visibleSlotKeys.filter((key, index) => index !== fillSlotIndex && Boolean(key)) as string[];
  const selected = pickerSelectKeys({
    items: visibleItems,
    compareMode,
    mode,
    currentTurn,
    schedulerSettings,
    recentHistory,
    currentStageKeys: [],
    preservedKeys,
  });
  const replacement = selected.find((key) => !preservedKeys.includes(key)) || null;
  const slots = [...currentSlots];
  slots[fillSlotIndex] = replacement;
  const visibleKeys = slots.slice(0, slotCount).filter(Boolean) as string[];
  const items = pickerRecordExposure({
    session: { ...session, slots: currentSlots },
    compareMode,
    visibleKeys,
    markOnlyNew: true,
  });
  const historyLimit = schedulerSettings.recentHistory[compareMode];
  const mergedRecent = [...visibleKeys, ...recentHistory.filter((key) => !visibleKeys.includes(key))].slice(0, historyLimit);
  const focusKey =
    session.focus_key && visibleKeys.includes(session.focus_key)
      ? session.focus_key
      : visibleKeys[0] || null;

  return {
    ...session,
    compare_mode: compareMode,
    items,
    slots,
    focus_key: focusKey,
    best_image: pickerUpdateBestImage(items),
    scheduler: {
      ...(session.scheduler || createEmptyPickerScheduler()),
      turn: currentTurn,
      last_mode: mode,
      last_boundary_at: isoNow(),
      recent_history: {
        ...(session.scheduler?.recent_history || createEmptyPickerRecentHistory()),
        [compareMode]: mergedRecent,
      },
    },
  };
}

function pickerApplyRating(session: PickerSession, key: string, rating: number) {
  const now = isoNow();
  const nextRating = rating > 0 ? clamp(Math.round(rating), 1, 5) : undefined;
  return {
    ...session,
    items: session.items.map((item) =>
      pickerItemKey(item) === key
        ? {
            ...item,
            rating: nextRating,
            reviewed: nextRating != null,
            last_rated_at: nextRating != null ? now : null,
          }
        : item
    ),
  };
}

function pickerApplyHardAction(args: {
  session: PickerSession;
  key: string;
  action: "toPreferred" | "toFilmstrip" | "delete";
  compareMode: PickerCompareMode;
  schedulerSettings: PickerSchedulerSettings;
}) {
  const { session, key, action, compareMode, schedulerSettings } = args;
  const slotIndex = pickerValidSlots(session).findIndex((slotKey) => slotKey === key);
  const now = isoNow();
  const items = session.items.map((item) => {
    if (pickerItemKey(item) !== key) return item;
    if (action === "delete") {
      return {
        ...item,
        bucket: "DELETED" as PickerBucket,
        pool: "FILMSTRIP",
        picked: false,
        last_hard_action_at: now,
      };
    }
    const bucket = action === "toPreferred" ? "PREFERRED" : "FILMSTRIP";
    return {
      ...item,
      bucket,
      pool: bucket === "PREFERRED" ? "PREFERRED" : "FILMSTRIP",
      last_hard_action_at: now,
      cooldown_until_turn: (session.scheduler?.turn || 0) + schedulerSettings.moveCooldownTurns,
    };
  });
  const next = {
    ...session,
    items,
    best_image: pickerUpdateBestImage(items),
    focus_key: action === "delete" && session.focus_key === key ? null : session.focus_key,
    slots: pickerValidSlots(session).map((slotKey) => (slotKey === key ? null : slotKey)),
  };
  if (slotIndex < 0) return next;
  return pickerFillSlot({
    session: next,
    compareMode,
    schedulerSettings,
    fillSlotIndex: slotIndex,
  });
}

function pickerRevealKeyInStage(args: {
  session: PickerSession;
  key: string;
  compareMode: PickerCompareMode;
}) {
  const { session, key, compareMode } = args;
  const slotCount = pickerCompareModeSlotCount(compareMode);
  const currentSlots = pickerValidSlots(session);
  const visibleKeys = currentSlots.slice(0, slotCount).filter(Boolean) as string[];
  if (visibleKeys.includes(key)) {
    return session.focus_key === key ? session : { ...session, focus_key: key };
  }
  const slots = [...currentSlots];
  slots[0] = key;
  return {
    ...session,
    slots,
    focus_key: key,
  };
}

function pickerLayoutPreserveKeys(session: PickerSession, nextMode: PickerCompareMode) {
  const slots = pickerValidSlots(session);
  const currentSlotCount = pickerCompareModeSlotCount(session.compare_mode);
  const nextSlotCount = pickerCompareModeSlotCount(nextMode);
  const currentVisible = slots.slice(0, currentSlotCount).filter(Boolean) as string[];
  if (!currentVisible.length) return [];
  if (nextSlotCount === 1) {
    return [session.focus_key && currentVisible.includes(session.focus_key) ? session.focus_key : currentVisible[0]];
  }
  return currentVisible.slice(0, nextSlotCount);
}

function pickerNormalizeStatusMetadata(session: PickerSession, previousItemsByKey: Map<string, PickerSessionItem>) {
  const now = isoNow();
  let changed = false;
  const items = session.items.map((item) => {
    const key = pickerItemKey(item);
    const previous = previousItemsByKey.get(key);
    if (!previous) return item;
    if (previous.status === item.status) return item;
    changed = true;
    const previousGen = pickerGenStatusFromJobStatus(previous.status);
    const nextGen = pickerGenStatusFromJobStatus(item.status);
    return {
      ...item,
      last_status_changed_at: now,
      just_completed_at:
        previousGen !== "succeeded" && nextGen === "succeeded" ? now : item.just_completed_at,
      just_completed_turn:
        previousGen !== "succeeded" && nextGen === "succeeded" ? session.scheduler.turn : item.just_completed_turn,
    };
  });
  return changed ? { ...session, items } : session;
}

// -----------------------------
// Toast system
// -----------------------------

type ToastKind = "success" | "error" | "info";

type ToastItem = {
  id: string;
  kind: ToastKind;
  title: string;
  message?: string;
};

type ToastCtx = {
  push: (t: Omit<ToastItem, "id">) => void;
};

const ToastContext = React.createContext<ToastCtx | null>(null);

function useToast() {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error("ToastContext missing");
  return ctx;
}

function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = (t: Omit<ToastItem, "id">) => {
    const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    setItems((xs) => [{ id, ...t }, ...xs].slice(0, 5));
    setTimeout(() => {
      setItems((xs) => xs.filter((x) => x.id !== id));
    }, 3500);
  };

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="fixed right-4 top-4 z-50 flex w-[360px] max-w-[90vw] flex-col gap-2">
        <AnimatePresence initial={false}>
          {items.map((t) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: -10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.98 }}
              transition={{ duration: 0.18 }}
              className={cn(
                "rounded-2xl border bg-white/90 p-3 shadow-lg backdrop-blur dark:border-white/10 dark:bg-zinc-900/80",
                t.kind === "success" && "border-emerald-200 dark:border-emerald-900",
                t.kind === "error" && "border-rose-200 dark:border-rose-900",
                t.kind === "info" && "border-sky-200 dark:border-sky-900"
              )}
            >
              <div className="flex items-start gap-3">
                <div
                  className={cn(
                    "mt-1 h-2.5 w-2.5 rounded-full",
                    t.kind === "success" && "bg-emerald-500",
                    t.kind === "error" && "bg-rose-500",
                    t.kind === "info" && "bg-sky-500"
                  )}
                />
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                    {t.title}
                  </div>
                  {t.message ? (
                    <div className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-300">
                      {t.message}
                    </div>
                  ) : null}
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

// -----------------------------
// API client
// -----------------------------

class ApiClient {
  baseUrl: string;
  jobAuthMode: JobAuthMode;

  constructor(settings: SettingsV1) {
    this.baseUrl = settings.baseUrl.replace(/\/$/, "");
    this.jobAuthMode = settings.jobAuthMode;
  }

  private buildUrl(path: string) {
    return `${this.baseUrl}/v1${path.startsWith("/") ? path : `/${path}`}`;
  }

  private async request<T>(
    path: string,
    init: RequestInit & { jobToken?: string; requestedJobCount?: number } = {}
  ): Promise<T> {
    const url = this.buildUrl(path);
    const startedAt = performance.now();
    const method = (init.method || "GET").toUpperCase();
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(init.headers as any),
    };

    // Job auth header
    if (this.jobAuthMode === "TOKEN" && init.jobToken) {
      headers["X-Job-Token"] = init.jobToken;
    }
    if (typeof init.requestedJobCount === "number" && Number.isFinite(init.requestedJobCount)) {
      headers["X-Requested-Job-Count"] = String(Math.max(1, Math.round(init.requestedJobCount)));
    }

    let resp: Response;
    try {
      resp = await fetch(url, { ...init, headers, credentials: "include" });
    } catch (e: any) {
      logError("api", "network request failed", {
        method,
        path,
        url,
        message: e?.message || "Network error",
      });
      const err: ApiError = { error: { code: "NETWORK_ERROR", message: e?.message || "Network error" } };
      throw err;
    }

    const contentType = resp.headers.get("content-type") || "";
    const elapsedMs = Math.round(performance.now() - startedAt);
    const logPayload = {
      method,
      path,
      status: resp.status,
      elapsedMs,
    };

    if (!resp.ok) {
      logWarn("api", "request failed", logPayload);
      if (contentType.includes("application/json")) {
        const j = (await resp.json().catch(() => null)) as ApiError | null;
        if (j?.error?.code || j?.error?.message) {
          logWarn("api", "backend returned error payload", {
            ...logPayload,
            errorCode: j.error?.code,
            errorMessage: j.error?.message,
          });
        }
        throw (
          j || {
            error: { code: String(resp.status), message: resp.statusText || "Request failed" },
          }
        );
      }
      throw { error: { code: String(resp.status), message: resp.statusText || "Request failed" } };
    }

    logInfo("api", "request succeeded", logPayload);
    if (contentType.includes("application/json")) {
      return (await resp.json()) as T;
    }

    // for non-json endpoints
    return (await (resp as any).blob()) as any;
  }

  health(signal?: AbortSignal) {
    return this.request<any>("/health", { method: "GET", signal });
  }

  login(username: string, password: string, turnstileToken: string, signal?: AbortSignal) {
    return this.request<AuthSession>("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        password,
        turnstile_token: turnstileToken,
      }),
      signal,
    });
  }

  logout(signal?: AbortSignal) {
    return this.request<{ logged_out: boolean }>("/auth/logout", { method: "POST", signal });
  }

  me(signal?: AbortSignal) {
    return this.request<AuthSession>("/auth/me", { method: "GET", signal });
  }

  verifyGenerationTurnstile(turnstileToken: string, requestedJobCount?: number, signal?: AbortSignal) {
    return this.request<AuthSession>("/auth/turnstile/generation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        turnstile_token: turnstileToken,
        requested_job_count: requestedJobCount,
      }),
      signal,
    });
  }

  verifyImageAccessTurnstile(turnstileToken: string, signal?: AbortSignal) {
    return this.request<{ verified: boolean; scope: string }>("/auth/turnstile/image-access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        turnstile_token: turnstileToken,
      }),
      signal,
    });
  }

  listModels(signal?: AbortSignal) {
    return this.request<ModelsPayload>("/models", { method: "GET", signal });
  }

  createJobJSON(payload: any, requestedJobCount = 1, signal?: AbortSignal) {
    return this.request<any>("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      requestedJobCount,
      signal,
    });
  }

  createJobMultipart(form: FormData, requestedJobCount = 1, signal?: AbortSignal) {
    // NOTE: Do NOT set Content-Type explicitly for FormData.
    return this.request<any>("/jobs", {
      method: "POST",
      body: form,
      requestedJobCount,
      signal,
    });
  }

  getJob(job_id: string, jobToken?: string, signal?: AbortSignal) {
    return this.request<JobMeta>(`/jobs/${encodeURIComponent(job_id)}`, {
      method: "GET",
      jobToken,
      signal,
    });
  }

  batchMeta(jobs: JobAccessRef[], fields?: string[], signal?: AbortSignal) {
    return this.request<BatchMetaResponse>("/jobs/batch-meta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobs, fields }),
      signal,
    });
  }

  activeJobs(jobs: JobAccessRef[], limit = 100, signal?: AbortSignal) {
    return this.request<ActiveJobsResponse>("/jobs/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobs, limit }),
      signal,
    });
  }

  dashboardSummary(jobs: JobAccessRef[], limit = 200, signal?: AbortSignal) {
    return this.request<DashboardSummaryResponse>("/dashboard/summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobs, limit }),
      signal,
    });
  }

  getJobRequest(job_id: string, jobToken?: string, signal?: AbortSignal) {
    return this.request<any>(`/jobs/${encodeURIComponent(job_id)}/request`, {
      method: "GET",
      jobToken,
      signal,
    });
  }

  getJobResponse(job_id: string, jobToken?: string, signal?: AbortSignal) {
    return this.request<any>(`/jobs/${encodeURIComponent(job_id)}/response`, {
      method: "GET",
      jobToken,
      signal,
    });
  }

  deleteJob(job_id: string, jobToken?: string, signal?: AbortSignal) {
    return this.request<any>(`/jobs/${encodeURIComponent(job_id)}`, {
      method: "DELETE",
      jobToken,
      signal,
    });
  }

  cancelJob(job_id: string, jobToken?: string, signal?: AbortSignal) {
    return this.request<any>(`/jobs/${encodeURIComponent(job_id)}/cancel`, {
      method: "POST",
      jobToken,
      signal,
    });
  }

  retryJob(job_id: string, jobToken?: string, signal?: AbortSignal) {
    return this.request<any>(`/jobs/${encodeURIComponent(job_id)}/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      jobToken,
      signal,
    });
  }

  // image download as blob
  getImageBlob(job_id: string, image_id: string, jobToken?: string, signal?: AbortSignal) {
    const url = this.buildUrl(`/jobs/${encodeURIComponent(job_id)}/images/${encodeURIComponent(image_id)}`);
    const startedAt = performance.now();
    const headers: Record<string, string> = {};
    if (this.jobAuthMode === "TOKEN" && jobToken) headers["X-Job-Token"] = jobToken;
    return fetch(url, { method: "GET", headers, signal, credentials: "include" }).then(async (r) => {
      if (!r.ok) {
        const contentType = r.headers.get("content-type") || "";
        logWarn("api", "image download failed", {
          path: `/jobs/${job_id}/images/${image_id}`,
          status: r.status,
        });
        let err: ApiError = { error: { code: String(r.status), message: r.statusText || "Image download failed" } };
        if (contentType.includes("application/json")) {
          const payload = (await r.json().catch(() => null)) as ApiError | null;
          if (payload?.error?.code || payload?.error?.message) {
            err = payload;
          }
        }
        throw err;
      }
      logDebug("api", "image downloaded", {
        path: `/jobs/${job_id}/images/${image_id}`,
        status: r.status,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      return r.blob();
    });
  }

  getPreviewBlob(job_id: string, image_id: string, jobToken?: string, signal?: AbortSignal) {
    const url = this.buildUrl(`/jobs/${encodeURIComponent(job_id)}/images/${encodeURIComponent(image_id)}/preview`);
    const headers: Record<string, string> = {};
    if (this.jobAuthMode === "TOKEN" && jobToken) headers["X-Job-Token"] = jobToken;
    return fetch(url, { method: "GET", headers, signal, credentials: "include" }).then(async (r) => {
      if (!r.ok) {
        const contentType = r.headers.get("content-type") || "";
        let err: ApiError = { error: { code: String(r.status), message: r.statusText || "Preview download failed" } };
        if (contentType.includes("application/json")) {
          const payload = (await r.json().catch(() => null)) as ApiError | null;
          if (payload?.error?.code || payload?.error?.message) err = payload;
        }
        throw err;
      }
      return r.blob();
    });
  }

  batchPreviewImages(
    images: Array<{ job_id: string; image_id: string; job_access_token?: string }>,
    signal?: AbortSignal
  ) {
    return this.request<PreviewBatchResponse>("/jobs/previews/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images }),
      signal,
    });
  }

  getReferenceBlob(job_id: string, refPath: string, jobToken?: string, signal?: AbortSignal) {
    const url = this.buildUrl(`/jobs/${encodeURIComponent(job_id)}/references/${refPath.split("/").map(encodeURIComponent).join("/")}`);
    const headers: Record<string, string> = {};
    if (this.jobAuthMode === "TOKEN" && jobToken) headers["X-Job-Token"] = jobToken;
    return fetch(url, { method: "GET", headers, signal, credentials: "include" }).then(async (r) => {
      if (!r.ok) {
        const contentType = r.headers.get("content-type") || "";
        let err: ApiError = { error: { code: String(r.status), message: r.statusText || "Reference image download failed" } };
        if (contentType.includes("application/json")) {
          const payload = (await r.json().catch(() => null)) as ApiError | null;
          if (payload?.error?.code || payload?.error?.message) err = payload;
        }
        throw err;
      }
      return r.blob();
    });
  }

  // Admin
  adminOverview(signal?: AbortSignal) {
    return this.request<AdminOverviewResponse>("/admin/overview", { method: "GET", signal });
  }

  adminProviders(signal?: AbortSignal) {
    return this.request<ProviderSummary>("/admin/providers", { method: "GET", signal });
  }

  adminUsers(signal?: AbortSignal) {
    return this.request<{ users: AdminUserItem[] }>("/admin/users", { method: "GET", signal });
  }

  adminUserJobs(
    userId: string,
    params?: {
      q?: string;
      status?: string;
      model?: string;
      from?: string;
      to?: string;
      batch_name?: string;
      has_images?: boolean;
      failed_only?: boolean;
      sort?: string;
      cursor?: string | null;
      limit?: number;
    },
    signal?: AbortSignal
  ) {
    const query = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      query.set(key, typeof value === "boolean" ? String(value) : String(value));
    });
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return this.request<AdminUserJobsResponse>(`/admin/users/${encodeURIComponent(userId)}/jobs${suffix}`, { method: "GET", signal });
  }

  adminCreateUser(payload: {
    username: string;
    password: string;
    role: UserRole;
    enabled: boolean;
    policy_overrides: Record<string, number | null>;
  }, signal?: AbortSignal) {
    return this.request<AdminUserItem>("/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
  }

  adminUpdateUser(
    userId: string,
    payload: {
      password?: string;
      role?: UserRole;
      enabled?: boolean;
      policy_overrides?: Record<string, number | null>;
    },
    signal?: AbortSignal
  ) {
    return this.request<AdminUserItem>(`/admin/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
  }

  adminResetQuota(userId: string, signal?: AbortSignal) {
    return this.request<AdminUserItem>(`/admin/users/${encodeURIComponent(userId)}/reset-quota`, {
      method: "POST",
      signal,
    });
  }

  adminUpdatePolicy(payload: Partial<SystemPolicy>, signal?: AbortSignal) {
    return this.request<{ policy: SystemPolicy }>("/admin/policy", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
  }

  adminUpdateProvider(
    providerId: string,
    payload: {
      enabled?: boolean;
      note?: string;
    },
    signal?: AbortSignal
  ) {
    return this.request<{ provider: ProviderSnapshot }>(`/admin/providers/${encodeURIComponent(providerId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
  }

  adminSetProviderBalance(providerId: string, amount_cny: number | null, signal?: AbortSignal) {
    return this.request<{ provider: ProviderSnapshot }>(`/admin/providers/${encodeURIComponent(providerId)}/balance/set`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount_cny }),
      signal,
    });
  }

  adminAddProviderBalance(providerId: string, delta_cny: number, signal?: AbortSignal) {
    return this.request<{ provider: ProviderSnapshot }>(`/admin/providers/${encodeURIComponent(providerId)}/balance/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delta_cny }),
      signal,
    });
  }
}

function useApiClient() {
  const settings = useSettingsStore((s) => s.settings);
  return useMemo(() => new ApiClient(settings), [settings.baseUrl, settings.jobAuthMode]);
}

function useAuthSession() {
  const loading = useAuthStore((s) => s.loading);
  const session = useAuthStore((s) => s.session);
  return {
    loading,
    session,
    user: session?.user || null,
    usage: session?.usage || null,
    isAdmin: session?.user?.role === "ADMIN",
  };
}

function useAuthBootstrap() {
  const client = useApiClient();
  const setLoading = useAuthStore((s) => s.setLoading);
  const setSession = useAuthStore((s) => s.setSession);
  const clearSession = useAuthStore((s) => s.clearSession);

  useEffect(() => {
    let stopped = false;
    const abort = new AbortController();
    setLoading(true);

    client
      .me(abort.signal)
      .then((session) => {
        if (stopped) return;
        useJobsStore.getState().scopeJobs(session.user.user_id);
        setSession(session);
      })
      .catch(() => {
        if (stopped) return;
        useJobsStore.getState().scopeJobs(null);
        clearSession();
      });

    return () => {
      stopped = true;
      abort.abort();
    };
  }, [client, clearSession, setLoading, setSession]);
}

function useModelCatalog() {
  const client = useApiClient();
  const [catalog, setCatalog] = useState<ModelsPayload>(FALLBACK_MODEL_CATALOG);

  useEffect(() => {
    let stopped = false;
    const abort = new AbortController();

    client
      .listModels(abort.signal)
      .then((payload) => {
        if (stopped) return;
        if (!payload || !Array.isArray(payload.models) || !payload.models.length) return;
        const models = payload.models
          .filter((m) => m?.model_id && m?.supported_aspect_ratios?.length)
          .map((m) => ({
            ...m,
            supports_thinking_level: Boolean((m as any).supports_thinking_level),
            supported_thinking_levels: Array.isArray((m as any).supported_thinking_levels)
              ? (m as any).supported_thinking_levels
              : [],
            default_params: {
              ...m.default_params,
              thinking_level: (m.default_params as any)?.thinking_level ?? null,
            },
          })) as ModelCapability[];
        if (!models.length) return;
        const modelIds = new Set(models.map((m) => m.model_id));
        const default_model = modelIds.has(payload.default_model) ? payload.default_model : models[0].model_id;
        setCatalog({ default_model, models });
      })
      .catch(() => {
        if (stopped) return;
        logWarn("models", "failed to load model catalog, fallback applied");
        setCatalog(FALLBACK_MODEL_CATALOG);
      });

    return () => {
      stopped = true;
      abort.abort();
    };
  }, [client]);

  return catalog;
}

function useAdminProviderSummary(enabled: boolean) {
  const client = useApiClient();
  const [providerSummary, setProviderSummary] = useState<ProviderSummary | null>(null);

  useEffect(() => {
    if (!enabled) {
      setProviderSummary(null);
      return;
    }
    let stopped = false;
    const abort = new AbortController();

    client
      .adminProviders(abort.signal)
      .then((payload) => {
        if (stopped) return;
        setProviderSummary(payload);
      })
      .catch(() => {
        if (stopped) return;
        setProviderSummary(null);
      });

    return () => {
      stopped = true;
      abort.abort();
    };
  }, [client, enabled]);

  return providerSummary;
}

// -----------------------------
// UI primitives
// -----------------------------

function Card({
  children,
  className,
  hover = true,
  testId,
}: {
  children: React.ReactNode;
  className?: string;
  hover?: boolean;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "rounded-2xl border border-zinc-200 bg-white/70 p-4 shadow-sm backdrop-blur dark:border-white/10 dark:bg-zinc-900/60",
        hover && "transition-all hover:-translate-y-0.5 hover:shadow-md",
        className
      )}
    >
      {children}
    </div>
  );
}

function Button({
  children,
  className,
  onClick,
  disabled,
  type,
  variant = "primary",
  title,
  testId,
}: {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
  variant?: "primary" | "ghost" | "danger" | "secondary";
  title?: string;
  testId?: string;
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50";
  const styles =
    variant === "primary"
      ? "bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100"
      : variant === "secondary"
        ? "bg-zinc-100 text-zinc-900 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-50 dark:hover:bg-zinc-700"
        : variant === "danger"
          ? "bg-rose-600 text-white hover:bg-rose-500"
          : "bg-transparent text-zinc-800 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800";

  return (
    <button data-testid={testId} type={type || "button"} title={title} disabled={disabled} onClick={onClick} className={cn(base, styles, className)}>
      {children}
    </button>
  );
}

function Input({
  value,
  onChange,
  placeholder,
  className,
  type,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  type?: string;
  testId?: string;
}) {
  return (
    <input
      data-testid={testId}
      type={type || "text"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={cn(
        "w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm outline-none ring-0 focus:border-zinc-400 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:border-white/20",
        className
      )}
    />
  );
}

function TextArea({
  value,
  onChange,
  placeholder,
  className,
  rows = 5,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  rows?: number;
  testId?: string;
}) {
  return (
    <textarea
      data-testid={testId}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      className={cn(
        "w-full resize-y rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm outline-none focus:border-zinc-400 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:border-white/20",
        className
      )}
    />
  );
}

function Select({
  value,
  onChange,
  options,
  className,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  className?: string;
  testId?: string;
}) {
  return (
    <select
      data-testid={testId}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm outline-none focus:border-zinc-400 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:border-white/20",
        className
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Switch({ value, onChange, testId }: { value: boolean; onChange: (v: boolean) => void; testId?: string }) {
  return (
    <button
      data-testid={testId}
      onClick={() => onChange(!value)}
      className={cn(
        "relative h-7 w-12 rounded-full border transition",
        value
          ? "border-emerald-400 bg-emerald-400/80 dark:bg-emerald-500/80"
          : "border-zinc-200 bg-zinc-100 dark:border-white/10 dark:bg-zinc-800"
      )}
      type="button"
    >
      <span
        className={cn(
          "absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition",
          value ? "left-5" : "left-0.5"
        )}
      />
    </button>
  );
}

function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-xl bg-zinc-200/70 dark:bg-zinc-700/50",
        className || "h-4 w-full"
      )}
    />
  );
}

function LoadingSpinner({
  className,
  label,
  tone = "neutral",
}: {
  className?: string;
  label?: string;
  tone?: "neutral" | "brand" | "sky";
}) {
  const toneClass =
    tone === "brand"
      ? "border-zinc-300 border-t-zinc-900 dark:border-zinc-700 dark:border-t-white"
      : tone === "sky"
        ? "border-sky-300 border-t-sky-600 dark:border-sky-800 dark:border-t-sky-300"
        : "border-zinc-300 border-t-zinc-500 dark:border-zinc-700 dark:border-t-zinc-200";

  return (
    <div className={cn("flex flex-col items-center justify-center gap-3", className)}>
      <div className={cn("h-9 w-9 animate-spin rounded-full border-2", toneClass)} />
      {label ? <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-300">{label}</div> : null}
    </div>
  );
}

function Badge({ status }: { status: JobStatus }) {
  const s = status;
  const style =
    s === "SUCCEEDED"
      ? "bg-emerald-500/15 text-emerald-700 border-emerald-200 dark:text-emerald-200 dark:border-emerald-900"
      : s === "CANCELLED"
        ? "bg-orange-500/15 text-orange-700 border-orange-200 dark:text-orange-200 dark:border-orange-900"
      : s === "FAILED"
        ? "bg-rose-500/15 text-rose-700 border-rose-200 dark:text-rose-200 dark:border-rose-900"
        : s === "RUNNING"
          ? "bg-sky-500/15 text-sky-700 border-sky-200 dark:text-sky-200 dark:border-sky-900"
          : s === "QUEUED"
            ? "bg-amber-500/15 text-amber-700 border-amber-200 dark:text-amber-200 dark:border-amber-900"
            : "bg-zinc-500/15 text-zinc-700 border-zinc-200 dark:text-zinc-200 dark:border-white/10";

  return (
    <span className={cn("inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-semibold", style)}>
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          s === "SUCCEEDED" && "bg-emerald-500",
          s === "CANCELLED" && "bg-orange-500",
          s === "FAILED" && "bg-rose-500",
          s === "RUNNING" && "bg-sky-500 animate-pulse",
          s === "QUEUED" && "bg-amber-500 animate-pulse",
          s === "UNKNOWN" && "bg-zinc-400"
        )}
      />
      {s}
    </span>
  );
}

function Divider() {
  return <div className="my-3 h-px w-full bg-zinc-200/80 dark:bg-white/10" />;
}

// -----------------------------
// Theme hook
// -----------------------------

function useTheme() {
  const theme = useSettingsStore((s) => s.settings.ui.theme);
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      const dark = theme === "dark" || (theme === "system" && prefersDark);
      root.classList.toggle("dark", dark);
    };
    apply();
    const m = window.matchMedia?.("(prefers-color-scheme: dark)");
    const on = () => apply();
    m?.addEventListener?.("change", on);
    return () => m?.removeEventListener?.("change", on);
  }, [theme]);
}

function ImageCacheJanitor() {
  const settings = useSettingsStore((s) => s.settings);
  const { user } = useAuthSession();
  const scope = user?.user_id || "__guest__";

  useEffect(() => {
    if (!settings.cache.enabled) {
      clearSharedPreviewMemory(scope);
      imageCacheClear(scope);
      return;
    }
    imageCacheTrim(scope, settings.cache.ttlDays, settings.cache.maxBytes);
  }, [scope, settings.cache.enabled, settings.cache.maxBytes, settings.cache.ttlDays]);

  return null;
}

// -----------------------------
// Motion settings
// -----------------------------

function useMotionConfig() {
  const reduceMotion = useSettingsStore((s) => s.settings.ui.reduceMotion);
  const transition = reduceMotion ? { duration: 0 } : { duration: 0.22, ease: "easeOut" };
  const page = reduceMotion
    ? {}
    : {
        initial: { opacity: 0, y: 10 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: -10 },
      };
  return { reduceMotion, transition, page };
}

// -----------------------------
// App shell
// -----------------------------

function TopNav() {
  const online = useOnlineStatus();
  const navigate = useNavigate();
  const settings = useSettingsStore((s) => s.settings);
  const client = useApiClient();
  const clearSession = useAuthStore((s) => s.clearSession);
  const { push } = useToast();
  const { user, isAdmin } = useAuthSession();

  if (!user) return null;

  const handleLogout = async () => {
    await client.logout().catch(() => null);
    useJobsStore.getState().scopeJobs(null);
    clearSession();
    push({ kind: "info", title: "已退出登录" });
    navigate("/login");
  };

  return (
    <div className="sticky top-0 z-40 border-b border-zinc-200/80 bg-white/70 backdrop-blur dark:border-white/10 dark:bg-zinc-950/60">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-zinc-900 text-white shadow-sm dark:bg-white dark:text-zinc-900">
            NB
          </div>
          <div className="leading-tight">
            <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">Nano Banana Pro</div>
            <div className="text-xs text-zinc-600 dark:text-zinc-300">
              {settings.baseUrl}
              <span className="mx-2 text-zinc-300 dark:text-white/20">•</span>
              <span className={cn("font-semibold", online ? "text-emerald-600 dark:text-emerald-300" : "text-rose-600 dark:text-rose-300")}>
                {online ? "Online" : "Offline"}
              </span>
              <span className="mx-2 text-zinc-300 dark:text-white/20">•</span>
              <span className="text-xs font-semibold">{user.username}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <NavButton to="/" label="Dashboard" />
          <NavButton to="/create" label="Create" />
          <NavButton to="/batch" label="Batch" />
          <NavButton to="/history" label="History" />
          <NavButton to="/picker" label="Picker" />
          {isAdmin ? <NavButton to="/admin" label="Admin" /> : null}
          <NavButton to="/settings" label="Settings" />
          <Button variant="primary" onClick={() => navigate("/create")} className="ml-1">
            + 快速创建
          </Button>
          <Button variant="ghost" onClick={handleLogout}>退出</Button>
        </div>
      </div>
    </div>
  );
}

function NavButton({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "rounded-xl px-3 py-2 text-sm font-semibold transition",
          isActive
            ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900"
            : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-900"
        )
      }
    >
      {label}
    </NavLink>
  );
}

function PageContainer({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("mx-auto w-full max-w-6xl px-4 py-6", className)}>{children}</div>;
}

function PageTitle({ title, subtitle, right }: { title: string; subtitle?: string; right?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <div className="text-2xl font-extrabold tracking-tight text-zinc-900 dark:text-zinc-50">{title}</div>
        {subtitle ? <div className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">{subtitle}</div> : null}
      </div>
      {right ? <div className="flex items-center gap-2">{right}</div> : null}
    </div>
  );
}

function AnimatedRoutes() {
  const location = useLocation();
  const { page, transition } = useMotionConfig();
  const { isAdmin } = useAuthSession();

  return (
    <motion.div key={location.pathname} {...(page as any)} transition={transition}>
      <Routes location={location}>
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="/" element={<DashboardPage />} />
        <Route path="/create" element={<CreateJobPage />} />
        <Route path="/batch" element={<BatchCreatePage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/picker" element={<PickerPage />} />
        <Route path="/admin" element={isAdmin ? <AdminPage /> : <Navigate to="/" replace />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </motion.div>
  );
}

function NotFoundPage() {
  const nav = useNavigate();
  return (
    <PageContainer>
      <Card>
        <div className="text-lg font-bold text-zinc-900 dark:text-zinc-50">404</div>
        <div className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">页面不存在。</div>
        <div className="mt-4">
          <Button onClick={() => nav("/")}>回到首页</Button>
        </div>
      </Card>
    </PageContainer>
  );
}

let turnstileScriptPromise: Promise<void> | null = null;

function ensureTurnstileScript() {
  if (typeof window === "undefined") return Promise.reject(new Error("window unavailable"));
  if (window.turnstile) return Promise.resolve();
  if (turnstileScriptPromise) return turnstileScriptPromise;

  turnstileScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-turnstile="true"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Turnstile script failed")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.dataset.turnstile = "true";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Turnstile script failed"));
    document.head.appendChild(script);
  });

  return turnstileScriptPromise;
}

function TurnstileWidget({
  onTokenChange,
  className,
}: {
  onTokenChange: (token: string | null) => void;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const theme = document.documentElement.classList.contains("dark") ? "dark" : "light";

  useEffect(() => {
    let cancelled = false;
    let widgetId: string | number | null = null;
    onTokenChange(null);
    setLoadError(null);

    if (!TURNSTILE_SITE_KEY) {
      setLoadError("未配置 Turnstile site key");
      return;
    }

    ensureTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        containerRef.current.innerHTML = "";
        widgetId = window.turnstile.render(containerRef.current, {
          sitekey: TURNSTILE_SITE_KEY,
          theme,
          callback: (token: string) => {
            setLoadError(null);
            onTokenChange(token);
          },
          "expired-callback": () => onTokenChange(null),
          "error-callback": () => {
            setLoadError("验证组件加载失败，请刷新后重试");
            onTokenChange(null);
          },
        });
      })
      .catch((err: any) => {
        if (cancelled) return;
        setLoadError(err?.message || "Turnstile 加载失败");
        onTokenChange(null);
      });

    return () => {
      cancelled = true;
      onTokenChange(null);
      if (widgetId !== null && window.turnstile?.remove) {
        window.turnstile.remove(widgetId);
      }
    };
  }, [onTokenChange, theme]);

  return (
    <div className={className}>
      <div ref={containerRef} />
      {loadError ? (
        <div className="mt-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
          {loadError}
        </div>
      ) : null}
    </div>
  );
}

function TurnstilePromptModal({
  open,
  title,
  description,
  token,
  tokenKey,
  setToken,
  loading,
  onClose,
  onConfirm,
  confirmLabel = "继续",
}: {
  open: boolean;
  title: string;
  description: string;
  token: string | null;
  tokenKey: number;
  setToken: (token: string | null) => void;
  loading: boolean;
  onClose: () => void;
  onConfirm: () => void;
  confirmLabel?: string;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/50 px-4 backdrop-blur-sm">
      <Card className="w-full max-w-lg border-zinc-900/10 bg-white p-6 shadow-2xl dark:border-white/10 dark:bg-zinc-950">
        <div className="text-lg font-bold text-zinc-900 dark:text-zinc-50">{title}</div>
        <div className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">{description}</div>
        <div className="mt-5 rounded-2xl border border-zinc-200 bg-zinc-50/80 p-4 dark:border-white/10 dark:bg-white/[0.03]">
          <TurnstileWidget key={tokenKey} onTokenChange={setToken} />
        </div>
        <div className="mt-5 flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={loading}>取消</Button>
          <Button variant="primary" onClick={onConfirm} disabled={!token || loading}>
            {loading ? "验证中…" : confirmLabel}
          </Button>
        </div>
      </Card>
    </div>
  );
}

function HelpTip({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex align-middle">
      <span className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-zinc-300 bg-white text-[10px] font-bold text-zinc-500 shadow-sm dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-300">
        ?
      </span>
      <span className="pointer-events-none absolute left-1/2 top-[calc(100%+8px)] z-20 hidden w-56 -translate-x-1/2 rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-[11px] font-medium leading-5 text-zinc-700 shadow-xl group-hover:block dark:border-white/10 dark:bg-zinc-950 dark:text-zinc-200">
        {text}
      </span>
    </span>
  );
}

function BatchSessionSelector({
  pickerSessions,
  selectedIds,
  onToggle,
  onCreateAndSelect,
}: {
  pickerSessions: PickerSession[];
  selectedIds: string[];
  onToggle: (sessionId: string, checked: boolean) => void;
  onCreateAndSelect: (name?: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [draftName, setDraftName] = useState("");
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return pickerSessions;
    return pickerSessions.filter((session) => session.name.toLowerCase().includes(query));
  }, [pickerSessions, search]);

  return (
    <div className="rounded-2xl border border-zinc-200/80 bg-zinc-50/70 p-3 dark:border-white/10 dark:bg-zinc-950/30">
      <div className="grid gap-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <Input value={search} onChange={setSearch} placeholder="Search session name" />
        <Input value={draftName} onChange={setDraftName} placeholder="Create session now" />
        <Button
          variant="secondary"
          className="xl:min-w-[92px]"
          onClick={() => {
            onCreateAndSelect(draftName.trim() || undefined);
            setDraftName("");
          }}
        >
          New
        </Button>
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
        <span>Local sessions {pickerSessions.length}</span>
        {selectedIds.length ? <span>Selected {selectedIds.length}</span> : null}
      </div>
      <div className="mt-3">
        {filtered.length ? (
          <div className="flex gap-2 overflow-x-auto pb-1">
            {filtered.map((session) => {
              const checked = selectedIdSet.has(session.session_id);
              const counts = getPickerSessionCounts(session);
              return (
                <label
                  key={session.session_id}
                  className={cn(
                    "min-w-[228px] flex-none cursor-pointer rounded-2xl border px-3 py-3 transition",
                    checked
                      ? "border-zinc-900 bg-white shadow-sm dark:border-white dark:bg-zinc-950/75"
                      : "border-zinc-200 bg-white/70 hover:border-zinc-300 dark:border-white/10 dark:bg-zinc-950/45 dark:hover:border-white/20"
                  )}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-400"
                      checked={checked}
                      onChange={(e) => onToggle(session.session_id, e.target.checked)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-50">{session.name}</div>
                      <div className="mt-1 truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                        {formatLocal(session.created_at)}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
                    <div className="rounded-xl bg-zinc-50 px-2.5 py-2 dark:bg-zinc-950/60">
                      <div className="font-semibold text-zinc-900 dark:text-zinc-50">{counts.filmstrip}</div>
                      <div className="text-zinc-500 dark:text-zinc-400">Filmstrip</div>
                    </div>
                    <div className="rounded-xl bg-zinc-50 px-2.5 py-2 dark:bg-zinc-950/60">
                      <div className="font-semibold text-zinc-900 dark:text-zinc-50">{counts.preferred}</div>
                      <div className="text-zinc-500 dark:text-zinc-400">Preferred</div>
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-zinc-200 px-3 py-4 text-center text-xs text-zinc-500 dark:border-white/10 dark:text-zinc-400">
            No matching session. Create one above.
          </div>
        )}
      </div>
    </div>
  );
}

function ModelRecommendationModal({
  open,
  targetLabel,
  onPreferBest,
  onKeepCurrent,
  onClose,
}: {
  open: boolean;
  targetLabel: string;
  onPreferBest: () => void;
  onKeepCurrent: () => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/55 px-4 backdrop-blur-sm">
      <Card className="w-full max-w-xl border-amber-200 bg-[linear-gradient(180deg,rgba(255,251,235,0.98),rgba(255,255,255,0.98))] p-0 shadow-2xl dark:border-amber-400/20 dark:bg-[linear-gradient(180deg,rgba(39,39,42,0.98),rgba(9,9,11,0.98))]" hover={false}>
        <div className="border-b border-amber-200/80 px-6 py-5 dark:border-amber-400/10">
          <div className="text-[11px] font-black uppercase tracking-[0.24em] text-amber-700 dark:text-amber-300">Model Recommendation</div>
          <div className="mt-2 text-2xl font-black text-zinc-950 dark:text-white">Nano Banana 2 更值得优先使用</div>
          <div className="mt-2 text-sm leading-6 text-zinc-700 dark:text-zinc-300">
            对普通用户来说，<span className="font-bold text-zinc-950 dark:text-white">Nano Banana 2</span> 通常比 Nano Banana Pro 和 Nano Banana 更均衡，
            在效果、稳定性和默认体验上更推荐作为首选模型。
          </div>
        </div>
        <div className="grid gap-3 px-6 py-5 md:grid-cols-[1.3fr_0.9fr]">
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50/80 p-4 dark:border-emerald-400/15 dark:bg-emerald-500/10">
            <div className="text-xs font-black uppercase tracking-[0.2em] text-emerald-700 dark:text-emerald-300">Recommended</div>
            <div className="mt-2 text-lg font-black text-zinc-950 dark:text-white">继续使用更好的 Nano Banana 2</div>
            <div className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">保持默认推荐模型，减少不必要的试错成本。</div>
            <Button variant="primary" className="mt-4 w-full !py-3 text-base font-black" onClick={onPreferBest}>
              用更好的 Nano Banana 2
            </Button>
          </div>
          <div className="rounded-2xl border border-zinc-200 bg-zinc-50/80 p-4 dark:border-white/10 dark:bg-zinc-900/60">
            <div className="text-xs font-bold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">Alternative</div>
            <div className="mt-2 text-sm font-bold text-zinc-900 dark:text-zinc-100">仍要使用 {targetLabel}</div>
            <div className="mt-2 text-xs leading-5 text-zinc-600 dark:text-zinc-400">如果你明确知道自己要测试这个模型，也可以继续。</div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" className="text-xs" onClick={onClose}>取消</Button>
              <Button variant="secondary" className="text-xs" onClick={onKeepCurrent}>
                仍要使用 {targetLabel}
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

type ImageAccessGuardContextValue = {
  runWithImageAccessTurnstile: <T>(runner: () => Promise<T>) => Promise<T>;
};

const ImageAccessGuardContext = createContext<ImageAccessGuardContextValue | null>(null);

function ImageAccessGuardProvider({ children }: { children: React.ReactNode }) {
  const client = useApiClient();
  const { push } = useToast();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [tokenKey, setTokenKey] = useState(0);
  const [verifying, setVerifying] = useState(false);
  const pendingRef = useRef<{ resolve: () => void; reject: (error: any) => void } | null>(null);
  const verificationPromiseRef = useRef<Promise<void> | null>(null);

  const beginVerification = () => {
    if (verificationPromiseRef.current) {
      return verificationPromiseRef.current;
    }
    const promise = new Promise<void>((resolve, reject) => {
      pendingRef.current = { resolve, reject };
      setToken(null);
      setTokenKey((v) => v + 1);
      setOpen(true);
    });
    verificationPromiseRef.current = promise.finally(() => {
      verificationPromiseRef.current = null;
      pendingRef.current = null;
    });
    return verificationPromiseRef.current;
  };

  const runWithImageAccessTurnstile = async <T,>(runner: () => Promise<T>) => {
    try {
      return await runner();
    } catch (e: any) {
      if (e?.error?.code !== "TURNSTILE_REQUIRED" || e?.error?.details?.turnstile_scope !== "image_access") {
        throw e;
      }
    }

    await beginVerification();
    return await runner();
  };

  const closeModal = (error?: any) => {
    setOpen(false);
    setToken(null);
    if (error) {
      pendingRef.current?.reject(error);
      return;
    }
    pendingRef.current?.resolve();
  };

  const confirm = async () => {
    if (!token) return;
    setVerifying(true);
    try {
      await client.verifyImageAccessTurnstile(token);
      closeModal();
    } catch (e: any) {
      setToken(null);
      setTokenKey((v) => v + 1);
      push({ kind: "error", title: "校验失败", message: e?.error?.message || "请重试" });
    } finally {
      setVerifying(false);
    }
  };

  return (
    <ImageAccessGuardContext.Provider value={{ runWithImageAccessTurnstile }}>
      {children}
      <TurnstilePromptModal
        open={open}
        title="继续查看前需要验证"
        description="请先完成一次 Cloudflare Turnstile 验证，然后继续当前的图片查看或下载操作。"
        token={token}
        tokenKey={tokenKey}
        setToken={setToken}
        loading={verifying}
        confirmLabel="继续查看"
        onClose={() => {
          if (verifying) return;
          closeModal({ error: { code: "TURNSTILE_CANCELLED", message: "Verification cancelled" } });
        }}
        onConfirm={confirm}
      />
    </ImageAccessGuardContext.Provider>
  );
}

function useImageAccessGuard() {
  const value = useContext(ImageAccessGuardContext);
  if (!value) {
    throw new Error("ImageAccessGuardProvider is required");
  }
  return value;
}

function LoginPage() {
  const client = useApiClient();
  const navigate = useNavigate();
  const { push } = useToast();
  const setSession = useAuthStore((s) => s.setSession);
  const settings = useSettingsStore((s) => s.settings);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileKey, setTurnstileKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const handleLogin = async () => {
    if (!username.trim() || !password) {
      push({ kind: "error", title: "请输入账号和密码" });
      return;
    }
    if (!turnstileToken) {
      push({ kind: "error", title: "请先完成 Turnstile 验证" });
      return;
    }

    setSubmitting(true);
    try {
      const session = await client.login(username.trim(), password, turnstileToken);
      useJobsStore.getState().scopeJobs(session.user.user_id);
      setSession(session);
      push({ kind: "success", title: `欢迎，${session.user.username}` });
      navigate("/", { replace: true });
    } catch (e: any) {
      setTurnstileKey((v) => v + 1);
      setTurnstileToken(null);
      push({ kind: "error", title: "登录失败", message: e?.error?.message || "请检查账号、密码或验证状态" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(251,191,36,0.18),_transparent_30%),radial-gradient(circle_at_bottom_right,_rgba(59,130,246,0.16),_transparent_28%),linear-gradient(135deg,#f8fafc,#eef2ff_45%,#f5f5f4)] text-zinc-900 dark:bg-[radial-gradient(circle_at_top_left,_rgba(245,158,11,0.16),_transparent_30%),radial-gradient(circle_at_bottom_right,_rgba(14,165,233,0.16),_transparent_28%),linear-gradient(135deg,#09090b,#111827_45%,#0f172a)] dark:text-zinc-50">
      <div className="mx-auto grid min-h-screen max-w-6xl grid-cols-1 gap-6 px-4 py-8 lg:grid-cols-[1.15fr_0.85fr] lg:items-center">
        <div className="rounded-[32px] border border-white/60 bg-white/70 p-8 shadow-[0_40px_120px_rgba(15,23,42,0.12)] backdrop-blur dark:border-white/10 dark:bg-white/[0.04]">
          <div className="inline-flex items-center gap-3 rounded-full border border-zinc-200 bg-white/80 px-4 py-2 text-xs font-semibold uppercase tracking-[0.24em] text-zinc-600 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-300">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-900 text-white dark:bg-white dark:text-zinc-900">NB</span>
            Secure Access
          </div>
          <div className="mt-8 max-w-xl">
            <div className="text-4xl font-black tracking-tight text-zinc-950 dark:text-white sm:text-5xl">
              Nano Banana Pro
            </div>
            <div className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-300">
              一个围绕文生图工作流打造的控制台，支持稳定创建、任务追踪、结果回看与浏览器端协作体验。
            </div>
          </div>

          <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Card className="border-amber-200/70 bg-amber-50/80 dark:border-amber-900/60 dark:bg-amber-950/30" hover={false}>
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-700 dark:text-amber-200">Studio</div>
              <div className="mt-2 text-sm text-zinc-700 dark:text-zinc-200">统一入口管理创作、任务流、结果挑选和历史记录。</div>
            </Card>
            <Card className="border-sky-200/70 bg-sky-50/80 dark:border-sky-900/60 dark:bg-sky-950/30" hover={false}>
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700 dark:text-sky-200">Turnstile</div>
              <div className="mt-2 text-sm text-zinc-700 dark:text-zinc-200">每次登录都要求通过 Cloudflare Turnstile 验证。</div>
            </Card>
            <Card className="border-emerald-200/70 bg-emerald-50/80 dark:border-emerald-900/60 dark:bg-emerald-950/30" hover={false}>
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-200">Session Cookie</div>
              <div className="mt-2 text-sm text-zinc-700 dark:text-zinc-200">认证状态通过 cookie session 持久化，刷新页面无需重新登录。</div>
            </Card>
          </div>
        </div>

        <Card className="border-zinc-900/10 bg-white/88 p-6 shadow-[0_32px_80px_rgba(15,23,42,0.14)] dark:border-white/10 dark:bg-zinc-950/85" hover={false}>
          <div className="text-sm font-semibold uppercase tracking-[0.22em] text-zinc-500 dark:text-zinc-400">Password Login</div>
          <div className="mt-2 text-2xl font-black text-zinc-950 dark:text-white">进入控制台</div>
          <div className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">当前后端地址：{settings.baseUrl}</div>

          <div className="mt-6 space-y-4">
            <Field label="username">
              <Input value={username} onChange={setUsername} placeholder="请输入账号" />
            </Field>
            <Field label="password">
              <Input value={password} onChange={setPassword} placeholder="请输入密码" type="password" />
            </Field>
            <Field label="Cloudflare Turnstile">
              <div className="rounded-2xl border border-zinc-200 bg-zinc-50/80 p-4 dark:border-white/10 dark:bg-white/[0.03]">
                <TurnstileWidget key={turnstileKey} onTokenChange={setTurnstileToken} />
              </div>
            </Field>
          </div>

          <div className="mt-6 flex items-center justify-between gap-3">
            <div className="text-xs text-zinc-500 dark:text-zinc-400">
              登录失败后会自动刷新验证组件。
            </div>
            <Button variant="primary" onClick={handleLogin} disabled={submitting || !turnstileToken}>
              {submitting ? "登录中…" : "登录"}
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

// -----------------------------
// Dashboard logic
// -----------------------------

type DashboardStat = {
  today_count: number;
  today_success: number;
  today_failed: number;
  today_success_rate: number;
  today_total_tokens: number;
  today_total_cost_usd: number;
  today_avg_latency_ms: number;
  today_p95_latency_ms: number;

  recent10_success_rate: number;
  recent10_avg_latency_ms: number;
  recent10_avg_cost_usd: number;
  recent10_avg_image_cost_usd: number;

  failure_top: Array<{ name: string; value: number }>;
  image_size_dist: Array<{ name: string; value: number }>;
  aspect_ratio_dist: Array<{ name: string; value: number }>;
  temperature_dist: Array<{ name: string; value: number }>;

  trend_tokens: Array<{ t: string; tokens: number }>;
  trend_cost: Array<{ t: string; cost: number }>;
};

type DashboardCache = {
  date: string;
  computed_at: string;
  stats: DashboardStat;
};

function computeDashboard(jobs: JobRecord[], metas: Array<JobMeta | null>): DashboardStat {
  const now = new Date();
  const todayISO = now.toISOString();

  const todayJobs: Array<{ rec: JobRecord; meta?: JobMeta | null }> = [];
  const recentJobs: Array<{ rec: JobRecord; meta?: JobMeta | null }> = [];

  const sorted = [...jobs]
    .filter((j) => !j.deleted)
    .sort((a, b) => (new Date(b.created_at).getTime() || 0) - (new Date(a.created_at).getTime() || 0));

  for (let i = 0; i < sorted.length; i++) {
    const rec = sorted[i];
    const meta = metas[i] || null;
    const created = rec.created_at || meta?.created_at || "";
    if (created && isSameDayISO(created, todayISO)) {
      todayJobs.push({ rec, meta });
    }
    if (recentJobs.length < 10) {
      recentJobs.push({ rec, meta });
    }
  }

  const todayStatuses = todayJobs.map((x) => pickStatus(x.meta || undefined, x.rec));
  const today_count = todayJobs.length;
  const today_success = todayStatuses.filter((s) => s === "SUCCEEDED").length;
  const today_failed = todayStatuses.filter((s) => s === "FAILED").length;
  const today_success_rate = today_count ? today_success / today_count : 0;

  const today_total_tokens = todayJobs
    .map((x) => x.meta?.usage?.total_token_count || 0)
    .reduce((a, b) => a + b, 0);
  const today_total_cost_usd = todayJobs
    .map((x) => x.meta?.billing?.estimated_cost_usd || 0)
    .reduce((a, b) => a + b, 0);

  const today_latencies = todayJobs
    .map((x) => extractRunDurationMs(x.meta || undefined, x.rec))
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0);
  const today_avg_latency_ms = today_latencies.length ? mean(today_latencies) : 0;
  const today_p95_latency_ms = today_latencies.length ? percentile(today_latencies, 95) : 0;

  const recent_statuses = recentJobs.map((x) => pickStatus(x.meta || undefined, x.rec));
  const recent10_success_rate = recentJobs.length
    ? recent_statuses.filter((s) => s === "SUCCEEDED").length / recentJobs.length
    : 0;

  const recent_lat = recentJobs
    .map((x) => extractRunDurationMs(x.meta || undefined, x.rec))
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0);
  const recent10_avg_latency_ms = recent_lat.length ? mean(recent_lat) : 0;

  const recent_cost = recentJobs
    .map((x) => x.meta?.billing?.estimated_cost_usd)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0);
  const recent10_avg_cost_usd = recent_cost.length ? mean(recent_cost) : 0;

  const recent_img_cost = recentJobs
    .map((x) => x.meta?.billing?.image_output_cost_usd)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0);
  const recent10_avg_image_cost_usd = recent_img_cost.length ? mean(recent_img_cost) : 0;

  // Failure analysis (near 7 days / 30 jobs)
  const cutoff = new Date(daysAgoISO(7)).getTime();
  const failureMap = new Map<string, number>();
  const scoped = sorted.slice(0, 30);
  for (let i = 0; i < scoped.length; i++) {
    const rec = scoped[i];
    const meta = metas[i] || null;
    const t = new Date(rec.created_at || meta?.created_at || 0).getTime();
    if (!Number.isFinite(t) || t < cutoff) continue;
    const st = pickStatus(meta || undefined, rec);
    if (st !== "FAILED") continue;
    const name = meta?.error?.type || "UNKNOWN_ERROR";
    failureMap.set(name, (failureMap.get(name) || 0) + 1);
  }
  const failure_top = [...failureMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, value]) => ({ name, value }));

  // Distributions from local cached params
  const dist = (key: keyof DefaultParams) => {
    const map = new Map<string, number>();
    for (const j of sorted.slice(0, 200)) {
      const v = (j.params_cache as any)?.[key];
      if (!v) continue;
      const k = String(v);
      map.set(k, (map.get(k) || 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value }));
  };

  const image_size_dist = dist("image_size");
  const aspect_ratio_dist = dist("aspect_ratio");

  // Temperature bucket
  const tempMap = new Map<string, number>();
  for (const j of sorted.slice(0, 200)) {
    const v = (j.params_cache as any)?.temperature;
    if (typeof v !== "number") continue;
    const bucket = v < 0.3 ? "<0.3" : v < 0.7 ? "0.3~0.7" : v < 1.0 ? "0.7~1.0" : ">=1.0";
    tempMap.set(bucket, (tempMap.get(bucket) || 0) + 1);
  }
  const temperature_dist = [...tempMap.entries()].map(([name, value]) => ({ name, value }));

  // Trend for today: bucket by hour
  const bucketTokens = new Map<string, number>();
  const bucketCost = new Map<string, number>();
  for (const x of todayJobs) {
    const ts = x.rec.created_at || x.meta?.created_at;
    if (!ts) continue;
    const d = new Date(ts);
    const h = String(d.getHours()).padStart(2, "0") + ":00";
    bucketTokens.set(h, (bucketTokens.get(h) || 0) + (x.meta?.usage?.total_token_count || 0));
    bucketCost.set(h, (bucketCost.get(h) || 0) + (x.meta?.billing?.estimated_cost_usd || 0));
  }
  const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0") + ":00");
  const trend_tokens = hours.map((t) => ({ t, tokens: bucketTokens.get(t) || 0 }));
  const trend_cost = hours.map((t) => ({ t, cost: bucketCost.get(t) || 0 }));

  return {
    today_count,
    today_success,
    today_failed,
    today_success_rate,
    today_total_tokens,
    today_total_cost_usd,
    today_avg_latency_ms,
    today_p95_latency_ms,

    recent10_success_rate,
    recent10_avg_latency_ms,
    recent10_avg_cost_usd,
    recent10_avg_image_cost_usd,

    failure_top,
    image_size_dist,
    aspect_ratio_dist,
    temperature_dist,

    trend_tokens,
    trend_cost,
  };
}

function useDashboardData() {
  const client = useApiClient();
  const { push } = useToast();
  const settings = useSettingsStore((s) => s.settings);
  const jobs = useJobsStore((s) => s.jobs);
  const { isAdmin } = useAuthSession();

  const [refreshing, setRefreshing] = useState(false);
  const [stats, setStats] = useState<DashboardStat | null>(null);
  const [admin, setAdmin] = useState<ProviderSummary | null>(null);

  const refresh = async ({ manual = false }: { manual?: boolean } = {}) => {
    const today = new Date().toISOString().slice(0, 10);

    // cache read (best effort)
    const cache = safeJsonParse<DashboardCache | null>(storageGet(KEY_DASH_CACHE), null);
    if (cache?.date === today && cache?.stats) {
      setStats(cache.stats);
    }

    setRefreshing(true);
    try {
      const list = [...jobs]
        .filter((j) => !j.deleted)
        .sort((a, b) => (new Date(b.created_at).getTime() || 0) - (new Date(a.created_at).getTime() || 0));

      // limit number of fetches for v1
      const MAX = list.length > 200 ? 50 : Math.max(1, Math.min(200, list.length));
      const subset = list.slice(0, MAX);

      const refs: JobAccessRef[] = subset.map((rec) => ({
        job_id: rec.job_id,
        job_access_token: rec.job_access_token,
      }));

      let computed: DashboardStat | null = null;

      try {
        const summary = await client.dashboardSummary(refs, MAX);
        if (summary?.stats) {
          computed = summary.stats;
        }
        (summary?.updates || []).forEach((u) => {
          useJobsStore.getState().updateJob(u.job_id, {
            status_cache: (u.status || "UNKNOWN") as JobStatus,
            model_cache: (u.model as ModelId) || undefined,
            last_seen_at: isoNow(),
            ...jobTimingPatch({ job_id: u.job_id, timing: u.timing || {} } as JobMeta),
          });
        });
      } catch {
        // backward compatibility: old backend without summary endpoint
      }

      if (!computed) {
        let metas: Array<JobMeta | null> | null = null;
        try {
          const batch = await client.batchMeta(refs, [
            "job_id",
            "status",
            "model",
            "created_at",
            "updated_at",
            "params",
            "timing",
            "usage",
            "billing",
            "response",
            "error",
          ]);
          const byId = new Map<string, JobMeta>();
          (batch.items || []).forEach((it) => {
            byId.set(it.job_id, it.meta);
            useJobsStore.getState().updateJob(it.job_id, {
              last_seen_at: isoNow(),
              ...jobMetaCachePatch(it.meta),
            });
          });
          metas = subset.map((rec) => byId.get(rec.job_id) || null);
        } catch {
          // old backend fallback
        }

        if (!metas) {
          metas = await mapLimit(subset, clamp(settings.polling.concurrency || 5, 1, 12), async (rec) => {
            try {
              const meta = await client.getJob(rec.job_id, rec.job_access_token);
              useJobsStore.getState().updateJob(rec.job_id, {
                last_seen_at: isoNow(),
                ...jobMetaCachePatch(meta),
              });
              return meta;
            } catch (e: any) {
              return null;
            }
          });
        }

        const alignedMetas: Array<JobMeta | null> = [];
        for (let i = 0; i < list.length; i++) {
          alignedMetas.push(i < subset.length ? metas[i] : null);
        }
        computed = computeDashboard(list, alignedMetas);
      }

      setStats(computed);
      storageSet(
        KEY_DASH_CACHE,
        JSON.stringify({ date: today, computed_at: isoNow(), stats: computed } satisfies DashboardCache)
      );

      if (isAdmin) {
        try {
          const providers = await client.adminProviders();
          setAdmin(providers);
        } catch (e: any) {
          setAdmin(null);
        }
      } else {
        setAdmin(null);
      }

      if (manual) {
        push({ kind: "success", title: "Dashboard 已刷新" });
      }
    } catch (e: any) {
      if (manual) {
        push({ kind: "error", title: "刷新失败", message: e?.error?.message || "请检查网络/后端地址" });
      }
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    refresh({ manual: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.baseUrl, isAdmin]);

  const loading = refreshing && !stats;
  return { loading, refreshing, stats, admin, refresh };
}

function KpiCard({
  title,
  value,
  sub,
  loading,
}: {
  title: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  loading?: boolean;
}) {
  return (
    <Card className="p-4" hover>
      <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">{title}</div>
      <div className="mt-2 text-2xl font-extrabold text-zinc-900 dark:text-zinc-50">
        {loading ? <Skeleton className="h-7 w-24" /> : value}
      </div>
      {sub ? (
        <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
          {loading ? <Skeleton className="h-4 w-40" /> : sub}
        </div>
      ) : null}
    </Card>
  );
}

function DashboardPage() {
  const { loading, refreshing, stats, admin, refresh } = useDashboardData();
  const nav = useNavigate();
  const { isAdmin } = useAuthSession();

  const cards = (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <KpiCard title="今日任务" value={stats?.today_count ?? "-"} loading={loading} />
      <KpiCard
        title="成功率"
        value={stats ? `${Math.round(stats.today_success_rate * 100)}%` : "-"}
        sub={stats ? `${stats.today_success}/${stats.today_count} 成功` : undefined}
        loading={loading}
      />
      <KpiCard title="今日 Token" value={stats ? numberish(stats.today_total_tokens) : "-"} loading={loading} />
      <KpiCard title="今日费用" value={stats ? currency(stats.today_total_cost_usd) : "-"} loading={loading} />
      <KpiCard
        title="平均耗时"
        value={stats ? formatLatencyAdaptive(stats.today_avg_latency_ms) : "-"}
        sub={stats ? `P95 ${formatLatencyAdaptive(stats.today_p95_latency_ms)}` : undefined}
        loading={loading}
      />
      <KpiCard
        title="最近 10 次"
        value={stats ? `${Math.round(stats.recent10_success_rate * 100)}%` : "-"}
        sub={stats ? `均耗时 ${formatLatencyAdaptive(stats.recent10_avg_latency_ms)}` : undefined}
        loading={loading}
      />
    </div>
  );

  return (
    <PageContainer>
      <PageTitle
        title="Dashboard"
        subtitle="本地历史驱动：前端读取浏览器保存的 job 列表，再逐个拉取真实详情用于统计。"
        right={
          <Button onClick={() => refresh({ manual: true })} variant="secondary" disabled={refreshing}>
            刷新
            {refreshing ? (
              <motion.span
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, duration: 0.9, ease: "linear" }}
                className="inline-block h-3.5 w-3.5 rounded-full border-2 border-zinc-400 border-t-transparent dark:border-zinc-400 dark:border-t-transparent"
                aria-hidden
              />
            ) : null}
          </Button>
        }
      />

      {cards}

      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">今日趋势</div>
              <div className="text-xs text-zinc-600 dark:text-zinc-300">按小时分桶（Token / Cost）</div>
            </div>
          </div>
          <div className="mt-3 h-[260px]">
            {loading || !stats ? (
              <div className="space-y-2">
                <Skeleton className="h-6 w-40" />
                <Skeleton className="h-[220px] w-full" />
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={stats.trend_tokens} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis dataKey="t" tick={{ fontSize: 11 }} interval={3} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Line type="monotone" dataKey="tokens" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
          {!loading && stats ? (
            <div className="mt-2 h-[180px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={stats.trend_cost} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis dataKey="t" tick={{ fontSize: 11 }} interval={3} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Line type="monotone" dataKey="cost" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : null}
        </Card>

        <Card>
          <div>
            <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">失败分析</div>
            <div className="text-xs text-zinc-600 dark:text-zinc-300">近 7 天 / 近 30 次</div>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="h-[260px]">
              {loading || !stats ? (
                <Skeleton className="h-full w-full" />
              ) : stats.failure_top.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stats.failure_top} margin={{ left: 0, right: 10, top: 10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                    <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-15} height={60} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="value" radius={[10, 10, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <EmptyHint text="近 7 天没有失败记录" />
              )}
            </div>

            <div className="h-[260px]">
              {loading || !stats ? (
                <Skeleton className="h-full w-full" />
              ) : stats.image_size_dist.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Tooltip />
                    <Legend />
                    <Pie data={stats.image_size_dist.slice(0, 6)} dataKey="value" nameKey="name" outerRadius={90}>
                      {stats.image_size_dist.slice(0, 6).map((_, i) => (
                        <Cell key={i} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <EmptyHint text="暂无 image_size 分布" />
              )}
            </div>
          </div>

          <Divider />

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <MiniList title="aspect_ratio 分布" items={stats?.aspect_ratio_dist?.slice(0, 6) || []} loading={loading} />
            <MiniList title="temperature 分布" items={stats?.temperature_dist?.slice(0, 6) || []} loading={loading} />
          </div>
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">最近任务</div>
              <div className="text-xs text-zinc-600 dark:text-zinc-300">点击进入 History 详情</div>
            </div>
            <Button variant="ghost" onClick={() => nav("/history")}>查看全部 →</Button>
          </div>
          <div className="mt-3">
            <RecentJobsPanel loading={loading} />
          </div>
        </Card>

        {isAdmin ? (
          <Card>
            <div>
              <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">管理视图</div>
              <div className="text-xs text-zinc-600 dark:text-zinc-300">多中转站余额与运行状态摘要。</div>
            </div>
            <Divider />
            {!admin ? (
              <EmptyHint text="管理数据暂不可用" />
            ) : (
              <div className="space-y-3">
                <KeyValue k="Providers" v={String(admin.providers_total)} />
                <KeyValue k="Healthy" v={String(admin.providers_healthy)} />
                <KeyValue k="Spent" v={`${numberish(admin.spent_cny)} CNY`} />
                <KeyValue k="Remaining" v={`${numberish(admin.remaining_balance_cny)} CNY`} />
                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                  {admin.last_updated_at ? `Updated: ${formatLocal(admin.last_updated_at)}` : ""}
                </div>
                <Divider />
                <MiniList
                  title="Provider 状态"
                  items={admin.providers.map((item) => ({ name: item.label, value: item.enabled && !item.cooldown_active ? 1 : 0 })).slice(0, 6)}
                />
              </div>
            )}
          </Card>
        ) : null}
      </div>
    </PageContainer>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center rounded-2xl border border-dashed border-zinc-200 p-6 text-sm text-zinc-500 dark:border-white/10 dark:text-zinc-400">
      {text}
    </div>
  );
}

function MiniList({
  title,
  items,
  loading,
}: {
  title: string;
  items: Array<{ name: string; value: number }>;
  loading?: boolean;
}) {
  return (
    <div>
      <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">{title}</div>
      <div className="mt-2 space-y-2">
        {loading ? (
          <>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-2/3" />
          </>
        ) : items.length ? (
          items.map((it) => (
            <div key={it.name} className="flex items-center justify-between text-sm">
              <div className="truncate pr-2 text-zinc-700 dark:text-zinc-200">{it.name}</div>
              <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">{it.value}</div>
            </div>
          ))
        ) : (
          <div className="text-sm text-zinc-500 dark:text-zinc-400">暂无</div>
        )}
      </div>
    </div>
  );
}

function KeyValue({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">{k}</div>
      <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">{v}</div>
    </div>
  );
}

function RecentJobsPanel({ loading }: { loading: boolean }) {
  const jobs = useJobsStore((s) => s.jobs);
  const nav = useNavigate();
  const recent = useMemo(
    () =>
      [...jobs]
        .filter((j) => !j.deleted)
        .sort((a, b) => (new Date(b.created_at).getTime() || 0) - (new Date(a.created_at).getTime() || 0))
        .slice(0, 10),
    [jobs]
  );

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-2xl border border-zinc-200/70 p-3 dark:border-white/10">
            <Skeleton className="h-4 w-2/3" />
            <div className="mt-2 flex gap-2">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (!recent.length) return <EmptyHint text="本地暂无历史记录，请先创建任务" />;

  return (
    <div className="space-y-2">
      {recent.map((j) => (
        <button
          key={j.job_id}
          onClick={() => nav(`/history?job=${encodeURIComponent(j.job_id)}`)}
          className="group w-full rounded-2xl border border-zinc-200/70 bg-white/50 p-3 text-left transition hover:-translate-y-0.5 hover:shadow-sm dark:border-white/10 dark:bg-zinc-950/30"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-bold text-zinc-900 dark:text-zinc-50">
                {j.prompt_preview || shortId(j.job_id)}
              </div>
              <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">{formatLocal(j.created_at)}</div>
            </div>
            <Badge status={j.status_cache || "UNKNOWN"} />
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs text-zinc-600 dark:text-zinc-300">
            {j.model_cache ? <Chip text={`model: ${j.model_cache}`} /> : null}
            {j.params_cache?.image_size ? <Chip text={`image_size: ${j.params_cache.image_size}`} /> : null}
            {j.params_cache?.aspect_ratio ? <Chip text={`aspect_ratio: ${j.params_cache.aspect_ratio}`} /> : null}
            {j.tags?.length ? <Chip text={`tags: ${j.tags.join(", ")}`} /> : null}
          </div>
        </button>
      ))}
    </div>
  );
}

function Chip({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-zinc-200 bg-white/60 px-2 py-0.5 dark:border-white/10 dark:bg-zinc-900/60">
      {text}
    </span>
  );
}

// -----------------------------
// Create Job Page
// -----------------------------

type CreateMode = JobMode;

function mergeReferenceFiles(existing: File[], incoming: File[], maxFiles: number) {
  const next = [...existing];
  const seen = new Set(existing.map((f) => `${f.name}:${f.size}:${f.lastModified}`));
  for (const file of incoming) {
    const sig = `${file.name}:${file.size}:${file.lastModified}`;
    if (seen.has(sig)) continue;
    next.push(file);
    seen.add(sig);
    if (next.length >= maxFiles) break;
  }
  return next;
}

function ImageDropzone({
  files,
  setFiles,
  maxFiles,
}: {
  files: File[];
  setFiles: React.Dispatch<React.SetStateAction<File[]>>;
  maxFiles: number;
}) {
  const { push } = useToast();
  const [drag, setDrag] = useState(false);

  const onPick = (list: FileList | null) => {
    if (!list) return;
    const picked = Array.from(list);
    const onlyImages = picked.filter((f) => f.type.startsWith("image/"));
    if (onlyImages.length !== picked.length) {
      push({ kind: "info", title: "已忽略非图片文件" });
    }
    if (!onlyImages.length) return;
    setFiles((prev) => mergeReferenceFiles(prev, onlyImages, maxFiles));
    if (files.length >= maxFiles || files.length + onlyImages.length > maxFiles) {
      push({ kind: "info", title: `最多 ${maxFiles} 张参考图` });
    }
  };

  const removeAt = (i: number) => {
    const next = [...files];
    next.splice(i, 1);
    setFiles(next);
  };

  return (
    <div>
      <div
        className={cn(
          "rounded-2xl border border-dashed p-4 transition",
          drag
            ? "border-sky-400 bg-sky-50 dark:border-sky-600 dark:bg-sky-950/30"
            : "border-zinc-200 bg-white/50 dark:border-white/10 dark:bg-zinc-950/30"
        )}
        onDragEnter={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setDrag(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          onPick(e.dataTransfer.files);
        }}
      >
        <div className="flex flex-col items-center justify-center gap-2 text-center">
          <div className="text-2xl">🖼️</div>
          <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">拖拽上传参考图</div>
          <div className="text-xs text-zinc-600 dark:text-zinc-300">最多 {maxFiles} 张，图片格式（image/*）</div>
          <label className="mt-2">
            <input
              type="file"
              multiple
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                onPick(e.target.files);
                e.currentTarget.value = "";
              }}
            />
            <span className="inline-flex cursor-pointer items-center rounded-xl bg-zinc-900 px-3 py-2 text-sm font-semibold text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100">
              选择文件
            </span>
          </label>
        </div>
      </div>

      {files.length ? (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {files.map((f, i) => (
            <ImageThumb key={`${f.name}_${i}`} file={f} onRemove={() => removeAt(i)} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ImageThumb({ file, onRemove }: { file: File; onRemove: () => void }) {
  const { push } = useToast();
  const [url, setUrl] = useState<string>("");
  const [phase, setPhase] = useState<"loading" | "ok" | "error">("loading");
  const triedFallbackRef = useRef(false);

  useEffect(() => {
    triedFallbackRef.current = false;
    setPhase("loading");

    // 优先使用 blob: URL（性能最好）；若在线预览环境 CSP 禁止 blob:，会触发 onError 再降级为 data: URL。
    const u = URL.createObjectURL(file);
    setUrl(u);

    return () => {
      try {
        URL.revokeObjectURL(u);
      } catch {
        // ignore
      }
    };
  }, [file]);

  const tryFallback = async () => {
    if (triedFallbackRef.current) return;
    triedFallbackRef.current = true;
    try {
      const dataUrl = await blobToDataURL(file);
      setUrl(dataUrl);
      setPhase("loading");
    } catch {
      setPhase("error");
      push({
        kind: "error",
        title: "参考图预览失败",
        message: "可能被在线预览环境的 CSP/沙箱策略拦截（blob/data URL）。",
      });
    }
  };

  return (
    <div className="group relative overflow-hidden rounded-2xl border border-zinc-200 bg-white/60 dark:border-white/10 dark:bg-zinc-900/50">
      {phase === "error" ? (
        <div className="flex h-28 w-full items-center justify-center bg-zinc-100 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          预览不可用（可能被 CSP 拦截）
        </div>
      ) : (
        <img
          src={url}
          alt={file.name}
          className="h-28 w-full object-cover opacity-0 blur-sm transition duration-300"
          onLoad={(e) => {
            const img = e.currentTarget;
            img.classList.remove("opacity-0", "blur-sm");
            img.classList.add("opacity-100");
            setPhase("ok");
          }}
          onError={(e) => {
            const img = e.currentTarget;
            img.classList.remove("opacity-0", "blur-sm");
            img.classList.add("opacity-100");
            tryFallback();
          }}
        />
      )}

      <button
        type="button"
        onClick={onRemove}
        className="absolute right-2 top-2 rounded-full bg-black/60 px-2 py-1 text-xs font-bold text-white opacity-0 transition group-hover:opacity-100"
        title="删除"
      >
        ✕
      </button>
      <div className="absolute bottom-0 left-0 right-0 bg-black/40 p-1 text-[10px] text-white">
        <div className="truncate">{file.name}</div>
      </div>
    </div>
  );
}

function AdminUserRiskChip({ label }: { label: string }) {
  const tone =
    label === "disabled"
      ? "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
      : label === "over quota" || label === "image access cap"
        ? "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-200"
        : label === "running jobs" || label === "high usage"
          ? "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-200"
          : label === "high failures"
            ? "bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-200"
            : label === "admin"
              ? "bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-200"
              : "bg-zinc-100 text-zinc-600 dark:bg-zinc-900/60 dark:text-zinc-300";
  return <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", tone)}>{label}</span>;
}

function AdminJsonDisclosure({
  title,
  value,
  defaultOpen = false,
}: {
  title: string;
  value: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details
      open={defaultOpen}
      className="overflow-hidden rounded-2xl border border-zinc-200 bg-white/70 dark:border-white/10 dark:bg-zinc-950/30"
    >
      <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-zinc-900 marker:content-none dark:text-zinc-50">
        {title}
      </summary>
      <div className="border-t border-zinc-200/80 px-4 py-3 dark:border-white/10">{value}</div>
    </details>
  );
}

function AdminTaskCard({
  item,
  preview,
  density,
  onOpen,
}: {
  item: AdminUserJobSummary;
  preview?: HistoryPreviewEntry;
  density: AdminTaskDensity;
  onOpen: () => void;
}) {
  const rec = adminJobSummaryToRecord(item);
  const reason = summarizeQueueOrFailure(null, rec);
  const riskText = item.error?.message || reason || (item.section_title ? `Section · ${item.section_title}` : `job_id · ${shortId(item.job_id, 8)}`);
  const cardClass =
    density === "list"
      ? "grid grid-cols-[180px_minmax(0,1fr)] items-stretch gap-0"
      : "block";
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="admin-task-card"
      className={cn(
        "group overflow-hidden rounded-[28px] border border-zinc-200/90 bg-white text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-xl dark:border-white/10 dark:bg-zinc-950/60",
        cardClass
      )}
    >
      <div className="relative">
        <HistoryPreviewTile rec={rec} preview={preview} className={density === "list" ? "aspect-[5/4] h-full" : "aspect-[4/5]"} />
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3">
          {item.batch_name ? (
            <span className="max-w-[72%] truncate rounded-full bg-white/90 px-2.5 py-1 text-[10px] font-semibold text-emerald-700 shadow-sm backdrop-blur dark:bg-zinc-950/80 dark:text-emerald-200">
              {item.batch_name}
            </span>
          ) : <span />}
          <Badge status={item.status} />
        </div>
      </div>
      <div className="space-y-2.5 px-3.5 py-3">
        <div className="flex items-center justify-between gap-3 text-[11px] text-zinc-500 dark:text-zinc-400">
          <span className="truncate">{formatLocal(item.created_at)}</span>
          <span className="truncate font-mono">{shortId(item.job_id, 6)}</span>
        </div>
        <div className="line-clamp-2 text-sm font-semibold leading-5 text-zinc-900 dark:text-zinc-50">
          {item.prompt_preview || shortId(item.job_id)}
        </div>
        <div className="line-clamp-2 min-h-[2rem] text-[11px] leading-5 text-zinc-500 dark:text-zinc-400">
          {riskText}
        </div>
        <div className="flex flex-wrap gap-1 text-[10px] text-zinc-500 dark:text-zinc-400">
          {item.model ? <span className="rounded-full border border-zinc-200 px-2 py-0.5 dark:border-white/10">{item.model}</span> : null}
          <span className="rounded-full border border-zinc-200 px-2 py-0.5 dark:border-white/10">{item.image_count || 0} imgs</span>
          {typeof item.timing?.run_duration_ms === "number" ? (
            <span className="rounded-full border border-zinc-200 px-2 py-0.5 dark:border-white/10">{formatDurationMs(item.timing.run_duration_ms)}</span>
          ) : null}
        </div>
      </div>
    </button>
  );
}

function AdminTaskDetailDrawer({
  item,
  owner,
  onClose,
  onRemoved,
  onRefreshList,
}: {
  item: AdminUserJobSummary | null;
  owner: AdminUserItem | null;
  onClose: () => void;
  onRemoved: (jobId: string) => void;
  onRefreshList: () => Promise<void> | void;
}) {
  const client = useApiClient();
  const settings = useSettingsStore((s) => s.settings);
  const { push } = useToast();
  const rec = useMemo(() => (item ? adminJobSummaryToRecord(item) : null), [item]);
  const { meta, loading, error, refresh } = useJobLive(rec?.job_id || null, undefined);

  const [reqSnap, setReqSnap] = useState<any | null>(null);
  const [respSnap, setRespSnap] = useState<any | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [fullUrls, setFullUrls] = useState<Record<string, string>>({});
  const [previewBlobs, setPreviewBlobs] = useState<Record<string, Blob>>({});
  const [fullBlobs, setFullBlobs] = useState<Record<string, Blob>>({});
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [refUrls, setRefUrls] = useState<Record<string, string>>({});
  const [actionLoading, setActionLoading] = useState<"cancel" | "retry" | "delete" | null>(null);
  const previewRevokeRef = useRef<string[]>([]);
  const fullRevokeRef = useRef<string[]>([]);
  const refRevokeRef = useRef<string[]>([]);
  const cacheScope = `admin:${owner?.user_id || item?.owner?.user_id || "__admin__"}`;
  const status = pickStatus(meta || undefined, rec || undefined);
  const imageIds = useMemo(() => extractImageIdsFromResult(meta?.result), [meta?.result]);
  const requestPrompt = reqSnap?.request?.prompt || rec?.prompt_preview || "";
  const requestRefs = useMemo(
    () => (Array.isArray(reqSnap?.request?.reference_images) ? reqSnap.request.reference_images : EMPTY_REFERENCE_LIST),
    [reqSnap?.request?.reference_images]
  );
  const requestRefsKey = useMemo(
    () => requestRefs.map((entry: any) => String(entry?.filename || "")).filter(Boolean).join("|"),
    [requestRefs]
  );
  const requestPreview = item?.prompt_preview || requestPrompt || "-";
  const confirmTail = item?.job_id ? item.job_id.slice(-6) : "";

  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item, onClose]);

  useEffect(() => {
    setReqSnap(null);
    setRespSnap(null);
    setPreviewUrls({});
    setFullUrls({});
    setPreviewBlobs({});
    setFullBlobs({});
    setSelectedImageId(null);
    setRefUrls({});
  }, [item?.job_id]);

  useEffect(() => {
    return () => {
      previewRevokeRef.current.forEach((url) => URL.revokeObjectURL(url));
      fullRevokeRef.current.forEach((url) => URL.revokeObjectURL(url));
      refRevokeRef.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  useEffect(() => {
    if (!item) return;
    let stopped = false;
    setDebugLoading(true);
    Promise.allSettled([client.getJobRequest(item.job_id), client.getJobResponse(item.job_id)])
      .then(([requestResult, responseResult]) => {
        if (stopped) return;
        setReqSnap(requestResult.status === "fulfilled" ? requestResult.value : { __error: requestResult.reason });
        setRespSnap(responseResult.status === "fulfilled" ? responseResult.value : { __error: responseResult.reason });
      })
      .finally(() => {
        if (!stopped) setDebugLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, [client, item?.job_id]);

  useEffect(() => {
    if (!imageIds.length) {
      setSelectedImageId(null);
      return;
    }
    if (!selectedImageId || !imageIds.includes(selectedImageId)) {
      setSelectedImageId(imageIds[0]);
    }
  }, [imageIds.join("|"), selectedImageId]);

  useEffect(() => {
    refRevokeRef.current.forEach((url) => URL.revokeObjectURL(url));
    refRevokeRef.current = [];
    setRefUrls({});
    if (!item || !requestRefs.length) return;
    const controller = new AbortController();
    requestRefs.forEach((entry: any) => {
      const filename = String(entry?.filename || "");
      if (!filename) return;
      client
        .getReferenceBlob(item.job_id, filename, undefined, controller.signal)
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          refRevokeRef.current.push(url);
          setRefUrls((current) => ({ ...current, [filename]: url }));
        })
        .catch(() => null);
    });
    return () => controller.abort();
  }, [client, item?.job_id, requestRefsKey]);

  const ensureImage = async (imageId: string, variant: ImageVariant) => {
    if (!rec) return null;
    const currentMap = variant === "preview" ? previewUrls : fullUrls;
    const currentBlobMap = variant === "preview" ? previewBlobs : fullBlobs;
    const updateUrl = variant === "preview" ? setPreviewUrls : setFullUrls;
    const updateBlob = variant === "preview" ? setPreviewBlobs : setFullBlobs;
    const revokeRef = variant === "preview" ? previewRevokeRef : fullRevokeRef;
    if (currentMap[imageId]) return currentBlobMap[imageId] || null;
    try {
      const { blob } = await readCachedImageOrFetch({
        scope: cacheScope,
        baseUrl: settings.baseUrl,
        jobId: rec.job_id,
        imageId,
        variant,
        config: settings.cache,
        fetcher: () =>
          variant === "preview"
            ? client.getPreviewBlob(rec.job_id, imageId)
            : client.getImageBlob(rec.job_id, imageId),
      });
      updateBlob((current) => ({ ...current, [imageId]: blob }));
      const url = URL.createObjectURL(blob);
      revokeRef.current.push(url);
      updateUrl((current) => ({ ...current, [imageId]: url }));
      return blob;
    } catch (e: any) {
      push({ kind: "error", title: `${variant === "preview" ? "预览" : "原图"}加载失败`, message: e?.error?.message || "" });
      return null;
    }
  };

  useEffect(() => {
    imageIds.slice(0, 12).forEach((imageId) => {
      ensureImage(imageId, "preview");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageIds.join("|")]);

  useEffect(() => {
    if (!selectedImageId) return;
    ensureImage(selectedImageId, "original");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedImageId]);

  if (!item || !rec) return null;

  const handleCancel = async () => {
    setActionLoading("cancel");
    try {
      await client.cancelJob(item.job_id);
      push({ kind: "success", title: "任务已取消" });
      await refresh();
      await onRefreshList();
    } catch (e: any) {
      push({ kind: "error", title: "取消失败", message: e?.error?.message || "" });
    } finally {
      setActionLoading(null);
    }
  };

  const handleRetry = async () => {
    setActionLoading("retry");
    try {
      const payload = await client.retryJob(item.job_id);
      push({ kind: "success", title: "已创建 retry 任务", message: shortId(payload?.new_job_id || "") });
      await onRefreshList();
    } catch (e: any) {
      push({ kind: "error", title: "重试失败", message: e?.error?.message || "" });
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async () => {
    if (!confirm("删除这条任务会同时删除后端 job 数据、输出图片和预览图，是否继续？")) return;
    const typed = prompt(`请输入该任务 job_id 的后 6 位以确认删除：${confirmTail}`);
    if ((typed || "").trim() !== confirmTail) {
      push({ kind: "info", title: "删除已取消", message: "确认码不匹配" });
      return;
    }
    setActionLoading("delete");
    try {
      await client.deleteJob(item.job_id);
      push({ kind: "success", title: "任务已删除" });
      onRemoved(item.job_id);
      onClose();
      await onRefreshList();
    } catch (e: any) {
      push({ kind: "error", title: "删除失败", message: e?.error?.message || "" });
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-50"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        <button
          type="button"
          className="absolute inset-0 bg-black/55 backdrop-blur-sm"
          onClick={onClose}
          data-testid="admin-task-detail-backdrop"
          aria-label="Close admin task detail"
        />
        <div className="pointer-events-none relative z-10 flex h-full justify-end">
          <motion.div
            initial={{ x: 32, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 32, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="pointer-events-auto h-full w-full max-w-[980px] overflow-y-auto border-l border-white/15 bg-[#f7f5ef] p-5 shadow-2xl dark:bg-zinc-950"
            role="dialog"
            aria-modal="true"
            aria-label="Admin task detail"
          >
            <div className="mb-4 flex items-start justify-between gap-4 border-b border-zinc-200/80 pb-4 dark:border-white/10">
              <div className="min-w-0">
                <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500 dark:text-zinc-400">Admin Task Detail</div>
                <div className="mt-1 truncate text-lg font-bold text-zinc-900 dark:text-zinc-50">{item.prompt_preview || shortId(item.job_id)}</div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                  <span>{formatLocal(item.created_at)}</span>
                  <span>·</span>
                  <span>{shortId(item.job_id)}</span>
                  <span>·</span>
                  <span>{owner?.username || item.owner?.username || "-"}</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge status={status} />
                <Button variant="ghost" onClick={onClose}>关闭</Button>
              </div>
            </div>

            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-4">
                <Card hover={false} className="p-3"><KeyValue k="model" v={item.model || "-"} /></Card>
                <Card hover={false} className="p-3"><KeyValue k="images" v={item.image_count ?? 0} /></Card>
                <Card hover={false} className="p-3"><KeyValue k="run_duration" v={formatDurationMs(item.timing?.run_duration_ms)} /></Card>
                <Card hover={false} className="p-3"><KeyValue k="queue_wait" v={formatDurationMs(item.timing?.queue_wait_ms)} /></Card>
              </div>

              <Card hover={false} className="overflow-hidden p-0">
                <div className="flex items-center justify-between border-b border-zinc-200/80 px-4 py-3 dark:border-white/10">
                  <div>
                    <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">结果预览</div>
                    <div className="text-xs text-zinc-600 dark:text-zinc-300">管理员可直接审查该任务的输出图。</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {status === "RUNNING" ? (
                      <Button variant="secondary" onClick={handleCancel} disabled={actionLoading !== null}>
                        {actionLoading === "cancel" ? "取消中…" : "取消任务"}
                      </Button>
                    ) : null}
                    {status !== "RUNNING" ? (
                      <Button variant="secondary" onClick={handleRetry} disabled={actionLoading !== null}>
                        {actionLoading === "retry" ? "重试中…" : "重试任务"}
                      </Button>
                    ) : null}
                    <Button variant="danger" onClick={handleDelete} disabled={actionLoading !== null}>
                      {actionLoading === "delete" ? "删除中…" : "删除任务"}
                    </Button>
                  </div>
                </div>
                {imageIds.length ? (
                  <div className="space-y-4 p-4">
                    <div className="overflow-hidden rounded-[24px] border border-zinc-200 bg-zinc-50 dark:border-white/10 dark:bg-zinc-950/30">
                      <div className="relative h-[280px] w-full bg-[linear-gradient(145deg,rgba(250,250,249,0.95),rgba(228,228,231,0.6))] sm:h-[360px] lg:h-[480px] dark:bg-[linear-gradient(145deg,rgba(24,24,27,0.95),rgba(39,39,42,0.72))]">
                        {selectedImageId && (fullUrls[selectedImageId] || previewUrls[selectedImageId]) ? (
                          <img
                            src={fullUrls[selectedImageId] || previewUrls[selectedImageId]}
                            alt={selectedImageId}
                            className="h-full w-full object-contain p-4"
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center">
                            <LoadingSpinner label={loading ? "Loading task" : "Loading image"} tone="brand" />
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-2 overflow-x-auto pb-1">
                      {imageIds.map((imageId) => (
                        <button
                          key={imageId}
                          type="button"
                          className={cn(
                            "relative overflow-hidden rounded-2xl border transition",
                            imageId === selectedImageId
                              ? "border-zinc-900 shadow-sm dark:border-white"
                              : "border-zinc-200 hover:-translate-y-0.5 hover:shadow-sm dark:border-white/10"
                          )}
                          onClick={() => {
                            setSelectedImageId(imageId);
                            ensureImage(imageId, "preview");
                          }}
                        >
                          {previewUrls[imageId] ? (
                            <img src={previewUrls[imageId]} alt={imageId} className="h-20 w-28 object-cover" />
                          ) : (
                            <div className="flex h-20 w-28 items-center justify-center bg-zinc-100 dark:bg-zinc-900">
                              <LoadingSpinner className="gap-1.5" />
                            </div>
                          )}
                          <div className="absolute bottom-1 left-1 rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-bold text-white">
                            {shortId(imageId, 6)}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="px-4 py-5 text-sm text-zinc-500 dark:text-zinc-400">
                    {status === "SUCCEEDED" ? "该任务未返回图片列表。" : summarizeQueueOrFailure(meta, rec) || "当前暂无图片输出"}
                  </div>
                )}
              </Card>

              <AdminJsonDisclosure title="Prompt Preview" value={<div className="whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-200">{requestPreview}</div>} />
              <AdminJsonDisclosure title="完整 Prompt" value={<div className="whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-200">{requestPrompt || "-"}</div>} />
              <AdminJsonDisclosure
                title="Request JSON"
                value={
                  debugLoading ? (
                    <LoadingSpinner label="Loading request" />
                  ) : (
                    <pre className="max-h-72 overflow-auto rounded-xl bg-black/90 p-3 text-[11px] text-white">{JSON.stringify(reqSnap, null, 2)}</pre>
                  )
                }
              />
              <AdminJsonDisclosure
                title="Response JSON"
                value={
                  debugLoading ? (
                    <LoadingSpinner label="Loading response" />
                  ) : (
                    <pre className="max-h-72 overflow-auto rounded-xl bg-black/90 p-3 text-[11px] text-white">{JSON.stringify(respSnap, null, 2)}</pre>
                  )
                }
              />
              <AdminJsonDisclosure
                title="Error / Debug"
                defaultOpen={status === "FAILED" || status === "CANCELLED"}
                value={
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <KeyValue k="code" v={meta?.error?.code || item.error?.code || "-"} />
                      <KeyValue k="type" v={meta?.error?.type || "-"} />
                      <KeyValue k="debug_id" v={meta?.error?.debug_id || "-"} />
                      <KeyValue k="loading" v={loading ? "true" : "false"} />
                    </div>
                    <div className="whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-200">{meta?.error?.message || item.error?.message || error || "-"}</div>
                    {meta?.error?.details ? (
                      <pre className="max-h-64 overflow-auto rounded-xl bg-black/90 p-3 text-[11px] text-white">{JSON.stringify(meta.error.details, null, 2)}</pre>
                    ) : null}
                  </div>
                }
              />
              <AdminJsonDisclosure
                title="引用图"
                value={
                  requestRefs.length ? (
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                      {requestRefs.map((entry: any, idx: number) => {
                        const filename = String(entry?.filename || "");
                        return (
                          <div key={filename || idx} className="overflow-hidden rounded-2xl border border-zinc-200 bg-white/60 dark:border-white/10 dark:bg-zinc-950/30">
                            <div className="relative h-28 w-full bg-zinc-100 dark:bg-zinc-900">
                              {refUrls[filename] ? <img src={refUrls[filename]} alt={filename} className="h-full w-full object-cover" /> : <Skeleton className="h-full w-full rounded-none" />}
                              <div className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-bold text-white">#{idx + 1}</div>
                            </div>
                            <div className="truncate px-3 py-2 text-[11px] text-zinc-600 dark:text-zinc-300">{filename || `reference_${idx}`}</div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-sm text-zinc-500 dark:text-zinc-400">没有引用图</div>
                  )
                }
              />
            </div>
          </motion.div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

function AdminPageLegacy() {
  const client = useApiClient();
  const { push } = useToast();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [overview, setOverview] = useState<AdminOverviewResponse | null>(null);
  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [providerNotes, setProviderNotes] = useState<Record<string, string>>({});
  const [providerEnabledDrafts, setProviderEnabledDrafts] = useState<Record<string, boolean>>({});
  const [providerSetBalanceDrafts, setProviderSetBalanceDrafts] = useState<Record<string, string>>({});
  const [providerAddBalanceDrafts, setProviderAddBalanceDrafts] = useState<Record<string, string>>({});
  const [savingProviderId, setSavingProviderId] = useState<string | null>(null);
  const [savingProviderBalanceId, setSavingProviderBalanceId] = useState<string | null>(null);

  const [policyDraft, setPolicyDraft] = useState<SystemPolicy | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);

  const [editRole, setEditRole] = useState<UserRole>("USER");
  const [editEnabled, setEditEnabled] = useState(true);
  const [editPassword, setEditPassword] = useState("");
  const [editDailyLimit, setEditDailyLimit] = useState("");
  const [editConcurrentLimit, setEditConcurrentLimit] = useState("");
  const [editTurnstileJobCount, setEditTurnstileJobCount] = useState("");
  const [editTurnstileDailyUsage, setEditTurnstileDailyUsage] = useState("");
  const [editImageAccessLimit, setEditImageAccessLimit] = useState("");
  const [editImageAccessBonusQuota, setEditImageAccessBonusQuota] = useState("");
  const [editImageAccessHardLimit, setEditImageAccessHardLimit] = useState("");
  const [savingUser, setSavingUser] = useState(false);
  const [resettingQuota, setResettingQuota] = useState(false);

  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<UserRole>("USER");
  const [newEnabled, setNewEnabled] = useState(true);
  const [newDailyLimit, setNewDailyLimit] = useState("");
  const [newConcurrentLimit, setNewConcurrentLimit] = useState("");
  const [newTurnstileJobCount, setNewTurnstileJobCount] = useState("");
  const [newTurnstileDailyUsage, setNewTurnstileDailyUsage] = useState("");
  const [newImageAccessLimit, setNewImageAccessLimit] = useState("");
  const [newImageAccessBonusQuota, setNewImageAccessBonusQuota] = useState("");
  const [newImageAccessHardLimit, setNewImageAccessHardLimit] = useState("");
  const [creatingUser, setCreatingUser] = useState(false);

  const parseOptionalNumber = (value: string) => {
    const raw = value.trim();
    if (!raw) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return null;
    return Math.max(0, Math.round(parsed));
  };

  const parseOptionalMoney = (value: string) => {
    const raw = value.trim();
    if (!raw) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return null;
    return Math.max(0, Number(parsed.toFixed(4)));
  };

  const loadAdminData = async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) setLoading(true);
    setRefreshing(true);
    try {
      const [overviewPayload, usersPayload] = await Promise.all([
        client.adminOverview(),
        client.adminUsers(),
      ]);
      setOverview(overviewPayload);
      setPolicyDraft(overviewPayload.policy);
      const providerItems = overviewPayload.providers?.providers || [];
      setProviderNotes(Object.fromEntries(providerItems.map((item) => [item.provider_id, item.note || ""])));
      setProviderEnabledDrafts(Object.fromEntries(providerItems.map((item) => [item.provider_id, Boolean(item.enabled)])));
      setProviderSetBalanceDrafts(
        Object.fromEntries(providerItems.map((item) => [item.provider_id, item.remaining_balance_cny == null ? "" : String(item.remaining_balance_cny)]))
      );
      setProviderAddBalanceDrafts((prev) => Object.fromEntries(providerItems.map((item) => [item.provider_id, prev[item.provider_id] || ""])));
      const nextUsers = [...(usersPayload.users || [])].sort((a, b) => a.username.localeCompare(b.username));
      setUsers(nextUsers);
      setSelectedUserId((current) => current || nextUsers[0]?.user_id || null);
    } catch (e: any) {
      push({ kind: "error", title: "Admin 数据加载失败", message: e?.error?.message || "请检查后端状态" });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    loadAdminData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedUser = useMemo(
    () => users.find((item) => item.user_id === selectedUserId) || null,
    [selectedUserId, users]
  );

  useEffect(() => {
    if (!selectedUser) return;
    setEditRole(selectedUser.role);
    setEditEnabled(selectedUser.enabled);
    setEditPassword("");
    setEditDailyLimit(
      selectedUser.policy.daily_image_limit == null ? "" : String(selectedUser.policy.daily_image_limit)
    );
    setEditConcurrentLimit(String(selectedUser.policy.concurrent_jobs_limit));
    setEditTurnstileJobCount(
      selectedUser.policy.turnstile_job_count_threshold == null
        ? ""
        : String(selectedUser.policy.turnstile_job_count_threshold)
    );
    setEditTurnstileDailyUsage(
      selectedUser.policy.turnstile_daily_usage_threshold == null
        ? ""
        : String(selectedUser.policy.turnstile_daily_usage_threshold)
    );
    setEditImageAccessLimit(
      selectedUser.policy.daily_image_access_limit == null ? "" : String(selectedUser.policy.daily_image_access_limit)
    );
    setEditImageAccessBonusQuota(
      selectedUser.policy.image_access_turnstile_bonus_quota == null
        ? ""
        : String(selectedUser.policy.image_access_turnstile_bonus_quota)
    );
    setEditImageAccessHardLimit(
      selectedUser.policy.daily_image_access_hard_limit == null
        ? ""
        : String(selectedUser.policy.daily_image_access_hard_limit)
    );
  }, [selectedUser]);

  const savePolicy = async () => {
    if (!policyDraft) return;
    setSavingPolicy(true);
    try {
      const updated = await client.adminUpdatePolicy(policyDraft);
      setPolicyDraft(updated.policy);
      await loadAdminData({ silent: true });
      push({ kind: "success", title: "系统策略已更新" });
    } catch (e: any) {
      push({ kind: "error", title: "策略更新失败", message: getApiErrorMessage(e, "请检查输入") });
    } finally {
      setSavingPolicy(false);
    }
  };

  const saveSelectedUser = async () => {
    if (!selectedUser) return;
    setSavingUser(true);
    try {
      const updated = await client.adminUpdateUser(selectedUser.user_id, {
        role: editRole,
        enabled: editEnabled,
        password: editPassword.trim() || undefined,
        policy_overrides: {
          daily_image_limit: parseOptionalNumber(editDailyLimit),
          concurrent_jobs_limit: parseOptionalNumber(editConcurrentLimit),
          turnstile_job_count_threshold: parseOptionalNumber(editTurnstileJobCount),
          turnstile_daily_usage_threshold: parseOptionalNumber(editTurnstileDailyUsage),
          daily_image_access_limit: parseOptionalNumber(editImageAccessLimit),
          image_access_turnstile_bonus_quota: parseOptionalNumber(editImageAccessBonusQuota),
          daily_image_access_hard_limit: parseOptionalNumber(editImageAccessHardLimit),
        },
      });
      setUsers((prev) => prev.map((item) => (item.user_id === updated.user_id ? updated : item)));
      setEditPassword("");
      push({ kind: "success", title: `已更新 ${updated.username}` });
      await loadAdminData({ silent: true });
    } catch (e: any) {
      push({ kind: "error", title: "用户更新失败", message: getApiErrorMessage(e, "请检查输入") });
    } finally {
      setSavingUser(false);
    }
  };

  const resetSelectedQuota = async () => {
    if (!selectedUser) return;
    setResettingQuota(true);
    try {
      const updated = await client.adminResetQuota(selectedUser.user_id);
      setUsers((prev) => prev.map((item) => (item.user_id === updated.user_id ? updated : item)));
      push({ kind: "success", title: `已重置 ${updated.username} 今日额度` });
      await loadAdminData({ silent: true });
    } catch (e: any) {
      push({ kind: "error", title: "额度重置失败", message: e?.error?.message || "请稍后重试" });
    } finally {
      setResettingQuota(false);
    }
  };

  const createUser = async () => {
    const username = newUsername.trim().toLowerCase();
    const password = newPassword.trim();
    if (!username || !password) {
      push({ kind: "error", title: "请填写新账号用户名与密码" });
      return;
    }
    if (!ADMIN_USERNAME_PATTERN.test(username)) {
      push({
        kind: "error",
        title: "创建用户失败",
        message: "用户名必须为 3-32 位，只能包含字母、数字、下划线、点和短横线",
      });
      return;
    }
    if (password.length < 8 || password.length > 128) {
      push({
        kind: "error",
        title: "创建用户失败",
        message: "密码长度必须为 8-128 位",
      });
      return;
    }
    setCreatingUser(true);
    try {
      await client.adminCreateUser({
        username,
        password,
        role: newRole,
        enabled: newEnabled,
        policy_overrides: {
          daily_image_limit: parseOptionalNumber(newDailyLimit),
          concurrent_jobs_limit: parseOptionalNumber(newConcurrentLimit),
          turnstile_job_count_threshold: parseOptionalNumber(newTurnstileJobCount),
          turnstile_daily_usage_threshold: parseOptionalNumber(newTurnstileDailyUsage),
          daily_image_access_limit: parseOptionalNumber(newImageAccessLimit),
          image_access_turnstile_bonus_quota: parseOptionalNumber(newImageAccessBonusQuota),
          daily_image_access_hard_limit: parseOptionalNumber(newImageAccessHardLimit),
        },
      });
      setNewUsername("");
      setNewPassword("");
      setNewRole("USER");
      setNewEnabled(true);
      setNewDailyLimit("");
      setNewConcurrentLimit("");
      setNewTurnstileJobCount("");
      setNewTurnstileDailyUsage("");
      setNewImageAccessLimit("");
      setNewImageAccessBonusQuota("");
      setNewImageAccessHardLimit("");
      await loadAdminData({ silent: true });
      push({ kind: "success", title: "新用户已创建" });
    } catch (e: any) {
      push({ kind: "error", title: "创建用户失败", message: getApiErrorMessage(e, "请检查输入") });
    } finally {
      setCreatingUser(false);
    }
  };

  const saveProvider = async (providerId: string) => {
    setSavingProviderId(providerId);
    try {
      await client.adminUpdateProvider(providerId, {
        enabled: providerEnabledDrafts[providerId],
        note: providerNotes[providerId] || "",
      });
      await loadAdminData({ silent: true });
      push({ kind: "success", title: `已更新 ${providerId}` });
    } catch (e: any) {
      push({ kind: "error", title: "Provider 更新失败", message: getApiErrorMessage(e, "请稍后重试") });
    } finally {
      setSavingProviderId(null);
    }
  };

  const setProviderBalance = async (providerId: string) => {
    setSavingProviderBalanceId(`set:${providerId}`);
    try {
      await client.adminSetProviderBalance(providerId, parseOptionalMoney(providerSetBalanceDrafts[providerId] || ""));
      await loadAdminData({ silent: true });
      push({ kind: "success", title: `已设置 ${providerId} 余额` });
    } catch (e: any) {
      push({ kind: "error", title: "余额设置失败", message: getApiErrorMessage(e, "请检查金额") });
    } finally {
      setSavingProviderBalanceId(null);
    }
  };

  const addProviderBalance = async (providerId: string) => {
    const delta = parseOptionalMoney(providerAddBalanceDrafts[providerId] || "");
    if (delta == null || delta <= 0) {
      push({ kind: "error", title: "请输入大于 0 的充值金额" });
      return;
    }
    setSavingProviderBalanceId(`add:${providerId}`);
    try {
      await client.adminAddProviderBalance(providerId, delta);
      setProviderAddBalanceDrafts((prev) => ({ ...prev, [providerId]: "" }));
      await loadAdminData({ silent: true });
      push({ kind: "success", title: `已为 ${providerId} 增加余额` });
    } catch (e: any) {
      push({ kind: "error", title: "余额增加失败", message: getApiErrorMessage(e, "请检查金额") });
    } finally {
      setSavingProviderBalanceId(null);
    }
  };

  return (
    <PageContainer>
      <PageTitle
        title="Admin"
        subtitle="查看系统实时状态，管理配额策略与用户账号。"
        right={
          <Button variant="secondary" onClick={() => loadAdminData({ silent: true })} disabled={refreshing}>
            {refreshing ? "刷新中…" : "刷新"}
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiCard title="活跃作业" value={loading ? "-" : numberish(overview?.system.active_jobs)} loading={loading} />
        <KpiCard title="队列长度" value={loading ? "-" : numberish(overview?.system.queue_size)} loading={loading} />
        <KpiCard title="今日成功" value={loading ? "-" : numberish(overview?.system.succeeded_today)} loading={loading} />
        <KpiCard title="今日失败" value={loading ? "-" : numberish(overview?.system.failed_today)} loading={loading} />
        <KpiCard title="今日出图" value={loading ? "-" : numberish(overview?.system.images_generated_today)} loading={loading} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-[1.05fr_0.95fr]">
        <Card>
          <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">系统概况</div>
          <div className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
            <KeyValue k="version" v={overview?.system.app_version || "-"} />
            <KeyValue k="worker_count" v={String(overview?.system.worker_count ?? "-")} />
            <KeyValue k="users_enabled" v={`${overview?.system.users_enabled ?? 0}/${overview?.system.users_total ?? 0}`} />
            <KeyValue k="running_jobs" v={String(overview?.system.running_jobs ?? "-")} />
            <KeyValue k="jobs_total" v={String(overview?.system.jobs_total ?? "-")} />
            <KeyValue k="uptime" v={formatDurationMs((overview?.system.uptime_sec ?? 0) * 1000)} />
          </div>
          <Divider />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="rounded-2xl border border-zinc-200 bg-white/60 p-3 dark:border-white/10 dark:bg-zinc-950/30">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">Providers</div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <KeyValue k="enabled" v={String(overview?.providers.providers_enabled ?? "-")} />
                <KeyValue k="healthy" v={String(overview?.providers.providers_healthy ?? "-")} />
                <KeyValue k="cooldown" v={String(overview?.providers.providers_cooldown ?? "-")} />
                <KeyValue k="remaining" v={`${numberish(overview?.providers.remaining_balance_cny)} CNY`} />
              </div>
            </div>
            <div className="rounded-2xl border border-zinc-200 bg-white/60 p-3 dark:border-white/10 dark:bg-zinc-950/30">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">Runtime</div>
              <div className="mt-3 space-y-2 text-xs text-zinc-600 dark:text-zinc-300">
                <div>部署时间：{formatLocal(overview?.system.deployed_at)}</div>
                <div>当前时间：{formatLocal(overview?.system.now)}</div>
                <div>Provider 更新时间：{formatLocal(overview?.providers.last_updated_at)}</div>
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-center justify-between">
            <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">全局策略</div>
            <Button variant="primary" onClick={savePolicy} disabled={!policyDraft || savingPolicy}>
              {savingPolicy ? "保存中…" : "保存策略"}
            </Button>
          </div>
          {policyDraft ? (
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field label="普通用户每日额度">
                <Input value={String(policyDraft.default_user_daily_image_limit)} onChange={(v) => setPolicyDraft({ ...policyDraft, default_user_daily_image_limit: Number(v || 0) })} />
              </Field>
              <Field label="超额额外额度">
                <Input value={String(policyDraft.default_user_extra_daily_image_limit)} onChange={(v) => setPolicyDraft({ ...policyDraft, default_user_extra_daily_image_limit: Number(v || 0) })} />
              </Field>
              <Field label="普通用户并发上限">
                <Input value={String(policyDraft.default_user_concurrent_jobs_limit)} onChange={(v) => setPolicyDraft({ ...policyDraft, default_user_concurrent_jobs_limit: Number(v || 0) })} />
              </Field>
              <Field label="管理员并发上限">
                <Input value={String(policyDraft.default_admin_concurrent_jobs_limit)} onChange={(v) => setPolicyDraft({ ...policyDraft, default_admin_concurrent_jobs_limit: Number(v || 0) })} />
              </Field>
              <Field label="job_count 触发阈值">
                <Input value={String(policyDraft.default_user_turnstile_job_count_threshold)} onChange={(v) => setPolicyDraft({ ...policyDraft, default_user_turnstile_job_count_threshold: Number(v || 0) })} />
              </Field>
              <Field label="日生成量触发阈值">
                <Input value={String(policyDraft.default_user_turnstile_daily_usage_threshold)} onChange={(v) => setPolicyDraft({ ...policyDraft, default_user_turnstile_daily_usage_threshold: Number(v || 0) })} />
              </Field>
              <Field label="图片访问基础额度">
                <Input value={String(policyDraft.default_user_daily_image_access_limit)} onChange={(v) => setPolicyDraft({ ...policyDraft, default_user_daily_image_access_limit: Number(v || 0) })} />
              </Field>
              <Field label="图片访问验证加额">
                <Input value={String(policyDraft.default_user_image_access_turnstile_bonus_quota)} onChange={(v) => setPolicyDraft({ ...policyDraft, default_user_image_access_turnstile_bonus_quota: Number(v || 0) })} />
              </Field>
              <Field label="图片访问硬上限">
                <Input value={String(policyDraft.default_user_daily_image_access_hard_limit)} onChange={(v) => setPolicyDraft({ ...policyDraft, default_user_daily_image_access_hard_limit: Number(v || 0) })} />
              </Field>
            </div>
          ) : (
            <div className="mt-3"><Skeleton className="h-28 w-full" /></div>
          )}
        </Card>
      </div>

      <Card className="mt-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">中转站状态</div>
            <div className="text-xs text-zinc-600 dark:text-zinc-300">手动控制启用、备注和余额；运行状态来自后端调度器实时统计。</div>
          </div>
          <div className="rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1 text-xs font-semibold text-zinc-600 dark:border-white/10 dark:bg-zinc-950/40 dark:text-zinc-300">
            {overview?.providers.providers_total ?? 0} providers
          </div>
        </div>

        <div className="mt-3 space-y-3">
          {(overview?.providers.providers || []).length ? (overview?.providers.providers || []).map((provider) => (
            <div
              key={provider.provider_id}
              className="rounded-2xl border border-zinc-200 bg-white/60 p-4 dark:border-white/10 dark:bg-zinc-950/30"
            >
              <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">{provider.label}</div>
                    <span className="rounded-full border border-zinc-200 px-2 py-0.5 text-[10px] font-semibold text-zinc-600 dark:border-white/10 dark:text-zinc-300">
                      {provider.provider_id}
                    </span>
                    <span className="rounded-full border border-zinc-200 px-2 py-0.5 text-[10px] font-semibold text-zinc-600 dark:border-white/10 dark:text-zinc-300">
                      {provider.adapter_type}
                    </span>
                    <span className={cn(
                      "rounded-full px-2 py-0.5 text-[10px] font-semibold",
                      provider.cooldown_active
                        ? "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-200"
                        : provider.enabled
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200"
                          : "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                    )}>
                      {provider.cooldown_active ? "cooldown" : provider.enabled ? "enabled" : "disabled"}
                    </span>
                  </div>
                  <div className="mt-2 break-all text-xs text-zinc-500 dark:text-zinc-400">{provider.base_url}</div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
                    <KeyValue k="cost" v={`${numberish(provider.cost_per_image_cny)} CNY`} />
                    <KeyValue k="balance" v={provider.remaining_balance_cny == null ? "unknown" : `${numberish(provider.remaining_balance_cny)} CNY`} />
                    <KeyValue k="quota" v={provider.quota_state} />
                    <KeyValue k="active" v={`${provider.active_requests}/${provider.max_concurrency}`} />
                    <KeyValue k="success" v={`${Math.round(provider.final_success_rate * 100)}%`} />
                    <KeyValue k="fails" v={`${provider.fail_count} (${provider.consecutive_failures} 连续)`} />
                    <KeyValue k="p50" v={provider.latency_p50_ms == null ? "-" : `${Math.round(provider.latency_p50_ms)} ms`} />
                    <KeyValue k="p95" v={provider.latency_p95_ms == null ? "-" : `${Math.round(provider.latency_p95_ms)} ms`} />
                  </div>
                  <div className="mt-3 text-[11px] text-zinc-500 dark:text-zinc-400">
                    models: {provider.supported_models.join(", ") || "-"}
                  </div>
                  <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                    last_success: {formatLocal(provider.last_success_time)} · last_fail: {formatLocal(provider.last_fail_time)} · reason: {provider.last_fail_reason || "-"}
                  </div>
                  <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                    last_circuit: {formatLocal(provider.last_circuit_open_time)} · until: {formatLocal(provider.last_circuit_open_until)} · reason: {provider.last_circuit_open_reason || "-"}
                  </div>
                  <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                    last_forced_activation: {formatLocal(provider.last_forced_activation_time)} · mode: {provider.last_forced_activation_mode || "-"} · count: {provider.forced_activation_count}
                  </div>
                </div>

                <div className="grid min-w-0 gap-2 xl:w-[420px] xl:grid-cols-2">
                  <Field label="enabled">
                    <div className="flex h-[42px] items-center">
                      <Switch
                        value={providerEnabledDrafts[provider.provider_id] ?? provider.enabled}
                        onChange={(value) => setProviderEnabledDrafts((prev) => ({ ...prev, [provider.provider_id]: value }))}
                      />
                    </div>
                  </Field>
                  <Field label="note">
                    <Input
                      value={providerNotes[provider.provider_id] ?? provider.note ?? ""}
                      onChange={(value) => setProviderNotes((prev) => ({ ...prev, [provider.provider_id]: value }))}
                      placeholder="备注"
                    />
                  </Field>
                  <Field label="set balance (CNY)">
                    <div className="flex gap-2">
                      <Input
                        value={providerSetBalanceDrafts[provider.provider_id] ?? ""}
                        onChange={(value) => setProviderSetBalanceDrafts((prev) => ({ ...prev, [provider.provider_id]: value }))}
                        placeholder="可留空设为 unknown"
                      />
                      <Button
                        variant="secondary"
                        onClick={() => setProviderBalance(provider.provider_id)}
                        disabled={savingProviderBalanceId === `set:${provider.provider_id}`}
                      >
                        {savingProviderBalanceId === `set:${provider.provider_id}` ? "设置中…" : "设置"}
                      </Button>
                    </div>
                  </Field>
                  <Field label="add balance (CNY)">
                    <div className="flex gap-2">
                      <Input
                        value={providerAddBalanceDrafts[provider.provider_id] ?? ""}
                        onChange={(value) => setProviderAddBalanceDrafts((prev) => ({ ...prev, [provider.provider_id]: value }))}
                        placeholder="充值金额"
                      />
                      <Button
                        variant="secondary"
                        onClick={() => addProviderBalance(provider.provider_id)}
                        disabled={savingProviderBalanceId === `add:${provider.provider_id}`}
                      >
                        {savingProviderBalanceId === `add:${provider.provider_id}` ? "增加中…" : "增加"}
                      </Button>
                    </div>
                  </Field>
                  <div className="xl:col-span-2 flex justify-end">
                    <Button
                      variant="primary"
                      onClick={() => saveProvider(provider.provider_id)}
                      disabled={savingProviderId === provider.provider_id}
                    >
                      {savingProviderId === provider.provider_id ? "保存中…" : "保存 Provider"}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )) : <EmptyHint text="暂无 provider 配置" />}
        </div>
      </Card>

      <div className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-[0.92fr_1.08fr]">
        <Card>
          <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">用户列表</div>
          <div className="mt-3 space-y-2">
            {users.length ? users.map((item) => (
              <button
                key={item.user_id}
                type="button"
                onClick={() => setSelectedUserId(item.user_id)}
                className={cn(
                  "w-full rounded-2xl border p-3 text-left transition",
                  item.user_id === selectedUserId
                    ? "border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900"
                    : "border-zinc-200 bg-white/60 text-zinc-900 hover:border-zinc-400 dark:border-white/10 dark:bg-zinc-950/30 dark:text-zinc-50"
                )}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-bold">{item.username}</div>
                    <div className={cn("mt-1 text-xs", item.user_id === selectedUserId ? "text-white/80 dark:text-zinc-700" : "text-zinc-500 dark:text-zinc-400")}>
                      {item.role} · {item.enabled ? "enabled" : "disabled"} · consumed {item.usage.quota_consumed_today}
                    </div>
                  </div>
                  <div className={cn("text-xs", item.user_id === selectedUserId ? "text-white/80 dark:text-zinc-700" : "text-zinc-500 dark:text-zinc-400")}>
                    image hits {item.usage.image_accesses_today ?? 0}
                  </div>
                </div>
              </button>
            )) : <EmptyHint text="暂无用户" />}
          </div>
        </Card>

        <div className="space-y-3">
          <Card>
            <div className="flex items-center justify-between">
              <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">编辑用户</div>
              <div className="flex items-center gap-2">
                <Button variant="secondary" onClick={resetSelectedQuota} disabled={!selectedUser || resettingQuota}>
                  {resettingQuota ? "重置中…" : "重置今日额度"}
                </Button>
                <Button variant="primary" onClick={saveSelectedUser} disabled={!selectedUser || savingUser}>
                  {savingUser ? "保存中…" : "保存用户"}
                </Button>
              </div>
            </div>
            {!selectedUser ? (
              <div className="mt-3"><EmptyHint text="请先选择一个用户" /></div>
            ) : (
              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                <Field label="username">
                  <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700 dark:border-white/10 dark:bg-zinc-950/30 dark:text-zinc-200">
                    {selectedUser.username}
                  </div>
                </Field>
                <Field label="role">
                  <Select value={editRole} onChange={(v) => setEditRole(v as UserRole)} options={[{ value: "ADMIN", label: "ADMIN" }, { value: "USER", label: "USER" }]} />
                </Field>
                <Field label="enabled">
                  <div className="flex h-[42px] items-center"><Switch value={editEnabled} onChange={setEditEnabled} /></div>
                </Field>
                <Field label="new password">
                  <Input value={editPassword} onChange={setEditPassword} type="password" placeholder="留空则不改密码" />
                </Field>
                <Field label="daily_image_limit">
                  <Input value={editDailyLimit} onChange={setEditDailyLimit} placeholder="留空表示无限制/跟随角色" />
                </Field>
                <Field label="concurrent_jobs_limit">
                  <Input value={editConcurrentLimit} onChange={setEditConcurrentLimit} />
                </Field>
                <Field label="turnstile_job_count_threshold">
                  <Input value={editTurnstileJobCount} onChange={setEditTurnstileJobCount} placeholder="留空则禁用" />
                </Field>
                <Field label="turnstile_daily_usage_threshold">
                  <Input value={editTurnstileDailyUsage} onChange={setEditTurnstileDailyUsage} placeholder="留空则禁用" />
                </Field>
                <Field label="daily_image_access_limit">
                  <Input value={editImageAccessLimit} onChange={setEditImageAccessLimit} placeholder="留空使用默认值" />
                </Field>
                <Field label="image_access_turnstile_bonus_quota">
                  <Input value={editImageAccessBonusQuota} onChange={setEditImageAccessBonusQuota} placeholder="留空使用默认值" />
                </Field>
                <Field label="daily_image_access_hard_limit">
                  <Input value={editImageAccessHardLimit} onChange={setEditImageAccessHardLimit} placeholder="留空使用默认值" />
                </Field>
              </div>
            )}
          </Card>

          <Card>
            <div className="flex items-center justify-between">
              <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">创建新用户</div>
              <Button variant="primary" onClick={createUser} disabled={creatingUser}>
                {creatingUser ? "创建中…" : "创建"}
              </Button>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field label="username">
                <Input value={newUsername} onChange={setNewUsername} placeholder="alice" />
              </Field>
              <Field label="password">
                <Input value={newPassword} onChange={setNewPassword} type="password" placeholder="至少 8 位" />
              </Field>
              <Field label="role">
                <Select value={newRole} onChange={(v) => setNewRole(v as UserRole)} options={[{ value: "USER", label: "USER" }, { value: "ADMIN", label: "ADMIN" }]} />
              </Field>
              <Field label="enabled">
                <div className="flex h-[42px] items-center"><Switch value={newEnabled} onChange={setNewEnabled} /></div>
              </Field>
              <Field label="daily_image_limit">
                <Input value={newDailyLimit} onChange={setNewDailyLimit} placeholder="留空使用默认值" />
              </Field>
              <Field label="concurrent_jobs_limit">
                <Input value={newConcurrentLimit} onChange={setNewConcurrentLimit} placeholder="留空使用默认值" />
              </Field>
              <Field label="turnstile_job_count_threshold">
                <Input value={newTurnstileJobCount} onChange={setNewTurnstileJobCount} placeholder="留空使用默认值" />
              </Field>
              <Field label="turnstile_daily_usage_threshold">
                <Input value={newTurnstileDailyUsage} onChange={setNewTurnstileDailyUsage} placeholder="留空使用默认值" />
              </Field>
              <Field label="daily_image_access_limit">
                <Input value={newImageAccessLimit} onChange={setNewImageAccessLimit} placeholder="留空使用默认值" />
              </Field>
              <Field label="image_access_turnstile_bonus_quota">
                <Input value={newImageAccessBonusQuota} onChange={setNewImageAccessBonusQuota} placeholder="留空使用默认值" />
              </Field>
              <Field label="daily_image_access_hard_limit">
                <Input value={newImageAccessHardLimit} onChange={setNewImageAccessHardLimit} placeholder="留空使用默认值" />
              </Field>
            </div>
          </Card>
        </div>
      </div>
    </PageContainer>
  );
}

function AdminPage() {
  const client = useApiClient();
  const catalog = useModelCatalog();
  const { push } = useToast();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [overview, setOverview] = useState<AdminOverviewResponse | null>(null);
  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<"overview" | "tasks" | "policy">("overview");
  const [userSearch, setUserSearch] = useState("");
  const [userRoleFilter, setUserRoleFilter] = useState<"ALL" | UserRole>("ALL");
  const [userStateFilter, setUserStateFilter] = useState<"ALL" | "ENABLED" | "DISABLED" | "RUNNING" | "HIGH_USAGE" | "RISK_ONLY">("ALL");
  const [userSort, setUserSort] = useState<"RISK_FIRST" | "RECENT_ACTIVE" | "USERNAME" | "CREATED_DESC">("RISK_FIRST");
  const [providerNotes, setProviderNotes] = useState<Record<string, string>>({});
  const [providerEnabledDrafts, setProviderEnabledDrafts] = useState<Record<string, boolean>>({});
  const [providerSetBalanceDrafts, setProviderSetBalanceDrafts] = useState<Record<string, string>>({});
  const [providerAddBalanceDrafts, setProviderAddBalanceDrafts] = useState<Record<string, string>>({});
  const [savingProviderId, setSavingProviderId] = useState<string | null>(null);
  const [savingProviderBalanceId, setSavingProviderBalanceId] = useState<string | null>(null);

  const [policyDraft, setPolicyDraft] = useState<SystemPolicy | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);

  const [editRole, setEditRole] = useState<UserRole>("USER");
  const [editEnabled, setEditEnabled] = useState(true);
  const [editPassword, setEditPassword] = useState("");
  const [editDailyLimit, setEditDailyLimit] = useState("");
  const [editConcurrentLimit, setEditConcurrentLimit] = useState("");
  const [editTurnstileJobCount, setEditTurnstileJobCount] = useState("");
  const [editTurnstileDailyUsage, setEditTurnstileDailyUsage] = useState("");
  const [editImageAccessLimit, setEditImageAccessLimit] = useState("");
  const [editImageAccessBonusQuota, setEditImageAccessBonusQuota] = useState("");
  const [editImageAccessHardLimit, setEditImageAccessHardLimit] = useState("");
  const [savingUser, setSavingUser] = useState(false);
  const [resettingQuota, setResettingQuota] = useState(false);

  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<UserRole>("USER");
  const [newEnabled, setNewEnabled] = useState(true);
  const [newDailyLimit, setNewDailyLimit] = useState("");
  const [newConcurrentLimit, setNewConcurrentLimit] = useState("");
  const [newTurnstileJobCount, setNewTurnstileJobCount] = useState("");
  const [newTurnstileDailyUsage, setNewTurnstileDailyUsage] = useState("");
  const [newImageAccessLimit, setNewImageAccessLimit] = useState("");
  const [newImageAccessBonusQuota, setNewImageAccessBonusQuota] = useState("");
  const [newImageAccessHardLimit, setNewImageAccessHardLimit] = useState("");
  const [creatingUser, setCreatingUser] = useState(false);

  const [taskSearch, setTaskSearch] = useState("");
  const [taskStatusFilter, setTaskStatusFilter] = useState<JobStatus | "ALL">("ALL");
  const [taskModelFilter, setTaskModelFilter] = useState<ModelId | "ALL">("ALL");
  const [taskFrom, setTaskFrom] = useState("");
  const [taskTo, setTaskTo] = useState("");
  const [taskBatchName, setTaskBatchName] = useState("");
  const [taskFailedOnly, setTaskFailedOnly] = useState(false);
  const [taskHasImages, setTaskHasImages] = useState<"ALL" | "YES" | "NO">("ALL");
  const [taskSort, setTaskSort] = useState<AdminTaskSortKey>("created_desc");
  const [taskDensity, setTaskDensity] = useState<AdminTaskDensity>("gallery");
  const [taskItems, setTaskItems] = useState<AdminUserJobSummary[]>([]);
  const [taskStats, setTaskStats] = useState<AdminUserJobsStats | null>(null);
  const [taskLoading, setTaskLoading] = useState(false);
  const [taskLoadingMore, setTaskLoadingMore] = useState(false);
  const [taskNextCursor, setTaskNextCursor] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<AdminUserJobSummary | null>(null);
  const taskRequestSeqRef = useRef(0);

  const debouncedUserSearch = useDebounced(userSearch, 150);
  const debouncedTaskSearch = useDebounced(taskSearch, 180);

  const parseOptionalNumber = (value: string) => {
    const raw = value.trim();
    if (!raw) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return null;
    return Math.max(0, Math.round(parsed));
  };

  const parseOptionalMoney = (value: string) => {
    const raw = value.trim();
    if (!raw) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return null;
    return Math.max(0, Number(parsed.toFixed(4)));
  };

  const clearOverrideDrafts = () => {
    setEditDailyLimit("");
    setEditConcurrentLimit("");
    setEditTurnstileJobCount("");
    setEditTurnstileDailyUsage("");
    setEditImageAccessLimit("");
    setEditImageAccessBonusQuota("");
    setEditImageAccessHardLimit("");
  };

  const applyRiskPreset = (mode: "STRICT" | "RELAXED") => {
    if (mode === "STRICT") {
      setEditDailyLimit("10");
      setEditConcurrentLimit("1");
      setEditTurnstileJobCount("1");
      setEditTurnstileDailyUsage("8");
      setEditImageAccessLimit("12");
      setEditImageAccessBonusQuota("0");
      setEditImageAccessHardLimit("12");
      return;
    }
    clearOverrideDrafts();
    setEditConcurrentLimit(editRole === "ADMIN" ? "" : "6");
    setEditTurnstileJobCount("999");
    setEditTurnstileDailyUsage("999");
  };

  const generateTempPassword = async () => {
    const password = `Reset-${Math.random().toString(36).slice(2, 8)}-A9`;
    setEditPassword(password);
    try {
      await navigator.clipboard.writeText(password);
      push({ kind: "success", title: "已生成临时密码", message: "新密码已复制到剪贴板" });
    } catch {
      push({ kind: "success", title: "已生成临时密码" });
    }
  };

  const loadAdminData = async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) setLoading(true);
    setRefreshing(true);
    try {
      const [overviewPayload, usersPayload] = await Promise.all([client.adminOverview(), client.adminUsers()]);
      setOverview(overviewPayload);
      setPolicyDraft(overviewPayload.policy);
      const providerItems = overviewPayload.providers?.providers || [];
      setProviderNotes(Object.fromEntries(providerItems.map((item) => [item.provider_id, item.note || ""])));
      setProviderEnabledDrafts(Object.fromEntries(providerItems.map((item) => [item.provider_id, Boolean(item.enabled)])));
      setProviderSetBalanceDrafts(
        Object.fromEntries(providerItems.map((item) => [item.provider_id, item.remaining_balance_cny == null ? "" : String(item.remaining_balance_cny)]))
      );
      setProviderAddBalanceDrafts((prev) => Object.fromEntries(providerItems.map((item) => [item.provider_id, prev[item.provider_id] || ""])));
      setUsers(usersPayload.users || []);
      setSelectedUserId((current) => current || usersPayload.users?.[0]?.user_id || null);
    } catch (e: any) {
      push({ kind: "error", title: "Admin 数据加载失败", message: e?.error?.message || "请检查后端状态" });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    loadAdminData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredUsers = useMemo(() => {
    const query = debouncedUserSearch.trim().toLowerCase();
    const next = [...users].filter((user) => {
      if (query && !`${user.username} ${user.user_id}`.toLowerCase().includes(query)) return false;
      if (userRoleFilter !== "ALL" && user.role !== userRoleFilter) return false;
      if (userStateFilter === "ENABLED" && !user.enabled) return false;
      if (userStateFilter === "DISABLED" && user.enabled) return false;
      if (userStateFilter === "RUNNING" && (user.usage.running_jobs || 0) <= 0) return false;
      if (userStateFilter === "HIGH_USAGE") {
        const dailyLimit = user.policy.daily_image_limit;
        if (!(dailyLimit != null && dailyLimit > 0 && (user.usage.quota_consumed_today || 0) / dailyLimit >= 0.8)) return false;
      }
      if (userStateFilter === "RISK_ONLY" && adminUserRiskTags(user).length === 0) return false;
      return true;
    });
    next.sort((a, b) => {
      if (userSort === "USERNAME") return a.username.localeCompare(b.username);
      if (userSort === "CREATED_DESC") return (new Date(b.created_at).getTime() || 0) - (new Date(a.created_at).getTime() || 0);
      if (userSort === "RECENT_ACTIVE") return (new Date(b.last_login_at || b.updated_at).getTime() || 0) - (new Date(a.last_login_at || a.updated_at).getTime() || 0);
      const riskDiff = adminUserRiskScore(b) - adminUserRiskScore(a);
      if (riskDiff) return riskDiff;
      return (new Date(b.last_login_at || b.updated_at).getTime() || 0) - (new Date(a.last_login_at || a.updated_at).getTime() || 0);
    });
    return next;
  }, [debouncedUserSearch, userRoleFilter, userSort, userStateFilter, users]);

  useEffect(() => {
    if (selectedUserId && filteredUsers.some((item) => item.user_id === selectedUserId)) return;
    setSelectedUserId(filteredUsers[0]?.user_id || users[0]?.user_id || null);
  }, [filteredUsers, selectedUserId, users]);

  const selectedUser = useMemo(() => users.find((item) => item.user_id === selectedUserId) || null, [selectedUserId, users]);

  useEffect(() => {
    if (!selectedUser) return;
    setEditRole(selectedUser.role);
    setEditEnabled(selectedUser.enabled);
    setEditPassword("");
    setEditDailyLimit(selectedUser.policy_overrides?.daily_image_limit == null ? "" : String(selectedUser.policy_overrides.daily_image_limit));
    setEditConcurrentLimit(selectedUser.policy_overrides?.concurrent_jobs_limit == null ? "" : String(selectedUser.policy_overrides.concurrent_jobs_limit));
    setEditTurnstileJobCount(selectedUser.policy_overrides?.turnstile_job_count_threshold == null ? "" : String(selectedUser.policy_overrides.turnstile_job_count_threshold));
    setEditTurnstileDailyUsage(selectedUser.policy_overrides?.turnstile_daily_usage_threshold == null ? "" : String(selectedUser.policy_overrides.turnstile_daily_usage_threshold));
    setEditImageAccessLimit(selectedUser.policy_overrides?.daily_image_access_limit == null ? "" : String(selectedUser.policy_overrides.daily_image_access_limit));
    setEditImageAccessBonusQuota(selectedUser.policy_overrides?.image_access_turnstile_bonus_quota == null ? "" : String(selectedUser.policy_overrides.image_access_turnstile_bonus_quota));
    setEditImageAccessHardLimit(selectedUser.policy_overrides?.daily_image_access_hard_limit == null ? "" : String(selectedUser.policy_overrides.daily_image_access_hard_limit));
  }, [selectedUser]);

  const savePolicy = async () => {
    if (!policyDraft) return;
    setSavingPolicy(true);
    try {
      const updated = await client.adminUpdatePolicy(policyDraft);
      setPolicyDraft(updated.policy);
      await loadAdminData({ silent: true });
      push({ kind: "success", title: "系统策略已更新" });
    } catch (e: any) {
      push({ kind: "error", title: "策略更新失败", message: getApiErrorMessage(e, "请检查输入") });
    } finally {
      setSavingPolicy(false);
    }
  };

  const saveSelectedUser = async () => {
    if (!selectedUser) return;
    setSavingUser(true);
    try {
      const updated = await client.adminUpdateUser(selectedUser.user_id, {
        role: editRole,
        enabled: editEnabled,
        password: editPassword.trim() || undefined,
        policy_overrides: {
          daily_image_limit: parseOptionalNumber(editDailyLimit),
          concurrent_jobs_limit: parseOptionalNumber(editConcurrentLimit),
          turnstile_job_count_threshold: parseOptionalNumber(editTurnstileJobCount),
          turnstile_daily_usage_threshold: parseOptionalNumber(editTurnstileDailyUsage),
          daily_image_access_limit: parseOptionalNumber(editImageAccessLimit),
          image_access_turnstile_bonus_quota: parseOptionalNumber(editImageAccessBonusQuota),
          daily_image_access_hard_limit: parseOptionalNumber(editImageAccessHardLimit),
        },
      });
      setUsers((current) => current.map((item) => (item.user_id === updated.user_id ? updated : item)));
      setEditPassword("");
      push({ kind: "success", title: `已更新 ${updated.username}` });
      await loadAdminData({ silent: true });
    } catch (e: any) {
      push({ kind: "error", title: "用户更新失败", message: getApiErrorMessage(e, "请检查输入") });
    } finally {
      setSavingUser(false);
    }
  };

  const resetSelectedQuota = async () => {
    if (!selectedUser) return;
    setResettingQuota(true);
    try {
      const updated = await client.adminResetQuota(selectedUser.user_id);
      setUsers((current) => current.map((item) => (item.user_id === updated.user_id ? updated : item)));
      push({ kind: "success", title: `已重置 ${updated.username} 今日额度` });
      await loadAdminData({ silent: true });
    } catch (e: any) {
      push({ kind: "error", title: "额度重置失败", message: e?.error?.message || "请稍后重试" });
    } finally {
      setResettingQuota(false);
    }
  };

  const createUser = async () => {
    const username = newUsername.trim().toLowerCase();
    const password = newPassword.trim();
    if (!username || !password) {
      push({ kind: "error", title: "请填写新账号用户名与密码" });
      return;
    }
    if (!ADMIN_USERNAME_PATTERN.test(username)) {
      push({ kind: "error", title: "创建用户失败", message: "用户名必须为 3-32 位，只能包含字母、数字、下划线、点和短横线" });
      return;
    }
    if (password.length < 8 || password.length > 128) {
      push({ kind: "error", title: "创建用户失败", message: "密码长度必须为 8-128 位" });
      return;
    }
    setCreatingUser(true);
    try {
      await client.adminCreateUser({
        username,
        password,
        role: newRole,
        enabled: newEnabled,
        policy_overrides: {
          daily_image_limit: parseOptionalNumber(newDailyLimit),
          concurrent_jobs_limit: parseOptionalNumber(newConcurrentLimit),
          turnstile_job_count_threshold: parseOptionalNumber(newTurnstileJobCount),
          turnstile_daily_usage_threshold: parseOptionalNumber(newTurnstileDailyUsage),
          daily_image_access_limit: parseOptionalNumber(newImageAccessLimit),
          image_access_turnstile_bonus_quota: parseOptionalNumber(newImageAccessBonusQuota),
          daily_image_access_hard_limit: parseOptionalNumber(newImageAccessHardLimit),
        },
      });
      setNewUsername("");
      setNewPassword("");
      setNewRole("USER");
      setNewEnabled(true);
      setNewDailyLimit("");
      setNewConcurrentLimit("");
      setNewTurnstileJobCount("");
      setNewTurnstileDailyUsage("");
      setNewImageAccessLimit("");
      setNewImageAccessBonusQuota("");
      setNewImageAccessHardLimit("");
      await loadAdminData({ silent: true });
      push({ kind: "success", title: "新用户已创建" });
    } catch (e: any) {
      push({ kind: "error", title: "创建用户失败", message: getApiErrorMessage(e, "请检查输入") });
    } finally {
      setCreatingUser(false);
    }
  };

  const saveProvider = async (providerId: string) => {
    setSavingProviderId(providerId);
    try {
      await client.adminUpdateProvider(providerId, {
        enabled: providerEnabledDrafts[providerId],
        note: providerNotes[providerId] || "",
      });
      await loadAdminData({ silent: true });
      push({ kind: "success", title: `已更新 ${providerId}` });
    } catch (e: any) {
      push({ kind: "error", title: "Provider 更新失败", message: getApiErrorMessage(e, "请稍后重试") });
    } finally {
      setSavingProviderId(null);
    }
  };

  const setProviderBalance = async (providerId: string) => {
    setSavingProviderBalanceId(`set:${providerId}`);
    try {
      await client.adminSetProviderBalance(providerId, parseOptionalMoney(providerSetBalanceDrafts[providerId] || ""));
      await loadAdminData({ silent: true });
      push({ kind: "success", title: `已设置 ${providerId} 余额` });
    } catch (e: any) {
      push({ kind: "error", title: "余额设置失败", message: getApiErrorMessage(e, "请检查金额") });
    } finally {
      setSavingProviderBalanceId(null);
    }
  };

  const addProviderBalance = async (providerId: string) => {
    const delta = parseOptionalMoney(providerAddBalanceDrafts[providerId] || "");
    if (delta == null || delta <= 0) {
      push({ kind: "error", title: "请输入大于 0 的充值金额" });
      return;
    }
    setSavingProviderBalanceId(`add:${providerId}`);
    try {
      await client.adminAddProviderBalance(providerId, delta);
      setProviderAddBalanceDrafts((prev) => ({ ...prev, [providerId]: "" }));
      await loadAdminData({ silent: true });
      push({ kind: "success", title: `已为 ${providerId} 增加余额` });
    } catch (e: any) {
      push({ kind: "error", title: "余额增加失败", message: getApiErrorMessage(e, "请检查金额") });
    } finally {
      setSavingProviderBalanceId(null);
    }
  };

  const loadSelectedUserTasks = async ({ cursor = null, append = false }: { cursor?: string | null; append?: boolean } = {}) => {
    if (!selectedUser) {
      setTaskItems([]);
      setTaskStats(null);
      setTaskNextCursor(null);
      return;
    }
    const requestSeq = ++taskRequestSeqRef.current;
    if (append) setTaskLoadingMore(true);
    else setTaskLoading(true);
    try {
      const payload = await client.adminUserJobs(selectedUser.user_id, {
        q: debouncedTaskSearch || undefined,
        status: taskStatusFilter === "ALL" ? undefined : taskStatusFilter,
        model: taskModelFilter === "ALL" ? undefined : taskModelFilter,
        from: taskFrom || undefined,
        to: taskTo || undefined,
        batch_name: taskBatchName || undefined,
        has_images: taskHasImages === "ALL" ? undefined : taskHasImages === "YES",
        failed_only: taskFailedOnly || undefined,
        sort: taskSort,
        cursor,
        limit: 24,
      });
      if (requestSeq !== taskRequestSeqRef.current) return;
      setTaskStats(payload.stats);
      setTaskNextCursor(payload.next_cursor || null);
      setTaskItems((current) =>
        append
          ? [...current, ...payload.items.filter((item) => !current.some((existing) => existing.job_id === item.job_id))]
          : payload.items
      );
    } catch (e: any) {
      if (requestSeq !== taskRequestSeqRef.current) return;
      push({ kind: "error", title: "任务列表加载失败", message: getApiErrorMessage(e, "请稍后重试") });
      if (!append) {
        setTaskItems([]);
        setTaskStats(null);
        setTaskNextCursor(null);
      }
    } finally {
      if (requestSeq === taskRequestSeqRef.current) {
        setTaskLoading(false);
        setTaskLoadingMore(false);
      }
    }
  };

  useEffect(() => {
    setTaskItems([]);
    setTaskStats(null);
    setTaskNextCursor(null);
    setSelectedTask(null);
    if (!selectedUser) return;
    loadSelectedUserTasks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUser?.user_id, debouncedTaskSearch, taskStatusFilter, taskModelFilter, taskFrom, taskTo, taskBatchName, taskFailedOnly, taskHasImages, taskSort]);

  useEffect(() => {
    if (!selectedTask) return;
    const updated = taskItems.find((item) => item.job_id === selectedTask.job_id) || null;
    if (updated) setSelectedTask(updated);
  }, [selectedTask, taskItems]);

  const selectedUserTags = selectedUser ? adminUserRiskTags(selectedUser) : [];
  const taskPreviewMap = useAdminTaskPreviewMap(taskItems, selectedUser?.user_id || "");
  const effectivePolicyRows = selectedUser
    ? [
        { key: "daily_image_limit" as const, label: "每日额度", value: selectedUser.policy.daily_image_limit ?? "无限制" },
        { key: "concurrent_jobs_limit" as const, label: "并发上限", value: selectedUser.policy.concurrent_jobs_limit },
        { key: "turnstile_job_count_threshold" as const, label: "job_count 验证阈值", value: selectedUser.policy.turnstile_job_count_threshold ?? "禁用" },
        { key: "turnstile_daily_usage_threshold" as const, label: "日生成量验证阈值", value: selectedUser.policy.turnstile_daily_usage_threshold ?? "禁用" },
        { key: "daily_image_access_limit" as const, label: "图片访问基础额度", value: selectedUser.policy.daily_image_access_limit ?? "默认/无限制" },
        { key: "image_access_turnstile_bonus_quota" as const, label: "图片访问验证加额", value: selectedUser.policy.image_access_turnstile_bonus_quota ?? "默认" },
        { key: "daily_image_access_hard_limit" as const, label: "图片访问硬上限", value: selectedUser.policy.daily_image_access_hard_limit ?? "默认/无限制" },
      ]
    : [];

  return (
    <PageContainer className="max-w-[1900px] px-5 2xl:px-8">
      <PageTitle
        title="Admin"
        subtitle="双栏用户工作台：左边筛人，右边做审查、风控和任务级强操作。"
        right={<Button variant="secondary" onClick={() => loadAdminData({ silent: true })} disabled={refreshing}>{refreshing ? "刷新中…" : "刷新"}</Button>}
      />

      <Card hover={false} className="rounded-[28px] px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
          <span className="rounded-full border border-zinc-200 bg-white px-3 py-1 dark:border-white/10 dark:bg-zinc-950/40">Users {overview?.system.users_total ?? "-"}</span>
          <span className="rounded-full border border-zinc-200 bg-white px-3 py-1 dark:border-white/10 dark:bg-zinc-950/40">Enabled {overview?.system.users_enabled ?? "-"}</span>
          <span className="rounded-full border border-zinc-200 bg-white px-3 py-1 dark:border-white/10 dark:bg-zinc-950/40">Active Jobs {overview?.system.active_jobs ?? "-"}</span>
          <span className="rounded-full border border-zinc-200 bg-white px-3 py-1 dark:border-white/10 dark:bg-zinc-950/40">Queued {overview?.system.queued_jobs ?? "-"}</span>
          <span className="rounded-full border border-zinc-200 bg-white px-3 py-1 dark:border-white/10 dark:bg-zinc-950/40">Running {overview?.system.running_jobs ?? "-"}</span>
          <span className="rounded-full border border-zinc-200 bg-white px-3 py-1 dark:border-white/10 dark:bg-zinc-950/40">Succeeded Today {overview?.system.succeeded_today ?? "-"}</span>
          <span className="rounded-full border border-zinc-200 bg-white px-3 py-1 dark:border-white/10 dark:bg-zinc-950/40">Failed Today {overview?.system.failed_today ?? "-"}</span>
          <span className="rounded-full border border-zinc-200 bg-white px-3 py-1 dark:border-white/10 dark:bg-zinc-950/40">Provider Healthy {overview?.providers.providers_healthy ?? "-"}</span>
        </div>
      </Card>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
        <Card className="h-fit xl:sticky xl:top-24" hover={false}>
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">Users</div>
          <div className="mt-2 text-lg font-bold text-zinc-900 dark:text-zinc-50">用户工作台</div>
          <div className="mt-4 space-y-3">
            <Field label="Search"><Input testId="admin-user-search" value={userSearch} onChange={setUserSearch} placeholder="username / user_id" /></Field>
            <Field label="Role">
              <Select testId="admin-user-role-filter" value={userRoleFilter} onChange={(value) => setUserRoleFilter(value as "ALL" | UserRole)} options={[{ value: "ALL", label: "All Roles" }, { value: "ADMIN", label: "ADMIN" }, { value: "USER", label: "USER" }]} />
            </Field>
            <Field label="State">
              <Select testId="admin-user-state-filter" value={userStateFilter} onChange={(value) => setUserStateFilter(value as typeof userStateFilter)} options={[{ value: "ALL", label: "All Users" }, { value: "ENABLED", label: "Enabled" }, { value: "DISABLED", label: "Disabled" }, { value: "RUNNING", label: "Running Jobs" }, { value: "HIGH_USAGE", label: "High Usage" }, { value: "RISK_ONLY", label: "Risk Only" }]} />
            </Field>
            <Field label="Sort">
              <Select testId="admin-user-sort" value={userSort} onChange={(value) => setUserSort(value as typeof userSort)} options={[{ value: "RISK_FIRST", label: "Risk First" }, { value: "RECENT_ACTIVE", label: "Recent Active" }, { value: "USERNAME", label: "Username" }, { value: "CREATED_DESC", label: "Newest First" }]} />
            </Field>
          </div>

          <div className="mt-4 space-y-2">
            {filteredUsers.length ? filteredUsers.map((user) => {
              const active = user.user_id === selectedUserId;
              const tags = adminUserRiskTags(user);
              return (
                <button key={user.user_id} type="button" onClick={() => setSelectedUserId(user.user_id)} data-testid={`admin-user-card-${user.user_id}`} className={cn("w-full rounded-2xl border p-3 text-left transition", active ? "border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900" : "border-zinc-200 bg-white/70 hover:border-zinc-400 dark:border-white/10 dark:bg-zinc-950/30")}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-bold">{user.username}</div>
                      <div className={cn("mt-1 text-[11px]", active ? "text-white/80 dark:text-zinc-700" : "text-zinc-500 dark:text-zinc-400")}>
                        {user.role} · {user.enabled ? "enabled" : "disabled"} · last login {formatLocal(user.last_login_at)}
                      </div>
                    </div>
                    <div className={cn("text-right text-[11px]", active ? "text-white/80 dark:text-zinc-700" : "text-zinc-500 dark:text-zinc-400")}>
                      <div>{user.total_jobs} jobs</div>
                      <div>{user.usage.active_jobs} active</div>
                    </div>
                  </div>
                  <div className={cn("mt-2 grid grid-cols-2 gap-2 text-[11px]", active ? "text-white/85 dark:text-zinc-700" : "text-zinc-600 dark:text-zinc-300")}>
                    <div>today created {user.usage.jobs_created_today}</div>
                    <div>today images {user.usage.images_generated_today}</div>
                    <div>quota {user.usage.quota_consumed_today}/{user.policy.daily_image_limit ?? "∞"}</div>
                    <div>run/q {user.usage.running_jobs || 0}/{user.usage.queued_jobs || 0}</div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {tags.length ? tags.map((tag) => <AdminUserRiskChip key={tag} label={tag} />) : <span className="text-[10px] text-zinc-400">no flags</span>}
                  </div>
                </button>
              );
            }) : <EmptyHint text="没有匹配的用户" />}
          </div>
        </Card>

        <div className="space-y-4">
          {!selectedUser ? (
            <Card hover={false}><EmptyHint text="请先选择一个用户" /></Card>
          ) : (
            <>
              <Card hover={false}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">Selected User</div>
                    <div className="mt-1 text-2xl font-bold text-zinc-900 dark:text-zinc-50">{selectedUser.username}</div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {selectedUserTags.length ? selectedUserTags.map((tag) => <AdminUserRiskChip key={tag} label={tag} />) : <AdminUserRiskChip label="healthy" />}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant={detailTab === "overview" ? "primary" : "ghost"} onClick={() => setDetailTab("overview")}>概览</Button>
                    <Button variant={detailTab === "tasks" ? "primary" : "ghost"} onClick={() => setDetailTab("tasks")}>任务</Button>
                    <Button variant={detailTab === "policy" ? "primary" : "ghost"} onClick={() => setDetailTab("policy")}>风控与额度</Button>
                  </div>
                </div>
              </Card>

              {detailTab === "overview" ? (
                <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.1fr_0.9fr]">
                  <Card hover={false}>
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">概览</div>
                        <div className="text-xs text-zinc-600 dark:text-zinc-300">身份、使用情况、快速动作与生效策略来源。</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button variant="secondary" onClick={resetSelectedQuota} disabled={resettingQuota}>{resettingQuota ? "重置中…" : "重置今日额度"}</Button>
                        <Button variant="primary" onClick={saveSelectedUser} disabled={savingUser}>{savingUser ? "保存中…" : "保存用户"}</Button>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-3 md:grid-cols-3">
                      <Card hover={false} className="p-3"><KeyValue k="role" v={editRole} /></Card>
                      <Card hover={false} className="p-3"><KeyValue k="enabled" v={editEnabled ? "true" : "false"} /></Card>
                      <Card hover={false} className="p-3"><KeyValue k="last_login" v={formatLocal(selectedUser.last_login_at)} /></Card>
                      <Card hover={false} className="p-3"><KeyValue k="created" v={formatLocal(selectedUser.created_at)} /></Card>
                      <Card hover={false} className="p-3"><KeyValue k="total_jobs" v={selectedUser.total_jobs} /></Card>
                      <Card hover={false} className="p-3"><KeyValue k="remaining_images" v={selectedUser.usage.remaining_images_today ?? "∞"} /></Card>
                    </div>

                    <div className="mt-4 rounded-2xl border border-zinc-200 bg-zinc-50/80 p-3 dark:border-white/10 dark:bg-zinc-950/30">
                      <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">快速动作</div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button variant="ghost" onClick={() => setEditEnabled((current) => !current)}>{editEnabled ? "设为禁用" : "设为启用"}</Button>
                        <Button variant="ghost" onClick={() => setEditRole((current) => (current === "ADMIN" ? "USER" : "ADMIN"))}>切换角色到 {editRole === "ADMIN" ? "USER" : "ADMIN"}</Button>
                        <Button variant="ghost" onClick={generateTempPassword}>生成临时密码</Button>
                        <Button variant="ghost" onClick={() => setDetailTab("policy")}>进入风控编辑</Button>
                      </div>
                      {editPassword ? (
                        <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800 dark:border-sky-800/50 dark:bg-sky-950/30 dark:text-sky-200">
                          当前待保存的新密码：<span className="font-bold">{editPassword}</span>
                        </div>
                      ) : null}
                    </div>
                  </Card>

                  <Card hover={false}>
                    <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">当前生效策略</div>
                    <div className="mt-3 space-y-2">
                      {effectivePolicyRows.map((row) => {
                        const overridden = adminUserOverrideValue(selectedUser, row.key) != null;
                        return (
                          <div key={row.key} className="flex items-center justify-between rounded-2xl border border-zinc-200 bg-white/70 px-3 py-2 text-sm dark:border-white/10 dark:bg-zinc-950/30">
                            <div>
                              <div className="font-semibold text-zinc-900 dark:text-zinc-50">{row.label}</div>
                              <div className="text-[11px] text-zinc-500 dark:text-zinc-400">来源：{overridden ? "user override" : selectedUser.role === "ADMIN" && row.key === "concurrent_jobs_limit" ? "admin default" : "system default"}</div>
                            </div>
                            <div className="text-right">
                              <div className="font-bold text-zinc-900 dark:text-zinc-50">{String(row.value)}</div>
                              {overridden ? <div className="text-[11px] text-amber-600 dark:text-amber-200">override</div> : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </Card>
                </div>
              ) : null}

              {detailTab === "tasks" ? (
                <div className="space-y-4">
                  <Card hover={false}>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">用户任务</div>
                        <div className="text-xs text-zinc-600 dark:text-zinc-300">服务端分页任务画廊，不复用本地 History 数据。</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button variant={taskDensity === "gallery" ? "secondary" : "ghost"} onClick={() => setTaskDensity("gallery")}>画廊</Button>
                        <Button variant={taskDensity === "list" ? "secondary" : "ghost"} onClick={() => setTaskDensity("list")}>列表</Button>
                        <Button variant="secondary" onClick={() => loadSelectedUserTasks()} disabled={taskLoading || taskLoadingMore}>刷新任务</Button>
                      </div>
                    </div>

                    <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                      <Field label="Search"><Input testId="admin-task-search" value={taskSearch} onChange={setTaskSearch} placeholder="job id / prompt / model / error" /></Field>
                      <Field label="Status">
                        <Select testId="admin-task-status-filter" value={taskStatusFilter} onChange={(value) => setTaskStatusFilter(value as JobStatus | "ALL")} options={[{ value: "ALL", label: "All Statuses" }, { value: "QUEUED", label: "Queued" }, { value: "RUNNING", label: "Running" }, { value: "SUCCEEDED", label: "Succeeded" }, { value: "FAILED", label: "Failed" }, { value: "CANCELLED", label: "Cancelled" }]} />
                      </Field>
                      <Field label="Model">
                        <Select testId="admin-task-model-filter" value={String(taskModelFilter)} onChange={(value) => setTaskModelFilter(value as ModelId | "ALL")} options={[{ value: "ALL", label: "All Models" }, ...catalog.models.map((model) => ({ value: model.model_id, label: model.label }))]} />
                      </Field>
                      <Field label="Sort">
                        <Select testId="admin-task-sort" value={taskSort} onChange={(value) => setTaskSort(value as AdminTaskSortKey)} options={[{ value: "created_desc", label: "Created Desc" }, { value: "created_asc", label: "Created Asc" }, { value: "updated_desc", label: "Updated Desc" }, { value: "updated_asc", label: "Updated Asc" }, { value: "duration_desc", label: "Duration Desc" }]} />
                      </Field>
                      <Field label="From"><Input testId="admin-task-from" value={taskFrom} onChange={setTaskFrom} type="date" /></Field>
                      <Field label="To"><Input testId="admin-task-to" value={taskTo} onChange={setTaskTo} type="date" /></Field>
                      <Field label="Batch Name"><Input testId="admin-task-batch-name" value={taskBatchName} onChange={setTaskBatchName} placeholder="可留空" /></Field>
                      <Field label="Images">
                        <Select testId="admin-task-images-filter" value={taskHasImages} onChange={(value) => setTaskHasImages(value as typeof taskHasImages)} options={[{ value: "ALL", label: "All" }, { value: "YES", label: "Has Images" }, { value: "NO", label: "No Images" }]} />
                      </Field>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <div className="flex items-center justify-between rounded-2xl border border-zinc-200 bg-zinc-50/80 px-3 py-2 dark:border-white/10 dark:bg-zinc-950/30">
                        <div>
                          <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Only Failed</div>
                          <div className="text-[11px] text-zinc-500 dark:text-zinc-400">Failed + cancelled</div>
                        </div>
                        <Switch testId="admin-task-failed-only" value={taskFailedOnly} onChange={setTaskFailedOnly} />
                      </div>
                      <div className="flex flex-wrap gap-2 text-xs text-zinc-600 dark:text-zinc-300">
                        <span className="rounded-full border border-zinc-200 bg-white px-3 py-1 dark:border-white/10 dark:bg-zinc-950/40">Total {taskStats?.total ?? 0}</span>
                        <span className="rounded-full border border-zinc-200 bg-white px-3 py-1 dark:border-white/10 dark:bg-zinc-950/40">Active {taskStats?.active ?? 0}</span>
                        <span className="rounded-full border border-zinc-200 bg-white px-3 py-1 dark:border-white/10 dark:bg-zinc-950/40">Running {taskStats?.running ?? 0}</span>
                        <span className="rounded-full border border-zinc-200 bg-white px-3 py-1 dark:border-white/10 dark:bg-zinc-950/40">Queued {taskStats?.queued ?? 0}</span>
                        <span className="rounded-full border border-zinc-200 bg-white px-3 py-1 dark:border-white/10 dark:bg-zinc-950/40">Succeeded {taskStats?.succeeded ?? 0}</span>
                        <span className="rounded-full border border-zinc-200 bg-white px-3 py-1 dark:border-white/10 dark:bg-zinc-950/40">Failed {taskStats?.failed ?? 0}</span>
                      </div>
                    </div>
                  </Card>

                  {taskLoading ? (
                    <Card hover={false}><Skeleton className="h-48 w-full" /></Card>
                  ) : taskItems.length ? (
                    <>
                      <div className={cn("grid gap-5", taskDensity === "list" ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2 xl:grid-cols-2 2xl:grid-cols-3")}>
                        {taskItems.map((item) => (
                          <AdminTaskCard key={item.job_id} item={item} preview={taskPreviewMap[item.job_id]} density={taskDensity} onOpen={() => setSelectedTask(item)} />
                        ))}
                      </div>
                      {taskNextCursor ? (
                        <div className="flex justify-center">
                          <Button variant="secondary" onClick={() => loadSelectedUserTasks({ cursor: taskNextCursor, append: true })} disabled={taskLoadingMore}>{taskLoadingMore ? "加载中…" : "加载更多"}</Button>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <Card hover={false}><EmptyHint text="当前筛选条件下没有任务" /></Card>
                  )}
                </div>
              ) : null}

              {detailTab === "policy" ? (
                <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.05fr_0.95fr]">
                  <Card hover={false}>
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">风控与额度</div>
                        <div className="text-xs text-zinc-600 dark:text-zinc-300">这些字段只编辑 override；留空表示恢复跟随默认。</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button variant="ghost" onClick={clearOverrideDrafts}>清空全部 override</Button>
                        <Button variant="ghost" onClick={() => applyRiskPreset("STRICT")}>设为高风险模式</Button>
                        <Button variant="ghost" onClick={() => applyRiskPreset("RELAXED")}>设为宽松模式</Button>
                        <Button variant="primary" onClick={saveSelectedUser} disabled={savingUser}>{savingUser ? "保存中…" : "保存用户"}</Button>
                      </div>
                    </div>

                    <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                      <div className="space-y-3">
                        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">身份与控制</div>
                        <Field label="username"><div className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700 dark:border-white/10 dark:bg-zinc-950/30 dark:text-zinc-200">{selectedUser.username}</div></Field>
                        <Field label="role"><Select value={editRole} onChange={(value) => setEditRole(value as UserRole)} options={[{ value: "ADMIN", label: "ADMIN" }, { value: "USER", label: "USER" }]} /></Field>
                        <Field label="enabled"><div className="flex h-[42px] items-center"><Switch value={editEnabled} onChange={setEditEnabled} /></div></Field>
                        <Field label="new password"><Input value={editPassword} onChange={setEditPassword} type="password" placeholder="留空则不改密码" /></Field>
                      </div>
                      <div className="space-y-3">
                        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">生成额度与并发</div>
                        <Field label="daily_image_limit"><Input testId="admin-policy-daily-limit" value={editDailyLimit} onChange={setEditDailyLimit} placeholder="留空跟随默认" /></Field>
                        <Field label="concurrent_jobs_limit"><Input testId="admin-policy-concurrent-limit" value={editConcurrentLimit} onChange={setEditConcurrentLimit} placeholder="留空跟随默认" /></Field>
                        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">Turnstile</div>
                        <Field label="turnstile_job_count_threshold"><Input testId="admin-policy-turnstile-job-count" value={editTurnstileJobCount} onChange={setEditTurnstileJobCount} placeholder="留空禁用/跟随默认" /></Field>
                        <Field label="turnstile_daily_usage_threshold"><Input testId="admin-policy-turnstile-daily-usage" value={editTurnstileDailyUsage} onChange={setEditTurnstileDailyUsage} placeholder="留空禁用/跟随默认" /></Field>
                        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">图片访问</div>
                        <Field label="daily_image_access_limit"><Input testId="admin-policy-image-access-limit" value={editImageAccessLimit} onChange={setEditImageAccessLimit} placeholder="留空跟随默认" /></Field>
                        <Field label="image_access_turnstile_bonus_quota"><Input testId="admin-policy-image-access-bonus" value={editImageAccessBonusQuota} onChange={setEditImageAccessBonusQuota} placeholder="留空跟随默认" /></Field>
                        <Field label="daily_image_access_hard_limit"><Input testId="admin-policy-image-access-hard-limit" value={editImageAccessHardLimit} onChange={setEditImageAccessHardLimit} placeholder="留空跟随默认" /></Field>
                      </div>
                    </div>
                  </Card>

                  <Card hover={false}>
                    <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">来源解释</div>
                    <div className="mt-3 space-y-2">
                      {effectivePolicyRows.map((row) => {
                        const overrideValue = adminUserOverrideValue(selectedUser, row.key);
                        return (
                          <div key={row.key} className="rounded-2xl border border-zinc-200 bg-white/70 px-3 py-3 dark:border-white/10 dark:bg-zinc-950/30">
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <div className="font-semibold text-zinc-900 dark:text-zinc-50">{row.label}</div>
                                <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{overrideValue == null ? "当前跟随默认策略" : `当前来自 override：${overrideValue}`}</div>
                              </div>
                              <div className="text-right text-sm font-bold text-zinc-900 dark:text-zinc-50">{String(row.value)}</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </Card>
                </div>
              ) : null}

              <Card hover={false}>
                <div className="flex items-center justify-between">
                  <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">创建新用户</div>
                  <Button variant="primary" onClick={createUser} disabled={creatingUser}>{creatingUser ? "创建中…" : "创建"}</Button>
                </div>
                <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                  <Field label="username"><Input value={newUsername} onChange={setNewUsername} placeholder="alice" /></Field>
                  <Field label="password"><Input value={newPassword} onChange={setNewPassword} type="password" placeholder="至少 8 位" /></Field>
                  <Field label="role"><Select value={newRole} onChange={(value) => setNewRole(value as UserRole)} options={[{ value: "USER", label: "USER" }, { value: "ADMIN", label: "ADMIN" }]} /></Field>
                  <Field label="enabled"><div className="flex h-[42px] items-center"><Switch value={newEnabled} onChange={setNewEnabled} /></div></Field>
                  <Field label="daily_image_limit"><Input value={newDailyLimit} onChange={setNewDailyLimit} placeholder="留空使用默认值" /></Field>
                  <Field label="concurrent_jobs_limit"><Input value={newConcurrentLimit} onChange={setNewConcurrentLimit} placeholder="留空使用默认值" /></Field>
                  <Field label="turnstile_job_count_threshold"><Input value={newTurnstileJobCount} onChange={setNewTurnstileJobCount} placeholder="留空使用默认值" /></Field>
                  <Field label="turnstile_daily_usage_threshold"><Input value={newTurnstileDailyUsage} onChange={setNewTurnstileDailyUsage} placeholder="留空使用默认值" /></Field>
                  <Field label="daily_image_access_limit"><Input value={newImageAccessLimit} onChange={setNewImageAccessLimit} placeholder="留空使用默认值" /></Field>
                  <Field label="image_access_turnstile_bonus_quota"><Input value={newImageAccessBonusQuota} onChange={setNewImageAccessBonusQuota} placeholder="留空使用默认值" /></Field>
                  <Field label="daily_image_access_hard_limit"><Input value={newImageAccessHardLimit} onChange={setNewImageAccessHardLimit} placeholder="留空使用默认值" /></Field>
                </div>
              </Card>
            </>
          )}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[1fr_1.2fr]">
        <Card hover={false}>
          <div className="flex items-center justify-between">
            <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">全局策略</div>
            <Button variant="primary" onClick={savePolicy} disabled={!policyDraft || savingPolicy}>{savingPolicy ? "保存中…" : "保存策略"}</Button>
          </div>
          {policyDraft ? (
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field label="普通用户每日额度"><Input value={String(policyDraft.default_user_daily_image_limit)} onChange={(v) => setPolicyDraft({ ...policyDraft, default_user_daily_image_limit: Number(v || 0) })} /></Field>
              <Field label="超额额外额度"><Input value={String(policyDraft.default_user_extra_daily_image_limit)} onChange={(v) => setPolicyDraft({ ...policyDraft, default_user_extra_daily_image_limit: Number(v || 0) })} /></Field>
              <Field label="普通用户并发上限"><Input value={String(policyDraft.default_user_concurrent_jobs_limit)} onChange={(v) => setPolicyDraft({ ...policyDraft, default_user_concurrent_jobs_limit: Number(v || 0) })} /></Field>
              <Field label="管理员并发上限"><Input value={String(policyDraft.default_admin_concurrent_jobs_limit)} onChange={(v) => setPolicyDraft({ ...policyDraft, default_admin_concurrent_jobs_limit: Number(v || 0) })} /></Field>
              <Field label="job_count 触发阈值"><Input value={String(policyDraft.default_user_turnstile_job_count_threshold)} onChange={(v) => setPolicyDraft({ ...policyDraft, default_user_turnstile_job_count_threshold: Number(v || 0) })} /></Field>
              <Field label="日生成量触发阈值"><Input value={String(policyDraft.default_user_turnstile_daily_usage_threshold)} onChange={(v) => setPolicyDraft({ ...policyDraft, default_user_turnstile_daily_usage_threshold: Number(v || 0) })} /></Field>
              <Field label="图片访问基础额度"><Input value={String(policyDraft.default_user_daily_image_access_limit)} onChange={(v) => setPolicyDraft({ ...policyDraft, default_user_daily_image_access_limit: Number(v || 0) })} /></Field>
              <Field label="图片访问验证加额"><Input value={String(policyDraft.default_user_image_access_turnstile_bonus_quota)} onChange={(v) => setPolicyDraft({ ...policyDraft, default_user_image_access_turnstile_bonus_quota: Number(v || 0) })} /></Field>
              <Field label="图片访问硬上限"><Input value={String(policyDraft.default_user_daily_image_access_hard_limit)} onChange={(v) => setPolicyDraft({ ...policyDraft, default_user_daily_image_access_hard_limit: Number(v || 0) })} /></Field>
            </div>
          ) : <Skeleton className="mt-3 h-28 w-full" />}
        </Card>

        <Card hover={false}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">中转站状态</div>
              <div className="text-xs text-zinc-600 dark:text-zinc-300">Provider 管理保留，但主视觉下移，避免和用户管理抢焦点。</div>
            </div>
            <div className="rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1 text-xs font-semibold text-zinc-600 dark:border-white/10 dark:bg-zinc-950/40 dark:text-zinc-300">{overview?.providers.providers_total ?? 0} providers</div>
          </div>
          <div className="mt-3 space-y-3">
            {(overview?.providers.providers || []).length ? (overview?.providers.providers || []).map((provider) => (
              <div key={provider.provider_id} className="rounded-2xl border border-zinc-200 bg-white/60 p-4 dark:border-white/10 dark:bg-zinc-950/30">
                <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">{provider.label}</div>
                      <span className="rounded-full border border-zinc-200 px-2 py-0.5 text-[10px] font-semibold text-zinc-600 dark:border-white/10 dark:text-zinc-300">{provider.provider_id}</span>
                      <span className="rounded-full border border-zinc-200 px-2 py-0.5 text-[10px] font-semibold text-zinc-600 dark:border-white/10 dark:text-zinc-300">{provider.adapter_type}</span>
                      <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", provider.cooldown_active ? "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-200" : provider.enabled ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200" : "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200")}>
                        {provider.cooldown_active ? "cooldown" : provider.enabled ? "enabled" : "disabled"}
                      </span>
                    </div>
                    <div className="mt-2 break-all text-xs text-zinc-500 dark:text-zinc-400">{provider.base_url}</div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
                      <KeyValue k="cost" v={`${numberish(provider.cost_per_image_cny)} CNY`} />
                      <KeyValue k="balance" v={provider.remaining_balance_cny == null ? "unknown" : `${numberish(provider.remaining_balance_cny)} CNY`} />
                      <KeyValue k="quota" v={provider.quota_state} />
                      <KeyValue k="active" v={`${provider.active_requests}/${provider.max_concurrency}`} />
                      <KeyValue k="success" v={`${Math.round(provider.final_success_rate * 100)}%`} />
                      <KeyValue k="fails" v={`${provider.fail_count} (${provider.consecutive_failures} 连续)`} />
                      <KeyValue k="p50" v={provider.latency_p50_ms == null ? "-" : `${Math.round(provider.latency_p50_ms)} ms`} />
                      <KeyValue k="p95" v={provider.latency_p95_ms == null ? "-" : `${Math.round(provider.latency_p95_ms)} ms`} />
                    </div>
                    <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">last_circuit: {formatLocal(provider.last_circuit_open_time)} · until: {formatLocal(provider.last_circuit_open_until)} · reason: {provider.last_circuit_open_reason || "-"}</div>
                    <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">last_forced_activation: {formatLocal(provider.last_forced_activation_time)} · mode: {provider.last_forced_activation_mode || "-"} · count: {provider.forced_activation_count}</div>
                  </div>

                  <div className="grid min-w-0 gap-2 xl:w-[420px] xl:grid-cols-2">
                    <Field label="enabled"><div className="flex h-[42px] items-center"><Switch value={providerEnabledDrafts[provider.provider_id] ?? provider.enabled} onChange={(value) => setProviderEnabledDrafts((prev) => ({ ...prev, [provider.provider_id]: value }))} /></div></Field>
                    <Field label="note"><Input value={providerNotes[provider.provider_id] ?? provider.note ?? ""} onChange={(value) => setProviderNotes((prev) => ({ ...prev, [provider.provider_id]: value }))} placeholder="备注" /></Field>
                    <Field label="set balance (CNY)">
                      <div className="flex gap-2">
                        <Input value={providerSetBalanceDrafts[provider.provider_id] ?? ""} onChange={(value) => setProviderSetBalanceDrafts((prev) => ({ ...prev, [provider.provider_id]: value }))} placeholder="可留空设为 unknown" />
                        <Button variant="secondary" onClick={() => setProviderBalance(provider.provider_id)} disabled={savingProviderBalanceId === `set:${provider.provider_id}`}>{savingProviderBalanceId === `set:${provider.provider_id}` ? "设置中…" : "设置"}</Button>
                      </div>
                    </Field>
                    <Field label="add balance (CNY)">
                      <div className="flex gap-2">
                        <Input value={providerAddBalanceDrafts[provider.provider_id] ?? ""} onChange={(value) => setProviderAddBalanceDrafts((prev) => ({ ...prev, [provider.provider_id]: value }))} placeholder="充值金额" />
                        <Button variant="secondary" onClick={() => addProviderBalance(provider.provider_id)} disabled={savingProviderBalanceId === `add:${provider.provider_id}`}>{savingProviderBalanceId === `add:${provider.provider_id}` ? "增加中…" : "增加"}</Button>
                      </div>
                    </Field>
                    <div className="xl:col-span-2 flex justify-end">
                      <Button variant="primary" onClick={() => saveProvider(provider.provider_id)} disabled={savingProviderId === provider.provider_id}>{savingProviderId === provider.provider_id ? "保存中…" : "保存 Provider"}</Button>
                    </div>
                  </div>
                </div>
              </div>
            )) : <EmptyHint text="暂无 provider 配置" />}
          </div>
        </Card>
      </div>

      <AdminTaskDetailDrawer
        item={selectedTask}
        owner={selectedUser}
        onClose={() => setSelectedTask(null)}
        onRemoved={(jobId) => setTaskItems((current) => current.filter((item) => item.job_id !== jobId))}
        onRefreshList={() => loadSelectedUserTasks()}
      />
    </PageContainer>
  );
}

function BatchCreatePage() {
  const client = useApiClient();
  const catalog = useModelCatalog();
  const navigate = useNavigate();
  const { push } = useToast();
  const { session, user, isAdmin } = useAuthSession();
  const providerSummary = useAdminProviderSummary(isAdmin);
  const setSession = useAuthStore((s) => s.setSession);
  const settings = useSettingsStore((s) => s.settings);
  const pickerSessions = usePickerStore((s) => s.sessions);
  const createPickerSession = usePickerStore((s) => s.createSession);
  const addPickerItems = usePickerStore((s) => s.addItems);

  const MAX_REF_FILES = 14;
  const sortedPickerSessions = useMemo(
    () =>
      [...pickerSessions].sort(
        (a, b) => (new Date(b.created_at).getTime() || 0) - (new Date(a.created_at).getTime() || 0)
      ),
    [pickerSessions]
  );
  const modelMap = useMemo(
    () => new Map(catalog.models.map((item) => [item.model_id, item])),
    [catalog.models]
  );
  const initialModel = settings.defaultModel || catalog.default_model;
  const initialParams = useMemo(
    () => getParamsForModel(settings, initialModel, modelMap.get(initialModel)?.default_params),
    [initialModel, modelMap, settings.defaultParams, settings.defaultParamsByModel]
  );

  const [batchName, setBatchName] = useState("");
  const [batchNote, setBatchNote] = useState("");
  const [defaultCollectionStrategy, setDefaultCollectionStrategy] = useState<BatchCollectionMode>("AUTO_BATCH");
  const [submitMode, setSubmitMode] = useState<BatchSubmitMode>("IMMEDIATE");

  const [globalPrompt, setGlobalPrompt] = useState("");
  const [globalFiles, setGlobalFiles] = useState<File[]>([]);
  const [globalModel, setGlobalModel] = useState<ModelId>(initialModel);
  const [globalAspect, setGlobalAspect] = useState<AspectRatio>(initialParams.aspect_ratio);
  const [globalSize, setGlobalSize] = useState<ImageSize>(initialParams.image_size);
  const [globalProviderId, setGlobalProviderId] = useState<string | null>(initialParams.provider_id ?? null);
  const [globalTemperature, setGlobalTemperature] = useState<number>(initialParams.temperature);
  const [globalJobCount, setGlobalJobCount] = useState<number>(1);
  const [namingTemplate, setNamingTemplate] = useState(BATCH_NAME_TEMPLATE_DEFAULT);

  const [submitEnabledOnly, setSubmitEnabledOnly] = useState(true);
  const [submitStartFrom, setSubmitStartFrom] = useState("1");
  const [autoInjectPageNo, setAutoInjectPageNo] = useState(true);
  const [removeFailedFromSession, setRemoveFailedFromSession] = useState(true);
  const [selectedSectionIds, setSelectedSectionIds] = useState<string[]>([]);
  const [sections, setSections] = useState<BatchSection[]>(() => [
    createBatchSectionDraft({
      fallbackModel: initialModel,
      settings,
      defaultCollectionMode: "AUTO_BATCH",
    }),
  ]);

  const [loading, setLoading] = useState(false);
  const [generationModalOpen, setGenerationModalOpen] = useState(false);
  const [generationTurnstileToken, setGenerationTurnstileToken] = useState<string | null>(null);
  const [generationTurnstileKey, setGenerationTurnstileKey] = useState(0);
  const [verifyingGenerationTurnstile, setVerifyingGenerationTurnstile] = useState(false);
  const [pendingGenerationTargetCount, setPendingGenerationTargetCount] = useState<number | null>(null);
  const batchDraftHydratedRef = useRef(false);
  const batchDraftFileEntriesRef = useRef<DraftFileEntry[]>([]);
  const batchDraftScope = user?.user_id || "__guest__";

  const globalModelMeta = useMemo(
    () => modelMap.get(globalModel) || catalog.models[0] || null,
    [catalog.models, globalModel, modelMap]
  );
  const availableProviders = providerSummary?.providers ?? EMPTY_PROVIDER_LIST;
  const globalProviderOptions = useMemo(
    () => providerSelectOptions(availableProviders, globalModel),
    [availableProviders, globalModel]
  );
  const globalDraftFileMetas = useMemo(() => globalFiles.map((file) => toPersistedDraftFileMeta(file)), [globalFiles]);
  const batchDraftSections = useMemo<BatchSectionDraftPersisted[]>(
    () =>
      sections.map((section) => ({
        id: section.id,
        section_title: section.section_title,
        section_prompt: section.section_prompt,
        section_model: section.section_model,
        section_aspect_ratio: section.section_aspect_ratio,
        section_image_size: section.section_image_size,
        section_provider_id: section.section_provider_id,
        section_temperature: section.section_temperature,
        section_job_count: section.section_job_count,
        collection_mode: section.collection_mode,
        collection_name: section.collection_name,
        existing_session_ids: [...section.existing_session_ids],
        inherit_previous_settings: section.inherit_previous_settings,
        enabled: section.enabled,
        section_reference_images: section.section_reference_images.map((file) => toPersistedDraftFileMeta(file)),
      })),
    [sections]
  );
  const batchDraftFileEntries = useMemo<DraftFileEntry[]>(
    () => [
      ...globalDraftFileMetas.map((meta) => ({ namespace: "global", meta })),
      ...batchDraftSections.flatMap((section) =>
        section.section_reference_images.map((meta) => ({
          namespace: `section:${section.id}`,
          meta,
        }))
      ),
    ],
    [batchDraftSections, globalDraftFileMetas]
  );
  const batchDraftSnapshot = useDebounced(
    {
      scope: batchDraftScope,
      batchName,
      batchNote,
      defaultCollectionStrategy,
      submitMode,
      globalPrompt,
      globalFiles: globalDraftFileMetas,
      globalModel,
      globalAspect,
      globalSize,
      globalProviderId,
      globalTemperature,
      globalJobCount,
      namingTemplate,
      submitEnabledOnly,
      submitStartFrom,
      autoInjectPageNo,
      removeFailedFromSession,
      selectedSectionIds,
      sections: batchDraftSections,
    },
    250
  );

  useEffect(() => {
    if (!catalog.models.some((item) => item.model_id === globalModel)) {
      setGlobalModel(catalog.default_model);
    }
  }, [catalog.default_model, catalog.models, globalModel]);

  useEffect(() => {
    if (!globalModelMeta) return;
    if (!globalModelMeta.supported_aspect_ratios.includes(globalAspect)) {
      setGlobalAspect((globalModelMeta.default_params.aspect_ratio || globalModelMeta.supported_aspect_ratios[0]) as AspectRatio);
    }
    if (globalModelMeta.supports_image_size) {
      if (!globalModelMeta.supported_image_sizes.includes(globalSize)) {
        setGlobalSize((globalModelMeta.default_params.image_size || globalModelMeta.supported_image_sizes[0]) as ImageSize);
      }
    } else if (globalSize !== "AUTO") {
      setGlobalSize("AUTO");
    }
  }, [globalAspect, globalModelMeta, globalSize]);

  useEffect(() => {
    if (!isAdmin) {
      if (globalProviderId !== null) setGlobalProviderId(null);
      setSections((prev) => {
        if (!prev.some((section) => section.section_provider_id != null)) return prev;
        return prev.map((section) =>
          section.section_provider_id == null ? section : { ...section, section_provider_id: null }
        );
      });
      return;
    }
    if (
      globalProviderId &&
      !availableProviders.some((provider) => provider.provider_id === globalProviderId && providerSupportsModel(provider, globalModel))
    ) {
      setGlobalProviderId(null);
    }
    setSections((prev) => {
      const hasInvalidProvider = prev.some(
        (section) =>
          section.section_provider_id &&
          !availableProviders.some(
            (provider) => provider.provider_id === section.section_provider_id && providerSupportsModel(provider, section.section_model)
          )
      );
      if (!hasInvalidProvider) return prev;
      return prev.map((section) =>
        section.section_provider_id &&
        !availableProviders.some(
          (provider) => provider.provider_id === section.section_provider_id && providerSupportsModel(provider, section.section_model)
        )
          ? { ...section, section_provider_id: null }
          : section
      );
    });
  }, [availableProviders, globalModel, globalProviderId, isAdmin]);

  useEffect(() => {
    setSections((prev) =>
      prev.map((section) => ({
        ...section,
        existing_session_ids: section.existing_session_ids.filter((id) =>
          sortedPickerSessions.some((session) => session.session_id === id)
        ),
      }))
    );
  }, [sortedPickerSessions]);

  useEffect(() => {
    if (!batchDraftHydratedRef.current) return;
    let cancelled = false;

    const syncBatchDraftFiles = async () => {
      const prevEntries = batchDraftFileEntriesRef.current;
      const prevMap = new Map(prevEntries.map((entry) => [`${entry.namespace}::${entry.meta.id}`, entry]));
      const nextMap = new Map(batchDraftFileEntries.map((entry) => [`${entry.namespace}::${entry.meta.id}`, entry]));
      const liveFilesByKey = new Map<string, File>();

      globalFiles.forEach((file) => {
        liveFilesByKey.set(`global::${persistedDraftFileId(file)}`, file);
      });
      sections.forEach((section) => {
        section.section_reference_images.forEach((file) => {
          liveFilesByKey.set(`section:${section.id}::${persistedDraftFileId(file)}`, file);
        });
      });

      for (const [key, entry] of prevMap.entries()) {
        if (nextMap.has(key)) continue;
        await deleteDraftFileBlob(batchDraftScope, KEY_BATCH_PAGE_DRAFT, entry.namespace, entry.meta);
      }

      for (const [key, entry] of nextMap.entries()) {
        if (prevMap.has(key)) continue;
        const file = liveFilesByKey.get(key);
        if (!file) continue;
        await putDraftFileBlob(batchDraftScope, KEY_BATCH_PAGE_DRAFT, entry.namespace, file, entry.meta);
      }

      if (cancelled) return;
      batchDraftFileEntriesRef.current = batchDraftFileEntries;
    };

    void syncBatchDraftFiles();
    return () => {
      cancelled = true;
    };
  }, [batchDraftFileEntries, batchDraftScope, globalFiles, sections]);

  useEffect(() => {
    if (!batchDraftHydratedRef.current) return;
    saveBatchPageDraft({
      ...batchDraftSnapshot,
      updated_at: isoNow(),
    });
  }, [batchDraftSnapshot]);

  const updateSection = (sectionId: string, updater: (section: BatchSection, index: number) => BatchSection) => {
    setSections((prev) =>
      prev.map((section, index) => (section.id === sectionId ? updater(section, index) : section))
    );
  };

  const makeDefaultSection = (seed?: Partial<BatchSection>) => ({
    ...createBatchSectionDraft({
      fallbackModel: globalModel,
      settings,
      defaultCollectionMode: defaultCollectionStrategy,
    }),
    section_model: globalModel,
    section_aspect_ratio: globalAspect,
    section_image_size: globalSize,
    section_provider_id: globalProviderId,
    section_temperature: globalTemperature,
    section_job_count: globalJobCount,
    collection_mode: defaultCollectionStrategy,
    inherit_previous_settings: false,
    ...(seed || {}),
    id: createDraftId("sec"),
  });

  useEffect(() => {
    let cancelled = false;
    batchDraftHydratedRef.current = false;
    batchDraftFileEntriesRef.current = [];

    const hydrate = async () => {
      const draft = loadBatchPageDraft();
      if (!draft || draft.scope !== batchDraftScope) {
        batchDraftHydratedRef.current = true;
        return;
      }

      const restoredGlobalFiles = await restoreDraftFiles(batchDraftScope, KEY_BATCH_PAGE_DRAFT, "global", draft.globalFiles || []);
      const restoredSectionsRaw = await Promise.all(
        (draft.sections || []).map(async (section) => {
          const restoredFiles = await restoreDraftFiles(
            batchDraftScope,
            KEY_BATCH_PAGE_DRAFT,
            `section:${section.id}`,
            section.section_reference_images || []
          );
          return {
            id: section.id || createDraftId("sec"),
            section_title: section.section_title || "",
            section_prompt: section.section_prompt || "",
            section_reference_images: restoredFiles,
            section_model: section.section_model || initialModel,
            section_aspect_ratio: section.section_aspect_ratio || initialParams.aspect_ratio,
            section_image_size: section.section_image_size || initialParams.image_size,
            section_provider_id: section.section_provider_id ?? initialParams.provider_id ?? null,
            section_temperature: typeof section.section_temperature === "number" ? section.section_temperature : initialParams.temperature,
            section_job_count: typeof section.section_job_count === "number" ? section.section_job_count : 1,
            collection_mode: section.collection_mode || draft.defaultCollectionStrategy || "AUTO_BATCH",
            collection_name: section.collection_name || "",
            existing_session_ids: Array.isArray(section.existing_session_ids) ? section.existing_session_ids : [],
            inherit_previous_settings: Boolean(section.inherit_previous_settings),
            enabled: section.enabled !== false,
          } satisfies BatchSection;
        })
      );
      if (cancelled) return;

      const fallbackSection = {
        ...createBatchSectionDraft({
          fallbackModel: draft.globalModel || initialModel,
          settings,
          defaultCollectionMode: draft.defaultCollectionStrategy || "AUTO_BATCH",
        }),
        section_model: draft.globalModel || initialModel,
        section_aspect_ratio: draft.globalAspect || initialParams.aspect_ratio,
        section_image_size: draft.globalSize || initialParams.image_size,
        section_provider_id: draft.globalProviderId ?? initialParams.provider_id ?? null,
        section_temperature: typeof draft.globalTemperature === "number" ? draft.globalTemperature : initialParams.temperature,
        section_job_count: typeof draft.globalJobCount === "number" ? draft.globalJobCount : 1,
        collection_mode: draft.defaultCollectionStrategy || "AUTO_BATCH",
        inherit_previous_settings: false,
      } satisfies BatchSection;
      const restoredSections = restoredSectionsRaw.length ? restoredSectionsRaw : [fallbackSection];

      setBatchName(draft.batchName || "");
      setBatchNote(draft.batchNote || "");
      setDefaultCollectionStrategy(draft.defaultCollectionStrategy || "AUTO_BATCH");
      setSubmitMode(draft.submitMode || "IMMEDIATE");
      setGlobalPrompt(draft.globalPrompt || "");
      setGlobalFiles(restoredGlobalFiles);
      setGlobalModel(draft.globalModel || initialModel);
      setGlobalAspect(draft.globalAspect || initialParams.aspect_ratio);
      setGlobalSize(draft.globalSize || initialParams.image_size);
      setGlobalProviderId(draft.globalProviderId ?? initialParams.provider_id ?? null);
      setGlobalTemperature(typeof draft.globalTemperature === "number" ? draft.globalTemperature : initialParams.temperature);
      setGlobalJobCount(typeof draft.globalJobCount === "number" ? draft.globalJobCount : 1);
      setNamingTemplate(draft.namingTemplate || BATCH_NAME_TEMPLATE_DEFAULT);
      setSubmitEnabledOnly(draft.submitEnabledOnly !== false);
      setSubmitStartFrom(draft.submitStartFrom || "1");
      setAutoInjectPageNo(draft.autoInjectPageNo !== false);
      setRemoveFailedFromSession(draft.removeFailedFromSession !== false);
      setSections(restoredSections);
      setSelectedSectionIds((draft.selectedSectionIds || []).filter((id) => restoredSections.some((section) => section.id === id)));
      batchDraftFileEntriesRef.current = [
        ...(draft.globalFiles || []).map((meta) => ({ namespace: "global", meta })),
        ...(draft.sections || []).flatMap((section) =>
          (section.section_reference_images || []).map((meta) => ({
            namespace: `section:${section.id}`,
            meta,
          }))
        ),
      ];
      batchDraftHydratedRef.current = true;
    };

    void hydrate();
    return () => {
      cancelled = true;
    };
  }, [batchDraftScope]);

  const toggleSelectedSection = (sectionId: string, checked: boolean) => {
    setSelectedSectionIds((prev) => {
      if (checked) return Array.from(new Set([sectionId, ...prev]));
      return prev.filter((id) => id !== sectionId);
    });
  };

  const applySectionModel = (sectionId: string, nextModel: ModelId) => {
    const cap = modelMap.get(nextModel);
    const defaults = getParamsForModel(settings, nextModel, cap?.default_params);
    updateSection(sectionId, (section) => ({
      ...section,
      section_model: nextModel,
      section_aspect_ratio: cap?.supported_aspect_ratios.includes(section.section_aspect_ratio)
        ? section.section_aspect_ratio
        : defaults.aspect_ratio,
      section_image_size: cap?.supports_image_size
        ? cap.supported_image_sizes.includes(section.section_image_size)
          ? section.section_image_size
          : defaults.image_size
        : "AUTO",
      section_provider_id:
        section.section_provider_id &&
        availableProviders.some((provider) => provider.provider_id === section.section_provider_id && providerSupportsModel(provider, nextModel))
          ? section.section_provider_id
          : defaults.provider_id,
      section_temperature: section.section_temperature ?? defaults.temperature,
    }));
  };

  const addSection = (seed?: Partial<BatchSection>) => {
    setSections((prev) => {
      return [
        ...prev,
        makeDefaultSection(seed),
      ];
    });
  };

  const duplicateSection = (sectionId: string) => {
    const current = sections.find((section) => section.id === sectionId);
    if (!current) return;
    addSection({
      ...current,
      section_title: current.section_title ? `${current.section_title} Copy` : "",
      section_reference_images: [...current.section_reference_images],
      existing_session_ids: [...current.existing_session_ids],
      enabled: true,
    });
  };

  const duplicateSelectedSections = () => {
    const targets = sections.filter((section) => selectedSectionIds.includes(section.id));
    if (!targets.length) return;
    targets.forEach((section) => {
      addSection({
        ...section,
        section_title: section.section_title ? `${section.section_title} Copy` : "",
        section_reference_images: [...section.section_reference_images],
        existing_session_ids: [...section.existing_session_ids],
        enabled: true,
      });
    });
    push({ kind: "success", title: "已复制所选分区", message: `${targets.length} 个` });
  };

  const deleteSelectedSections = () => {
    if (!selectedSectionIds.length) return;
    setSections((prev) => {
      const next = prev.filter((section) => !selectedSectionIds.includes(section.id));
      return next.length
        ? next
        : [
            makeDefaultSection(),
          ];
    });
    setSelectedSectionIds([]);
    push({ kind: "info", title: "已删除所选分区" });
  };

  const copyPreviousSectionParams = (sectionId: string) => {
    setSections((prev) =>
      prev.map((section, index) => {
        if (section.id !== sectionId || index === 0) return section;
        const previous = prev[index - 1];
        return {
          ...section,
      section_model: previous.section_model,
      section_aspect_ratio: previous.section_aspect_ratio,
      section_image_size: previous.section_image_size,
      section_provider_id: previous.section_provider_id,
      section_temperature: previous.section_temperature,
      section_job_count: previous.section_job_count,
      collection_mode: previous.collection_mode,
      inherit_previous_settings: true,
        };
      })
    );
    push({ kind: "success", title: "已复制上一个分区参数" });
  };

  const createAndAttachExistingSession = (sectionId: string, name?: string) => {
    const sessionId = createPickerSession(name);
    updateSection(sectionId, (section) => ({
      ...section,
      collection_mode: "EXISTING",
      existing_session_ids: Array.from(new Set([sessionId, ...section.existing_session_ids])),
    }));
    push({ kind: "success", title: "已创建并选中 session" });
  };

  const clearBatchAutosave = async () => {
    const entries = batchDraftFileEntriesRef.current;
    await Promise.all(
      entries.map((entry) => deleteDraftFileBlob(batchDraftScope, KEY_BATCH_PAGE_DRAFT, entry.namespace, entry.meta))
    );
    batchDraftFileEntriesRef.current = [];
    clearBatchPageDraft();
  };

  const plannedSections = useMemo(() => {
    const startIndex = clamp(Number(submitStartFrom || "1") || 1, 1, Math.max(1, sections.length));
    return sections
      .map((section, index) => ({ section, index, displayIndex: index + 1 }))
      .filter((item) => item.displayIndex >= startIndex)
      .filter((item) => (submitEnabledOnly ? item.section.enabled : true));
  }, [sections, submitEnabledOnly, submitStartFrom]);

  const totalPlannedJobs = useMemo(
    () =>
      plannedSections.reduce(
        (sum, item) => sum + clamp(Math.round(item.section.section_job_count || 0), 0, 12),
        0
      ),
    [plannedSections]
  );

  const estimatedCost = useMemo(
    () =>
      plannedSections.reduce((sum, item) => {
        const unit = estimateBatchUnitCost(item.section.section_model, item.section.section_image_size);
        return sum + unit * clamp(Math.round(item.section.section_job_count || 0), 0, 12);
      }, 0),
    [plannedSections]
  );

  const hasFreshGenerationVerification = (candidate: AuthSession | null) => {
    const ts = candidate?.generation_turnstile_verified_until;
    if (!ts) return false;
    const dt = new Date(ts);
    return Number.isFinite(dt.getTime()) && dt.getTime() > Date.now();
  };

  const needsGenerationTurnstile = (candidate: AuthSession | null, targetCount: number) => {
    const currentUser = candidate?.user;
    const currentUsage = candidate?.usage;
    if (!currentUser || currentUser.role === "ADMIN") return false;
    const countThreshold = currentUser.policy.turnstile_job_count_threshold;
    const dailyThreshold = currentUser.policy.turnstile_daily_usage_threshold;
    if (typeof countThreshold === "number" && targetCount > countThreshold) {
      return true;
    }
    if (typeof dailyThreshold === "number" && (currentUsage?.quota_consumed_today ?? 0) >= dailyThreshold) {
      return !hasFreshGenerationVerification(candidate);
    }
    return false;
  };

  const refreshSession = async () => {
    const nextSession = await client.me();
    setSession(nextSession);
    return nextSession;
  };

  const validateBatch = () => {
    if (!batchName.trim()) return "batch_name 不能为空";
    if (!globalPrompt.trim()) return "global_prompt 不能为空";
    if (!sections.length) return "至少需要 1 个分区";
    if (globalFiles.length > MAX_REF_FILES) return `全局参考图最多 ${MAX_REF_FILES} 张`;
    if (globalFiles.some((file) => !file.type.startsWith("image/"))) return "全局参考图必须是 image/*";
    if (!Number.isFinite(globalJobCount) || globalJobCount < 1 || globalJobCount > 12) {
      return "全局默认每分区生成数量需在 1~12 之间";
    }
    if (!plannedSections.length) return "没有可提交的分区";
    if (totalPlannedJobs > 100) return "批量提交总任务数暂时需控制在 100 以内";
    for (const item of plannedSections) {
      const section = item.section;
      if (section.section_reference_images.length > MAX_REF_FILES) {
        return `第 ${item.displayIndex} 分区参考图最多 ${MAX_REF_FILES} 张`;
      }
      if (section.section_reference_images.some((file) => !file.type.startsWith("image/"))) {
        return `第 ${item.displayIndex} 分区存在非图片参考图`;
      }
      if (!Number.isFinite(section.section_job_count) || section.section_job_count < 1 || section.section_job_count > 12) {
        return `第 ${item.displayIndex} 分区的 job_count 需在 1~12 之间`;
      }
      if (section.collection_mode === "EXISTING" && !section.existing_session_ids.length) {
        return `第 ${item.displayIndex} 分区选择了 Existing Session，但未勾选任何 session`;
      }
    }
    return null;
  };

  const attachJobToSessionIds = (
    sessionIds: string[],
    job: { job_id: string; job_access_token?: string; created_at?: string; status?: JobStatus }
  ) => {
    if (!sessionIds.length) return;
    sessionIds.forEach((sessionId) => {
      addPickerItems(sessionId, [
        {
          item_key: pickerPendingItemKey(job.job_id),
          job_id: job.job_id,
          job_access_token: job.job_access_token,
          picked: true,
          status: job.status || "QUEUED",
          added_at: job.created_at || isoNow(),
        },
      ]);
    });
  };

  const executeBatchSubmit = async (targetCountOverride?: number, allowTurnstileRecovery = true) => {
    const err = validateBatch();
    if (err) {
      push({ kind: "error", title: "表单校验失败", message: err });
      return;
    }

    const totalTargetCount = clamp(targetCountOverride ?? totalPlannedJobs, 1, 100);
    const batchId = createBatchId();
    const autoCreatedSessions = new Map<string, string>();
    let firstError: string | null = null;
    let createdCount = 0;
    let plannedOrdinal = 0;
    let firstJobId: string | null = null;

    const resolveSectionSessions = (section: BatchSection, displayIndex: number) => {
      if (section.collection_mode === "NONE") return [] as string[];
      if (section.collection_mode === "EXISTING") return section.existing_session_ids;
      const cached = autoCreatedSessions.get(section.id);
      if (cached) return [cached];
      const vars = {
        batch_name: batchName.trim(),
        page_no: String(displayIndex),
        section_title: section.section_title.trim() || "untitled",
      };
      const autoName =
        section.collection_mode === "AUTO_BATCH"
          ? renderTemplate(namingTemplate, vars)
          : section.collection_name.trim() || renderTemplate(namingTemplate, vars);
      const sessionId = createPickerSession(autoName);
      autoCreatedSessions.set(section.id, sessionId);
      return [sessionId];
    };

    setLoading(true);
    const abort = new AbortController();

    try {
      for (let sectionPos = 0; sectionPos < plannedSections.length; sectionPos++) {
        const item = plannedSections[sectionPos];
        const section = item.section;
        const modelMeta = modelMap.get(section.section_model) || modelMap.get(catalog.default_model) || catalog.models[0];
        if (!modelMeta) {
          throw { error: { code: "MODEL_NOT_READY", message: "模型目录加载失败，请稍后重试" } };
        }
        const fallbackParams = getParamsForModel(settings, section.section_model, modelMeta.default_params);
        const vars = {
          batch_name: batchName.trim(),
          page_no: String(item.displayIndex),
          section_title: section.section_title.trim() || "untitled",
        };
        const finalPrompt = batchPromptPreview(globalPrompt, section.section_prompt, vars, autoInjectPageNo);
        const params: DefaultParams = {
          aspect_ratio: section.section_aspect_ratio,
          image_size: modelMeta.supports_image_size ? section.section_image_size : "AUTO",
          thinking_level: modelMeta.supports_thinking_level ? fallbackParams.thinking_level : null,
          provider_id: isAdmin ? section.section_provider_id : null,
          temperature: section.section_temperature,
          timeout_sec: fallbackParams.timeout_sec,
          max_retries: fallbackParams.max_retries,
        };
        const sectionSessionIds = resolveSectionSessions(section, item.displayIndex);
        const refs = [...globalFiles, ...section.section_reference_images];

        for (let jobIndex = 0; jobIndex < section.section_job_count; jobIndex++) {
          plannedOrdinal += 1;
          let resp: any;
          try {
            if (refs.length) {
              const form = new FormData();
              form.append("prompt", finalPrompt);
              form.append("model", String(section.section_model));
              form.append("mode", "IMAGE_ONLY");
              form.append("params", JSON.stringify(params));
              refs.forEach((file) => form.append("reference_images", file));
              resp = await client.createJobMultipart(form, totalTargetCount, abort.signal);
            } else {
              resp = await client.createJobJSON(
                { prompt: finalPrompt, model: section.section_model, mode: "IMAGE_ONLY", params },
                totalTargetCount,
                abort.signal
              );
            }
          } catch (e: any) {
            const code = e?.error?.code;
            if (code === "TURNSTILE_REQUIRED" || code === "QUOTA_EXCEEDED" || code === "RATE_LIMITED") {
              throw e;
            }
            firstError = firstError || e?.error?.message || "创建失败";
            continue;
          }

          const job_id = resp?.job_id;
          const job_access_token = resp?.job_access_token;
          if (!job_id) {
            firstError = firstError || "后端未返回 job_id";
            continue;
          }

          createdCount += 1;
          if (!firstJobId) firstJobId = job_id;

          const rec: JobRecord = {
            job_id,
            job_access_token,
            model_cache: section.section_model,
            created_at: resp?.created_at || isoNow(),
            status_cache: (resp?.status as JobStatus) || "QUEUED",
            prompt_preview: toPreview(finalPrompt),
            prompt_text: finalPrompt,
            params_cache: {
              aspect_ratio: params.aspect_ratio,
              image_size: params.image_size,
              thinking_level: params.thinking_level,
              provider_id: params.provider_id,
              temperature: params.temperature,
              timeout_sec: params.timeout_sec,
              max_retries: params.max_retries,
            },
            last_seen_at: isoNow(),
            pinned: false,
            tags: [],
            batch_id: batchId,
            batch_name: batchName.trim(),
            batch_note: batchNote.trim() || undefined,
            batch_size: totalTargetCount > 1 ? totalTargetCount : undefined,
            batch_index: totalTargetCount > 1 ? plannedOrdinal : undefined,
            section_index: item.displayIndex,
            section_title: section.section_title.trim() || undefined,
            linked_session_ids: sectionSessionIds.length ? sectionSessionIds : undefined,
            auto_remove_failed_from_picker: removeFailedFromSession && sectionSessionIds.length ? true : undefined,
          };
          useJobsStore.getState().upsertJob(rec);
          attachJobToSessionIds(sectionSessionIds, {
            job_id,
            job_access_token,
            created_at: rec.created_at,
            status: rec.status_cache,
          });
        }

        if (submitMode === "STAGGERED" && sectionPos < plannedSections.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
      }

      if (!createdCount || !firstJobId) {
        throw { error: { code: "BAD_RESPONSE", message: firstError || "批量提交失败" } };
      }

      await clearBatchAutosave();
      push({
        kind: createdCount === totalTargetCount ? "success" : "info",
        title: `Batch queued ${createdCount}/${totalTargetCount}`,
        message:
          createdCount === totalTargetCount
            ? "所有计划任务都已写入队列"
            : `有 ${totalTargetCount - createdCount} 个任务没有成功提交（${firstError || "请检查后端日志"}）`,
      });
      navigate("/history");
    } catch (e: any) {
      if (allowTurnstileRecovery && e?.error?.code === "TURNSTILE_REQUIRED") {
        setPendingGenerationTargetCount(totalTargetCount);
        setGenerationTurnstileToken(null);
        setGenerationTurnstileKey((v) => v + 1);
        setGenerationModalOpen(true);
        return;
      }
      push({ kind: "error", title: "批量提交失败", message: e?.error?.message || "请检查后端/参数" });
    } finally {
      setLoading(false);
      abort.abort();
    }
  };

  const onSubmit = async () => {
    const err = validateBatch();
    if (err) {
      push({ kind: "error", title: "表单校验失败", message: err });
      return;
    }
    const targetCount = clamp(totalPlannedJobs, 1, 100);
    try {
      const nextSession = await refreshSession();
      if (needsGenerationTurnstile(nextSession, targetCount)) {
        setPendingGenerationTargetCount(targetCount);
        setGenerationTurnstileToken(null);
        setGenerationTurnstileKey((v) => v + 1);
        setGenerationModalOpen(true);
        return;
      }
    } catch (e: any) {
      push({ kind: "error", title: "状态同步失败", message: e?.error?.message || "无法确认当前账号状态" });
      return;
    }

    setPendingGenerationTargetCount(null);
    await executeBatchSubmit(targetCount);
  };

  const confirmGenerationTurnstile = async () => {
    if (!generationTurnstileToken) return;
    setVerifyingGenerationTurnstile(true);
    try {
      const targetCount = clamp(Math.round(pendingGenerationTargetCount ?? totalPlannedJobs), 1, 100);
      const nextSession = await client.verifyGenerationTurnstile(generationTurnstileToken, targetCount);
      setSession(nextSession);
      setGenerationModalOpen(false);
      setGenerationTurnstileToken(null);
      setPendingGenerationTargetCount(null);
      await executeBatchSubmit(targetCount, false);
    } catch (e: any) {
      setGenerationTurnstileKey((v) => v + 1);
      setGenerationTurnstileToken(null);
      push({ kind: "error", title: "Turnstile 校验失败", message: e?.error?.message || "请重试" });
    } finally {
      setVerifyingGenerationTurnstile(false);
    }
  };

  return (
    <>
      <TurnstilePromptModal
        open={generationModalOpen}
        title="需要二次验证"
        description="当前批量提交触发了普通用户的额外校验策略。完成 Cloudflare Turnstile 后，系统才会继续按计划提交全部任务。"
        token={generationTurnstileToken}
        tokenKey={generationTurnstileKey}
        setToken={setGenerationTurnstileToken}
        loading={verifyingGenerationTurnstile}
        confirmLabel="继续批量提交"
        onClose={() => {
          if (verifyingGenerationTurnstile) return;
          setGenerationModalOpen(false);
          setGenerationTurnstileToken(null);
          setPendingGenerationTargetCount(null);
        }}
        onConfirm={confirmGenerationTurnstile}
      />

      <PageContainer>
        <PageTitle
          title="Batch"
          subtitle="面向 PPT 配图、分镜和章节插图。固定区放公共条件，Section 区只填每页差异。"
          right={
            <div className="flex items-center gap-2">
              {user ? (
                <div className="rounded-full border border-zinc-200 bg-white/70 px-3 py-2 text-xs font-semibold text-zinc-600 dark:border-white/10 dark:bg-zinc-900/40 dark:text-zinc-300">
                  {user.role === "ADMIN" ? "Admin session" : "User session"}
                </div>
              ) : null}
              <Button
                variant="secondary"
                onClick={() => {
                  void clearBatchAutosave();
                  setBatchName("");
                  setBatchNote("");
                  setGlobalPrompt("");
                  setGlobalFiles([]);
                  setGlobalProviderId(initialParams.provider_id ?? null);
                  setSections([
                    makeDefaultSection(),
                  ]);
                  setSelectedSectionIds([]);
                  push({ kind: "info", title: "已重置批量草稿" });
                }}
              >
                Reset
              </Button>
            </div>
          }
        />

        <div className="space-y-3">
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">Batch Info</div>
                <div className="text-xs text-zinc-600 dark:text-zinc-300">批次名会进入本地历史，便于在 History 中识别同一组图片。</div>
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="rounded-full border border-sky-200 bg-sky-50 px-2 py-1 text-sky-700 dark:border-sky-800/60 dark:bg-sky-950/40 dark:text-sky-200">
                  Planned jobs {totalPlannedJobs}
                </span>
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-950/40 dark:text-emerald-200">
                  Est. {currency(estimatedCost)}
                </span>
              </div>
            </div>
            <div className="mt-3 grid gap-3 lg:grid-cols-2 xl:grid-cols-4">
              <Field label={<span className="inline-flex items-center gap-1.5">batch_name <HelpTip text="历史记录会用它来标记同一批次。建议用章节名、项目名或本次 PPT 的主题名。" /></span>}>
                <Input value={batchName} onChange={setBatchName} placeholder="Q2-Deck / Chapter-03 / Storyboard-A" />
              </Field>
              <Field label={<span className="inline-flex items-center gap-1.5">batch_note <HelpTip text="可选备注，用于记录本批次的用途、客户、版本或筛图说明。" /></span>}>
                <Input value={batchNote} onChange={setBatchNote} placeholder="可选备注" />
              </Field>
              <Field label={<span className="inline-flex items-center gap-1.5">default_collection_strategy <HelpTip text="新建 section 默认采用的图像集策略。推荐用批次命名自动建 session，后续在 Picker 中更容易区分。" /></span>}>
                <Select
                  value={defaultCollectionStrategy}
                  onChange={(v) => setDefaultCollectionStrategy(v as BatchCollectionMode)}
                  options={BATCH_COLLECTION_MODE_OPTIONS.map((item) => ({ value: item.value, label: item.label }))}
                />
              </Field>
              <Field label={<span className="inline-flex items-center gap-1.5">submit_mode <HelpTip text="Queue All Now 会连续提交所有任务；Queue Per Section 会在 section 之间短暂停顿，适合降低瞬时排队压力。" /></span>}>
                <Select
                  value={submitMode}
                  onChange={(v) => setSubmitMode(v as BatchSubmitMode)}
                  options={BATCH_SUBMIT_MODE_OPTIONS.map((item) => ({ value: item.value, label: item.label }))}
                />
              </Field>
            </div>
          </Card>

          <div className="grid gap-3 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">Global Block</div>
                  <div className="text-xs text-zinc-600 dark:text-zinc-300">全局 prompt 与全局参考图会自动追加到每个 section。</div>
                </div>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setSections((prev) =>
                      prev.map((section) => ({
                        ...section,
                      section_model: globalModel,
                      section_aspect_ratio: globalAspect,
                      section_image_size: globalSize,
                      section_provider_id: globalProviderId,
                      section_temperature: globalTemperature,
                      section_job_count: globalJobCount,
                      collection_mode: defaultCollectionStrategy,
                    }))
                    );
                    push({ kind: "success", title: "已把全局默认应用到全部 section" });
                  }}
                >
                  Apply Defaults To All
                </Button>
              </div>

              <div className="mt-3 space-y-3">
                <Field label={<span className="inline-flex items-center gap-1.5">global_prompt <HelpTip text="会追加到每个 section prompt 尾部。适合写通用画风、统一镜头语气、品牌元素等公共约束。" /></span>}>
                  <TextArea
                    value={globalPrompt}
                    onChange={setGlobalPrompt}
                    rows={5}
                    placeholder="例如：cinematic editorial lighting, crisp composition, premium presentation quality"
                  />
                </Field>

                <Field label={<span className="inline-flex items-center gap-1.5">global_reference_images <HelpTip text="最终送入模型的参考图顺序始终是：先全局参考图，再当前 section 的参考图。适合放品牌主视觉、角色设定或统一风格参考。" /></span>}>
                  <ImageDropzone files={globalFiles} setFiles={setGlobalFiles} maxFiles={MAX_REF_FILES} />
                </Field>

                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  <Field label={<span className="inline-flex items-center gap-1.5">default_model <HelpTip text="新 section 默认模型。已有 section 不会被自动覆盖，除非你点击 Apply Defaults To All。" /></span>}>
                    <Select
                      value={String(globalModel)}
                      onChange={(v) => setGlobalModel(v as ModelId)}
                      options={catalog.models.map((item) => ({ value: item.model_id, label: `${item.label} (${item.model_id})` }))}
                    />
                  </Field>
                  <Field label={<span className="inline-flex items-center gap-1.5">default_aspect_ratio <HelpTip text="新 section 的默认宽高比。PPT 页通常建议 16:9，竖版章节封面可以用 3:4 或 9:16。" /></span>}>
                    <Select
                      value={String(globalAspect)}
                      onChange={(v) => setGlobalAspect(v as AspectRatio)}
                      options={(globalModelMeta?.supported_aspect_ratios || ["1:1"]).map((item) => ({ value: item, label: item }))}
                    />
                  </Field>
                  <Field label={<span className="inline-flex items-center gap-1.5">default_image_size <HelpTip text="新 section 的默认尺寸。尺寸越大，成本和耗时通常越高。" /></span>}>
                    <Select
                      value={String(globalSize)}
                      onChange={(v) => setGlobalSize(v as ImageSize)}
                      options={
                        globalModelMeta?.supports_image_size
                          ? (globalModelMeta.supported_image_sizes || []).map((item) => ({ value: item, label: item }))
                          : [{ value: "AUTO", label: "AUTO" }]
                      }
                    />
                  </Field>
                  {isAdmin ? (
                    <Field label={<span className="inline-flex items-center gap-1.5">default_provider <HelpTip text="仅管理员可见。Auto Select 会走普通调度；手动指定时，新 section 会继承这个 provider 设置。" /></span>}>
                      <Select
                        testId="batch-global-provider-select"
                        value={globalProviderId || AUTO_PROVIDER_VALUE}
                        onChange={(v) => setGlobalProviderId(v === AUTO_PROVIDER_VALUE ? null : v)}
                        options={globalProviderOptions}
                      />
                    </Field>
                  ) : null}
                  <Field label={<span className="inline-flex items-center gap-1.5">default_temperature ({globalTemperature.toFixed(2)}) <HelpTip text="越低越稳定，越高越发散。做同一套 PPT 页面时，通常不建议拉得过高。" /></span>}>
                    <input
                      type="range"
                      min={0}
                      max={2}
                      step={0.05}
                      value={globalTemperature}
                      onChange={(e) => setGlobalTemperature(Number(e.target.value))}
                      className="w-full"
                    />
                  </Field>
                  <Field label={<span className="inline-flex items-center gap-1.5">default_job_count ({globalJobCount}) <HelpTip text="新 section 默认生成几张。提交前会汇总所有启用 section 的 job_count，作为总任务数预估。" /></span>}>
                    <input
                      type="range"
                      min={1}
                      max={12}
                      step={1}
                      value={globalJobCount}
                      onChange={(e) => setGlobalJobCount(Number(e.target.value))}
                      className="w-full"
                    />
                  </Field>
                  <Field label={<span className="inline-flex items-center gap-1.5">default_collection_strategy <HelpTip text="新 section 会默认采用这个图像集策略。对需要后续挑图的批次，推荐自动建 session。" /></span>}>
                    <Select
                      value={defaultCollectionStrategy}
                      onChange={(v) => setDefaultCollectionStrategy(v as BatchCollectionMode)}
                      options={BATCH_COLLECTION_MODE_OPTIONS.map((item) => ({ value: item.value, label: item.label }))}
                    />
                  </Field>
                </div>

                <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
                  <Field label={<span className="inline-flex items-center gap-1.5">naming_template <HelpTip text="用于自动建 session 时的命名模板。支持 {{batch_name}}、{{page_no}}、{{section_title}} 三个变量。" /></span>}>
                    <Input value={namingTemplate} onChange={setNamingTemplate} placeholder={BATCH_NAME_TEMPLATE_DEFAULT} />
                  </Field>
                  <Field label={<span className="inline-flex items-center gap-1.5">variables <HelpTip text="这些变量会在提交前被渲染进最终 prompt 和 session 名称里。未填写标题时，section_title 会自动回退成 untitled。" /></span>}>
                    <div className="flex h-full flex-wrap gap-2 rounded-2xl border border-zinc-200 bg-zinc-50/80 px-3 py-2 text-xs font-semibold text-zinc-700 dark:border-white/10 dark:bg-zinc-950/40 dark:text-zinc-200">
                      <span className="rounded-full bg-white px-2 py-1 dark:bg-zinc-900">{"{{page_no}}"}</span>
                      <span className="rounded-full bg-white px-2 py-1 dark:bg-zinc-900">{"{{section_title}}"}</span>
                      <span className="rounded-full bg-white px-2 py-1 dark:bg-zinc-900">{"{{batch_name}}"}</span>
                    </div>
                  </Field>
                </div>
              </div>
            </Card>

            <Card className="h-fit">
              <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">Advanced</div>
              <div className="mt-3 space-y-3">
                <div className="flex items-center justify-between gap-3 rounded-2xl border border-zinc-200 bg-zinc-50/80 px-3 py-3 dark:border-white/10 dark:bg-zinc-950/40">
                  <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                    只提交启用 section
                    <span className="ml-1 align-middle"><HelpTip text="关闭后，会忽略 section 的 enabled 开关，直接从第 N 个 section 开始全部提交。" /></span>
                  </div>
                  <Switch value={submitEnabledOnly} onChange={setSubmitEnabledOnly} />
                </div>
                <Field label={<span className="inline-flex items-center gap-1.5">start_from_section <HelpTip text="从第几个 section 开始提交。适合中途补跑后半段页面。" /></span>}>
                  <Input value={submitStartFrom} onChange={setSubmitStartFrom} type="number" />
                </Field>
                <div className="flex items-center justify-between gap-3 rounded-2xl border border-zinc-200 bg-zinc-50/80 px-3 py-3 dark:border-white/10 dark:bg-zinc-950/40">
                  <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                    自动附加页码变量
                    <span className="ml-1 align-middle"><HelpTip text="开启后，系统会在每个最终 prompt 尾部再补一行 Page number，方便在分镜或 PPT 多页批量生成时保持页序语义。" /></span>
                  </div>
                  <Switch value={autoInjectPageNo} onChange={setAutoInjectPageNo} />
                </div>
                <div className="flex items-center justify-between gap-3 rounded-2xl border border-zinc-200 bg-zinc-50/80 px-3 py-3 dark:border-white/10 dark:bg-zinc-950/40">
                  <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                    失败任务自动从 session 移除
                    <span className="ml-1 align-middle"><HelpTip text="若某任务最终失败，会把它在对应 session 里的 pending 占位条目自动清掉，避免 Picker 里留下失败占位。" /></span>
                  </div>
                  <Switch value={removeFailedFromSession} onChange={setRemoveFailedFromSession} />
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Button variant="secondary" onClick={duplicateSelectedSections} disabled={!selectedSectionIds.length}>
                    Duplicate Selected
                  </Button>
                  <Button variant="danger" onClick={deleteSelectedSections} disabled={!selectedSectionIds.length}>
                    Delete Selected
                  </Button>
                  <Button variant="ghost" onClick={() => addSection()}>
                    Add Section
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setGlobalFiles([]);
                      setSections((prev) => prev.map((section) => ({ ...section, section_reference_images: [] })));
                      push({ kind: "info", title: "已清空所有参考图" });
                    }}
                  >
                    Clear All Refs
                  </Button>
                </div>
                <div className="rounded-2xl border border-zinc-200 bg-white/70 p-3 text-xs text-zinc-600 dark:border-white/10 dark:bg-zinc-900/40 dark:text-zinc-300">
                  <div>启用 section：{sections.filter((section) => section.enabled).length} / {sections.length}</div>
                  <div className="mt-1">提交起点：Section {clamp(Number(submitStartFrom || "1") || 1, 1, Math.max(1, sections.length))}</div>
                  <div className="mt-1">提交模式：{submitMode === "IMMEDIATE" ? "Queue All Now" : "Queue Per Section"}</div>
                  <div className="mt-1">预估费用：{currency(estimatedCost)}（前端经验估算，仅供参考）</div>
                </div>
                <Button variant="primary" className="w-full" disabled={loading || !totalPlannedJobs} onClick={onSubmit}>
                  {loading ? "Submitting…" : `Submit Batch (${totalPlannedJobs})`}
                </Button>
              </div>
            </Card>
          </div>

          <div className="space-y-3">
            {sections.map((section, index) => {
              const displayIndex = index + 1;
              const cap = modelMap.get(section.section_model) || globalModelMeta;
              const previewText = batchPromptPreview(
                globalPrompt,
                section.section_prompt,
                {
                  batch_name: batchName.trim() || "batch",
                  page_no: String(displayIndex),
                  section_title: section.section_title.trim() || "untitled",
                },
                autoInjectPageNo
              );
              const autoSessionName = renderTemplate(namingTemplate, {
                batch_name: batchName.trim() || "batch",
                page_no: String(displayIndex),
                section_title: section.section_title.trim() || "untitled",
              });
              const isSelected = selectedSectionIds.includes(section.id);
              return (
                <Card key={section.id} className={cn(!section.enabled && "opacity-70")}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={(e) => toggleSelectedSection(section.id, e.target.checked)}
                        className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-400"
                      />
                      <div>
                        <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">Section {displayIndex}</div>
                        <div className="text-xs text-zinc-600 dark:text-zinc-300">
                          {section.section_title.trim() || "Untitled"} · {section.section_job_count} job(s)
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">Enabled</span>
                      <Switch
                        value={section.enabled}
                        onChange={(value) => updateSection(section.id, (current) => ({ ...current, enabled: value }))}
                      />
                      <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => copyPreviousSectionParams(section.id)} disabled={index === 0}>
                        Copy Prev Settings
                      </Button>
                      <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => duplicateSection(section.id)}>
                        Duplicate
                      </Button>
                      <Button
                        variant="danger"
                        className="!px-2 !py-1 text-xs"
                        onClick={() => {
                          setSections((prev) => {
                            const next = prev.filter((item) => item.id !== section.id);
                            return next.length
                              ? next
                              : [
                                  makeDefaultSection(),
                                ];
                          });
                          setSelectedSectionIds((prev) => prev.filter((id) => id !== section.id));
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>

                  <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,1.12fr)_minmax(320px,0.88fr)]">
                    <div className="space-y-3">
                      <div className="grid gap-3 md:grid-cols-2">
                        <Field label={<span className="inline-flex items-center gap-1.5">section_title <HelpTip text="可选标题。会参与 session 自动命名，也可用于 prompt 模板里的 {{section_title}}。" /></span>}>
                          <Input
                            value={section.section_title}
                            onChange={(v) => updateSection(section.id, (current) => ({ ...current, section_title: v }))}
                            placeholder="Slide title / Chapter title"
                          />
                        </Field>
                        <Field label={<span className="inline-flex items-center gap-1.5">inherit_previous_settings <HelpTip text="打开后会立即拷贝上一个 section 的模型、比例、尺寸、温度、数量和图像集策略；标题、prompt、参考图不会被覆盖。" /></span>}>
                          <div className="flex h-[42px] items-center justify-between rounded-2xl border border-zinc-200 bg-zinc-50/80 px-3 dark:border-white/10 dark:bg-zinc-950/40">
                            <span className="text-sm text-zinc-700 dark:text-zinc-200">Follow previous core settings</span>
                            <Switch
                              value={section.inherit_previous_settings}
                              onChange={(value) => {
                                updateSection(section.id, (current) => ({ ...current, inherit_previous_settings: value }));
                                if (value && index > 0) {
                                  copyPreviousSectionParams(section.id);
                                }
                              }}
                            />
                          </div>
                        </Field>
                      </div>

                      <Field label={<span className="inline-flex items-center gap-1.5">section_prompt <HelpTip text="当前页的独立描述。会排在全局 prompt 之前，再拼接全局 prompt 和可选页码信息。" /></span>}>
                        <TextArea
                          value={section.section_prompt}
                          onChange={(v) => updateSection(section.id, (current) => ({ ...current, section_prompt: v }))}
                          rows={5}
                          placeholder="描述这一页需要出现的主体、情绪、构图或画面动作"
                        />
                      </Field>

                      <Field label={<span className="inline-flex items-center gap-1.5">section_reference_images <HelpTip text="这一页的局部参考图。送入模型时会排在全局参考图之后。" /></span>}>
                        <ImageDropzone
                          files={section.section_reference_images}
                          setFiles={(next) =>
                            updateSection(section.id, (current) => ({
                              ...current,
                              section_reference_images:
                                typeof next === "function" ? next(current.section_reference_images) : next,
                            }))
                          }
                          maxFiles={MAX_REF_FILES}
                        />
                      </Field>
                    </div>

                    <div className="space-y-3">
                      <div className="grid gap-3 md:grid-cols-2">
                        <Field label={<span className="inline-flex items-center gap-1.5">section_model <HelpTip text="只影响当前 section。若这个 section 要求完全不同的风格或能力，可单独切模型。" /></span>}>
                          <Select
                            value={String(section.section_model)}
                            onChange={(v) => applySectionModel(section.id, v as ModelId)}
                            options={catalog.models.map((item) => ({ value: item.model_id, label: item.label }))}
                          />
                        </Field>
                        <Field label={<span className="inline-flex items-center gap-1.5">section_aspect_ratio <HelpTip text="当前 section 的独立宽高比。PPT 内容页常见 16:9，人物竖图常见 3:4 或 9:16。" /></span>}>
                          <Select
                            value={String(section.section_aspect_ratio)}
                            onChange={(v) => updateSection(section.id, (current) => ({ ...current, section_aspect_ratio: v as AspectRatio }))}
                            options={(cap?.supported_aspect_ratios || ["1:1"]).map((item) => ({ value: item, label: item }))}
                          />
                        </Field>
                        <Field label={<span className="inline-flex items-center gap-1.5">section_image_size <HelpTip text="当前 section 的独立尺寸。尺寸越大越适合留裁切空间，但成本和等待时间通常会上升。" /></span>}>
                          <Select
                            value={String(section.section_image_size)}
                            onChange={(v) => updateSection(section.id, (current) => ({ ...current, section_image_size: v as ImageSize }))}
                            options={
                              cap?.supports_image_size
                                ? (cap.supported_image_sizes || []).map((item) => ({ value: item, label: item }))
                              : [{ value: "AUTO", label: "AUTO" }]
                            }
                          />
                        </Field>
                        {isAdmin ? (
                          <Field label={<span className="inline-flex items-center gap-1.5">section_provider <HelpTip text="仅管理员可见。可直接点名当前 section 使用某个 provider，包含 disabled / cooldown provider。" /></span>}>
                            <Select
                              testId={`batch-section-provider-${displayIndex}`}
                              value={section.section_provider_id || AUTO_PROVIDER_VALUE}
                              onChange={(v) =>
                                updateSection(section.id, (current) => ({
                                  ...current,
                                  section_provider_id: v === AUTO_PROVIDER_VALUE ? null : v,
                                }))
                              }
                              options={providerSelectOptions(availableProviders, section.section_model)}
                            />
                          </Field>
                        ) : null}
                        <Field label={<span className="inline-flex items-center gap-1.5">section_job_count ({section.section_job_count}) <HelpTip text="当前 section 要生成几张。总任务数会按所有计划 section 的 job_count 求和。" /></span>}>
                          <input
                            type="range"
                            min={1}
                            max={12}
                            step={1}
                            value={section.section_job_count}
                            onChange={(e) =>
                              updateSection(section.id, (current) => ({
                                ...current,
                                section_job_count: Number(e.target.value),
                              }))
                            }
                            className="w-full"
                          />
                        </Field>
                      </div>

                      <Field label={<span className="inline-flex items-center gap-1.5">section_temperature ({section.section_temperature.toFixed(2)}) <HelpTip text="这个 section 的随机度。需要更稳定的品牌视觉时建议偏低；做概念探索时可以略高。" /></span>}>
                        <input
                          type="range"
                          min={0}
                          max={2}
                          step={0.05}
                          value={section.section_temperature}
                          onChange={(e) =>
                            updateSection(section.id, (current) => ({
                              ...current,
                              section_temperature: Number(e.target.value),
                            }))
                          }
                          className="w-full"
                        />
                      </Field>

                      <Field label={<span className="inline-flex items-center gap-1.5">collection_mode <HelpTip text="决定当前 section 生成出来的图是否要写入本地 session。推荐默认自动建 session，后续筛图更顺手。" /></span>}>
                        <Select
                          value={section.collection_mode}
                          onChange={(v) =>
                            updateSection(section.id, (current) => ({
                              ...current,
                              collection_mode: v as BatchCollectionMode,
                            }))
                          }
                          options={BATCH_COLLECTION_MODE_OPTIONS.map((item) => ({ value: item.value, label: item.label }))}
                        />
                      </Field>

                      {section.collection_mode === "AUTO_NEW" ? (
                        <Field label={<span className="inline-flex items-center gap-1.5">collection_name <HelpTip text="AUTO_NEW 时可手动指定 session 名称；留空则回退到命名模板。" /></span>}>
                          <Input
                            value={section.collection_name}
                            onChange={(v) => updateSection(section.id, (current) => ({ ...current, collection_name: v }))}
                            placeholder="可选，自定义 session 名称"
                          />
                        </Field>
                      ) : null}

                      {section.collection_mode === "AUTO_BATCH" ? (
                        <div className="rounded-2xl border border-zinc-200 bg-zinc-50/80 px-3 py-3 text-sm text-zinc-700 dark:border-white/10 dark:bg-zinc-950/40 dark:text-zinc-200">
                          <div className="font-semibold">Auto session name</div>
                          <div className="mt-1 break-all text-xs text-zinc-500 dark:text-zinc-400">{autoSessionName}</div>
                        </div>
                      ) : null}

                      {section.collection_mode === "EXISTING" ? (
                        <BatchSessionSelector
                          pickerSessions={sortedPickerSessions}
                          selectedIds={section.existing_session_ids}
                          onToggle={(sessionId, checked) =>
                            updateSection(section.id, (current) => ({
                              ...current,
                              existing_session_ids: checked
                                ? Array.from(new Set([sessionId, ...current.existing_session_ids]))
                                : current.existing_session_ids.filter((id) => id !== sessionId),
                            }))
                          }
                          onCreateAndSelect={(name) => createAndAttachExistingSession(section.id, name)}
                        />
                      ) : null}

                      <div className="rounded-2xl border border-zinc-200 bg-zinc-50/80 p-3 dark:border-white/10 dark:bg-zinc-950/40">
                        <div className="flex items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                          Prompt Preview
                          <HelpTip text="这是提交给后端的最终 prompt 预览，已经把变量、全局 prompt 和页码注入逻辑都合成好了。" />
                        </div>
                        <pre className="mt-2 whitespace-pre-wrap break-words text-xs leading-6 text-zinc-600 dark:text-zinc-300">
                          {previewText || "当前 section 还没有内容"}
                        </pre>
                      </div>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      </PageContainer>
    </>
  );
}

function CreateJobPage() {
  const client = useApiClient();
  const catalog = useModelCatalog();
  const { push } = useToast();
  const navigate = useNavigate();
  const { session, user, isAdmin } = useAuthSession();
  const providerSummary = useAdminProviderSummary(isAdmin);
  const setSession = useAuthStore((s) => s.setSession);
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const updateDefaultParams = useSettingsStore((s) => s.updateDefaultParams);
  const pickerSessions = usePickerStore((s) => s.sessions);
  const createPickerSession = usePickerStore((s) => s.createSession);
  const addPickerItems = usePickerStore((s) => s.addItems);

  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [model, setModel] = useState<ModelId>(settings.defaultModel || catalog.default_model);
  const [mode, setMode] = useState<CreateMode>("IMAGE_ONLY");
  const [sessionSearch, setSessionSearch] = useState("");
  const [newSessionName, setNewSessionName] = useState("");
  const [boundSessionIds, setBoundSessionIds] = useState<string[]>([]);

  const initParams = useMemo(
    () => getParamsForModel(settings, settings.defaultModel || catalog.default_model),
    [catalog.default_model, settings.defaultModel, settings.defaultParams, settings.defaultParamsByModel]
  );
  const [aspect, setAspect] = useState<AspectRatio>(initParams.aspect_ratio);
  const [size, setSize] = useState<ImageSize>(initParams.image_size);
  const [thinkingLevel, setThinkingLevel] = useState<string | null>(initParams.thinking_level ?? null);
  const [providerId, setProviderId] = useState<string | null>(initParams.provider_id ?? null);
  const [temperature, setTemperature] = useState<number>(initParams.temperature);
  const [timeoutSec, setTimeoutSec] = useState<number>(initParams.timeout_sec);
  const [maxRetries, setMaxRetries] = useState<number>(initParams.max_retries);
  const [jobCount, setJobCount] = useState<number>(1);

  const [loading, setLoading] = useState(false);
  const [generationModalOpen, setGenerationModalOpen] = useState(false);
  const [generationTurnstileToken, setGenerationTurnstileToken] = useState<string | null>(null);
  const [generationTurnstileKey, setGenerationTurnstileKey] = useState(0);
  const [verifyingGenerationTurnstile, setVerifyingGenerationTurnstile] = useState(false);
  const [pendingGenerationTargetCount, setPendingGenerationTargetCount] = useState<number | null>(null);
  const [modelRecommendationOpen, setModelRecommendationOpen] = useState(false);
  const [pendingModelChoice, setPendingModelChoice] = useState<ModelId | null>(null);
  const hydratedModelRef = useRef<ModelId | null>(null);
  const createDraftHydratedRef = useRef(false);
  const createDraftFileEntriesRef = useRef<DraftFileEntry[]>([]);
  const lastPasteAtRef = useRef<number>(0);
  const MAX_REF_FILES = 14;
  const recommendedModelId: ModelId = "gemini-3.1-flash-image-preview";
  const discouragedModels = useMemo<ModelId[]>(
    () => ["gemini-3-pro-image-preview", "gemini-2.5-flash-image"],
    []
  );
  const createDraftScope = user?.user_id || "__guest__";

  const currentModel = useMemo(() => {
    return (
      catalog.models.find((m) => m.model_id === model) ||
      catalog.models.find((m) => m.model_id === catalog.default_model) ||
      catalog.models[0]
    );
  }, [catalog, model]);
  const availableProviders = providerSummary?.providers ?? EMPTY_PROVIDER_LIST;
  const createProviderOptions = useMemo(
    () => providerSelectOptions(availableProviders, model),
    [availableProviders, model]
  );
  const pendingModelMeta = useMemo(
    () => catalog.models.find((m) => m.model_id === pendingModelChoice) || null,
    [catalog.models, pendingModelChoice]
  );
  const filteredPickerSessions = useMemo(() => {
    const query = sessionSearch.trim().toLowerCase();
    if (!query) return pickerSessions;
    return pickerSessions.filter((session) => session.name.toLowerCase().includes(query));
  }, [pickerSessions, sessionSearch]);
  const boundSessionIdSet = useMemo(() => new Set(boundSessionIds), [boundSessionIds]);
  const createDraftFileMetas = useMemo(() => files.map((file) => toPersistedDraftFileMeta(file)), [files]);
  const createDraftFileEntries = useMemo(
    () => createDraftFileMetas.map((meta) => ({ namespace: "create", meta })),
    [createDraftFileMetas]
  );
  const createDraftSnapshot = useDebounced(
    {
      scope: createDraftScope,
      prompt,
      model,
      mode,
      sessionSearch,
      newSessionName,
      boundSessionIds,
      aspect,
      size,
      thinkingLevel,
      providerId,
      temperature,
      timeoutSec,
      maxRetries,
      jobCount,
      files: createDraftFileMetas,
    },
    250
  );

  const applyModelChoice = (nextModel: ModelId) => {
    setModel(nextModel);
    hydratedModelRef.current = null;
  };

  const handleModelChange = (nextModel: ModelId) => {
    if (!nextModel || nextModel === model) return;
    if (!isAdmin && discouragedModels.includes(nextModel) && nextModel !== recommendedModelId) {
      setPendingModelChoice(nextModel);
      setModelRecommendationOpen(true);
      return;
    }
    applyModelChoice(nextModel);
  };

  useEffect(() => {
    if (!currentModel) return;
    if (!catalog.models.some((m) => m.model_id === model)) {
      setModel(currentModel.model_id);
    }
  }, [catalog.models, currentModel, model]);

  useEffect(() => {
    let cancelled = false;
    createDraftHydratedRef.current = false;
    createDraftFileEntriesRef.current = [];

    const hydrate = async () => {
      const cloneDraft = loadCreateCloneDraft();
      if (cloneDraft) {
        if (cancelled) return;
        setPrompt(cloneDraft.prompt || "");
        setFiles([]);
        setMode(cloneDraft.mode || "IMAGE_ONLY");
        setSessionSearch("");
        setNewSessionName("");
        setBoundSessionIds([]);
        if (cloneDraft.model) {
          setModel(cloneDraft.model);
        }
        if (cloneDraft.params?.aspect_ratio) setAspect(cloneDraft.params.aspect_ratio as AspectRatio);
        if (cloneDraft.params?.image_size) setSize(cloneDraft.params.image_size as ImageSize);
        if (cloneDraft.params?.thinking_level !== undefined) setThinkingLevel(cloneDraft.params.thinking_level ?? null);
        setProviderId(cloneDraft.params?.provider_id ?? null);
        if (typeof cloneDraft.params?.temperature === "number") setTemperature(cloneDraft.params.temperature);
        if (typeof cloneDraft.params?.timeout_sec === "number") setTimeoutSec(cloneDraft.params.timeout_sec);
        if (typeof cloneDraft.params?.max_retries === "number") setMaxRetries(cloneDraft.params.max_retries);
        hydratedModelRef.current = cloneDraft.model || settings.defaultModel || catalog.default_model;
        createDraftHydratedRef.current = true;
        clearCreateCloneDraft();
        push({ kind: "info", title: "已导入历史任务参数", message: "参考图不会自动回填，请按需重新上传" });
        return;
      }

      const draft = loadCreatePageDraft();
      if (!draft || draft.scope !== createDraftScope) {
        createDraftHydratedRef.current = true;
        return;
      }

      const restoredFiles = await restoreDraftFiles(createDraftScope, KEY_CREATE_PAGE_DRAFT, "create", draft.files || []);
      if (cancelled) return;

      setPrompt(draft.prompt || "");
      setFiles(restoredFiles);
      setModel(draft.model || settings.defaultModel || catalog.default_model);
      setMode(draft.mode || "IMAGE_ONLY");
      setSessionSearch(draft.sessionSearch || "");
      setNewSessionName(draft.newSessionName || "");
      setBoundSessionIds(Array.isArray(draft.boundSessionIds) ? draft.boundSessionIds : []);
      setAspect(draft.aspect || initParams.aspect_ratio);
      setSize(draft.size || initParams.image_size);
      setThinkingLevel(draft.thinkingLevel ?? initParams.thinking_level ?? null);
      setProviderId(draft.providerId ?? initParams.provider_id ?? null);
      setTemperature(typeof draft.temperature === "number" ? draft.temperature : initParams.temperature);
      setTimeoutSec(typeof draft.timeoutSec === "number" ? draft.timeoutSec : initParams.timeout_sec);
      setMaxRetries(typeof draft.maxRetries === "number" ? draft.maxRetries : initParams.max_retries);
      setJobCount(typeof draft.jobCount === "number" ? draft.jobCount : 1);
      hydratedModelRef.current = draft.model || settings.defaultModel || catalog.default_model;
      createDraftFileEntriesRef.current = (draft.files || []).map((meta) => ({ namespace: "create", meta }));
      createDraftHydratedRef.current = true;
    };

    void hydrate();
    return () => {
      cancelled = true;
    };
  }, [createDraftScope]);

  useEffect(() => {
    if (!currentModel) return;
    if (hydratedModelRef.current === model) return;
    const saved = getParamsForModel(settings, model, currentModel.default_params);
    setAspect(saved.aspect_ratio as AspectRatio);
    setSize(saved.image_size as ImageSize);
    setThinkingLevel(saved.thinking_level ?? null);
    setProviderId(saved.provider_id ?? null);
    setTemperature(saved.temperature);
    setTimeoutSec(saved.timeout_sec);
    setMaxRetries(saved.max_retries);
    hydratedModelRef.current = model;
  }, [currentModel, model, settings.defaultModel, settings.defaultParams, settings.defaultParamsByModel]);

  useEffect(() => {
    setBoundSessionIds((prev) => prev.filter((sessionId) => pickerSessions.some((session) => session.session_id === sessionId)));
  }, [pickerSessions]);

  useEffect(() => {
    if (!isAdmin) {
      if (providerId !== null) setProviderId(null);
      return;
    }
    if (!providerId) return;
    if (!availableProviders.some((provider) => provider.provider_id === providerId && providerSupportsModel(provider, model))) {
      setProviderId(null);
    }
  }, [availableProviders, isAdmin, model, providerId]);

  useEffect(() => {
    if (!createDraftHydratedRef.current) return;
    let cancelled = false;

    const syncCreateDraftFiles = async () => {
      const prevEntries = createDraftFileEntriesRef.current;
      const prevMap = new Map(prevEntries.map((entry) => [`${entry.namespace}::${entry.meta.id}`, entry]));
      const nextMap = new Map(createDraftFileEntries.map((entry) => [`${entry.namespace}::${entry.meta.id}`, entry]));

      for (const [key, entry] of prevMap.entries()) {
        if (nextMap.has(key)) continue;
        await deleteDraftFileBlob(createDraftScope, KEY_CREATE_PAGE_DRAFT, entry.namespace, entry.meta);
      }

      for (const [key, entry] of nextMap.entries()) {
        if (prevMap.has(key)) continue;
        const file = files.find((candidate) => persistedDraftFileId(candidate) === entry.meta.id);
        if (!file) continue;
        await putDraftFileBlob(createDraftScope, KEY_CREATE_PAGE_DRAFT, entry.namespace, file, entry.meta);
      }

      if (cancelled) return;
      createDraftFileEntriesRef.current = createDraftFileEntries;
    };

    void syncCreateDraftFiles();
    return () => {
      cancelled = true;
    };
  }, [createDraftFileEntries, createDraftScope, files]);

  useEffect(() => {
    if (!createDraftHydratedRef.current) return;
    saveCreatePageDraft({
      ...createDraftSnapshot,
      updated_at: isoNow(),
    });
  }, [createDraftSnapshot]);

  useEffect(() => {
    const onPaste = (evt: ClipboardEvent) => {
      const clipboard = evt.clipboardData;
      if (!clipboard) return;

      const fromFiles = Array.from(clipboard.files || []).filter((f) => f.type.startsWith("image/"));
      const fromItems = Array.from(clipboard.items || [])
        .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
        .map((it) => it.getAsFile())
        .filter((f): f is File => Boolean(f));
      const merged = [...fromFiles, ...fromItems];
      if (!merged.length) return;

      evt.preventDefault();
      const now = Date.now();
      if (now - lastPasteAtRef.current < 300) {
        return;
      }
      lastPasteAtRef.current = now;

      const seen = new Set<string>();
      const deduped = merged.filter((file) => {
        const key = `${file.name}:${file.size}:${file.type}:${file.lastModified}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const picked = deduped.slice(0, 1);
      if (!picked.length) return;

      const normalized = picked.map((file, idx) => {
        if (file.name) return file;
        const ext = file.type.includes("jpeg") ? "jpg" : file.type.includes("webp") ? "webp" : "png";
        return new File([file], `clipboard_${now}_${idx}.${ext}`, {
          type: file.type || "image/png",
          lastModified: now,
        });
      });

      setFiles((prev) => mergeReferenceFiles(prev, normalized, MAX_REF_FILES));
      push({ kind: "success", title: "已从剪贴板加入参考图", message: `${normalized.length} 张` });
    };

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [push]);

  useEffect(() => {
    if (!currentModel) return;
    if (!currentModel.supported_aspect_ratios.includes(aspect)) {
      setAspect((currentModel.default_params.aspect_ratio || currentModel.supported_aspect_ratios[0]) as AspectRatio);
    }
    if (currentModel.supports_image_size) {
      if (!currentModel.supported_image_sizes.includes(size)) {
        setSize((currentModel.default_params.image_size || currentModel.supported_image_sizes[0]) as ImageSize);
      }
    } else if (size !== "AUTO") {
      setSize("AUTO");
    }
    if (currentModel.supports_thinking_level) {
      const nextThinking = thinkingLevel || currentModel.default_params.thinking_level || currentModel.supported_thinking_levels[0] || null;
      if (!nextThinking || !currentModel.supported_thinking_levels.includes(nextThinking)) {
        setThinkingLevel(nextThinking);
      }
    } else if (thinkingLevel !== null) {
      setThinkingLevel(null);
    }
    if (!currentModel.supports_text_output && mode === "TEXT_AND_IMAGE") {
      setMode("IMAGE_ONLY");
    }
  }, [aspect, currentModel, mode, size, thinkingLevel]);

  // 在 Create 页面每次调整参数后，自动写回 settings.defaultParamsByModel（持久化到 localStorage）
  useEffect(() => {
    if (!currentModel) return;
    const t = setTimeout(() => {
      const cur = getParamsForModel(settings, model, currentModel.default_params);
      const nextImageSize = currentModel.supports_image_size ? size : "AUTO";
      const nextThinkingLevel = currentModel.supports_thinking_level
        ? (thinkingLevel || currentModel.default_params.thinking_level || currentModel.supported_thinking_levels[0] || null)
        : null;
      const nextProviderId = isAdmin ? providerId : null;
      const changed =
        cur.aspect_ratio !== aspect ||
        cur.image_size !== nextImageSize ||
        (cur.thinking_level || null) !== nextThinkingLevel ||
        (cur.provider_id || null) !== nextProviderId ||
        cur.temperature !== temperature ||
        cur.timeout_sec !== timeoutSec ||
        cur.max_retries !== maxRetries;
      if (changed) {
        updateDefaultParams(model, {
          aspect_ratio: aspect,
          image_size: nextImageSize,
          thinking_level: nextThinkingLevel,
          provider_id: nextProviderId,
          temperature,
          timeout_sec: timeoutSec,
          max_retries: maxRetries,
        });
      }
      if (settings.defaultModel !== model) {
        setSettings({ defaultModel: model });
      }
    }, 200);
    return () => clearTimeout(t);
  }, [
    currentModel,
    model,
    aspect,
    size,
    thinkingLevel,
    providerId,
    temperature,
    timeoutSec,
    maxRetries,
    isAdmin,
    settings.defaultModel,
    settings.defaultParamsByModel,
    setSettings,
    updateDefaultParams,
  ]);

  const validate = () => {
    if (!prompt.trim()) return "Prompt 不能为空";
    if (files.length > MAX_REF_FILES) return `参考图最多 ${MAX_REF_FILES} 张`;
    if (files.some((f) => !f.type.startsWith("image/"))) return "参考图必须是 image/*";
    if (!Number.isFinite(jobCount) || jobCount < 1 || jobCount > 12) return "同一 prompt 的任务数需在 1~12 之间";
    return null;
  };

  const hasFreshGenerationVerification = (candidate: AuthSession | null) => {
    const ts = candidate?.generation_turnstile_verified_until;
    if (!ts) return false;
    const dt = new Date(ts);
    return Number.isFinite(dt.getTime()) && dt.getTime() > Date.now();
  };

  const needsGenerationTurnstile = (candidate: AuthSession | null, targetCount: number) => {
    const currentUser = candidate?.user;
    const currentUsage = candidate?.usage;
    if (!currentUser || currentUser.role === "ADMIN") return false;
    const countThreshold = currentUser.policy.turnstile_job_count_threshold;
    const dailyThreshold = currentUser.policy.turnstile_daily_usage_threshold;
    if (typeof countThreshold === "number" && targetCount > countThreshold) {
      // High job_count always requires a fresh Turnstile challenge.
      return true;
    }
    if (typeof dailyThreshold === "number" && (currentUsage?.quota_consumed_today ?? 0) >= dailyThreshold) {
      return !hasFreshGenerationVerification(candidate);
    }
    return false;
  };

  const refreshSession = async () => {
    const nextSession = await client.me();
    setSession(nextSession);
    return nextSession;
  };

  const toggleBoundSession = (sessionId: string, checked: boolean) => {
    setBoundSessionIds((prev) => {
      if (checked) return Array.from(new Set([sessionId, ...prev]));
      return prev.filter((id) => id !== sessionId);
    });
  };

  const handleCreateAndBindSession = () => {
    const sessionId = createPickerSession(newSessionName.trim() || undefined);
    setBoundSessionIds((prev) => Array.from(new Set([sessionId, ...prev])));
    setNewSessionName("");
    push({ kind: "success", title: "已创建并绑定 session" });
  };

  const clearCreateAutosave = async () => {
    const entries = createDraftFileEntriesRef.current;
    await Promise.all(
      entries.map((entry) => deleteDraftFileBlob(createDraftScope, KEY_CREATE_PAGE_DRAFT, entry.namespace, entry.meta))
    );
    createDraftFileEntriesRef.current = [];
    clearCreatePageDraft();
  };

  const attachJobToBoundSessions = (job: {
    job_id: string;
    job_access_token?: string;
    created_at?: string;
    status?: JobStatus;
  }) => {
    if (!boundSessionIds.length) return;
    boundSessionIds.forEach((sessionId) => {
      addPickerItems(sessionId, [
        {
          item_key: pickerPendingItemKey(job.job_id),
          job_id: job.job_id,
          job_access_token: job.job_access_token,
          picked: true,
          status: job.status || "QUEUED",
          added_at: job.created_at || isoNow(),
        },
      ]);
    });
  };

  const executeCreate = async (targetCountOverride?: number, allowTurnstileRecovery = true) => {
    const err = validate();
    if (err) {
      push({ kind: "error", title: "表单校验失败", message: err });
      return;
    }

    setLoading(true);
    const abort = new AbortController();

    try {
      if (!currentModel) {
        throw { error: { code: "MODEL_NOT_READY", message: "模型目录加载失败，请稍后重试" } };
      }
      const effectiveMode = currentModel.supports_text_output ? mode : "IMAGE_ONLY";
      const effectiveThinkingLevel = currentModel.supports_thinking_level
        ? (thinkingLevel || currentModel.default_params.thinking_level || currentModel.supported_thinking_levels[0] || null)
        : null;
      const params: DefaultParams = {
        aspect_ratio: aspect,
        image_size: currentModel.supports_image_size ? size : "AUTO",
        thinking_level: effectiveThinkingLevel,
        provider_id: isAdmin ? providerId : null,
        temperature,
        timeout_sec: timeoutSec,
        max_retries: maxRetries,
      };

      const targetCount = clamp(Math.round(targetCountOverride ?? jobCount), 1, 12);
      const batchId = targetCount > 1 ? createBatchId() : undefined;
      const created: Array<{ job_id: string; job_access_token?: string }> = [];
      let firstErr: string | null = null;

      for (let i = 0; i < targetCount; i++) {
        let resp: any;
        try {
          if (files.length) {
            const form = new FormData();
            form.append("prompt", prompt);
            form.append("model", String(model));
            form.append("mode", effectiveMode);
            form.append("params", JSON.stringify(params));
            files.forEach((f) => form.append("reference_images", f));
            resp = await client.createJobMultipart(form, targetCount, abort.signal);
          } else {
            resp = await client.createJobJSON({ prompt, model, mode: effectiveMode, params }, targetCount, abort.signal);
          }
        } catch (err: any) {
          const code = err?.error?.code;
          if (code === "TURNSTILE_REQUIRED" || code === "QUOTA_EXCEEDED" || code === "RATE_LIMITED") {
            throw err;
          }
          firstErr = firstErr || err?.error?.message || "创建失败";
          continue;
        }

        const job_id = resp?.job_id;
        const job_access_token = resp?.job_access_token;
        if (!job_id) {
          firstErr = firstErr || "后端未返回 job_id";
          continue;
        }

        created.push({ job_id, job_access_token });
        const rec: JobRecord = {
          job_id,
          job_access_token,
          model_cache: model,
          created_at: resp?.created_at || isoNow(),
          status_cache: (resp?.status as JobStatus) || "QUEUED",
          prompt_preview: toPreview(prompt),
          prompt_text: prompt,
            params_cache: {
              aspect_ratio: params.aspect_ratio,
              image_size: params.image_size,
              thinking_level: params.thinking_level,
              provider_id: params.provider_id,
              temperature,
              timeout_sec: timeoutSec,
              max_retries: maxRetries,
            },
          last_seen_at: isoNow(),
          pinned: false,
          tags: [],
          batch_id: batchId,
          batch_size: targetCount > 1 ? targetCount : undefined,
          batch_index: batchId ? i + 1 : undefined,
        };
        useJobsStore.getState().upsertJob(rec);
        attachJobToBoundSessions({
          job_id,
          job_access_token,
          created_at: rec.created_at,
          status: rec.status_cache,
        });
      }

      if (!created.length) {
        throw { error: { code: "BAD_RESPONSE", message: firstErr || "创建失败" } };
      }

      // remember last used as defaults for this model
      updateDefaultParams(model, params);
      await clearCreateAutosave();

      if (created.length === 1) {
        push({ kind: "success", title: "创建成功", message: `job_id: ${shortId(created[0].job_id)}` });
        navigate("/history");
      } else {
        const failed = targetCount - created.length;
        push({
          kind: failed > 0 ? "info" : "success",
          title: `批量创建完成：${created.length}/${targetCount}`,
          message: failed > 0 ? `有 ${failed} 个请求失败（${firstErr || "请检查后端日志"}）` : `已创建 ${created.length} 个任务`,
        });
        navigate("/history");
      }
    } catch (e: any) {
      if (allowTurnstileRecovery && e?.error?.code === "TURNSTILE_REQUIRED") {
        const targetCount = clamp(Math.round(targetCountOverride ?? jobCount), 1, 12);
        setPendingGenerationTargetCount(targetCount);
        setGenerationTurnstileToken(null);
        setGenerationTurnstileKey((v) => v + 1);
        setGenerationModalOpen(true);
        return;
      }
      push({ kind: "error", title: "创建失败", message: e?.error?.message || "请检查后端/参数" });
    } finally {
      setLoading(false);
      abort.abort();
    }
  };

  const onSubmit = async () => {
    const targetCount = clamp(Math.round(jobCount), 1, 12);
    try {
      const nextSession = await refreshSession();
      if (needsGenerationTurnstile(nextSession, targetCount)) {
        setPendingGenerationTargetCount(targetCount);
        setGenerationTurnstileToken(null);
        setGenerationTurnstileKey((v) => v + 1);
        setGenerationModalOpen(true);
        return;
      }
    } catch (e: any) {
      push({ kind: "error", title: "状态同步失败", message: e?.error?.message || "无法确认当前账号状态" });
      return;
    }

    setPendingGenerationTargetCount(null);
    await executeCreate(targetCount);
  };

  const confirmGenerationTurnstile = async () => {
    if (!generationTurnstileToken) return;
    setVerifyingGenerationTurnstile(true);
    try {
      const targetCount = clamp(Math.round(pendingGenerationTargetCount ?? jobCount), 1, 12);
      const nextSession = await client.verifyGenerationTurnstile(generationTurnstileToken, targetCount);
      setSession(nextSession);
      setGenerationModalOpen(false);
      setGenerationTurnstileToken(null);
      setPendingGenerationTargetCount(null);
      await executeCreate(targetCount, false);
    } catch (e: any) {
      setGenerationTurnstileKey((v) => v + 1);
      setGenerationTurnstileToken(null);
      push({ kind: "error", title: "Turnstile 校验失败", message: e?.error?.message || "请重试" });
    } finally {
      setVerifyingGenerationTurnstile(false);
    }
  };

  return (
    <>
      <ModelRecommendationModal
        open={modelRecommendationOpen}
        targetLabel={pendingModelMeta?.label || pendingModelChoice || "该模型"}
        onPreferBest={() => {
          setModelRecommendationOpen(false);
          setPendingModelChoice(null);
          applyModelChoice(recommendedModelId);
        }}
        onKeepCurrent={() => {
          if (pendingModelChoice) {
            applyModelChoice(pendingModelChoice);
          }
          setModelRecommendationOpen(false);
          setPendingModelChoice(null);
        }}
        onClose={() => {
          setModelRecommendationOpen(false);
          setPendingModelChoice(null);
        }}
      />

      <TurnstilePromptModal
        open={generationModalOpen}
        title="需要二次验证"
        description="当前账号的本次生成触发了额外校验策略。完成 Cloudflare Turnstile 后，后端才会放行本次生图请求。"
        token={generationTurnstileToken}
        tokenKey={generationTurnstileKey}
        setToken={setGenerationTurnstileToken}
        loading={verifyingGenerationTurnstile}
        confirmLabel="继续生成"
        onClose={() => {
          if (verifyingGenerationTurnstile) return;
          setGenerationModalOpen(false);
          setGenerationTurnstileToken(null);
          setPendingGenerationTargetCount(null);
        }}
        onConfirm={confirmGenerationTurnstile}
      />

      <PageContainer>
        <PageTitle
          title="Create Job"
          subtitle="支持纯文本 prompt 或 文本 + 多参考图（最多 14 张）。"
          right={
            <div className="flex items-center gap-2">
              {user ? (
                <div className="rounded-full border border-zinc-200 bg-white/70 px-3 py-2 text-xs font-semibold text-zinc-600 dark:border-white/10 dark:bg-zinc-900/40 dark:text-zinc-300">
                  工作区已连接
                </div>
              ) : null}
              <Button variant="secondary" onClick={() => {
                void clearCreateAutosave();
                setPrompt("");
                setFiles([]);
                setSessionSearch("");
                setNewSessionName("");
                setBoundSessionIds([]);
                setJobCount(1);
                push({ kind: "info", title: "已清空" });
              }}>
                清空
              </Button>
            </div>
          }
        />

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">Prompt</div>
            <div className="mt-2">
              <TextArea
                testId="create-prompt"
                value={prompt}
                onChange={setPrompt}
                rows={5}
                placeholder="描述你想生成的图像（建议包含主体、风格、光照、构图、镜头等）"
              />
            </div>

            <Divider />

            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">参考图</div>
                <div className="text-xs text-zinc-600 dark:text-zinc-300">拖拽/选择上传或直接 Ctrl/Cmd+V 粘贴，支持预览与删除</div>
              </div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">{files.length}/{MAX_REF_FILES}</div>
            </div>

            <div className="mt-3">
              <ImageDropzone files={files} setFiles={setFiles} maxFiles={MAX_REF_FILES} />
            </div>
            <Divider />

            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">绑定 Session</div>
                <div className="text-xs text-zinc-600 dark:text-zinc-300">放在当前页内快速绑定。支持多选、搜索、即时新建，也可以完全不选。</div>
              </div>
              <div className="rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-[10px] font-bold text-zinc-600 dark:border-white/10 dark:bg-zinc-950/40 dark:text-zinc-300">
                已选 {boundSessionIds.length}
              </div>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
              <Input
                value={sessionSearch}
                onChange={setSessionSearch}
                placeholder="搜索 session 名称"
              />
              <Input
                value={newSessionName}
                onChange={setNewSessionName}
                placeholder="新建 session 名称（可留空）"
              />
              <Button variant="secondary" className="xl:min-w-[88px]" onClick={handleCreateAndBindSession}>
                新建
              </Button>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
              <span>本地已有 {pickerSessions.length} 个 session</span>
              {boundSessionIds.length ? (
                <button
                  type="button"
                  className="font-semibold text-zinc-700 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white"
                  onClick={() => setBoundSessionIds([])}
                >
                  清空选择
                </button>
              ) : null}
            </div>

            <div className="mt-3">
              {filteredPickerSessions.length ? (
                <div
                  className="flex gap-2 overflow-x-auto pb-1"
                  onWheel={(e) => {
                    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                      (e.currentTarget as HTMLDivElement).scrollLeft += e.deltaY;
                    }
                  }}
                >
                  {filteredPickerSessions.map((session) => {
                    const checked = boundSessionIdSet.has(session.session_id);
                    const counts = getPickerSessionCounts(session);
                    return (
                      <label
                        key={session.session_id}
                        className={cn(
                          "min-w-[250px] flex-none cursor-pointer rounded-2xl border px-3 py-3 transition",
                          checked
                            ? "border-zinc-900 bg-zinc-50 shadow-sm dark:border-white dark:bg-zinc-950/70"
                            : "border-zinc-200 bg-white/60 hover:border-zinc-300 dark:border-white/10 dark:bg-zinc-950/30 dark:hover:border-white/20"
                        )}
                      >
                        <div className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            className="mt-1 h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-400"
                            checked={checked}
                            onChange={(e) => toggleBoundSession(session.session_id, e.target.checked)}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-50">{session.name}</div>
                            <div className="mt-1 truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                              创建于 {formatLocal(session.created_at)}
                            </div>
                          </div>
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
                          <div className="rounded-xl bg-zinc-50 px-2.5 py-2 dark:bg-zinc-950/60">
                            <div className="font-semibold text-zinc-900 dark:text-zinc-50">{counts.filmstrip}</div>
                            <div className="text-zinc-500 dark:text-zinc-400">Filmstrip</div>
                          </div>
                          <div className="rounded-xl bg-zinc-50 px-2.5 py-2 dark:bg-zinc-950/60">
                            <div className="font-semibold text-zinc-900 dark:text-zinc-50">{counts.preferred}</div>
                            <div className="text-zinc-500 dark:text-zinc-400">优选池</div>
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-2xl border border-dashed border-zinc-200 px-3 py-4 text-center text-xs text-zinc-500 dark:border-white/10 dark:text-zinc-400">
                  没有匹配的 session，可直接上方新建。
                </div>
              )}
            </div>

            <div className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
              不选任何 session 也能正常生成；如果已绑定，任务进入生成队列后会先以“生成中”占位写入。
            </div>
          </Card>

          <div>
            <Card>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">参数</div>
                  <div className="text-xs text-zinc-600 dark:text-zinc-300">默认值来自 Settings</div>
                </div>
                <span className="rounded-full border border-zinc-200 bg-white/60 px-2 py-1 text-[10px] font-bold text-zinc-600 dark:border-white/10 dark:bg-zinc-900/40 dark:text-zinc-300">
                  v1
                </span>
              </div>

              <div className="mt-3 space-y-3">
                <Field label="model">
                  <Select
                    value={String(model)}
                    onChange={(v) => handleModelChange(v as ModelId)}
                    options={catalog.models.map((m) => ({ value: m.model_id, label: `${m.label} (${m.model_id})` }))}
                  />
                </Field>

                {isAdmin ? (
                  <Field label="provider">
                    <Select
                      testId="create-provider-select"
                      value={providerId || AUTO_PROVIDER_VALUE}
                      onChange={(v) => setProviderId(v === AUTO_PROVIDER_VALUE ? null : v)}
                      options={createProviderOptions}
                    />
                    <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                      仅管理员可见。`Auto Select` 走普通调度；手动指定时可临时测试 disabled / cooldown provider。
                    </div>
                  </Field>
                ) : null}

                <Field label="aspect_ratio">
                  <Select
                    value={String(aspect)}
                    onChange={(v) => setAspect(v as AspectRatio)}
                    options={(currentModel?.supported_aspect_ratios || ["1:1"]).map((v) => ({ value: v, label: v }))}
                  />
                  <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">Google 当前接口不支持 `auto`。</div>
                </Field>

                {currentModel?.supports_image_size ? (
                  <Field label="image_size">
                    <Select
                      value={String(size)}
                      onChange={(v) => setSize(v as ImageSize)}
                      options={(currentModel.supported_image_sizes || []).map((v) => ({ value: v, label: v }))}
                    />
                  </Field>
                ) : (
                  <Field label="image_size">
                    <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-600 dark:border-white/10 dark:bg-zinc-950/30 dark:text-zinc-300">
                      当前模型输出分辨率固定（无需设置 image_size）
                    </div>
                  </Field>
                )}

                {currentModel?.supports_thinking_level ? (
                  <Field label="thinking_level">
                    <Select
                      value={String(thinkingLevel || currentModel.default_params.thinking_level || currentModel.supported_thinking_levels[0] || "High")}
                      onChange={(v) => setThinkingLevel(v)}
                      options={(currentModel.supported_thinking_levels || []).map((v) => ({ value: v, label: v }))}
                    />
                  </Field>
                ) : null}

                <Field label={<span className="inline-flex items-center gap-1.5">temperature ({temperature.toFixed(2)}) <HelpTip text="控制生成结果的随机性。数值越高，结果越发散；数值越低，结果越稳定、更贴近提示词。" /></span>}>
                  <input
                    type="range"
                    min={0}
                    max={1.5}
                    step={0.01}
                    value={temperature}
                    onChange={(e) => setTemperature(Number(e.target.value))}
                    className="w-full"
                  />
                </Field>

                <Field label={<span className="inline-flex items-center gap-1.5">timeout_sec ({timeoutSec}s) <HelpTip text="单次请求允许后端等待上游模型返回结果的最长时间。时间越长，越适合复杂任务，但等待也会更久。" /></span>}>
                  <input
                    type="range"
                    min={15}
                    max={600}
                    step={1}
                    value={timeoutSec}
                    onChange={(e) => setTimeoutSec(Number(e.target.value))}
                    className="w-full"
                  />
                </Field>

                <Field label={`job_count (${jobCount})`}>
                  <input
                    type="range"
                    min={1}
                    max={12}
                    step={1}
                    value={jobCount}
                    onChange={(e) => setJobCount(Number(e.target.value))}
                    className="w-full"
                  />
                  <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                    同一 prompt 连续创建多个 job，默认 1，用于一次生成多张图供挑选。
                  </div>
                </Field>

                <Divider />

                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">高级模式</div>
                    <div className="text-xs text-zinc-600 dark:text-zinc-300">
                      {currentModel?.supports_text_output ? "Text+Image（仅部分模型有效）" : "当前模型仅支持 IMAGE_ONLY"}
                    </div>
                  </div>
                  {currentModel?.supports_text_output ? (
                    <Switch value={mode === "TEXT_AND_IMAGE"} onChange={(v) => setMode(v ? "TEXT_AND_IMAGE" : "IMAGE_ONLY")} />
                  ) : (
                    <span className="rounded-full border border-zinc-200 bg-zinc-100 px-3 py-1 text-xs font-bold text-zinc-600 dark:border-white/10 dark:bg-zinc-900/40 dark:text-zinc-300">
                      IMAGE_ONLY
                    </span>
                  )}
                </div>

                <Button
                  variant="primary"
                  disabled={loading}
                  onClick={onSubmit}
                  className="w-full"
                  title="创建后会写入本地历史，并跳转到详情页"
                >
                  {loading ? (
                    <span className="inline-flex items-center gap-2">
                      <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white dark:border-zinc-400/30 dark:border-t-zinc-900" />
                      生成中…
                    </span>
                  ) : (
                    "生成"
                  )}
                </Button>

                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                  创建成功后：会把 job_id / token / params 写入 localStorage（本地为主）。
                </div>
              </div>
            </Card>
          </div>
        </div>
      </PageContainer>
    </>
  );
}

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold text-zinc-500 dark:text-zinc-400">{label}</div>
      {children}
    </div>
  );
}

function LabelWithHint({ label, hint }: { label: string; hint: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span>{label}</span>
      <span
        title={hint}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-zinc-300 text-[10px] font-bold text-zinc-500 dark:border-white/15 dark:text-zinc-300"
      >
        ?
      </span>
    </span>
  );
}

function PickerSessionJobSync() {
  const client = useApiClient();
  const settings = useSettingsStore((s) => s.settings);
  const jobs = useJobsStore((s) => s.jobs);
  const updateJob = useJobsStore((s) => s.updateJob);
  const sessions = usePickerStore((s) => s.sessions);
  const patchSession = usePickerStore((s) => s.patchSession);
  const addItems = usePickerStore((s) => s.addItems);
  const hydratedJobsRef = useRef<Record<string, true>>({});
  const hydratingJobsRef = useRef<Record<string, true>>({});
  const tickRunningRef = useRef(false);

  const jobsById = useMemo(() => {
    const map = new Map<string, JobRecord>();
    jobs.forEach((job) => map.set(job.job_id, job));
    return map;
  }, [jobs]);
  const jobsByIdRef = useLatestRef(jobsById);

  const pendingJobs = useMemo(() => {
    const map = new Map<
      string,
      {
        job_id: string;
        job_access_token?: string;
        status: JobStatus;
        placeholders: Array<{ session_id: string; key: string; item: PickerSessionItem }>;
      }
    >();

    sessions.forEach((session) => {
      session.items.forEach((item) => {
        if (pickerItemHasImage(item)) return;
        const current = map.get(item.job_id);
        const status = pickerItemJobStatus(item, jobsById.get(item.job_id));
        if (current) {
          current.placeholders.push({ session_id: session.session_id, key: pickerItemKey(item), item });
          if (!current.job_access_token && item.job_access_token) current.job_access_token = item.job_access_token;
          if (current.status !== "FAILED" && (status === "RUNNING" || status === "QUEUED")) current.status = status;
        } else {
          map.set(item.job_id, {
            job_id: item.job_id,
            job_access_token: item.job_access_token,
            status,
            placeholders: [{ session_id: session.session_id, key: pickerItemKey(item), item }],
          });
        }
      });
    });

    return Array.from(map.values());
  }, [jobsById, sessions]);
  const pendingJobsRef = useLatestRef(pendingJobs);

  useEffect(() => {
    const activeJobIds = new Set(pendingJobs.map((entry) => entry.job_id));
    Object.keys(hydratedJobsRef.current).forEach((jobId) => {
      if (!activeJobIds.has(jobId)) delete hydratedJobsRef.current[jobId];
    });
    Object.keys(hydratingJobsRef.current).forEach((jobId) => {
      if (!activeJobIds.has(jobId)) delete hydratingJobsRef.current[jobId];
    });
  }, [pendingJobs]);

  useEffect(() => {
    const controller = new AbortController();
    const readJobsById = () => jobsByIdRef.current;
    const readPendingJobs = () => pendingJobsRef.current;

    const applySnapshot = (snap: JobStatusSnapshot) => {
      const rec = readJobsById().get(snap.job_id);
      updateJob(snap.job_id, {
        status_cache: (snap.status || rec?.status_cache || "UNKNOWN") as JobStatus,
        model_cache: (snap.model as ModelId) || rec?.model_cache,
        first_image_id: snap.first_image_id || rec?.first_image_id,
        image_count_cache: typeof snap.image_count === "number" ? snap.image_count : rec?.image_count_cache,
        last_seen_at: isoNow(),
        ...jobTimingPatch({ job_id: snap.job_id, timing: snap.timing || {} } as JobMeta),
      });
    };

    const hydrateSucceededJob = async (entry: (typeof pendingJobs)[number]) => {
      if (hydratedJobsRef.current[entry.job_id] || hydratingJobsRef.current[entry.job_id]) return;
      hydratingJobsRef.current[entry.job_id] = true;
      try {
        const meta = await client.getJob(entry.job_id, entry.job_access_token, controller.signal);
        updateJob(entry.job_id, {
          status_cache: (meta.status || "SUCCEEDED") as JobStatus,
          model_cache: (meta.model as ModelId) || readJobsById().get(entry.job_id)?.model_cache,
          last_seen_at: isoNow(),
          ...jobTimingPatch(meta),
        });
        const imageIds = extractImageIdsFromResult(meta?.result);
        if (imageIds.length) {
          entry.placeholders.forEach(({ session_id, key, item }) => {
            const replacementKey = pickerItemKeyFrom(entry.job_id, imageIds[0]);
            patchSession(session_id, (session) => ({
              ...session,
              items: session.items.filter((sessionItem) => pickerItemKey(sessionItem) !== key),
              slots: session.slots.map((slotKey) => (slotKey === key ? replacementKey : slotKey)),
              focus_key: session.focus_key === key ? replacementKey : session.focus_key,
            }));
            addItems(
              session_id,
              imageIds.map((image_id) => ({
                job_id: entry.job_id,
                image_id,
                job_access_token: entry.job_access_token || readJobsById().get(entry.job_id)?.job_access_token,
                bucket: item.bucket || (item.pool === "PREFERRED" ? "PREFERRED" : "FILMSTRIP"),
                pool: item.pool,
                picked: item.picked,
                rating: item.rating,
                reviewed: item.reviewed,
                notes: item.notes,
                added_at: item.added_at,
                status: "SUCCEEDED" as JobStatus,
                show_count_total: item.show_count_total,
                show_count_by_mode: item.show_count_by_mode,
                first_shown_at: item.first_shown_at,
                last_shown_at: item.last_shown_at,
                arrival_seq: item.arrival_seq,
                arrival_turn: item.arrival_turn,
                last_status_changed_at: isoNow(),
                just_completed_at: isoNow(),
                just_completed_turn: usePickerStore.getState().sessions.find((session) => session.session_id === session_id)?.scheduler?.turn || 0,
              }))
            );
          });
          hydratedJobsRef.current[entry.job_id] = true;
        } else {
          entry.placeholders.forEach(({ session_id, key }) => {
            patchSession(session_id, (session) => ({
              ...session,
              items: session.items.map((item) =>
                pickerItemKey(item) === key
                  ? { ...item, status: "SUCCEEDED", notes: item.notes || "结果已完成，等待图片清单同步" }
                  : item
              ),
            }));
          });
        }
      } catch {
        // keep placeholder and retry later
      } finally {
        delete hydratingJobsRef.current[entry.job_id];
      }
    };

    const tick = async () => {
      const latestPendingJobs = readPendingJobs();
      if (!latestPendingJobs.length) return;

      const unsettled = latestPendingJobs.filter((entry) => {
        const status = (useJobsStore.getState().jobs.find((job) => job.job_id === entry.job_id)?.status_cache || entry.status) as JobStatus;
        return status !== "SUCCEEDED" && status !== "FAILED";
      });

      if (unsettled.length) {
        const refs: JobAccessRef[] = unsettled.map((entry) => ({
          job_id: entry.job_id,
          job_access_token: entry.job_access_token,
        }));

        try {
          const payload = await client.activeJobs(refs, 100, controller.signal);
          (payload.active || []).forEach(applySnapshot);
          (payload.settled || []).forEach(applySnapshot);
        } catch {
          await mapLimit(unsettled, clamp(settings.polling.concurrency || 5, 1, 12), async (entry) => {
            try {
              const meta = await client.getJob(entry.job_id, entry.job_access_token, controller.signal);
              updateJob(entry.job_id, {
                status_cache: (meta.status || "UNKNOWN") as JobStatus,
                model_cache: (meta.model as ModelId) || readJobsById().get(entry.job_id)?.model_cache,
                last_seen_at: isoNow(),
                ...jobTimingPatch(meta),
              });
            } catch {
              // ignore transient sync errors
            }
          });
        }

        const latestAfterBatch = new Map(useJobsStore.getState().jobs.map((job) => [job.job_id, job]));
        const unresolved = unsettled.filter((entry) => {
          const status = (latestAfterBatch.get(entry.job_id)?.status_cache || entry.status || "UNKNOWN") as JobStatus;
          return status !== "SUCCEEDED" && status !== "FAILED";
        });
        if (unresolved.length) {
          await mapLimit(unresolved, clamp(settings.polling.concurrency || 5, 1, 12), async (entry) => {
            try {
              const meta = await client.getJob(entry.job_id, entry.job_access_token, controller.signal);
              updateJob(entry.job_id, {
                status_cache: (meta.status || "UNKNOWN") as JobStatus,
                model_cache: (meta.model as ModelId) || readJobsById().get(entry.job_id)?.model_cache,
                last_seen_at: isoNow(),
                ...jobTimingPatch(meta),
              });
            } catch {
              // ignore transient sync errors
            }
          });
        }
      }

      const latestJobs = new Map(useJobsStore.getState().jobs.map((job) => [job.job_id, job]));
      const succeeded = readPendingJobs().filter((entry) => {
        const status = (latestJobs.get(entry.job_id)?.status_cache || entry.status || "UNKNOWN") as JobStatus;
        return status === "SUCCEEDED" && !hydratedJobsRef.current[entry.job_id];
      });
      if (succeeded.length) {
        await mapLimit(succeeded, 2, async (entry) => {
          await hydrateSucceededJob(entry);
          return null;
        });
      }
    };

    const runTick = async () => {
      if (tickRunningRef.current) return;
      tickRunningRef.current = true;
      try {
        await tick();
      } finally {
        tickRunningRef.current = false;
      }
    };

    runTick();
    const timer = window.setInterval(runTick, clamp(settings.polling.intervalMs || 1200, 800, 10000));
    return () => {
      controller.abort();
      tickRunningRef.current = false;
      window.clearInterval(timer);
    };
  }, [addItems, client, patchSession, settings.polling.concurrency, settings.polling.intervalMs, updateJob]);

  return null;
}

function FailedBatchSessionCleanup() {
  const jobs = useJobsStore((s) => s.jobs);
  const sessions = usePickerStore((s) => s.sessions);
  const removeItem = usePickerStore((s) => s.removeItem);
  const cleanedRef = useRef<Record<string, true>>({});

  useEffect(() => {
    jobs.forEach((job) => {
      if (!job.auto_remove_failed_from_picker) return;
      if ((job.status_cache || "UNKNOWN") !== "FAILED") return;
      const linkedSessionIds = job.linked_session_ids || [];
      if (!linkedSessionIds.length) return;
      const cleanupKey = `${job.job_id}:${linkedSessionIds.join(",")}`;
      if (cleanedRef.current[cleanupKey]) return;
      linkedSessionIds.forEach((sessionId) => {
        const session = sessions.find((item) => item.session_id === sessionId);
        if (!session) return;
        const pendingKey = pickerPendingItemKey(job.job_id);
        if (session.items.some((item) => pickerItemKey(item) === pendingKey)) {
          removeItem(sessionId, pendingKey);
        }
      });
      cleanedRef.current[cleanupKey] = true;
    });
  }, [jobs, removeItem, sessions]);

  return null;
}

function PendingSessionDirectHydrator() {
  const client = useApiClient();
  const settings = useSettingsStore((s) => s.settings);
  const jobs = useJobsStore((s) => s.jobs);
  const sessions = usePickerStore((s) => s.sessions);
  const patchSession = usePickerStore((s) => s.patchSession);
  const addItems = usePickerStore((s) => s.addItems);
  const updateJob = useJobsStore((s) => s.updateJob);
  const tickRunningRef = useRef(false);
  const jobsById = useMemo(() => {
    const map = new Map<string, JobRecord>();
    jobs.forEach((job) => map.set(job.job_id, job));
    return map;
  }, [jobs]);

  const pendingEntries = useMemo(() => {
    const map = new Map<
      string,
      {
        job_id: string;
        job_access_token?: string;
        placeholders: Array<{ session_id: string; key: string; item: PickerSessionItem }>;
      }
    >();

    sessions.forEach((session) => {
      session.items.forEach((item) => {
        if (pickerItemHasImage(item)) return;
        const job = jobsById.get(item.job_id);
        if (job?.status_cache && job.status_cache !== "UNKNOWN") return;
        const key = pickerItemKey(item);
        const found = map.get(item.job_id);
        if (found) {
          found.placeholders.push({ session_id: session.session_id, key, item });
          if (!found.job_access_token && item.job_access_token) found.job_access_token = item.job_access_token;
        } else {
          map.set(item.job_id, {
            job_id: item.job_id,
            job_access_token: item.job_access_token,
            placeholders: [{ session_id: session.session_id, key, item }],
          });
        }
      });
    });

    return Array.from(map.values());
  }, [jobsById, sessions]);
  const pendingEntriesRef = useLatestRef(pendingEntries);

  useEffect(() => {
    const controller = new AbortController();

    const tick = async () => {
      const latestPendingEntries = pendingEntriesRef.current;
      if (!latestPendingEntries.length) return;

      await mapLimit(latestPendingEntries, 2, async (entry) => {
        try {
          const meta = await client.getJob(entry.job_id, entry.job_access_token, controller.signal);
          const nextStatus = (meta.status || "UNKNOWN") as JobStatus;
          updateJob(entry.job_id, {
            status_cache: nextStatus,
            model_cache: (meta.model as ModelId) || useJobsStore.getState().jobs.find((job) => job.job_id === entry.job_id)?.model_cache,
            last_seen_at: isoNow(),
            ...jobTimingPatch(meta),
          });

          if (nextStatus === "SUCCEEDED") {
            const imageIds = extractImageIdsFromResult(meta?.result);
            if (imageIds.length) {
              entry.placeholders.forEach(({ session_id, key, item }) => {
                const replacementKey = pickerItemKeyFrom(entry.job_id, imageIds[0]);
                patchSession(session_id, (session) => ({
                  ...session,
                  items: session.items.filter((sessionItem) => pickerItemKey(sessionItem) !== key),
                  slots: session.slots.map((slotKey) => (slotKey === key ? replacementKey : slotKey)),
                  focus_key: session.focus_key === key ? replacementKey : session.focus_key,
                }));
                addItems(
                  session_id,
                  imageIds.map((image_id) => ({
                    job_id: entry.job_id,
                    image_id,
                    job_access_token: entry.job_access_token,
                    bucket: item.bucket || (item.pool === "PREFERRED" ? "PREFERRED" : "FILMSTRIP"),
                    pool: item.pool,
                    picked: item.picked,
                    rating: item.rating,
                    reviewed: item.reviewed,
                    notes: item.notes,
                    added_at: item.added_at,
                    status: "SUCCEEDED" as JobStatus,
                    show_count_total: item.show_count_total,
                    show_count_by_mode: item.show_count_by_mode,
                    first_shown_at: item.first_shown_at,
                    last_shown_at: item.last_shown_at,
                    arrival_seq: item.arrival_seq,
                    arrival_turn: item.arrival_turn,
                    last_status_changed_at: isoNow(),
                    just_completed_at: isoNow(),
                    just_completed_turn: usePickerStore.getState().sessions.find((session) => session.session_id === session_id)?.scheduler?.turn || 0,
                  }))
                );
              });
            } else {
              entry.placeholders.forEach(({ session_id, key }) => {
                patchSession(session_id, (session) => ({
                  ...session,
                  items: session.items.map((item) =>
                    pickerItemKey(item) === key
                      ? { ...item, status: "SUCCEEDED", notes: item.notes || "结果已完成，等待图片清单同步" }
                      : item
                  ),
                }));
              });
            }
            return;
          }

          entry.placeholders.forEach(({ session_id, key }) => {
            patchSession(session_id, (session) => ({
              ...session,
              items: session.items.map((item) =>
                pickerItemKey(item) === key ? { ...item, status: nextStatus } : item
              ),
            }));
          });
        } catch {
          // ignore transient polling errors
        }
      });
    };

    const runTick = async () => {
      if (tickRunningRef.current) return;
      tickRunningRef.current = true;
      try {
        await tick();
      } finally {
        tickRunningRef.current = false;
      }
    };

    runTick();
    const timer = window.setInterval(runTick, clamp(settings.polling.intervalMs || 1200, 800, 10000));
    return () => {
      controller.abort();
      tickRunningRef.current = false;
      window.clearInterval(timer);
    };
  }, [addItems, client, patchSession, settings.polling.intervalMs, updateJob]);

  return null;
}

// -----------------------------
// Job live (SSE fallback polling)
// -----------------------------

function useJobLive(jobId: string | null, jobToken?: string) {
  const client = useApiClient();
  const settings = useSettingsStore((s) => s.settings);

  const [meta, setMeta] = useState<JobMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sseRef = useRef<EventSource | null>(null);
  const stopRef = useRef(false);

  const fetchOnce = async () => {
    if (!jobId) return;
    setLoading(true);
    setError(null);
    try {
      const m = await client.getJob(jobId, jobToken);
      setMeta(m);
      useJobsStore.getState().updateJob(jobId, {
        last_seen_at: isoNow(),
        ...jobMetaCachePatch(m),
      });
    } catch (e: any) {
      setError(e?.error?.message || "加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    stopRef.current = false;
    setMeta(null);
    setError(null);

    if (!jobId) return;

    // Try SSE first (optional endpoint)
    const trySSE = () => {
      try {
        // NOTE: native EventSource cannot set headers; token-protected SSE may not work.
        const url = `${settings.baseUrl.replace(/\/$/, "")}/v1/jobs/${encodeURIComponent(jobId)}/events`;
        const es = new EventSource(url, { withCredentials: true });
        sseRef.current = es;

        const onMsg = (ev: MessageEvent) => {
          try {
            const data = JSON.parse(ev.data);
            if (data?.status || data?.job_id) {
              setMeta((prev) => ({ ...(prev || { job_id: jobId }), ...data }));
            }
            if (data?.status) {
              useJobsStore.getState().updateJob(jobId, {
                status_cache: data.status,
                model_cache: (data?.model as ModelId) || undefined,
                last_seen_at: isoNow(),
              });
            }
            if (data?.status === "SUCCEEDED" || data?.status === "FAILED" || data?.status === "CANCELLED") {
              es.close();
              sseRef.current = null;
              // fetch full meta once
              fetchOnce();
            }
          } catch {
            // ignore
          }
        };

        const onErr = () => {
          es.close();
          sseRef.current = null;
          // fallback to polling
          poll();
        };

        es.addEventListener("message", onMsg);
        es.addEventListener("error", onErr);
        // initial fetch
        fetchOnce();
      } catch {
        poll();
      }
    };

    const poll = async () => {
      let interval = settings.polling.intervalMs || 1200;
      const maxInterval = settings.polling.maxIntervalMs || 5000;
      while (!stopRef.current) {
        await fetchOnce();
        const st = (useJobsStore.getState().jobs.find((j) => j.job_id === jobId)?.status_cache || meta?.status || "") as JobStatus;
        if (st === "SUCCEEDED" || st === "FAILED" || st === "CANCELLED") break;
        await new Promise((r) => setTimeout(r, interval));
        interval = Math.min(maxInterval, Math.round(interval * 1.25));
      }
    };

    trySSE();

    return () => {
      stopRef.current = true;
      sseRef.current?.close();
      sseRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, jobToken, settings.baseUrl, settings.polling.intervalMs, settings.polling.maxIntervalMs]);

  return { meta, loading, error, refresh: fetchOnce };
}

type HistoryPreviewEntry = {
  src?: string;
  loading: boolean;
  failed?: boolean;
};

function useHistoryPreviewMap(records: JobRecord[]) {
  const client = useApiClient();
  const settings = useSettingsStore((s) => s.settings);
  const { user } = useAuthSession();
  const scope = user?.user_id || "__guest__";
  const [previewMap, setPreviewMap] = useState<Record<string, HistoryPreviewEntry>>({});
  const recordsKey = useMemo(
    () => records.map((rec) => `${rec.job_id}:${rec.first_image_id || ""}:${rec.status_cache || ""}`).join("|"),
    [records]
  );
  const targets = useMemo(
    () =>
      records.map((rec) => ({
        job_id: rec.job_id,
        job_access_token: rec.job_access_token,
        status_cache: rec.status_cache,
        first_image_id: rec.first_image_id,
      })),
    [recordsKey]
  );

  useEffect(() => {
    let stopped = false;
    const controller = new AbortController();
    const successful = targets.filter((rec) => rec.status_cache === "SUCCEEDED" && rec.first_image_id);
    setPreviewMap(() => {
      const next: Record<string, HistoryPreviewEntry> = {};
      targets.forEach((rec) => {
        if (rec.status_cache !== "SUCCEEDED" || !rec.first_image_id) return;
        const shared = sharedPreviewGet(scope, settings.baseUrl, rec.job_id, rec.first_image_id);
        if (shared?.url) {
          next[rec.job_id] = { src: shared.url, loading: false, failed: false };
          return;
        }
        next[rec.job_id] = {
          loading: !(settings.jobAuthMode === "TOKEN" && !rec.job_access_token),
          failed: settings.jobAuthMode === "TOKEN" && !rec.job_access_token,
        };
      });
      return next;
    });

    if (!successful.length) return () => controller.abort();

    (async () => {
      const cachedResults = await Promise.all(
        successful.map(async (rec) => {
          const imageId = rec.first_image_id as string;
          const shared = sharedPreviewGet(scope, settings.baseUrl, rec.job_id, imageId);
          const blob =
            !shared?.url && settings.cache.enabled
              ? await imageCacheGet(scope, settings.baseUrl, rec.job_id, imageId, "preview")
              : null;
          return { rec, imageId, sharedUrl: shared?.url, blob };
        })
      );
      if (stopped) return;

      const misses: Array<{ job_id: string; image_id: string; job_access_token?: string }> = [];
      const nextState: Record<string, HistoryPreviewEntry> = {};
      cachedResults.forEach(({ rec, imageId, sharedUrl, blob }) => {
        if (sharedUrl) {
          nextState[rec.job_id] = { src: sharedUrl, loading: false, failed: false };
        } else if (blob) {
          nextState[rec.job_id] = {
            src: sharedPreviewRemember(scope, settings.baseUrl, rec.job_id, imageId, blob),
            loading: false,
            failed: false,
          };
        } else if (settings.jobAuthMode === "TOKEN" && !rec.job_access_token) {
          nextState[rec.job_id] = { loading: false, failed: true };
        } else {
          misses.push({ job_id: rec.job_id, image_id: imageId, job_access_token: rec.job_access_token });
          nextState[rec.job_id] = { loading: true, failed: false };
        }
      });
      setPreviewMap((current) => ({ ...current, ...nextState }));
      if (!misses.length) return;

      try {
        const payload = await client.batchPreviewImages(misses.slice(0, 72), controller.signal);
        if (stopped) return;
        const byJobId = new Map(payload.items.map((item) => [item.job_id, item]));
        const merged: Record<string, HistoryPreviewEntry> = {};
        await Promise.all(
          misses.map(async (miss) => {
            const item = byJobId.get(miss.job_id);
            if (!item) {
              merged[miss.job_id] = { loading: false, failed: true };
              return;
            }
            const blob = base64ToBlob(item.data_base64, item.mime);
            if (settings.cache.enabled) {
              await imageCachePut(scope, settings.baseUrl, miss.job_id, miss.image_id, "preview", blob, settings.cache);
            }
            merged[miss.job_id] = {
              src: sharedPreviewRemember(scope, settings.baseUrl, miss.job_id, miss.image_id, blob),
              loading: false,
              failed: false,
            };
          })
        );
        if (!stopped) {
          setPreviewMap((current) => ({ ...current, ...merged }));
        }
      } catch {
        if (!stopped) {
          setPreviewMap((current) => {
            const next = { ...current };
            misses.forEach((miss) => {
              next[miss.job_id] = { loading: false, failed: true };
            });
            return next;
          });
        }
      }
    })();

    return () => {
      stopped = true;
      controller.abort();
    };
  }, [client, recordsKey, scope, settings.baseUrl, settings.cache.enabled, settings.cache.maxBytes, settings.cache.ttlDays, settings.jobAuthMode, targets]);

  return previewMap;
}

type AdminTaskSortKey = "created_desc" | "created_asc" | "updated_desc" | "updated_asc" | "duration_desc";
type AdminTaskDensity = "gallery" | "list";

function adminJobSummaryToRecord(item: AdminUserJobSummary): JobRecord {
  return {
    job_id: item.job_id,
    created_at: item.created_at,
    last_seen_at: item.updated_at || item.created_at,
    status_cache: item.status,
    model_cache: item.model,
    prompt_preview: item.prompt_preview,
    batch_id: item.batch_id || undefined,
    batch_name: item.batch_name || undefined,
    batch_note: item.batch_note || undefined,
    batch_size: item.batch_size ?? undefined,
    batch_index: item.batch_index ?? undefined,
    section_index: item.section_index ?? undefined,
    section_title: item.section_title || undefined,
    queue_wait_ms: item.timing?.queue_wait_ms,
    run_duration_ms: item.timing?.run_duration_ms,
    run_started_at: item.timing?.started_at,
    run_finished_at: item.timing?.finished_at,
    first_image_id: item.first_image_id || undefined,
    image_count_cache: item.image_count ?? undefined,
    error_code_cache: item.error?.code || undefined,
    error_message_cache: item.error?.message || undefined,
  };
}

function adminUserOverrideValue(user: AdminUserItem | null, key: keyof UserPolicyOverrides) {
  return user?.policy_overrides?.[key] ?? null;
}

function adminUserRiskTags(user: AdminUserItem) {
  const tags: string[] = [];
  const dailyLimit = user.policy.daily_image_limit;
  const quotaConsumed = user.usage.quota_consumed_today || 0;
  const imageAccessLimit = user.usage.image_access_limit_today;
  if (!user.enabled) tags.push("disabled");
  if (user.role === "ADMIN") tags.push("admin");
  if (!user.last_login_at) tags.push("never login");
  if ((user.usage.running_jobs || 0) > 0) tags.push("running jobs");
  if ((user.usage.jobs_failed_today || 0) >= 3) tags.push("high failures");
  if (dailyLimit != null && quotaConsumed >= dailyLimit) tags.push("over quota");
  if (dailyLimit != null && dailyLimit > 0 && quotaConsumed / dailyLimit >= 0.8 && quotaConsumed < dailyLimit) tags.push("high usage");
  if (imageAccessLimit != null && (user.usage.image_accesses_today || 0) >= imageAccessLimit) tags.push("image access cap");
  return tags;
}

function adminUserRiskScore(user: AdminUserItem) {
  const tags = new Set(adminUserRiskTags(user));
  return [
    tags.has("disabled") ? 40 : 0,
    tags.has("over quota") ? 32 : 0,
    tags.has("running jobs") ? 24 : 0,
    tags.has("high failures") ? 20 : 0,
    tags.has("high usage") ? 12 : 0,
    tags.has("never login") ? 8 : 0,
    user.role === "ADMIN" ? -5 : 0,
  ].reduce((sum, n) => sum + n, 0);
}

function useAdminTaskPreviewMap(items: AdminUserJobSummary[], ownerKey: string) {
  const client = useApiClient();
  const settings = useSettingsStore((s) => s.settings);
  const scope = `admin:${ownerKey || "__none__"}`;
  const [previewMap, setPreviewMap] = useState<Record<string, HistoryPreviewEntry>>({});
  const targets = useMemo(
    () =>
      items.map((item) => ({
        job_id: item.job_id,
        first_image_id: item.first_image_id || undefined,
        status: item.status,
      })),
    [items]
  );
  const recordsKey = useMemo(
    () => targets.map((item) => `${item.job_id}:${item.first_image_id || ""}:${item.status}`).join("|"),
    [targets]
  );

  useEffect(() => {
    let stopped = false;
    const controller = new AbortController();
    const successful = targets.filter((item) => item.status === "SUCCEEDED" && item.first_image_id);
    setPreviewMap(() => {
      const next: Record<string, HistoryPreviewEntry> = {};
      targets.forEach((item) => {
        if (item.status !== "SUCCEEDED" || !item.first_image_id) return;
        const shared = sharedPreviewGet(scope, settings.baseUrl, item.job_id, item.first_image_id);
        next[item.job_id] = shared?.url ? { src: shared.url, loading: false, failed: false } : { loading: true, failed: false };
      });
      return next;
    });

    if (!successful.length) return () => controller.abort();

    (async () => {
      const cachedResults = await Promise.all(
        successful.map(async (item) => {
          const imageId = item.first_image_id as string;
          const shared = sharedPreviewGet(scope, settings.baseUrl, item.job_id, imageId);
          const blob =
            !shared?.url && settings.cache.enabled
              ? await imageCacheGet(scope, settings.baseUrl, item.job_id, imageId, "preview")
              : null;
          return { item, imageId, sharedUrl: shared?.url, blob };
        })
      );
      if (stopped) return;

      const misses: Array<{ job_id: string; image_id: string }> = [];
      const nextState: Record<string, HistoryPreviewEntry> = {};
      cachedResults.forEach(({ item, imageId, sharedUrl, blob }) => {
        if (sharedUrl) {
          nextState[item.job_id] = { src: sharedUrl, loading: false, failed: false };
        } else if (blob) {
          nextState[item.job_id] = {
            src: sharedPreviewRemember(scope, settings.baseUrl, item.job_id, imageId, blob),
            loading: false,
            failed: false,
          };
        } else {
          misses.push({ job_id: item.job_id, image_id: imageId });
          nextState[item.job_id] = { loading: true, failed: false };
        }
      });
      if (!stopped) setPreviewMap((current) => ({ ...current, ...nextState }));
      if (!misses.length) return;

      try {
        const payload = await client.batchPreviewImages(
          misses.map((item) => ({ job_id: item.job_id, image_id: item.image_id })).slice(0, 72),
          controller.signal
        );
        if (stopped) return;
        const byJobId = new Map(payload.items.map((entry) => [entry.job_id, entry]));
        const merged: Record<string, HistoryPreviewEntry> = {};
        await Promise.all(
          misses.map(async (miss) => {
            const entry = byJobId.get(miss.job_id);
            if (!entry) {
              merged[miss.job_id] = { loading: false, failed: true };
              return;
            }
            const blob = base64ToBlob(entry.data_base64, entry.mime);
            if (settings.cache.enabled) {
              await imageCachePut(scope, settings.baseUrl, miss.job_id, miss.image_id, "preview", blob, settings.cache);
            }
            merged[miss.job_id] = {
              src: sharedPreviewRemember(scope, settings.baseUrl, miss.job_id, miss.image_id, blob),
              loading: false,
              failed: false,
            };
          })
        );
        if (!stopped) setPreviewMap((current) => ({ ...current, ...merged }));
      } catch {
        if (!stopped) {
          setPreviewMap((current) => {
            const next = { ...current };
            misses.forEach((miss) => {
              next[miss.job_id] = { loading: false, failed: true };
            });
            return next;
          });
        }
      }
    })();

    return () => {
      stopped = true;
      controller.abort();
    };
  }, [client, recordsKey, scope, settings.baseUrl, settings.cache, targets]);

  return previewMap;
}

// -----------------------------
// History Page
// -----------------------------

type SortKey = "created_desc" | "created_asc" | "duration_desc";

type DateRange = "today" | "7d" | "30d" | "custom" | "all";

type HistoryDensity = "cozy" | "compact";

type HistoryBatchGroup = {
  key: string;
  batchId: string | null;
  items: JobRecord[];
};

function HistoryPage() {
  const client = useApiClient();
  const catalog = useModelCatalog();
  const settings = useSettingsStore((s) => s.settings);
  const jobs = useJobsStore((s) => s.jobs);
  const updateJob = useJobsStore((s) => s.updateJob);
  const pickerSessions = usePickerStore((s) => s.sessions);

  const [searchParams, setSearchParams] = useSearchParams();
  const selectedJobId = searchParams.get("job");
  const selectedRec = useMemo(() => jobs.find((j) => j.job_id === selectedJobId) || null, [jobs, selectedJobId]);

  const [q, setQ] = useState("");
  const qd = useDebounced(q, 150);
  const [statusFilter, setStatusFilter] = useState<JobStatus | "ALL">("ALL");
  const [range, setRange] = useState<DateRange>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [modelFilter, setModelFilter] = useState<ModelId | "ALL">("ALL");
  const [batchFilter, setBatchFilter] = useState("ALL");
  const [sessionFilter, setSessionFilter] = useState("ALL");
  const [failedOnly, setFailedOnly] = useState(false);
  const [density, setDensity] = useState<HistoryDensity>("cozy");
  const [sort, setSort] = useState<SortKey>("created_desc");
  const [manualAutoRefresh, setManualAutoRefresh] = useState(false);
  const [disableActiveAutoRefresh, setDisableActiveAutoRefresh] = useState<boolean>(() =>
    safeJsonParse<boolean>(storageGet(KEY_HISTORY_AUTO_REFRESH_PREF), false)
  );
  const [pageSize, setPageSize] = useState(24);
  const [page, setPage] = useState(1);

  const sessionNameById = useMemo(() => new Map(pickerSessions.map((session) => [session.session_id, session.name])), [pickerSessions]);
  const jobSessionIds = useMemo(() => {
    const map = new Map<string, Set<string>>();
    jobs.forEach((job) => {
      (job.linked_session_ids || []).forEach((sessionId) => {
        if (!map.has(job.job_id)) map.set(job.job_id, new Set());
        map.get(job.job_id)!.add(sessionId);
      });
    });
    pickerSessions.forEach((session) => {
      session.items.forEach((item) => {
        if (!map.has(item.job_id)) map.set(item.job_id, new Set());
        map.get(item.job_id)!.add(session.session_id);
      });
    });
    return map;
  }, [jobs, pickerSessions]);

  const batchNames = useMemo(
    () =>
      Array.from(new Set(jobs.map((job) => job.batch_name).filter((name): name is string => Boolean(name))))
        .sort((a, b) => a.localeCompare(b)),
    [jobs]
  );

  const filtered = useMemo(() => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const d7 = new Date(daysAgoISO(7)).getTime();
    const d30 = new Date(daysAgoISO(30)).getTime();
    const tokens = qd.trim().toLowerCase();

    const inDateRange = (j: JobRecord) => {
      const t = new Date(j.created_at).getTime();
      if (!Number.isFinite(t)) return true;
      if (range === "today") return t >= todayStart;
      if (range === "7d") return t >= d7;
      if (range === "30d") return t >= d30;
      if (range === "custom") {
        const a = from ? new Date(from).getTime() : -Infinity;
        const b = to ? new Date(to).getTime() + 24 * 3600 * 1000 - 1 : Infinity;
        return t >= a && t <= b;
      }
      return true;
    };

    let list = [...jobs].filter((j) => !j.deleted);

    if (tokens) {
      list = list.filter((j) => {
        const sessionNames = Array.from(jobSessionIds.get(j.job_id) || [])
          .map((sessionId) => sessionNameById.get(sessionId) || "")
          .join(" ");
        const hay = [
          j.job_id,
          j.model_cache || "",
          j.prompt_preview || "",
          j.prompt_text || "",
          j.batch_name || "",
          j.batch_note || "",
          j.section_title || "",
          j.error_message_cache || "",
          j.error_code_cache || "",
          sessionNames,
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(tokens);
      });
    }

    if (statusFilter !== "ALL") {
      list = list.filter((j) => (j.status_cache || "UNKNOWN") === statusFilter);
    }
    if (modelFilter !== "ALL") {
      list = list.filter((j) => (j.model_cache || "") === modelFilter);
    }
    if (batchFilter !== "ALL") {
      list = list.filter((j) => (j.batch_name || "") === batchFilter);
    }
    if (sessionFilter !== "ALL") {
      list = list.filter((j) => {
        const ids = Array.from(jobSessionIds.get(j.job_id) || []);
        if (sessionFilter === "NONE") return ids.length === 0;
        return ids.includes(sessionFilter);
      });
    }
    if (failedOnly) {
      list = list.filter((j) => ["FAILED", "CANCELLED"].includes(j.status_cache || "UNKNOWN"));
    }

    list = list.filter(inDateRange);
    list.sort((a, b) => {
      if (sort === "created_asc") {
        return (new Date(a.created_at).getTime() || 0) - (new Date(b.created_at).getTime() || 0);
      }
      if (sort === "duration_desc") {
        const ad = typeof a.run_duration_ms === "number" ? a.run_duration_ms : -1;
        const bd = typeof b.run_duration_ms === "number" ? b.run_duration_ms : -1;
        if (ad !== bd) return bd - ad;
      }
      return (new Date(b.created_at).getTime() || 0) - (new Date(a.created_at).getTime() || 0);
    });
    return list;
  }, [jobs, qd, statusFilter, range, from, to, modelFilter, batchFilter, sessionFilter, failedOnly, sort, jobSessionIds, sessionNameById]);

  const hasActiveJobs = useMemo(() => filtered.some((j) => isActiveJobStatus(j.status_cache || "UNKNOWN")), [filtered]);
  const autoRefresh = manualAutoRefresh || (hasActiveJobs && !disableActiveAutoRefresh);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = clamp(page, 1, totalPages);
  const pagedItems = useMemo(() => filtered.slice((safePage - 1) * pageSize, safePage * pageSize), [filtered, safePage, pageSize]);
  const previewMap = useHistoryPreviewMap(pagedItems);
  const pagedIdsKey = useMemo(() => pagedItems.map((item) => item.job_id).join("|"), [pagedItems]);
  const filteredActiveCount = filtered.filter((j) => isActiveJobStatus(j.status_cache || "UNKNOWN")).length;
  const autoRefreshTargets = useMemo(() => {
    if (hasActiveJobs) return filtered.filter((j) => isActiveJobStatus(j.status_cache || "UNKNOWN")).slice(0, 72);
    return pagedItems.slice(0, Math.max(24, Math.min(pageSize, 72)));
  }, [hasActiveJobs, filtered, pagedItems, pageSize]);

  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);

  useEffect(() => {
    setPage(1);
  }, [qd, statusFilter, range, from, to, modelFilter, batchFilter, sessionFilter, failedOnly, sort, density, pageSize]);

  useEffect(() => {
    storageSet(KEY_HISTORY_AUTO_REFRESH_PREF, JSON.stringify(disableActiveAutoRefresh));
  }, [disableActiveAutoRefresh]);

  useEffect(() => {
    if (!pagedItems.length) return;
    const controller = new AbortController();
    const refs: JobAccessRef[] = pagedItems.map((rec) => ({ job_id: rec.job_id, job_access_token: rec.job_access_token }));
    client
      .batchMeta(refs, ["job_id", "status", "model", "created_at", "updated_at", "params", "timing", "error", "result"], controller.signal)
      .then((batch) => {
        (batch.items || []).forEach((item) => {
          updateJob(item.job_id, {
            created_at: item.meta?.created_at || pagedItems.find((rec) => rec.job_id === item.job_id)?.created_at || isoNow(),
            ...jobMetaCachePatch(item.meta),
          });
        });
      })
      .catch(() => null);
    return () => controller.abort();
  }, [client, pagedIdsKey, updateJob]);

  useEffect(() => {
    if (!autoRefresh) return;
    const controller = new AbortController();
    const tick = async () => {
      if (!autoRefreshTargets.length) return;
      const refs: JobAccessRef[] = autoRefreshTargets.map((rec) => ({
        job_id: rec.job_id,
        job_access_token: rec.job_access_token,
      }));
      const applySnap = (snap: JobStatusSnapshot) => {
        const rec = autoRefreshTargets.find((item) => item.job_id === snap.job_id);
        updateJob(snap.job_id, {
          status_cache: (snap.status || rec?.status_cache || "UNKNOWN") as JobStatus,
          model_cache: (snap.model as ModelId) || rec?.model_cache,
          first_image_id: snap.first_image_id || rec?.first_image_id,
          image_count_cache: typeof snap.image_count === "number" ? snap.image_count : rec?.image_count_cache,
          last_seen_at: isoNow(),
          ...jobTimingPatch({ job_id: snap.job_id, timing: snap.timing || {} } as JobMeta),
        });
      };

      try {
        const payload = await client.activeJobs(refs, 120, controller.signal);
        (payload.active || []).forEach(applySnap);
        (payload.settled || []).forEach(applySnap);
        return;
      } catch {
        // ignore and fallback
      }

      try {
        const batch = await client.batchMeta(refs, ["job_id", "status", "model", "timing", "error", "result"], controller.signal);
        (batch.items || []).forEach((item) => {
          updateJob(item.job_id, {
            last_seen_at: isoNow(),
            ...jobMetaCachePatch(item.meta),
          });
        });
      } catch {
        await mapLimit(autoRefreshTargets, clamp(settings.polling.concurrency || 5, 1, 12), async (rec) => {
          try {
            const meta = await client.getJob(rec.job_id, rec.job_access_token, controller.signal);
            updateJob(rec.job_id, {
              last_seen_at: isoNow(),
              ...jobMetaCachePatch(meta),
            });
          } catch {
            // ignore
          }
        });
      }
    };

    tick();
    const timer = window.setInterval(tick, clamp(settings.polling.intervalMs || 1200, 300, 10000));
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [autoRefresh, autoRefreshTargets, client, settings.polling.concurrency, settings.polling.intervalMs, updateJob]);

  const openJob = (jobId: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("job", jobId);
      return next;
    });
  };

  const closeJob = () => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("job");
      return next;
    });
  };

  const onToggleAutoRefresh = (next: boolean) => {
    if (hasActiveJobs) {
      if (next) {
        setDisableActiveAutoRefresh(false);
      } else {
        setDisableActiveAutoRefresh(true);
        setManualAutoRefresh(false);
      }
      return;
    }
    setManualAutoRefresh(next);
  };

  const galleryCols =
    density === "compact"
      ? "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
      : "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4";

  return (
    <PageContainer className="max-w-[1880px] px-5 2xl:px-8">
      <PageTitle
        title="History"
        subtitle="本地历史画廊。支持批次识别、全文搜索、筛选和 Notion 风格详情模态。"
      />

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[248px_minmax(0,1fr)_208px] 2xl:grid-cols-[260px_minmax(0,1fr)_220px]">
        <Card className="h-fit xl:sticky xl:top-24" hover={false}>
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">Browse</div>
          <div className="mt-2 text-lg font-bold text-zinc-900 dark:text-zinc-50">Search & Filter</div>
          <div className="mt-4 space-y-3">
            <Field label="Search">
              <Input testId="history-search" value={q} onChange={setQ} placeholder="job id / prompt / batch / section / error / model" />
            </Field>
            <Field label="Status">
              <Select
                testId="history-status-filter"
                value={statusFilter}
                onChange={(v) => setStatusFilter(v as JobStatus | "ALL")}
                options={[
                  { value: "ALL", label: "All Statuses" },
                  { value: "QUEUED", label: "Queued" },
                  { value: "RUNNING", label: "Running" },
                  { value: "SUCCEEDED", label: "Success" },
                  { value: "FAILED", label: "Failed" },
                  { value: "CANCELLED", label: "Cancelled" },
                ]}
              />
            </Field>
            <Field label="Model">
              <Select
                testId="history-model-filter"
                value={String(modelFilter)}
                onChange={(v) => setModelFilter(v as ModelId | "ALL")}
                options={[
                  { value: "ALL", label: "All Models" },
                  ...catalog.models.map((m) => ({ value: m.model_id, label: m.label })),
                ]}
              />
            </Field>
            <Field label="Date Range">
              <Select
                testId="history-range-filter"
                value={range}
                onChange={(v) => setRange(v as DateRange)}
                options={[
                  { value: "all", label: "All Time" },
                  { value: "today", label: "Today" },
                  { value: "7d", label: "Last 7 Days" },
                  { value: "30d", label: "Last 30 Days" },
                  { value: "custom", label: "Custom" },
                ]}
              />
            </Field>
            {range === "custom" ? (
              <div className="grid grid-cols-2 gap-3">
                <Field label="From">
                  <Input testId="history-range-from" value={from} onChange={setFrom} type="date" />
                </Field>
                <Field label="To">
                  <Input testId="history-range-to" value={to} onChange={setTo} type="date" />
                </Field>
              </div>
            ) : null}
            <Field label="Batch">
              <Select
                testId="history-batch-filter"
                value={batchFilter}
                onChange={setBatchFilter}
                options={[
                  { value: "ALL", label: "All Batches" },
                  ...batchNames.map((name) => ({ value: name, label: name })),
                ]}
              />
            </Field>
            <Field label="Session">
              <Select
                testId="history-session-filter"
                value={sessionFilter}
                onChange={setSessionFilter}
                options={[
                  { value: "ALL", label: "All Sessions" },
                  { value: "NONE", label: "No Session" },
                  ...pickerSessions.map((session) => ({ value: session.session_id, label: session.name })),
                ]}
              />
            </Field>
            <Field label="Sort">
              <Select
                testId="history-sort-filter"
                value={sort}
                onChange={(v) => setSort(v as SortKey)}
                options={[
                  { value: "created_desc", label: "Created Desc" },
                  { value: "created_asc", label: "Created Asc" },
                  { value: "duration_desc", label: "Longest First" },
                ]}
              />
            </Field>
            <Field label="Density">
              <Select
                testId="history-density-filter"
                value={density}
                onChange={(v) => setDensity(v as HistoryDensity)}
                options={[
                  { value: "cozy", label: "Cozy" },
                  { value: "compact", label: "Compact" },
                ]}
              />
            </Field>
            <div className="flex items-center justify-between rounded-2xl border border-zinc-200 bg-zinc-50/80 px-3 py-2 dark:border-white/10 dark:bg-zinc-950/30">
              <div>
                <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Only Failed</div>
                <div className="text-[11px] text-zinc-500 dark:text-zinc-400">Failed + cancelled</div>
              </div>
              <Switch testId="history-failed-only" value={failedOnly} onChange={setFailedOnly} />
            </div>
            <div className="flex items-center justify-between rounded-2xl border border-zinc-200 bg-zinc-50/80 px-3 py-2 dark:border-white/10 dark:bg-zinc-950/30">
              <div>
                <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Auto Refresh</div>
                <div className="text-[11px] text-zinc-500 dark:text-zinc-400">Keep running/queued cards fresh</div>
              </div>
              <Switch testId="history-auto-refresh" value={autoRefresh} onChange={onToggleAutoRefresh} />
            </div>
          </div>
        </Card>

        <div className="space-y-4">
          <Card hover={false} className="rounded-[28px] px-4 py-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
              <span className="rounded-full border border-zinc-200 bg-white px-3 py-1 dark:border-white/10 dark:bg-zinc-950/40">Total {filtered.length}</span>
              <span className="rounded-full border border-zinc-200 bg-white px-3 py-1 dark:border-white/10 dark:bg-zinc-950/40">Active {filteredActiveCount}</span>
              <span className="rounded-full border border-zinc-200 bg-white px-3 py-1 dark:border-white/10 dark:bg-zinc-950/40">Page {safePage} / {totalPages}</span>
              <span className="rounded-full border border-zinc-200 bg-white px-3 py-1 dark:border-white/10 dark:bg-zinc-950/40">
                Showing {filtered.length ? (safePage - 1) * pageSize + 1 : 0}-{Math.min(filtered.length, safePage * pageSize)}
              </span>
            </div>
          </Card>

          {pagedItems.length ? (
            <div className={cn("grid gap-5", galleryCols)}>
              {pagedItems.map((rec) => (
                <HistoryGalleryCard
                  key={rec.job_id}
                  rec={rec}
                  density={density}
                  preview={previewMap[rec.job_id]}
                  onOpen={() => openJob(rec.job_id)}
                />
              ))}
            </div>
          ) : (
            <Card hover={false}>
              <EmptyHint text="没有匹配的历史任务" />
            </Card>
          )}
        </div>

        <Card className="h-fit xl:sticky xl:top-24" hover={false}>
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">Pager</div>
          <div className="mt-2 text-lg font-bold text-zinc-900 dark:text-zinc-50">Page Controls</div>
          <div className="mt-4 space-y-3">
            <Field label="Per Page">
              <Select
                testId="history-page-size"
                value={String(pageSize)}
                onChange={(v) => setPageSize(clamp(Number(v), 24, 72))}
                options={[
                  { value: "24", label: "24" },
                  { value: "48", label: "48" },
                  { value: "72", label: "72" },
                ]}
              />
            </Field>
            <div className="rounded-2xl border border-zinc-200 bg-zinc-50/80 p-3 dark:border-white/10 dark:bg-zinc-950/30">
              <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Totals</div>
              <div className="mt-2 space-y-1 text-sm text-zinc-600 dark:text-zinc-300">
                <div>Total cards: {filtered.length}</div>
                <div>Current page: {safePage}</div>
                <div>Total pages: {totalPages}</div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button testId="history-prev-page" variant="ghost" onClick={() => setPage((p) => clamp(p - 1, 1, totalPages))} disabled={safePage <= 1}>
                Prev
              </Button>
              <Button testId="history-next-page" variant="ghost" onClick={() => setPage((p) => clamp(p + 1, 1, totalPages))} disabled={safePage >= totalPages}>
                Next
              </Button>
            </div>
          </div>
        </Card>
      </div>

      <HistoryDetailModal rec={selectedRec} onClose={closeJob} />
    </PageContainer>
  );
}

function JobList({
  groups,
  selectedId,
  onSelect,
  onDeleteLocal,
  onTogglePin,
  onAddTag,
  onAddToPicker,
  progressNowMs,
  avgDurationMs,
}: {
  groups: HistoryBatchGroup[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDeleteLocal: (id: string) => void;
  onTogglePin: (id: string, v: boolean) => void;
  onAddTag: (id: string) => void;
  onAddToPicker: (id: string) => void;
  progressNowMs: number;
  avgDurationMs: number;
}) {
  if (!groups.length) return <EmptyHint text="没有匹配的记录" />;

  const renderJobCard = (j: JobRecord) => {
    const active = j.job_id === selectedId;
    const progress = computeFakeProgressPercent(j, progressNowMs, avgDurationMs);
    const runDuration = formatDurationMs(j.run_duration_ms);
    const isRunning = (j.status_cache || "UNKNOWN") === "RUNNING";
    const isQueued = (j.status_cache || "UNKNOWN") === "QUEUED";
    return (
      <div
        key={j.job_id}
        onClick={() => onSelect(j.job_id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(j.job_id);
          }
        }}
        role="button"
        tabIndex={0}
        className={cn(
          "w-full rounded-2xl border p-3 text-left transition",
          active
            ? "border-zinc-900 bg-zinc-900 text-white shadow-sm dark:border-white dark:bg-white dark:text-zinc-900"
            : "border-zinc-200 bg-white/50 hover:-translate-y-0.5 hover:shadow-sm dark:border-white/10 dark:bg-zinc-950/30"
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-bold">{j.prompt_preview || shortId(j.job_id)}</div>
            <div className={cn("mt-1 text-xs", active ? "text-white/80 dark:text-zinc-700" : "text-zinc-600 dark:text-zinc-300")}>
              {formatLocal(j.created_at)}
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            {active ? (
              <span className="inline-flex items-center gap-2 rounded-full bg-white/15 px-2 py-1 text-xs font-bold text-white dark:bg-zinc-900/10 dark:text-zinc-900">
                <span className="h-2 w-2 rounded-full bg-white/70 dark:bg-zinc-900" />
                {j.status_cache || "UNKNOWN"}
              </span>
            ) : (
              <Badge status={j.status_cache || "UNKNOWN"} />
            )}
            {j.pinned ? (
              <span className={cn("text-[10px] font-bold", active ? "text-white/80" : "text-amber-600 dark:text-amber-200")}>
                PINNED
              </span>
            ) : null}
          </div>
        </div>

        <div className={cn("mt-2", active ? "text-white/85" : "text-zinc-600 dark:text-zinc-300")}>
          <div className="flex items-center justify-between text-[11px]">
            <span>耗时：{runDuration}</span>
            {progress !== null ? (
              <span>
                {isQueued ? "排队中" : isRunning ? "运行中" : "进度"} {progress}%
              </span>
            ) : null}
          </div>
          {progress !== null ? (
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
              <div
                className={cn(
                  "h-full transition-[width] duration-500",
                  progress >= 100
                    ? "bg-emerald-500"
                    : isRunning
                      ? "bg-sky-500"
                      : isQueued
                        ? "bg-amber-500"
                        : "bg-zinc-500"
                )}
                style={{ width: `${clamp(progress, 0, 100)}%` }}
              />
            </div>
          ) : null}
        </div>

        <div className={cn("mt-2 flex flex-wrap gap-2 text-xs", active ? "text-white/85" : "text-zinc-600 dark:text-zinc-300")}>
          {j.batch_size && j.batch_size > 1 ? (
            <span className="rounded-full border border-sky-300/70 bg-sky-500/20 px-2 py-0.5 text-sky-700 dark:border-sky-700/50 dark:bg-sky-500/20 dark:text-sky-200">
              同批次 #{j.batch_index || "?"}/{j.batch_size}
            </span>
          ) : null}
          {j.batch_name ? (
            <span className="rounded-full border border-white/10 bg-white/10 px-2 py-0.5">
              Batch {j.batch_name}
            </span>
          ) : null}
          {typeof j.section_index === "number" ? (
            <span className="rounded-full border border-white/10 bg-white/10 px-2 py-0.5">
              Section {j.section_index}{j.section_title ? ` · ${j.section_title}` : ""}
            </span>
          ) : null}
          {j.model_cache ? <span className="rounded-full border border-white/10 bg-white/10 px-2 py-0.5">{j.model_cache}</span> : null}
          {j.params_cache?.image_size ? <span className="rounded-full border border-white/10 bg-white/10 px-2 py-0.5">{j.params_cache.image_size}</span> : null}
          {j.params_cache?.aspect_ratio ? <span className="rounded-full border border-white/10 bg-white/10 px-2 py-0.5">{j.params_cache.aspect_ratio}</span> : null}
          {j.tags?.slice(0, 2).map((t) => (
            <span key={t} className="rounded-full border border-white/10 bg-white/10 px-2 py-0.5">
              #{t}
            </span>
          ))}
          {j.tags && j.tags.length > 2 ? (
            <span className="rounded-full border border-white/10 bg-white/10 px-2 py-0.5">+{j.tags.length - 2}</span>
          ) : null}
        </div>

        <div className={cn("mt-3 flex flex-wrap gap-2", active ? "" : "")} onClick={(e) => e.stopPropagation()}>
          <Button
            variant={active ? "secondary" : "ghost"}
            className="!px-2 !py-1 text-xs"
            onClick={() => onTogglePin(j.job_id, !j.pinned)}
          >
            {j.pinned ? "取消置顶" : "置顶"}
          </Button>
          <Button
            variant={active ? "secondary" : "ghost"}
            className="!px-2 !py-1 text-xs"
            onClick={() => onAddTag(j.job_id)}
          >
            + Tag
          </Button>
          <Button
            variant={active ? "secondary" : "ghost"}
            className="!px-2 !py-1 text-xs"
            onClick={() => onAddToPicker(j.job_id)}
          >
            加入挑选
          </Button>
          <Button
            variant="danger"
            className="!px-2 !py-1 text-xs"
            onClick={() => {
              if (confirm("仅删除本地记录？")) onDeleteLocal(j.job_id);
            }}
          >
            删除本地
          </Button>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-3">
      {groups.map((group) => {
        const batchEnabled = Boolean(group.batchId && group.items.length > 1);
        const first = group.items[0];
        const totalInBatch = first?.batch_size && first.batch_size > 1 ? first.batch_size : group.items.length;
        return (
          <div
            key={group.key}
            className={cn(
              batchEnabled
                ? "rounded-2xl border border-sky-200 bg-gradient-to-br from-sky-50 via-cyan-50/70 to-white p-2 dark:border-sky-800/50 dark:from-sky-950/40 dark:via-cyan-950/20 dark:to-zinc-950/40"
                : ""
            )}
          >
            {batchEnabled ? (
              <div className="mb-2 flex flex-wrap items-center gap-2 px-1">
                <span className="rounded-full bg-sky-600 px-2 py-1 text-[10px] font-bold text-white dark:bg-sky-500 dark:text-sky-950">
                  同一批 Prompt 生成
                </span>
                <span className="rounded-full border border-sky-300/70 bg-white/70 px-2 py-0.5 text-[11px] font-semibold text-sky-700 dark:border-sky-700/40 dark:bg-sky-950/20 dark:text-sky-200">
                  当前页 {group.items.length}/{totalInBatch} jobs
                </span>
                {first?.batch_name ? (
                  <span className="rounded-full border border-emerald-300/70 bg-white/70 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:border-emerald-700/40 dark:bg-emerald-950/20 dark:text-emerald-200">
                    {first.batch_name}
                  </span>
                ) : null}
                {first?.batch_note ? (
                  <span className="rounded-full border border-zinc-200 bg-white/70 px-2 py-0.5 text-[11px] text-zinc-600 dark:border-white/10 dark:bg-zinc-900/50 dark:text-zinc-300">
                    {first.batch_note}
                  </span>
                ) : null}
                <span className="rounded-full border border-zinc-200 bg-white/70 px-2 py-0.5 text-[11px] text-zinc-600 dark:border-white/10 dark:bg-zinc-900/50 dark:text-zinc-300">
                  批次 {shortId(group.batchId!, 5)}
                </span>
                <span className="rounded-full border border-zinc-200 bg-white/70 px-2 py-0.5 text-[11px] text-zinc-600 dark:border-white/10 dark:bg-zinc-900/50 dark:text-zinc-300">
                  {formatLocal(first?.created_at)}
                </span>
              </div>
            ) : null}
            <div className={cn("space-y-2", batchEnabled ? "border-l-2 border-sky-200/80 pl-2 dark:border-sky-800/50" : "")}>
              {group.items.map((j) => renderJobCard(j))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function HistoryGalleryCard({
  rec,
  density,
  preview,
  onOpen,
}: {
  rec: JobRecord;
  density: HistoryDensity;
  preview?: HistoryPreviewEntry;
  onOpen: () => void;
}) {
  const status = rec.status_cache || "UNKNOWN";
  const reason = summarizeQueueOrFailure(null, rec);
  const previewHeight = density === "compact" ? "aspect-square" : "aspect-[4/5]";

  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="history-card"
      className="group overflow-hidden rounded-[28px] border border-zinc-200/90 bg-white text-left shadow-sm transition hover:-translate-y-1 hover:shadow-xl dark:border-white/10 dark:bg-zinc-950/60"
    >
      <div className="relative">
        <HistoryPreviewTile rec={rec} preview={preview} className={previewHeight} />
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3">
          {rec.batch_name ? (
            <span className="max-w-[72%] truncate rounded-full bg-white/90 px-2.5 py-1 text-[10px] font-semibold text-emerald-700 shadow-sm backdrop-blur dark:bg-zinc-950/80 dark:text-emerald-200">
              {rec.batch_name}
            </span>
          ) : <span />}
          <Badge status={status} />
        </div>
      </div>
      <div className="space-y-2.5 px-3.5 py-3">
        <div className="flex items-center justify-between gap-3 text-[11px] text-zinc-500 dark:text-zinc-400">
          <span className="truncate">{formatLocal(rec.created_at)}</span>
          <span className="truncate font-mono">{shortId(rec.job_id, 6)}</span>
        </div>
        <div className="line-clamp-2 text-sm font-semibold leading-5 text-zinc-900 dark:text-zinc-50">
          {rec.prompt_preview || shortId(rec.job_id)}
        </div>
        <div className="line-clamp-2 min-h-[2rem] text-[11px] leading-5 text-zinc-500 dark:text-zinc-400">
          {reason || (rec.section_title ? `Section · ${rec.section_title}` : `job_id · ${shortId(rec.job_id, 8)}`)}
        </div>
      </div>
    </button>
  );
}

function HistoryPreviewTile({
  rec,
  preview,
  className,
}: {
  rec: JobRecord;
  preview?: HistoryPreviewEntry;
  className?: string;
}) {
  const [imageReady, setImageReady] = useState(false);
  const status = rec.status_cache || "UNKNOWN";
  const src = preview?.src || "";
  const loadFailed = Boolean(preview?.failed);

  useEffect(() => {
    setImageReady(false);
  }, [src]);

  if (status === "SUCCEEDED" && src) {
    return (
      <div className={cn("relative overflow-hidden bg-[linear-gradient(145deg,rgba(250,250,249,0.95),rgba(228,228,231,0.7))] dark:bg-[linear-gradient(145deg,rgba(24,24,27,0.95),rgba(39,39,42,0.75))]", className)}>
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.8),_transparent_55%)] dark:bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.08),_transparent_55%)]" />
        <div className="relative flex h-full items-center justify-center p-4">
          <img
            src={src}
            alt={rec.prompt_preview || rec.job_id}
            className={cn(
              "h-full w-full object-contain transition duration-300",
              imageReady ? "opacity-100" : "opacity-0"
            )}
            onLoad={() => setImageReady(true)}
            onError={() => {
              setLoadFailed(true);
              setSrc("");
            }}
          />
          {!imageReady ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <LoadingSpinner label="Loading preview" tone="brand" />
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("relative flex w-full items-center justify-center overflow-hidden bg-zinc-100 dark:bg-zinc-900", className)}>
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.75),_transparent_55%),linear-gradient(135deg,rgba(24,24,27,0.08),rgba(24,24,27,0.02))] dark:bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.08),_transparent_55%),linear-gradient(135deg,rgba(255,255,255,0.04),rgba(255,255,255,0.01))]" />
      {status === "RUNNING" ? (
        <div className="relative z-10 flex flex-col items-center gap-3 text-sky-700 dark:text-sky-200">
          <LoadingSpinner tone="sky" />
          <div className="text-xs font-semibold">Generating</div>
        </div>
      ) : status === "QUEUED" ? (
        <div className="relative z-10 flex flex-col items-center gap-2 text-amber-700 dark:text-amber-200">
          <div className="rounded-full border border-amber-300 bg-white/70 px-3 py-1 text-lg dark:border-amber-700/60 dark:bg-amber-950/30">Q</div>
          <div className="text-xs font-semibold">Queued</div>
        </div>
      ) : status === "FAILED" ? (
        <div className="relative z-10 flex flex-col items-center gap-2 text-rose-700 dark:text-rose-200">
          <div className="rounded-full border border-rose-300 bg-white/70 px-3 py-1 text-lg dark:border-rose-800/60 dark:bg-rose-950/30">!</div>
          <div className="text-xs font-semibold">Failed</div>
        </div>
      ) : status === "CANCELLED" ? (
        <div className="relative z-10 flex flex-col items-center gap-2 text-orange-700 dark:text-orange-200">
          <div className="rounded-full border border-orange-300 bg-white/70 px-3 py-1 text-lg dark:border-orange-800/60 dark:bg-orange-950/30">×</div>
          <div className="text-xs font-semibold">Cancelled</div>
        </div>
      ) : loadFailed ? (
        <div className="relative z-10 text-xs font-semibold text-zinc-500 dark:text-zinc-400">Preview unavailable</div>
      ) : (
        <div className="relative z-10">
          <LoadingSpinner label={preview?.loading ? "Loading preview" : "Preparing preview"} />
        </div>
      )}
    </div>
  );
}

function HistoryDetailModal({ rec, onClose }: { rec: JobRecord | null; onClose: () => void }) {
  const navigate = useNavigate();

  useEffect(() => {
    if (!rec) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, rec]);

  return (
    <AnimatePresence>
      {rec ? (
        <motion.div
          className="fixed inset-0 z-50"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.button
            type="button"
            aria-label="Close history detail overlay"
            data-testid="history-detail-backdrop"
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />
          <div className="pointer-events-none relative z-10 flex h-full items-start justify-center overflow-y-auto px-4 py-10">
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.98 }}
            transition={{ duration: 0.2 }}
            className="pointer-events-auto w-full max-w-6xl rounded-[32px] border border-white/20 bg-[#f8f6f1] p-5 shadow-2xl dark:border-white/10 dark:bg-zinc-950"
            role="dialog"
            aria-modal="true"
            aria-label="History detail modal"
            onClick={(e) => e.stopPropagation()}
          >
              <div className="mb-4 flex items-center justify-between gap-3 border-b border-zinc-200/80 pb-4 dark:border-white/10">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500 dark:text-zinc-400">Task Detail</div>
                  <div className="mt-1 text-lg font-bold text-zinc-900 dark:text-zinc-50">{rec.prompt_preview || rec.job_id}</div>
              </div>
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
            </div>
            <JobDetail
              rec={rec}
              onNavigateToCreate={() => {
                onClose();
                window.setTimeout(() => navigate("/create"), 0);
              }}
              onUpdateToken={(tok) => useJobsStore.getState().updateJob(rec.job_id, { job_access_token: tok })}
            />
          </motion.div>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function JobDetail({
  rec,
  onUpdateToken,
  onNavigateToCreate,
}: {
  rec: JobRecord;
  onUpdateToken: (tok: string) => void;
  onNavigateToCreate?: () => void;
}) {
  const client = useApiClient();
  const { runWithImageAccessTurnstile } = useImageAccessGuard();
  const { push } = useToast();
  const navigate = useNavigate();
  const settings = useSettingsStore((s) => s.settings);
  const updateJob = useJobsStore((s) => s.updateJob);
  const pickerSessions = usePickerStore((s) => s.sessions);
  const createPickerSession = usePickerStore((s) => s.createSession);
  const addPickerItems = usePickerStore((s) => s.addItems);
  const { user } = useAuthSession();

  const hasToken = Boolean(rec.job_access_token);
  const cacheScope = user?.user_id || "__guest__";

  // live meta
  const { meta, loading, error, refresh } = useJobLive(rec.job_id, rec.job_access_token);

  const status = pickStatus(meta || undefined, rec);

  const [debugOpen, setDebugOpen] = useState(false);
  const [reqSnap, setReqSnap] = useState<any | null>(null);
  const [respSnap, setRespSnap] = useState<any | null>(null);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [fullUrls, setFullUrls] = useState<Record<string, string>>({});
  const [fullBlobs, setFullBlobs] = useState<Record<string, Blob>>({});
  const previewRevokeRef = useRef<string[]>([]);
  const fullRevokeRef = useRef<string[]>([]);
  const refRevokeRef = useRef<string[]>([]);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [imgLoadError, setImgLoadError] = useState<string | null>(null);
  const [refUrls, setRefUrls] = useState<Record<string, string>>({});
  const [thumbLoadedIds, setThumbLoadedIds] = useState<Record<string, boolean>>({});
  const [mainLoadedImageId, setMainLoadedImageId] = useState<string | null>(null);
  const [sessionSearch, setSessionSearch] = useState("");
  const [newSessionName, setNewSessionName] = useState("");
  const [targetSessionId, setTargetSessionId] = useState("");

  const imageIds = useMemo(() => {
    return extractImageIdsFromResult(meta?.result);
  }, [meta?.result]);
  const filteredSessions = useMemo(() => {
    const query = sessionSearch.trim().toLowerCase();
    if (!query) return pickerSessions;
    return pickerSessions.filter((session) => session.name.toLowerCase().includes(query));
  }, [pickerSessions, sessionSearch]);
  const requestPrompt = reqSnap?.request?.prompt || rec.prompt_text || rec.prompt_preview || "";
  const requestRefs = Array.isArray(reqSnap?.request?.reference_images) ? reqSnap.request.reference_images : [];
  const timelineRows = [
    { label: "Created", value: meta?.created_at || rec.created_at },
    { label: "Queued", value: meta?.timing?.queued_at || rec.created_at },
    { label: "Started", value: meta?.timing?.started_at || rec.run_started_at },
    { label: status === "CANCELLED" ? "Cancelled" : "Finished", value: meta?.timing?.finished_at || rec.run_finished_at },
  ].filter((row) => row.value);

  useEffect(() => {
    if (!imageIds.length) {
      setSelectedImageId(null);
      return;
    }
    if (!selectedImageId || !imageIds.includes(selectedImageId)) {
      setSelectedImageId(imageIds[0]);
    }
  }, [imageIds.join("|"), selectedImageId]);

  useEffect(() => {
    setMainLoadedImageId(null);
  }, [selectedImageId]);

  useEffect(() => {
    return () => {
      // cleanup object urls
      previewRevokeRef.current.forEach((u) => URL.revokeObjectURL(u));
      previewRevokeRef.current = [];
      fullRevokeRef.current.forEach((u) => URL.revokeObjectURL(u));
      fullRevokeRef.current = [];
      refRevokeRef.current.forEach((u) => URL.revokeObjectURL(u));
      refRevokeRef.current = [];
    };
  }, []);

  const canRead = settings.jobAuthMode === "ID_ONLY" || hasToken;

  const manualToken = async () => {
    const tok = prompt("输入该 job 的 X-Job-Token（将仅保存在本地）");
    if (!tok) return;
    onUpdateToken(tok);
    push({ kind: "success", title: "已保存 token（本地）" });
  };

  const loadDebug = async (silent = false) => {
    if (!canRead) {
      if (!silent) {
        push({ kind: "error", title: "缺少 token", message: "TOKEN 模式下读取详情必须带 X-Job-Token" });
      }
      return;
    }
    const requestTask = client
      .getJobRequest(rec.job_id, rec.job_access_token)
      .then((payload) => {
        setReqSnap(payload);
        return { ok: true as const };
      })
      .catch((e) => {
        setReqSnap({ __error: e });
        return { ok: false as const, message: e?.error?.message || "request 加载失败" };
      });

    const responseTask = client
      .getJobResponse(rec.job_id, rec.job_access_token)
      .then((payload) => {
        setRespSnap(payload);
        return { ok: true as const };
      })
      .catch((e) => {
        setRespSnap({ __error: e });
        return { ok: false as const, message: e?.error?.message || "response 加载失败" };
      });

    const [requestResult, responseResult] = await Promise.all([requestTask, responseTask]);
    if (silent) return;
    if (requestResult.ok || responseResult.ok) {
      push({ kind: "success", title: "已加载调试信息" });
      return;
    }
    push({
      kind: "error",
      title: "加载失败",
      message: requestResult.message || responseResult.message || "",
    });
  };

  const copyJson = async (obj: any) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(obj, null, 2));
      push({ kind: "success", title: "已复制" });
    } catch {
      push({ kind: "error", title: "复制失败" });
    }
  };

  const downloadImage = async (image_id: string) => {
    try {
      const existing = fullBlobs[image_id];
      const blob =
        existing ||
        (
          await readCachedImageOrFetch({
            scope: cacheScope,
            baseUrl: settings.baseUrl,
            jobId: rec.job_id,
            imageId: image_id,
            variant: "original",
            config: settings.cache,
            fetcher: () => runWithImageAccessTurnstile(() => client.getImageBlob(rec.job_id, image_id, rec.job_access_token)),
          })
        ).blob;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${rec.job_id}_${image_id}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 700);
      push({ kind: "success", title: "已开始下载" });
    } catch (e: any) {
      push({ kind: "error", title: "下载失败", message: e?.error?.message || "" });
    }
  };

  const ensurePreviewImage = async (image_id: string) => {
    if (previewUrls[image_id]) return;
    try {
      const { blob } = await readCachedImageOrFetch({
        scope: cacheScope,
        baseUrl: settings.baseUrl,
        jobId: rec.job_id,
        imageId: image_id,
        variant: "preview",
        config: settings.cache,
        fetcher: () => client.getPreviewBlob(rec.job_id, image_id, rec.job_access_token),
      });
      const url = URL.createObjectURL(blob);
      previewRevokeRef.current.push(url);
      setPreviewUrls((m) => ({ ...m, [image_id]: url }));
    } catch (e: any) {
      setImgLoadError(e?.error?.message || "预览图拉取失败");
    }
  };

  const ensureOriginalImage = async (image_id: string) => {
    if (fullUrls[image_id]) return fullBlobs[image_id] || null;
    try {
      const { blob } = await readCachedImageOrFetch({
        scope: cacheScope,
        baseUrl: settings.baseUrl,
        jobId: rec.job_id,
        imageId: image_id,
        variant: "original",
        config: settings.cache,
        fetcher: () => runWithImageAccessTurnstile(() => client.getImageBlob(rec.job_id, image_id, rec.job_access_token)),
      });
      setFullBlobs((m) => ({ ...m, [image_id]: blob }));
      const url = URL.createObjectURL(blob);
      fullRevokeRef.current.push(url);
      setFullUrls((m) => ({ ...m, [image_id]: url }));
      return blob;
    } catch (e: any) {
      setImgLoadError(e?.error?.message || "原图拉取失败");
      return null;
    }
  };

  const onRetry = async () => {
    if (!canRead) {
      push({ kind: "error", title: "缺少 token", message: "TOKEN 模式下 retry 需要 X-Job-Token" });
      return;
    }
    try {
      const r = await client.retryJob(rec.job_id, rec.job_access_token);
      const newId = r?.new_job_id || r?.job_id;
      const newTok = r?.new_job_access_token || r?.job_access_token;
      if (!newId) throw { error: { message: "后端未返回 new job_id" } };

      useJobsStore.getState().upsertJob({
        job_id: newId,
        job_access_token: newTok,
        model_cache: rec.model_cache || meta?.model,
        created_at: isoNow(),
        status_cache: "QUEUED",
        prompt_preview: rec.prompt_preview,
        prompt_text: rec.prompt_text,
        params_cache: rec.params_cache,
        last_seen_at: isoNow(),
        pinned: false,
        tags: rec.tags || [],
      });
      push({ kind: "success", title: "已创建 retry job", message: shortId(newId) });
      // navigate by updating query param
      const url = new URL(window.location.href);
      url.searchParams.set("job", newId);
      window.history.pushState({}, "", url.toString());
      window.dispatchEvent(new PopStateEvent("popstate"));
    } catch (e: any) {
      push({ kind: "error", title: "Retry 失败", message: e?.error?.message || "" });
    }
  };

  const onDelete = async () => {
    if (status === "RUNNING") {
      if (!canRead) {
        push({ kind: "error", title: "缺少 token", message: "TOKEN 模式下取消运行中任务需要 X-Job-Token" });
        return;
      }
      try {
        await client.cancelJob(rec.job_id, rec.job_access_token);
        updateJob(rec.job_id, {
          status_cache: "CANCELLED",
          error_code_cache: "JOB_CANCELLED",
          error_message_cache: "Job was cancelled by user while running. Any later worker result will be discarded.",
          last_seen_at: isoNow(),
        });
        push({ kind: "success", title: "运行中任务已取消" });
        await refresh();
      } catch (e: any) {
        push({ kind: "error", title: "取消失败", message: e?.error?.message || "" });
      }
      return;
    }

    if (
      !confirm(
        status === "QUEUED"
          ? "删除排队任务？它会从历史和服务端目录中一起移除。"
          : "删除这条历史任务？服务端原图与本地 session 关联条目也会被清理。"
      )
    ) {
      return;
    }

    useJobsStore.getState().removeJob(rec.job_id);
    invalidatePickerEntriesForDeletedJob(rec.job_id);
    push({ kind: "success", title: status === "QUEUED" ? "排队任务已移除" : "历史任务已删除" });

    if (!canRead) {
      push({ kind: "info", title: "仅删除了本地记录", message: "缺少 token，未同步删除服务端文件" });
      return;
    }

    try {
      await client.deleteJob(rec.job_id, rec.job_access_token);
      push({ kind: "success", title: "服务端文件已删除" });
    } catch (e: any) {
      push({ kind: "error", title: "删除服务端失败", message: e?.error?.message || "" });
    }
  };

  const addImagesToSession = (sessionId: string) => {
    if (!sessionId) return;
    if (!imageIds.length) {
      push({ kind: "error", title: "暂无可加入 session 的图片" });
      return;
    }
    addPickerItems(
      sessionId,
      imageIds.map((imageId) => ({
        job_id: rec.job_id,
        job_access_token: rec.job_access_token,
        image_id: imageId,
        status: "SUCCEEDED",
        added_at: isoNow(),
      }))
    );
    push({ kind: "success", title: "已加入 session", message: `${imageIds.length} 张图片` });
  };

  const onCreateSessionAndAdd = () => {
    const sessionId = createPickerSession(newSessionName.trim() || undefined);
    setTargetSessionId(sessionId);
    setNewSessionName("");
    addImagesToSession(sessionId);
  };

  const copyParamsToCreate = async () => {
    const params = meta?.params || rec.params_cache || {};
    saveCreateCloneDraft({
      prompt: requestPrompt,
      model: (meta?.model || rec.model_cache || settings.defaultModel) as ModelId,
      mode: (meta?.mode || "IMAGE_ONLY") as JobMode,
      params: {
        aspect_ratio: params.aspect_ratio,
        image_size: params.image_size,
        thinking_level: params.thinking_level,
        provider_id: params.provider_id,
        temperature: params.temperature,
        timeout_sec: params.timeout_sec,
        max_retries: params.max_retries,
      },
    });
    try {
      await navigator.clipboard.writeText(requestPrompt);
    } catch {
      // ignore clipboard failures
    }
    if (onNavigateToCreate) {
      onNavigateToCreate();
      return;
    }
    navigate("/create");
  };

  useEffect(() => {
    // update status cache on meta change
    if (meta?.status) {
      updateJob(rec.job_id, {
        last_seen_at: isoNow(),
        ...jobMetaCachePatch(meta),
      });
    }
  }, [meta, rec.job_id, updateJob]);

  useEffect(() => {
    if (!canRead) return;
    loadDebug(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRead, rec.job_id, rec.job_access_token]);

  useEffect(() => {
    if (!canRead) return;
    setImgLoadError(null);
    imageIds.slice(0, 12).forEach((id) => ensurePreviewImage(id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRead, imageIds.join("|")]);

  useEffect(() => {
    if (!canRead || !selectedImageId) return;
    ensureOriginalImage(selectedImageId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRead, selectedImageId]);

  useEffect(() => {
    refRevokeRef.current.forEach((u) => URL.revokeObjectURL(u));
    refRevokeRef.current = [];
    setRefUrls({});
    if (!canRead || !requestRefs.length) return;
    const controller = new AbortController();
    requestRefs.forEach((item: any) => {
      const filename = String(item?.filename || "");
      if (!filename) return;
      client
        .getReferenceBlob(rec.job_id, filename, rec.job_access_token, controller.signal)
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          refRevokeRef.current.push(url);
          setRefUrls((current) => ({ ...current, [filename]: url }));
        })
        .catch(() => null);
    });
    return () => controller.abort();
  }, [canRead, client, rec.job_access_token, rec.job_id, requestRefs]);

  const markThumbLoaded = (imageId: string) => {
    setThumbLoadedIds((current) => (current[imageId] ? current : { ...current, [imageId]: true }));
  };

  const activeImageLoaded = selectedImageId ? mainLoadedImageId === selectedImageId : false;
  const resultPreviewCard = (
    <Card hover={false} className="overflow-hidden p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200/80 px-4 py-3 dark:border-white/10">
        <div>
          <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">结果预览</div>
          <div className="text-xs text-zinc-600 dark:text-zinc-300">
            尽量把结果图放在首屏，切图和下载都放在这里。
          </div>
        </div>
        {selectedImageId ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              className="!px-2 !py-1 text-xs"
              onClick={() => navigate(`/picker?job=${encodeURIComponent(rec.job_id)}`)}
            >
              去挑选对比
            </Button>
            <Button
              variant="secondary"
              className="!px-2 !py-1 text-xs"
              onClick={() => downloadImage(selectedImageId)}
            >
              下载选中
            </Button>
            {fullUrls[selectedImageId] || previewUrls[selectedImageId] ? (
              <Button
                variant="ghost"
                className="!px-2 !py-1 text-xs"
                onClick={() => window.open(fullUrls[selectedImageId] || previewUrls[selectedImageId], "_blank")}
              >
                新窗口
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {!canRead ? (
        <div className="px-4 py-4 text-xs text-zinc-500 dark:text-zinc-400">缺少 token，无法拉取图片。</div>
      ) : imageIds.length ? (
        <div className="space-y-4 p-4">
          <div className="overflow-hidden rounded-[24px] border border-zinc-200 bg-zinc-50 dark:border-white/10 dark:bg-zinc-950/30">
            <div className="relative h-[320px] w-full bg-[linear-gradient(145deg,rgba(250,250,249,0.95),rgba(228,228,231,0.6))] sm:h-[420px] lg:h-[520px] dark:bg-[linear-gradient(145deg,rgba(24,24,27,0.95),rgba(39,39,42,0.72))]">
              {selectedImageId && (previewUrls[selectedImageId] || fullUrls[selectedImageId]) ? (
                <>
                  {previewUrls[selectedImageId] ? (
                    <img
                      src={previewUrls[selectedImageId]}
                      alt={`${selectedImageId}-preview`}
                      className="absolute inset-0 h-full w-full object-contain p-4 opacity-100"
                    />
                  ) : null}
                  {fullUrls[selectedImageId] ? (
                    <img
                      src={fullUrls[selectedImageId]}
                      alt={selectedImageId}
                      className={cn(
                        "relative h-full w-full object-contain p-4 transition duration-300",
                        activeImageLoaded ? "opacity-100" : "opacity-0"
                      )}
                      onLoad={() => setMainLoadedImageId(selectedImageId)}
                    />
                  ) : null}
                  {!activeImageLoaded || !fullUrls[selectedImageId] ? (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <LoadingSpinner label={previewUrls[selectedImageId] ? "Loading original" : "Loading preview"} tone="brand" />
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <LoadingSpinner label={selectedImageId ? "Loading image" : "Waiting for result"} tone="brand" />
                </div>
              )}

              {selectedImageId ? (
                <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between gap-2 bg-black/45 p-2 text-[11px] text-white">
                  <span className="truncate">{shortId(selectedImageId, 10)}</span>
                  <button
                    className="rounded-full bg-white/20 px-2 py-1 font-bold hover:bg-white/30"
                    onClick={() => {
                      navigator.clipboard
                        .writeText(selectedImageId)
                        .then(() => push({ kind: "success", title: "已复制 image_id" }))
                        .catch(() => push({ kind: "error", title: "复制失败" }));
                    }}
                  >
                    复制 image_id
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          {imgLoadError ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
              {imgLoadError}
            </div>
          ) : null}

          <div className="flex gap-2 overflow-x-auto pb-1">
            {imageIds.map((id) => {
              const active = id === selectedImageId;
              const u = previewUrls[id];
              const thumbLoaded = Boolean(thumbLoadedIds[id]);
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setSelectedImageId(id);
                    ensurePreviewImage(id);
                  }}
                  className={cn(
                    "relative overflow-hidden rounded-2xl border transition",
                    active
                      ? "border-zinc-900 shadow-sm dark:border-white"
                      : "border-zinc-200 hover:-translate-y-0.5 hover:shadow-sm dark:border-white/10"
                  )}
                  title={id}
                >
                  {u ? (
                    <>
                      <img
                        src={u}
                        alt={id}
                        className={cn(
                          "h-20 w-28 object-cover transition duration-300",
                          thumbLoaded ? "opacity-100" : "opacity-0"
                        )}
                        onLoad={() => markThumbLoaded(id)}
                      />
                      {!thumbLoaded ? (
                        <div className="absolute inset-0 flex items-center justify-center bg-zinc-100/85 dark:bg-zinc-950/80">
                          <LoadingSpinner className="gap-1.5" />
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <div className="flex h-20 w-28 items-center justify-center bg-zinc-100 dark:bg-zinc-900">
                      <LoadingSpinner className="gap-1.5" />
                    </div>
                  )}
                  <div className="absolute bottom-1 left-1 rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-bold text-white">
                    {shortId(id, 6)}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="px-4 py-4 text-xs text-zinc-500 dark:text-zinc-400">
          {status === "SUCCEEDED"
            ? "未检测到图片列表字段（result.images / result.image_ids），请对齐后端返回结构"
            : "尚无输出"}
        </div>
      )}
    </Card>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-bold text-zinc-900 dark:text-zinc-50">{rec.prompt_preview || shortId(rec.job_id)}</div>
          <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">job_id: {shortId(rec.job_id)}</div>
        </div>
        <Badge status={status} />
      </div>

      {!canRead ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          <div className="font-bold">无法读取详情：缺少 X-Job-Token</div>
          <div className="mt-1 text-xs opacity-90">TOKEN 模式下，读取 /retry /delete 需要带 token。</div>
          <div className="mt-2">
            <Button variant="secondary" onClick={manualToken}>
              手动补录 Token
            </Button>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <Card hover={false} className="p-3">
          <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">Created</div>
          <div className="mt-1 text-sm font-bold text-zinc-900 dark:text-zinc-50">{formatLocal(meta?.created_at || rec.created_at)}</div>
        </Card>
        <Card hover={false} className="p-3">
          <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">Updated</div>
          <div className="mt-1 text-sm font-bold text-zinc-900 dark:text-zinc-50">{formatLocal(meta?.updated_at || rec.last_seen_at)}</div>
        </Card>
      </div>

      {resultPreviewCard}

      <Card hover={false} className="p-3">
        <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">Prompt</div>
        <div className="mt-2 whitespace-pre-wrap text-sm leading-6 text-zinc-700 dark:text-zinc-200">{requestPrompt || "-"}</div>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card hover={false} className="p-3">
          <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">Batch Info</div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
            <KeyValue k="batch_name" v={rec.batch_name || "-"} />
            <KeyValue k="batch_index" v={rec.batch_index ?? "-"} />
            <KeyValue k="batch_size" v={rec.batch_size ?? "-"} />
            <KeyValue k="section_index" v={rec.section_index ?? "-"} />
            <KeyValue k="section_title" v={rec.section_title || "-"} />
            <KeyValue k="batch_note" v={rec.batch_note || "-"} />
          </div>
        </Card>

        <Card hover={false} className="p-3">
          <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">Status Timeline</div>
          <div className="mt-2 space-y-2">
            {timelineRows.map((row) => (
              <div key={row.label} className="flex items-center justify-between rounded-2xl border border-zinc-200 bg-white/60 px-3 py-2 text-xs dark:border-white/10 dark:bg-zinc-950/30">
                <span className="font-semibold text-zinc-600 dark:text-zinc-300">{row.label}</span>
                <span className="text-zinc-900 dark:text-zinc-50">{formatLocal(String(row.value))}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card hover={false} className="p-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">参数</div>
          <Button variant="ghost" onClick={refresh} disabled={loading}>
            ⟳ 刷新
          </Button>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
          <KeyValue k="model" v={(meta?.model || rec.model_cache || "-") as any} />
          <KeyValue k="mode" v={(meta?.mode || "-") as any} />
          <KeyValue k="aspect_ratio" v={(meta?.params?.aspect_ratio || rec.params_cache?.aspect_ratio || "-") as any} />
          <KeyValue k="image_size" v={(meta?.params?.image_size || rec.params_cache?.image_size || "-") as any} />
          <KeyValue k="thinking_level" v={(meta?.params?.thinking_level ?? rec.params_cache?.thinking_level ?? "-") as any} />
          <KeyValue k="provider_id" v={(meta?.params?.provider_id ?? rec.params_cache?.provider_id ?? "AUTO") as any} />
          <KeyValue k="temperature" v={(meta?.params?.temperature ?? rec.params_cache?.temperature ?? "-") as any} />
          <KeyValue k="timeout_sec" v={(meta?.params?.timeout_sec ?? rec.params_cache?.timeout_sec ?? "-") as any} />
          <KeyValue k="max_retries" v={(meta?.params?.max_retries ?? rec.params_cache?.max_retries ?? "-") as any} />
          <KeyValue k="run_duration" v={formatDurationMs(extractRunDurationMs(meta, rec))} />
          <KeyValue
            k="queue_wait"
            v={
              typeof (meta?.timing?.queue_wait_ms ?? rec.queue_wait_ms) === "number"
                ? formatDurationMs(meta?.timing?.queue_wait_ms ?? rec.queue_wait_ms)
                : "-"
            }
          />
          <KeyValue k="upstream_latency" v={meta?.response?.latency_ms ? formatDurationMs(meta.response.latency_ms) : "-"} />
        </div>
      </Card>

      <Card hover={false} className="p-3">
        <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">Usage / Billing</div>
        <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
          <KeyValue k="total_token_count" v={numberish(meta?.usage?.total_token_count)} />
          <KeyValue k="estimated_cost_usd" v={currency(meta?.billing?.estimated_cost_usd)} />
          <KeyValue k="input_token_count" v={numberish(meta?.usage?.input_token_count)} />
          <KeyValue k="output_token_count" v={numberish(meta?.usage?.output_token_count)} />
          <KeyValue k="image_output_cost_usd" v={currency(meta?.billing?.image_output_cost_usd)} />
          <KeyValue k="status" v={status} />
        </div>

        {meta?.billing?.breakdown ? (
          <div className="mt-2 rounded-2xl border border-zinc-200 bg-white/50 p-2 text-xs dark:border-white/10 dark:bg-zinc-950/30">
            <div className="mb-1 font-semibold text-zinc-600 dark:text-zinc-300">breakdown</div>
            <div className="space-y-1">
              {Object.entries(meta.billing.breakdown).map(([k, v]) => (
                <div key={k} className="flex items-center justify-between">
                  <span className="text-zinc-600 dark:text-zinc-300">{k}</span>
                  <span className="font-bold text-zinc-900 dark:text-zinc-50">{currency(v)}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </Card>

      {(status === "FAILED" || status === "CANCELLED") ? (
        <Card hover={false} className="p-3">
          <div className={cn("text-sm font-bold", status === "CANCELLED" ? "text-orange-700 dark:text-orange-200" : "text-rose-700 dark:text-rose-200")}>
            {status === "CANCELLED" ? "取消信息" : "失败信息"}
          </div>
          <div className="mt-2 text-xs text-zinc-700 dark:text-zinc-200">
            <div>
              <span className="font-semibold">code：</span>
              {meta?.error?.code || "-"}
            </div>
            <div className="mt-1">
              <span className="font-semibold">type：</span>
              {meta?.error?.type || "-"}
            </div>
            <div className="mt-1">
              <span className="font-semibold">message：</span>
              {meta?.error?.message || "-"}
            </div>
            {meta?.error?.details && Object.keys(meta.error.details).length > 0 ? (
              <div className="mt-1">
                <span className="font-semibold">details：</span>
                <pre className="mt-1 max-h-32 overflow-auto rounded-xl bg-black/90 p-2 text-[11px] text-white">
                  {JSON.stringify(meta.error.details, null, 2)}
                </pre>
              </div>
            ) : null}
            {meta?.error?.debug_id ? (
              <div className="mt-1">
                <span className="font-semibold">debug_id：</span>
                {meta.error.debug_id}
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      <Card hover={false} className="p-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">Reference Images</div>
            <div className="text-xs text-zinc-600 dark:text-zinc-300">按请求顺序展示固定参考图 / 当前任务参考图。</div>
          </div>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">{requestRefs.length} refs</span>
        </div>
        {requestRefs.length ? (
          <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            {requestRefs.map((item: any, idx: number) => {
              const filename = String(item?.filename || "");
              const src = refUrls[filename];
              return (
                <div key={filename || idx} className="overflow-hidden rounded-2xl border border-zinc-200 bg-white/60 dark:border-white/10 dark:bg-zinc-950/30">
                  <div className="relative h-28 w-full bg-zinc-100 dark:bg-zinc-900">
                    {src ? <img src={src} alt={filename} className="h-full w-full object-cover" /> : <Skeleton className="h-full w-full rounded-none" />}
                    <div className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-bold text-white">#{idx + 1}</div>
                  </div>
                  <div className="truncate px-3 py-2 text-[11px] text-zinc-600 dark:text-zinc-300">{filename || `reference_${idx}`}</div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">没有参考图</div>
        )}
      </Card>

      <Card hover={false} className="p-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">Add To Session</div>
            <div className="text-xs text-zinc-600 dark:text-zinc-300">把当前任务输出加入已有 session，或即时创建一个新的 session。</div>
          </div>
          <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={copyParamsToCreate}>
            复制参数并前往快速生成
          </Button>
        </div>
        <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px]">
          <div className="space-y-2">
            <Input value={sessionSearch} onChange={setSessionSearch} placeholder="Search session name" />
            <div className="max-h-40 space-y-2 overflow-auto rounded-2xl border border-zinc-200 bg-white/60 p-2 dark:border-white/10 dark:bg-zinc-950/30">
              {filteredSessions.length ? (
                filteredSessions.map((session) => (
                  <label key={session.session_id} className="flex cursor-pointer items-center gap-2 rounded-xl px-2 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900">
                    <input
                      type="radio"
                      name={`history-session-${rec.job_id}`}
                      checked={targetSessionId === session.session_id}
                      onChange={() => setTargetSessionId(session.session_id)}
                    />
                    <span className="min-w-0 truncate">{session.name}</span>
                  </label>
                ))
              ) : (
                <div className="px-2 py-2 text-xs text-zinc-500 dark:text-zinc-400">没有匹配的 session</div>
              )}
            </div>
          </div>
          <div className="space-y-2">
            <Button variant="secondary" onClick={() => addImagesToSession(targetSessionId)} disabled={!targetSessionId || !imageIds.length}>
              加入选中 Session
            </Button>
            <Input value={newSessionName} onChange={setNewSessionName} placeholder="Create session now" />
            <Button variant="ghost" onClick={onCreateSessionAndAdd} disabled={!imageIds.length}>
              新建 Session 并加入
            </Button>
          </div>
        </div>
      </Card>

      <Card hover={false} className="p-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">任务操作</div>
            <div className="text-xs text-zinc-600 dark:text-zinc-300">
              {status === "RUNNING" ? "Cancel running task" : status === "QUEUED" ? "Delete queued task" : "Retry / Delete history"}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {status !== "RUNNING" ? (
              <Button variant="secondary" onClick={onRetry} disabled={!canRead}>
                Retry
              </Button>
            ) : null}
            <Button variant="danger" onClick={onDelete}>
              {status === "RUNNING" ? "Cancel" : "Delete"}
            </Button>
          </div>
        </div>

        <Divider />

        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">调试面板</div>
            <div className="text-xs text-zinc-600 dark:text-zinc-300">request / response snapshot</div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => setDebugOpen((v) => !v)}>
              {debugOpen ? "收起" : "展开"}
            </Button>
            <Button variant="secondary" onClick={loadDebug} disabled={!canRead}>
              拉取
            </Button>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {debugOpen ? (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.22 }}
              className="mt-3 overflow-hidden"
            >
              <div className="grid grid-cols-1 gap-3">
                <JsonCard title="Request Snapshot" obj={reqSnap} onCopy={() => copyJson(reqSnap)} />
                <JsonCard title="Response Snapshot" obj={respSnap} onCopy={() => copyJson(respSnap)} />
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        {error ? (
          <div className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200">
            {error}
          </div>
        ) : null}
      </Card>
    </div>
  );
}

function JsonCard({ title, obj, onCopy }: { title: string; obj: any; onCopy: () => void }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white/60 p-3 dark:border-white/10 dark:bg-zinc-950/30">
      <div className="flex items-center justify-between">
        <div className="text-xs font-bold text-zinc-900 dark:text-zinc-50">{title}</div>
        <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={onCopy}>
          复制 JSON
        </Button>
      </div>
      <pre className="mt-2 max-h-56 overflow-auto rounded-xl bg-black/90 p-2 text-[11px] text-white">
        {obj ? JSON.stringify(obj, null, 2) : "(empty)"}
      </pre>
    </div>
  );
}

type PickerImageState = {
  loading?: boolean;
  url?: string;
  error?: string;
  code?: string;
};

function usePickerPreviewState(items: PickerSessionItem[]) {
  const client = useApiClient();
  const settings = useSettingsStore((s) => s.settings);
  const { user } = useAuthSession();
  const scope = user?.user_id || "__guest__";
  const [imageState, setImageState] = useState<Record<string, PickerImageState>>({});
  const itemsKey = useMemo(
    () =>
      items
        .map((item) => `${pickerItemKey(item)}:${item.status || "UNKNOWN"}:${item.job_access_token || ""}`)
        .join("|"),
    [items]
  );
  const imageItems = useMemo(
    () => items.filter((item) => pickerItemHasImage(item) && pickerBucketOf(item) !== "DELETED"),
    [items]
  );

  useEffect(() => {
    let stopped = false;
    const controller = new AbortController();
    const nextInitial: Record<string, PickerImageState> = {};
    imageItems.forEach((item) => {
      const key = pickerItemKey(item);
      const shared = sharedPreviewGet(scope, settings.baseUrl, item.job_id, item.image_id);
      if (shared?.url) {
        nextInitial[key] = { loading: false, url: shared.url };
      } else if (settings.jobAuthMode === "TOKEN" && !item.job_access_token) {
        nextInitial[key] = { loading: false, code: "TOKEN_REQUIRED", error: "缺少 token" };
      } else {
        nextInitial[key] = { loading: true };
      }
    });
    setImageState(nextInitial);

    if (!imageItems.length) return () => controller.abort();

    (async () => {
      const misses: Array<{ item: PickerSessionItem; key: string }> = [];
      const cachedState: Record<string, PickerImageState> = {};
      for (const item of imageItems) {
        const key = pickerItemKey(item);
        const shared = sharedPreviewGet(scope, settings.baseUrl, item.job_id, item.image_id);
        if (shared?.url) {
          cachedState[key] = { loading: false, url: shared.url };
          continue;
        }
        if (settings.jobAuthMode === "TOKEN" && !item.job_access_token) continue;
        const cached = settings.cache.enabled
          ? await imageCacheGet(scope, settings.baseUrl, item.job_id, item.image_id, "preview")
          : null;
        if (stopped) return;
        if (cached) {
          cachedState[key] = {
            loading: false,
            url: sharedPreviewRemember(scope, settings.baseUrl, item.job_id, item.image_id, cached),
          };
        } else {
          misses.push({ item, key });
        }
      }

      if (!stopped && Object.keys(cachedState).length) {
        setImageState((current) => ({ ...current, ...cachedState }));
      }
      if (!misses.length) return;

      const chunks: Array<Array<{ item: PickerSessionItem; key: string }>> = [];
      for (let idx = 0; idx < misses.length; idx += 72) {
        chunks.push(misses.slice(idx, idx + 72));
      }

      for (const chunk of chunks) {
        try {
          const payload = await client.batchPreviewImages(
            chunk.map(({ item }) => ({
              job_id: item.job_id,
              image_id: item.image_id!,
              job_access_token: item.job_access_token,
            })),
            controller.signal
          );
          if (stopped) return;
          const byComposite = new Map(payload.items.map((entry) => [`${entry.job_id}::${entry.image_id}`, entry]));
          const chunkState: Record<string, PickerImageState> = {};

          await Promise.all(
            chunk.map(async ({ item, key }) => {
              const entry = byComposite.get(`${item.job_id}::${item.image_id}`);
              if (!entry) return;
              const blob = base64ToBlob(entry.data_base64, entry.mime);
              if (settings.cache.enabled) {
                await imageCachePut(scope, settings.baseUrl, item.job_id, item.image_id!, "preview", blob, settings.cache);
              }
              chunkState[key] = {
                loading: false,
                url: sharedPreviewRemember(scope, settings.baseUrl, item.job_id, item.image_id!, blob),
              };
            })
          );

          const unresolved = chunk.filter(({ key }) => !chunkState[key]);
          if (unresolved.length) {
            await mapLimit(unresolved, 4, async ({ item, key }) => {
              try {
                const blob = await client.getPreviewBlob(item.job_id, item.image_id!, item.job_access_token, controller.signal);
                if (settings.cache.enabled) {
                  await imageCachePut(scope, settings.baseUrl, item.job_id, item.image_id!, "preview", blob, settings.cache);
                }
                chunkState[key] = {
                  loading: false,
                  url: sharedPreviewRemember(scope, settings.baseUrl, item.job_id, item.image_id!, blob),
                };
              } catch (error: any) {
                chunkState[key] = {
                  loading: false,
                  code: String(error?.error?.code || "ERROR"),
                  error: error?.error?.message || "预览图加载失败",
                };
              }
              return null;
            });
          }

          if (!stopped) {
            setImageState((current) => ({ ...current, ...chunkState }));
          }
        } catch {
          if (stopped) return;
          const fallbackState: Record<string, PickerImageState> = {};
          await mapLimit(chunk, 4, async ({ item, key }) => {
            try {
              const blob = await client.getPreviewBlob(item.job_id, item.image_id!, item.job_access_token, controller.signal);
              if (settings.cache.enabled) {
                await imageCachePut(scope, settings.baseUrl, item.job_id, item.image_id!, "preview", blob, settings.cache);
              }
              fallbackState[key] = {
                loading: false,
                url: sharedPreviewRemember(scope, settings.baseUrl, item.job_id, item.image_id!, blob),
              };
            } catch (error: any) {
              fallbackState[key] = {
                loading: false,
                code: String(error?.error?.code || "ERROR"),
                error: error?.error?.message || "预览图加载失败",
              };
            }
            return null;
          });
          if (!stopped) {
            setImageState((current) => ({ ...current, ...fallbackState }));
          }
        }
      }
    })();

    return () => {
      stopped = true;
      controller.abort();
    };
  }, [client, imageItems, itemsKey, scope, settings.baseUrl, settings.cache, settings.jobAuthMode]);

  return imageState;
}

function RatingStars({
  value,
  onChange,
  className,
}: {
  value?: number;
  onChange: (next: number) => void;
  className?: string;
}) {
  const v = clamp(Math.round(value || 0), 0, 5);
  return (
    <div className={cn("inline-flex items-center gap-1", className)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          className={cn(
            "text-sm transition",
            n <= v ? "text-amber-500" : "text-zinc-300 hover:text-zinc-400 dark:text-zinc-600 dark:hover:text-zinc-500"
          )}
          onClick={() => onChange(n)}
          title={`评分 ${n}`}
        >
          ★
        </button>
      ))}
    </div>
  );
}

function BestCrownBadge({ active }: { active: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-bold",
        active
          ? "border-amber-300 bg-amber-500/15 text-amber-700 dark:border-amber-700 dark:text-amber-200"
          : "border-zinc-200 text-zinc-500 dark:border-white/10 dark:text-zinc-400"
      )}
    >
      {active ? "优选池中" : "移入优选"}
    </span>
  );
}

function LoadingRing({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block h-4 w-4 animate-spin rounded-full border-2 border-zinc-300/60 border-t-zinc-900 dark:border-white/20 dark:border-t-white",
        className
      )}
    />
  );
}

function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

function PickerPendingVisual({ status }: { status: JobStatus }) {
  const failed = status === "FAILED";
  const waitingResult = status === "SUCCEEDED";
  const title = failed ? "生成失败" : waitingResult ? "生成完成，正在同步结果" : "图像生成中";
  const desc = failed ? "保留该条目，便于后续排查或移除。" : waitingResult ? "正在写入 session 图片清单。" : "任务已进入 session，图片返回后会自动补全。";

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center">
      {failed ? (
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-rose-300 bg-rose-50 text-sm font-bold text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200">
          !
        </span>
      ) : (
        <LoadingRing className="h-5 w-5" />
      )}
      <div className={cn("text-sm font-semibold", failed ? "text-rose-700 dark:text-rose-200" : "text-zinc-700 dark:text-zinc-100")}>
        {title}
      </div>
      <div className="max-w-[240px] text-[11px] leading-5 text-zinc-500 dark:text-zinc-400">{desc}</div>
    </div>
  );
}

function PickerCompareSlot({
  slotLabel,
  item,
  image,
  compareMode,
  isBest,
  focused,
  showInfo,
  showGrid,
  darkStage,
  jobRec,
  displayName,
  onFocus,
  onEnsureImage,
  onBest,
  onRate,
  onRemove,
  onFixToken,
}: {
  slotLabel: string;
  item: PickerSessionItem | null;
  image?: PickerImageState;
  compareMode: PickerCompareMode;
  isBest: boolean;
  focused: boolean;
  showInfo: boolean;
  showGrid: boolean;
  darkStage: boolean;
  jobRec?: JobRecord;
  displayName: string;
  onFocus: () => void;
  onEnsureImage: () => void;
  onBest: () => void;
  onRate: (n: number) => void;
  onRemove: () => void;
  onFixToken: () => void;
}) {
  useEffect(() => {
    if (item && pickerItemHasImage(item)) onEnsureImage();
  }, [item?.job_id, item?.image_id]);

  const locked = image?.code === "TOKEN_REQUIRED";
  const notFound = image?.code === "404";
  const hasImage = pickerItemHasImage(item);
  const status = item ? pickerItemJobStatus(item, jobRec) : "UNKNOWN";
  const mediaHeightClass =
    compareMode === "FOUR"
      ? "h-[210px] sm:h-[220px] md:h-[240px] xl:h-[255px] 2xl:h-[280px]"
      : compareMode === "TWO"
        ? "h-[360px] sm:h-[420px] md:h-[500px] xl:h-[560px]"
        : "h-[320px] sm:h-[380px] md:h-[430px] xl:h-[500px]";

  return (
    <motion.div
      layout
      className={cn(
        "relative overflow-hidden rounded-2xl border",
        focused ? "border-zinc-900 shadow-lg dark:border-white" : "border-zinc-200 dark:border-white/10",
        darkStage ? "bg-zinc-950" : "bg-zinc-50"
      )}
    >
      <button
        type="button"
        className="absolute inset-0 z-0"
        onClick={onFocus}
        title="聚焦该图片"
        data-testid={`picker-focus-${slotLabel}`}
      />
      <div className={cn("relative w-full", mediaHeightClass)}>
        {!item ? (
          <div className="flex h-full items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">空槽位 {slotLabel}</div>
        ) : !hasImage ? (
          <PickerPendingVisual status={status} />
        ) : image?.url ? (
          <img
            src={image.url}
            alt={`${item.job_id}-${item.image_id}`}
            className="h-full w-full object-contain opacity-0 blur-sm transition duration-300"
            onLoad={(e) => {
              const el = e.currentTarget;
              el.classList.remove("opacity-0", "blur-sm");
              el.classList.add("opacity-100");
            }}
          />
        ) : (
          <div className="h-full w-full">
            <Skeleton className="h-full w-full" />
          </div>
        )}

        {locked ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/65 p-4">
            <div className="max-w-[90%] rounded-2xl border border-amber-300/50 bg-amber-50/95 p-3 text-center text-xs text-amber-900">
              <div className="font-bold">缺少 X-Job-Token</div>
              <div className="mt-1">TOKEN 模式下无法拉取图片。</div>
              <div className="mt-2">
                <Button variant="secondary" className="!px-2 !py-1 text-xs" onClick={onFixToken}>
                  补录 token
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {notFound ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 p-4">
            <div className="rounded-2xl border border-rose-300/50 bg-rose-50/95 px-3 py-2 text-xs font-bold text-rose-800">
              资源不存在（404）
            </div>
          </div>
        ) : null}

        {showGrid ? (
          <div
            className="pointer-events-none absolute inset-0 z-[11] opacity-20"
            style={{
              backgroundImage:
                "linear-gradient(to right, rgba(255,255,255,0.55) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.55) 1px, transparent 1px)",
              backgroundSize: "24px 24px",
            }}
          />
        ) : null}

        <div className="absolute left-2 top-2 z-20 flex items-center gap-2">
          <span className="rounded-full bg-black/55 px-2 py-1 text-[11px] font-bold text-white">{slotLabel}</span>
          <button data-testid={`picker-best-${slotLabel}`} type="button" onClick={onBest} disabled={!hasImage}>
            <span className="sr-only">{`toggle-best-${slotLabel}`}</span>
            <BestCrownBadge active={isBest} />
          </button>
        </div>

        <div className="absolute right-2 top-2 z-20 flex items-center gap-1">
          {item ? (
            <Button testId={`picker-remove-${slotLabel}`} variant="secondary" className="!px-2 !py-1 text-xs" onClick={onRemove}>
              删除
            </Button>
          ) : null}
        </div>
      </div>

      {item ? (
          <div className="relative z-20 border-t border-black/5 bg-white/80 p-2 dark:border-white/10 dark:bg-zinc-900/70">
          <div className="flex items-center justify-between gap-2">
            <div data-testid={`picker-name-${slotLabel}`} className="truncate text-xs font-semibold text-zinc-700 dark:text-zinc-200">
              {displayName}
            </div>
            {hasImage ? (
              <RatingStars value={item.rating || 0} onChange={onRate} />
            ) : (
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-bold",
                  status === "FAILED"
                    ? "bg-rose-500/15 text-rose-700 dark:text-rose-200"
                    : "bg-sky-500/15 text-sky-700 dark:text-sky-200"
                )}
              >
                {status}
              </span>
            )}
          </div>
          {showInfo ? (
            <div className="mt-1 grid grid-cols-2 gap-1 text-[11px] text-zinc-500 dark:text-zinc-400">
              <div className="truncate">job: {shortId(item.job_id, 6)}</div>
              <div className="truncate">model: {jobRec?.model_cache || "-"}</div>
              <div>size: {jobRec?.params_cache?.image_size || "-"}</div>
              <div>ratio: {jobRec?.params_cache?.aspect_ratio || "-"}</div>
            </div>
          ) : null}
          {image?.error && image.code !== "TOKEN_REQUIRED" && image.code !== "404" ? (
            <div className="mt-1 text-[11px] text-rose-600 dark:text-rose-300">{image.error}</div>
          ) : null}
        </div>
      ) : null}
    </motion.div>
  );
}

// -----------------------------
// Picker Page
// -----------------------------

function PickerPage() {
  const { push } = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const client = useApiClient();
  const { runWithImageAccessTurnstile } = useImageAccessGuard();
  const settings = useSettingsStore((s) => s.settings);
  const jobs = useJobsStore((s) => s.jobs);
  const updateJob = useJobsStore((s) => s.updateJob);

  const sessions = usePickerStore((s) => s.sessions);
  const currentSessionId = usePickerStore((s) => s.currentSessionId);
  const setCurrentSession = usePickerStore((s) => s.setCurrentSession);
  const createSession = usePickerStore((s) => s.createSession);
  const renameSession = usePickerStore((s) => s.renameSession);
  const deleteSession = usePickerStore((s) => s.deleteSession);
  const patchSession = usePickerStore((s) => s.patchSession);
  const addItems = usePickerStore((s) => s.addItems);
  const updateItem = usePickerStore((s) => s.updateItem);
  const removeItem = usePickerStore((s) => s.removeItem);
  const setFocus = usePickerStore((s) => s.setFocus);

  const [importOpen, setImportOpen] = useState(false);
  const [immersiveMode, setImmersiveMode] = useState(false);
  const [importFilter, setImportFilter] = useState("");
  const [quickJobId, setQuickJobId] = useState(searchParams.get("job") || "");
  const [importState, setImportState] = useState<Record<string, { loading: boolean; imageIds: string[]; error?: string }>>({});
  const [importSelection, setImportSelection] = useState<Record<string, boolean>>({});
  const [manualTokenByJob, setManualTokenByJob] = useState<Record<string, string>>({});
  const [sidebarPinned, setSidebarPinned] = useState(() => {
    const saved = safeJsonParse<{ pinned?: boolean } | null>(storageGet(KEY_PICKER_SIDEBAR_PREF), null);
    return saved?.pinned ?? false;
  });
  const [sidebarHoverOpen, setSidebarHoverOpen] = useState(false);
  const [showArchivedSessions, setShowArchivedSessions] = useState(false);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [pendingPoolCenterKey, setPendingPoolCenterKey] = useState<string | null>(null);
  const [sessionMenuId, setSessionMenuId] = useState<string | null>(null);
  const [newSessionDraft, setNewSessionDraft] = useState("");
  const [visibleSessionCount, setVisibleSessionCount] = useState(16);
  const [importPage, setImportPage] = useState(1);
  const [importGroupCollapsed, setImportGroupCollapsed] = useState<Record<string, boolean>>({});
  const autoImportedRef = useRef<Record<string, boolean>>({});
  const previousSessionIdRef = useRef<string | null>(null);
  const previousSessionItemsRef = useRef<Map<string, PickerSessionItem>>(new Map());
  const immersiveRevealTimeoutsRef = useRef<Record<string, number>>({});
  const filmstripScrollRef = useRef<HTMLDivElement | null>(null);
  const preferredScrollRef = useRef<HTMLDivElement | null>(null);
  const filmstripItemRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const preferredItemRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const currentSession = useMemo(
    () => sessions.find((s) => s.session_id === currentSessionId) || null,
    [sessions, currentSessionId]
  );
  const sessionQuery = searchParams.get("session") || "";
  const jobQuery = searchParams.get("job") || "";
  const syncSessionParam = (sessionId: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (sessionId) {
      next.set("session", sessionId);
    } else {
      next.delete("session");
    }
    setSearchParams(next, { replace: true });
  };
  const setCurrentSessionAndUrl = (sessionId: string) => {
    setCurrentSession(sessionId);
    syncSessionParam(sessionId);
  };

  useEffect(() => {
    if (sessions.length) return;
    const id = createSession("默认挑选会话");
    syncSessionParam(id);
  }, [sessions.length, createSession, searchParams, setSearchParams]);

  useEffect(() => {
    if (immersiveMode) {
      document.body.classList.add("overflow-hidden");
      setImportOpen(false);
    } else {
      document.body.classList.remove("overflow-hidden");
    }
    return () => {
      document.body.classList.remove("overflow-hidden");
    };
  }, [immersiveMode]);

  useEffect(() => {
    storageSet(KEY_PICKER_SIDEBAR_PREF, JSON.stringify({ pinned: sidebarPinned }));
  }, [sidebarPinned]);

  useEffect(() => {
    const sid = sessionQuery;
    if (!sid) return;
    if (sid === currentSessionId) return;
    if (sessions.some((s) => s.session_id === sid)) {
      setCurrentSession(sid);
    }
  }, [sessionQuery, sessions, currentSessionId, setCurrentSession]);

  useEffect(() => {
    if (!currentSessionId) return;
    if (!sessionQuery || !sessions.some((s) => s.session_id === sessionQuery)) {
      syncSessionParam(currentSessionId);
    }
  }, [currentSessionId, sessionQuery, sessions, searchParams, setSearchParams]);

  const jobsById = useMemo(() => {
    const m = new Map<string, JobRecord>();
    jobs.forEach((j) => m.set(j.job_id, j));
    return m;
  }, [jobs]);

  const filteredJobs = useMemo(() => {
    const q = importFilter.trim().toLowerCase();
    const base = [...jobs].filter((j) => !j.deleted);
    if (!q) return base;
    return base
      .filter((j) => `${j.job_id} ${j.prompt_preview || ""} ${(j.tags || []).join(" ")}`.toLowerCase().includes(q))
      .slice(0, 400);
  }, [jobs, importFilter]);
  const activeSessions = useMemo(() => sessions.filter((session) => !session.archived), [sessions]);
  const archivedSessions = useMemo(() => sessions.filter((session) => session.archived), [sessions]);
  const sidebarSessions = showArchivedSessions ? archivedSessions : activeSessions;
  const visibleSidebarSessions = useMemo(
    () => sidebarSessions.slice(0, visibleSessionCount),
    [sidebarSessions, visibleSessionCount]
  );
  const sidebarOpen = sidebarPinned || sidebarHoverOpen;

  const importGroups = useMemo(() => {
    const grouped = new Map<
      string,
      {
        key: string;
        label: string;
        hint: string;
        jobs: JobRecord[];
        collapsible: boolean;
      }
    >();

    filteredJobs.forEach((job) => {
      const isBatch = Boolean(job.batch_id && (job.batch_size || 0) > 1);
      const key = isBatch ? `batch:${job.batch_id}` : `job:${job.job_id}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.jobs.push(job);
        return;
      }
      grouped.set(key, {
        key,
        label: isBatch ? (job.batch_name ? `批次 · ${job.batch_name}` : `批次 · ${shortId(job.batch_id || job.job_id, 6)}`) : (job.prompt_preview || shortId(job.job_id, 6)),
        hint: isBatch
          ? `${job.batch_size || 0} 个 job${job.section_title ? ` · ${job.section_title}` : ""}`
          : `${shortId(job.job_id)} · ${job.status_cache || "UNKNOWN"}`,
        jobs: [job],
        collapsible: isBatch,
      });
    });

    return Array.from(grouped.values())
      .map((group) => ({
        ...group,
        jobs: group.jobs.sort((a, b) => (new Date(b.created_at).getTime() || 0) - (new Date(a.created_at).getTime() || 0)),
      }))
      .sort((a, b) => {
        const latestA = Math.max(...a.jobs.map((job) => new Date(job.created_at).getTime() || 0));
        const latestB = Math.max(...b.jobs.map((job) => new Date(job.created_at).getTime() || 0));
        return latestB - latestA;
      });
  }, [filteredJobs]);
  const importGroupPageSize = 10;
  const importTotalPages = Math.max(1, Math.ceil(importGroups.length / importGroupPageSize));
  const safeImportPage = clamp(importPage, 1, importTotalPages);
  const pagedImportGroups = useMemo(
    () => importGroups.slice((safeImportPage - 1) * importGroupPageSize, safeImportPage * importGroupPageSize),
    [importGroups, safeImportPage]
  );

  useEffect(() => {
    setVisibleSessionCount(16);
  }, [showArchivedSessions, sidebarSessions.length]);

  useEffect(() => {
    if (importPage !== safeImportPage) setImportPage(safeImportPage);
  }, [importPage, safeImportPage]);

  useEffect(() => {
    setImportPage(1);
  }, [importFilter, importGroups.length]);

  useEffect(() => {
    setImportGroupCollapsed((current) => {
      const next = { ...current };
      importGroups.forEach((group) => {
        if (next[group.key] === undefined) {
          next[group.key] = group.collapsible;
        }
      });
      return next;
    });
  }, [importGroups]);

  const loadJobImages = async (job_id: string, tokenOverride?: string) => {
    const rec = jobsById.get(job_id);
    const token = tokenOverride || manualTokenByJob[job_id] || rec?.job_access_token;
    if (settings.jobAuthMode === "TOKEN" && !token) {
      setImportState((m) => ({ ...m, [job_id]: { loading: false, imageIds: [], error: "缺少 token，无法读取该任务图片列表" } }));
      return { imageIds: [] as string[], token: "" };
    }

    setImportState((m) => ({ ...m, [job_id]: { loading: true, imageIds: [] } }));
    try {
      const meta = await client.getJob(job_id, token || undefined);
      const imageIds = extractImageIdsFromResult(meta?.result);
      setImportState((m) => ({
        ...m,
        [job_id]: {
          loading: false,
          imageIds,
          error: imageIds.length ? undefined : "结果中未检测到图片列表字段",
        },
      }));
      if (imageIds.length) {
        setImportSelection((prev) => {
          const next = { ...prev };
          imageIds.forEach((id) => {
            next[pickerItemKeyFrom(job_id, id)] = true;
          });
          return next;
        });
      }
      updateJob(job_id, {
        status_cache: (meta.status || rec?.status_cache || "UNKNOWN") as JobStatus,
        model_cache: (meta.model as ModelId) || rec?.model_cache,
        last_seen_at: isoNow(),
        ...jobTimingPatch(meta),
      });
      return { imageIds, token: token || "" };
    } catch (e: any) {
      const msg = e?.error?.message || "读取失败";
      setImportState((m) => ({ ...m, [job_id]: { loading: false, imageIds: [], error: msg } }));
      return { imageIds: [] as string[], token: token || "" };
    }
  };

  const importAllFromJob = async (job_id: string, silent = false, tokenOverride?: string) => {
    if (!currentSession) return;
    const loaded = await loadJobImages(job_id, tokenOverride);
    if (!loaded.imageIds.length) {
      if (!silent) push({ kind: "error", title: "导入失败", message: importState[job_id]?.error || "无可导入图片" });
      return;
    }
    addItems(
      currentSession.session_id,
      loaded.imageIds.map((image_id) => ({
        job_id,
        image_id,
        job_access_token: loaded.token || jobsById.get(job_id)?.job_access_token,
        picked: true,
        status: "SUCCEEDED" as JobStatus,
        added_at: isoNow(),
      }))
    );
    if (!silent) push({ kind: "success", title: "已导入", message: `${loaded.imageIds.length} 张图片` });
  };

  const createSessionFromSidebar = () => {
    const id = createSession(newSessionDraft.trim() || undefined);
    setNewSessionDraft("");
    syncSessionParam(id);
    push({ kind: "success", title: "已创建会话" });
    setShowArchivedSessions(false);
  };

  const archiveSession = (sessionId: string, archived: boolean) => {
    patchSession(sessionId, (session) => ({ ...session, archived }));
    if (archived && currentSessionId === sessionId) {
      const nextActive = sessions.find((session) => session.session_id !== sessionId && !session.archived);
      if (nextActive) {
        setCurrentSessionAndUrl(nextActive.session_id);
      }
    }
    setSessionMenuId(null);
  };

  const pinSession = (sessionId: string, pinned: boolean) => {
    patchSession(sessionId, (session) => ({ ...session, pinned }));
    setSessionMenuId(null);
  };

  const renameSessionFromSidebar = (session: PickerSession) => {
    const nextName = prompt("重命名会话：", session.name);
    if (!nextName) return;
    renameSession(session.session_id, nextName);
    setSessionMenuId(null);
  };

  const deleteSessionFromSidebar = (session: PickerSession) => {
    if (!confirm(`删除会话「${session.name}」？`)) return;
    const nextSessionId = sessions.find((item) => item.session_id !== session.session_id && !item.archived)?.session_id
      || sessions.find((item) => item.session_id !== session.session_id)?.session_id
      || null;
    deleteSession(session.session_id);
    syncSessionParam(nextSessionId);
    setSessionMenuId(null);
  };

  const importAllFromGroup = async (group: { jobs: JobRecord[]; label: string }) => {
    if (!currentSession) return;
    let importedJobs = 0;
    for (const job of group.jobs) {
      await importAllFromJob(job.job_id, true);
      importedJobs += 1;
    }
    push({ kind: "success", title: "已批量导入", message: `${group.label} · ${importedJobs} 个 job` });
  };

  useEffect(() => {
    const jobId = jobQuery;
    if (!jobId || !currentSession) return;
    const key = `${currentSession.session_id}:${jobId}`;
    if (autoImportedRef.current[key]) return;
    autoImportedRef.current[key] = true;
    importAllFromJob(jobId, true).then(() => {
      push({ kind: "info", title: "已从 URL 自动导入 job", message: shortId(jobId) });
    });
  }, [jobQuery, currentSession?.session_id]);

  const sessionItems = currentSession?.items || [];
  const imageState = usePickerPreviewState(sessionItems);
  const filmstripItems = useMemo(
    () => sessionItems.filter((it) => pickerBucketOf(it) === "FILMSTRIP"),
    [sessionItems]
  );
  const preferredItems = useMemo(
    () => sessionItems.filter((it) => pickerBucketOf(it) === "PREFERRED"),
    [sessionItems]
  );
  const orderedItemsByPool = useMemo(
    () => [...filmstripItems, ...preferredItems],
    [filmstripItems, preferredItems]
  );
  const itemMap = useMemo(() => {
    const map = new Map<string, PickerSessionItem>();
    sessionItems.forEach((it) => map.set(pickerItemKey(it), it));
    return map;
  }, [sessionItems]);

  const normalizedSlots = useMemo(() => (currentSession ? pickerValidSlots(currentSession) : [null, null, null, null]), [currentSession]);

  const focusKey = useMemo(() => {
    if (!currentSession) return null;
    if (currentSession.focus_key && itemMap.has(currentSession.focus_key)) return currentSession.focus_key;
    return normalizedSlots.find(Boolean) || (orderedItemsByPool[0] ? pickerItemKey(orderedItemsByPool[0]) : null);
  }, [currentSession, itemMap, normalizedSlots, orderedItemsByPool]);

  useEffect(() => {
    if (!currentSession || !focusKey) return;
    if (currentSession.focus_key === focusKey) return;
    setFocus(currentSession.session_id, focusKey);
  }, [currentSession?.session_id, currentSession?.focus_key, focusKey, setFocus]);

  const compareMode = currentSession?.compare_mode || "FOUR";
  const stageSlotCount = pickerCompareModeSlotCount(compareMode);
  const stageSlots = normalizedSlots.slice(0, stageSlotCount);
  const isPreferredKey = (key?: string | null) => Boolean(key && pickerBucketOf(itemMap.get(key) || null) === "PREFERRED");

  const fixToken = (item: PickerSessionItem) => {
    const tok = prompt(`为 job ${shortId(item.job_id)} 输入 X-Job-Token：`);
    if (!tok || !currentSession) return;
    updateItem(currentSession.session_id, pickerItemKey(item), { job_access_token: tok });
    updateJob(item.job_id, { job_access_token: tok });
    setManualTokenByJob((m) => ({ ...m, [item.job_id]: tok }));
    push({ kind: "success", title: "已保存 token" });
  };

  const rateItem = (key: string, rating: number) => {
    if (!currentSession) return;
    patchSession(currentSession.session_id, (session) => pickerApplyRating(session, key, rating));
  };

  const toggleBest = (key: string) => {
    if (!currentSession) return;
    const currentItem = itemMap.get(key);
    if (!currentItem || !pickerItemHasImage(currentItem)) return;
    patchSession(currentSession.session_id, (session) =>
      pickerApplyHardAction({
        session,
        key,
        action: pickerBucketOf(currentItem) === "PREFERRED" ? "toFilmstrip" : "toPreferred",
        compareMode,
        schedulerSettings: settings.pickerScheduler,
      })
    );
  };

  const deleteFromPicker = (key: string) => {
    if (!currentSession) return;
    patchSession(currentSession.session_id, (session) =>
      pickerApplyHardAction({
        session,
        key,
        action: "delete",
        compareMode,
        schedulerSettings: settings.pickerScheduler,
      })
    );
  };

  const shiftToNextBatch = () => {
    if (!currentSession) return;
    if (!pickerVisibleCandidateItems(sessionItems).length) {
      push({ kind: "info", title: "暂无可切换图片" });
      return;
    }
    patchSession(currentSession.session_id, (session) => {
      const next = pickerScheduleSession({
        session,
        compareMode,
        schedulerSettings: settings.pickerScheduler,
        reason: "next",
      });
      return {
        ...next,
        focus_key: next.slots.find(Boolean) || null,
      };
    });
  };

  const setSessionMode = (mode: PickerCompareMode) => {
    if (!currentSession) return;
    patchSession(currentSession.session_id, (session) =>
      pickerScheduleSession({
        session: { ...session, compare_mode: mode },
        compareMode: mode,
        schedulerSettings: settings.pickerScheduler,
        reason: "layout",
        preserveKeys: pickerLayoutPreserveKeys(session, mode),
      })
    );
  };

  const patchSessionUi = (patch: Partial<PickerSession["ui"]>) => {
    if (!currentSession) return;
    patchSession(currentSession.session_id, (s) => ({ ...s, ui: { ...s.ui, ...patch } }));
  };

  const patchSessionLayout = (layout: PickerLayoutPreset) => {
    if (!currentSession) return;
    patchSession(currentSession.session_id, (s) => ({ ...s, layout_preset: layout }));
  };

  const activatePickerItem = (key: string) => {
    if (!currentSession) return;
    patchSession(currentSession.session_id, (session) => pickerRevealKeyInStage({ session, key, compareMode }));
  };

  const setPoolItemRef = (bucket: "FILMSTRIP" | "PREFERRED", key: string, node: HTMLDivElement | null) => {
    const target = bucket === "FILMSTRIP" ? filmstripItemRefs.current : preferredItemRefs.current;
    if (node) {
      target[key] = node;
      return;
    }
    delete target[key];
  };

  const centerPoolCard = (key: string) => {
    const bucket = pickerBucketOf(itemMap.get(key) || null);
    const containerTestId = bucket === "PREFERRED" ? "picker-preferred-scroll" : bucket === "FILMSTRIP" ? "picker-filmstrip-scroll" : "";
    const refContainer = bucket === "PREFERRED" ? preferredScrollRef.current : bucket === "FILMSTRIP" ? filmstripScrollRef.current : null;
    const domContainer = typeof document !== "undefined"
      ? document.querySelector<HTMLDivElement>(`[data-testid="${containerTestId}"]`)
      : null;
    const container = refContainer || domContainer;
    const refCard = bucket === "PREFERRED" ? preferredItemRefs.current[key] : bucket === "FILMSTRIP" ? filmstripItemRefs.current[key] : null;
    const testId = bucket === "PREFERRED" ? `picker-preferred-card-${key}` : bucket === "FILMSTRIP" ? `picker-filmstrip-card-${key}` : "";
    const domCard = container?.querySelector<HTMLElement>(`[data-testid="${testId}"]`) || null;
    const card = refCard || domCard;
    if (!container || !card) return;
    const containerRect = container.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const itemCenter = (cardRect.left - containerRect.left) + container.scrollLeft + cardRect.width / 2;
    const rawTarget = itemCenter - container.clientWidth / 2;
    const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
    const nextScrollLeft = clamp(rawTarget, 0, maxScrollLeft);
    if (Math.abs(container.scrollLeft - nextScrollLeft) < 1) return;
    const previousScrollLeft = container.scrollLeft;
    try {
      container.scrollTo({ left: nextScrollLeft, behavior: "smooth" });
      if (typeof window !== "undefined") {
        window.setTimeout(() => {
          if (Math.abs(container.scrollLeft - previousScrollLeft) < 1) {
            container.scrollLeft = nextScrollLeft;
          }
        }, 180);
      }
    } catch {
      container.scrollLeft = nextScrollLeft;
    }
  };

  const focusAndCenterPoolItem = (key: string) => {
    if (!currentSession) return;
    setFocus(currentSession.session_id, key);
    setPendingPoolCenterKey(key);
  };

  const stageFocusKeys = useMemo(
    () => stageSlots.filter(Boolean) as string[],
    [stageSlots]
  );

  const stepFocus = (direction: 1 | -1, fromKey?: string | null) => {
    if (!currentSession || !stageFocusKeys.length) return;
    const originKey = fromKey || focusKey;
    const currentIndex = originKey ? stageFocusKeys.indexOf(originKey) : -1;
    const nextIndex =
      currentIndex < 0
        ? direction > 0
          ? 0
          : stageFocusKeys.length - 1
        : (currentIndex + direction + stageFocusKeys.length) % stageFocusKeys.length;
    const nextKey = stageFocusKeys[nextIndex];
    if (nextKey) setFocus(currentSession.session_id, nextKey);
  };

  const [immersiveRevealKeys, setImmersiveRevealKeys] = useState<Record<string, true>>({});

  const revealImmersiveControls = (key: string, durationMs = 2600) => {
    if (typeof window === "undefined") return;
    const existing = immersiveRevealTimeoutsRef.current[key];
    if (existing) window.clearTimeout(existing);
    setImmersiveRevealKeys((current) => ({ ...current, [key]: true }));
    immersiveRevealTimeoutsRef.current[key] = window.setTimeout(() => {
      setImmersiveRevealKeys((current) => {
        if (!current[key]) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
      delete immersiveRevealTimeoutsRef.current[key];
    }, durationMs);
  };

  useEffect(() => {
    return () => {
      Object.values(immersiveRevealTimeoutsRef.current).forEach((timerId) => {
        if (typeof window !== "undefined") window.clearTimeout(timerId);
      });
    };
  }, []);

  useEffect(() => {
    filmstripItemRefs.current = {};
    preferredItemRefs.current = {};
  }, [currentSession?.session_id]);

  useEffect(() => {
    if (!pendingPoolCenterKey) return;
    if (typeof window === "undefined") {
      centerPoolCard(pendingPoolCenterKey);
      setPendingPoolCenterKey(null);
      return;
    }
    const rafId = window.requestAnimationFrame(() => {
      centerPoolCard(pendingPoolCenterKey);
      window.setTimeout(() => centerPoolCard(pendingPoolCenterKey), 90);
      setPendingPoolCenterKey(null);
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [pendingPoolCenterKey, filmstripItems, preferredItems, compareMode]);

  const applyKeyboardRating = (rating: number) => {
    if (!focusKey) return;
    rateItem(focusKey, rating);
    if (immersiveMode && rating > 0) {
      revealImmersiveControls(focusKey);
      stepFocus(1, focusKey);
    }
  };

  useEffect(() => {
    if (!currentSession) return;
    const previous = previousSessionItemsRef.current;
    const currentMap = new Map(sessionItems.map((item) => [pickerItemKey(item), item]));
    if (previous.size && previousSessionIdRef.current === currentSession.session_id) {
      const patched = pickerNormalizeStatusMetadata(currentSession, previous);
      if (patched !== currentSession) {
        patchSession(currentSession.session_id, () => patched);
      }
    }
    previousSessionIdRef.current = currentSession.session_id;
    previousSessionItemsRef.current = currentMap;
  }, [currentSession, sessionItems, patchSession]);

  useEffect(() => {
    if (!currentSession) return;
    if (pickerVisibleCandidateItems(sessionItems).length === 0) return;
    const visible = normalizedSlots.slice(0, stageSlotCount).filter(Boolean);
    if (visible.length) return;
    patchSession(currentSession.session_id, (session) =>
      pickerScheduleSession({
        session,
        compareMode,
        schedulerSettings: settings.pickerScheduler,
        reason: "init",
      })
    );
  }, [currentSession?.session_id, compareMode, normalizedSlots.join("|"), sessionItems.length, patchSession, settings.pickerScheduler, stageSlotCount]);

  const downloadOne = async (item: PickerSessionItem) => {
    if (!pickerItemHasImage(item)) return false;
    try {
      const blob = await runWithImageAccessTurnstile(() =>
        client.getImageBlob(item.job_id, item.image_id, item.job_access_token)
      );
      const ext = blob.type.includes("jpeg") ? "jpg" : blob.type.includes("webp") ? "webp" : "png";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${item.job_id}_${item.image_id}.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 600);
      return true;
    } catch (e: any) {
      push({ kind: "error", title: "下载失败", message: e?.error?.message || "" });
      return false;
    }
  };

  const downloadBest = async () => {
    const preferred = orderedItemsByPool.filter((it) => pickerBucketOf(it) === "PREFERRED" && pickerItemHasImage(it));
    if (!preferred.length) {
      push({ kind: "info", title: "优选池为空" });
      return;
    }
    let ok = 0;
    for (const item of preferred) {
      const done = await downloadOne(item);
      if (done) ok += 1;
      await new Promise((r) => setTimeout(r, 120));
    }
    push({ kind: "success", title: `优选池下载已触发 ${ok}/${preferred.length}` });
  };

  const downloadPicked = async () => {
    const picked = sessionItems.filter((it) => it.picked && pickerBucketOf(it) !== "DELETED" && pickerItemHasImage(it));
    if (!picked.length) {
      push({ kind: "info", title: "请先勾选要下载的图片" });
      return;
    }
    let ok = 0;
    for (const item of picked) {
      const done = await downloadOne(item);
      if (done) ok += 1;
      await new Promise((r) => setTimeout(r, 120));
    }
    push({ kind: "success", title: `已触发下载 ${ok}/${picked.length} 张` });
  };

  useEffect(() => {
    if (!currentSession) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === "Escape") {
        if (showShortcutHelp) {
          e.preventDefault();
          setShowShortcutHelp(false);
          return;
        }
        if (immersiveMode) {
          e.preventDefault();
          setImmersiveMode(false);
          return;
        }
      }
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const shortcutHelpPressed =
        (!e.metaKey && !e.ctrlKey && !e.altKey)
        && (e.key === "?" || e.key === "？" || e.key === "/" || e.code === "Slash");
      if (shortcutHelpPressed) {
        e.preventDefault();
        setShowShortcutHelp((current) => !current);
        return;
      }
      if (showShortcutHelp) return;
      if (e.key.toLowerCase() === "f") {
        e.preventDefault();
        setImmersiveMode((v) => !v);
        return;
      }
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        stepFocus(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        shiftToNextBatch();
        return;
      }
      if (!focusKey) {
        if (["1", "2", "3", "4", "5", "0", "b", "d"].includes(e.key.toLowerCase())) {
          e.preventDefault();
        }
        return;
      }
      const focusItem = itemMap.get(focusKey);
      if (!focusItem) return;
      if (["1", "2", "3", "4", "5"].includes(e.key)) {
        e.preventDefault();
        applyKeyboardRating(Number(e.key));
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        rateItem(focusKey, 0);
        return;
      }
      const key = e.key.toLowerCase();
      if (key === "b" && !e.shiftKey && pickerItemHasImage(focusItem)) {
        e.preventDefault();
        toggleBest(focusKey);
        return;
      }
      if (key === "d" && !e.shiftKey) {
        e.preventDefault();
        deleteFromPicker(focusKey);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    currentSession?.session_id,
    compareMode,
    focusKey,
    stageFocusKeys.join("|"),
    itemMap,
    immersiveMode,
    sessionItems,
    settings.pickerScheduler,
    showShortcutHelp,
  ]);

  if (!currentSession) {
    return (
      <PageContainer>
        <EmptyHint text="正在初始化挑选会话…" />
      </PageContainer>
    );
  }

  const darkStage = currentSession.ui.background === "dark";
  const selectedCount = sessionItems.filter((it) => it.picked && pickerBucketOf(it) !== "DELETED").length;
  const activeMode = pickerScheduleMode(pickerVisibleCandidateItems(sessionItems));
  const pendingReviewCount = filmstripItems.filter((item) => !item.reviewed).length;
  const filmstripGeneratingCount = filmstripItems.filter((item) => {
    const status = pickerItemJobStatus(item, jobsById.get(item.job_id));
    return !pickerItemHasImage(item) && status !== "FAILED" && status !== "CANCELLED";
  }).length;
  const filmstripFailedCount = filmstripItems.filter((item) => pickerItemJobStatus(item, jobsById.get(item.job_id)) === "FAILED").length;
  const immersiveSlots = normalizedSlots.slice(0, pickerCompareModeSlotCount(compareMode));
  const pickerStatChips = [
    { key: "mode", label: `当前模式 ${activeMode}`, testId: "picker-stat-mode" },
    { key: "pending", label: `未审 Filmstrip ${pendingReviewCount}`, testId: "picker-stat-pending" },
    { key: "filmstrip", label: `Filmstrip ${filmstripItems.length}`, testId: "picker-stat-filmstrip" },
    { key: "preferred", label: `优选池 ${preferredItems.length}`, testId: "picker-stat-preferred" },
    { key: "selected", label: `已选 ${selectedCount}`, testId: "picker-stat-selected" },
  ];
  const shortcutItems = [
    ["Space", "焦点移动到下一张"],
    ["Shift + Space", "回到上一张"],
    ["1~5", "给焦点图片打分"],
    ["0", "清空评分"],
    ["B", "加入或移出优选池"],
    ["D", "从当前 session 删除"],
    ["N", "切换下一组"],
    ["F", "进入或退出全屏"],
    ["?", "显示或关闭快捷键帮助"],
  ];

  const renderImmersiveSlot = (slotKey: string | null, label: string) => {
    const item = slotKey ? itemMap.get(slotKey) || null : null;
    const state = slotKey ? imageState[slotKey] : undefined;
    const isBest = Boolean(slotKey && isPreferredKey(slotKey));
    const jobRec = item ? jobsById.get(item.job_id) : undefined;
    const display = item ? pickerDisplayName(item, jobRec) : `空槽位 ${label}`;
    const hasImage = pickerItemHasImage(item);
    const status = item ? pickerItemJobStatus(item, jobRec) : "UNKNOWN";
    const controlsVisible = Boolean(slotKey && immersiveRevealKeys[slotKey]);
    const immersiveHeightClass =
      compareMode === "FOUR"
        ? "h-[44vh] min-h-[300px] md:h-[46vh]"
        : compareMode === "TWO"
          ? "h-[58vh] min-h-[360px] md:h-[66vh]"
          : "h-[78vh] min-h-[380px] md:h-[82vh]";

    return (
      <div
        key={`${label}_${slotKey || "empty"}_immersive`}
        data-testid={`picker-immersive-slot-${label}`}
        className={cn(
          "group relative overflow-hidden rounded-2xl border",
          slotKey && slotKey === focusKey ? "border-white shadow-[0_0_0_1px_rgba(255,255,255,0.35)]" : "border-white/15",
          "bg-black/60"
        )}
      >
        <button
          type="button"
          className="absolute inset-0 z-0"
          onClick={() => slotKey && focusAndCenterPoolItem(slotKey)}
          title="聚焦该图片"
        />
        <div className={cn("relative w-full", immersiveHeightClass)}>
          {!item ? (
            <div className="flex h-full items-center justify-center text-sm text-zinc-400">{display}</div>
          ) : !hasImage ? (
            <PickerPendingVisual status={status} />
          ) : state?.url ? (
            <img
              src={state.url}
              alt={display}
              className="h-full w-full object-contain opacity-0 blur-sm transition duration-300"
              onLoad={(e) => {
                const el = e.currentTarget;
                el.classList.remove("opacity-0", "blur-sm");
                el.classList.add("opacity-100");
              }}
            />
          ) : (
            <div className="h-full w-full">
              <Skeleton className="h-full w-full" />
            </div>
          )}
          {state?.code === "404" ? (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/70 text-sm font-bold text-white">404</div>
          ) : null}
        </div>
        <div className={cn("pointer-events-none absolute left-3 top-3 z-20 flex items-center gap-2 transition", controlsVisible ? "opacity-100" : "opacity-0 group-hover:opacity-100")}>
          <span className="rounded-full bg-black/55 px-2 py-1 text-xs font-bold text-white">{label}</span>
          <button
            type="button"
            className={cn(
              "pointer-events-auto rounded-full border px-2 py-0.5 text-xs font-semibold",
              isBest ? "border-amber-300 bg-amber-500/20 text-amber-200" : "border-white/25 bg-black/30 text-zinc-200"
            )}
            onClick={(e) => {
              e.stopPropagation();
              if (slotKey && hasImage) toggleBest(slotKey);
            }}
            disabled={!hasImage}
          >
            {isBest ? "移回片池" : "移入优选"}
          </button>
        </div>
        <div className={cn("pointer-events-none absolute right-3 top-3 z-20 transition", controlsVisible ? "opacity-100" : "opacity-0 group-hover:opacity-100")}>
          {item ? (
            <Button
              variant="danger"
              className="pointer-events-auto !px-2 !py-1 text-xs"
              onClick={(e) => {
                e.stopPropagation();
                if (slotKey) deleteFromPicker(slotKey);
              }}
            >
              删除
            </Button>
          ) : null}
        </div>
        {item ? (
          <div
            data-testid={`picker-immersive-overlay-${label}`}
            className={cn("pointer-events-none absolute inset-x-0 bottom-0 z-20 border-t border-white/10 bg-black/55 px-3 py-2 backdrop-blur transition", controlsVisible ? "opacity-100" : "opacity-0 group-hover:opacity-100")}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="truncate text-xs font-semibold text-zinc-200">{display}</div>
              {hasImage ? (
                <RatingStars
                  value={item.rating || 0}
                  onChange={(n) => slotKey && rateItem(slotKey, n)}
                  className="pointer-events-auto"
                />
              ) : (
                <span className="pointer-events-auto rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-bold text-white/80">
                  {status}
                </span>
              )}
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className={cn("relative min-h-screen", sidebarPinned ? "pl-[330px]" : "pl-6")}>
      {!sidebarPinned ? (
        <div
          className="fixed inset-y-0 left-0 z-30 w-5"
          onMouseEnter={() => setSidebarHoverOpen(true)}
        />
      ) : null}

      <aside
        className="fixed bottom-4 left-4 top-24 z-40 w-[300px] rounded-[28px] border border-zinc-200/80 bg-white/92 p-3 shadow-[0_18px_60px_rgba(15,23,42,0.14)] backdrop-blur transition duration-300 dark:border-white/10 dark:bg-zinc-950/88"
        style={{ transform: sidebarOpen ? "translateX(0)" : "translateX(calc(-100% + 18px))" }}
        onMouseEnter={() => setSidebarHoverOpen(true)}
        onMouseLeave={() => {
          if (!sidebarPinned) {
            setSidebarHoverOpen(false);
            setSessionMenuId(null);
          }
        }}
        data-testid="picker-session-sidebar"
      >
        <div className="absolute inset-y-8 -right-5 z-[70] flex items-center">
          <button
            type="button"
            className="rounded-full border border-zinc-200 bg-white px-3 py-4 text-[10px] font-bold uppercase tracking-[0.22em] text-zinc-500 shadow-[0_10px_30px_rgba(15,23,42,0.14)] dark:border-white/10 dark:bg-zinc-950 dark:text-zinc-300"
            onClick={() => setSidebarPinned((current) => !current)}
            data-testid="picker-sidebar-toggle"
          >
            {sidebarPinned ? "收起" : "会话"}
          </button>
        </div>

        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">Sessions</div>
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
              {showArchivedSessions ? `归档 ${archivedSessions.length}` : `活跃 ${activeSessions.length}`}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant={sidebarPinned ? "secondary" : "ghost"} className="!px-2 !py-1 text-xs" onClick={() => setSidebarPinned((current) => !current)}>
              {sidebarPinned ? "固定" : "自动隐藏"}
            </Button>
            <Button testId="picker-sidebar-archived-toggle" variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => setShowArchivedSessions((current) => !current)}>
              {showArchivedSessions ? "返回活跃" : "查看归档"}
            </Button>
          </div>
        </div>

        <div className="mb-3 rounded-2xl border border-zinc-200 bg-zinc-50/80 p-2 dark:border-white/10 dark:bg-zinc-900/50">
          <div className="flex gap-2">
            <Input value={newSessionDraft} onChange={setNewSessionDraft} placeholder="新建会话名称" />
            <Button testId="picker-sidebar-create-session" variant="secondary" className="!px-3" onClick={createSessionFromSidebar}>
              新建
            </Button>
          </div>
          <div className="mt-2 flex items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
            <span>默认 4-up</span>
            <span>·</span>
            <span>Light BG</span>
            <span>·</span>
            <span>支持归档 / 置顶</span>
          </div>
        </div>

        <div
          className="h-[calc(100%-132px)] overflow-y-auto pr-2"
          onScroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollTop + el.clientHeight >= el.scrollHeight - 72) {
              setVisibleSessionCount((current) => Math.min(sidebarSessions.length, current + 12));
            }
          }}
        >
          <div className="space-y-2">
            {visibleSidebarSessions.map((session) => {
              const counts = getPickerSessionCounts(session);
              const active = session.session_id === currentSession.session_id;
              const menuOpen = sessionMenuId === session.session_id;
              return (
                <div
                  key={session.session_id}
                  data-testid={`picker-session-item-${session.session_id}`}
                  className={cn(
                    "relative cursor-pointer overflow-visible rounded-2xl border p-2.5 transition",
                    menuOpen ? "z-40" : "z-0",
                    active
                      ? "border-zinc-900 bg-zinc-900 text-white shadow-md dark:border-white dark:bg-white dark:text-zinc-900"
                      : "border-zinc-200 bg-white/80 hover:border-zinc-300 dark:border-white/10 dark:bg-zinc-900/60 dark:hover:border-white/20"
                  )}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setCurrentSessionAndUrl(session.session_id);
                    setSessionMenuId(null);
                    setShowArchivedSessions(Boolean(session.archived));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setCurrentSessionAndUrl(session.session_id);
                      setSessionMenuId(null);
                      setShowArchivedSessions(Boolean(session.archived));
                    }
                  }}
                >
                  <div className="relative z-10 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{session.name}</div>
                      <div className={cn("mt-1 text-[11px]", active ? "text-white/75 dark:text-zinc-700" : "text-zinc-500 dark:text-zinc-400")}>
                        Filmstrip {counts.filmstrip} · 优选 {counts.preferred}
                      </div>
                    </div>
                    <div className="relative shrink-0">
                      <button
                        type="button"
                        className={cn(
                          "relative z-20 rounded-full px-2 py-1 text-xs font-bold",
                          active ? "bg-white/15 text-white dark:bg-zinc-900/10 dark:text-zinc-900" : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                        )}
                        data-testid={`picker-session-menu-${session.session_id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSessionMenuId((current) => (current === session.session_id ? null : session.session_id));
                        }}
                      >
                        ...
                      </button>
                      {menuOpen ? (
                        <div
                          className="absolute right-0 top-11 z-[80] w-44 rounded-2xl border border-zinc-200/80 bg-white p-1.5 shadow-[0_24px_50px_rgba(15,23,42,0.2)] ring-1 ring-zinc-950/5 dark:border-white/10 dark:bg-zinc-950 dark:ring-white/10"
                          data-testid={`picker-session-menu-panel-${session.session_id}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button type="button" className="w-full rounded-xl px-3 py-2 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-900" onClick={() => renameSessionFromSidebar(session)}>
                            重命名
                          </button>
                          <button type="button" className="w-full rounded-xl px-3 py-2 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-900" onClick={() => pinSession(session.session_id, !session.pinned)}>
                            {session.pinned ? "取消置顶" : "置顶"}
                          </button>
                          <button type="button" className="w-full rounded-xl px-3 py-2 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-900" onClick={() => archiveSession(session.session_id, !session.archived)}>
                            {session.archived ? "恢复会话" : "归档会话"}
                          </button>
                          <button type="button" className="w-full rounded-xl px-3 py-2 text-left text-xs text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30" onClick={() => deleteSessionFromSidebar(session)}>
                            删除
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <div className="relative z-10 mt-2 flex flex-wrap items-center gap-1 text-[10px]">
                    {session.pinned ? <span className={cn("rounded-full px-2 py-0.5", active ? "bg-white/15 text-white dark:bg-zinc-900/10 dark:text-zinc-900" : "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-200")}>置顶</span> : null}
                    {session.archived ? <span className={cn("rounded-full px-2 py-0.5", active ? "bg-white/15 text-white dark:bg-zinc-900/10 dark:text-zinc-900" : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300")}>归档</span> : null}
                    <span className={cn("rounded-full px-2 py-0.5", active ? "bg-white/15 text-white dark:bg-zinc-900/10 dark:text-zinc-900" : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300")}>
                      {session.compare_mode}
                    </span>
                  </div>
                </div>
              );
            })}
            {!visibleSidebarSessions.length ? (
              <div className="rounded-2xl border border-dashed border-zinc-200 p-4 text-xs text-zinc-500 dark:border-white/10 dark:text-zinc-400">
                {showArchivedSessions ? "还没有归档会话。" : "还没有活跃会话。"}
              </div>
            ) : null}
          </div>
          {visibleSessionCount < sidebarSessions.length ? (
            <div className="mt-3 flex justify-center">
              <Button variant="ghost" className="!px-3 !py-1.5 text-xs" onClick={() => setVisibleSessionCount((current) => Math.min(sidebarSessions.length, current + 12))}>
                加载更多会话
              </Button>
            </div>
          ) : null}
        </div>
      </aside>

      <div className="mx-auto w-full max-w-[1780px] px-4 py-6">
        <PageTitle
          title="Image Picker"
          subtitle="中间大舞台负责审图，左侧侧边栏负责 session 切换与管理。"
          right={
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs font-semibold text-zinc-600 dark:border-white/10 dark:bg-zinc-950/50 dark:text-zinc-300">
                当前会话 · {currentSession.name}
              </span>
              <Button variant="ghost" onClick={() => navigate("/history")}>返回 History</Button>
            </div>
          }
        />

        <div className="space-y-3">
          <Card className="overflow-hidden border-none bg-[radial-gradient(circle_at_top_left,rgba(251,191,36,0.18),transparent_28%),radial-gradient(circle_at_top_right,rgba(56,189,248,0.16),transparent_26%),linear-gradient(180deg,rgba(255,255,255,0.98),rgba(244,244,245,0.96))] shadow-[0_14px_50px_rgba(15,23,42,0.08)] dark:bg-[radial-gradient(circle_at_top_left,rgba(251,191,36,0.14),transparent_24%),radial-gradient(circle_at_top_right,rgba(56,189,248,0.1),transparent_24%),linear-gradient(180deg,rgba(24,24,27,0.96),rgba(9,9,11,0.96))]">
            <div className="flex items-center gap-2 overflow-x-auto whitespace-nowrap pb-1" data-testid="picker-toolbar">
              <Button variant="secondary" onClick={() => setImportOpen(true)}>从历史导入</Button>
              <Button testId="picker-mode-one" variant={compareMode === "ONE" ? "primary" : "ghost"} onClick={() => setSessionMode("ONE")}>1-up</Button>
              <Button variant={compareMode === "TWO" ? "primary" : "ghost"} onClick={() => setSessionMode("TWO")}>2-up</Button>
              <Button variant={compareMode === "FOUR" ? "primary" : "ghost"} onClick={() => setSessionMode("FOUR")}>4-up</Button>
              <Button
                variant={currentSession.layout_preset === "SYNC_ZOOM" ? "secondary" : "ghost"}
                onClick={() => patchSessionLayout(currentSession.layout_preset === "SYNC_ZOOM" ? "FREE_ZOOM" : "SYNC_ZOOM")}
              >
                {currentSession.layout_preset === "SYNC_ZOOM" ? "同步缩放" : "自由缩放"}
              </Button>
              <Button variant={currentSession.ui.showInfo ? "secondary" : "ghost"} onClick={() => patchSessionUi({ showInfo: !currentSession.ui.showInfo })}>
                Info
              </Button>
              <Button variant={currentSession.ui.showGrid ? "secondary" : "ghost"} onClick={() => patchSessionUi({ showGrid: !currentSession.ui.showGrid })}>
                Grid
              </Button>
              <Button
                variant={!darkStage ? "secondary" : "ghost"}
                onClick={() => patchSessionUi({ background: darkStage ? "light" : "dark" })}
              >
                {darkStage ? "Light BG" : "Dark BG"}
              </Button>
              <Button variant="secondary" onClick={() => setImmersiveMode(true)}>全屏审阅</Button>
              <Button testId="picker-next-batch" variant="secondary" onClick={shiftToNextBatch}>切换下一组</Button>
              <Button variant="primary" onClick={downloadBest}>下载优选</Button>
              <Button variant="secondary" onClick={downloadPicked}>下载选中</Button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
              {pickerStatChips.map((chip) => (
                <span
                  key={chip.key}
                  className="rounded-full border border-zinc-200 bg-white px-3 py-1 dark:border-white/10 dark:bg-zinc-950/40"
                  data-testid={chip.testId}
                >
                  {chip.label}
                </span>
              ))}
            </div>
          </Card>

          <Card className={cn("overflow-hidden border-none p-2.5 shadow-[0_22px_70px_rgba(15,23,42,0.16)]", darkStage ? "bg-zinc-950" : "bg-[linear-gradient(180deg,#fffdf7,#f8fafc)]")} testId="picker-stage">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">{currentSession.name}</div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">审图主舞台默认突出展示，硬操作后立即补位。</div>
              </div>
              <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{compareMode} · {darkStage ? "Dark Stage" : "Light Stage"}</div>
            </div>
            <div className={cn("grid gap-2.5", compareMode === "FOUR" ? "grid-cols-1 xl:grid-cols-2" : compareMode === "TWO" ? "grid-cols-1 lg:grid-cols-2" : "grid-cols-1")}>
              {stageSlots.map((slotKey, idx) => {
                const item = slotKey ? itemMap.get(slotKey) || null : null;
                const label = String.fromCharCode(65 + idx);
                return (
                  <div key={`${label}_${slotKey || "empty"}`} data-testid={`picker-slot-${label}`}>
                    <PickerCompareSlot
                      slotLabel={label}
                      item={item}
                      image={slotKey ? imageState[slotKey] : undefined}
                      compareMode={compareMode}
                      isBest={Boolean(slotKey && isPreferredKey(slotKey))}
                      focused={Boolean(slotKey && slotKey === focusKey)}
                      showInfo={currentSession.ui.showInfo}
                      showGrid={currentSession.ui.showGrid}
                      darkStage={darkStage}
                      jobRec={item ? jobsById.get(item.job_id) : undefined}
                      displayName={item ? pickerDisplayName(item, jobsById.get(item.job_id)) : "-"}
                      onFocus={() => slotKey && focusAndCenterPoolItem(slotKey)}
                      onEnsureImage={() => {}}
                      onBest={() => slotKey && toggleBest(slotKey)}
                      onRate={(n) => slotKey && rateItem(slotKey, n)}
                      onRemove={() => slotKey && deleteFromPicker(slotKey)}
                      onFixToken={() => item && fixToken(item)}
                    />
                  </div>
                );
              })}
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="min-w-0 overflow-hidden" testId="picker-filmstrip-panel">
              <div className="mb-3 flex items-center justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">Filmstrip</div>
                    <div className="flex items-center gap-1 whitespace-nowrap text-[10px]">
                      {filmstripGeneratingCount > 0 ? (
                        <span className="rounded-full border border-sky-300/80 bg-sky-500/10 px-2 py-0.5 font-semibold text-sky-700 dark:border-sky-400/30 dark:text-sky-200">
                          生成中 {filmstripGeneratingCount}
                        </span>
                      ) : null}
                      {filmstripFailedCount > 0 ? (
                        <span className="rounded-full border border-rose-300/80 bg-rose-500/10 px-2 py-0.5 font-semibold text-rose-700 dark:border-rose-400/30 dark:text-rose-200">
                          失败 {filmstripFailedCount}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">横向片池适合快速浏览、评分和硬决策。</div>
                </div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">已选 {selectedCount} / 总计 {filmstripItems.length + preferredItems.length}</div>
              </div>
              {!filmstripItems.length && !preferredItems.length ? (
                <EmptyHint text="暂无图片，点击“从历史导入”开始挑选" />
              ) : (
                <div
                  data-testid="picker-filmstrip-scroll"
                  ref={filmstripScrollRef}
                  className="flex gap-3 overflow-x-auto pb-2"
                  onWheel={(e) => {
                    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                      (e.currentTarget as HTMLDivElement).scrollLeft += e.deltaY;
                    }
                  }}
                >
                  {filmstripItems.map((item) => {
                    const key = pickerItemKey(item);
                    const active = key === focusKey;
                    const inSlot = normalizedSlots.indexOf(key);
                    const state = imageState[key];
                    const hasImage = pickerItemHasImage(item);
                    const status = pickerItemJobStatus(item, jobsById.get(item.job_id));
                    return (
                      <motion.div
                        layout
                        key={`film_${key}`}
                        data-testid={`picker-filmstrip-card-${key}`}
                        ref={(node) => setPoolItemRef("FILMSTRIP", key, node)}
                        className={cn(
                          "w-64 flex-none overflow-hidden rounded-[24px] border",
                          active ? "border-zinc-900 shadow-md dark:border-white" : "border-zinc-200 dark:border-white/10"
                        )}
                      >
                        <button
                          type="button"
                          className="relative block h-40 w-full overflow-hidden bg-zinc-100 dark:bg-zinc-900"
                          onClick={() => activatePickerItem(key)}
                        >
                          {!hasImage ? (
                            <PickerPendingVisual status={status} />
                          ) : state?.url ? (
                            <img
                              src={state.url}
                              alt={item.image_id}
                              className="h-full w-full object-cover opacity-0 blur-sm transition duration-300"
                              onLoad={(e) => {
                                const el = e.currentTarget;
                                el.classList.remove("opacity-0", "blur-sm");
                                el.classList.add("opacity-100");
                              }}
                            />
                          ) : (
                            <Skeleton className="h-full w-full" />
                          )}
                        </button>
                        <div className="space-y-2 p-3">
                          <div className="flex items-center justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
                            <label className="inline-flex items-center gap-1">
                              <input
                                type="checkbox"
                                checked={Boolean(item.picked)}
                                onChange={(e) => updateItem(currentSession.session_id, key, { picked: e.target.checked })}
                              />
                              选中
                            </label>
                            <span>槽位 {inSlot >= 0 ? String.fromCharCode(65 + inSlot) : "-"}</span>
                          </div>
                          {hasImage ? (
                            <RatingStars value={item.rating || 0} onChange={(n) => rateItem(key, n)} />
                          ) : (
                            <div className="rounded-xl bg-sky-500/10 px-2 py-1 text-[11px] font-semibold text-sky-700 dark:text-sky-200">{status}</div>
                          )}
                          <div className="flex flex-wrap gap-1">
                            <Button variant="ghost" className="!px-1.5 !py-0.5 text-[10px]" onClick={() => toggleBest(key)} disabled={!hasImage}>
                              {isPreferredKey(key) ? "移回片池" : "移入优选"}
                            </Button>
                            <Button variant="ghost" className="!px-1.5 !py-0.5 text-[10px]" onClick={() => downloadOne(item)} disabled={!hasImage}>下载</Button>
                            <Button variant="danger" className="!px-1.5 !py-0.5 text-[10px]" onClick={() => deleteFromPicker(key)}>删除</Button>
                          </div>
                          <div className="truncate text-[10px] text-zinc-500 dark:text-zinc-400">{pickerDisplayName(item, jobsById.get(item.job_id))}</div>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              )}
            </Card>

            <Card className="min-w-0 overflow-hidden" testId="picker-preferred-panel">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">优选池</div>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">保留有潜力的图，继续横向比较与下载。</div>
                </div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">{preferredItems.length} 张</div>
              </div>
              {!preferredItems.length ? (
                <div className="rounded-2xl border border-dashed border-zinc-200 p-4 text-xs text-zinc-500 dark:border-white/10 dark:text-zinc-400">
                  还没有优选图片，可在 Filmstrip 中点击“移入优选”。
                </div>
              ) : (
                <div
                  data-testid="picker-preferred-scroll"
                  ref={preferredScrollRef}
                  className="flex gap-3 overflow-x-auto pb-2"
                  onWheel={(e) => {
                    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                      (e.currentTarget as HTMLDivElement).scrollLeft += e.deltaY;
                    }
                  }}
                >
                  {preferredItems.map((item) => {
                    const key = pickerItemKey(item);
                    const active = key === focusKey;
                    const inSlot = normalizedSlots.indexOf(key);
                    const state = imageState[key];
                    return (
                      <motion.div
                        layout
                        key={`pref_${key}`}
                        data-testid={`picker-preferred-card-${key}`}
                        ref={(node) => setPoolItemRef("PREFERRED", key, node)}
                        className={cn(
                          "w-64 flex-none overflow-hidden rounded-[24px] border",
                          active ? "border-amber-500 shadow-md dark:border-amber-300" : "border-zinc-200 dark:border-white/10"
                        )}
                      >
                        <button
                          type="button"
                          className="relative block h-44 w-full overflow-hidden bg-zinc-100 dark:bg-zinc-900"
                          onClick={() => activatePickerItem(key)}
                        >
                          {state?.url ? (
                            <img
                              src={state.url}
                              alt={item.image_id}
                              className="h-full w-full object-cover opacity-0 blur-sm transition duration-300"
                              onLoad={(e) => {
                                const el = e.currentTarget;
                                el.classList.remove("opacity-0", "blur-sm");
                                el.classList.add("opacity-100");
                              }}
                            />
                          ) : (
                            <Skeleton className="h-full w-full" />
                          )}
                          <div className="absolute left-2 top-2 rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-bold text-white">优选</div>
                        </button>
                        <div className="space-y-2 p-3">
                          <div className="flex items-center justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
                            <label className="inline-flex items-center gap-1">
                              <input
                                type="checkbox"
                                checked={Boolean(item.picked)}
                                onChange={(e) => updateItem(currentSession.session_id, key, { picked: e.target.checked })}
                              />
                              选中
                            </label>
                            <span>槽位 {inSlot >= 0 ? String.fromCharCode(65 + inSlot) : "-"}</span>
                          </div>
                          <RatingStars value={item.rating || 0} onChange={(n) => rateItem(key, n)} />
                          <div className="flex flex-wrap gap-1">
                            <Button variant="ghost" className="!px-1.5 !py-0.5 text-[10px]" onClick={() => toggleBest(key)}>移回片池</Button>
                            <Button variant="ghost" className="!px-1.5 !py-0.5 text-[10px]" onClick={() => downloadOne(item)}>下载</Button>
                            <Button variant="danger" className="!px-1.5 !py-0.5 text-[10px]" onClick={() => deleteFromPicker(key)}>删除</Button>
                          </div>
                          <div className="truncate text-[10px] text-zinc-500 dark:text-zinc-400">{pickerDisplayName(item, jobsById.get(item.job_id))}</div>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              )}
            </Card>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {immersiveMode ? (
          <motion.div
            className="fixed inset-0 z-[70] bg-black text-white"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_56%)]" />
            <div className="relative flex h-full flex-col px-4 pb-4 pt-3 md:px-6">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 overflow-hidden whitespace-nowrap">
                    <div className="truncate text-sm font-bold">{currentSession.name} · 沉浸式审阅</div>
                    <div className="flex min-w-0 items-center gap-1 overflow-x-auto text-[10px] text-zinc-300/80 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                      {pickerStatChips.map((chip) => (
                        <span key={chip.key} className="rounded-full border border-white/12 bg-white/6 px-2 py-0.5 font-medium text-zinc-300/80">
                          {chip.label}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="text-[11px] text-zinc-300">悬停显示评分与优选控件，按 `Esc` 退出</div>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant={compareMode === "ONE" ? "secondary" : "ghost"} onClick={() => setSessionMode("ONE")}>1-up</Button>
                  <Button variant={compareMode === "TWO" ? "secondary" : "ghost"} onClick={() => setSessionMode("TWO")}>2-up</Button>
                  <Button variant={compareMode === "FOUR" ? "secondary" : "ghost"} onClick={() => setSessionMode("FOUR")}>4-up</Button>
                  <Button variant="secondary" onClick={shiftToNextBatch}>切换下一组</Button>
                  <Button variant="secondary" onClick={() => setImmersiveMode(false)}>退出全屏</Button>
                </div>
              </div>

              <div className="flex-1 overflow-auto">
                <div className={cn("grid gap-3", compareMode === "FOUR" ? "grid-cols-1 lg:grid-cols-2" : compareMode === "TWO" ? "grid-cols-1 lg:grid-cols-2" : "grid-cols-1")}>
                  {immersiveSlots.map((slotKey, idx) => renderImmersiveSlot(slotKey || null, String.fromCharCode(65 + idx)))}
                </div>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {showShortcutHelp ? (
          <motion.div
            className="fixed inset-0 z-[72] flex items-end justify-end bg-black/20 p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <button type="button" className="absolute inset-0" onClick={() => setShowShortcutHelp(false)} aria-label="关闭快捷键帮助" />
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 12 }}
              className="relative w-full max-w-sm rounded-3xl border border-zinc-200 bg-white/95 p-4 shadow-2xl backdrop-blur dark:border-white/10 dark:bg-zinc-950/92"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">Picker 快捷键</div>
                  <div className="text-[11px] text-zinc-500 dark:text-zinc-400">仅在 picker 页面生效，普通模式和全屏审阅都可用。</div>
                </div>
                <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => setShowShortcutHelp(false)}>
                  关闭
                </Button>
              </div>
              <div className="mt-3 space-y-2">
                {shortcutItems.map(([combo, label]) => (
                  <div key={combo} className="flex items-center justify-between gap-4 rounded-2xl bg-zinc-50 px-3 py-2 text-xs dark:bg-white/5">
                    <span className="font-semibold text-zinc-900 dark:text-zinc-100">{combo}</span>
                    <span className="text-right text-zinc-500 dark:text-zinc-400">{label}</span>
                  </div>
                ))}
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {importOpen ? (
          <motion.div
            className="fixed inset-0 z-50 flex"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <button type="button" className="h-full flex-1 bg-black/45" onClick={() => setImportOpen(false)} />
            <motion.div
              initial={{ x: 420 }}
              animate={{ x: 0 }}
              exit={{ x: 420 }}
              transition={{ duration: settings.ui.reduceMotion ? 0 : 0.18 }}
              className="h-full w-[480px] max-w-[96vw] overflow-y-auto border-l border-zinc-200 bg-white p-4 shadow-2xl dark:border-white/10 dark:bg-zinc-950"
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-lg font-bold text-zinc-900 dark:text-zinc-50">导入图片</div>
                  <div className="text-xs text-zinc-600 dark:text-zinc-300">同批次任务默认折叠，可整批导入，也支持展开后逐图勾选。</div>
                </div>
                <Button variant="ghost" onClick={() => setImportOpen(false)}>关闭</Button>
              </div>

              <div className="mt-3 space-y-2">
                <Input value={importFilter} onChange={setImportFilter} placeholder="搜索 job_id / prompt / tag" />
                <div className="flex gap-2">
                  <Input value={quickJobId} onChange={setQuickJobId} placeholder="按 job_id 快速导入" />
                  <Button
                    variant="secondary"
                    onClick={async () => {
                      const id = quickJobId.trim();
                      if (!id) return;
                      let token = manualTokenByJob[id] || jobsById.get(id)?.job_access_token || "";
                      if (settings.jobAuthMode === "TOKEN" && !token) {
                        token = prompt(`该 job 缺少 token，请输入 X-Job-Token（job: ${shortId(id)}）`) || "";
                        if (token) setManualTokenByJob((m) => ({ ...m, [id]: token }));
                      }
                      await importAllFromJob(id, false, token || undefined);
                    }}
                  >
                    导入该 Job
                  </Button>
                </div>
                <div className="flex items-center justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
                  <span>共 {importGroups.length} 组</span>
                  <span data-testid="picker-import-page">第 {safeImportPage} / {importTotalPages} 页</span>
                </div>
              </div>

              <div className="mt-4 space-y-2">
                {pagedImportGroups.map((group) => {
                  const collapsed = importGroupCollapsed[group.key] ?? group.collapsible;
                  return (
                    <div key={group.key} className="rounded-2xl border border-zinc-200 p-3 dark:border-white/10" data-testid="picker-import-group">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-xs font-bold text-zinc-900 dark:text-zinc-50">{group.label}</div>
                          <div className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">{group.hint}</div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {group.jobs.length > 1 ? (
                            <Button
                              variant="ghost"
                              className="!px-2 !py-1 text-xs"
                              onClick={() => setImportGroupCollapsed((current) => ({ ...current, [group.key]: !collapsed }))}
                            >
                              {collapsed ? "展开" : "折叠"}
                            </Button>
                          ) : null}
                          <Button variant="secondary" className="!px-2 !py-1 text-xs" onClick={() => importAllFromGroup(group)}>
                            整组导入
                          </Button>
                        </div>
                      </div>

                      {!collapsed ? (
                        <div className="mt-3 space-y-2">
                          {group.jobs.map((job) => {
                            const st = importState[job.job_id];
                            const ids = st?.imageIds || [];
                            return (
                              <div key={job.job_id} className="rounded-2xl bg-zinc-50/80 p-2.5 dark:bg-zinc-900/40">
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <div className="truncate text-xs font-bold text-zinc-900 dark:text-zinc-50">
                                      {job.prompt_preview || shortId(job.job_id)}
                                    </div>
                                    <div className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                                      {shortId(job.job_id)} · {job.status_cache || "UNKNOWN"}
                                    </div>
                                  </div>
                                  <Button
                                    variant="ghost"
                                    className="!px-2 !py-1 text-xs"
                                    onClick={() => loadJobImages(job.job_id)}
                                  >
                                    {st?.loading ? "加载中…" : "读取图片"}
                                  </Button>
                                </div>

                                {st?.error ? <div className="mt-2 text-[11px] text-rose-600 dark:text-rose-300">{st.error}</div> : null}
                                {ids.length ? (
                                  <div className="mt-2 space-y-1">
                                    <div className="flex items-center justify-between">
                                      <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{ids.length} 张</div>
                                      <div className="flex gap-1">
                                        <Button
                                          variant="ghost"
                                          className="!px-2 !py-0.5 text-[10px]"
                                          onClick={() =>
                                            setImportSelection((prev) => {
                                              const next = { ...prev };
                                              ids.forEach((id) => {
                                                next[pickerItemKeyFrom(job.job_id, id)] = true;
                                              });
                                              return next;
                                            })
                                          }
                                        >
                                          全选
                                        </Button>
                                        <Button
                                          variant="ghost"
                                          className="!px-2 !py-0.5 text-[10px]"
                                          onClick={() =>
                                            setImportSelection((prev) => {
                                              const next = { ...prev };
                                              ids.forEach((id) => {
                                                next[pickerItemKeyFrom(job.job_id, id)] = false;
                                              });
                                              return next;
                                            })
                                          }
                                        >
                                          清空
                                        </Button>
                                      </div>
                                    </div>
                                    <div className="max-h-32 space-y-1 overflow-auto rounded-xl bg-white p-2 dark:bg-zinc-950/40">
                                      {ids.map((id) => {
                                        const key = pickerItemKeyFrom(job.job_id, id);
                                        const display = pickerDisplayName(
                                          {
                                            job_id: job.job_id,
                                            image_id: id,
                                            added_at: job.created_at || isoNow(),
                                          },
                                          job
                                        );
                                        return (
                                          <label key={key} className="flex items-center gap-2 text-[11px] text-zinc-700 dark:text-zinc-200">
                                            <input
                                              type="checkbox"
                                              checked={Boolean(importSelection[key])}
                                              onChange={(e) => setImportSelection((m) => ({ ...m, [key]: e.target.checked }))}
                                            />
                                            <span className="truncate">{display}</span>
                                          </label>
                                        );
                                      })}
                                    </div>
                                  </div>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="mt-2 rounded-2xl border border-dashed border-zinc-200 px-3 py-2 text-[11px] text-zinc-500 dark:border-white/10 dark:text-zinc-400">
                          已自动折叠该批次。可直接整组导入，或点击“展开”逐个 job 查看图片。
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="mt-4 flex items-center justify-between">
                <Button variant="ghost" className="!px-3 !py-1.5 text-xs" onClick={() => setImportPage((page) => clamp(page - 1, 1, importTotalPages))} disabled={safeImportPage <= 1}>
                  上一页
                </Button>
                <div className="text-[11px] text-zinc-500 dark:text-zinc-400" data-testid="picker-import-page-summary">
                  第 {safeImportPage} / {importTotalPages} 页 · 当前 {pagedImportGroups.length} 组
                </div>
                <Button variant="ghost" className="!px-3 !py-1.5 text-xs" onClick={() => setImportPage((page) => clamp(page + 1, 1, importTotalPages))} disabled={safeImportPage >= importTotalPages}>
                  下一页
                </Button>
              </div>

              <Divider />
              <div className="flex items-center justify-between">
                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                  已勾选 {Object.values(importSelection).filter(Boolean).length} 张
                </div>
                <Button
                  onClick={() => {
                    const picked = Object.entries(importSelection).filter(([, v]) => v).map(([k]) => k);
                    if (!picked.length) {
                      push({ kind: "info", title: "请先勾选图片" });
                      return;
                    }
                    addItems(
                      currentSession.session_id,
                      picked
                        .map((k) => pickerItemRefFromKey(k))
                        .filter(Boolean)
                        .map((ref) => ({
                          job_id: ref!.job_id,
                          image_id: ref!.image_id,
                          job_access_token: manualTokenByJob[ref!.job_id] || jobsById.get(ref!.job_id)?.job_access_token,
                          picked: true,
                          status: "SUCCEEDED" as JobStatus,
                          added_at: isoNow(),
                        }))
                    );
                    push({ kind: "success", title: "已加入对比池" });
                    setImportOpen(false);
                  }}
                >
                  导入选中
                </Button>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

// -----------------------------
// Settings Page
// -----------------------------

function SettingsPage() {
  const { push } = useToast();
  const client = useApiClient();
  const catalog = useModelCatalog();
  const nav = useNavigate();
  const { user, isAdmin } = useAuthSession();
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const resetSettings = useSettingsStore((s) => s.resetSettings);
  const clearJobs = useJobsStore((s) => s.clearJobs);
  const jobs = useJobsStore((s) => s.jobs);

  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [defaultModel, setDefaultModel] = useState<ModelId>(settings.defaultModel || catalog.default_model);
  const [jobAuthMode, setJobAuthMode] = useState<JobAuthMode>(settings.jobAuthMode);

  const [theme, setTheme] = useState<ThemeMode>(settings.ui.theme);
  const [reduceMotion, setReduceMotion] = useState(settings.ui.reduceMotion);
  const currentDefaultParams = useMemo(
    () => getParamsForModel(settings, settings.defaultModel || catalog.default_model),
    [catalog.default_model, settings]
  );

  const [intervalMs, setIntervalMs] = useState(settings.polling.intervalMs);
  const [maxIntervalMs, setMaxIntervalMs] = useState(settings.polling.maxIntervalMs);
  const [concurrency, setConcurrency] = useState(settings.polling.concurrency);
  const [cacheEnabled, setCacheEnabled] = useState(settings.cache.enabled);
  const [cacheTtlDays, setCacheTtlDays] = useState(settings.cache.ttlDays);
  const [cacheMaxGb, setCacheMaxGb] = useState(Number((settings.cache.maxBytes / (1024 * 1024 * 1024)).toFixed(2)));
  const [moveCooldownTurns, setMoveCooldownTurns] = useState(settings.pickerScheduler.moveCooldownTurns);
  const [recentHistoryOne, setRecentHistoryOne] = useState(settings.pickerScheduler.recentHistory.ONE);
  const [recentHistoryTwo, setRecentHistoryTwo] = useState(settings.pickerScheduler.recentHistory.TWO);
  const [recentHistoryFour, setRecentHistoryFour] = useState(settings.pickerScheduler.recentHistory.FOUR);
  const [newArrivalBonus, setNewArrivalBonus] = useState(settings.pickerScheduler.newArrivalBonus);
  const [justCompletedBonus, setJustCompletedBonus] = useState(settings.pickerScheduler.justCompletedBonus);
  const [unseenBonus, setUnseenBonus] = useState(settings.pickerScheduler.unseenBonus);
  const [resolveUrgencyWeight, setResolveUrgencyWeight] = useState(settings.pickerScheduler.resolveUrgencyWeight);
  const [polishRatingWeight, setPolishRatingWeight] = useState(settings.pickerScheduler.polishRatingWeight);
  const [cacheStatsState, setCacheStatsState] = useState<ImageCacheStats>({ count: 0, size: 0 });

  const [health, setHealth] = useState<any | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    setBaseUrl(settings.baseUrl);
    setDefaultModel(settings.defaultModel || catalog.default_model);
    setJobAuthMode(settings.jobAuthMode);
    setTheme(settings.ui.theme);
    setReduceMotion(settings.ui.reduceMotion);

    setIntervalMs(settings.polling.intervalMs);
    setMaxIntervalMs(settings.polling.maxIntervalMs);
    setConcurrency(settings.polling.concurrency);
    setCacheEnabled(settings.cache.enabled);
    setCacheTtlDays(settings.cache.ttlDays);
    setCacheMaxGb(Number((settings.cache.maxBytes / (1024 * 1024 * 1024)).toFixed(2)));
    setMoveCooldownTurns(settings.pickerScheduler.moveCooldownTurns);
    setRecentHistoryOne(settings.pickerScheduler.recentHistory.ONE);
    setRecentHistoryTwo(settings.pickerScheduler.recentHistory.TWO);
    setRecentHistoryFour(settings.pickerScheduler.recentHistory.FOUR);
    setNewArrivalBonus(settings.pickerScheduler.newArrivalBonus);
    setJustCompletedBonus(settings.pickerScheduler.justCompletedBonus);
    setUnseenBonus(settings.pickerScheduler.unseenBonus);
    setResolveUrgencyWeight(settings.pickerScheduler.resolveUrgencyWeight);
    setPolishRatingWeight(settings.pickerScheduler.polishRatingWeight);
  }, [catalog.default_model, settings]);

  useEffect(() => {
    const scope = user?.user_id || "__guest__";
    imageCacheStats(scope).then(setCacheStatsState).catch(() => setCacheStatsState({ count: 0, size: 0 }));
  }, [user?.user_id, settings.cache.enabled, settings.cache.maxBytes, settings.cache.ttlDays]);

  const save = () => {
    const next: Partial<SettingsV1> = {
      baseUrl: baseUrl.trim().replace(/\/$/, ""),
      defaultModel,
      jobAuthMode,
      ui: {
        ...settings.ui,
        theme,
        reduceMotion,
      },
      polling: {
        intervalMs,
        maxIntervalMs,
        concurrency,
      },
      cache: {
        enabled: cacheEnabled,
        ttlDays: cacheTtlDays,
        maxBytes: Math.round(cacheMaxGb * 1024 * 1024 * 1024),
      },
      pickerScheduler: {
        moveCooldownTurns,
        recentHistory: {
          ONE: recentHistoryOne,
          TWO: recentHistoryTwo,
          FOUR: recentHistoryFour,
        },
        newArrivalBonus,
        justCompletedBonus,
        unseenBonus,
        resolveUrgencyWeight,
        polishRatingWeight,
      },
    };
    setSettings(next);
    push({ kind: "success", title: "已保存设置" });
  };

  const testHealth = async () => {
    setTesting(true);
    setHealth(null);
    try {
      const tmp = new ApiClient({ ...settings, baseUrl });
      const r = await tmp.health();
      setHealth(r);
      push({ kind: "success", title: "连接成功" });
    } catch (e: any) {
      setHealth({ __error: e });
      push({ kind: "error", title: "连接失败", message: e?.error?.message || "" });
    } finally {
      setTesting(false);
    }
  };

  const exportAll = () => {
    downloadJson("nbp_export_all.json", {
      exported_at: isoNow(),
      settings: safeJsonParse(localStorage.getItem(KEY_SETTINGS), DEFAULT_SETTINGS),
      jobs: safeJsonParse(localStorage.getItem(KEY_JOBS), [] as JobRecord[]),
    });
  };

  const exportSettings = () => {
    downloadJson("nbp_settings.json", safeJsonParse(localStorage.getItem(KEY_SETTINGS), DEFAULT_SETTINGS));
  };

  const exportJobs = () => {
    downloadJson("nbp_jobs.json", safeJsonParse(localStorage.getItem(KEY_JOBS), [] as JobRecord[]));
  };

  const importJson = async (kind: "settings" | "jobs" | "all") => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      const text = await f.text();
      try {
        const obj = JSON.parse(text);
        if (kind === "settings") {
          localStorage.setItem(KEY_SETTINGS, JSON.stringify(obj));
          // reload store
          useSettingsStore.getState().setSettings(obj);
        } else if (kind === "jobs") {
          localStorage.setItem(KEY_JOBS, JSON.stringify(obj));
          useJobsStore.getState().setJobs(Array.isArray(obj) ? obj : []);
        } else {
          if (obj.settings) {
            localStorage.setItem(KEY_SETTINGS, JSON.stringify(obj.settings));
            useSettingsStore.getState().setSettings(obj.settings);
          }
          if (obj.jobs) {
            localStorage.setItem(KEY_JOBS, JSON.stringify(obj.jobs));
            useJobsStore.getState().setJobs(Array.isArray(obj.jobs) ? obj.jobs : []);
          }
        }
        push({ kind: "success", title: "导入成功" });
      } catch (e: any) {
        push({ kind: "error", title: "导入失败", message: e?.message || "非法 JSON" });
      }
    };
    input.click();
  };

  return (
    <PageContainer>
      <PageTitle title="Settings" subtitle="浏览器配置中心：baseUrl / 默认参数 / 轮询 / UI / 数据管理" right={<Button onClick={save}>保存</Button>} />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">后端连接</div>
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
            <Field label="baseUrl">
              <Input value={baseUrl} onChange={setBaseUrl} placeholder="http://127.0.0.1:8000" />
            </Field>
            <Field label="jobAuthMode">
              <Select
                value={jobAuthMode}
                onChange={(v) => setJobAuthMode(v as any)}
                options={[
                  { value: "TOKEN", label: "TOKEN" },
                  { value: "ID_ONLY", label: "ID_ONLY" },
                ]}
              />
            </Field>
            <Field label="defaultModel">
              <Select
                value={String(defaultModel)}
                onChange={(v) => setDefaultModel(v as ModelId)}
                options={catalog.models.map((m) => ({ value: m.model_id, label: m.label }))}
              />
            </Field>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={testHealth} disabled={testing}>
              {testing ? "测试中…" : "测试连接"}
            </Button>
            <Button variant="ghost" onClick={() => {
              setHealth(null);
            }}>
              清空结果
            </Button>
          </div>
          {health ? (
            <div className="mt-3 rounded-2xl border border-zinc-200 bg-white/60 p-3 text-xs dark:border-white/10 dark:bg-zinc-950/30">
              <div className="font-bold text-zinc-900 dark:text-zinc-50">Health</div>
              {health?.__error?.error?.code === "NETWORK_ERROR" ? (
                <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
                  浏览器报 NETWORK_ERROR 但后端日志是 200，最常见原因是 <span className="font-semibold">CORS 拦截响应</span>。
                  也可能是 HTTPS 页面请求 HTTP（Mixed Content）或证书/代理问题。
                  请打开 DevTools Console/Network 查看是否有 CORS 报错，并在后端开启允许当前前端 Origin 的 CORS（尤其要允许 credentials 与 `X-Job-Token`）。
                </div>
              ) : null}
              <pre className="mt-2 max-h-40 overflow-auto rounded-xl bg-black/90 p-2 text-[11px] text-white">
                {JSON.stringify(health, null, 2)}
              </pre>
            </div>
          ) : null}
        </Card>

        <Card>
          <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">生图默认参数</div>
          <div className="mt-2 text-xs text-zinc-600 dark:text-zinc-300">
            提示：Create 和 Batch 页面都会自动保存未完成编辑（刷新网页也会保留）。这里仅提供“恢复默认”。
          </div>
          <Divider />
          <div className="grid grid-cols-2 gap-2 text-xs">
            <KeyValue k="model" v={settings.defaultModel as any} />
            <KeyValue k="aspect_ratio" v={currentDefaultParams.aspect_ratio as any} />
            <KeyValue k="image_size" v={currentDefaultParams.image_size as any} />
            <KeyValue k="thinking_level" v={(currentDefaultParams.thinking_level || "-") as any} />
            <KeyValue k="temperature" v={currentDefaultParams.temperature.toFixed(2)} />
            <KeyValue k="timeout_sec" v={`${currentDefaultParams.timeout_sec}s`} />
            <KeyValue k="max_retries" v={currentDefaultParams.max_retries as any} />
          </div>

          <div className="mt-3">
            <Button
              variant="secondary"
              onClick={() => {
                const resetByModel = Object.fromEntries(
                  catalog.models.map((m) => [m.model_id, normalizeDefaultParams(m.default_params)])
                ) as Record<string, DefaultParams>;
                const nextDefaultParams = resetByModel[DEFAULT_SETTINGS.defaultModel] || { ...DEFAULT_PARAMS_TEMPLATE };
                setSettings({
                  defaultModel: DEFAULT_SETTINGS.defaultModel,
                  defaultParams: nextDefaultParams,
                  defaultParamsByModel: resetByModel,
                });
                push({ kind: "success", title: "已恢复默认生图参数" });
              }}
            >
              恢复默认参数
            </Button>
          </div>
        </Card>

        {isAdmin ? (
          <Card className="lg:col-span-2">
            <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">控制台入口</div>
            {user ? (
              <div className="mt-3 flex items-center justify-between gap-3 rounded-2xl border border-zinc-200 bg-white/60 p-4 dark:border-white/10 dark:bg-zinc-950/30">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">Session</div>
                  <div className="mt-2 text-lg font-bold text-zinc-900 dark:text-zinc-50">{user.username}</div>
                  <div className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">系统侧运行状态、用户和策略管理可在管理页查看。</div>
                </div>
                <Button variant="secondary" onClick={() => nav("/admin")}>前往 Admin 页面</Button>
              </div>
            ) : (
              <div className="mt-3 text-sm text-zinc-600 dark:text-zinc-300">当前未登录。</div>
            )}
          </Card>
        ) : null}

        <Card>
          <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">轮询/性能</div>
          <div className="mt-3 space-y-3">
            <Field label={`polling.intervalMs (${intervalMs}ms)`}>
              <input type="range" min={300} max={5000} step={50} value={intervalMs} onChange={(e) => setIntervalMs(Number(e.target.value))} className="w-full" />
            </Field>
            <Field label={`polling.maxIntervalMs (${maxIntervalMs}ms)`}>
              <input type="range" min={800} max={15000} step={100} value={maxIntervalMs} onChange={(e) => setMaxIntervalMs(Number(e.target.value))} className="w-full" />
            </Field>
            <Field label={`并发刷新上限 (${concurrency})`}>
              <input type="range" min={1} max={12} step={1} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} className="w-full" />
            </Field>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">并发过高可能触发 429，需要降低刷新频率。</div>
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">Picker 调度参数</div>
          <div className="mt-2 text-xs text-zinc-600 dark:text-zinc-300">
            这些参数只影响 Picker 的下一次调度边界，不会强制打断当前正在看的屏幕。
          </div>
          <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label={<LabelWithHint label={`移动冷却 (${moveCooldownTurns} turn)`} hint="图片在 Filmstrip 和优选池之间移动后，冷却期间不会立刻回到展示区。" />}>
              <input type="range" min={1} max={6} step={1} value={moveCooldownTurns} onChange={(e) => setMoveCooldownTurns(Number(e.target.value))} className="w-full" />
            </Field>
            <Field label={<LabelWithHint label={`新图加分 (+${newArrivalBonus})`} hint="新流入 Filmstrip 的图片在前 2 个调度 turn 内获得额外优先级。" />}>
              <input type="range" min={0} max={120} step={5} value={newArrivalBonus} onChange={(e) => setNewArrivalBonus(Number(e.target.value))} className="w-full" />
            </Field>
            <Field label={<LabelWithHint label={`刚完成加分 (+${justCompletedBonus})`} hint="queued/running 刚转为 succeeded 的图片，在下一次调度中更容易进展示区。" />}>
              <input type="range" min={0} max={120} step={5} value={justCompletedBonus} onChange={(e) => setJustCompletedBonus(Number(e.target.value))} className="w-full" />
            </Field>
            <Field label={<LabelWithHint label={`未审图加分 (+${unseenBonus})`} hint="REVIEW_NEW 模式下，未审图的全局优先级偏置。" />}>
              <input type="range" min={0} max={180} step={5} value={unseenBonus} onChange={(e) => setUnseenBonus(Number(e.target.value))} className="w-full" />
            </Field>
            <Field label={<LabelWithHint label={`复筛紧迫度 (${resolveUrgencyWeight})`} hint="RESOLVE_FILMSTRIP 模式使用 abs(rating - 3) * weight，星级越极端越优先复筛。" />}>
              <input type="range" min={0} max={60} step={5} value={resolveUrgencyWeight} onChange={(e) => setResolveUrgencyWeight(Number(e.target.value))} className="w-full" />
            </Field>
            <Field label={<LabelWithHint label={`终筛高分偏置 (${polishRatingWeight})`} hint="POLISH_PICKED 模式使用 rating * weight，高分优选图会更靠前。" />}>
              <input type="range" min={0} max={24} step={1} value={polishRatingWeight} onChange={(e) => setPolishRatingWeight(Number(e.target.value))} className="w-full" />
            </Field>
            <Field label={<LabelWithHint label={`1-up 最近历史 (${recentHistoryOne})`} hint="1 图模式下，最近展示过的图片会被降权，避免来回重复。" />}>
              <input type="range" min={2} max={12} step={1} value={recentHistoryOne} onChange={(e) => setRecentHistoryOne(Number(e.target.value))} className="w-full" />
            </Field>
            <Field label={<LabelWithHint label={`2-up 最近历史 (${recentHistoryTwo})`} hint="2 图模式下，最近 1~3 屏展示过的图片会被降权。" />}>
              <input type="range" min={4} max={16} step={1} value={recentHistoryTwo} onChange={(e) => setRecentHistoryTwo(Number(e.target.value))} className="w-full" />
            </Field>
            <Field label={<LabelWithHint label={`4-up 最近历史 (${recentHistoryFour})`} hint="4 图模式下，历史长度越长，下一组越不容易重复刚看过的图。" />}>
              <input type="range" min={6} max={24} step={1} value={recentHistoryFour} onChange={(e) => setRecentHistoryFour(Number(e.target.value))} className="w-full" />
            </Field>
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">UI 偏好</div>
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="theme">
              <Select
                value={theme}
                onChange={(v) => setTheme(v as any)}
                options={[
                  { value: "system", label: "system" },
                  { value: "dark", label: "dark" },
                  { value: "light", label: "light" },
                ]}
              />
            </Field>
            <div className="flex items-center justify-between rounded-2xl border border-zinc-200 bg-white/60 p-3 dark:border-white/10 dark:bg-zinc-950/30">
              <div>
                <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">reduceMotion</div>
                <div className="text-xs text-zinc-600 dark:text-zinc-300">减少动效，适配易眩晕用户</div>
              </div>
              <Switch value={reduceMotion} onChange={setReduceMotion} />
            </div>
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">图片缓存</div>
          <div className="mt-2 text-xs text-zinc-600 dark:text-zinc-300">
            History 与 Picker 共用同一套预览缓存策略：当前标签页内会复用共享预览内存，浏览器持久缓存按当前登录用户隔离。Task Detail 原图仍按需读取浏览器持久缓存。默认保留 3 天且总上限 2 GB。
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="flex items-center justify-between rounded-2xl border border-zinc-200 bg-white/60 p-3 dark:border-white/10 dark:bg-zinc-950/30">
              <div>
                <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">启用缓存</div>
                <div className="text-xs text-zinc-600 dark:text-zinc-300">控制 History / Picker 共享预览缓存与浏览器持久缓存。关闭时会清空当前用户的共享与持久缓存。</div>
              </div>
              <Switch testId="settings-cache-enabled" value={cacheEnabled} onChange={setCacheEnabled} />
            </div>
            <Field label={`保留天数 (${cacheTtlDays}d)`}>
              <input
                data-testid="settings-cache-ttl"
                type="range"
                min={1}
                max={30}
                step={1}
                value={cacheTtlDays}
                onChange={(e) => setCacheTtlDays(Number(e.target.value))}
                className="w-full"
              />
            </Field>
            <Field label={`缓存上限 (${cacheMaxGb.toFixed(1)} GB)`}>
              <input
                data-testid="settings-cache-max"
                type="range"
                min={0.25}
                max={8}
                step={0.25}
                value={cacheMaxGb}
                onChange={(e) => setCacheMaxGb(Number(e.target.value))}
                className="w-full"
              />
            </Field>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
            <span className="rounded-full border border-zinc-200 bg-white px-3 py-1 dark:border-white/10 dark:bg-zinc-950/40">
              Persistent items {cacheStatsState.count}
            </span>
            <span className="rounded-full border border-zinc-200 bg-white px-3 py-1 dark:border-white/10 dark:bg-zinc-950/40">
              Persistent size {formatBytes(cacheStatsState.size)}
            </span>
            <Button
              variant="ghost"
              testId="settings-clear-cache"
              onClick={async () => {
                clearSharedPreviewMemory(user?.user_id || "__guest__");
                await imageCacheClear(user?.user_id || "__guest__");
                setCacheStatsState({ count: 0, size: 0 });
                push({ kind: "success", title: "已清空当前用户共享预览与持久缓存" });
              }}
            >
              清空共享/持久缓存
            </Button>
          </div>
        </Card>

        <Card>
          <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">数据管理</div>
          <div className="mt-3 space-y-2">
            <Button variant="secondary" onClick={() => {
              if (confirm("仅清空本地历史（不可恢复）？")) {
                clearJobs();
                push({ kind: "success", title: "已清空本地历史" });
              }
            }}>
              清空全部历史（本地）
            </Button>

            <Button variant="secondary" onClick={exportSettings}>导出设置 JSON</Button>
            <Button
              variant="secondary"
              onClick={() => {
                if (!confirm("导出历史会包含 job token（敏感）。确定继续？")) return;
                exportJobs();
              }}
            >
              导出历史 JSON（含 token）
            </Button>
            <Button variant="secondary" onClick={exportAll}>导出全部（settings+jobs）</Button>

            <Divider />

            <Button variant="ghost" onClick={() => importJson("settings")}>导入设置</Button>
            <Button variant="ghost" onClick={() => importJson("jobs")}>导入历史</Button>
            <Button variant="ghost" onClick={() => importJson("all")}>导入全部</Button>

            <Divider />

            <Button
              variant="danger"
              onClick={() => {
                if (confirm("恢复出厂设置（含设置项）？")) {
                  resetSettings();
                  push({ kind: "success", title: "已恢复设置默认值" });
                }
              }}
            >
              恢复默认设置
            </Button>

            <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">当前本地历史：{jobs.length} 条</div>
          </div>
        </Card>
      </div>
    </PageContainer>
  );
}

// -----------------------------
// Root App
// -----------------------------

export default function App() {
  useTheme();
  useAuthBootstrap();
  const { loading, session } = useAuthSession();

  return (
    <ToastProvider>
      <BrowserRouter>
        <ImageAccessGuardProvider>
          <ImageCacheJanitor />
          <div className="min-h-screen bg-gradient-to-b from-zinc-50 to-white text-zinc-900 dark:from-zinc-950 dark:to-zinc-950 dark:text-zinc-50">
            {loading ? (
              <div className="flex min-h-screen items-center justify-center px-4">
                <div className="rounded-[28px] border border-zinc-200 bg-white/80 px-8 py-10 text-center shadow-xl dark:border-white/10 dark:bg-zinc-950/70">
                  <div className="text-sm font-semibold uppercase tracking-[0.22em] text-zinc-500 dark:text-zinc-400">Session</div>
                  <div className="mt-3 text-2xl font-black text-zinc-950 dark:text-white">检查登录状态</div>
                  <div className="mt-3 flex items-center justify-center gap-2 text-sm text-zinc-600 dark:text-zinc-300">
                    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-900 dark:border-zinc-700 dark:border-t-white" />
                    正在同步后端 session…
                  </div>
                </div>
              </div>
            ) : session ? (
              <>
                <PickerSessionJobSync />
                <FailedBatchSessionCleanup />
                <PendingSessionDirectHydrator />
                <TopNav />
                <AnimatedRoutes />
                <Footer />
              </>
            ) : (
              <Routes>
                <Route path="*" element={<LoginPage />} />
              </Routes>
            )}
          </div>
        </ImageAccessGuardProvider>
      </BrowserRouter>
    </ToastProvider>
  );
}

function Footer() {
  return (
    <div className="mx-auto max-w-6xl px-4 pb-10 pt-6">
      <div className="rounded-2xl border border-zinc-200 bg-white/60 p-4 text-xs text-zinc-600 dark:border-white/10 dark:bg-zinc-950/30 dark:text-zinc-300">
        <div className="font-bold text-zinc-900 dark:text-zinc-50">提示</div>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>后端 API 前缀：<span className="font-mono">{`{BASE_URL}/v1`}</span>（本应用从 Settings.baseUrl 拼接）。</li>
          <li>历史列表只来自浏览器本地存储，不会也无法展示系统级全部 job。</li>
          <li>SSE 端点若需要 token header，原生 EventSource 无法带 header，会自动 fallback 到轮询。</li>
          <li>multipart 字段名（如 reference_images / prompt / params）如与后端不一致，请在 CreateJobPage 的 FormData 处对齐。</li>
        </ul>
      </div>
    </div>
  );
}
