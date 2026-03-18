import { test, expect } from "@playwright/test";
import { openApp, openCorePage } from "./helpers";

test("persists settings changes across reloads", async ({ page }) => {
  await openApp(page);
  await openCorePage(page, "nav-settings", "settings-save");

  const cacheToggle = page.getByTestId("settings-cache-enabled");
  await expect(cacheToggle).toHaveClass(/border-emerald-400/);

  await cacheToggle.click();
  await page.getByTestId("settings-save").click();

  await expect.poll(async () => {
    return page.evaluate(() => {
      const raw = window.localStorage.getItem("nbp_settings_v1");
      return raw ? JSON.parse(raw).cache?.enabled : null;
    });
  }).toBe(false);

  await page.reload();
  await expect(page.getByTestId("settings-save")).toBeVisible();
  await expect(page.getByTestId("settings-cache-enabled")).not.toHaveClass(/border-emerald-400/);
});
