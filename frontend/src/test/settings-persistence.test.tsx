import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../App";

describe("Settings persistence", () => {
  it("writes saved settings back to localStorage", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByTestId("nav-dashboard")).toBeInTheDocument();
    await user.click(screen.getByTestId("nav-settings"));
    expect(await screen.findByTestId("settings-save")).toBeInTheDocument();

    await user.click(screen.getByTestId("settings-cache-enabled"));
    await user.click(screen.getByTestId("settings-save"));

    await waitFor(() => {
      const raw = localStorage.getItem("nbp_settings_v1");
      expect(raw).toContain("\"enabled\":false");
    });
  });
});
