import { describe, expect, it } from "vitest";

import { loadCartridge } from "../cartridge/load.js";
import type { LoadedCartridge } from "../cartridge/types.js";
import { MS_PER_DAY, parseTimestamp } from "../clock/civil.js";
import { hashString } from "../random/seed.js";
import { deserialize, serialize } from "../serialize/canonical.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
import { ENGINE_VERSION } from "../version.js";
import { defineEventModule } from "./module.js";
import type { EventModule } from "./module.js";
import { ENGINE_EVENT_REGISTRY } from "./modules.js";
import {
  EventVersionError,
  UnknownEventTypeError,
  bootstrap,
  reduce,
  restoreSnapshot,
  snapshot,
  step,
} from "./reduce.js";
import type { ReduceInput } from "./reduce.js";
import { createRegistry } from "./registry.js";
import {
  MAX_TRANSCRIPT_DETAIL_LINES,
  MAX_TRANSCRIPT_LINE_LENGTH,
} from "./transcript.js";
import type { EventRegistry } from "./registry.js";
import { EVENT_SCHEMA_VERSION } from "./state.js";
import type { EngineEvent, SessionState } from "./state.js";

const SEED = "2026-08-05/0/deep-foundation";
const STARTED_AT = "2026-08-05T09:14:22.000Z";

/**
 * The committed fixture world, loaded the way production does.
 *
 * One shared object, deliberately: a reducer that keyed a WeakMap on its
 * cartridge, or edited one in place, would answer identically to two freshly
 * loaded copies while behaving differently in a real session, which loads once
 * and reuses it.
 */
const CARTRIDGE: LoadedCartridge = loadCartridge(
  loadCartridgeFixture("minimal"),
);

/** A log that exercises both registered modules and both kinds of payload. */
const EVENTS: readonly EngineEvent[] = Object.freeze([
  { type: "clock.tick", payload: { ms: 1500 } },
  {
    type: "probe.random",
    payload: { stream: "spinner.verbs", count: 4, form: "uint32" },
  },
  { type: "clock.tick", payload: { ms: 0 } },
  { type: "probe.int", payload: { stream: "pids", count: 6, max: 5 } },
]);

function fold(events: readonly EngineEvent[] = EVENTS): SessionState {
  return reduce({ cartridge: CARTRIDGE, seed: SEED, events });
}

