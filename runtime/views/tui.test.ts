import { describe, expect, it } from "vitest";

import cartridgeDocument from "../../content/incidents/phase-1-demo.json";
import {
  createShellExecuteEvent,
  loadCartridge,
  reduce,
} from "../../engine/index.js";
import { createTuiInputEvents } from "./tui.js";

const CARTRIDGE = loadCartridge(cartridgeDocument);
const STATE = reduce({
  cartridge: CARTRIDGE,
  seed: "2026-08-22/0/structural-audit",
  events: [],
});

describe("createTuiInputEvents", () => {
  it("routes exactly one shell prefix through the shared shell envelope", () => {
    expect(createTuiInputEvents(CARTRIDGE, STATE, "!pwd")).toEqual([
      createShellExecuteEvent("pwd"),
    ]);
    expect(createTuiInputEvents(CARTRIDGE, STATE, "!!pwd")).toEqual([
      createShellExecuteEvent("!pwd"),
    ]);
  });

  it("keeps ordinary input on the authored agent path and reserves /exit for the shared terminal mode event", () => {
    expect(
      createTuiInputEvents(CARTRIDGE, STATE, "inspect it").map(
        (event) => event.type,
      ),
    ).toEqual([
      "agent.activity-set",
      "agent.message-added",
      "shell.execute",
      "agent.response-recorded",
      "agent.activity-set",
    ]);
    expect(createTuiInputEvents(CARTRIDGE, STATE, "/exit")).toMatchObject([
      { type: "terminal.mode-set", payload: { mode: "bash" } },
    ]);
  });
});
