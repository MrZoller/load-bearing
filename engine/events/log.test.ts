import { describe, expect, it } from "vitest";

import { loadCartridge } from "../cartridge/load.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
import { EMPTY_EVENT_LOG, appendEvent, assertEventEnvelope } from "./log.js";
import { reduce } from "./reduce.js";
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

  it("copies all the way down, not just the top level", () => {
    // A one-level copy left this reachable: `probe.weighted` folds
    // `payload.entries` straight into `weightedPick`, so a caller retaining
    // that array could change a weight — or add an arm — after the event was
    // appended, and the same log would fold to a different distribution.
    const entries = [
      { value: "held", weight: 3 },
      { value: "gave-way", weight: 1 },
    ];
    const log = appendEvent(EMPTY_EVENT_LOG, {
      type: "probe.weighted",
      payload: { stream: "a", count: 5, entries },
    });

    entries[0]!.weight = 999;
    entries.push({ value: "smuggled", weight: 50 });

    expect(log[0]?.payload?.["entries"]).toEqual([
      { value: "held", weight: 3 },
      { value: "gave-way", weight: 1 },
    ]);
  });

  it("freezes the copy, so the appended event cannot be edited either", () => {
    const log = appendEvent(EMPTY_EVENT_LOG, {
      type: "probe.weighted",
      payload: { stream: "a", count: 1, entries: [{ value: "x", weight: 1 }] },
    });
    const stored = log[0]?.payload?.["entries"] as { weight: number }[];

    expect(Object.isFrozen(stored)).toBe(true);
    expect(() => {
      stored[0]!.weight = 2;
    }).toThrow(TypeError);
  });

  it("refuses a payload structured clone cannot copy at all", () => {
    expect(() =>
      appendEvent(EMPTY_EVENT_LOG, {
        type: "clock.tick",
        payload: { ms: 5, andThen: () => 1 },
      }),
    ).toThrow(/"payload" holds a value that cannot be copied/);
  });

  it("refuses a payload that clones cleanly but is not plain data", () => {
    // The gap between "copyable" and "recordable". Structured clone is happy
    // with all of these — it preserves them by internal slot — so without the
    // serializer check they would append successfully and fail much later, at
    // record time, which is exactly the deferred failure this is meant to
    // prevent. A cloned Map is also "frozen" and still mutable, since
    // `Object.freeze` does not reach internal slots.
    const notPlainData: readonly (readonly [string, unknown])[] = [
      ["Date", new Date(0)],
      ["Map", new Map([["a", 1]])],
      ["Set", new Set([1])],
      ["RegExp", /x/],
      ["typed array", new Uint8Array([1])],
    ];

    for (const [what, value] of notPlainData) {
      expect(
        () =>
          appendEvent(EMPTY_EVENT_LOG, {
            type: "clock.tick",
            payload: { ms: 5, [what]: value },
          }),
        what,
      ).toThrow(/"payload" is not plain data/);
    }
  });

  it("refuses a payload that contains itself", () => {
    // Structured clone *preserves* a cycle rather than refusing it, so the
    // clone came back fine and the freeze walk below it used to exhaust the
    // stack — a RangeError with none of the framing this function promises.
    const cyclic: Record<string, unknown> = { ms: 5 };
    cyclic["self"] = cyclic;

    expect(() =>
      appendEvent(EMPTY_EVENT_LOG, { type: "clock.tick", payload: cyclic }),
    ).toThrow(/nothing that contains itself/);
  });

  it("hardens the append path only, and the unhardened path behaves as documented", () => {
    // A real limit, not an oversight: `reduce` takes a raw array so a fixture
    // and a decoded replay permalink can be folded directly. Asserted by
    // exercising both paths with the same mutation, rather than by observing
    // that a fresh object literal is unfrozen — which would be true whatever
    // the engine did.
    const cartridge = loadCartridge(loadCartridgeFixture("minimal"));
    const seed = "2026-08-05/0/deep-foundation";
    const entries = [
      { value: "held", weight: 1 },
      { value: "gave-way", weight: 1 },
    ];
    const payload = { stream: "a", count: 20, entries };
    const detail = (events: readonly EngineEvent[]) =>
      reduce({ cartridge, seed, events }).transcript[0]?.detail;

    // Raw, straight into `reduce`: the caller still owns the payload, so
    // editing it afterwards changes how the same log folds.
    const raw: readonly EngineEvent[] = [{ type: "probe.weighted", payload }];
    const before = detail(raw);
    entries[1]!.weight = 1000;
    expect(detail(raw)).not.toEqual(before);

    // Through `appendEvent`: detached, so the same edit changes nothing.
    entries[1]!.weight = 1;
    const appended = appendEvent(EMPTY_EVENT_LOG, {
      type: "probe.weighted",
      payload,
    });
    const appendedBefore = detail(appended);
    entries[1]!.weight = 1000;
    expect(detail(appended)).toEqual(appendedBefore);
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
