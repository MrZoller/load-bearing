import { describe, expect, it } from "vitest";

import { loadCartridge } from "../cartridge/load.js";
import type { LoadedCartridge } from "../cartridge/types.js";
import { createClock } from "../clock/clock.js";
import { createRandom } from "../random/stream.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
import { ENGINE_VERSION } from "../version.js";
import { EVENT_SCHEMA_VERSION, readSlice } from "./state.js";
import type { SessionState } from "./state.js";

const SEED = "2026-08-05/0/deep-foundation";

const CARTRIDGE: LoadedCartridge = loadCartridge(
  loadCartridgeFixture("minimal"),
);

/**
 * A zero-event session state, built the way `bootstrap` builds one.
 *
 * Hand-assembled rather than reduced, because `readSlice` is the whole of this
 * module's behaviour and the fold is not needed to reach it — but coherent
 * anyway: the clock starts where the cartridge says and the PRNG root is the
 * one this seed derives, so no test here rests on a state the engine could
 * never have produced.
 */
function state(overrides: Partial<SessionState> = {}): SessionState {
  return {
    engineVersion: ENGINE_VERSION,
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    seed: SEED,
    cartridge: CARTRIDGE,
    eventCount: 0,
    clock: createClock(CARTRIDGE.meta.startedAt).toState(),
    random: createRandom(SEED).toState(),
    slices: {},
    transcript: [],
    ...overrides,
  };
}

describe("readSlice", () => {
  it("hands back the slice stored under the module's namespace", () => {
    expect(readSlice(state({ slices: { alpha: { n: 7 } } }), "alpha")).toEqual({
      n: 7,
    });
  });

  it("refuses a state bootstrapped without the module rather than answering undefined", () => {
    // The state and the registry describe different engines, so folding on
    // would produce a session neither of them does. `step` reaches this through
    // a registry the state was not bootstrapped under; here it is the contract
    // itself.
    expect(() => readSlice(state({ slices: { alpha: 0 } }), "beta")).toThrow(
      /has no slice for module "beta"/,
    );
  });

  it("looks the slice up by own key, so a prototype member is not a slice", () => {
    // `Object.hasOwn`, not `in`: every namespace inherits `constructor` and
    // `toString` from `Object.prototype`, and `in` would hand a module the
    // `Object` constructor as its state — a value that then fails much later,
    // in the canonical serializer, naming the module that never asked for it.
    expect(() => readSlice(state(), "constructor")).toThrow(
      /has no slice for module "constructor"/,
    );
    expect(() => readSlice(state(), "toString")).toThrow(
      /has no slice for module "toString"/,
    );
  });
});

describe("a caller-owned session state", () => {
  // `readSlice` is exported from the engine's own index, so `state` is the
  // caller's object and `slices` can be a getter. It was read to check the key
  // and again to read the value: a record answering `{ alpha: 7 }` and then
  // `{}` passes `Object.hasOwn` and hands back `undefined`, which is the own
  // key holding `undefined` that `captureOutcome` spends a paragraph on — the
  // module is given `undefined` from then on and behaves as if every event were
  // its first, while `snapshot()` still succeeds.
  it("returns the value from the record it checked, not a later read", () => {
    let reads = 0;
    const shifty: SessionState = {
      ...state(),
      get slices(): Readonly<Record<string, unknown>> {
        reads += 1;
        return reads > 1 ? {} : { alpha: 7 };
      },
    };

    expect(readSlice(shifty, "alpha")).toBe(7);
    expect(reads).toBe(1);
  });

  it("refuses a record that held no slice, whatever a later read holds", () => {
    // The other direction, and the other use of the same capture: the check
    // must be of the record the value would come from. Re-read, the guard
    // passes on a record the return never sees and `undefined` is handed back
    // as though it were state.
    let reads = 0;
    const shifty: SessionState = {
      ...state(),
      get slices(): Readonly<Record<string, unknown>> {
        reads += 1;
        return reads > 1 ? { alpha: 7 } : {};
      },
    };

    expect(() => readSlice(shifty, "alpha")).toThrow(
      /has no slice for module "alpha"/,
    );
    expect(reads).toBe(1);
  });
});
