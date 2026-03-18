import { expect, Page } from "@playwright/test";

export async function openApp(page: Page, path = "/") {
  await page.goto(path);
  await expect(page.getByTestId("nav-dashboard")).toBeVisible();
}

export async function openCorePage(page: Page, navTestId: string, readyTestId: string) {
  await page.getByTestId(navTestId).click();
  await expect(page.getByTestId(readyTestId)).toBeVisible();
}
