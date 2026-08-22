import { describe, expect, it } from "vitest";

import cartridgeDocument from "../../content/incidents/phase-1-demo.json";
import { loadCartridge } from "../cartridge/load.js";
import { createShellExecuteEvent } from "../commands/shell.js";
import { reduce } from "../events/reduce.js";
import { readAgentSlice } from "./agent.js";
import {
  createAgentInputEvents,
  normalizeAgentInput,
  selectAgentIntent,
} from "./intent.js";

const CARTRIDGE = loadCartridge(cartridgeDocument);
const SEED = "2026-08-22/0/structural-audit";

describe("authored agent input", () => {
  it("normalizes authored patterns and selects their response and ordered shell plan", () => {
    expect(normalizeAgentInput("  CHECK\tTHE   SENTINEL ")).toBe(
      "check the sentinel",
    );
    expect(selectAgentIntent(CARTRIDGE, "  CHECK\tTHE   SENTINEL ")).toEqual({
      intentId: "inspect-sentinel",
      responseId: "inspect",
      actions: [{ kind: "shell-execute", input: "cat src/ready.stale" }],
    });

    expect(
      createAgentInputEvents(
        CARTRIDGE,
        reduce({ cartridge: CARTRIDGE, seed: SEED, events: [] }),
        "inspect it",
      ),
    ).toEqual([
      expect.objectContaining({
        type: "agent.message-added",
        payload: { id: "turn-0", text: "inspect it" },
      }),
      createShellExecuteEvent("cat src/ready.stale"),
      expect.objectContaining({
        type: "agent.response-recorded",
        payload: { responseId: "inspect", instanceId: "turn-0" },
      }),
    ]);
  });

  it("plans the authored fallback as a visitor message followed by its response", () => {
    const events = createAgentInputEvents(
      CARTRIDGE,
      reduce({ cartridge: CARTRIDGE, seed: SEED, events: [] }),
      "please rotate the moon",
    );

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.type)).toEqual([
      "agent.message-added",
      "agent.response-recorded",
    ]);
    const state = reduce({ cartridge: CARTRIDGE, seed: SEED, events });
    expect(readAgentSlice(state).messages).toMatchObject([
      { role: "visitor", text: "please rotate the moon" },
      {
        role: "agent",
        responseId: "fallback",
        text: "I treated that as a request for a wider readiness review. The original task is now supporting it.",
      },
    ]);
  });
});
