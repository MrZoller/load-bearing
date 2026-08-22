import { describe, expect, it } from "vitest";

import cartridgeDocument from "../content/incidents/phase-1-demo.json";
import { createShellExecuteEvent, reduce } from "../engine/index.js";
import { createRuntimeSession } from "./session.js";

describe("createRuntimeSession", () => {
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
});
