import { describe, expect, it } from "vitest";

import { loadCartridge } from "../cartridge/load.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
import { defineEventModule } from "./module.js";
import { bootstrap, step } from "./reduce.js";
import { createRegistry } from "./registry.js";

function cartridge() {
  return loadCartridge(loadCartridgeFixture("minimal"));
}

function module(namespace: "alpha" | "beta", fail = false) {
  return defineEventModule<{ readonly value: number }>({
    namespace,
    description: namespace,
    initialSlice: () => ({ value: 0 }),
    validateSlice: (slice) => slice as { readonly value: number },
    events: {
      [`${namespace}.raise`]: {
        version: 0,
        apply(_context, slice) {
          if (fail) throw new Error("controlled effect failure");
          return { slice: { value: slice.value + 1 } };
        },
      },
      [`${namespace}.outer`]: {
        version: 0,
        apply(_context, slice) {
          return {
            slice: { value: slice.value + 1 },
            summary: "transaction",
            effects: [{ type: "beta.raise", payload: {} }],
          };
        },
      },
    },
  });
}

describe("transactional effects", () => {
  it("lets each module own its slice and records only the outer event", () => {
    const registry = createRegistry([module("alpha"), module("beta")]);
    const before = bootstrap({
      cartridge: cartridge(),
      seed: "effects",
      registry,
    });
    const after = step(before, { type: "alpha.outer", payload: {} }, registry);

    expect(after.slices).toMatchObject({
      alpha: { value: 1 },
      beta: { value: 1 },
    });
    expect(after.eventCount).toBe(1);
    expect(after.transcript.map((entry) => entry.type)).toEqual([
      "alpha.outer",
    ]);
  });

  it("publishes no partial state when an effect fails", () => {
    const registry = createRegistry([module("alpha"), module("beta", true)]);
    const before = bootstrap({
      cartridge: cartridge(),
      seed: "effects",
      registry,
    });

    expect(() =>
      step(before, { type: "alpha.outer", payload: {} }, registry),
    ).toThrow(/controlled effect failure/);
    expect(before.slices).toMatchObject({
      alpha: { value: 0 },
      beta: { value: 0 },
    });
    expect(before.eventCount).toBe(0);
  });
});
