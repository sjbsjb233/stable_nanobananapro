import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  BrowserRouter,
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
// - API client with headers (X-Job-Token / X-Admin-Key)
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

type JobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "UNKNOWN";

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
  temperature: number;
  timeout_sec: number;
  max_retries: number;
};

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
};

type JobRecord = {
  job_id: string;
  job_access_token?: string;
  model_cache?: ModelId;
  created_at: string; // ISO
  status_cache?: JobStatus;
  prompt_preview?: string;
  params_cache?: Partial<DefaultParams>;
  run_started_at?: string;
  run_finished_at?: string;
  queue_wait_ms?: number;
  run_duration_ms?: number;
  last_seen_at?: string;
  pinned?: boolean;
  tags?: string[];
  batch_id?: string;
  batch_size?: number;
  batch_index?: number;
  deleted?: boolean;
};

type PickerCompareMode = "TWO" | "FOUR" | "FILMSTRIP";

type PickerLayoutPreset = "SYNC_ZOOM" | "FREE_ZOOM";

type PickerItemRef = {
  job_id: string;
  image_id: string;
};

type PickerSessionItem = {
  job_id: string;
  job_access_token?: string;
  image_id: string;
  pool?: "FILMSTRIP" | "PREFERRED";
  label?: string;
  rating?: number;
  picked?: boolean;
  notes?: string;
  added_at: string;
};

type PickerSession = {
  session_id: string;
  name: string;
  created_at: string;
  updated_at: string;
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
  type?: string;
  message?: string;
  debug_id?: string;
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

// Admin billing

type BillingSummary = {
  budget_usd?: number;
  spent_usd?: number;
  remaining_usd?: number;
  last_updated_at?: string;
  mode?: string;
  [k: string]: any;
};

type GoogleRemaining = {
  google_remaining_usd?: number;
  notes?: string;
  last_updated_at?: string;
  [k: string]: any;
};

// -----------------------------
// Storage keys
// -----------------------------

const KEY_SETTINGS = "nbp_settings_v1";
const KEY_JOBS = "nbp_jobs_v1";
const KEY_DASH_CACHE = "nbp_dashboard_cache_v1";
const KEY_PICKER_SESSIONS = "nbp_picker_sessions_v1";
const KEY_PICKER_RECENT = "nbp_picker_recent_v1";
const KEY_HISTORY_AUTO_REFRESH_PREF = "nbp_history_auto_refresh_pref_v1";

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

function pickerItemKey(item: PickerItemRef) {
  return `${item.job_id}::${item.image_id}`;
}

function pickerItemKeyFrom(job_id: string, image_id: string) {
  return `${job_id}::${image_id}`;
}

function pickerItemRefFromKey(key?: string | null): PickerItemRef | undefined {
  if (!key || !key.includes("::")) return undefined;
  const [job_id, image_id] = key.split("::");
  if (!job_id || !image_id) return undefined;
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
const FALLBACK_BASE_URL =
  typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.hostname}:8000`
    : "http://127.0.0.1:8000";

const DEFAULT_PARAMS_TEMPLATE: DefaultParams = {
  aspect_ratio: "1:1",
  image_size: "1K",
  thinking_level: null,
  temperature: 0.7,
  timeout_sec: 120,
  max_retries: 1,
};

const DEFAULT_SETTINGS: SettingsV1 = {
  baseUrl: ENV_BASE_URL || FALLBACK_BASE_URL,
  defaultModel: "gemini-3-pro-image-preview",
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
};

const FALLBACK_MODEL_CATALOG: ModelsPayload = {
  default_model: "gemini-3-pro-image-preview",
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
      default_params: { aspect_ratio: "1:1", image_size: "1K", thinking_level: "High", temperature: 0.7, timeout_sec: 120, max_retries: 1 },
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
      default_params: { aspect_ratio: "1:1", image_size: "AUTO", thinking_level: null, temperature: 0.7, timeout_sec: 120, max_retries: 1 },
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
      default_params: { aspect_ratio: "1:1", image_size: "1K", thinking_level: null, temperature: 0.7, timeout_sec: 120, max_retries: 1 },
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

type JobsStore = {
  jobs: JobRecord[];
  setJobs: (jobs: JobRecord[]) => void;
  upsertJob: (rec: JobRecord) => void;
  updateJob: (job_id: string, patch: Partial<JobRecord>) => void;
  removeJob: (job_id: string) => void;
  clearJobs: () => void;
};

const useJobsStore = create<JobsStore>((set, get) => {
  const persisted = safeJsonParse<JobRecord[]>(storageGet(KEY_JOBS), []);
  // normalize
  const jobs = Array.isArray(persisted) ? persisted : [];
  storageSet(KEY_JOBS, JSON.stringify(jobs));

  const setAndPersist = (next: JobRecord[]) => {
    storageSet(KEY_JOBS, JSON.stringify(next));
    set({ jobs: next });
  };

  return {
    jobs,
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

function createPickerSession(name?: string): PickerSession {
  const now = isoNow();
  return {
    session_id: `pk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name: (name || "").trim() || `挑选会话 ${new Date().toLocaleDateString()}`,
    created_at: now,
    updated_at: now,
    items: [],
    compare_mode: "TWO",
    layout_preset: "SYNC_ZOOM",
    ui: {
      background: "dark",
      showGrid: false,
      showInfo: false,
    },
    slots: [null, null, null, null],
    focus_key: null,
  };
}

function normalizePickerSession(raw: any): PickerSession {
  const now = isoNow();
  const session: PickerSession = {
    session_id: String(raw?.session_id || `pk_${Math.random().toString(36).slice(2, 10)}`),
    name: String(raw?.name || "未命名会话"),
    created_at: String(raw?.created_at || now),
    updated_at: String(raw?.updated_at || raw?.created_at || now),
    cover:
      raw?.cover?.job_id && raw?.cover?.image_id
        ? { job_id: String(raw.cover.job_id), image_id: String(raw.cover.image_id) }
        : undefined,
    items: Array.isArray(raw?.items)
      ? raw.items
          .map((it: any) => {
            if (!it?.job_id || !it?.image_id) return null;
            return {
              job_id: String(it.job_id),
              job_access_token: it.job_access_token ? String(it.job_access_token) : undefined,
              image_id: String(it.image_id),
              pool: it.pool === "PREFERRED" ? "PREFERRED" : "FILMSTRIP",
              label: it.label ? String(it.label) : undefined,
              rating: typeof it.rating === "number" ? clamp(Math.round(it.rating), 1, 5) : undefined,
              picked: it.picked !== undefined ? Boolean(it.picked) : true,
              notes: it.notes ? String(it.notes) : undefined,
              added_at: String(it.added_at || now),
            } as PickerSessionItem;
          })
          .filter(Boolean) as PickerSessionItem[]
      : [],
    best_image:
      raw?.best_image?.job_id && raw?.best_image?.image_id
        ? { job_id: String(raw.best_image.job_id), image_id: String(raw.best_image.image_id) }
        : undefined,
    compare_mode: raw?.compare_mode === "FOUR" || raw?.compare_mode === "FILMSTRIP" ? raw.compare_mode : "TWO",
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
  };
  while (session.slots.length < 4) session.slots.push(null);
  return session;
}

