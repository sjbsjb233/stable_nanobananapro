import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

export const frontendDir = path.resolve(scriptDir, "..");
export const repoDir = path.resolve(frontendDir, "..");

function parsePort(raw, fallback) {
  const value = Number.parseInt((raw || "").trim(), 10);
  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function stripTrailingSlash(url) {
  return url.replace(/\/+$/, "");
}

const backendPort = parsePort(process.env.NBP_BACKEND_PORT, 8000);
const frontendPort = parsePort(process.env.NBP_FRONTEND_PORT, 5173);

export const backendUrl = stripTrailingSlash(
  (process.env.NBP_BACKEND_URL || `http://127.0.0.1:${backendPort}`).trim()
);
export const frontendUrl = stripTrailingSlash(
  (process.env.NBP_FRONTEND_URL || `http://127.0.0.1:${frontendPort}`).trim()
);
export const backendDataDir = path.resolve(
  (process.env.NBP_BACKEND_DATA_DIR || path.join(repoDir, "backend", "data")).trim()
);
export const jobsDir = path.join(backendDataDir, "jobs");

export function frontendPage(target) {
  return new URL(target, `${frontendUrl}/`).toString();
}

export function createStoredSettings(overrides = {}) {
  const defaultParams = {
    aspect_ratio: "1:1",
    image_size: "1K",
    thinking_level: null,
    temperature: 0.7,
    timeout_sec: 120,
    max_retries: 1,
  };

  const defaults = {
    baseUrl: backendUrl,
    defaultModel: "gemini-3-pro-image-preview",
    jobAuthMode: "ID_ONLY",
    adminModeEnabled: false,
    adminKey: "",
    defaultParams,
    defaultParamsByModel: {
      "gemini-3-pro-image-preview": { ...defaultParams },
    },
    ui: { theme: "dark", language: "zh-CN", reduceMotion: true },
    polling: { intervalMs: 1200, maxIntervalMs: 5000, concurrency: 4 },
  };

  return {
    ...defaults,
    ...overrides,
    defaultParams: {
      ...defaults.defaultParams,
      ...(overrides.defaultParams || {}),
    },
    defaultParamsByModel: {
      ...defaults.defaultParamsByModel,
      ...(overrides.defaultParamsByModel || {}),
    },
    ui: {
      ...defaults.ui,
      ...(overrides.ui || {}),
    },
    polling: {
      ...defaults.polling,
      ...(overrides.polling || {}),
    },
  };
}
