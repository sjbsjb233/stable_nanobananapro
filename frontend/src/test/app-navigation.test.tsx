import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../App";

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
  });
});
