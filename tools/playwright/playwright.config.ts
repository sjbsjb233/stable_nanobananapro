import { defineConfig } from "@playwright/test";

const baseURL =
  process.env.PW_BASE_URL ||
  process.env.NBP_FRONTEND_URL ||
  `http://127.0.0.1:${process.env.NBP_FRONTEND_PORT || "5173"}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: true,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "output/playwright/report" }]],
  use: {
    baseURL,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        viewport: {
          width: 1440,
          height: 900,
        },
      },
    },
  ],
});
