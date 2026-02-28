export type FrontendLogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

type FrontendLogEntry = {
  ts: string;
  level: FrontendLogLevel;
  scope: string;
  message: string;
  details?: unknown;
};

const KEY_FRONTEND_LOGS = "nbp_frontend_logs_v1";
const LEVEL_ORDER: Record<FrontendLogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

const retentionDays = readInt(import.meta.env.VITE_LOG_RETENTION_DAYS, 3, 1, 30);
const maxEntries = readInt(import.meta.env.VITE_LOG_MAX_ENTRIES, 1200, 200, 5000);
const minLevel = readLevel(import.meta.env.VITE_LOG_LEVEL, "INFO");

function readInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function readLevel(raw: unknown, fallback: FrontendLogLevel): FrontendLogLevel {
  const v = String(raw || fallback).trim().toUpperCase();
  if (v === "DEBUG" || v === "INFO" || v === "WARN" || v === "ERROR") return v;
  return fallback;
}

function nowISO() {
  return new Date().toISOString();
}

function shouldWrite(level: FrontendLogLevel) {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

function loadLogs(): FrontendLogEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY_FRONTEND_LOGS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLogs(entries: FrontendLogEntry[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(KEY_FRONTEND_LOGS, JSON.stringify(entries));
  } catch {
    // ignore storage failures
  }
}

function prune(entries: FrontendLogEntry[]): FrontendLogEntry[] {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const kept = entries.filter((entry) => {
    const ts = new Date(entry.ts).getTime();
    return Number.isFinite(ts) && ts >= cutoff;
  });
  if (kept.length <= maxEntries) return kept;
  return kept.slice(kept.length - maxEntries);
}

function toMessage(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function write(level: FrontendLogLevel, scope: string, message: unknown, details?: unknown) {
  if (!shouldWrite(level)) return;

  const entry: FrontendLogEntry = {
    ts: nowISO(),
    level,
    scope,
    message: toMessage(message),
    details,
  };

  const next = prune([...loadLogs(), entry]);
  saveLogs(next);

  const line = `[${entry.ts}] [${level}] [${scope}] ${entry.message}`;
  if (level === "ERROR") {
    console.error(line, details ?? "");
  } else if (level === "WARN") {
    console.warn(line, details ?? "");
  } else if (level === "DEBUG") {
    console.debug(line, details ?? "");
  } else {
    console.info(line, details ?? "");
  }
}

export function initFrontendLogger() {
  const cleaned = prune(loadLogs());
  saveLogs(cleaned);
  write("INFO", "logger", "frontend logger initialized", {
    retentionDays,
    maxEntries,
    minLevel,
  });
}

export function logDebug(scope: string, message: unknown, details?: unknown) {
  write("DEBUG", scope, message, details);
}

export function logInfo(scope: string, message: unknown, details?: unknown) {
  write("INFO", scope, message, details);
}

export function logWarn(scope: string, message: unknown, details?: unknown) {
  write("WARN", scope, message, details);
}

export function logError(scope: string, message: unknown, details?: unknown) {
  write("ERROR", scope, message, details);
}

export function getFrontendLogs(limit = 200): FrontendLogEntry[] {
  const n = readInt(limit, 200, 1, 5000);
  const logs = prune(loadLogs());
  return logs.slice(Math.max(0, logs.length - n));
}

export function clearFrontendLogs() {
  saveLogs([]);
}

declare global {
  interface Window {
    __NBP_LOGGER__?: {
      get: typeof getFrontendLogs;
      clear: typeof clearFrontendLogs;
    };
  }
}

if (typeof window !== "undefined") {
  window.__NBP_LOGGER__ = {
    get: getFrontendLogs,
    clear: clearFrontendLogs,
  };
}