/** Freeze a value and everything reachable from it. */
function deepFreeze(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

describe("bootstrap", () => {
  it("hydrates a session from the cartridge with nothing folded on top", () => {
    const state = bootstrap({ cartridge: CARTRIDGE, seed: SEED });

    expect(state.engineVersion).toBe(ENGINE_VERSION);
    expect(state.eventSchemaVersion).toBe(EVENT_SCHEMA_VERSION);
    expect(state.seed).toBe(SEED);
    expect(state.eventCount).toBe(0);
    expect(state.transcript).toEqual([]);
    // The clock starts where the cartridge says the session does, and the PRNG
    // is seeded but untouched — an unread stream records no cursor.
    expect(state.clock).toEqual({
      startMs: parseTimestamp(STARTED_AT),
      elapsedMs: 0,
    });
    expect(state.random.cursors).toEqual({});
  });

  it("gives every stateful module its slice, and nobody else a key", () => {
    // `probe` is Phase 0's one stateful module; `clock` holds nothing, so it
    // must not appear at all rather than appearing as a null.
    expect(bootstrap({ cartridge: CARTRIDGE, seed: SEED }).slices).toEqual({
      probe: { events: 0, values: 0 },
    });
  });

  it("is where reduce starts: an empty log reduces to the bootstrap state", () => {
    expect(serialize(fold([]))).toBe(
      serialize(bootstrap({ cartridge: CARTRIDGE, seed: SEED })),
    );
  });
});

describe("reduce", () => {
  it("is pure: identical input folds to byte-identical state and transcript", () => {
    expect(serialize(fold())).toBe(serialize(fold()));
  });

  it("produces no observable difference when the same log is reduced twice", () => {
    // Not the same assertion as above. This one passes the *same frozen
    // objects* both times and interleaves an unrelated fold between them, so
    // hidden module state — a memo keyed on the cartridge, a counter that
    // changes behaviour after first use — would show up here and not there.
    const events = deepFreeze([...EVENTS]) as readonly EngineEvent[];
    const first = serialize(
      reduce({ cartridge: CARTRIDGE, seed: SEED, events }),
    );
    fold([{ type: "clock.tick", payload: { ms: 99 } }]);
    const second = serialize(
      reduce({ cartridge: CARTRIDGE, seed: SEED, events }),
    );

    expect(second).toBe(first);
  });

  it("reads each of its inputs exactly once", () => {
    // `input` is a caller-owned object like any other, and `cartridge`, `seed`
    // and `registry` were each read several times. A getter could then start
    // the clock from one cartridge while recording another, or key the
    // generator to one seed while `state.seed` named a second — a session that
    // lies about its own inputs, which the golden replay suite cannot see
    // because it folds the same lie twice.
    let cartridgeReads = 0;
    let seedReads = 0;
    let registryReads = 0;
    const other = loadCartridge({
      ...(loadCartridgeFixture("minimal") as Record<string, unknown>),
      meta: {
        schemaVersion: 0,
        number: 9,
        date: "2027-01-01",
        title: "Other",
        assignment: "A different world.",
        startedAt: "2027-01-01T00:00:00.000Z",
      },
    });
    // `registry` gets a counting getter too, because it is the read whose
    // double consequence is sharpest: bootstrapping the slices under one
    // registry and folding every event under another.
    const declared = createRegistry([
      defineEventModule<number>({
        namespace: "counted",
        description: "the module the first read of `registry` supplies",
        initialSlice: () => 0,
        events: { "counted.go": { version: 0, apply: () => ({}) } },
      }),
    ]);
    const shifty: ReduceInput = {
      get cartridge(): LoadedCartridge {
        cartridgeReads += 1;
        return cartridgeReads > 1 ? other : CARTRIDGE;
      },
      get seed(): string {
        seedReads += 1;
        return seedReads > 1 ? "2026-08-05/1/quick-patch" : SEED;
      },
      get registry(): EventRegistry {
        registryReads += 1;
        return registryReads > 1 ? ENGINE_EVENT_REGISTRY : declared;
      },
      events: [],
    };

    const state = reduce(shifty);

    // Exactly one read each — the property itself, and the crispest way to
    // state it. Asserting only self-consistency would not discriminate: a
    // getter that flips once and then stays gives a state consistently built
    // from the *second* value, which passes every internal cross-check while
    // being a session the caller never asked for.
    expect(cartridgeReads).toBe(1);
    expect(seedReads).toBe(1);
    expect(registryReads).toBe(1);

    // And the value used is the first one observed, not a later one.
    expect(state.cartridge.meta.title).toBe(CARTRIDGE.meta.title);
    expect(state.seed).toBe(SEED);
    expect(Object.keys(state.slices)).toEqual(["counted"]);

    // Self-consistency too, since that is what a restore would check.
    expect(state.clock.startMs).toBe(
      parseTimestamp(state.cartridge.meta.startedAt),
    );
    expect(state.random.seed).toBe(hashString(state.seed));
    // Restored under the registry the state was produced under, which is
    // `restoreSnapshot`'s documented precondition — and here that is the
    // registry the *first* read supplied, not the one a later read offered.
    expect(() => restoreSnapshot(snapshot(state), declared)).not.toThrow();
  });

  it("carries a cartridge no handler can write to", () => {
    // Every handler is handed the same `context.cartridge`, and it also sits
    // inside every session state and every recorded fixture. `loadCartridge`
    // freezes it all the way down so one subsystem cannot rewrite the world
    // for the nine after it — see engine/cartridge/load.ts.
    const state = fold();

    expect(Object.isFrozen(state.cartridge)).toBe(true);
    expect(Object.isFrozen(state.cartridge.meta)).toBe(true);
    expect(Object.isFrozen(state.cartridge.repository.files)).toBe(true);
    expect(() => {
      (state.cartridge.meta as { title: string }).title = "MUTATED";
    }).toThrow(TypeError);
  });

  it("leaves the cartridge and the log it was given untouched", () => {
    const cartridge = deepFreeze(
      loadCartridge(loadCartridgeFixture("minimal")),
    ) as LoadedCartridge;
    const events = deepFreeze([...EVENTS]) as readonly EngineEvent[];
    const before = serialize(cartridge);

    reduce({ cartridge, seed: SEED, events });

    expect(serialize(cartridge)).toBe(before);
  });

  it("returns frozen state, so an in-place edit throws where it happens", () => {
    const state = fold();

    // Every structure the reducer owns, not only the outermost one. A handler
    // holds `context.state`, so an unfrozen interior is a write into a session
    // that has already been folded — and `elapsedMs` and `cursors` are exactly
    // the two that would make a later replay diverge without a diff to show
    // for it.
    for (const frozen of [
      state,
      state.clock,
      state.random,
      state.random.cursors,
      state.slices,
      state.slices["probe"],
      state.transcript,
      state.transcript[0],
      state.transcript[1]?.detail,
    ]) {
      expect(Object.isFrozen(frozen)).toBe(true);
    }

    expect(() => {
      (state.clock as { elapsedMs: number }).elapsedMs = 0;
    }).toThrow(TypeError);
    expect(() => {
      (state.random.cursors as Record<string, number>)["root/probe"] = 0;
    }).toThrow(TypeError);
    expect(() => {
      (state.transcript as unknown as unknown[]).push({});
    }).toThrow(TypeError);
  });

  it("folds every event of a sparse log rather than skipping the holes", () => {
    // `Array.prototype.reduce` skips holes silently, which would fold fewer
    // events than the log appears to contain and record that as correct.
    const sparse: EngineEvent[] = [];
    sparse[2] = { type: "clock.tick", payload: { ms: 1 } };

    expect(() => fold(sparse)).toThrow(/event 0: an event must be an object/);
  });
});

describe("step", () => {
  it("equals reduce when the same log is folded one event at a time", () => {
    let state = bootstrap({ cartridge: CARTRIDGE, seed: SEED });
    for (const event of EVENTS) state = step(state, event);

    expect(serialize(state)).toBe(serialize(fold()));
  });

  it("equals reduce for every way of splitting the log in two", () => {
    // A resumed session is a split at an arbitrary point, so the equivalence
    // has to hold everywhere, not only at the ends.
    for (let cut = 0; cut <= EVENTS.length; cut += 1) {
      let state = reduce({
        cartridge: CARTRIDGE,
        seed: SEED,
        events: EVENTS.slice(0, cut),
      });
      for (const event of EVENTS.slice(cut)) state = step(state, event);

      expect(serialize(state)).toBe(serialize(fold()));
    }
  });

  it("advances the event count and appends exactly one transcript entry", () => {
    const before = bootstrap({ cartridge: CARTRIDGE, seed: SEED });
    const after = step(before, { type: "clock.tick", payload: { ms: 7 } });

    expect(before.eventCount).toBe(0);
    expect(after.eventCount).toBe(1);
    expect(after.transcript).toHaveLength(1);
    expect(after.transcript[0]).toEqual({
      index: 0,
      at: STARTED_AT,
      type: "clock.tick",
      summary: "ms=7",
      detail: [],
    });
  });

  it("stamps each entry with the instant the event was issued, not the one it ended at", () => {
    const state = fold([
      { type: "clock.tick", payload: { ms: 60000 } },
      { type: "clock.tick", payload: { ms: 0 } },
    ]);

    expect(state.transcript[0]?.at).toBe(STARTED_AT);
    expect(state.transcript[1]?.at).toBe("2026-08-05T09:15:22.000Z");
  });

  it("writes only the owning module's slice", () => {
    const state = fold([
      {
        type: "probe.random",
        payload: { stream: "a", count: 2, form: "float" },
      },
      { type: "clock.tick", payload: { ms: 1 } },
      { type: "probe.int", payload: { stream: "a", count: 3, max: 2 } },
    ]);

    expect(state.slices).toEqual({ probe: { events: 2, values: 5 } });
  });
});

describe("an unregistered event type", () => {
  it("fails loudly rather than folding in as a no-op", () => {
    const attempt = () =>
      fold([{ type: "shell.exec", payload: { input: "ls" } }]);

    expect(attempt).toThrow(UnknownEventTypeError);
    expect(attempt).toThrow(/no registered module handles this event type/);
    // The message has to be actionable: which event, and what does exist.
    expect(attempt).toThrow(/event 0 \(shell\.exec\)/);
    expect(attempt).toThrow(/Registered namespaces: clock, probe/);
  });

  it("names the offending event, since a log has many", () => {
    expect(() =>
      fold([
        { type: "clock.tick", payload: { ms: 1 } },
        { type: "clock.tick", payload: { ms: 1 } },
        { type: "vfs.write" },
      ]),
    ).toThrow(/event 2 \(vfs\.write\)/);
  });

  it("carries the type and the index as data, not only as text", () => {
    try {
      fold([{ type: "clock.tick", payload: { ms: 1 } }, { type: "nope.nope" }]);
      expect.unreachable("the fold should have refused an unregistered type");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(UnknownEventTypeError);
      expect((thrown as UnknownEventTypeError).type).toBe("nope.nope");
      expect((thrown as UnknownEventTypeError).index).toBe(1);
    }
  });

  it("is refused before any of the log is folded into the returned state", () => {
    // No partial state escapes: `reduce` throws, so there is no half-session to
    // record or render.
    expect(() =>
      fold([{ type: "clock.tick", payload: { ms: 1 } }, { type: "nope.nope" }]),
    ).toThrow();
  });
});

describe("event schema versioning", () => {
  it("accepts an event stamped with the version its handler implements", () => {
    expect(() =>
      fold([{ type: "clock.tick", version: 0, payload: { ms: 5 } }]),
    ).not.toThrow();
  });

  it("refuses one stamped with a version this engine does not implement", () => {
    const attempt = () =>
      fold([{ type: "clock.tick", version: 1, payload: { ms: 5 } }]);

    expect(attempt).toThrow(EventVersionError);
    expect(attempt).toThrow(/declares payload schema version 1/);
    expect(attempt).toThrow(/implements version 0 of clock\.tick/);
  });

  it("treats an unstamped event as current, which is what a fresh log means", () => {
    expect(serialize(fold([{ type: "clock.tick", payload: { ms: 5 } }]))).toBe(
      serialize(fold([{ type: "clock.tick", version: 0, payload: { ms: 5 } }])),
    );
  });
});

describe("snapshots", () => {
  it("round-trips through the canonical serializer byte for byte", () => {
    const text = snapshot(fold());
    expect(serialize(deserialize(text))).toBe(text);
  });

  it("restores to a state that serializes identically", () => {
    const state = fold();
    expect(serialize(restoreSnapshot(snapshot(state)))).toBe(serialize(state));
  });

  it("restores to a state that can be stepped as if it had never stopped", () => {
    const resumed = step(restoreSnapshot(snapshot(fold())), {
      type: "probe.random",
      payload: { stream: "spinner.verbs", count: 2, form: "uint32" },
    });
    const uninterrupted = fold([
      ...EVENTS,
      {
        type: "probe.random",
        payload: { stream: "spinner.verbs", count: 2, form: "uint32" },
      },
    ]);

    expect(serialize(resumed)).toBe(serialize(uninterrupted));
  });

  it("stores a slice a handler observes identically before and after a restore", () => {
    // The property "restoring and continuing is the same as never having
    // stopped" is about what a *handler* sees, and the resumption tests below
    // compare `serialize(...)` — through the very normalizer whose absence from
    // the fold path caused the divergence. So they are named for this and
    // cannot see it. These assertions read the slice the way a handler does.
    //
    // Note the scope: two live folds always agreed with each other, and two
    // replays always agreed with each other. `reduce(cartridge, seed, log)` was
    // never at risk. What was false is the narrower restore promise.
    const shared = { host: "eu-west" };
    const hazards = defineEventModule<Record<string, unknown>>({
      namespace: "hazards",
      description: "builds a slice that diverges from its own recorded form",
      initialSlice: () => ({}),
      events: {
        "hazards.write": {
          version: 0,
          apply: () => ({
            slice: {
              // Insertion order is not sorted order.
              zulu: 1,
              alpha: 2,
              // `-0` is a different value from `0` and the same JSON.
              drift: -0,
              // An own key the serializer drops, so `Object.hasOwn` flips.
              absent: undefined,
              // Two properties, one object: distinct after a round trip.
              left: shared,
              right: shared,
            },
          }),
        },
      },
    });
    const registry = createRegistry([hazards]);
    const state = reduce({
      cartridge: CARTRIDGE,
      seed: SEED,
      registry,
      events: [{ type: "hazards.write" }],
    });
    const restored = restoreSnapshot(snapshot(state), registry);

    const live = state.slices["hazards"] as Record<string, unknown>;
    const back = restored.slices["hazards"] as Record<string, unknown>;

    // The four axes, each read as a handler would read it. `Object.keys` order
    // is the `ls` case from issue #5: a pure handler printing a directory
    // listing showed one order live and another after a refresh.
    expect(Object.keys(live)).toEqual(Object.keys(back));
    expect(Object.keys(live)).toEqual([
      "alpha",
      "drift",
      "left",
      "right",
      "zulu",
    ]);
    expect(Object.is(live["drift"], -0)).toBe(false);
    expect(Object.hasOwn(live, "absent")).toBe(Object.hasOwn(back, "absent"));
    expect(Object.hasOwn(live, "absent")).toBe(false);
    expect(live["left"] === live["right"]).toBe(back["left"] === back["right"]);
  });

  it("normalizes -0 even where the previous canonical value was 0", () => {
    // The identity shortcut and the `-0` rule interact: `-0 === 0` is true, so
    // ordering the shortcut first let a recomputed `-0` land on top of a
    // canonical `0` and be stored unnormalized — the slice going stale on the
    // one axis this walk exists to fix, and only when the prior value happened
    // to be zero, which is the worst kind to find.
    const drifting = defineEventModule<{ drift: number }>({
      namespace: "drift",
      description: "writes 0 and then recomputes it as -0",
      initialSlice: () => ({ drift: 0 }),
      events: {
        "drift.go": {
          version: 0,
          apply: (context) => ({
            slice: { drift: context.index === 0 ? 0 : -0 },
          }),
        },
      },
    });
    const registry = createRegistry([drifting]);
    const state = reduce({
      cartridge: CARTRIDGE,
      seed: SEED,
      registry,
      events: [{ type: "drift.go" }, { type: "drift.go" }],
    });
    const live = (state.slices["drift"] as { drift: number }).drift;
    const back = (
      restoreSnapshot(snapshot(state), registry).slices["drift"] as {
        drift: number;
      }
    ).drift;

    expect(Object.is(live, -0)).toBe(false);
    expect(1 / live).toBe(Number.POSITIVE_INFINITY);
    expect(Object.is(live, back)).toBe(true);
  });

  it("refuses the properties a rebuild would drop, in arrays as well as objects", () => {
    // Rebuilding is destructive where freezing was not: whatever the walk does
    // not copy is gone inside the fold, where before it survived to the
    // canonical serializer and came back named with a JSON pointer. Each case
    // here used to throw at record time and briefly became silent destruction.
    const holding = (build: () => unknown): EventModule =>
      defineEventModule<unknown>({
        namespace: "shape",
        description: "returns a slice the canonical form could not carry",
        initialSlice: () => ({}),
        events: {
          "shape.go": { version: 0, apply: () => ({ slice: build() }) },
        },
      });
    const fold = (build: () => unknown) =>
      reduce({
        cartridge: CARTRIDGE,
        seed: SEED,
        registry: createRegistry([holding(build)]),
        events: [{ type: "shape.go" }],
      });

    // An array carrying a non-index property.
    expect(() => fold(() => Object.assign([1, 2], { foo: "state" }))).toThrow(
      /non-index property "foo"/,
    );
    // An array carrying a symbol key.
    expect(() =>
      fold(() => {
        const array: unknown[] = [1];
        (array as unknown as Record<symbol, unknown>)[Symbol("s")] = "state";
        return array;
      }),
    ).toThrow(/symbol-keyed property/);
    // An array index defined as a getter — which must not run.
    let reads = 0;
    expect(() =>
      fold(() => {
        const array: unknown[] = [];
        Object.defineProperty(array, "0", {
          enumerable: true,
          configurable: true,
          get: () => {
            reads += 1;
            return 1;
          },
        });
        array.length = 1;
        return array;
      }),
    ).toThrow(/is an accessor/);
    expect(reads).toBe(0);
    // A hole.
    expect(() => fold(() => [1, , 3] as unknown[])).toThrow(
      /hole in a sparse array/,
    );
    // And a non-enumerable own property on a plain object, which `Object.keys`
    // never showed the walk at all.
    expect(() =>
      fold(() => {
        const held: Record<string, unknown> = { visible: 1 };
        Object.defineProperty(held, "hidden", {
          value: "state",
          enumerable: false,
        });
        return held;
      }),
    ).toThrow(/non-enumerable property/);

    // The member of this family that is *preserved* rather than refused, and
    // the one the repository had already been bitten by: `rebuilt[key] = value`
    // invokes the inherited setter for the prototype key instead of creating an
    // own property, so the key vanishes and — for an object value — the slice
    // walks away wearing a prototype the handler chose. For a primitive nothing
    // throws at all and two states record as one. `load.ts`'s
    // `objectFromEntries` fixed exactly this for cartridges;
    // `load.test.ts` pins the same survival.
    //
    // `JSON.parse` rather than a literal, because a literal is the setter
    // syntax and does not create an own property. This is also the reachable
    // route: `deserialize` is `JSON.parse`, so a snapshot carries it here.
    const poisoned = () =>
      JSON.parse('{"__proto__": {"polluted": true}, "keep": 1}') as unknown;
    const state = fold(poisoned);
    const slice = state.slices["shape"] as Record<string, unknown>;

    expect(Object.keys(slice).sort()).toEqual(["__proto__", "keep"]);
    expect(Object.hasOwn(slice, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(slice)).toBe(Object.prototype);
    expect((slice as { polluted?: unknown }).polluted).toBeUndefined();

    // And through a restore, which is the path a snapshot actually takes.
    const registry = createRegistry([holding(poisoned)]);
    const restored = restoreSnapshot(
      snapshot(
        reduce({
          cartridge: CARTRIDGE,
          seed: SEED,
          registry,
          events: [{ type: "shape.go" }],
        }),
      ),
      registry,
    );
    const back = restored.slices["shape"] as Record<string, unknown>;

    expect(Object.hasOwn(back, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(back)).toBe(Object.prototype);
    expect(serialize(back)).toBe(serialize(slice));
  });

  it("looks the previous value up by own key, not through the prototype", () => {
    // The read side of the same inherited accessor. Looking the previous
    // canonical value up as `before[key]` answers from `Object.prototype` for
    // the prototype key rather than reporting it absent, so the walk is handed
    // a prototype object as a "previous canonical value" — and if the new value
    // happens to be that same object, the identity shortcut fires and stores
    // the live `Object.prototype` into the frozen slice.
    //
    // **Unreachable today, and pinned so a refactor cannot quietly drop it.**
    // It needs a handler to build an own prototype-named key holding
    // `Object.prototype` itself, which nothing does and which the walk refuses
    // by another route the moment the shortcut does not fire. This asserts the
    // refusal, not a live defect.
    const returning = (build: (index: number) => unknown): EventModule =>
      defineEventModule<unknown>({
        namespace: "readside",
        description: "hands over a prototype-named key on its second event",
        initialSlice: () => ({ keep: 1 }),
        events: {
          "readside.go": {
            version: 0,
            apply: (context) => ({ slice: build(context.index) }),
          },
        },
      });

    expect(() =>
      reduce({
        cartridge: CARTRIDGE,
        seed: SEED,
        registry: createRegistry([
          returning((index) =>
            index === 0
              ? { keep: 1 }
              : Object.defineProperty({ keep: 1 }, "__proto__", {
                  value: Object.prototype,
                  enumerable: true,
                  writable: true,
                  configurable: true,
                }),
          ),
        ]),
        events: [{ type: "readside.go" }, { type: "readside.go" }],
      }),
    ).toThrow(/non-enumerable property/);
  });

  it("keeps the shared structure a handler hands it, and refuses a cycle", () => {
    // The walk is incremental: it stops wherever the new slice shares structure
    // with the previous canonical one, which is what makes canonicalizing per
    // event cheaper than the deep freeze this function's comment refused.
    const files = defineEventModule<{ files: Record<string, unknown> }>({
      namespace: "files",
      description: "adds one file per event, sharing the rest",
      initialSlice: () => ({ files: { "/a": { size: 1 } } }),
      events: {
        "files.add": {
          version: 0,
          apply: (context, slice) => ({
            slice: {
              files: {
                ...slice.files,
                [`/f${String(context.index)}`]: { size: 2 },
              },
            },
          }),
        },
        "files.cycle": {
          version: 0,
          apply: () => {
            const loop: Record<string, unknown> = {};
            loop["self"] = loop;
            return { slice: { files: loop } };
          },
        },
      },
    });
    const registry = createRegistry([files]);
    const fold = (events: readonly EngineEvent[]) =>
      reduce({ cartridge: CARTRIDGE, seed: SEED, registry, events });

    // Stepped within one session, since sharing is what one fold carries
    // forward — two separate `reduce` calls necessarily build separate objects.
    const start = bootstrap({ cartridge: CARTRIDGE, seed: SEED, registry });
    const once = step(start, { type: "files.add" }, registry);
    const twice = step(once, { type: "files.add" }, registry);
    const untouched = (state: SessionState) =>
      (state.slices["files"] as { files: Record<string, unknown> }).files["/a"];

    // An untouched subtree is the same frozen object across events, not a copy:
    // the walk stops the moment it recognises what the previous slice held.
    expect(untouched(once)).toBe(untouched(start));
    expect(untouched(twice)).toBe(untouched(start));
    expect(Object.isFrozen(untouched(twice))).toBe(true);
    // And the event's own write did land.
    expect(
      Object.keys(
        (twice.slices["files"] as { files: Record<string, unknown> }).files,
      ),
    ).toEqual(["/a", "/f0", "/f1"]);

    // A cycle cannot be rebuilt, so it is refused here rather than becoming a
    // bare RangeError from unbounded recursion.
    expect(() => fold([{ type: "files.cycle" }])).toThrow(/contains itself/);
  });

  it("resumes from mid-session, where the last entry predates the clock", () => {
    // The opposite edge of the bound from the test above, and the one a real
    // session sits on: the log ends in a `clock.tick`, and an event is stamped
    // before it advances the clock — so the last transcript entry is strictly
    // earlier than `startMs + elapsedMs`.
    //
    // That is exactly what the `<=` upper bound in `restoreSnapshot` was
    // written to allow. Tightening it to `==` would reject every snapshot
    // taken after any event that took simulated time, breaking resumption
    // itself, and the `last == now` case above would not notice.
    const paused: readonly EngineEvent[] = [
      ...EVENTS,
      { type: "clock.tick", payload: { ms: 45000 } },
    ];
    const resumption: readonly EngineEvent[] = [
      { type: "probe.int", payload: { stream: "pids", count: 3, max: 4 } },
      { type: "clock.tick", payload: { ms: 250 } },
    ];

    const state = fold(paused);
    const last = state.transcript[state.transcript.length - 1];
    // The precondition the test exists for. Without it a later change to
    // `EVENTS` could make this silently re-test the `==` boundary.
    expect(parseTimestamp(last?.at ?? "")).toBeLessThan(
      state.clock.startMs + state.clock.elapsedMs,
    );

    let resumed = restoreSnapshot(snapshot(state));
    for (const event of resumption) resumed = step(resumed, event);

    expect(serialize(resumed)).toBe(
      serialize(fold([...paused, ...resumption])),
    );
  });

  it("validates rather than trusts what it is given", () => {
    const text = snapshot(fold());
    const edited = (
      change: (state: Record<string, unknown>) => void,
    ): string => {
      const parsed = deserialize(text) as Record<string, unknown>;
      change(parsed);
      return serialize(parsed);
    };

    expect(() => restoreSnapshot("[]")).toThrow(/"snapshot" must be an object/);
    expect(() =>
      restoreSnapshot(edited((s) => (s["engineVersion"] = "9.9.9"))),
    ).toThrow(/recorded by engine 9\.9\.9/);
    expect(() =>
      restoreSnapshot(edited((s) => (s["eventSchemaVersion"] = 7))),
    ).toThrow(/event schema version 7/);
    expect(() =>
      restoreSnapshot(edited((s) => (s["eventCount"] = 99))),
    ).toThrow(/transcript entr/);
    expect(() => restoreSnapshot(edited((s) => (s["slices"] = {})))).toThrow(
      /one entry per stateful module/,
    );
    expect(() =>
      restoreSnapshot(edited((s) => (s["random"] = { seed: 1, cursors: [] }))),
    ).toThrow(/cursors must be an object/);
    expect(() =>
      restoreSnapshot(
        edited((s) => (s["clock"] = { startMs: 0, elapsedMs: -1 })),
      ),
    ).toThrow(/elapsed must be an integer/);
    // The embedded cartridge goes back through the loader, so a snapshot
    // carrying a world this engine would refuse is refused on the way in.
    expect(() =>
      restoreSnapshot(
        edited((s) => {
          const cartridge = s["cartridge"] as Record<string, unknown>;
          (cartridge["meta"] as Record<string, unknown>)["schemaVersion"] = 99;
        }),
      ),
    ).toThrow(/cartridge is not valid/);
  });

  it("refuses a seed that does not hash to the recorded PRNG root", () => {
    // `bootstrap` derives the generator from the seed string, so the two are
    // one fact recorded twice. Editing either alone produces a session that
    // draws from one generator while claiming the seed of another — and
    // `reduce(cartridge, seed, log)` could never reproduce it.
    const text = snapshot(fold());
    const edited = (
      change: (state: Record<string, unknown>) => void,
    ): string => {
      const parsed = deserialize(text) as Record<string, unknown>;
      change(parsed);
      return serialize(parsed);
    };

    expect(() =>
      restoreSnapshot(edited((s) => (s["seed"] = "2026-08-05/1/quick-patch"))),
    ).toThrow(/hashes to \d+, but the recorded PRNG root is/);
    expect(() =>
      restoreSnapshot(
        edited((s) => {
          (s["random"] as Record<string, unknown>)["seed"] = 12345;
        }),
      ),
    ).toThrow(/recorded PRNG root is 12345/);

    // The invariant it enforces holds for every state the reducer produces,
    // which is what makes the check safe to apply unconditionally.
    const state = fold();
    expect(state.random.seed).toBe(hashString(state.seed));
  });

  it("refuses a clock that does not start where the cartridge says", () => {
    // The sibling of the seed check, on the same footing: `bootstrap` always
    // starts the clock with `createClock(cartridge.meta.startedAt)`, so these
    // are one fact recorded twice. Edit either and the session restores
    // cleanly while stamping instants `reduce(cartridge, seed, log)` would
    // never produce.
    const text = snapshot(fold());
    const edited = (
      change: (state: Record<string, unknown>) => void,
    ): string => {
      const parsed = deserialize(text) as Record<string, unknown>;
      change(parsed);
      return serialize(parsed);
    };

    expect(() =>
      restoreSnapshot(
        edited((s) => {
          const clock = s["clock"] as Record<string, number>;
          clock["startMs"] = (clock["startMs"] as number) + MS_PER_DAY;
        }),
      ),
    ).toThrow(/the clock starts at \d+, but the cartridge declares/);

    // And the other direction: moving the cartridge's declared start instead.
    expect(() =>
      restoreSnapshot(
        edited((s) => {
          const cartridge = s["cartridge"] as Record<string, unknown>;
          (cartridge["meta"] as Record<string, unknown>)["startedAt"] =
            "2026-08-06T09:14:22.000Z";
        }),
      ),
    ).toThrow(/"2026-08-06T09:14:22\.000Z"/);

    // A malformed clock still reports what is wrong with the clock, rather
    // than the two disagreeing — which is why the cross-check runs after
    // `restoreClock` and not before it.
    expect(() =>
      restoreSnapshot(
        edited((s) => (s["clock"] = { startMs: 0, elapsedMs: -1 })),
      ),
    ).toThrow(/elapsed must be an integer/);

    // The invariant holds for every state the reducer produces, which is what
    // makes the check safe to apply unconditionally.
    const state = fold();
    expect(state.clock.startMs).toBe(parseTimestamp(STARTED_AT));
  });

  it("refuses a transcript whose instants the clock could not have produced", () => {
    // The third "one fact recorded twice", after the seed and the start
    // instant. Every entry is stamped from this clock as it is folded, so
    // winding `elapsedMs` back lets the *next* event be stamped before entries
    // already in the transcript — time running backwards inside a session.
    const text = snapshot(
      fold([
        { type: "clock.tick", payload: { ms: 60000 } },
        { type: "clock.tick", payload: { ms: 60000 } },
      ]),
    );
    const edited = (
      change: (state: Record<string, unknown>) => void,
    ): string => {
      const parsed = deserialize(text) as Record<string, unknown>;
      change(parsed);
      return serialize(parsed);
    };
    const entriesOf = (state: Record<string, unknown>) =>
      state["transcript"] as Record<string, unknown>[];

    expect(() =>
      restoreSnapshot(
        edited((s) => {
          (s["clock"] as Record<string, number>)["elapsedMs"] = 0;
        }),
      ),
    ).toThrow(
      /the last transcript entry is stamped .* but the clock stopped at/,
    );

    // An `at` that is not an instant at all restores cleanly without the parse.
    expect(() =>
      restoreSnapshot(
        edited((s) => {
          entriesOf(s)[0]!["at"] = "banana";
        }),
      ),
    ).toThrow(/"transcript\[0\]\.at" is "banana", which is not a UTC instant/);

    // And two entries swapped: each parses, the pair does not run forwards.
    expect(() =>
      restoreSnapshot(
        edited((s) => {
          const entries = entriesOf(s);
          const first = entries[0]!["at"];
          entries[0]!["at"] = entries[1]!["at"];
          entries[1]!["at"] = first;
        }),
      ),
    ).toThrow(/earlier than the entry before it/);

    // The other end of the window: entries that predate the session.
    // Nondecreasing, inside the upper bound, and still a transcript this
    // reducer never wrote.
    expect(() =>
      restoreSnapshot(
        edited((s) => {
          for (const entry of entriesOf(s)) {
            entry["at"] = "2026-08-04T09:14:22.000Z";
          }
        }),
      ),
    ).toThrow(
      /the first transcript entry is stamped .* before the session began/,
    );

    // A valid instant spelled in a form the engine never writes. Caught by
    // re-formatting, so `parseTimestamp` stays lenient for the cartridge
    // authors who depend on it.
    expect(() =>
      restoreSnapshot(
        edited((s) => {
          entriesOf(s)[0]!["at"] = "2026-08-05T09:14:22Z";
        }),
      ),
    ).toThrow(/spelled in a form this engine never writes/);

    // The bounds are `<=` and `>=`, not `==`: an event is stamped at the
    // instant it was issued and only then advances the clock, so the last
    // entry legitimately sits before where the clock stopped — and an
    // unedited snapshot restores.
    expect(() => restoreSnapshot(text)).not.toThrow();
  });

  it("refuses transcript text that could not have been recorded", () => {
    // `deserialize` is bare `JSON.parse`, so the check `step` runs on a
    // handler's output has to be repeated on the way back in — otherwise a
    // snapshot restores cleanly and breaks `renderTranscript`'s one-string-
    // per-line contract afterwards.
    const text = snapshot(fold());
    const withEntry = (
      change: (entry: Record<string, unknown>) => void,
    ): string => {
      const parsed = deserialize(text) as Record<string, unknown>;
      const entries = parsed["transcript"] as Record<string, unknown>[];
      change(entries[0] as Record<string, unknown>);
      return serialize(parsed);
    };

    expect(() =>
      restoreSnapshot(withEntry((entry) => (entry["summary"] = "a\nb"))),
    ).toThrow(/"transcript\[0\]\.summary" contains a control character/);
    expect(() =>
      restoreSnapshot(withEntry((entry) => (entry["type"] = "a b"))),
    ).toThrow(/"transcript\[0\]\.type" contains a control character/);
    expect(() =>
      restoreSnapshot(withEntry((entry) => (entry["at"] = "\ud800"))),
    ).toThrow(/"transcript\[0\]\.at" contains an unpaired surrogate/);
    expect(() =>
      restoreSnapshot(
        withEntry((entry) => (entry["detail"] = ["fine", "not\rfine"])),
      ),
    ).toThrow(/"transcript\[0\]\.detail\[1\]" contains a control character/);
  });

  it("requires a zero-event state to be exactly what bootstrap produces", () => {
    // The total check is only possible here: with no events folded the state is
    // determined entirely by cartridge, seed and registry, all three of which
    // the snapshot carries. At N events it also depends on the event log, which
    // a snapshot does not contain — so there is no "now do it for N" version of
    // this. It is also not a hand-written rule like "zero events means no
    // cursors", which would be wrong for a module that draws inside
    // `initialSlice`; bootstrap reproduces whatever that module does.
    const text = snapshot(bootstrap({ cartridge: CARTRIDGE, seed: SEED }));
    const edited = (change: (state: Record<string, unknown>) => void) => {
      const parsed = deserialize(text) as Record<string, unknown>;
      change(parsed);
      return serialize(parsed);
    };

    expect(() =>
      restoreSnapshot(
        edited((s) => {
          (s["slices"] as Record<string, unknown>)["probe"] = {
            events: 3,
            values: 9,
          };
        }),
      ),
    ).toThrow(/must be exactly what bootstrapping this cartridge and seed/);

    expect(() =>
      restoreSnapshot(
        edited((s) => {
          const random = s["random"] as Record<string, unknown>;
          random["cursors"] = { "root/probe": 12345 };
        }),
      ),
    ).toThrow(/must be exactly what bootstrapping this cartridge and seed/);

    expect(() => restoreSnapshot(text)).not.toThrow();
  });

  it("round-trips a zero-event state whose slice was drawn or derived", () => {
    // The two positive properties the check's comment argues from, which the
    // refusal cases above do not exercise. Both were asserted in prose only,
    // which is the shape that was wrong in an earlier round.
    //
    // A module drawing inside `initialSlice` records a cursor at zero events,
    // so a hand-written "zero events means no cursors" rule would be wrong;
    // comparing against bootstrap reproduces whatever the module does.
    const drawing = defineEventModule<{ roll: number }>({
      namespace: "drawing",
      description: "draws from its own stream while building its first slice",
      initialSlice: (context) => ({ roll: context.random.nextUint32() }),
      events: { "drawing.go": { version: 0, apply: () => ({}) } },
    });
    // And a cartridge-dependent slice has to survive the cartridge itself
    // going through `serialize` and `loadCartridge` on the way back.
    const derived = defineEventModule<{ title: string; files: number }>({
      namespace: "derived",
      description: "builds its first slice out of the cartridge",
      initialSlice: (context) => ({
        title: context.cartridge.meta.title,
        files: Object.keys(context.cartridge.repository.files).length,
      }),
      events: { "derived.go": { version: 0, apply: () => ({}) } },
    });

    const registry = createRegistry([drawing, derived]);
    const state = bootstrap({ cartridge: CARTRIDGE, seed: SEED, registry });

    // Preconditions, so this cannot pass vacuously if a later change stops the
    // module drawing or stops the slice depending on the cartridge.
    expect(Object.keys(state.random.cursors)).toEqual(["root/drawing"]);
    expect(state.slices["derived"]).toEqual({
      title: CARTRIDGE.meta.title,
      files: Object.keys(CARTRIDGE.repository.files).length,
    });

    const restored = restoreSnapshot(snapshot(state), registry);
    expect(serialize(restored)).toBe(serialize(state));
  });

  it("refuses an empty transcript whose clock has nonetheless moved", () => {
    // The bounds that tie the clock to the transcript need a transcript. With
    // zero events there is nothing for them to bound, so a bootstrap snapshot
    // with `elapsedMs` edited restored cleanly and stamped its first event a
    // day after the cartridge's declared start. Nothing can advance the clock
    // before the first event — `BootstrapContext` carries no clock — which is
    // the same proof the first-entry bound rests on, applied where there is no
    // first entry.
    const text = snapshot(bootstrap({ cartridge: CARTRIDGE, seed: SEED }));
    const parsed = deserialize(text) as Record<string, unknown>;
    (parsed["clock"] as Record<string, number>)["elapsedMs"] = MS_PER_DAY;

    expect(() => restoreSnapshot(serialize(parsed))).toThrow(
      /the clock has advanced 86400000ms but the transcript is empty/,
    );
    expect(() => restoreSnapshot(text)).not.toThrow();
  });

  it("applies the transcript bounds on the restore door too", () => {
    // `requireTranscript` is the other way an entry enters a `SessionState`,
    // and it applied neither ceiling — so a hand-edited snapshot restored with
    // an entry no fold could have written, and the exported constants bounded
    // what `step` produces rather than what a state may hold. `requireLine`
    // states the rule: both doors, not only the one the reducer writes through.
    const text = snapshot(fold([{ type: "clock.tick", payload: { ms: 1 } }]));
    const withEntry = (change: (entry: Record<string, unknown>) => void) => {
      const parsed = deserialize(text) as Record<string, unknown>;
      const entries = parsed["transcript"] as Record<string, unknown>[];
      change(entries[0] as Record<string, unknown>);
      return serialize(parsed);
    };

    expect(() =>
      restoreSnapshot(
        withEntry((entry) => {
          entry["detail"] = new Array<string>(
            MAX_TRANSCRIPT_DETAIL_LINES + 1,
          ).fill("x");
        }),
      ),
    ).toThrow(/holds 4097 lines/);
    expect(() =>
      restoreSnapshot(
        withEntry((entry) => {
          entry["summary"] = "z".repeat(MAX_TRANSCRIPT_LINE_LENGTH + 1);
        }),
      ),
    ).toThrow(/is 4097 characters/);
  });

  it("refuses a PRNG cursor belonging to no registered module", () => {
    // No divergence is possible from an extra cursor — `fork` derives a stream
    // from the seed and the path, never from another stream's position — so
    // what this defends is the snapshot's claim to be
    // `reduce(cartridge, seed, log)`, exactly like the seed and clock checks.
    const text = snapshot(
      fold([
        {
          type: "probe.random",
          payload: { stream: "a", count: 2, form: "uint32" },
        },
      ]),
    );
    const withCursor = (path: string, at: number): string => {
      const parsed = deserialize(text) as Record<string, unknown>;
      const random = parsed["random"] as Record<string, unknown>;
      (random["cursors"] as Record<string, number>)[path] = at;
      return serialize(parsed);
    };

    expect(() => restoreSnapshot(withCursor("root/ghost", 12345))).toThrow(
      /"random\.cursors" holds "root\/ghost", which belongs to no module/,
    );
    // Bare `root` cannot be recorded either: nothing draws from the root
    // stream, only from `root/<namespace>` forks.
    expect(() => restoreSnapshot(withCursor("root", 777))).toThrow(
      /belongs to no module in this registry/,
    );
    // Same registry-drift framing as the transcript-type check: a renamed
    // module lands here legitimately, so the message says so.
    expect(() => restoreSnapshot(withCursor("root/ghost", 1))).toThrow(
      /recorded under a registry that has since changed/,
    );
    expect(() => restoreSnapshot(text)).not.toThrow();
  });

  it("refuses a transcript entry whose type nothing registers", () => {
    // The missing member of the family: transcript text, transcript instants,
    // seed against PRNG root, clock against `startedAt` — and now the type.
    // Every entry the reducer writes took its type from a successful handler
    // lookup in `step`, so one that resolves to nothing was written elsewhere.
    // `requireSlices` cannot stand in for this: `CLOCK_MODULE` is stateless,
    // so a registry missing it still passes the slice-set check.
    const text = snapshot(fold());
    const withType = (type: string): string => {
      const parsed = deserialize(text) as Record<string, unknown>;
      const entries = parsed["transcript"] as Record<string, unknown>[];
      entries[0]!["type"] = type;
      return serialize(parsed);
    };

    expect(() => restoreSnapshot(withType("vfs.write"))).toThrow(
      /"transcript\[0\]\.type" is "vfs\.write", which no module in this registry registers/,
    );
    expect(() => restoreSnapshot(withType("not even a type shape"))).toThrow(
      /which no module in this registry registers/,
    );
    expect(() => restoreSnapshot(text)).not.toThrow();
  });

  it("also refuses a legitimate snapshot after its module was renamed", () => {
    // Documenting a known consequence, not locking in a bug. The check above
    // is right for a snapshot restored under the registry it was produced
    // under, which is what `restoreSnapshot` requires — but
    // `EVENT_SCHEMA_VERSION` is one global envelope version and deliberately
    // does not move when a subsystem changes, so a snapshot recorded before a
    // module was renamed lands here too.
    //
    // The stateless case is the sharp one: `requireSlices` catches a renamed
    // *stateful* module by its slice key, so this is the only check that sees
    // a renamed stateless one. Hence the message names drift alongside
    // tampering rather than accusing.
    const before = defineEventModule({
      namespace: "oldname",
      description: "stateless, so requireSlices will not notice it leaving",
      events: { "oldname.ping": { version: 0, apply: () => ({}) } },
    });
    const after = defineEventModule({
      namespace: "newname",
      description: "the same module, renamed",
      events: { "newname.ping": { version: 0, apply: () => ({}) } },
    });

    const recorded = snapshot(
      reduce({
        cartridge: CARTRIDGE,
        seed: SEED,
        registry: createRegistry([before]),
        events: [{ type: "oldname.ping" }],
      }),
    );

    // Restored under the registry it was produced under: fine.
    expect(() =>
      restoreSnapshot(recorded, createRegistry([before])),
    ).not.toThrow();

    // Restored after the rename: refused, and the message says why it might
    // not be tampering.
    expect(() => restoreSnapshot(recorded, createRegistry([after]))).toThrow(
      /recorded under a registry that has since changed/,
    );
  });

  it("refuses a validator that returns undefined instead of throwing", () => {
    // The third and last door into `slices`, and the one that was open.
    // `bootstrap` refuses an `initialSlice` returning `undefined` and
    // `captureOutcome`'s `hasSlice` refuses a handler doing it; a validator
    // could still hand one back, and `(s, w) => cond ? {n: 0} : undefined`
    // typechecks with inferred `S`. The result was an own key holding
    // `undefined` — `Object.hasOwn` true, the module given `undefined` from
    // then on, `snapshot()` succeeding, and the *next* restore blaming
    // registry drift.
    const lax = defineEventModule<{ n: number } | undefined>({
      namespace: "lax",
      description: "a validator that declines by returning nothing",
      initialSlice: () => ({ n: 0 }),
      validateSlice: () => undefined,
      events: { "lax.go": { version: 0, apply: () => ({}) } },
    });
    const registry = createRegistry([lax]);
    const text = snapshot(
      reduce({
        cartridge: CARTRIDGE,
        seed: SEED,
        registry,
        events: [{ type: "lax.go" }],
      }),
    );

    expect(() => restoreSnapshot(text, registry)).toThrow(
      /validateSlice returned undefined/,
    );
  });

  it("routes each slice to the module that knows its shape", () => {
    // The reducer can check that the *set* of slices matches the registry and
    // nothing more. Without the module's own validator this restores happily
    // and the next probe event folds `"oops1"` into recorded state.
    const parsed = deserialize(snapshot(fold())) as Record<string, unknown>;
    (parsed["slices"] as Record<string, unknown>)["probe"] = {
      events: "oops",
      values: 0,
    };

    expect(() => restoreSnapshot(serialize(parsed))).toThrow(
      /snapshot: slices\.probe: events must be an integer between 0 and/,
    );
  });

  it("leaves a slice alone when its module declares no validator", () => {
    // The hook is optional on purpose, and a module without one must behave
    // exactly as it did before the hook existed.
    //
    // Built on a snapshot with history rather than a bootstrap one. A
    // zero-event state is now checked whole against a fresh `bootstrap`, so an
    // edited slice there is refused before any per-module question is reached:
    // `restoreSnapshot` would throw and this assertion would fail, testing the
    // zero-event check rather than the property named above. With one event
    // folded, the state is no longer determined by its inputs alone, and the
    // absence of narrowing is the only thing left to observe.
    const lax = defineEventModule<unknown>({
      namespace: "lax",
      description: "declares no slice validator",
      initialSlice: () => ({ anything: true }),
      events: {
        "lax.noop": { version: 0, apply: () => ({ slice: { folded: true } }) },
      },
    });
    const registry = createRegistry([lax]);
    const text = snapshot(
      reduce({
        cartridge: CARTRIDGE,
        seed: SEED,
        registry,
        events: [{ type: "lax.noop" }],
      }),
    );
    const parsed = deserialize(text) as Record<string, unknown>;
    (parsed["slices"] as Record<string, unknown>)["lax"] = { whatever: 1 };

    expect(restoreSnapshot(serialize(parsed), registry).slices["lax"]).toEqual({
      whatever: 1,
    });
  });
});

describe("a module's own state", () => {
  /** Reads another module's slice, which the context is supposed to allow. */
  const observer: EventModule = defineEventModule<string[]>({
    namespace: "observer",
    description: "records what the other module's slice looked like",
    initialSlice: () => [],
    events: {
      "observer.look": {
        version: 0,
        apply(context, slice) {
          const seen = JSON.stringify(context.state.slices["counter"]);
          return { slice: [...slice, seen], summary: seen };
        },
      },
    },
  });

  const counter: EventModule = defineEventModule<number>({
    namespace: "counter",
    description: "counts",
    initialSlice: () => 0,
    events: {
      "counter.bump": {
        version: 0,
        apply: (_c, slice) => ({ slice: slice + 1 }),
      },
    },
  });

  const registry = createRegistry([observer, counter]);

  it("is readable by another module through the context", () => {
    const state = reduce({
      cartridge: CARTRIDGE,
      seed: SEED,
      registry,
      events: [
        { type: "observer.look" },
        { type: "counter.bump" },
        { type: "observer.look" },
      ],
    });

    expect(state.slices["observer"]).toEqual(["0", "1"]);
  });

  it("is the only thing a handler can write", () => {
    const state = reduce({
      cartridge: CARTRIDGE,
      seed: SEED,
      registry,
      events: [{ type: "counter.bump" }],
    });

    // The observer's slice is untouched by an event it did not handle, and the
    // counter cannot have reached it: the reducer takes only the slice the
    // handler returns and discards everything else.
    expect(state.slices).toEqual({ counter: 1, observer: [] });
  });

  it("must be a shape Object.freeze can actually make inert", () => {
    // The one-level promise `freezeSlice` makes requires that freezing works at
    // that level, and on a branded value it does not: `map.set(…)` after
    // `Object.freeze` is `slice.count += 1` in another spelling — the exact
    // accident the freeze exists to stop, through a surface reporting frozen.
    // A typed array does not survive `Object.freeze` at all.
    //
    // Hardening, not representability: a *nested* Map still passes here and is
    // refused by the canonical serializer at record time, with a pointer to the
    // path. That is a better error than this could produce, and costs nothing
    // per event.
    const holding = (slice: unknown): EventModule =>
      defineEventModule({
        namespace: "branded",
        description: "keeps its state in internal slots",
        initialSlice: () => slice,
        events: { "branded.go": { version: 0, apply: () => ({}) } },
      });
    const boot = (slice: unknown) =>
      bootstrap({
        cartridge: CARTRIDGE,
        seed: SEED,
        registry: createRegistry([holding(slice)]),
      });

    for (const branded of [
      new Map([["a", 1]]),
      new Set([1]),
      new Date(0),
      new Uint8Array([1, 2, 3]),
    ]) {
      expect(() => boot(branded)).toThrow(
        /must be a plain object or array at its top level/,
      );
    }

    // A class instance with plain fields is genuinely protected by
    // `Object.freeze`, but its prototype is not one of the three, so it is
    // refused too — the predicate is a prototype question, not a mutability
    // audit, and that is what gives it an end.
    expect(() => boot(new (class Holder {})())).toThrow(/internal slots/);

    // Nested is not this function's question, and passes.
    expect(() => boot({ inner: new Map([["a", 1]]) })).not.toThrow();
  });

  it("is checked on every path a slice enters state by, not just bootstrap", () => {
    // `freezeSlice` has three call sites and the case above exercises one.
    // A branded slice arriving from a *handler* or from a *snapshot* is the
    // same accident through a different door.
    const returning = defineEventModule<unknown>({
      namespace: "branded",
      description: "returns a branded slice from its handler",
      initialSlice: () => ({ n: 0 }),
      events: {
        "branded.go": {
          version: 0,
          apply: () => ({ slice: new Map([["a", 1]]) }),
        },
      },
    });
    const registry = createRegistry([returning]);

    // The fold path, through `nextSlices`.
    expect(() =>
      reduce({
        cartridge: CARTRIDGE,
        seed: SEED,
        registry,
        events: [{ type: "branded.go" }],
      }),
    ).toThrow(/must be a plain object or array at its top level/);

    // The restore path, through `requireSlices`. A `Map` cannot survive the
    // canonical serializer, so the snapshot is built by hand — which is how a
    // tampered one would arrive anyway.
    const plain = defineEventModule<unknown>({
      namespace: "branded",
      description: "same namespace, keeps its slice plain",
      initialSlice: () => ({ n: 0 }),
      events: { "branded.go": { version: 0, apply: () => ({}) } },
    });
    const plainRegistry = createRegistry([plain]);
    const parsed = deserialize(
      snapshot(
        bootstrap({
          cartridge: CARTRIDGE,
          seed: SEED,
          registry: plainRegistry,
        }),
      ),
    ) as Record<string, unknown>;

    expect(() =>
      restoreSnapshot(
        serialize(parsed),
        createRegistry([
          defineEventModule<unknown>({
            namespace: "branded",
            description: "a validator that hands back a branded value",
            initialSlice: () => ({ n: 0 }),
            validateSlice: () => new Map([["a", 1]]),
            events: { "branded.go": { version: 0, apply: () => ({}) } },
          }),
        ]),
      ),
    ).toThrow(/must be a plain object or array at its top level/);
  });

  it("must be a value, not a per-session decision", () => {
    // Statefulness follows from *declaring* `initialSlice`, which is what the
    // contract says — so a module that returns `undefined` conditionally
    // ("holds state only when the cartridge declares X") is outside it. This
    // typechecks with no cast, snapshots fine, and then fails its own restore
    // with `requireSlices` complaining about a slice set nobody chose.
    const conditional = defineEventModule<{ n: number } | undefined>({
      namespace: "cond",
      description: "holds state only sometimes, which is not an option",
      initialSlice: (context) =>
        context.cartridge.meta.number > 0 ? { n: 0 } : undefined,
      events: {
        "cond.go": { version: 0, apply: (_context, slice) => ({ slice }) },
      },
    });

    expect(() =>
      bootstrap({
        cartridge: CARTRIDGE,
        seed: SEED,
        registry: createRegistry([conditional]),
      }),
    ).toThrow(/declares initialSlice but returned undefined/);
  });

  it("catches a hand-built truthy `stateful` by the same check", () => {
    // The route a field-shape guard on `stateful` would have covered. A
    // non-boolean truthy value takes the stateful path, so its undefined slice
    // is refused by the check above rather than needing one of its own —
    // verified here rather than assumed.
    const sound = defineEventModule({
      namespace: "hand",
      description: "declares no slice",
      events: { "hand.go": { version: 0, apply: () => ({}) } },
    });
    const handBuilt = {
      ...sound,
      stateful: "yes",
    } as unknown as EventModule;

    expect(sound.stateful).toBe(false);
    expect(() =>
      bootstrap({
        cartridge: CARTRIDGE,
        seed: SEED,
        registry: createRegistry([handBuilt]),
      }),
    ).toThrow(/declares initialSlice but returned undefined/);
  });

  it("is frozen, so a handler cannot edit the state it was handed", () => {
    // The likely accident, and the one that reaches backwards: `slice.n += 1`
    // on the slice a handler received would change a state that has already
    // been folded and possibly already recorded.
    const grabby = defineEventModule<{ n: number }>({
      namespace: "grabby",
      description:
        "edits the slice it was given instead of returning a new one",
      initialSlice: () => ({ n: 0 }),
      events: {
        "grabby.poke": {
          version: 0,
          apply(_context, slice) {
            slice.n += 1;
            return {};
          },
        },
      },
    });

    const registry = createRegistry([grabby]);
    expect(
      Object.isFrozen(
        bootstrap({ cartridge: CARTRIDGE, seed: SEED, registry }).slices[
          "grabby"
        ],
      ),
    ).toBe(true);
    expect(() =>
      reduce({
        cartridge: CARTRIDGE,
        seed: SEED,
        registry,
        events: [{ type: "grabby.poke" }],
      }),
    ).toThrow(TypeError);
  });

  it("cannot be kept by a module that declared none", () => {
    const smuggler = defineEventModule({
      namespace: "smuggler",
      description: "returns a slice it never declared",
      events: {
        "smuggler.hide": { version: 0, apply: () => ({ slice: "kept" }) },
      },
    });

    expect(() =>
      reduce({
        cartridge: CARTRIDGE,
        seed: SEED,
        registry: createRegistry([smuggler]),
        events: [{ type: "smuggler.hide" }],
      }),
    ).toThrow(/declares no initialSlice but its handler returned one/);
  });

  it("is what a mismatched registry is caught by, and the limit of it", () => {
    // Documenting a precondition, not locking in a bug. `reduce` threads one
    // registry through bootstrap and every step, so this is reachable only by
    // stepping by hand with a different one.
    //
    // Caught: a slice the state does not carry.
    const withoutCounter = bootstrap({
      cartridge: CARTRIDGE,
      seed: SEED,
      registry: createRegistry([observer]),
    });
    expect(() =>
      step(withoutCounter, { type: "counter.bump" }, registry),
    ).toThrow(/has no slice for module "counter"/);

    // Caught: a snapshot whose slice set disagrees with the registry.
    expect(() => restoreSnapshot(snapshot(withoutCounter), registry)).toThrow(
      /one entry per stateful module/,
    );

    // NOT caught, deliberately: same namespaces, different semantics. Closing
    // it needs a registry fingerprint in SessionState — a snapshot format
    // change — for a path only a caller passing two different registries can
    // reach. `step`'s docstring states the precondition.
    const doppelganger = createRegistry([
      observer,
      defineEventModule<number>({
        namespace: "counter",
        description: "same name, counts by a hundred",
        initialSlice: () => 0,
        events: {
          "counter.bump": {
            version: 0,
            apply: (_c, slice) => ({ slice: slice + 100 }),
          },
        },
      }),
    ]);
    const state = bootstrap({ cartridge: CARTRIDGE, seed: SEED, registry });

    expect(
      step(state, { type: "counter.bump" }, doppelganger).slices["counter"],
    ).toBe(100);
  });

  it("must exist in the state being stepped", () => {
    // Bootstrapped without `counter`, stepped with a registry that has it: the
    // state and the registry describe different engines.
    const state = bootstrap({
      cartridge: CARTRIDGE,
      seed: SEED,
      registry: createRegistry([observer]),
    });

    expect(() => step(state, { type: "counter.bump" }, registry)).toThrow(
      /has no slice for module "counter"/,
    );
  });
});

describe("transcript text a handler produces", () => {
  const noisy = (summary: string, detail: readonly string[]): EventModule =>
    defineEventModule({
      namespace: "noisy",
      description: "writes text the artifact could not hold",
      events: {
        "noisy.say": { version: 0, apply: () => ({ summary, detail }) },
      },
    });

  const say = (module: EventModule) =>
    reduce({
      cartridge: CARTRIDGE,
      seed: SEED,
      registry: createRegistry([module]),
      events: [{ type: "noisy.say" }],
    });

  it("is refused when it would break one entry into several lines", () => {
    expect(() => say(noisy("a\nb", []))).toThrow(
      /transcript summary contains a control character/,
    );
    expect(() => say(noisy("", ["fine", "not\rfine"]))).toThrow(
      /transcript detail line 1 contains a control character/,
    );
  });

  it("is read once, so a getter cannot show the check and the store two values", () => {
    // `EventOutcome` is a caller-owned object like the event envelope, and it
    // was a boundary the read-once discipline had not been applied to.
    // (`BootstrapInput` and `ReduceInput` were two more, closed in the same
    // change — see "reads each of its inputs exactly once" above.) Each case
    // below is a field that was read twice.
    const returning = (outcome: unknown): EventModule =>
      defineEventModule({
        namespace: "shifty",
        description: "returns an outcome whose fields change between reads",
        initialSlice: () => ({ n: 0 }),
        events: {
          "shifty.go": { version: 0, apply: () => outcome as never },
        },
      });
    const fold = (outcome: unknown) =>
      reduce({
        cartridge: CARTRIDGE,
        seed: SEED,
        registry: createRegistry([returning(outcome)]),
        events: [{ type: "shifty.go" }],
      });

    // `slice`: the guard saw an object and the store saw `undefined`, leaving an
    // own key holding `undefined`. `readSlice`'s `Object.hasOwn` then answered
    // true, so the module was handed `undefined` from then on — behaving as if
    // every event were its first, which is the failure `nextSlices` exists to
    // prevent. It is the only member of this family that corrupts state in
    // memory: `snapshot()` succeeds, because JSON drops undefined-valued
    // properties, and the restore blames registry drift instead.
    let sliceReads = 0;
    const shiftySlice = {
      get slice(): unknown {
        sliceReads += 1;
        return sliceReads > 1 ? undefined : { n: 1 };
      },
    };
    expect(fold(shiftySlice).slices["shifty"]).toEqual({ n: 1 });

    // `detail`: a getter drawing from `context.random` is the sharpest version.
    // The fold still replays identically, so this is not a determinism break —
    // it is an invariant-4 coherence break plus a PRNG stream stuck in place.
    let detailReads = 0;
    const shiftyDetail = {
      get detail(): readonly string[] {
        detailReads += 1;
        return detailReads > 1 ? ["swapped"] : ["original"];
      },
    };
    expect(fold(shiftyDetail).transcript[0]?.detail).toEqual(["original"]);

    // `summary`: same shape, and the field the detail-line comment's own
    // coercion argument had never been applied to.
    let summaryReads = 0;
    const shiftySummary = {
      get summary(): string {
        summaryReads += 1;
        return summaryReads > 1 ? "swapped" : "original";
      },
    };
    expect(fold(shiftySummary).transcript[0]?.summary).toBe("original");
  });

  it("is bounded in both dimensions a transcript entry has", () => {
    // The `MAX_PROBE_*` constants each bound one *input* — and there are more
    // inputs than constants: a `weightedPick` arm's label amplified by
    // `padEnd`, and a stream path's depth, both reach the transcript unbounded.
    // Bounding the output covers all of them, and covers #5–#13 without each
    // module inventing its own ceiling.
    //
    // The residual, stated because the bound does not close it: this bounds the
    // artifact, not the work. A fifty-thousand-segment stream path costs most
    // of a second while producing one line, and no output ceiling sees that.
    const emitting = (outcome: unknown): EventModule =>
      defineEventModule({
        namespace: "loud",
        description: "writes more transcript than an artifact can hold",
        events: { "loud.say": { version: 0, apply: () => outcome as never } },
      });
    const say = (outcome: unknown) =>
      reduce({
        cartridge: CARTRIDGE,
        seed: SEED,
        registry: createRegistry([emitting(outcome)]),
        events: [{ type: "loud.say" }],
      });

    expect(() =>
      say({
        detail: new Array<string>(MAX_TRANSCRIPT_DETAIL_LINES + 1).fill("x"),
      }),
    ).toThrow(/would write 4097 transcript lines/);
    expect(() =>
      say({ detail: ["ok", "y".repeat(MAX_TRANSCRIPT_LINE_LENGTH + 1)] }),
    ).toThrow(/detail line 1 is 4097 characters/);
    expect(() =>
      say({ summary: "z".repeat(MAX_TRANSCRIPT_LINE_LENGTH + 1) }),
    ).toThrow(/transcript summary is 4097 characters/);

    // Comfortably inside, which is where every committed fixture sits: the
    // largest entry is 126 detail lines of at most 84 characters. (The 99-char
    // lines in `002-random-clock/transcript.txt` are *rendered* lines, which
    // carry the index/timestamp/type header this bound does not cover.)
    expect(() =>
      say({
        detail: new Array<string>(MAX_TRANSCRIPT_DETAIL_LINES).fill("x"),
        summary: "z".repeat(MAX_TRANSCRIPT_LINE_LENGTH),
      }),
    ).not.toThrow();
  });

  it("is refused when it is not an object, or its summary is not a string", () => {
    // A non-object outcome dereferenced into a bare TypeError naming no event.
    // A *string* was worse: `"".slice` is a function, so `String.prototype.slice`
    // was stored as the module's state and only the canonical serializer
    // noticed, much later.
    const returning = (outcome: unknown): EventModule =>
      defineEventModule({
        namespace: "shifty",
        description: "returns something that is not an outcome",
        events: { "shifty.go": { version: 0, apply: () => outcome as never } },
      });
    const fold = (outcome: unknown) =>
      reduce({
        cartridge: CARTRIDGE,
        seed: SEED,
        registry: createRegistry([returning(outcome)]),
        events: [{ type: "shifty.go" }],
      });

    for (const bad of [undefined, null, "text", 42, ["a"]]) {
      expect(() => fold(bad)).toThrow(/must return an outcome object/);
    }
    // `describeUnwritableText` takes a string but tests with a regex, which
    // coerces — so a number summary passed the text check and landed in a
    // `TranscriptEntry` typed `string`.
    expect(() => fold({ summary: 42 })).toThrow(
      /transcript summary must be a string, got number/,
    );
    expect(() => fold({ detail: "lines" })).toThrow(
      /transcript detail must be an array, got string/,
    );
  });

  it("is refused when a detail line is not a string at all", () => {
    // Two routes to the same unrecordable state, and each closes half. A hole
    // — `new Array(1)`, validly typed and uncast — is skipped by `forEach`,
    // materialized by the spread, and then refused by the canonical serializer
    // at snapshot time: `reduce` succeeds and hands back state that cannot be
    // recorded. And an explicit `undefined` passes a text check that takes a
    // `string` but tests with a regex, which coerces it to "undefined".
    const emitting = (detail: readonly string[]): EventModule =>
      defineEventModule({
        namespace: "noisy",
        description: "emits a detail array that is not all strings",
        events: { "noisy.say": { version: 0, apply: () => ({ detail }) } },
      });
    const say = (module: EventModule) =>
      reduce({
        cartridge: CARTRIDGE,
        seed: SEED,
        registry: createRegistry([module]),
        events: [{ type: "noisy.say" }],
      });

    expect(() => say(emitting(new Array<string>(1)))).toThrow(
      /detail line 0 is a hole in a sparse array/,
    );
    expect(() =>
      say(emitting(["fine", undefined as unknown as string])),
    ).toThrow(/detail line 1 is undefined/);

    // And the state that does come back is snapshottable, which is the
    // property both halves exist to keep.
    expect(() => snapshot(say(emitting(["fine"])))).not.toThrow();
  });

  it("is refused when no recording of it could ever match", () => {
    expect(() => say(noisy("\ud800", []))).toThrow(/unpaired surrogate/);
  });

  it("is copied, so a handler cannot edit the transcript afterwards", () => {
    const lines = ["first"];
    const module = defineEventModule({
      namespace: "noisy",
      description: "keeps a reference to the array it handed over",
      events: {
        "noisy.say": { version: 0, apply: () => ({ detail: lines }) },
      },
    });
    const state = reduce({
      cartridge: CARTRIDGE,
      seed: SEED,
      registry: createRegistry([module]),
      events: [{ type: "noisy.say" }],
    });

    lines.push("smuggled");

    expect(state.transcript[0]?.detail).toEqual(["first"]);
  });
});

describe("the default registry", () => {
  it("is what reduce uses when none is given", () => {
    expect(serialize(fold())).toBe(
      serialize(
        reduce({
          cartridge: CARTRIDGE,
          seed: SEED,
          events: EVENTS,
          registry: ENGINE_EVENT_REGISTRY,
        }),
      ),
    );
  });
});
