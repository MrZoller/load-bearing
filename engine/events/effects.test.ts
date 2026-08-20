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

describe("event expansion", () => {
  function expansionModule(
    mode: "normal" | "empty" | "nested" | "clock" | "random",
  ) {
    return defineEventModule<never>({
      namespace: "expand",
      description: "synthetic expansion contract",
      events: {
        "expand.child": {
          version: 0,
          apply(context) {
            if (mode === "nested")
              return { expansion: [{ type: "expand.result" }] };
            if (mode === "clock") context.clock.advance(1);
            if (mode === "random") context.random.nextUint32();
            return { summary: "child" };
          },
        },
        "expand.outer": {
          version: 0,
          apply() {
            return {
              expansion:
                mode === "empty"
                  ? []
                  : [{ type: "expand.child" }, { type: "expand.result" }],
            };
          },
        },
        "expand.result": {
          version: 0,
          apply() {
            return { summary: "result" };
          },
        },
      },
    });
  }

  function expanded(mode: "normal" | "empty" | "nested" | "clock" | "random") {
    const registry = createRegistry([expansionModule(mode)]);
    const before = bootstrap({
      cartridge: cartridge(),
      seed: "expand",
      registry,
    });
    return () => step(before, { type: "expand.outer" }, registry);
  }

  it("logs children at ordinary consecutive indexes and not the envelope", () => {
    const state = expanded("normal")();
    expect(state.eventCount).toBe(2);
    expect(state.transcript.map((entry) => [entry.index, entry.type])).toEqual([
      [0, "expand.child"],
      [1, "expand.result"],
    ]);
  });

  it("rejects empty and nested expansions", () => {
    expect(expanded("empty")).toThrow(/at least one logged child/);
    expect(expanded("nested")).toThrow(/nested event expansion/);
  });

  it("rejects clock or random mutation by an expansion child that also expands", () => {
    const mutatingExpander = (kind: "clock" | "random") => {
      const module = defineEventModule<never>({
        namespace: "mutate",
        description: "mutates while expanding",
        events: {
          "mutate.child": { version: 0, apply: () => ({ summary: "child" }) },
          "mutate.outer": {
            version: 0,
            apply(context) {
              if (kind === "clock") context.clock.advance(1);
              else context.random.nextUint32();
              return { expansion: [{ type: "mutate.child" }] };
            },
          },
        },
      });
      const registry = createRegistry([module]);
      const before = bootstrap({
        cartridge: cartridge(),
        seed: "mutate",
        registry,
      });
      return () => step(before, { type: "mutate.outer" }, registry);
    };

    expect(mutatingExpander("clock")).toThrow(/may not move the clock or PRNG/);
    expect(mutatingExpander("random")).toThrow(
      /may not move the clock or PRNG/,
    );
  });

  it.each([
    ["a slice", { slice: {} }],
    ["a summary", { summary: "envelope" }],
    ["detail", { detail: ["envelope"] }],
    ["structured output and exit status", { output: [], exitCode: 0 }],
    ["effects", { effects: [{ type: "forbidden.child" }] }],
  ])("rejects an expansion combined with %s", (_case, forbidden) => {
    const registry = createRegistry([
      defineEventModule<never>({
        namespace: "forbidden",
        description: "expansions are envelopes, not outcomes",
        events: {
          "forbidden.child": { version: 0, apply: () => ({}) },
          "forbidden.outer": {
            version: 0,
            apply: () =>
              ({
                ...forbidden,
                expansion: [{ type: "forbidden.child" }],
              }) as never,
          },
        },
      }),
    ]);
    const before = bootstrap({
      cartridge: cartridge(),
      seed: "forbidden",
      registry,
    });

    expect(() => step(before, { type: "forbidden.outer" }, registry)).toThrow(
      /may return only expansion children/,
    );
  });
});
