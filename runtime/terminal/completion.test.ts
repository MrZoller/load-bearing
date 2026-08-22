import { describe, expect, it } from "vitest";

import cartridgeDocument from "../../content/incidents/phase-1-demo.json";
import {
  createShellExecuteEvent,
  loadCartridge,
  reduce,
} from "../../engine/index.js";
import { completeTerminalInput } from "./completion.js";

const CARTRIDGE = loadCartridge(cartridgeDocument);
const STATE = reduce({
  cartridge: CARTRIDGE,
  seed: "2026-08-22/0/structural-audit",
  events: [],
});

describe("completeTerminalInput", () => {
  it("completes TUI slash commands and Bash builtin commands at the caret", () => {
    expect(completeTerminalInput("tui", "/hel", 4, STATE)).toEqual({
      value: "/help",
      cursor: 5,
      candidates: ["/help"],
    });
    expect(completeTerminalInput("tui", "/C", 2, STATE)).toEqual({
      value: "/co",
      cursor: 3,
      candidates: ["/compact", "/cost"],
    });
    expect(completeTerminalInput("bash", "pw", 2, STATE)).toEqual({
      value: "pwd ",
      cursor: 4,
      candidates: ["pwd"],
    });
  });

  it("completes live VFS paths, including from a TUI shell escape", () => {
    expect(completeTerminalInput("bash", "cat src/rea", 11, STATE)).toEqual({
      value: "cat src/ready.stale ",
      cursor: 20,
      candidates: ["src/ready.stale"],
    });
    expect(completeTerminalInput("tui", "!cat src/wor", 12, STATE)).toEqual({
      value: "!cat src/worker.ts ",
      cursor: 19,
      candidates: ["src/worker.ts"],
    });
  });

  it("retains shell escaping when completing a live VFS filename with a space", () => {
    const stateWithSpacedFile = reduce({
      cartridge: CARTRIDGE,
      seed: "2026-08-22/0/structural-audit",
      events: [createShellExecuteEvent("touch escaped\\ space")],
    });
    const value = "cat escaped\\ sp";

    expect(
      completeTerminalInput("bash", value, value.length, stateWithSpacedFile),
    ).toEqual({
      value: "cat escaped\\ space ",
      cursor: 19,
      candidates: ["escaped space"],
    });
  });

  it("leaves unsupported positions and unmatched prefixes alone", () => {
    expect(completeTerminalInput("tui", "/help more", 5, STATE)).toBeNull();
    expect(completeTerminalInput("bash", "unknown", 7, STATE)).toBeNull();
  });
});
