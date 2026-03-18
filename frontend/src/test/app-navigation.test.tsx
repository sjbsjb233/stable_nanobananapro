import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import App from "../App";
import { server } from "./server";

describe("App navigation", () => {
  it("boots with an authenticated session and navigates core pages", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByTestId("nav-dashboard")).toBeInTheDocument();

    await user.click(screen.getByTestId("nav-create"));
    expect(await screen.findByTestId("create-submit")).toBeInTheDocument();

    await user.click(screen.getByTestId("nav-history"));
    expect(await screen.findByTestId("history-search")).toBeInTheDocument();

    await user.click(screen.getByTestId("nav-settings"));
    expect(await screen.findByTestId("settings-save")).toBeInTheDocument();

    await user.click(screen.getByTestId("nav-admin"));
    expect(await screen.findByTestId("admin-danger-zone")).toBeInTheDocument();
    expect(await screen.findByTestId("admin-danger-switch-pause_generation")).toBeInTheDocument();
  });

  it("shows the emergency lock screen for a locked normal member session", async () => {
    server.use(
      http.get(/^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/v1\/auth\/me$/, () =>
        HttpResponse.json({
          authenticated: true,
          user: {
            user_id: "user-1",
            username: "alice",
            role: "USER",
            enabled: true,
            created_at: "2026-03-18T12:00:00Z",
            updated_at: "2026-03-18T12:00:00Z",
            last_login_at: "2026-03-18T12:00:00Z",
            policy: {
              daily_image_limit: 10,
              concurrent_jobs_limit: 1,
              turnstile_job_count_threshold: 1,
              turnstile_daily_usage_threshold: 8,
              daily_image_access_limit: 12,
              image_access_turnstile_bonus_quota: 0,
              daily_image_access_hard_limit: 12,
            },
          },
          usage: {
            quota_consumed_today: 0,
            remaining_images_today: 10,
            image_accesses_today: 0,
            image_access_bonus_quota_today: 0,
            image_access_limit_today: 12,
            image_access_hard_limit_today: 12,
          },
          generation_turnstile_verified_until: null,
          emergency: {
            active_switches: ["lock_member_backend"],
            operator_reason: "incident",
            public_message: "系统正在执行临时封控。",
            updated_at: "2026-03-18T12:00:00Z",
            updated_by_user_id: "admin-user",
            updated_by_username: "admin",
            locked_for_current_user: true,
            banner_message: "系统正在执行临时封控。",
          },
        })
      )
    );

    render(<App />);

    expect(await screen.findByText("系统当前仅保留管理员控制面")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "退出登录" })).toBeInTheDocument();
  });
});
