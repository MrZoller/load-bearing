import { describe, expect, it } from "vitest";

import { loadCartridge } from "../cartridge/load.js";
import type { LoadedCartridge } from "../cartridge/types.js";
import { parseTimestamp } from "../clock/civil.js";
import { deserialize, serialize } from "../serialize/canonical.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
import { CLOCK_MODULE, MAX_TICK_MS } from "./core.js";
import { ENGINE_EVENT_MODULES, ENGINE_EVENT_REGISTRY } from "./modules.js";
import { PROBE_MODULE } from "./probe.js";
import { reduce, restoreSnapshot, snapshot, step } from "./reduce.js";
import type { EngineEvent, SessionState } from "./state.js";
import { MAX_TRANSCRIPT_DETAIL_LINES, renderTranscript } from "./transcript.js";

const SEED = "2026-08-05/0/deep-foundation";
const STARTED_AT = "2026-08-05T09:14:22.000Z";
const CARTRIDGE: LoadedCartridge = loadCartridge(
  loadCartridgeFixture("minimal"),
);

function fold(events: readonly EngineEvent[]): SessionState {
  return reduce({ cartridge: CARTRIDGE, seed: SEED, events });
}

/** `[{…}, <hole>, {…}]` — built here because a literal cannot express one. */
function sparseEntries(): unknown[] {
  const entries: unknown[] = [{ value: "a", weight: 1 }];
  entries.length = 2;
  entries.push({ value: "b", weight: 1 });
  return entries;
}

function lines(events: readonly EngineEvent[]): string[] {
  return renderTranscript(fold(events).transcript);
}

describe("the engine's module list", () => {
  it("registers every module it declares, with no collisions", () => {
    expect(ENGINE_EVENT_REGISTRY.namespaces).toEqual(
      [...ENGINE_EVENT_MODULES].map((module) => module.namespace).sort(),
    );
    expect(ENGINE_EVENT_REGISTRY.types).toEqual([
      "clock.tick",
      "probe.int",
      "probe.random",
      "probe.weighted",
    ]);
  });

  it("is frozen, so nothing can register an event type at runtime", () => {
    expect(Object.isFrozen(ENGINE_EVENT_MODULES)).toBe(true);
  });

  it("declares a slice validator exactly where there is a slice to validate", () => {
    // The clock holds no slice — its position lives in `SessionState.clock`,
    // which `restoreClock` already validates — so it declares no validator,
    // and `createRegistry` would refuse one.
    expect(CLOCK_MODULE.stateful).toBe(false);
    expect(CLOCK_MODULE.validateSlice).toBeUndefined();
    expect(PROBE_MODULE.stateful).toBe(true);
    expect(PROBE_MODULE.validateSlice).toBeTypeOf("function");
  });
});

describe("clock.tick", () => {
  it("advances simulated time and records how far", () => {
    const state = fold([
      { type: "clock.tick", payload: { ms: 1500 } },
      { type: "clock.tick", payload: { ms: 500 } },
    ]);

    expect(state.clock).toEqual({
      startMs: parseTimestamp(STARTED_AT),
      elapsedMs: 2000,
    });
    expect(lines([{ type: "clock.tick", payload: { ms: 1500 } }])).toEqual([
      `0000  ${STARTED_AT}  clock.tick ms=1500`,
    ]);
  });

  it("accepts a zero tick, since plenty of events take no time", () => {
    expect(
      fold([{ type: "clock.tick", payload: { ms: 0 } }]).clock.elapsedMs,
    ).toBe(0);
  });

  it("refuses a tick it cannot trust", () => {
    const cases: readonly (readonly [EngineEvent, RegExp])[] = [
      [{ type: "clock.tick" }, /requires a payload/],
      [{ type: "clock.tick", payload: {} }, /ms must be an integer/],
      [{ type: "clock.tick", payload: { ms: -1 } }, /ms must be an integer/],
      [{ type: "clock.tick", payload: { ms: 1.5 } }, /ms must be an integer/],
      [
        { type: "clock.tick", payload: { ms: MAX_TICK_MS + 1 } },
        /ms must be an integer in \[0, 86400000\]/,
      ],
    ];

    for (const [event, expected] of cases) {
      expect(() => fold([event])).toThrow(expected);
    }
  });
});

