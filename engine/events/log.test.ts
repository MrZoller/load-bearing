import { describe, expect, it } from "vitest";

import { loadCartridge } from "../cartridge/load.js";
import { deserialize, serialize } from "../serialize/canonical.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
import { EMPTY_EVENT_LOG, appendEvent, assertEventEnvelope } from "./log.js";
import { defineEventModule } from "./module.js";
import type { RegisteredHandler } from "./module.js";
import { reduce } from "./reduce.js";
import { createRegistry } from "./registry.js";
import type { EventRegistry } from "./registry.js";
import type { EngineEvent } from "./state.js";
import { renderTranscript } from "./transcript.js";

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

  it("stores the payload in canonical form, not as it was handed over", () => {
    // A structural copy preserves everything the canonical form flattens, and
    // all three of these are reachable from JSON.parse-able input alone — no
    // getter, no hand-built object. A handler reading `Object.keys` would then
    // see one order live and another when the same log is replayed from its
    // permalink, because the permalink went through the serializer on the way
    // out and the live payload never did. One log, two states.
    const shared = { n: 1 };
    const log = appendEvent(EMPTY_EVENT_LOG, {
      type: "clock.tick",
      payload: {
        ...(JSON.parse('{"b":1,"a":2}') as Record<string, unknown>),
        neg: -0,
        x: shared,
        y: shared,
      },
    });
    const stored = log[0]?.payload as Record<string, unknown>;

    expect(Object.keys(stored)).toEqual(["a", "b", "neg", "x", "y"]);
    expect(Object.is(stored["neg"], -0)).toBe(false);
    expect(stored["x"]).not.toBe(stored["y"]);

    // The property all three serve: the stored log already *is* what it will
    // be after a round trip, so folding it live and folding its permalink
    // cannot diverge.
    expect(serialize(deserialize(serialize(log)))).toBe(serialize(log));
  });

  it("folds identically live and after a serialize round trip", () => {
    // The end-to-end form of the same bug: a handler that reads key order,
    // run against an appended log and against that log's own permalink.
    const cartridge = loadCartridge(loadCartridgeFixture("minimal"));
    const seed = "2026-08-05/0/deep-foundation";
    const reporter = defineEventModule({
      namespace: "alpha",
      description: "reports what it sees in its payload",
      events: {
        "alpha.probe": {
          version: 0,
          apply: (context) => {
            const payload = context.event.payload ?? {};
            return {
              summary: `order=${Object.keys(payload).join(",")} negzero=${String(
                Object.is(payload["n"], -0),
              )}`,
            };
          },
        },
      },
    });
    const registry = createRegistry([reporter]);

    const log = appendEvent(
      EMPTY_EVENT_LOG,
      {
        type: "alpha.probe",
        payload: {
          ...(JSON.parse('{"b":1,"a":2}') as Record<string, unknown>),
          n: -0,
        },
      },
      registry,
    );
    const replayed = deserialize(serialize(log)) as readonly EngineEvent[];

    expect(
      serialize(reduce({ cartridge, seed, registry, events: replayed })),
    ).toBe(serialize(reduce({ cartridge, seed, registry, events: log })));
  });

  it("refuses a payload holding something JSON cannot carry", () => {
    // Structured clone refuses a function too, but the serializer now runs
    // first and refuses it by shape — so there is one designed error rather
    // than a second message about copying.
    expect(() =>
      appendEvent(EMPTY_EVENT_LOG, {
        type: "clock.tick",
        payload: { ms: 5, andThen: () => 1 },
      }),
    ).toThrow(/"payload" is not plain data/);
  });

  it("refuses the properties a clone would drop in silence", () => {
    // The reason the serializer judges the *original* rather than the copy.
    // Structured clone drops a non-enumerable and a symbol-keyed property
    // without a word, so cloning first meant the payload appended as clean
    // data and the original was never examined — a field its author believes
    // is in effect, gone.
    const nonEnumerable: Record<string, unknown> = { ms: 1 };
    Object.defineProperty(nonEnumerable, "hidden", {
      value: "dropped",
      enumerable: false,
    });
    expect(() =>
      appendEvent(EMPTY_EVENT_LOG, {
        type: "clock.tick",
        payload: nonEnumerable,
      }),
    ).toThrow(/"payload" is not plain data/);

    const symbolKeyed: Record<string, unknown> = { ms: 1 };
    (symbolKeyed as Record<symbol, unknown>)[Symbol("secret")] = "dropped";
    expect(() =>
      appendEvent(EMPTY_EVENT_LOG, {
        type: "clock.tick",
        payload: symbolKeyed,
      }),
    ).toThrow(/"payload" is not plain data/);
  });

  it("refuses an accessor without ever calling it", () => {
    // Reading it is exactly what an accessor is waiting for. The serializer
    // inspects descriptors instead of properties, so the getter is refused
    // rather than run — the same care `engine/serialize/canonical.ts` takes
    // throughout, and which cloning first quietly undid.
    let reads = 0;
    const withGetter: Record<string, unknown> = { ms: 1 };
    Object.defineProperty(withGetter, "computed", {
      enumerable: true,
      get: () => {
        reads += 1;
        return 1;
      },
    });

    expect(() =>
      appendEvent(EMPTY_EVENT_LOG, {
        type: "clock.tick",
        payload: withGetter,
      }),
    ).toThrow(/"payload" is not plain data/);
    expect(reads).toBe(0);
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

describe("a type that changes between reads", () => {
  /** An event whose `type` getter returns `honest` until the Nth read. */
  function shifty(honest: string, thenceforth: string, after: number) {
    let reads = 0;
    return {
      get type(): string {
        reads += 1;
        return reads > after ? thenceforth : honest;
      },
      payload: { ms: 1 },
    };
  }

  it("cannot slip a forged transcript line past the fold", () => {
    // The envelope is captured once, so the string that was checked is the
    // string that gets used. Re-reading would let a newline reach
    // `TranscriptEntry.type` — past `describeUnwritableText` and past the
    // handler lookup — and `renderTranscript` would then emit an extra line,
    // breaking its one-string-per-line contract.
    const cartridge = loadCartridge(loadCartridgeFixture("minimal"));
    const seed = "2026-08-05/0/deep-foundation";
    const event = shifty("clock.tick", "clock.tick\nFORGED", 1);
    const state = reduce({ cartridge, seed, events: [event] });

    expect(state.transcript[0]?.type).toBe("clock.tick");
    expect(renderTranscript(state.transcript)).toHaveLength(1);
  });

  it("cannot stamp an unregistered type into an appended log", () => {
    // `appendEvent` refuses an unregistered type on principle; re-reading would
    // let one be stamped into the log after `clock.tick` passed the lookup.
    const log = appendEvent(
      EMPTY_EVENT_LOG,
      shifty("clock.tick", "nosuch.type", 1),
    );

    expect(log[0]?.type).toBe("clock.tick");
  });

  it("hands the handler the same envelope the reducer dispatched on", () => {
    const cartridge = loadCartridge(loadCartridgeFixture("minimal"));
    const seen: string[] = [];
    const watcher = defineEventModule({
      namespace: "watcher",
      description: "reports the type it was given",
      events: {
        "watcher.look": {
          version: 0,
          apply: (context) => {
            seen.push(context.event.type);
            return {};
          },
        },
      },
    });

    reduce({
      cartridge,
      seed: "2026-08-05/0/deep-foundation",
      registry: createRegistry([watcher]),
      events: [shifty("watcher.look", "watcher.other", 1)],
    });

    expect(seen).toEqual(["watcher.look"]);
  });

  it("returns the captured envelope, frozen", () => {
    const captured = assertEventEnvelope(
      shifty("clock.tick", "other.type", 1),
      "event 0",
    );

    expect(Object.isFrozen(captured)).toBe(true);
    expect(captured.type).toBe("clock.tick");
    expect(captured.type).toBe("clock.tick");
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

describe("the log a caller hands over", () => {
  it("is read once, so the label and the append agree on the position", () => {
    // `log.length` for the error label and the spread below were two reads.
    // The divergence is confined to a message, which is why it is cheap rather
    // than urgent — but leaving a known member of a family this engine declares
    // closed is how the next one arrives.
    let reads = 0;
    const growing = {
      get length(): number {
        reads += 1;
        return reads > 1 ? 99 : 1;
      },
      0: { type: "clock.tick", payload: { ms: 1 }, version: 0 },
      [Symbol.iterator]: Array.prototype[Symbol.iterator],
    } as unknown as readonly EngineEvent[];

    // 99, not 1: the array iterator re-reads `length` as it goes, so the
    // captured log really is that long and the label names the position the
    // event would land at. Reading `log.length` for the label and spreading
    // separately labelled it 1 while appending at 99 — the label and the append
    // disagreeing is the whole defect, whatever the number.
    expect(() => appendEvent(growing, { type: "nope.nope" })).toThrow(
      /appended event 99 \(nope\.nope\)/,
    );
    expect(appendEvent(growing, TICK)).toHaveLength(100);
  });
});

describe("a caller-owned registry's handler", () => {
  it("stamps the version it validated, not a later read of it", () => {
    // A hand-built registry is caller-owned — `makeEntry` says so and guards
    // for it — and `handler.version` was read to validate, to report, and to
    // stamp. The stamp is the strongest form in this family: a stored value
    // that was never validated, and exactly the log/reducer mismatch
    // `createRegistry` describes as closed.
    let reads = 0;
    const registry = createRegistry([
      defineEventModule({
        namespace: "alpha",
        description: "",
        events: { "alpha.go": { version: 0, apply: () => ({}) } },
      }),
    ]);
    const real = registry.handler("alpha.go") as RegisteredHandler;
    const shifty: EventRegistry = {
      ...registry,
      handler: () => ({
        ...real,
        get version(): number {
          reads += 1;
          return reads > 1 ? -1 : 7;
        },
      }),
    };

    // `version: 7` is load-bearing. Without it the pre-fix guard
    // short-circuits on `envelope.version !== undefined` and never reads
    // `handler.version` at all, so validated and stored cannot diverge and the
    // test asserts nothing.
    const log = appendEvent(
      EMPTY_EVENT_LOG,
      { type: "alpha.go", version: 7 },
      shifty,
    );

    // The stored stamp is the validated value, and it is one the reducer's own
    // envelope check accepts.
    expect(log[0]?.version).toBe(7);
    expect(() => assertEventEnvelope(log[0], "event 0")).not.toThrow();
  });
});
