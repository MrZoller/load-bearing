import { describe, expect, it } from "vitest";

import { createTerminalHistory } from "./history.js";

describe("createTerminalHistory", () => {
  it("keeps visitor history mode-specific while retaining authored Bash history", () => {
    const history = createTerminalHistory(["git status", "", "pwd"]);

    history.record("tui", "inspect it");
    history.record("bash", "cat src/ready.stale");

    expect(history.previous("tui", "draft agent turn")).toBe("inspect it");
    expect(history.previous("bash", "draft shell turn")).toBe(
      "cat src/ready.stale",
    );
    expect(history.previous("bash", "ignored while navigating")).toBe("pwd");
    expect(history.next("bash", "ignored while navigating")).toBe(
      "cat src/ready.stale",
    );
    expect(history.next("bash", "ignored while navigating")).toBe(
      "draft shell turn",
    );
  });

  it("does not record empty submissions and restores an empty draft after navigation", () => {
    const history = createTerminalHistory();

    history.record("tui", "");
    expect(history.previous("tui", "")).toBe("");

    history.record("tui", "inspect it");
    expect(history.previous("tui", "")).toBe("inspect it");
    expect(history.next("tui", "")).toBe("");
  });
});