function normalizePickerSessions(raw: any): PickerSession[] {
  const list = Array.isArray(raw) ? raw : [];
  const sessions = list.map((x) => normalizePickerSession(x));
  return sessions.sort((a, b) => (new Date(b.updated_at).getTime() || 0) - (new Date(a.updated_at).getTime() || 0));
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
        const normalizedNew = items
          .map((it) => ({
            ...it,
            pool: it.pool === "PREFERRED" ? "PREFERRED" : "FILMSTRIP",
            picked: it.picked !== undefined ? it.picked : true,
            added_at: it.added_at || isoNow(),
          }))
          .filter((it) => !existing.has(pickerItemKey(it)));
        if (!normalizedNew.length) return session;

        const slots = [...session.slots];
        normalizedNew.forEach((item) => {
          const key = pickerItemKey(item);
          const emptyIndex = slots.findIndex((x) => !x);
          if (emptyIndex >= 0) {
            slots[emptyIndex] = key;
            item.label = item.label || String.fromCharCode(65 + emptyIndex);
          }
        });

        const focus_key = session.focus_key || slots.find(Boolean) || pickerItemKey(normalizedNew[0]);
        const cover = session.cover || { job_id: normalizedNew[0].job_id, image_id: normalizedNew[0].image_id };
        return {
          ...session,
          items: [...session.items, ...normalizedNew],
          slots,
          cover,
          focus_key,
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
  adminModeEnabled: boolean;
  adminKey: string;

  constructor(settings: SettingsV1) {
    this.baseUrl = settings.baseUrl.replace(/\/$/, "");
    this.jobAuthMode = settings.jobAuthMode;
    this.adminModeEnabled = settings.adminModeEnabled;
    this.adminKey = settings.adminKey;
  }

  private buildUrl(path: string) {
    return `${this.baseUrl}/v1${path.startsWith("/") ? path : `/${path}`}`;
  }

  private async request<T>(
    path: string,
    init: RequestInit & { jobToken?: string; isAdmin?: boolean } = {}
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

    // Admin auth header
    if (init.isAdmin && this.adminModeEnabled && this.adminKey) {
      headers["X-Admin-Key"] = this.adminKey;
    }

    let resp: Response;
    try {
      resp = await fetch(url, { ...init, headers });
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

  listModels(signal?: AbortSignal) {
    return this.request<ModelsPayload>("/models", { method: "GET", signal });
  }

  createJobJSON(payload: any, signal?: AbortSignal) {
    return this.request<any>("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
  }

  createJobMultipart(form: FormData, signal?: AbortSignal) {
    // NOTE: Do NOT set Content-Type explicitly for FormData.
    return this.request<any>("/jobs", {
      method: "POST",
      body: form,
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
    return fetch(url, { method: "GET", headers, signal }).then(async (r) => {
      if (!r.ok) {
        logWarn("api", "image download failed", {
          path: `/jobs/${job_id}/images/${image_id}`,
          status: r.status,
        });
        const err: ApiError = { error: { code: String(r.status), message: r.statusText || "Image download failed" } };
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

  // Admin
  billingSummary(signal?: AbortSignal) {
    return this.request<BillingSummary>("/billing/summary", { method: "GET", isAdmin: true, signal });
  }

  billingGoogleRemaining(signal?: AbortSignal) {
    return this.request<GoogleRemaining>("/billing/google/remaining", {
      method: "GET",
      isAdmin: true,
      signal,
    });
  }
}

function useApiClient() {
  const settings = useSettingsStore((s) => s.settings);
  return useMemo(() => new ApiClient(settings), [settings.baseUrl, settings.jobAuthMode, settings.adminKey, settings.adminModeEnabled]);
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

// -----------------------------
// UI primitives
// -----------------------------

function Card({
  children,
  className,
  hover = true,
}: {
  children: React.ReactNode;
  className?: string;
  hover?: boolean;
}) {
  return (
    <div
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
}: {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
  variant?: "primary" | "ghost" | "danger" | "secondary";
  title?: string;
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
    <button type={type || "button"} title={title} disabled={disabled} onClick={onClick} className={cn(base, styles, className)}>
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
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  type?: string;
}) {
  return (
    <input
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
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  rows?: number;
}) {
  return (
    <textarea
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
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  className?: string;
}) {
  return (
    <select
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

function Switch({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
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

function Badge({ status }: { status: JobStatus }) {
  const s = status;
  const style =
    s === "SUCCEEDED"
      ? "bg-emerald-500/15 text-emerald-700 border-emerald-200 dark:text-emerald-200 dark:border-emerald-900"
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
              <span className="text-xs">Auth: {settings.jobAuthMode}</span>
              <span className="mx-2 text-zinc-300 dark:text-white/20">•</span>
              <span className="text-xs">Model: {settings.defaultModel}</span>
              {settings.adminModeEnabled ? (
                <>
                  <span className="mx-2 text-zinc-300 dark:text-white/20">•</span>
                  <span className="text-xs font-semibold text-amber-700 dark:text-amber-200">Admin</span>
                </>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <NavButton to="/" label="Dashboard" />
          <NavButton to="/create" label="Create" />
          <NavButton to="/history" label="History" />
          <NavButton to="/picker" label="Picker" />
          <NavButton to="/settings" label="Settings" />
          <Button variant="primary" onClick={() => navigate("/create")} className="ml-1">
            + 快速创建
          </Button>
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

function PageContainer({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-6xl px-4 py-6">{children}</div>;
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

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div key={location.pathname + location.search} {...(page as any)} transition={transition}>
        <Routes location={location}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/create" element={<CreateJobPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/picker" element={<PickerPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </motion.div>
    </AnimatePresence>
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

  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<DashboardStat | null>(null);
  const [admin, setAdmin] = useState<{ summary?: BillingSummary; google?: GoogleRemaining } | null>(null);

  const refresh = async () => {
    const today = new Date().toISOString().slice(0, 10);

    // cache read (best effort)
    const cache = safeJsonParse<DashboardCache | null>(storageGet(KEY_DASH_CACHE), null);
    if (cache?.date === today && cache?.stats) {
      setStats(cache.stats);
    }

    setLoading(true);
    try {
      const list = [...jobs]
        .filter((j) => !j.deleted)
        .sort((a, b) => (new Date(b.created_at).getTime() || 0) - (new Date(a.created_at).getTime() || 0));

      // limit number of fetches for v1
      const MAX = list.length > 200 ? 50 : Math.min(200, list.length);
      const subset = list.slice(0, MAX);

      const metas = await mapLimit(subset, clamp(settings.polling.concurrency || 5, 1, 12), async (rec) => {
        try {
          const meta = await client.getJob(rec.job_id, rec.job_access_token);
          // update cache fields
          useJobsStore.getState().updateJob(rec.job_id, {
            status_cache: (meta.status || rec.status_cache || "UNKNOWN") as JobStatus,
            last_seen_at: isoNow(),
            ...jobTimingPatch(meta),
          });
          return meta;
        } catch (e: any) {
          // do not fail the page
          return null;
        }
      });

      // align metas array with sorted list indexing in computeDashboard
      // computeDashboard expects metas aligned with sorted jobs (same indices)
      const alignedMetas: Array<JobMeta | null> = [];
      for (let i = 0; i < list.length; i++) {
        alignedMetas.push(i < subset.length ? metas[i] : null);
      }

      const computed = computeDashboard(list, alignedMetas);
      setStats(computed);
      storageSet(
        KEY_DASH_CACHE,
        JSON.stringify({ date: today, computed_at: isoNow(), stats: computed } satisfies DashboardCache)
      );

      if (settings.adminModeEnabled) {
        try {
          const [summary, google] = await Promise.all([
            client.billingSummary(),
            client.billingGoogleRemaining().catch(() => null as any),
          ]);
          setAdmin({ summary, google: google || undefined });
        } catch (e: any) {
          setAdmin(null);
        }
      } else {
        setAdmin(null);
      }

      push({ kind: "success", title: "Dashboard 已刷新" });
    } catch (e: any) {
      push({ kind: "error", title: "刷新失败", message: e?.error?.message || "请检查网络/后端地址" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.baseUrl, settings.adminModeEnabled, settings.adminKey]);

  return { loading, stats, admin, refresh };
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
  const { loading, stats, admin, refresh } = useDashboardData();
  const { transition } = useMotionConfig();
  const nav = useNavigate();

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
          <Button onClick={refresh} variant="secondary">
            <motion.span
              animate={loading ? { rotate: 360 } : { rotate: 0 }}
              transition={loading ? { repeat: Infinity, duration: 1, ease: "linear" } : transition}
              className="inline-block"
            >
              ⟳
            </motion.span>
            刷新
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

        <Card>
          <div>
            <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">管理员区块</div>
            <div className="text-xs text-zinc-600 dark:text-zinc-300">仅在 Settings 开启 Admin 模式后显示</div>
          </div>
          <Divider />
          {!admin ? (
            <EmptyHint text="未开启或无权限" />
          ) : (
            <div className="space-y-3">
              <KeyValue k="Budget" v={currency(admin.summary?.budget_usd)} />
              <KeyValue k="Spent" v={currency(admin.summary?.spent_usd)} />
              <KeyValue k="Remaining" v={currency(admin.summary?.remaining_usd)} />
              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                {admin.summary?.mode ? `Mode: ${admin.summary.mode}` : ""}
                {admin.summary?.last_updated_at ? ` · ${formatLocal(admin.summary.last_updated_at)}` : ""}
              </div>
              <Divider />
              <KeyValue k="Google Remaining" v={currency(admin.google?.google_remaining_usd)} />
              {admin.google?.notes ? (
                <div className="text-xs text-zinc-600 dark:text-zinc-300">{admin.google.notes}</div>
              ) : null}
            </div>
          )}
        </Card>
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


function CreateJobPage() {
  const client = useApiClient();
  const catalog = useModelCatalog();
  const { push } = useToast();
  const navigate = useNavigate();
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const updateDefaultParams = useSettingsStore((s) => s.updateDefaultParams);

  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [model, setModel] = useState<ModelId>(settings.defaultModel || catalog.default_model);
  const [mode, setMode] = useState<CreateMode>("IMAGE_ONLY");

  const initParams = getParamsForModel(settings, settings.defaultModel || catalog.default_model);
  const [aspect, setAspect] = useState<AspectRatio>(initParams.aspect_ratio);
  const [size, setSize] = useState<ImageSize>(initParams.image_size);
  const [thinkingLevel, setThinkingLevel] = useState<string | null>(initParams.thinking_level ?? null);
  const [temperature, setTemperature] = useState<number>(initParams.temperature);
  const [timeoutSec, setTimeoutSec] = useState<number>(initParams.timeout_sec);
  const [maxRetries, setMaxRetries] = useState<number>(initParams.max_retries);
  const [jobCount, setJobCount] = useState<number>(1);

  const [loading, setLoading] = useState(false);
  const hydratedModelRef = useRef<ModelId | null>(null);
  const lastPasteAtRef = useRef<number>(0);
  const MAX_REF_FILES = 14;

  const currentModel = useMemo(() => {
    return (
      catalog.models.find((m) => m.model_id === model) ||
      catalog.models.find((m) => m.model_id === catalog.default_model) ||
      catalog.models[0]
    );
  }, [catalog, model]);

  useEffect(() => {
    if (!currentModel) return;
    if (!catalog.models.some((m) => m.model_id === model)) {
      setModel(currentModel.model_id);
    }
  }, [catalog.models, currentModel, model]);

  useEffect(() => {
    if (!currentModel) return;
    if (hydratedModelRef.current === model) return;
    const saved = getParamsForModel(settings, model, currentModel.default_params);
    setAspect(saved.aspect_ratio as AspectRatio);
    setSize(saved.image_size as ImageSize);
    setThinkingLevel(saved.thinking_level ?? null);
    setTemperature(saved.temperature);
    setTimeoutSec(saved.timeout_sec);
    setMaxRetries(saved.max_retries);
    hydratedModelRef.current = model;
  }, [currentModel, model, settings.defaultModel, settings.defaultParams, settings.defaultParamsByModel]);

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
      const changed =
        cur.aspect_ratio !== aspect ||
        cur.image_size !== nextImageSize ||
        (cur.thinking_level || null) !== nextThinkingLevel ||
        cur.temperature !== temperature ||
        cur.timeout_sec !== timeoutSec ||
        cur.max_retries !== maxRetries;
      if (changed) {
        updateDefaultParams(model, {
          aspect_ratio: aspect,
          image_size: nextImageSize,
          thinking_level: nextThinkingLevel,
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
    temperature,
    timeoutSec,
    maxRetries,
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

  const onSubmit = async () => {
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
        temperature,
        timeout_sec: timeoutSec,
        max_retries: maxRetries,
      };

      const targetCount = clamp(Math.round(jobCount), 1, 12);
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
            resp = await client.createJobMultipart(form, abort.signal);
          } else {
            resp = await client.createJobJSON({ prompt, model, mode: effectiveMode, params }, abort.signal);
          }
        } catch (err: any) {
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
          status_cache: "QUEUED",
          prompt_preview: toPreview(prompt),
          params_cache: {
            aspect_ratio: params.aspect_ratio,
            image_size: params.image_size,
            thinking_level: params.thinking_level,
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
      }

      if (!created.length) {
        throw { error: { code: "BAD_RESPONSE", message: firstErr || "创建失败" } };
      }

      // remember last used as defaults for this model
      updateDefaultParams(model, params);

      if (created.length === 1) {
        push({ kind: "success", title: "创建成功", message: `job_id: ${shortId(created[0].job_id)}` });
        navigate(`/history?job=${encodeURIComponent(created[0].job_id)}`);
      } else {
        const failed = targetCount - created.length;
        push({
          kind: failed > 0 ? "info" : "success",
          title: `批量创建完成：${created.length}/${targetCount}`,
          message: failed > 0 ? `有 ${failed} 个请求失败（${firstErr || "请检查后端日志"}）` : `已创建 ${created.length} 个任务`,
        });
        navigate(`/history?job=${encodeURIComponent(created[0].job_id)}`);
      }
    } catch (e: any) {
      push({ kind: "error", title: "创建失败", message: e?.error?.message || "请检查后端/参数" });
    } finally {
      setLoading(false);
      abort.abort();
    }
  };

  return (
    <PageContainer>
      <PageTitle
        title="Create Job"
        subtitle="支持纯文本 prompt 或 文本 + 多参考图（最多 14 张）。"
        right={
          <Button variant="secondary" onClick={() => {
            setPrompt("");
            setFiles([]);
            setJobCount(1);
            push({ kind: "info", title: "已清空" });
          }}>
            清空
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">Prompt</div>
          <div className="mt-2">
            <TextArea
              value={prompt}
              onChange={setPrompt}
              rows={6}
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
        </Card>

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
                onChange={(v) => setModel(v as ModelId)}
                options={catalog.models.map((m) => ({ value: m.model_id, label: `${m.label} (${m.model_id})` }))}
              />
            </Field>

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

            <Field label={`temperature (${temperature.toFixed(2)})`}>
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

            <Field label={`timeout_sec (${timeoutSec}s)`}>
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

            <Field label={`max_retries (${maxRetries})`}>
              <input
                type="range"
                min={0}
                max={3}
                step={1}
                value={maxRetries}
                onChange={(e) => setMaxRetries(Number(e.target.value))}
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
    </PageContainer>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold text-zinc-500 dark:text-zinc-400">{label}</div>
      {children}
    </div>
  );
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
        status_cache: (m.status || "UNKNOWN") as JobStatus,
        model_cache: (m.model as ModelId) || undefined,
        last_seen_at: isoNow(),
        ...jobTimingPatch(m),
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
        // If your backend requires X-Job-Token for SSE, consider switching to fetch-stream.
        const url = `${settings.baseUrl.replace(/\/$/, "")}/v1/jobs/${encodeURIComponent(jobId)}/events`;
        const es = new EventSource(url);
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
            if (data?.status === "SUCCEEDED" || data?.status === "FAILED") {
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
        if (st === "SUCCEEDED" || st === "FAILED") break;
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

// -----------------------------
// History Page
// -----------------------------

type SortKey = "latest" | "cost" | "latency";

type DateRange = "today" | "7d" | "custom" | "all";

type HistoryBatchGroup = {
  key: string;
  batchId: string | null;
  items: JobRecord[];
};

function HistoryPage() {
  const { push } = useToast();
  const client = useApiClient();
  const catalog = useModelCatalog();
  const navigate = useNavigate();
  const settings = useSettingsStore((s) => s.settings);
  const jobs = useJobsStore((s) => s.jobs);
  const updateJob = useJobsStore((s) => s.updateJob);
  const removeJob = useJobsStore((s) => s.removeJob);

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
  const [size, setSize] = useState<ImageSize | "ALL">("ALL");
  const [aspect, setAspect] = useState<AspectRatio | "ALL">("ALL");
  const [sort, setSort] = useState<SortKey>("latest");
  const [manualAutoRefresh, setManualAutoRefresh] = useState(false);
  const [disableActiveAutoRefresh, setDisableActiveAutoRefresh] = useState<boolean>(() =>
    safeJsonParse<boolean>(storageGet(KEY_HISTORY_AUTO_REFRESH_PREF), false)
  );
  const [pageSize, setPageSize] = useState<number>(20);
  const [page, setPage] = useState<number>(1);
  const [progressNowMs, setProgressNowMs] = useState<number>(() => Date.now());

  const filtered = useMemo(() => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const d7 = new Date(daysAgoISO(7)).getTime();

    const tokens = qd.trim().toLowerCase();

    const inDateRange = (j: JobRecord) => {
      const t = new Date(j.created_at).getTime();
      if (!Number.isFinite(t)) return true;
      if (range === "today") return t >= todayStart;
      if (range === "7d") return t >= d7;
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
        const hay = `${j.job_id} ${j.model_cache || ""} ${(j.prompt_preview || "")} ${(j.tags || []).join(" ")}`.toLowerCase();
        return hay.includes(tokens);
      });
    }

    if (statusFilter !== "ALL") {
      list = list.filter((j) => (j.status_cache || "UNKNOWN") === statusFilter);
    }

    if (modelFilter !== "ALL") {
      list = list.filter((j) => (j.model_cache || "") === modelFilter);
    }

    if (size !== "ALL") {
      list = list.filter((j) => (j.params_cache?.image_size || "") === size);
    }

    if (aspect !== "ALL") {
      list = list.filter((j) => (j.params_cache?.aspect_ratio || "") === aspect);
    }

    list = list.filter(inDateRange);

    // sort
    if (sort === "latest") {
      list.sort((a, b) => {
        const ap = a.pinned ? 1 : 0;
        const bp = b.pinned ? 1 : 0;
        if (ap !== bp) return bp - ap;
        return (new Date(b.created_at).getTime() || 0) - (new Date(a.created_at).getTime() || 0);
      });
    } else if (sort === "cost") {
      // we only have cached fields; use status_cache for quick ordering; real cost shown in detail
      // Put pinned on top still
      list.sort((a, b) => {
        const ap = a.pinned ? 1 : 0;
        const bp = b.pinned ? 1 : 0;
        if (ap !== bp) return bp - ap;
        // fallback: newer first
        return (new Date(b.created_at).getTime() || 0) - (new Date(a.created_at).getTime() || 0);
      });
    } else {
      list.sort((a, b) => {
        const ap = a.pinned ? 1 : 0;
        const bp = b.pinned ? 1 : 0;
        if (ap !== bp) return bp - ap;
        const ad = typeof a.run_duration_ms === "number" ? a.run_duration_ms : -1;
        const bd = typeof b.run_duration_ms === "number" ? b.run_duration_ms : -1;
        if (ad !== bd) return bd - ad;
        return (new Date(b.created_at).getTime() || 0) - (new Date(a.created_at).getTime() || 0);
      });
    }

    return list;
  }, [jobs, qd, statusFilter, range, from, to, modelFilter, size, aspect, sort]);

  const hasActiveJobs = useMemo(
    () => filtered.some((j) => isActiveJobStatus(j.status_cache || "UNKNOWN")),
    [filtered]
  );
  const autoRefresh = manualAutoRefresh || (hasActiveJobs && !disableActiveAutoRefresh);

  const recentSuccessAvgDurationMs = useMemo(() => {
    const succeeded = [...jobs]
      .filter((j) => !j.deleted && (j.status_cache || "UNKNOWN") === "SUCCEEDED" && typeof j.run_duration_ms === "number")
      .sort((a, b) => {
        const at = new Date(a.run_finished_at || a.created_at).getTime() || 0;
        const bt = new Date(b.run_finished_at || b.created_at).getTime() || 0;
        return bt - at;
      })
      .slice(0, 10)
      .map((j) => j.run_duration_ms as number)
      .filter((v) => Number.isFinite(v) && v >= 0);
    return succeeded.length ? mean(succeeded) : 45000;
  }, [jobs]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = clamp(page, 1, totalPages);
  const pagedItems = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, safePage, pageSize]);
  const groupedPagedItems = useMemo<HistoryBatchGroup[]>(() => {
    const grouped = new Map<string, HistoryBatchGroup>();
    for (const rec of pagedItems) {
      const batchId = rec.batch_id && (rec.batch_size || 0) > 1 ? rec.batch_id : null;
      const key = batchId ? `batch:${batchId}` : `single:${rec.job_id}`;
      const found = grouped.get(key);
      if (found) {
        found.items.push(rec);
      } else {
        grouped.set(key, { key, batchId, items: [rec] });
      }
    }
    return Array.from(grouped.values()).map((group) => ({
      ...group,
      items: [...group.items].sort((a, b) => {
        const ai = typeof a.batch_index === "number" ? a.batch_index : Number.MAX_SAFE_INTEGER;
        const bi = typeof b.batch_index === "number" ? b.batch_index : Number.MAX_SAFE_INTEGER;
        if (ai !== bi) return ai - bi;
        return (new Date(a.created_at).getTime() || 0) - (new Date(b.created_at).getTime() || 0);
      }),
    }));
  }, [pagedItems]);
  const batchedGroupCount = useMemo(
    () => groupedPagedItems.filter((g) => g.batchId && g.items.length > 1).length,
    [groupedPagedItems]
  );
  const batchedJobCount = useMemo(
    () => groupedPagedItems
      .filter((g) => g.batchId && g.items.length > 1)
      .reduce((sum, g) => sum + g.items.length, 0),
    [groupedPagedItems]
  );

  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);

  useEffect(() => {
    setPage(1);
  }, [qd, statusFilter, range, from, to, modelFilter, size, aspect, sort, pageSize]);

  useEffect(() => {
    storageSet(KEY_HISTORY_AUTO_REFRESH_PREF, JSON.stringify(disableActiveAutoRefresh));
  }, [disableActiveAutoRefresh]);

  useEffect(() => {
    if (!hasActiveJobs) return;
    const t = setInterval(() => setProgressNowMs(Date.now()), 500);
    return () => clearInterval(t);
  }, [hasActiveJobs]);

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

  // Auto refresh visible jobs status
  useEffect(() => {
    if (!autoRefresh) return;

    const controller = new AbortController();
    const tick = async () => {
      const visible = pagedItems.slice(0, Math.max(15, Math.min(pageSize, 50)));
      await mapLimit(visible, clamp(settings.polling.concurrency || 5, 1, 12), async (rec) => {
        try {
          const meta = await client.getJob(rec.job_id, rec.job_access_token, controller.signal);
          updateJob(rec.job_id, {
            status_cache: (meta.status || "UNKNOWN") as JobStatus,
            model_cache: (meta.model as ModelId) || rec.model_cache,
            last_seen_at: isoNow(),
            ...jobTimingPatch(meta),
          });
        } catch {
          // ignore
        }
      });
    };

    tick();
    const t = setInterval(tick, clamp(settings.polling.intervalMs || 1200, 300, 10000));
    return () => {
      controller.abort();
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, pagedItems, pageSize, settings.baseUrl, settings.polling.intervalMs, settings.polling.concurrency]);

  const selectJob = (id: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("job", id);
      return next;
    });
  };

  const onDeleteLocal = (id: string) => {
    removeJob(id);
    push({ kind: "success", title: "已删除本地记录" });
    if (selectedJobId === id) {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete("job");
        return next;
      });
    }
  };

  const onTogglePin = (id: string, v: boolean) => {
    updateJob(id, { pinned: v });
  };

  const onAddTag = (id: string) => {
    const tag = prompt("输入 tag（逗号分隔可多标签）：");
    if (!tag) return;
    const tags = tag
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const cur = jobs.find((j) => j.job_id === id);
    const next = Array.from(new Set([...(cur?.tags || []), ...tags]));
    updateJob(id, { tags: next });
    push({ kind: "success", title: "已添加标签" });
  };

  const filteredActiveCount = filtered.filter((j) => isActiveJobStatus(j.status_cache || "UNKNOWN")).length;
  const pageFrom = filtered.length ? (safePage - 1) * pageSize + 1 : 0;
  const pageTo = Math.min(filtered.length, safePage * pageSize);

  return (
    <PageContainer>
      <PageTitle
        title="History"
        subtitle="只读浏览器本地历史（localStorage）。支持按同批次创建任务聚合展示，便于快速识别同一套 Prompt 的多 job。"
        right={
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 rounded-2xl border border-zinc-200 bg-white/60 px-3 py-2 text-sm dark:border-white/10 dark:bg-zinc-900/40">
              <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">自动刷新</span>
              <Switch value={autoRefresh} onChange={onToggleAutoRefresh} />
              {hasActiveJobs ? (
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-200">
                  RUNNING 默认开启
                </span>
              ) : null}
            </div>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[320px_minmax(0,1fr)]">
        <Card className="h-fit xl:sticky xl:top-20">
          <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">筛选</div>
          <div className="mt-3 space-y-3">
            <Field label="搜索（prompt / tag / job_id）">
              <Input value={q} onChange={setQ} placeholder="输入关键词…" />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="状态">
                <Select
                  value={statusFilter}
                  onChange={(v) => setStatusFilter(v as any)}
                  options={[
                    { value: "ALL", label: "全部" },
                    { value: "SUCCEEDED", label: "SUCCEEDED" },
                    { value: "FAILED", label: "FAILED" },
                    { value: "RUNNING", label: "RUNNING" },
                    { value: "QUEUED", label: "QUEUED" },
                  ]}
                />
              </Field>
              <Field label="日期范围">
                <Select
                  value={range}
                  onChange={(v) => setRange(v as any)}
                  options={[
                    { value: "all", label: "全部" },
                    { value: "today", label: "今天" },
                    { value: "7d", label: "近 7 天" },
                    { value: "custom", label: "自定义" },
                  ]}
                />
              </Field>
            </div>

            {range === "custom" ? (
              <div className="grid grid-cols-2 gap-3">
                <Field label="From">
                  <Input value={from} onChange={setFrom} type="date" />
                </Field>
                <Field label="To">
                  <Input value={to} onChange={setTo} type="date" />
                </Field>
              </div>
            ) : null}

            <div className="grid grid-cols-2 gap-3">
              <Field label="model">
                <Select
                  value={String(modelFilter)}
                  onChange={(v) => setModelFilter(v as any)}
                  options={[
                    { value: "ALL", label: "全部" },
                    ...catalog.models.map((m) => ({ value: m.model_id, label: m.label })),
                  ]}
                />
              </Field>
              <Field label="image_size">
                <Select
                  value={String(size)}
                  onChange={(v) => setSize(v as any)}
                  options={[
                    { value: "ALL", label: "全部" },
                    { value: "AUTO", label: "AUTO" },
                    { value: "512", label: "512" },
                    { value: "1K", label: "1K" },
                    { value: "2K", label: "2K" },
                    { value: "4K", label: "4K" },
                  ]}
                />
              </Field>
              <Field label="aspect_ratio">
                <Select
                  value={String(aspect)}
                  onChange={(v) => setAspect(v as any)}
                  options={[
                    { value: "ALL", label: "全部" },
                    { value: "1:1", label: "1:1" },
                    { value: "1:4", label: "1:4" },
                    { value: "1:8", label: "1:8" },
                    { value: "4:1", label: "4:1" },
                    { value: "8:1", label: "8:1" },
                    { value: "21:9", label: "21:9" },
                    { value: "4:3", label: "4:3" },
                    { value: "3:4", label: "3:4" },
                    { value: "16:9", label: "16:9" },
                    { value: "9:16", label: "9:16" },
                    { value: "2:3", label: "2:3" },
                    { value: "3:2", label: "3:2" },
                    { value: "4:5", label: "4:5" },
                    { value: "5:4", label: "5:4" },
                  ]}
                />
              </Field>
            </div>

            <Field label="排序">
              <Select
                value={sort}
                onChange={(v) => setSort(v as any)}
                options={[
                  { value: "latest", label: "最新" },
                  { value: "cost", label: "成本优先" },
                  { value: "latency", label: "最耗时" },
                ]}
              />
            </Field>

            <Divider />

            <div className="text-xs text-zinc-500 dark:text-zinc-400">
              说明：后端不提供用户级历史列表，列表完全来自浏览器 localStorage。
            </div>
          </div>
        </Card>

        <div className="space-y-3">
          <Card className="p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-600 dark:text-zinc-300">
                <span className="rounded-full border border-zinc-200 bg-white/60 px-2 py-1 dark:border-white/10 dark:bg-zinc-900/40">
                  总计 {filtered.length} 条
                </span>
                <span className="rounded-full border border-zinc-200 bg-white/60 px-2 py-1 dark:border-white/10 dark:bg-zinc-900/40">
                  活跃 {filteredActiveCount} 条
                </span>
                <span className="rounded-full border border-zinc-200 bg-white/60 px-2 py-1 dark:border-white/10 dark:bg-zinc-900/40">
                  平均耗时(近10成功) {formatDurationMs(recentSuccessAvgDurationMs)}
                </span>
                <span className="rounded-full border border-sky-200 bg-sky-50/80 px-2 py-1 text-sky-700 dark:border-sky-800/60 dark:bg-sky-950/40 dark:text-sky-200">
                  同批生成 {batchedGroupCount} 组 / {batchedJobCount} 条
                </span>
                <span className="rounded-full border border-zinc-200 bg-white/60 px-2 py-1 dark:border-white/10 dark:bg-zinc-900/40">
                  当前 {pageFrom}-{pageTo}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={String(pageSize)}
                  onChange={(v) => setPageSize(clamp(Number(v), 10, 100))}
                  options={[
                    { value: "10", label: "10 / 页" },
                    { value: "20", label: "20 / 页" },
                    { value: "50", label: "50 / 页" },
                    { value: "100", label: "100 / 页" },
                  ]}
                  className="!w-24"
                />
                <Button variant="ghost" onClick={() => setPage((p) => clamp(p - 1, 1, totalPages))} disabled={safePage <= 1}>
                  上一页
                </Button>
                <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                  {safePage} / {totalPages}
                </span>
                <Button variant="ghost" onClick={() => setPage((p) => clamp(p + 1, 1, totalPages))} disabled={safePage >= totalPages}>
                  下一页
                </Button>
              </div>
            </div>
          </Card>

          <div className="grid grid-cols-1 gap-3 2xl:grid-cols-[minmax(360px,420px)_minmax(0,1fr)]">
            <Card>
              <div className="flex items-center justify-between">
                <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">任务列表</div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                  第 {safePage} 页 · {pagedItems.length} 条
                </div>
              </div>
              <Divider />
              <JobList
                groups={groupedPagedItems}
                selectedId={selectedJobId}
                onSelect={selectJob}
                onDeleteLocal={onDeleteLocal}
                onTogglePin={onTogglePin}
                onAddTag={onAddTag}
                onAddToPicker={(id) => navigate(`/picker?job=${encodeURIComponent(id)}`)}
                progressNowMs={progressNowMs}
                avgDurationMs={recentSuccessAvgDurationMs}
              />
            </Card>

            <Card>
              <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">详情</div>
              <Divider />
              {selectedRec ? (
                <JobDetail rec={selectedRec} onUpdateToken={(tok) => updateJob(selectedRec.job_id, { job_access_token: tok })} />
              ) : (
                <EmptyHint text="从列表中选择一个 job" />
              )}
            </Card>
          </div>
        </div>
      </div>
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

function JobDetail({ rec, onUpdateToken }: { rec: JobRecord; onUpdateToken: (tok: string) => void }) {
  const client = useApiClient();
  const { push } = useToast();
  const navigate = useNavigate();
  const settings = useSettingsStore((s) => s.settings);
  const updateJob = useJobsStore((s) => s.updateJob);

  const hasToken = Boolean(rec.job_access_token);

  // live meta
  const { meta, loading, error, refresh } = useJobLive(rec.job_id, rec.job_access_token);

  const status = pickStatus(meta || undefined, rec);

  const [debugOpen, setDebugOpen] = useState(false);
  const [reqSnap, setReqSnap] = useState<any | null>(null);
  const [respSnap, setRespSnap] = useState<any | null>(null);
  const [imgUrls, setImgUrls] = useState<Record<string, string>>({});
  const [imgBlobs, setImgBlobs] = useState<Record<string, Blob>>({});
  const revokeRef = useRef<string[]>([]);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [imgLoadError, setImgLoadError] = useState<string | null>(null);

  const imageIds = useMemo(() => {
    return extractImageIdsFromResult(meta?.result);
  }, [meta?.result]);

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
    return () => {
      // cleanup object urls
      revokeRef.current.forEach((u) => URL.revokeObjectURL(u));
      revokeRef.current = [];
    };
  }, []);

  const canRead = settings.jobAuthMode === "ID_ONLY" || hasToken;

  const manualToken = async () => {
    const tok = prompt("输入该 job 的 X-Job-Token（将仅保存在本地）");
    if (!tok) return;
    onUpdateToken(tok);
    push({ kind: "success", title: "已保存 token（本地）" });
  };

  const loadDebug = async () => {
    if (!canRead) {
      push({ kind: "error", title: "缺少 token", message: "TOKEN 模式下读取详情必须带 X-Job-Token" });
      return;
    }
    try {
      const [r1, r2] = await Promise.all([
        client.getJobRequest(rec.job_id, rec.job_access_token).catch((e) => ({ __error: e })),
        client.getJobResponse(rec.job_id, rec.job_access_token).catch((e) => ({ __error: e })),
      ]);
      setReqSnap(r1);
      setRespSnap(r2);
      push({ kind: "success", title: "已加载调试信息" });
    } catch (e: any) {
      push({ kind: "error", title: "加载失败", message: e?.error?.message || "" });
    }
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
      const blob = await client.getImageBlob(rec.job_id, image_id, rec.job_access_token);
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

  const ensureThumb = async (image_id: string) => {
    if (imgUrls[image_id]) return;
    try {
      const blob = await client.getImageBlob(rec.job_id, image_id, rec.job_access_token);
      setImgBlobs((m) => ({ ...m, [image_id]: blob }));
      const url = URL.createObjectURL(blob);
      revokeRef.current.push(url);
      setImgUrls((m) => ({ ...m, [image_id]: url }));
    } catch (e: any) {
      setImgLoadError(e?.error?.message || "图片拉取失败（可能缺少 token / CORS / 后端未返回该 image_id）");
    }
  };

  const fallbackToDataUrl = async (image_id: string) => {
    const blob = imgBlobs[image_id];
    if (!blob) return;
    try {
      const dataUrl = await blobToDataURL(blob);
      const old = imgUrls[image_id];
      if (old?.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(old);
        } catch {
          // ignore
        }
      }
      setImgUrls((m) => ({ ...m, [image_id]: dataUrl }));
    } catch {
      setImgLoadError("图片预览被在线预览环境的 CSP/沙箱策略拦截（blob/data URL）。建议本地 Vite 运行或调整平台 CSP。 ");
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
    const alsoServer = confirm("是否同时删除服务端 job？\n确定=同时删除服务端，取消=仅删除本地");

    // always delete local
    useJobsStore.getState().removeJob(rec.job_id);
    push({ kind: "success", title: "已删除本地记录" });

    if (alsoServer) {
      if (!canRead) {
        push({ kind: "error", title: "缺少 token", message: "TOKEN 模式下删除服务端需要 X-Job-Token" });
        return;
      }
      try {
        await client.deleteJob(rec.job_id, rec.job_access_token);
        push({ kind: "success", title: "已删除服务端 job" });
      } catch (e: any) {
        push({ kind: "error", title: "删除服务端失败", message: e?.error?.message || "" });
      }
    }
  };

  useEffect(() => {
    // update status cache on meta change
    if (meta?.status) {
      updateJob(rec.job_id, {
        status_cache: meta.status,
        model_cache: (meta.model as ModelId) || rec.model_cache,
        last_seen_at: isoNow(),
        ...jobTimingPatch(meta),
      });
    }
  }, [meta?.status, meta?.model, rec.job_id, rec.model_cache, updateJob]);

  useEffect(() => {
    if (!canRead) return;
    setImgLoadError(null);
    // 预加载：最多 12 张（避免一次性拉太多）
    imageIds.slice(0, 12).forEach((id) => ensureThumb(id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRead, imageIds.join("|")]);

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

      {status === "FAILED" ? (
        <Card hover={false} className="p-3">
          <div className="text-sm font-bold text-rose-700 dark:text-rose-200">失败信息</div>
          <div className="mt-2 text-xs text-zinc-700 dark:text-zinc-200">
            <div>
              <span className="font-semibold">type：</span>
              {meta?.error?.type || "-"}
            </div>
            <div className="mt-1">
              <span className="font-semibold">message：</span>
              {meta?.error?.message || "-"}
            </div>
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
            <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">结果预览</div>
            <div className="text-xs text-zinc-600 dark:text-zinc-300">
              预览会通过 /v1/jobs/{"{job_id}"}/images/{"{image_id}"} 拉取 blob（TOKEN 模式会带 X-Job-Token）。
            </div>
          </div>
          {selectedImageId ? (
            <div className="flex items-center gap-2">
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
              {imgUrls[selectedImageId] ? (
                <Button
                  variant="ghost"
                  className="!px-2 !py-1 text-xs"
                  onClick={() => window.open(imgUrls[selectedImageId], "_blank")}
                >
                  新窗口
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>

        {!canRead ? (
          <div className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">缺少 token，无法拉取图片。</div>
        ) : imageIds.length ? (
          <div className="mt-3 space-y-3">
            <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-50 dark:border-white/10 dark:bg-zinc-950/30">
              <div className="relative h-[360px] w-full sm:h-[420px] md:h-[500px]">
                {selectedImageId && imgUrls[selectedImageId] ? (
                  <img
                    src={imgUrls[selectedImageId]}
                    alt={selectedImageId}
                    className="h-full w-full object-contain opacity-0 blur-sm transition duration-300"
                    onLoad={(e) => {
                      const el = e.currentTarget;
                      el.classList.remove("opacity-0", "blur-sm");
                      el.classList.add("opacity-100");
                    }}
                    onError={(e) => {
                      const el = e.currentTarget;
                      el.classList.remove("opacity-0", "blur-sm");
                      el.classList.add("opacity-100");
                      fallbackToDataUrl(selectedImageId);
                    }}
                  />
                ) : (
                  <div className="h-full w-full">
                    <Skeleton className="h-full w-full" />
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
                const u = imgUrls[id];
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      setSelectedImageId(id);
                      ensureThumb(id);
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
                      <img
                        src={u}
                        alt={id}
                        className="h-20 w-28 object-cover opacity-0 blur-sm transition duration-300"
                        onLoad={(e) => {
                          const el = e.currentTarget;
                          el.classList.remove("opacity-0", "blur-sm");
                          el.classList.add("opacity-100");
                        }}
                        onError={(e) => {
                          const el = e.currentTarget;
                          el.classList.remove("opacity-0", "blur-sm");
                          el.classList.add("opacity-100");
                          fallbackToDataUrl(id);
                        }}
                      />
                    ) : (
                      <div className="h-20 w-28">
                        <Skeleton className="h-full w-full" />
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
          <div className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
            {status === "SUCCEEDED"
              ? "未检测到图片列表字段（result.images / result.image_ids），请对齐后端返回结构"
              : "尚无输出"}
          </div>
        )}
      </Card>

      <Card hover={false} className="p-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">任务操作</div>
            <div className="text-xs text-zinc-600 dark:text-zinc-300">Retry / Delete</div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={onRetry} disabled={!canRead}>
              Retry
            </Button>
            <Button variant="danger" onClick={onDelete}>
              Delete
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

function PickerCompareSlot({
  slotLabel,
  item,
  image,
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
    if (item) onEnsureImage();
  }, [item?.job_id, item?.image_id]);

  const locked = image?.code === "TOKEN_REQUIRED";
  const notFound = image?.code === "404";

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
      />
      <div className="relative h-[260px] w-full sm:h-[320px] md:h-[360px]">
        {!item ? (
          <div className="flex h-full items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">空槽位 {slotLabel}</div>
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
          <button type="button" onClick={onBest}>
            <BestCrownBadge active={isBest} />
          </button>
        </div>

        <div className="absolute right-2 top-2 z-20 flex items-center gap-1">
          {item ? (
            <Button variant="secondary" className="!px-2 !py-1 text-xs" onClick={onRemove}>
              移除
            </Button>
          ) : null}
        </div>
      </div>

      {item ? (
        <div className="relative z-20 border-t border-black/5 bg-white/80 p-2 dark:border-white/10 dark:bg-zinc-900/70">
          <div className="flex items-center justify-between gap-2">
            <div className="truncate text-xs font-semibold text-zinc-700 dark:text-zinc-200">
              {displayName}
            </div>
            <RatingStars value={item.rating || 0} onChange={onRate} />
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
  const setSlot = usePickerStore((s) => s.setSlot);
  const setFocus = usePickerStore((s) => s.setFocus);

  const [importOpen, setImportOpen] = useState(false);
  const [immersiveMode, setImmersiveMode] = useState(false);
  const [importFilter, setImportFilter] = useState("");
  const [quickJobId, setQuickJobId] = useState(searchParams.get("job") || "");
  const [importState, setImportState] = useState<Record<string, { loading: boolean; imageIds: string[]; error?: string }>>({});
  const [importSelection, setImportSelection] = useState<Record<string, boolean>>({});
  const [manualTokenByJob, setManualTokenByJob] = useState<Record<string, string>>({});
  const [imageState, setImageState] = useState<Record<string, PickerImageState>>({});
  const [prefetchPausedUntil, setPrefetchPausedUntil] = useState(0);
  const revokeRef = useRef<string[]>([]);
  const mountedRef = useRef(true);
  const inFlightRef = useRef<Map<string, AbortController>>(new Map());
  const imageStateRef = useRef<Record<string, PickerImageState>>({});
  const autoImportedRef = useRef<Record<string, boolean>>({});
  const rotationSeenRef = useRef<Record<string, string[]>>({});

  const currentSession = useMemo(
    () => sessions.find((s) => s.session_id === currentSessionId) || null,
    [sessions, currentSessionId]
  );
  const sessionQuery = searchParams.get("session") || "";
  const jobQuery = searchParams.get("job") || "";

  useEffect(() => {
    if (!sessions.length) createSession("默认挑选会话");
  }, [sessions.length, createSession]);

  useEffect(() => {
    imageStateRef.current = imageState;
  }, [imageState]);

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
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      inFlightRef.current.forEach((ctrl) => {
        try {
          ctrl.abort();
        } catch {
          // ignore
        }
      });
      inFlightRef.current.clear();
      revokeRef.current.forEach((u) => {
        try {
          URL.revokeObjectURL(u);
        } catch {
          // ignore
        }
      });
      revokeRef.current = [];
    };
  }, []);

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
    if (sessionQuery === currentSessionId) return;
    const next = new URLSearchParams(searchParams);
    next.set("session", currentSessionId);
    setSearchParams(next, { replace: true });
  }, [currentSessionId, sessionQuery, searchParams, setSearchParams]);

  const jobsById = useMemo(() => {
    const m = new Map<string, JobRecord>();
    jobs.forEach((j) => m.set(j.job_id, j));
    return m;
  }, [jobs]);

  const filteredJobs = useMemo(() => {
    const q = importFilter.trim().toLowerCase();
    const base = [...jobs].filter((j) => !j.deleted);
    if (!q) return base.slice(0, 60);
    return base
      .filter((j) => `${j.job_id} ${j.prompt_preview || ""} ${(j.tags || []).join(" ")}`.toLowerCase().includes(q))
      .slice(0, 60);
  }, [jobs, importFilter]);

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
        added_at: isoNow(),
      }))
    );
    if (!silent) push({ kind: "success", title: "已导入", message: `${loaded.imageIds.length} 张图片` });
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
  const filmstripItems = useMemo(
    () => sessionItems.filter((it) => (it.pool || "FILMSTRIP") !== "PREFERRED"),
    [sessionItems]
  );
  const preferredItems = useMemo(
    () => sessionItems.filter((it) => (it.pool || "FILMSTRIP") === "PREFERRED"),
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

  const normalizedSlots = useMemo(() => {
    const slots = [...(currentSession?.slots || [null, null, null, null])].slice(0, 4);
    while (slots.length < 4) slots.push(null);
    const seen = new Set<string>();
    for (let i = 0; i < slots.length; i++) {
      const k = slots[i];
      if (!k || !itemMap.has(k) || seen.has(k)) {
        slots[i] = null;
      } else {
        seen.add(k);
      }
    }
    for (const it of orderedItemsByPool) {
      const k = pickerItemKey(it);
      if (seen.has(k)) continue;
      const idx = slots.findIndex((x) => !x);
      if (idx < 0) break;
      slots[idx] = k;
      seen.add(k);
    }
    return slots;
  }, [currentSession?.slots, orderedItemsByPool, itemMap]);

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

  const compareMode = currentSession?.compare_mode || "TWO";
  const stageSlots = compareMode === "FOUR" ? normalizedSlots.slice(0, 4) : normalizedSlots.slice(0, 2);
  const isPreferredKey = (key?: string | null) => Boolean(key && (itemMap.get(key)?.pool || "FILMSTRIP") === "PREFERRED");

  const ensureImage = async (item: PickerSessionItem) => {
    const key = pickerItemKey(item);
    const snap = imageStateRef.current[key];
    if (snap?.url || snap?.loading || inFlightRef.current.has(key)) return;

    if (settings.jobAuthMode === "TOKEN" && !item.job_access_token) {
      setImageState((prev) => ({ ...prev, [key]: { loading: false, code: "TOKEN_REQUIRED", error: "缺少 token" } }));
      return;
    }

    const controller = new AbortController();
    inFlightRef.current.set(key, controller);
    setImageState((prev) => ({ ...prev, [key]: { ...prev[key], loading: true, error: undefined, code: undefined } }));

    try {
      const blob = await client.getImageBlob(item.job_id, item.image_id, item.job_access_token, controller.signal);
      if (!mountedRef.current) return;
      const url = URL.createObjectURL(blob);
      revokeRef.current.push(url);
      setImageState((prev) => ({ ...prev, [key]: { loading: false, url } }));
    } catch (e: any) {
      if (controller.signal.aborted || !mountedRef.current) return;
      const code = String(e?.error?.code || "ERROR");
      const msg = e?.error?.message || "图片加载失败";
      setImageState((prev) => ({ ...prev, [key]: { loading: false, error: msg, code } }));
      if (code === "429") {
        setPrefetchPausedUntil(Date.now() + 5000);
        push({ kind: "info", title: "请求过快（429）", message: "已暂停预取 5 秒" });
      }
    } finally {
      inFlightRef.current.delete(key);
    }
  };

  useEffect(() => {
    if (!currentSession) return;
    if (Date.now() < prefetchPausedUntil) return;
    const targetKeys = new Set<string>();
    stageSlots.forEach((k) => k && targetKeys.add(k));
    if (focusKey) targetKeys.add(focusKey);
    sessionItems.slice(0, 10).forEach((it) => targetKeys.add(pickerItemKey(it)));
    const targets = Array.from(targetKeys)
      .map((k) => itemMap.get(k))
      .filter(Boolean) as PickerSessionItem[];
    mapLimit(targets, 2, async (it) => {
      await ensureImage(it);
      return null;
    });
  }, [currentSession?.session_id, stageSlots.join("|"), focusKey, sessionItems.map((x) => pickerItemKey(x)).join("|"), prefetchPausedUntil, settings.jobAuthMode]);

  const fixToken = (item: PickerSessionItem) => {
    const tok = prompt(`为 job ${shortId(item.job_id)} 输入 X-Job-Token：`);
    if (!tok || !currentSession) return;
    updateItem(currentSession.session_id, pickerItemKey(item), { job_access_token: tok });
    updateJob(item.job_id, { job_access_token: tok });
    setManualTokenByJob((m) => ({ ...m, [item.job_id]: tok }));
    push({ kind: "success", title: "已保存 token" });
  };

  const toggleBest = (key: string) => {
    if (!currentSession) return;
    patchSession(currentSession.session_id, (session) => {
      const items = session.items.map((it) => {
        const itemKey = pickerItemKey(it);
        if (itemKey !== key) return it;
        const currentPool = it.pool === "PREFERRED" ? "PREFERRED" : "FILMSTRIP";
        return { ...it, pool: currentPool === "PREFERRED" ? "FILMSTRIP" : "PREFERRED" };
      });
      const preferred = items.find((it) => (it.pool || "FILMSTRIP") === "PREFERRED");
      return {
        ...session,
        items,
        best_image: preferred ? { job_id: preferred.job_id, image_id: preferred.image_id } : undefined,
      };
    });
  };

  const shiftToNextBatch = () => {
    if (!currentSession) return;
    const slotCount = compareMode === "FOUR" ? 4 : 2;
    const orderedKeys = orderedItemsByPool.map((it) => pickerItemKey(it));
    if (!orderedKeys.length) {
      push({ kind: "info", title: "暂无可切换图片" });
      return;
    }

    const sessionId = currentSession.session_id;
    const seenList = rotationSeenRef.current[sessionId] || [];
    const seen = new Set(seenList);
    stageSlots.forEach((k) => k && seen.add(k));
    let nextKeys = orderedKeys.filter((k) => !seen.has(k));
    if (nextKeys.length < slotCount) {
      seen.clear();
      stageSlots.forEach((k) => k && seen.add(k));
      nextKeys = orderedKeys.filter((k) => !seen.has(k));
      if (!nextKeys.length) nextKeys = orderedKeys;
    }

    const chosen = nextKeys.slice(0, slotCount);
    chosen.forEach((k) => seen.add(k));
    rotationSeenRef.current[sessionId] = Array.from(seen);

    patchSession(sessionId, (session) => {
      const slots = [...session.slots];
      for (let i = 0; i < slotCount; i++) {
        slots[i] = chosen[i] || null;
      }
      const focus_key = chosen[0] || slots.find(Boolean) || null;
      return { ...session, slots, focus_key };
    });
  };

  const setSessionMode = (mode: PickerCompareMode) => {
    if (!currentSession) return;
    patchSession(currentSession.session_id, (s) => ({ ...s, compare_mode: mode }));
  };

  const patchSessionUi = (patch: Partial<PickerSession["ui"]>) => {
    if (!currentSession) return;
    patchSession(currentSession.session_id, (s) => ({ ...s, ui: { ...s.ui, ...patch } }));
  };

  const patchSessionLayout = (layout: PickerLayoutPreset) => {
    if (!currentSession) return;
    patchSession(currentSession.session_id, (s) => ({ ...s, layout_preset: layout }));
  };

  const focusListKeys = useMemo(
    () => orderedItemsByPool.map((it) => pickerItemKey(it)),
    [orderedItemsByPool]
  );

  const downloadOne = async (item: PickerSessionItem) => {
    try {
      const blob = await client.getImageBlob(item.job_id, item.image_id, item.job_access_token);
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
    const preferred = orderedItemsByPool.filter((it) => (it.pool || "FILMSTRIP") === "PREFERRED");
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
    const picked = sessionItems.filter((it) => it.picked);
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

  const downloadFocus = async () => {
    if (!focusKey) return;
    const item = itemMap.get(focusKey);
    if (!item) return;
    const ok = await downloadOne(item);
    if (ok) push({ kind: "success", title: "下载已触发" });
  };

  useEffect(() => {
    if (!currentSession) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === "Escape" && immersiveMode) {
        e.preventDefault();
        setImmersiveMode(false);
        return;
      }
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key.toLowerCase() === "f") {
        e.preventDefault();
        setImmersiveMode((v) => !v);
        return;
      }
      if (!focusKey) return;
      const focusItem = itemMap.get(focusKey);
      if (!focusItem) return;
      if (["1", "2", "3", "4", "5"].includes(e.key)) {
        updateItem(currentSession.session_id, focusKey, { rating: Number(e.key) });
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (compareMode !== "FILMSTRIP" || focusListKeys.length < 2) return;
        const i = focusListKeys.indexOf(focusKey);
        if (i < 0) return;
        const next = e.key === "ArrowRight" ? (i + 1) % focusListKeys.length : (i - 1 + focusListKeys.length) % focusListKeys.length;
        setFocus(currentSession.session_id, focusListKeys[next]);
        return;
      }
      const key = e.key.toLowerCase();
      if (key === "d" && !e.shiftKey) {
        e.preventDefault();
        downloadFocus();
        return;
      }
      if (["a", "b", "c"].includes(key) || (key === "d" && e.shiftKey)) {
        const idx = key === "d" ? 3 : ["a", "b", "c"].indexOf(key);
        setSlot(currentSession.session_id, idx, focusKey);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        toggleBest(focusKey);
        return;
      }
      if (e.key === "Backspace") {
        e.preventDefault();
        removeItem(currentSession.session_id, focusKey);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentSession?.session_id, focusKey, compareMode, focusListKeys.join("|"), itemMap, updateItem, setSlot, removeItem, immersiveMode]);

  if (!currentSession) {
    return (
      <PageContainer>
        <EmptyHint text="正在初始化挑选会话…" />
      </PageContainer>
    );
  }

  const darkStage = currentSession.ui.background === "dark";
  const selectedCount = sessionItems.filter((it) => it.picked).length;
  const immersiveSlots = compareMode === "FOUR" ? normalizedSlots.slice(0, 4) : compareMode === "TWO" ? normalizedSlots.slice(0, 2) : [focusKey];

  const renderImmersiveSlot = (slotKey: string | null, label: string) => {
    const item = slotKey ? itemMap.get(slotKey) || null : null;
    const state = slotKey ? imageState[slotKey] : undefined;
    const isBest = Boolean(slotKey && isPreferredKey(slotKey));
    const jobRec = item ? jobsById.get(item.job_id) : undefined;
    const display = item ? pickerDisplayName(item, jobRec) : `空槽位 ${label}`;
    const immersiveHeightClass =
      compareMode === "FOUR"
        ? "h-[44vh] min-h-[300px] md:h-[46vh]"
        : compareMode === "TWO"
          ? "h-[76vh] min-h-[360px] md:h-[80vh]"
          : "h-[78vh] min-h-[380px] md:h-[82vh]";

    return (
      <div
        key={`${label}_${slotKey || "empty"}_immersive`}
        className={cn(
          "group relative overflow-hidden rounded-2xl border",
          slotKey && slotKey === focusKey ? "border-white shadow-[0_0_0_1px_rgba(255,255,255,0.35)]" : "border-white/15",
          "bg-black/60"
        )}
      >
        <button
          type="button"
          className="absolute inset-0 z-0"
          onClick={() => slotKey && setFocus(currentSession.session_id, slotKey)}
          title="聚焦该图片"
        />
        <div className={cn("relative w-full", immersiveHeightClass)}>
          {!item ? (
            <div className="flex h-full items-center justify-center text-sm text-zinc-400">{display}</div>
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
        <div className="pointer-events-none absolute left-3 top-3 z-20 flex items-center gap-2 opacity-0 transition group-hover:opacity-100">
          <span className="rounded-full bg-black/55 px-2 py-1 text-xs font-bold text-white">{label}</span>
          <button
            type="button"
            className={cn(
              "pointer-events-auto rounded-full border px-2 py-0.5 text-xs font-semibold",
              isBest ? "border-amber-300 bg-amber-500/20 text-amber-200" : "border-white/25 bg-black/30 text-zinc-200"
            )}
            onClick={(e) => {
              e.stopPropagation();
              if (slotKey) toggleBest(slotKey);
            }}
          >
            {isBest ? "移回片池" : "移入优选"}
          </button>
        </div>
        <div className="pointer-events-none absolute right-3 top-3 z-20 opacity-0 transition group-hover:opacity-100">
          {item ? (
            <Button
              variant="danger"
              className="pointer-events-auto !px-2 !py-1 text-xs"
              onClick={(e) => {
                e.stopPropagation();
                if (slotKey) removeItem(currentSession.session_id, slotKey);
              }}
            >
              移除
            </Button>
          ) : null}
        </div>
        {item ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 border-t border-white/10 bg-black/55 px-3 py-2 opacity-0 backdrop-blur transition group-hover:opacity-100">
            <div className="flex items-center justify-between gap-2">
              <div className="truncate text-xs font-semibold text-zinc-200">{display}</div>
              <RatingStars
                value={item.rating || 0}
                onChange={(n) => slotKey && updateItem(currentSession.session_id, slotKey, { rating: n })}
                className="pointer-events-auto"
              />
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-6">
      <PageTitle
        title="Image Picker"
        subtitle="跨任务图片对比、选优与下载（本地会话持久化）"
        right={
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => navigate("/history")}>返回 History</Button>
          </div>
        }
      />

      <Card className="mb-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-[220px] flex-1">
            <Select
              value={currentSession.session_id}
              onChange={setCurrentSession}
              options={sessions.map((s) => ({ value: s.session_id, label: `${s.name} · ${s.items.length} 张` }))}
            />
          </div>
          <Button
            variant="secondary"
            onClick={() => {
              const name = prompt("新会话名称：", `挑选会话 ${new Date().toLocaleDateString()}`);
              const id = createSession(name || undefined);
              setCurrentSession(id);
              push({ kind: "success", title: "已创建会话" });
            }}
          >
            新建会话
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              const name = prompt("重命名会话：", currentSession.name);
              if (!name) return;
              renameSession(currentSession.session_id, name);
            }}
          >
            重命名
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (!confirm("删除当前会话？")) return;
              deleteSession(currentSession.session_id);
            }}
            disabled={sessions.length <= 1}
          >
            删除会话
          </Button>

          <div className="mx-2 h-6 w-px bg-zinc-200 dark:bg-white/10" />

          <Button variant="secondary" onClick={() => setImportOpen(true)}>从历史导入</Button>
          <Button variant={compareMode === "TWO" ? "primary" : "ghost"} onClick={() => setSessionMode("TWO")}>2-up</Button>
          <Button variant={compareMode === "FOUR" ? "primary" : "ghost"} onClick={() => setSessionMode("FOUR")}>4-up</Button>
          <Button variant={compareMode === "FILMSTRIP" ? "primary" : "ghost"} onClick={() => setSessionMode("FILMSTRIP")}>Filmstrip</Button>
          <Button
            variant={currentSession.layout_preset === "SYNC_ZOOM" ? "secondary" : "ghost"}
            onClick={() => patchSessionLayout(currentSession.layout_preset === "SYNC_ZOOM" ? "FREE_ZOOM" : "SYNC_ZOOM")}
          >
            {currentSession.layout_preset === "SYNC_ZOOM" ? "同步缩放" : "自由缩放"}
          </Button>
          <Button
            variant={currentSession.ui.showInfo ? "secondary" : "ghost"}
            onClick={() => patchSessionUi({ showInfo: !currentSession.ui.showInfo })}
          >
            Info
          </Button>
          <Button
            variant={currentSession.ui.showGrid ? "secondary" : "ghost"}
            onClick={() => patchSessionUi({ showGrid: !currentSession.ui.showGrid })}
          >
            Grid
          </Button>
          <Button
            variant={darkStage ? "secondary" : "ghost"}
            onClick={() => patchSessionUi({ background: darkStage ? "light" : "dark" })}
          >
            {darkStage ? "Dark BG" : "Light BG"}
          </Button>
          <Button variant="secondary" onClick={() => setImmersiveMode(true)}>
            全屏审阅
          </Button>
          <Button variant="secondary" onClick={shiftToNextBatch}>
            切换下一组
          </Button>
          <Button variant="primary" onClick={downloadBest}>下载优选</Button>
          <Button variant="secondary" onClick={downloadPicked}>下载选中</Button>
        </div>
      </Card>

      <Card className={cn("mb-3 overflow-hidden p-2", darkStage ? "bg-zinc-950" : "bg-zinc-50")}>
        {compareMode === "FILMSTRIP" ? (
          <div className="grid grid-cols-1 gap-2">
            <PickerCompareSlot
              slotLabel="Focus"
              item={focusKey ? itemMap.get(focusKey) || null : null}
              image={focusKey ? imageState[focusKey] : undefined}
              isBest={Boolean(focusKey && isPreferredKey(focusKey))}
              focused
              showInfo={currentSession.ui.showInfo}
              showGrid={currentSession.ui.showGrid}
              darkStage={darkStage}
              jobRec={focusKey ? jobsById.get(itemMap.get(focusKey)?.job_id || "") : undefined}
              displayName={
                focusKey && itemMap.get(focusKey)
                  ? pickerDisplayName(itemMap.get(focusKey)!, jobsById.get(itemMap.get(focusKey)!.job_id))
                  : "-"
              }
              onFocus={() => {}}
              onEnsureImage={() => {
                const item = focusKey ? itemMap.get(focusKey) : null;
                if (item) ensureImage(item);
              }}
              onBest={() => {
                if (focusKey) toggleBest(focusKey);
              }}
              onRate={(n) => {
                if (focusKey) updateItem(currentSession.session_id, focusKey, { rating: n });
              }}
              onRemove={() => {
                if (focusKey) removeItem(currentSession.session_id, focusKey);
              }}
              onFixToken={() => {
                const item = focusKey ? itemMap.get(focusKey) : null;
                if (item) fixToken(item);
              }}
            />
          </div>
        ) : (
          <div className={cn("grid gap-2", compareMode === "FOUR" ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1 md:grid-cols-2")}>
            {stageSlots.map((slotKey, idx) => {
              const item = slotKey ? itemMap.get(slotKey) || null : null;
              const label = String.fromCharCode(65 + idx);
              return (
                <PickerCompareSlot
                  key={`${label}_${slotKey || "empty"}`}
                  slotLabel={label}
                  item={item}
                  image={slotKey ? imageState[slotKey] : undefined}
                  isBest={Boolean(slotKey && isPreferredKey(slotKey))}
                  focused={Boolean(slotKey && slotKey === focusKey)}
                  showInfo={currentSession.ui.showInfo}
                  showGrid={currentSession.ui.showGrid}
                  darkStage={darkStage}
                  jobRec={item ? jobsById.get(item.job_id) : undefined}
                  displayName={item ? pickerDisplayName(item, jobsById.get(item.job_id)) : "-"}
                  onFocus={() => slotKey && setFocus(currentSession.session_id, slotKey)}
                  onEnsureImage={() => item && ensureImage(item)}
                  onBest={() => slotKey && toggleBest(slotKey)}
                  onRate={(n) => slotKey && updateItem(currentSession.session_id, slotKey, { rating: n })}
                  onRemove={() => slotKey && removeItem(currentSession.session_id, slotKey)}
                  onFixToken={() => item && fixToken(item)}
                />
              );
            })}
          </div>
        )}
      </Card>

      <Card>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">Filmstrip</div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400">已选 {selectedCount} / 总计 {sessionItems.length}</div>
        </div>
        {!sessionItems.length ? (
          <EmptyHint text="暂无图片，点击“从历史导入”开始挑选" />
        ) : (
          <div className="space-y-4">
            <div
              className="flex gap-2 overflow-x-auto pb-2"
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
                return (
                  <motion.div
                    layout
                    key={`film_${key}`}
                    className={cn(
                      "w-56 flex-none overflow-hidden rounded-2xl border",
                      active ? "border-zinc-900 shadow-md dark:border-white" : "border-zinc-200 dark:border-white/10"
                    )}
                  >
                    <button
                      type="button"
                      className="relative block h-36 w-full overflow-hidden bg-zinc-100 dark:bg-zinc-900"
                      onClick={() => setFocus(currentSession.session_id, key)}
                      onMouseEnter={() => ensureImage(item)}
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
                      {state?.code === "404" ? <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-xs font-bold text-white">404</div> : null}
                    </button>

                    <div className="space-y-1 p-2">
                      <div className="flex items-center justify-between">
                        <label className="inline-flex items-center gap-1 text-[11px] text-zinc-600 dark:text-zinc-300">
                          <input
                            type="checkbox"
                            checked={Boolean(item.picked)}
                            onChange={(e) => updateItem(currentSession.session_id, key, { picked: e.target.checked })}
                          />
                          选中
                        </label>
                        <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{inSlot >= 0 ? String.fromCharCode(65 + inSlot) : "-"}</div>
                      </div>
                      <RatingStars
                        value={item.rating || 0}
                        onChange={(n) => updateItem(currentSession.session_id, key, { rating: n })}
                      />
                      <div className="flex flex-wrap gap-1">
                        {["A", "B", "C", "D"].map((s, i) => (
                          <Button key={s} variant="ghost" className="!px-1.5 !py-0.5 text-[10px]" onClick={() => setSlot(currentSession.session_id, i, key)}>
                            {s}
                          </Button>
                        ))}
                        <Button variant="ghost" className="!px-1.5 !py-0.5 text-[10px]" onClick={() => toggleBest(key)}>
                          优选
                        </Button>
                        <Button variant="ghost" className="!px-1.5 !py-0.5 text-[10px]" onClick={() => downloadOne(item)}>下载</Button>
                        <Button variant="danger" className="!px-1.5 !py-0.5 text-[10px]" onClick={() => removeItem(currentSession.session_id, key)}>
                          移除
                        </Button>
                      </div>
                      <div className="truncate text-[10px] text-zinc-500 dark:text-zinc-400">
                        {pickerDisplayName(item, jobsById.get(item.job_id))}
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">优选池</div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">{preferredItems.length} 张</div>
              </div>
              {!preferredItems.length ? (
                <div className="rounded-2xl border border-dashed border-zinc-200 p-3 text-xs text-zinc-500 dark:border-white/10 dark:text-zinc-400">
                  还没有优选图片，可在 Filmstrip 中点击“优选”转入。
                </div>
              ) : (
                <div
                  className="flex gap-2 overflow-x-auto pb-2"
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
                        className={cn(
                          "w-56 flex-none overflow-hidden rounded-2xl border",
                          active ? "border-amber-500 shadow-md dark:border-amber-300" : "border-zinc-200 dark:border-white/10"
                        )}
                      >
                        <button
                          type="button"
                          className="relative block h-36 w-full overflow-hidden bg-zinc-100 dark:bg-zinc-900"
                          onClick={() => setFocus(currentSession.session_id, key)}
                          onMouseEnter={() => ensureImage(item)}
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
                          <div className="absolute left-1 top-1 rounded-full bg-amber-500/90 px-2 py-0.5 text-[10px] font-bold text-white">优</div>
                        </button>
                        <div className="space-y-1 p-2">
                          <div className="flex items-center justify-between">
                            <label className="inline-flex items-center gap-1 text-[11px] text-zinc-600 dark:text-zinc-300">
                              <input
                                type="checkbox"
                                checked={Boolean(item.picked)}
                                onChange={(e) => updateItem(currentSession.session_id, key, { picked: e.target.checked })}
                              />
                              选中
                            </label>
                            <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{inSlot >= 0 ? String.fromCharCode(65 + inSlot) : "-"}</div>
                          </div>
                          <RatingStars
                            value={item.rating || 0}
                            onChange={(n) => updateItem(currentSession.session_id, key, { rating: n })}
                          />
                          <div className="flex flex-wrap gap-1">
                            {["A", "B", "C", "D"].map((s, i) => (
                              <Button key={s} variant="ghost" className="!px-1.5 !py-0.5 text-[10px]" onClick={() => setSlot(currentSession.session_id, i, key)}>
                                {s}
                              </Button>
                            ))}
                            <Button variant="ghost" className="!px-1.5 !py-0.5 text-[10px]" onClick={() => toggleBest(key)}>
                              移回片池
                            </Button>
                            <Button variant="ghost" className="!px-1.5 !py-0.5 text-[10px]" onClick={() => downloadOne(item)}>下载</Button>
                            <Button variant="danger" className="!px-1.5 !py-0.5 text-[10px]" onClick={() => removeItem(currentSession.session_id, key)}>
                              移除
                            </Button>
                          </div>
                          <div className="truncate text-[10px] text-zinc-500 dark:text-zinc-400">
                            {pickerDisplayName(item, jobsById.get(item.job_id))}
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </Card>

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
                <div className="min-w-0">
                  <div className="truncate text-sm font-bold">{currentSession.name} · 沉浸式审阅</div>
                  <div className="text-[11px] text-zinc-300">悬停显示评分与优选控件，按 `Esc` 退出</div>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant={compareMode === "TWO" ? "secondary" : "ghost"} onClick={() => setSessionMode("TWO")}>2-up</Button>
                  <Button variant={compareMode === "FOUR" ? "secondary" : "ghost"} onClick={() => setSessionMode("FOUR")}>4-up</Button>
                  <Button variant={compareMode === "FILMSTRIP" ? "secondary" : "ghost"} onClick={() => setSessionMode("FILMSTRIP")}>Filmstrip</Button>
                  <Button variant="secondary" onClick={shiftToNextBatch}>切换下一组</Button>
                  <Button variant="secondary" onClick={() => setImmersiveMode(false)}>退出全屏</Button>
                </div>
              </div>

              <div className="flex-1 overflow-auto">
                {compareMode === "FILMSTRIP" ? (
                  <div className="grid grid-cols-1 gap-3">
                    {renderImmersiveSlot(focusKey, "Focus")}
                    <div className="flex gap-2 overflow-x-auto pb-1">
                      {sessionItems.map((it, idx) => {
                        const k = pickerItemKey(it);
                        const s = imageState[k];
                        const active = k === focusKey;
                        return (
                          <button
                            key={`${k}_immersive_strip`}
                            type="button"
                            className={cn(
                              "relative h-20 w-32 flex-none overflow-hidden rounded-xl border",
                              active ? "border-white shadow-[0_0_0_1px_rgba(255,255,255,0.25)]" : "border-white/20"
                            )}
                            onClick={() => setFocus(currentSession.session_id, k)}
                            onMouseEnter={() => ensureImage(it)}
                          >
                            {s?.url ? <img src={s.url} alt={pickerDisplayName(it, jobsById.get(it.job_id))} className="h-full w-full object-cover" /> : <Skeleton className="h-full w-full" />}
                            {isPreferredKey(k) ? <span className="absolute left-1 top-1 rounded-full bg-amber-500/90 px-1.5 py-0.5 text-[10px] font-bold text-white">优</span> : null}
                            <span className="absolute bottom-1 left-1 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white">{idx + 1}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className={cn("grid gap-3", compareMode === "FOUR" ? "grid-cols-1 lg:grid-cols-2" : "grid-cols-1 lg:grid-cols-2")}>
                    {immersiveSlots.map((slotKey, idx) => renderImmersiveSlot(slotKey || null, String.fromCharCode(65 + idx)))}
                  </div>
                )}
              </div>
            </div>
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
              className="h-full w-[420px] max-w-[95vw] overflow-y-auto border-l border-zinc-200 bg-white p-4 shadow-2xl dark:border-white/10 dark:bg-zinc-950"
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-lg font-bold text-zinc-900 dark:text-zinc-50">导入图片</div>
                  <div className="text-xs text-zinc-600 dark:text-zinc-300">从历史任务勾选图片加入当前会话</div>
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
              </div>

              <div className="mt-4 space-y-2">
                {filteredJobs.map((job) => {
                  const st = importState[job.job_id];
                  const ids = st?.imageIds || [];
                  return (
                    <div key={job.job_id} className="rounded-2xl border border-zinc-200 p-2 dark:border-white/10">
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
                          <div className="max-h-32 space-y-1 overflow-auto rounded-xl bg-zinc-50 p-2 dark:bg-zinc-900/50">
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
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const resetSettings = useSettingsStore((s) => s.resetSettings);
  const clearJobs = useJobsStore((s) => s.clearJobs);
  const jobs = useJobsStore((s) => s.jobs);

  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [defaultModel, setDefaultModel] = useState<ModelId>(settings.defaultModel || catalog.default_model);
  const [jobAuthMode, setJobAuthMode] = useState<JobAuthMode>(settings.jobAuthMode);

  const [adminEnabled, setAdminEnabled] = useState(settings.adminModeEnabled);
  const [adminKey, setAdminKey] = useState(settings.adminKey);

  const [theme, setTheme] = useState<ThemeMode>(settings.ui.theme);
  const [reduceMotion, setReduceMotion] = useState(settings.ui.reduceMotion);
  const currentDefaultParams = useMemo(
    () => getParamsForModel(settings, settings.defaultModel || catalog.default_model),
    [catalog.default_model, settings]
  );

  const [intervalMs, setIntervalMs] = useState(settings.polling.intervalMs);
  const [maxIntervalMs, setMaxIntervalMs] = useState(settings.polling.maxIntervalMs);
  const [concurrency, setConcurrency] = useState(settings.polling.concurrency);

  const [health, setHealth] = useState<any | null>(null);
  const [adminCheck, setAdminCheck] = useState<BillingSummary | null>(null);
  const [googleRemain, setGoogleRemain] = useState<GoogleRemaining | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    setBaseUrl(settings.baseUrl);
    setDefaultModel(settings.defaultModel || catalog.default_model);
    setJobAuthMode(settings.jobAuthMode);
    setAdminEnabled(settings.adminModeEnabled);
    setAdminKey(settings.adminKey);
    setTheme(settings.ui.theme);
    setReduceMotion(settings.ui.reduceMotion);

    setIntervalMs(settings.polling.intervalMs);
    setMaxIntervalMs(settings.polling.maxIntervalMs);
    setConcurrency(settings.polling.concurrency);
  }, [catalog.default_model, settings]);

  const save = () => {
    const next: Partial<SettingsV1> = {
      baseUrl: baseUrl.trim().replace(/\/$/, ""),
      defaultModel,
      jobAuthMode,
      adminModeEnabled: adminEnabled,
      adminKey,
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

  const validateAdmin = async () => {
    setAdminCheck(null);
    setGoogleRemain(null);
    try {
      const tmp = new ApiClient({ ...settings, baseUrl, adminModeEnabled: true, adminKey });
      const summary = await tmp.billingSummary();
      setAdminCheck(summary);
      const g = await tmp.billingGoogleRemaining().catch(() => null as any);
      setGoogleRemain(g || null);
      push({ kind: "success", title: "Admin 校验成功" });
    } catch (e: any) {
      push({ kind: "error", title: "Admin 校验失败", message: e?.error?.message || "" });
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
      <PageTitle title="Settings" subtitle="浏览器配置中心：baseUrl / 默认参数 / Admin / 轮询 / UI / 数据管理" right={<Button onClick={save}>保存</Button>} />

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
              setAdminCheck(null);
              setGoogleRemain(null);
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
                  请打开 DevTools Console/Network 查看是否有 CORS 报错，并在后端开启允许当前前端 Origin 的 CORS（尤其要允许 headers：X-Job-Token / X-Admin-Key）。
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
            提示：在 Create 页面调整参数会自动保存（刷新网页也会保留）。这里仅提供“恢复默认”。
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

        <Card className="lg:col-span-2">
          <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">Admin 模式</div>
          <div className="mt-3 flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">adminModeEnabled</div>
              <div className="text-xs text-zinc-600 dark:text-zinc-300">开启后 Dashboard 会显示预算与 Google remaining</div>
            </div>
            <Switch value={adminEnabled} onChange={setAdminEnabled} />
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="adminKey">
              <Input value={adminKey} onChange={setAdminKey} type="password" placeholder="X-Admin-Key" />
            </Field>
            <div className="flex items-end gap-2">
              <Button variant="secondary" onClick={validateAdmin} disabled={!adminEnabled || !adminKey}>
                校验 admin 权限
              </Button>
              <Button onClick={save}>保存</Button>
            </div>
          </div>

          {adminCheck ? (
            <div className="mt-3 rounded-2xl border border-zinc-200 bg-white/60 p-3 text-xs dark:border-white/10 dark:bg-zinc-950/30">
              <div className="font-bold text-zinc-900 dark:text-zinc-50">Billing Summary</div>
              <pre className="mt-2 max-h-44 overflow-auto rounded-xl bg-black/90 p-2 text-[11px] text-white">
                {JSON.stringify(adminCheck, null, 2)}
              </pre>
            </div>
          ) : null}

          {googleRemain ? (
            <div className="mt-3 rounded-2xl border border-zinc-200 bg-white/60 p-3 text-xs dark:border-white/10 dark:bg-zinc-950/30">
              <div className="font-bold text-zinc-900 dark:text-zinc-50">Google Remaining</div>
              <pre className="mt-2 max-h-44 overflow-auto rounded-xl bg-black/90 p-2 text-[11px] text-white">
                {JSON.stringify(googleRemain, null, 2)}
              </pre>
            </div>
          ) : null}
        </Card>

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

  return (
    <ToastProvider>
      <BrowserRouter>
        <div className="min-h-screen bg-gradient-to-b from-zinc-50 to-white text-zinc-900 dark:from-zinc-950 dark:to-zinc-950 dark:text-zinc-50">
          <TopNav />
          <AnimatedRoutes />
          <Footer />
        </div>
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
