import { describe, expect, it } from "vitest";

import cartridgeDocument from "../../content/incidents/phase-1-demo.json";
import incidentDocument from "../../content/incidents/incident-001.json";
import {
  createAgentInputEvents,
  createShellExecuteEvent,
  loadCartridge,
  reduce,
  step,
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
    expect(createTuiInputEvents(CARTRIDGE, STATE, " /exit ")).toMatchObject([
      { type: "terminal.mode-set", payload: { mode: "bash" } },
    ]);
  });

  it("inspects raw waiver input before slash, shell or intent normalization and mismatches deny", () => {
    const incident = loadCartridge(incidentDocument);
    let state = reduce({ cartridge: incident, seed: "waiver", events: [] });
    for (const event of createAgentInputEvents(
      incident,
      state,
      "detach europe",
    ))
      state = step(state, event);

    expect(createTuiInputEvents(incident, state, "I agree")).toMatchObject([
      { type: "mind.waiver-choice", payload: { accepted: true } },
    ]);
    for (const mismatch of [" I agree", "I agree ", "i agree", "/exit", "!pwd"])
      expect(createTuiInputEvents(incident, state, mismatch)).toMatchObject([
        { type: "mind.waiver-choice", payload: { accepted: false } },
      ]);
  });
});
