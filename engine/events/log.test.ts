import { describe, expect, it } from "vitest";

import { EMPTY_EVENT_LOG, appendEvent, assertEventEnvelope } from "./log.js";
import type { EngineEvent } from "./state.js";

const TICK: EngineEvent = { type: "clock.tick", payload: { ms: 5 } };

describe("the event log", () => {
  it("starts empty and frozen", () => {
    expect(EMPTY_EVENT_LOG).toEqual([]);
    expect(Object.isFrozen(EMPTY_EVENT_LOG)).toBe(true);
  });

  it("appends by returning a new log, never by editing the old one", () => {
    const first = appendEvent(EMPTY_EVENT_LOG, TICK);
    const second = appendEvent(first, TICK);

    expect(EMPTY_EVENT_LOG).toHaveLength(0);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
    expect(Object.isFrozen(second)).toBe(true);
  });

  it("stamps the payload schema version the engine implements", () => {
    // A log produced through this function always says what it was written
    // against, which is what makes the version check on the way back in mean
    // something.
    expect(appendEvent(EMPTY_EVENT_LOG, TICK)[0]).toEqual({
      type: "clock.tick",
      payload: { ms: 5 },
      version: 0,
    });
  });

  it("copies the payload, so a caller cannot edit an event already appended", () => {
    const payload = { ms: 5 };
    const log = appendEvent(EMPTY_EVENT_LOG, { type: "clock.tick", payload });

    payload.ms = 9999;

    expect(log[0]?.payload).toEqual({ ms: 5 });
  });

  it("refuses an event nothing can fold", () => {
    expect(() => appendEvent(EMPTY_EVENT_LOG, { type: "shell.exec" })).toThrow(
      /no registered module handles this event type/,
    );
    expect(() => appendEvent(EMPTY_EVENT_LOG, { ...TICK, version: 3 })).toThrow(
      /declares payload schema version 3/,
    );
  });

  it("says which position in the log was refused", () => {
    const log = appendEvent(EMPTY_EVENT_LOG, TICK);
    expect(() => appendEvent(log, { type: "nope.nope" })).toThrow(
      /appended event 1 \(nope\.nope\)/,
    );
  });
});

describe("assertEventEnvelope", () => {
  const rejections: readonly (readonly [unknown, RegExp])[] = [
    [null, /must be an object with a string "type"/],
    [["clock.tick"], /must be an object with a string "type"/],
    ["clock.tick", /must be an object with a string "type"/],
    [{ kind: "clock.tick" }, /"type" must be a non-empty string/],
    [{ type: 42 }, /"type" must be a non-empty string/],
    [{ type: "" }, /"type" must be a non-empty string/],
    // One event has to render as one transcript line, and a recording holding
    // an unpaired surrogate could never be matched by a re-record.
    [{ type: "a\nb" }, /"type" contains a control character/],
    [{ type: "a\ud800" }, /"type" contains an unpaired surrogate/],
    [{ type: "clock.tick", payload: null }, /"payload" must be an object/],
    [{ type: "clock.tick", payload: [1] }, /"payload" must be an object/],
    [{ type: "clock.tick", version: 1.5 }, /"version" must be a non-negative/],
    [{ type: "clock.tick", version: -1 }, /"version" must be a non-negative/],
    [{ type: "clock.tick", version: "0" }, /"version" must be a non-negative/],
  ];

  it.each(rejections)("rejects %j", (event, expected) => {
    expect(() => assertEventEnvelope(event, "event 0")).toThrow(expected);
  });

  it("accepts the shapes a log legitimately holds", () => {
    for (const event of [
      { type: "clock.tick" },
      { type: "clock.tick", payload: {} },
      { type: "clock.tick", payload: { ms: 1 }, version: 0 },
    ]) {
      expect(() => assertEventEnvelope(event, "event 0")).not.toThrow();
    }
  });
});