describe("the probe events", () => {
  it("names the resolved stream path, so a fixture says which stream moved", () => {
    // Paths are relative to the module's own stream: every module draws under
    // `root/<namespace>`, which is what keeps one subsystem's draws out of
    // another's sequence.
    const rendered = lines([
      {
        type: "probe.random",
        payload: { stream: "spinner/verbs", count: 1, form: "uint32" },
      },
      {
        type: "probe.random",
        payload: { stream: "", count: 1, form: "float" },
      },
    ]);

    expect(rendered[0]).toContain("stream=root/probe/spinner/verbs");
    expect(rendered[3]).toContain("stream=root/probe ");
  });

  it("tallies a weighted distribution, zero-weight entries included", () => {
    const rendered = lines([
      {
        type: "probe.weighted",
        payload: {
          stream: "rare-events",
          count: 100,
          entries: [
            { value: "off", weight: 0 },
            { value: "on", weight: 1 },
          ],
        },
      },
    ]);

    expect(rendered[1]).toMatch(/off\s+weight=\s+0\s+picks=\s+0/);
    expect(rendered[2]).toMatch(/on\s+weight=\s+1\s+picks=\s+100/);
  });

  it("records a snapshot whose picks sum to the count", () => {
    // The property the duplicate-value rejection exists to keep true: rows are
    // labelled by value, so a snapshot whose column does not sum to `count` is
    // reporting one arm's draws against two labels.
    const count = 4000;
    const rendered = lines([
      {
        type: "probe.weighted",
        payload: {
          stream: "rare-events",
          count,
          entries: [
            { value: "off", weight: 0 },
            { value: "rare", weight: 1 },
            { value: "common", weight: 9 },
          ],
        },
      },
    ]);

    const picks = rendered
      .slice(1, 4)
      .map((line) => Number(/picks=\s*(\d+)/.exec(line)?.[1]));

    expect(picks[0]).toBe(0);
    expect(picks.reduce((sum, hits) => sum + hits, 0)).toBe(count);
  });

  it("accumulates its slice across events, which is how a subsystem holds state", () => {
    expect(
      fold([
        {
          type: "probe.random",
          payload: { stream: "a", count: 3, form: "float" },
        },
        { type: "probe.int", payload: { stream: "a", count: 2, max: 4 } },
      ]).slices,
    ).toEqual({ probe: { events: 2, values: 5 } });
  });

  it("accepts every count its own validator admits, in every form", () => {
    // Two ceilings in one engine contradicted each other: `MAX_PROBE_COUNT` was
    // 20000, and a float probe at that count rendered 5001 detail lines — over
    // the transcript bound — so a shipped event type declared a payload legal
    // that the fold then refused. `MAX_PROBE_COUNT` is now derived from
    // `MAX_TRANSCRIPT_DETAIL_LINES`, so the two cannot drift apart.
    //
    // Checked against every form, not just the one that set the bound.
    const largest = (MAX_TRANSCRIPT_DETAIL_LINES - 1) * 4;
    for (const form of ["float", "uint32"] as const) {
      const rendered = lines([
        {
          type: "probe.random",
          payload: { stream: "a", count: largest, form },
        },
      ]);
      expect(rendered.length - 1).toBeLessThanOrEqual(
        MAX_TRANSCRIPT_DETAIL_LINES,
      );
    }
    // `probe.int` renders one row per bucket, bounded separately, and
    // `probe.weighted` one row per arm, bounded by the transcript itself.
    expect(() =>
      lines([
        {
          type: "probe.int",
          payload: { stream: "a", count: largest, max: 1024 },
        },
      ]),
    ).not.toThrow();
    // One past the derived ceiling is refused by the payload validator, not by
    // the transcript — which is the point: the complaint names the count.
    expect(() =>
      lines([
        {
          type: "probe.random",
          payload: { stream: "a", count: largest + 1, form: "float" },
        },
      ]),
    ).toThrow(/count must be an integer/);
  });

  it("checks its own slice on the way back from a snapshot", () => {
    // The worked example of `validateSlice`. Only this module knows the shape,
    // so only this module can refuse it — the reducer can confirm the slice
    // *set* matches the registry and nothing more.
    const validate = PROBE_MODULE.validateSlice;
    if (validate === undefined) {
      expect.unreachable("the probe module declares a slice validator");
    }
    const where = "snapshot: slices.probe";

    expect(validate({ events: 2, values: 9 }, where)).toEqual({
      events: 2,
      values: 9,
    });

    const rejections: readonly (readonly [unknown, RegExp])[] = [
      [null, /must be an object/],
      [[], /must be an object/],
      [
        { events: "oops", values: 0 },
        /events must be an integer between 0 and/,
      ],
      [{ events: 0, values: -1 }, /values must be an integer between 0 and/],
      [{ events: 1.5, values: 0 }, /events must be an integer between 0 and/],
      [{ events: 0 }, /values must be an integer between 0 and/],
      [{ events: 0, values: 0, extra: 1 }, /unexpected field\(s\) extra/],
      // Past 2^53 the counter stops counting: `events + 1` returns `events`
      // unchanged and `values + 3` lands 2 away, and the corruption survives
      // re-serialization looking like an ordinary integer.
      [
        { events: Number.MAX_SAFE_INTEGER + 1, values: 0 },
        /events must be an integer between 0 and/,
      ],
      [
        { events: 0, values: Number.MAX_SAFE_INTEGER + 1 },
        /values must be an integer between 0 and/,
      ],
    ];

    for (const [slice, expected] of rejections) {
      expect(() => validate(slice, where)).toThrow(expected);
    }
  });

  it("refuses to fold a counter past the point addition stays exact", () => {
    // The two bounds are one invariant: the fold path never *creates* a counter
    // above MAX_SAFE_INTEGER, and restore accepts exactly what the fold path
    // can create. The guard has to be here and not only at restore — any
    // ceiling restore accepts, the next fold turns into a larger value that
    // restore would then refuse, so no restore-side bound can deliver the
    // round trip.
    const validate = PROBE_MODULE.validateSlice;
    if (validate === undefined) {
      expect.unreachable("the probe module declares a slice validator");
    }

    // Exactly at the ceiling restores — it is a value the fold path can reach.
    const atCeiling = { events: 1, values: Number.MAX_SAFE_INTEGER };
    expect(validate(atCeiling, "snapshot: slices.probe")).toEqual(atCeiling);

    // And one fold from there is refused rather than silently losing precision.
    //
    // Built on a snapshot with one event already folded, not a zero-event one.
    // `restoreSnapshot` now checks that a zero-event state is exactly what
    // bootstrapping produces, and it correctly refuses this fixture: a session
    // that has folded nothing cannot have a probe slice at the ceiling. The
    // check caught this test's own synthetic state, which is the argument for
    // it working.
    const state = restoreSnapshot(
      serialize({
        ...(deserialize(
          snapshot(
            fold([
              {
                type: "probe.random",
                payload: { stream: "a", count: 1, form: "uint32" },
              },
            ]),
          ),
        ) as Record<string, unknown>),
        slices: { probe: atCeiling },
      }),
    );

    expect(() =>
      step(state, {
        type: "probe.random",
        payload: { stream: "a", count: 1, form: "uint32" },
      }),
    ).toThrow(/would take the slice past 9007199254740991/);
  });

  it("rejects a payload it cannot trust", () => {
    const cases: readonly (readonly [EngineEvent, RegExp])[] = [
      [
        { type: "probe.random", payload: { stream: "a", count: 1 } },
        /form must be a string/,
      ],
      [
        {
          type: "probe.random",
          payload: { stream: "a", count: 1, form: "double" },
        },
        /form must be "uint32" or "float"/,
      ],
      [
        { type: "probe.random", payload: { count: 1, form: "float" } },
        /stream must be a string/,
      ],
      [
        { type: "probe.int", payload: { stream: "a", count: 1, max: 0 } },
        /max must be an integer/,
      ],
      [
        { type: "probe.weighted", payload: { stream: "a", count: 1 } },
        /entries must be an array/,
      ],
      [
        {
          type: "probe.weighted",
          payload: { stream: "a", count: 1, entries: [null] },
        },
        /entry 0: must be an object/,
      ],
      // A hole, not a null. `map` skips it, so it passed validation untouched
      // and reached the handler as a bare TypeError on `entry.value`, naming no
      // event and no module — the lesson `weightedPick` and `captureOutcome`
      // both already carry, in the validator sitting between them.
      [
        {
          type: "probe.weighted",
          payload: { stream: "a", count: 1, entries: sparseEntries() },
        },
        /entry 1: is a hole in a sparse array/,
      ],
      [
        {
          type: "probe.weighted",
          payload: { stream: "a", count: 1, entries: [{ weight: 1 }] },
        },
        /value must be a string/,
      ],
      [
        {
          type: "probe.weighted",
          payload: {
            stream: "a",
            count: 1,
            entries: [
              { value: "same", weight: 0 },
              { value: "same", weight: 1 },
            ],
          },
        },
        /already appears in this snapshot/,
      ],
    ];

    for (const [event, expected] of cases) {
      expect(() => fold([event])).toThrow(expected);
    }
  });

  it("names the offending event, since a fixture has many", () => {
    expect(() =>
      fold([
        { type: "clock.tick", payload: { ms: 0 } },
        { type: "probe.int", payload: { stream: "a", count: 1 } },
      ]),
    ).toThrow(/event 1 \(probe\.int\)/);
  });
});
