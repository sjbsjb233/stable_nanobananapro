import { expect, test } from "@playwright/test";

const BASE_URL = "http://127.0.0.1:5178";
const ADMIN_COOKIE = "eyJ1c2VyX2lkIjogIjFmZjAxODI3YTkxNzA3NjhkMjY1NmMwYyJ9.aa6-cA.CPyq2oqG6B0uzph_K7ogDfTJHC0";
const USER_COOKIE = "eyJ1c2VyX2lkIjogIjc3NzdiYjljMjNiZDZiZDk3ZTJiYjg2MiJ9.aa6-cA.eJeAqlwswi-9DvsEcgCriif9lWQ";

async function loginWithCookie(page, cookieValue, path = "/batch") {
  await page.context().addCookies([{ name: "nbp_session", value: cookieValue, url: BASE_URL }]);
  await page.goto(`${BASE_URL}${path}`);
  await expect(page.getByText("Batch Info")).toBeVisible();
}

async function clearLocalData(page) {
  await page.evaluate(() => {
    localStorage.clear();
  });
  await page.reload();
  await expect(page.getByText("Batch Info")).toBeVisible();
}

function sectionSelect(page, sectionIndex, fieldIndex) {
  return page.locator("select").nth(6 + (sectionIndex - 1) * 4 + fieldIndex);
}

function sectionSlider(page, sectionIndex, fieldIndex) {
  return page.locator("input[type='range']").nth(2 + (sectionIndex - 1) * 2 + fieldIndex);
}

function sectionTitleInput(page, sectionIndex) {
  return page.getByPlaceholder("Slide title / Chapter title").nth(sectionIndex - 1);
}

function sectionPromptInput(page, sectionIndex) {
  return page.getByPlaceholder("描述这一页需要出现的主体、情绪、构图或画面动作").nth(sectionIndex - 1);
}

async function setSectionJobCount(page, sectionIndex, value) {
  const slider = sectionSlider(page, sectionIndex, 0);
  const current = Number(await slider.inputValue());
  await slider.focus();
  const key = value >= current ? "ArrowRight" : "ArrowLeft";
  for (let step = 0; step < Math.abs(value - current); step += 1) {
    await slider.press(key);
  }
}

async function setSectionTemperature(page, sectionIndex, value) {
  const slider = sectionSlider(page, sectionIndex, 1);
  const current = Number(await slider.inputValue());
  await slider.focus();
  const steps = Math.round(Math.abs(value - current) / 0.05);
  const key = value >= current ? "ArrowRight" : "ArrowLeft";
  for (let step = 0; step < steps; step += 1) {
    await slider.press(key);
  }
}

async function fillSectionBasics(page, sectionIndex, { title, prompt }) {
  await sectionTitleInput(page, sectionIndex).fill(title);
  await sectionPromptInput(page, sectionIndex).fill(prompt);
}

