import { beforeEach, describe, expect, it } from "vitest";
import { clearFrontendLogs, getFrontendLogs, logError, logInfo } from "../logger";

describe("frontend logger", () => {
  beforeEach(() => {
    clearFrontendLogs();
  });

  it("stores and clears log entries", () => {
    logInfo("app", "hello");
    logError("app", "boom", { code: 500 });

    const entries = getFrontendLogs();
    expect(entries).toHaveLength(2);
    expect(entries[1].level).toBe("ERROR");
    expect(entries[1].details).toEqual({ code: 500 });

    clearFrontendLogs();
    expect(getFrontendLogs()).toHaveLength(0);
  });
});
