import { expect, Page } from "@playwright/test";

const TUTORIAL_STORAGE_KEY = "nbp_tutorial_seen_v1";

/**
 * Pre-seed the tutorial-seen flag so the auto-open modal doesn't block tests
 * that aren't specifically exercising the tutorial. Tests that want to see the
 * auto-open behaviour clear this key explicitly.
 */
export async function suppressTutorialAutoOpen(page: Page) {
  await page.addInitScript((key) => {
    try {
      const raw = window.localStorage.getItem(key);
      const current = raw ? JSON.parse(raw) : {};
      window.localStorage.setItem(
        key,
        JSON.stringify({ ...current, Create: true, Batch: true, History: true, Picker: true })
      );
    } catch {
      // ignore
    }
  }, TUTORIAL_STORAGE_KEY);
}

export async function openApp(page: Page, path = "/") {
  await suppressTutorialAutoOpen(page);
  await page.goto(path);
  await expect(page.getByTestId("nav-dashboard")).toBeVisible();
}

export async function openCorePage(page: Page, navTestId: string, readyTestId: string) {
  await page.getByTestId(navTestId).click();
  await expect(page.getByTestId(readyTestId)).toBeVisible();
}
