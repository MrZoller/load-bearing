import { describe, expect, it } from "vitest";

import cartridgeDocument from "../content/incidents/phase-1-demo.json";
import {
  createAgentMessageEvent,
  createAgentResponseEvent,
  createMindPermissionChoiceEvent,
  createMindPermissionRequestEvent,
  readMindSlice,
  readStorySlice,
  createShellExecuteEvent,
  reduce,
} from "../engine/index.js";
import { createRuntimeSession } from "./session.js";

describe("createRuntimeSession", () => {
  it("uses an explicit acceptance seed without changing the cartridge", () => {
    const session = createRuntimeSession(cartridgeDocument, {
      seed: "acceptance/rare-hit",
    });

    expect(session.current().state.seed).toBe("acceptance/rare-hit");
    expect(session.cartridge.meta.number).toBe(0);
  });

  it("loads the demonstration cartridge and publishes immutable replay snapshots", () => {
    const session = createRuntimeSession(cartridgeDocument);
    const before = session.current();

    const after = session.dispatch(createShellExecuteEvent("pwd"));

    expect(session.cartridge.meta.number).toBe(0);
    expect(before).not.toBe(after);
    expect(before.eventLog).not.toBe(after.eventLog);
    expect(before.state).not.toBe(after.state);
    expect(before.eventLog).toEqual([]);
    expect(before.state.eventCount).toBe(0);
    expect(before.state.transcript).toEqual([]);
    expect(after.eventLog).toHaveLength(1);
    const current = session.current();
    expect(current).not.toBe(after);
    expect(current.eventLog).toBe(after.eventLog);
    expect(current.state).toBe(after.state);
  });

  it("replays its retained visitor log while accounting for shell event expansion", () => {
    const session = createRuntimeSession(cartridgeDocument);
    const snapshot = session.dispatch(createShellExecuteEvent("pwd"));

    // A shell envelope is one visitor event, but it expands into the recorded
    // history append and shell result that the engine exposes in its state.
    expect(snapshot.eventLog).toHaveLength(1);
    expect(snapshot.state.eventCount).toBeGreaterThan(snapshot.eventLog.length);
    expect(snapshot.state.transcript.length).toBeGreaterThan(
      snapshot.eventLog.length,
    );
    expect(snapshot.state.transcript.at(-1)).toMatchObject({
      output: [{ stream: "stdout", text: "/production/service" }],
    });

    expect(
      reduce({
        cartridge: session.cartridge,
        seed: snapshot.state.seed,
        events: snapshot.eventLog,
      }),
    ).toEqual(snapshot.state);
  });

  it("publishes no partial visitor turn when a later event in a batch is rejected", () => {
    const session = createRuntimeSession(cartridgeDocument);
    const before = session.current();

    expect(() =>
      session.dispatchMany([
        createAgentMessageEvent("turn-0", "inspect it"),
        createAgentResponseEvent("not-an-authored-response", "turn-0"),
      ]),
    ).toThrow(/unknown authored response/);

    expect(session.current()).toEqual(before);
  });

  it("dismisses a failed permission choice without recording its decision", () => {
    const document = JSON.parse(JSON.stringify(cartridgeDocument)) as any;
    document.story.phase2 = {
      initialBeat: "start",
      counters: [{ id: "full", initial: 1, maximum: 1 }],
      facts: [],
      beats: [{ id: "start", ending: "", actions: [], variants: [] }],
      endings: [],
    };
    document.story.intents[1].actions[0].grant = [
      { kind: "counter-add", counter: "full", amount: 1 },
    ];
    const session = createRuntimeSession(document);
    session.dispatch(createMindPermissionRequestEvent("delete-ready-sentinel"));

    session.dispatchMany([
      createMindPermissionChoiceEvent("delete-ready-sentinel", "grant"),
    ]);

    const snapshot = session.current();
    expect(snapshot.eventLog).toHaveLength(2);
    expect(readMindSlice(snapshot.state)).toMatchObject({
      pendingPermission: null,
      permissions: [],
    });
    expect(readStorySlice(snapshot.state).counters).toEqual([
      { id: "full", value: 1 },
    ]);
  });
});
