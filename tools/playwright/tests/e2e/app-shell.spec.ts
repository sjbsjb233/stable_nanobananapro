import { test, expect } from "@playwright/test";
import { openApp, openCorePage } from "./helpers";

test("boots with admin bypass and navigates core pages", async ({ page }) => {
  await openApp(page);

  await openCorePage(page, "nav-create", "create-submit");
  await openCorePage(page, "nav-history", "history-search");
  await openCorePage(page, "nav-settings", "settings-save");

  await page.getByTestId("nav-admin").click();
  await expect(page.getByTestId("admin-user-search")).toBeVisible();
});
