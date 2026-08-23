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
import { createModelHandoffEvents, createTuiInputEvents } from "./tui.js";

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

describe("createModelHandoffEvents", () => {
  it("records one transition followed by replayable pair and incident response instances", () => {
    const document = JSON.parse(JSON.stringify(cartridgeDocument)) as Record<
      string,
      unknown
    >;
    const models = document["models"] as Record<string, unknown>[];
    const successor = models[1];
    if (successor === undefined) throw new Error("demo needs a second model");
    successor["archetype"] = "reckless";
    const presentation = document["presentation"] as Record<string, unknown>;
    const spinnerPools = presentation["spinnerPools"] as Record<
      string,
      unknown
    >[];
    spinnerPools.push({ archetype: "reckless", stage: 0, verbs: ["Rushing"] });
    const story = document["story"] as Record<string, unknown>;
    const responses = story["responses"] as Record<string, unknown>[];
    responses.push(
      { id: "pair-blame", text: "The pair is at fault." },
      { id: "incident-addition", text: "This incident agrees." },
    );
    story["phase2"] = {
      initialBeat: "start",
      facts: [],
      beats: [{ id: "start", ending: "" }],
      routes: [],
      handoffs: [
        {
          predecessor: "paranoid",
          successor: "reckless",
          response: "pair-blame",
          additionResponse: "incident-addition",
        },
      ],
      endings: [],
    };
    const cartridge = loadCartridge(document);
    const state = reduce({ cartridge, seed: "handoff", events: [] });

    const events = createModelHandoffEvents(
      cartridge,
      state,
      successor["id"] as string,
    );

    expect(events).toEqual([
      {
        type: "terminal.model-transitioned",
        payload: {
          predecessor: models[0]?.["id"],
          successor: successor["id"],
        },
        version: 0,
      },
      {
        type: "agent.response-recorded",
        payload: { responseId: "pair-blame", instanceId: "handoff-0-pair" },
        version: 0,
      },
      {
        type: "agent.response-recorded",
        payload: {
          responseId: "incident-addition",
          instanceId: "handoff-0-incident",
        },
        version: 0,
      },
    ]);
    expect(reduce({ cartridge, seed: state.seed, events })).toMatchObject({
      seed: "handoff",
    });
    expect(
      createModelHandoffEvents(cartridge, state, models[0]?.["id"] as string),
    ).toEqual([]);
  });
});
