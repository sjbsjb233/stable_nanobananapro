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
  temperature: number;
  timeout_sec: number;
  max_retries: number;
};

type SettingsV1 = {
  baseUrl: string;
  jobAuthMode: JobAuthMode;
  adminModeEnabled: boolean;
  adminKey: string;
  defaultParams: DefaultParams;
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
  created_at: string; // ISO
  status_cache?: JobStatus;
  prompt_preview?: string;
  params_cache?: Partial<DefaultParams>;
  last_seen_at?: string;
  pinned?: boolean;
  tags?: string[];
  deleted?: boolean;
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
  status?: JobStatus;
  created_at?: string;
  updated_at?: string;
  params?: DefaultParams & Record<string, any>;
  usage?: UsageMeta;
  billing?: BillingMeta;
  result?: JobResult;
  error?: JobError;
  response?: { latency_ms?: number } & Record<string, any>;
  [k: string]: any;
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

const DEFAULT_SETTINGS: SettingsV1 = {
  baseUrl: "http://127.0.0.1:8000",
  jobAuthMode: "TOKEN",
  adminModeEnabled: false,
  adminKey: "",
  defaultParams: {
    aspect_ratio: "1:1",
    image_size: "1K",
    temperature: 0.7,
    timeout_sec: 60,
    max_retries: 1,
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

// -----------------------------
// Zustand stores (persisted)
// -----------------------------

type SettingsStore = {
  settings: SettingsV1;
  setSettings: (patch: Partial<SettingsV1>) => void;
  updateDefaultParams: (patch: Partial<DefaultParams>) => void;
  resetSettings: () => void;
};

const useSettingsStore = create<SettingsStore>((set, get) => {
  const persisted = safeJsonParse<SettingsV1>(localStorage.getItem(KEY_SETTINGS), DEFAULT_SETTINGS);
  // shallow-merge with defaults to survive schema drift
  const merged: SettingsV1 = {
    ...DEFAULT_SETTINGS,
    ...persisted,
    defaultParams: { ...DEFAULT_SETTINGS.defaultParams, ...persisted.defaultParams },
    ui: { ...DEFAULT_SETTINGS.ui, ...persisted.ui },
    polling: { ...DEFAULT_SETTINGS.polling, ...persisted.polling },
  };
  localStorage.setItem(KEY_SETTINGS, JSON.stringify(merged));

  return {
    settings: merged,
    setSettings: (patch) => {
      const next = {
        ...get().settings,
        ...patch,
        defaultParams: { ...get().settings.defaultParams, ...(patch as any).defaultParams },
        ui: { ...get().settings.ui, ...(patch as any).ui },
        polling: { ...get().settings.polling, ...(patch as any).polling },
      } as SettingsV1;
      localStorage.setItem(KEY_SETTINGS, JSON.stringify(next));
      set({ settings: next });
    },
    updateDefaultParams: (patch) => {
      const cur = get().settings;
      const next = { ...cur, defaultParams: { ...cur.defaultParams, ...patch } };
      localStorage.setItem(KEY_SETTINGS, JSON.stringify(next));
      set({ settings: next });
    },
    resetSettings: () => {
      localStorage.setItem(KEY_SETTINGS, JSON.stringify(DEFAULT_SETTINGS));
      set({ settings: DEFAULT_SETTINGS });
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
  const persisted = safeJsonParse<JobRecord[]>(localStorage.getItem(KEY_JOBS), []);
  // normalize
  const jobs = Array.isArray(persisted) ? persisted : [];
  localStorage.setItem(KEY_JOBS, JSON.stringify(jobs));

  const setAndPersist = (next: JobRecord[]) => {
    localStorage.setItem(KEY_JOBS, JSON.stringify(next));
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
      const err: ApiError = { error: { code: "NETWORK_ERROR", message: e?.message || "Network error" } };
      throw err;
    }

    const contentType = resp.headers.get("content-type") || "";

    if (!resp.ok) {
      if (contentType.includes("application/json")) {
        const j = (await resp.json().catch(() => null)) as ApiError | null;
        throw (
          j || {
            error: { code: String(resp.status), message: resp.statusText || "Request failed" },
          }
        );
      }
      throw { error: { code: String(resp.status), message: resp.statusText || "Request failed" } };
    }

    if (contentType.includes("application/json")) {
      return (await resp.json()) as T;
    }

    // for non-json endpoints
    return (await (resp as any).blob()) as any;
  }

  health(signal?: AbortSignal) {
    return this.request<any>("/health", { method: "GET", signal });
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
      jobToken,
      signal,
    });
  }

  // image download as blob
  getImageBlob(job_id: string, image_id: string, jobToken?: string, signal?: AbortSignal) {
    const url = this.buildUrl(`/jobs/${encodeURIComponent(job_id)}/images/${encodeURIComponent(image_id)}`);
    const headers: Record<string, string> = {};
    if (this.jobAuthMode === "TOKEN" && jobToken) headers["X-Job-Token"] = jobToken;
    return fetch(url, { method: "GET", headers, signal }).then(async (r) => {
      if (!r.ok) {
        const err: ApiError = { error: { code: String(r.status), message: r.statusText || "Image download failed" } };
        throw err;
      }
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
    .map((x) => x.meta?.response?.latency_ms)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0);
  const today_avg_latency_ms = today_latencies.length ? mean(today_latencies) : 0;
  const today_p95_latency_ms = today_latencies.length ? percentile(today_latencies, 95) : 0;

  const recent_statuses = recentJobs.map((x) => pickStatus(x.meta || undefined, x.rec));
  const recent10_success_rate = recentJobs.length
    ? recent_statuses.filter((s) => s === "SUCCEEDED").length / recentJobs.length
    : 0;

  const recent_lat = recentJobs
    .map((x) => x.meta?.response?.latency_ms)
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
    const cache = safeJsonParse<DashboardCache | null>(localStorage.getItem(KEY_DASH_CACHE), null);
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
      localStorage.setItem(
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
        value={stats ? `${Math.round(stats.today_avg_latency_ms)}ms` : "-"}
        sub={stats ? `P95 ${Math.round(stats.today_p95_latency_ms)}ms` : undefined}
        loading={loading}
      />
      <KpiCard
        title="最近 10 次"
        value={stats ? `${Math.round(stats.recent10_success_rate * 100)}%` : "-"}
        sub={stats ? `均耗时 ${Math.round(stats.recent10_avg_latency_ms)}ms` : undefined}
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

type CreateMode = "IMAGE_ONLY" | "TEXT_IMAGE";

function ImageDropzone({
  files,
  setFiles,
  maxFiles,
}: {
  files: File[];
  setFiles: (fs: File[]) => void;
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
    const next = [...files, ...onlyImages].slice(0, maxFiles);
    if (next.length >= maxFiles && files.length + onlyImages.length > maxFiles) {
      push({ kind: "info", title: `最多 ${maxFiles} 张参考图` });
    }
    setFiles(next);
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
  const { push } = useToast();
  const navigate = useNavigate();
  const settings = useSettingsStore((s) => s.settings);
  const updateDefaultParams = useSettingsStore((s) => s.updateDefaultParams);

  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [mode, setMode] = useState<CreateMode>("IMAGE_ONLY");

  const [aspect, setAspect] = useState<AspectRatio>(settings.defaultParams.aspect_ratio);
  const [size, setSize] = useState<ImageSize>(settings.defaultParams.image_size);
  const [temperature, setTemperature] = useState<number>(settings.defaultParams.temperature);
  const [timeoutSec, setTimeoutSec] = useState<number>(settings.defaultParams.timeout_sec);
  const [maxRetries, setMaxRetries] = useState<number>(settings.defaultParams.max_retries);

  const [loading, setLoading] = useState(false);

  // 在 Create 页面每次调整参数后，自动写回 settings.defaultParams（持久化到 localStorage）
  useEffect(() => {
    const t = setTimeout(() => {
      const cur = settings.defaultParams;
      const changed =
        cur.aspect_ratio !== aspect ||
        cur.image_size !== size ||
        cur.temperature !== temperature ||
        cur.timeout_sec !== timeoutSec ||
        cur.max_retries !== maxRetries;
      if (changed) {
        updateDefaultParams({
          aspect_ratio: aspect,
          image_size: size,
          temperature,
          timeout_sec: timeoutSec,
          max_retries: maxRetries,
        });
      }
    }, 200);
    return () => clearTimeout(t);
  }, [
    aspect,
    size,
    temperature,
    timeoutSec,
    maxRetries,
    settings.defaultParams.aspect_ratio,
    settings.defaultParams.image_size,
    settings.defaultParams.temperature,
    settings.defaultParams.timeout_sec,
    settings.defaultParams.max_retries,
    updateDefaultParams,
  ]);

  const validate = () => {
    if (!prompt.trim()) return "Prompt 不能为空";
    if (files.length > 14) return "参考图最多 14 张";
    if (files.some((f) => !f.type.startsWith("image/"))) return "参考图必须是 image/*";
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
      const params: DefaultParams = {
        aspect_ratio: aspect,
        image_size: size,
        temperature,
        timeout_sec: timeoutSec,
        max_retries: maxRetries,
      };

      let resp: any;
      if (files.length) {
        const form = new FormData();
        form.append("prompt", prompt);
        form.append("mode", mode);
        // 后端约定：multipart 可用 params（JSON string）或拆字段；这里统一走 params，避免字段解析差异
        form.append("params", JSON.stringify(params));
        files.forEach((f) => form.append("reference_images", f));
        resp = await client.createJobMultipart(form, abort.signal);
      } else {
        // JSON 请求：后端按 {prompt, mode, params:{...}} 解析
        resp = await client.createJobJSON({ prompt, mode, params }, abort.signal);
      }

      const job_id = resp?.job_id;
      const job_access_token = resp?.job_access_token;
      if (!job_id) {
        throw { error: { code: "BAD_RESPONSE", message: "后端未返回 job_id" } };
      }

      const rec: JobRecord = {
        job_id,
        job_access_token,
        created_at: isoNow(),
        status_cache: "QUEUED",
        prompt_preview: toPreview(prompt),
        params_cache: { aspect_ratio: aspect, image_size: size, temperature, timeout_sec: timeoutSec, max_retries: maxRetries },
        last_seen_at: isoNow(),
        pinned: false,
        tags: [],
      };

      useJobsStore.getState().upsertJob(rec);

      // remember last used as defaults
      updateDefaultParams(params);

      push({ kind: "success", title: "创建成功", message: `job_id: ${shortId(job_id)}` });
      navigate(`/history?job=${encodeURIComponent(job_id)}`);
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
              <div className="text-xs text-zinc-600 dark:text-zinc-300">拖拽/选择上传，支持预览与删除</div>
            </div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">{files.length}/14</div>
          </div>

          <div className="mt-3">
            <ImageDropzone files={files} setFiles={setFiles} maxFiles={14} />
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
            <Field label="aspect_ratio">
              <Select
                value={String(aspect)}
                onChange={(v) => setAspect(v)}
                options={[
                  { value: "1:1", label: "1:1" },
                  { value: "4:3", label: "4:3" },
                  { value: "3:4", label: "3:4" },
                  { value: "16:9", label: "16:9" },
                  { value: "9:16", label: "9:16" },
                  { value: "2:3", label: "2:3" },
                  { value: "3:2", label: "3:2" },
                ]}
              />
            </Field>

            <Field label="image_size">
              <Select
                value={String(size)}
                onChange={(v) => setSize(v)}
                options={[
                  { value: "1K", label: "1K" },
                  { value: "2K", label: "2K" },
                  { value: "4K", label: "4K" },
                ]}
              />
            </Field>

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
                min={10}
                max={180}
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

            <Divider />

            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">高级模式</div>
                <div className="text-xs text-zinc-600 dark:text-zinc-300">Text+Image（不推荐）</div>
              </div>
              <Switch value={mode === "TEXT_IMAGE"} onChange={(v) => setMode(v ? "TEXT_IMAGE" : "IMAGE_ONLY")} />
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
        last_seen_at: isoNow(),
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
              useJobsStore.getState().updateJob(jobId, { status_cache: data.status, last_seen_at: isoNow() });
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

function HistoryPage() {
  const { push } = useToast();
  const client = useApiClient();
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
  const [size, setSize] = useState<ImageSize | "ALL">("ALL");
  const [aspect, setAspect] = useState<AspectRatio | "ALL">("ALL");
  const [sort, setSort] = useState<SortKey>("latest");

  const [autoRefresh, setAutoRefresh] = useState(false);

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
        const hay = `${j.job_id} ${(j.prompt_preview || "")} ${(j.tags || []).join(" ")}`.toLowerCase();
        return hay.includes(tokens);
      });
    }

    if (statusFilter !== "ALL") {
      list = list.filter((j) => (j.status_cache || "UNKNOWN") === statusFilter);
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
        return (new Date(b.created_at).getTime() || 0) - (new Date(a.created_at).getTime() || 0);
      });
    }

    return list;
  }, [jobs, qd, statusFilter, range, from, to, size, aspect, sort]);

  // Auto refresh visible jobs status
  useEffect(() => {
    if (!autoRefresh) return;

    const controller = new AbortController();
    const tick = async () => {
      const visible = filtered.slice(0, 15);
      await mapLimit(visible, clamp(settings.polling.concurrency || 5, 1, 12), async (rec) => {
        try {
          const meta = await client.getJob(rec.job_id, rec.job_access_token, controller.signal);
          updateJob(rec.job_id, { status_cache: (meta.status || "UNKNOWN") as JobStatus, last_seen_at: isoNow() });
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
  }, [autoRefresh, filtered.length, settings.baseUrl, settings.polling.intervalMs, settings.polling.concurrency]);

  const selectJob = (id: string) => {
    setSearchParams((prev) => {
      prev.set("job", id);
      return prev;
    });
  };

  const onDeleteLocal = (id: string) => {
    removeJob(id);
    push({ kind: "success", title: "已删除本地记录" });
    if (selectedJobId === id) {
      setSearchParams((prev) => {
        prev.delete("job");
        return prev;
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

  return (
    <PageContainer>
      <PageTitle
        title="History"
        subtitle="只读浏览器本地历史（localStorage）。可筛选/搜索/置顶/打标签/删除。"
        right={
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 rounded-2xl border border-zinc-200 bg-white/60 px-3 py-2 text-sm dark:border-white/10 dark:bg-zinc-900/40">
              <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">自动刷新</span>
              <Switch value={autoRefresh} onChange={setAutoRefresh} />
            </div>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-1">
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
              <Field label="image_size">
                <Select
                  value={String(size)}
                  onChange={(v) => setSize(v as any)}
                  options={[
                    { value: "ALL", label: "全部" },
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
                    { value: "4:3", label: "4:3" },
                    { value: "3:4", label: "3:4" },
                    { value: "16:9", label: "16:9" },
                    { value: "9:16", label: "9:16" },
                    { value: "2:3", label: "2:3" },
                    { value: "3:2", label: "3:2" },
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
                  { value: "cost", label: "最贵（v1 先按时间）" },
                  { value: "latency", label: "最耗时（v1 先按时间）" },
                ]}
              />
            </Field>

            <Divider />

            <div className="text-xs text-zinc-500 dark:text-zinc-400">
              说明：后端不提供用户级历史列表，列表完全来自浏览器 localStorage。
            </div>
          </div>
        </Card>

        <Card className="lg:col-span-1">
          <div className="flex items-center justify-between">
            <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">任务列表</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">{filtered.length} 条</div>
          </div>
          <Divider />
          <JobList
            items={filtered}
            selectedId={selectedJobId}
            onSelect={selectJob}
            onDeleteLocal={onDeleteLocal}
            onTogglePin={onTogglePin}
            onAddTag={onAddTag}
          />
        </Card>

        <Card className="lg:col-span-1">
          <div className="text-sm font-bold text-zinc-900 dark:text-zinc-50">详情</div>
          <Divider />
          {selectedRec ? (
            <JobDetail rec={selectedRec} onUpdateToken={(tok) => updateJob(selectedRec.job_id, { job_access_token: tok })} />
          ) : (
            <EmptyHint text="从列表中选择一个 job" />
          )}
        </Card>
      </div>
    </PageContainer>
  );
}

function JobList({
  items,
  selectedId,
  onSelect,
  onDeleteLocal,
  onTogglePin,
  onAddTag,
}: {
  items: JobRecord[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDeleteLocal: (id: string) => void;
  onTogglePin: (id: string, v: boolean) => void;
  onAddTag: (id: string) => void;
}) {
  if (!items.length) return <EmptyHint text="没有匹配的记录" />;

  return (
    <div className="space-y-2">
      {items.slice(0, 200).map((j) => {
        const active = j.job_id === selectedId;
        return (
          <button
            key={j.job_id}
            onClick={() => onSelect(j.job_id)}
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

            <div className={cn("mt-2 flex flex-wrap gap-2 text-xs", active ? "text-white/85" : "text-zinc-600 dark:text-zinc-300")}>
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

            <div className={cn("mt-3 flex flex-wrap gap-2", active ? "" : "")}
              onClick={(e) => e.stopPropagation()}
            >
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
                variant="danger"
                className="!px-2 !py-1 text-xs"
                onClick={() => {
                  if (confirm("仅删除本地记录？")) onDeleteLocal(j.job_id);
                }}
              >
                删除本地
              </Button>
            </div>
          </button>
        );
      })}
      {items.length > 200 ? (
        <div className="rounded-2xl border border-dashed border-zinc-200 p-3 text-xs text-zinc-500 dark:border-white/10 dark:text-zinc-400">
          v1 默认最多显示最近 200 条（避免渲染压力）。
        </div>
      ) : null}
    </div>
  );
}

function JobDetail({ rec, onUpdateToken }: { rec: JobRecord; onUpdateToken: (tok: string) => void }) {
  const client = useApiClient();
  const { push } = useToast();
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
    const r: any = meta?.result;
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
      const newId = r?.job_id;
      const newTok = r?.job_access_token;
      if (!newId) throw { error: { message: "后端未返回 new job_id" } };

      useJobsStore.getState().upsertJob({
        job_id: newId,
        job_access_token: newTok,
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
      updateJob(rec.job_id, { status_cache: meta.status, last_seen_at: isoNow() });
    }
  }, [meta?.status, rec.job_id, updateJob]);

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
          <KeyValue k="aspect_ratio" v={(meta?.params?.aspect_ratio || rec.params_cache?.aspect_ratio || "-") as any} />
          <KeyValue k="image_size" v={(meta?.params?.image_size || rec.params_cache?.image_size || "-") as any} />
          <KeyValue k="temperature" v={(meta?.params?.temperature ?? rec.params_cache?.temperature ?? "-") as any} />
          <KeyValue k="timeout_sec" v={(meta?.params?.timeout_sec ?? rec.params_cache?.timeout_sec ?? "-") as any} />
          <KeyValue k="max_retries" v={(meta?.params?.max_retries ?? rec.params_cache?.max_retries ?? "-") as any} />
          <KeyValue k="latency_ms" v={meta?.response?.latency_ms ? `${meta.response.latency_ms}ms` : "-"} />
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

// -----------------------------
// Settings Page
// -----------------------------

function SettingsPage() {
  const { push } = useToast();
  const client = useApiClient();
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const resetSettings = useSettingsStore((s) => s.resetSettings);
  const clearJobs = useJobsStore((s) => s.clearJobs);
  const jobs = useJobsStore((s) => s.jobs);

  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [jobAuthMode, setJobAuthMode] = useState<JobAuthMode>(settings.jobAuthMode);

  const [adminEnabled, setAdminEnabled] = useState(settings.adminModeEnabled);
  const [adminKey, setAdminKey] = useState(settings.adminKey);

  const [theme, setTheme] = useState<ThemeMode>(settings.ui.theme);
  const [reduceMotion, setReduceMotion] = useState(settings.ui.reduceMotion);

  const [aspect, setAspect] = useState(settings.defaultParams.aspect_ratio);
  const [size, setSize] = useState(settings.defaultParams.image_size);
  const [temperature, setTemperature] = useState(settings.defaultParams.temperature);
  const [timeoutSec, setTimeoutSec] = useState(settings.defaultParams.timeout_sec);
  const [maxRetries, setMaxRetries] = useState(settings.defaultParams.max_retries);

  const [intervalMs, setIntervalMs] = useState(settings.polling.intervalMs);
  const [maxIntervalMs, setMaxIntervalMs] = useState(settings.polling.maxIntervalMs);
  const [concurrency, setConcurrency] = useState(settings.polling.concurrency);

  const [health, setHealth] = useState<any | null>(null);
  const [adminCheck, setAdminCheck] = useState<BillingSummary | null>(null);
  const [googleRemain, setGoogleRemain] = useState<GoogleRemaining | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    setBaseUrl(settings.baseUrl);
    setJobAuthMode(settings.jobAuthMode);
    setAdminEnabled(settings.adminModeEnabled);
    setAdminKey(settings.adminKey);
    setTheme(settings.ui.theme);
    setReduceMotion(settings.ui.reduceMotion);

    setAspect(settings.defaultParams.aspect_ratio);
    setSize(settings.defaultParams.image_size);
    setTemperature(settings.defaultParams.temperature);
    setTimeoutSec(settings.defaultParams.timeout_sec);
    setMaxRetries(settings.defaultParams.max_retries);

    setIntervalMs(settings.polling.intervalMs);
    setMaxIntervalMs(settings.polling.maxIntervalMs);
    setConcurrency(settings.polling.concurrency);
  }, [settings]);

  const save = () => {
    const next: Partial<SettingsV1> = {
      baseUrl: baseUrl.trim().replace(/\/$/, ""),
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
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
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
            <KeyValue k="aspect_ratio" v={settings.defaultParams.aspect_ratio as any} />
            <KeyValue k="image_size" v={settings.defaultParams.image_size as any} />
            <KeyValue k="temperature" v={settings.defaultParams.temperature.toFixed(2)} />
            <KeyValue k="timeout_sec" v={`${settings.defaultParams.timeout_sec}s`} />
            <KeyValue k="max_retries" v={settings.defaultParams.max_retries as any} />
          </div>

          <div className="mt-3">
            <Button
              variant="secondary"
              onClick={() => {
                setSettings({ defaultParams: { ...DEFAULT_SETTINGS.defaultParams } });
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