test.describe.serial("Batch page", () => {
  test("shows batch layout, tooltips, and inherited section defaults", async ({ page }) => {
    await loginWithCookie(page, ADMIN_COOKIE);
    await clearLocalData(page);

    await expect(page.getByText("Batch Info")).toBeVisible();
    await expect(page.getByText("Global Block")).toBeVisible();
    await expect(page.getByText("Advanced")).toBeVisible();
    await expect(page.getByRole("link", { name: "Batch" })).toHaveClass(/bg-zinc-900|bg-white/);

    await page.getByPlaceholder("Q2-Deck / Chapter-03 / Storyboard-A").fill("Spec Deck");
    await page.getByText("?").first().hover();
    await expect(page.getByText("历史记录会用它来标记同一批次")).toBeVisible();

    await sectionSelect(page, 1, 1).selectOption("16:9");
    await sectionSelect(page, 1, 2).selectOption({ label: "2K" });
    await setSectionJobCount(page, 1, 3);
    await setSectionTemperature(page, 1, 0.65);
    await sectionSelect(page, 1, 3).selectOption("EXISTING");
    await expect(sectionSlider(page, 1, 0)).toHaveValue("3");

    await page.getByRole("button", { name: "Add Section" }).click();
    await expect(sectionSelect(page, 2, 1)).toHaveValue("16:9");
    await expect(sectionSelect(page, 2, 2)).toHaveValue("2K");
    await expect(sectionSelect(page, 2, 3)).toHaveValue("EXISTING");
    await expect(sectionSlider(page, 2, 0)).toHaveValue("3");
  });

  test("supports existing session search, reverse chronological order, multiselect, and instant creation", async ({ page }) => {
    await loginWithCookie(page, ADMIN_COOKIE);
    await clearLocalData(page);

    await page.getByPlaceholder("Q2-Deck / Chapter-03 / Storyboard-A").fill("Session Deck");
    await sectionSelect(page, 1, 3).selectOption("EXISTING");

    await page.getByPlaceholder("Create session now").nth(0).fill("Session Alpha");
    await page.getByRole("button", { name: "New" }).nth(0).click();
    await page.getByPlaceholder("Create session now").nth(0).fill("Session Beta");
    await page.getByRole("button", { name: "New" }).nth(0).click();

    const cards = page.locator("label").filter({ has: page.locator("input[type='checkbox']") });
    await expect(cards.nth(0)).toContainText("Session Beta");
    await expect(cards.nth(1)).toContainText("Session Alpha");

    await page.getByPlaceholder("Search session name").nth(0).fill("Alpha");
    await expect(cards).toHaveCount(1);
    await expect(cards.nth(0)).toContainText("Session Alpha");

    await page.getByPlaceholder("Search session name").nth(0).fill("");
    await cards.nth(0).locator("input[type='checkbox']").check();
    await cards.nth(1).locator("input[type='checkbox']").check();
    await expect(page.getByText("Selected 2")).toBeVisible();
  });

  test("submits batch, auto-creates per-section sessions, and exposes batch metadata in history", async ({ page }) => {
    await loginWithCookie(page, ADMIN_COOKIE);
    await clearLocalData(page);

    await page.getByPlaceholder("Q2-Deck / Chapter-03 / Storyboard-A").fill("PW Batch");
    await page.getByPlaceholder("可选备注").fill("storyboard");
    await page.getByPlaceholder("例如：cinematic editorial lighting, crisp composition, premium presentation quality").fill(
      "global look {{batch_name}}"
    );

    await fillSectionBasics(page, 1, {
      title: "Intro",
      prompt: "hero frame {{section_title}}",
    });

    await page.getByRole("button", { name: "Add Section" }).click();
    await fillSectionBasics(page, 2, {
      title: "Closing",
      prompt: "final frame",
    });

    await expect(page.getByText("Prompt Preview").first()).toBeVisible();
    await expect(page.locator("pre").first()).toContainText("global look PW Batch");
    await expect(page.locator("pre").first()).toContainText("Page number: 1");
    await expect(page.getByText("PW Batch-P1-Intro")).toBeVisible();
    await expect(page.getByText("PW Batch-P2-Closing")).toBeVisible();

    await page.getByRole("button", { name: /Submit Batch \(2\)/ }).click();
    await expect(page.getByText("Batch queued 2/2")).toBeVisible({ timeout: 120000 });
    if (!page.url().includes("/history")) {
      await page.getByRole("link", { name: "History" }).click();
    }
    await expect(page).toHaveURL(/\/history/);
    await expect(page.getByText(/^PW Batch$/).first()).toBeVisible();
    await expect(page.getByText(/^storyboard$/).first()).toBeVisible();
    await expect(page.getByText(/Section 1/).first()).toBeVisible();

    const sessions = await page.evaluate(() => JSON.parse(localStorage.getItem("nbp_picker_sessions_v1") || "[]"));
    const targetSessions = sessions.filter((item) => item.name.startsWith("PW Batch-P"));
    expect(targetSessions.map((item) => item.name)).toEqual(
      expect.arrayContaining(["PW Batch-P1-Intro", "PW Batch-P2-Closing"])
    );
    expect(
      targetSessions.some((item) =>
        (item.items || []).some((entry) => String(entry.item_key || "").endsWith("::__pending__") || !entry.image_id)
      )
    ).toBeTruthy();

    await page.waitForFunction(
      () => {
        const sessions = JSON.parse(localStorage.getItem("nbp_picker_sessions_v1") || "[]");
        return sessions
          .filter((item) => item.name.startsWith("PW Batch-P"))
          .some((item) => (item.items || []).some((entry) => Boolean(entry.image_id)));
      },
      null,
      { timeout: 90000 }
    );
    const sessionsAfter = await page.evaluate(() => JSON.parse(localStorage.getItem("nbp_picker_sessions_v1") || "[]"));
    const hydrated = sessionsAfter.filter((item) => item.name.startsWith("PW Batch-P"));
    expect(
      hydrated.some((item) => (item.items || []).some((entry) => Boolean(entry.image_id) || String(entry.item_key || "").includes("::image_")))
    ).toBeTruthy();
  });

  test("triggers user turnstile modal by total batch count and counts quota when user batch submission is allowed", async ({ page }) => {
    await loginWithCookie(page, USER_COOKIE);
    await clearLocalData(page);

    await page.getByPlaceholder("Q2-Deck / Chapter-03 / Storyboard-A").fill("User Guard");
    await fillSectionBasics(page, 1, {
      title: "Guard",
      prompt: "guard prompt",
    });
    await setSectionJobCount(page, 1, 6);
    await page.getByRole("button", { name: /Submit Batch \(6\)/ }).click();
    await expect(page.getByText("需要二次验证")).toBeVisible();

    await loginWithCookie(page, USER_COOKIE);
    await clearLocalData(page);

    const beforeUsage = await page.evaluate(async () => {
      const resp = await fetch("http://127.0.0.1:8000/v1/auth/me", { credentials: "include" });
      return resp.json();
    });

    await page.getByPlaceholder("Q2-Deck / Chapter-03 / Storyboard-A").fill("User Batch");
    await fillSectionBasics(page, 1, {
      title: "Quota",
      prompt: "quota prompt",
    });
    await setSectionJobCount(page, 1, 2);
    await page.getByRole("button", { name: /Submit Batch \(2\)/ }).click();
    await expect(page.getByText("Batch queued 2/2")).toBeVisible({ timeout: 120000 });

    const afterUsage = await page.evaluate(async () => {
      const resp = await fetch("http://127.0.0.1:8000/v1/auth/me", { credentials: "include" });
      return resp.json();
    });

    expect(afterUsage.usage.quota_consumed_today - beforeUsage.usage.quota_consumed_today).toBe(2);
    await expect(page.getByText("User Batch", { exact: true }).first()).toBeVisible();
  });
});
