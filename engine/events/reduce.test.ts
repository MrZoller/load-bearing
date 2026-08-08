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
