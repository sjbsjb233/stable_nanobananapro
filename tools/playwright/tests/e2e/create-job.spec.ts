import { test, expect } from "@playwright/test";
import { openApp, openCorePage } from "./helpers";

test("creates a job and opens its history detail", async ({ page }) => {
  const prompt = `ci smoke ${Date.now()}`;

  await openApp(page);
  await openCorePage(page, "nav-create", "create-submit");

  await page.getByTestId("create-prompt").fill(prompt);
  await page.getByTestId("create-submit").click();

  await expect(page).toHaveURL(/\/history$/);

  const card = page.getByTestId("history-card").filter({ hasText: prompt }).first();
  await expect(card).toBeVisible({ timeout: 15_000 });

  await card.click();

  const dialog = page.getByRole("dialog", { name: "History detail modal" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(prompt);
  await expect(dialog).toContainText("SUCCEEDED", { timeout: 15_000 });
});
