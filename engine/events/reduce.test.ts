import { describe, expect, it } from "vitest";

import { loadCartridge } from "../cartridge/load.js";
import type { LoadedCartridge } from "../cartridge/types.js";
import { parseTimestamp } from "../clock/civil.js";
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
import { createRegistry } from "./registry.js";
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
      /snapshot: slices\.probe: events must be a non-negative integer/,
    );
  });

  it("leaves a slice alone when its module declares no validator", () => {
    // The hook is optional on purpose, and a module without one must behave
    // exactly as it did before the hook existed.
    const lax = defineEventModule<unknown>({
      namespace: "lax",
      description: "declares no slice validator",
      initialSlice: () => ({ anything: true }),
      events: { "lax.noop": { version: 0, apply: () => ({}) } },
    });
    const registry = createRegistry([lax]);
    const text = snapshot(
      bootstrap({ cartridge: CARTRIDGE, seed: SEED, registry }),
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
