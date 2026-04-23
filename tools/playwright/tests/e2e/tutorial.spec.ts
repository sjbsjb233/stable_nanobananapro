import { test, expect, Page } from "@playwright/test";

const STORAGE_KEY = "nbp_tutorial_seen_v1";

type TutorialPage = "Create" | "Batch" | "History" | "Picker";

const PAGE_NAV: Record<TutorialPage, { navTestId: string; urlPath: string }> = {
  Create: { navTestId: "nav-create", urlPath: "/create" },
  Batch: { navTestId: "nav-batch", urlPath: "/batch" },
  History: { navTestId: "nav-history", urlPath: "/history" },
  Picker: { navTestId: "nav-picker", urlPath: "/picker" },
};

async function openFreshApp(page: Page) {
  // This spec intentionally does NOT use the shared `openApp` helper: that
  // helper installs a persistent init-script pre-seeding the tutorial-seen
  // flag, which would suppress the behaviour we're verifying here.
  await page.goto("/");
  await expect(page.getByTestId("nav-dashboard")).toBeVisible();
}

async function readSeen(page: Page): Promise<Record<string, boolean>> {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }, STORAGE_KEY);
}

async function gotoTutorialPage(page: Page, which: TutorialPage) {
  const { navTestId, urlPath } = PAGE_NAV[which];
  await page.getByTestId(navTestId).click();
  await page.waitForURL(new RegExp(`${urlPath}(\\?|$)`));
}

function tutorialDialog(page: Page, which: TutorialPage) {
  return page.getByRole("dialog", { name: new RegExp(`欢迎使用 ${which}`) });
}

function tutorialButton(page: Page, which: TutorialPage) {
  return page.getByRole("button", { name: `${which} 教程` });
}

test.describe("Tutorial widgets", () => {
  test.beforeEach(async ({ page }) => {
    await openFreshApp(page);
  });

  test("auto-opens once per page and persists the seen flag", async ({ page }) => {
    for (const which of ["Create", "Batch", "History", "Picker"] as TutorialPage[]) {
      await gotoTutorialPage(page, which);
      const dialog = tutorialDialog(page, which);
      await expect(dialog, `${which} tutorial should auto-open on first visit`).toBeVisible();
      await expect(dialog).toContainText(`新手教程 · ${which}`);
      await dialog.getByRole("button", { name: "关闭教程" }).click();
      await expect(dialog).toBeHidden();
    }

    await expect
      .poll(async () => readSeen(page))
      .toEqual({ Create: true, Batch: true, History: true, Picker: true });

    // Reload and visit every page again — modal must not auto-open.
    await page.reload();
    await expect(page.getByTestId("nav-dashboard")).toBeVisible();
    for (const which of ["Create", "Batch", "History", "Picker"] as TutorialPage[]) {
      await gotoTutorialPage(page, which);
      await expect(tutorialDialog(page, which)).toBeHidden();
      // Button is still visible so the user can reopen manually.
      await expect(tutorialButton(page, which)).toBeVisible();
    }
  });

  test("manual reopen via the 教程 button works even after the first visit", async ({ page }) => {
    await gotoTutorialPage(page, "Create");

    const dialog = tutorialDialog(page, "Create");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "关闭教程" }).click();
    await expect(dialog).toBeHidden();

    await tutorialButton(page, "Create").click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("描述你想要的画面");
  });

  test("step rail, arrow buttons and keyboard shortcuts navigate through steps", async ({ page }) => {
    await gotoTutorialPage(page, "Create");
    const dialog = tutorialDialog(page, "Create");
    await expect(dialog).toBeVisible();

    // Step 1 on mount
    await expect(dialog).toContainText("描述你想要的画面");
    await expect(dialog.getByRole("button", { name: "上一步" })).toBeDisabled();

    // 下一步 advances to step 2
    await dialog.getByRole("button", { name: "下一步" }).click();
    await expect(dialog).toContainText("拖拽上传最多 14 张参考图");

    // 上一步 goes back
    await dialog.getByRole("button", { name: "上一步" }).click();
    await expect(dialog).toContainText("描述你想要的画面");

    // Clicking the step rail jumps to step 3
    await dialog.getByRole("button", { name: "3 调参数" }).click();
    await expect(dialog).toContainText("模型 · 比例 · 尺寸 · 温度");

    // → key advances
    await page.keyboard.press("ArrowRight");
    await expect(dialog).toContainText("提交后自动排队并轮询");

    // Final step: button becomes 开始使用 and closes the dialog
    await expect(dialog.getByRole("button", { name: "开始使用 →" })).toBeVisible();
    await dialog.getByRole("button", { name: "开始使用 →" }).click();
    await expect(dialog).toBeHidden();

    // Reopen via button, then close via Esc
    await tutorialButton(page, "Create").click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("clicking the backdrop closes the modal", async ({ page }) => {
    await gotoTutorialPage(page, "History");
    const dialog = tutorialDialog(page, "History");
    await expect(dialog).toBeVisible();

    // Click the backdrop (outside the dialog card) to dismiss.
    await page.getByTestId("tutorial-backdrop").click({ position: { x: 10, y: 10 } });
    await expect(dialog).toBeHidden();
  });
});
