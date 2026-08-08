import { describe, expect, it } from "vitest";

import { deepFreeze } from "./freeze.js";

describe("deepFreeze", () => {
  it("freezes everything reachable, not just the surface", () => {
    const value = deepFreeze({
      meta: { title: "t" },
      models: [{ quirks: ["one"] }],
    });

    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.meta)).toBe(true);
    expect(Object.isFrozen(value.models)).toBe(true);
    expect(Object.isFrozen(value.models[0])).toBe(true);
    expect(Object.isFrozen(value.models[0]?.quirks)).toBe(true);
    expect(() => {
      (value.meta as { title: string }).title = "MUTATED";
    }).toThrow(TypeError);
  });

  it("freezes a non-enumerable property too", () => {
    // An unfrozen interior hiding behind a frozen surface is worse than an
    // obviously mutable object, and `Object.keys` would not have seen this.
    const hidden = { n: 1 };
    const value: Record<string, unknown> = {};
    Object.defineProperty(value, "hidden", {
      value: hidden,
      enumerable: false,
    });

    deepFreeze(value);

    expect(Object.isFrozen(hidden)).toBe(true);
  });

  it("leaves functions alone", () => {
    // The cartridge schema holds `refine` and `fill` callbacks, and freezing a
    // shared function object would reach outside the value being frozen.
    const fn = () => 1;
    deepFreeze({ fn });

    expect(Object.isFrozen(fn)).toBe(false);
  });

  it("terminates on a value that contains itself", () => {
    // `structuredClone` preserves a cycle rather than refusing it, so a cyclic
    // value really can reach a freeze walk. Unguarded recursion met it with a
    // RangeError and a host-formatted stack.
    const cyclic: Record<string, unknown> = { n: 1 };
    cyclic["self"] = cyclic;
    cyclic["nested"] = { back: cyclic };

    expect(() => deepFreeze(cyclic)).not.toThrow();
    expect(Object.isFrozen(cyclic)).toBe(true);
    expect(Object.isFrozen(cyclic["nested"])).toBe(true);
  });

  it("visits a shared subobject once rather than once per path", () => {
    // A wide DAG is not a cycle, but re-walking it at every reference is how
    // an O(n) freeze becomes exponential.
    const shared = { leaf: true };
    let level: Record<string, unknown> = { a: shared, b: shared };
    for (let depth = 0; depth < 40; depth += 1) {
      level = { a: level, b: level };
    }

    deepFreeze(level);

    expect(Object.isFrozen(shared)).toBe(true);
  });

  it("returns the value it was given, so it reads as an annotation", () => {
    const value = { n: 1 };
    expect(deepFreeze(value)).toBe(value);
    expect(deepFreeze("scalar")).toBe("scalar");
    expect(deepFreeze(null)).toBeNull();
  });
});
