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

  it("freezes a symbol-keyed property too", () => {
    // Same argument as the non-enumerable case: no caller in the repository
    // can reach one, because `serialize` and the cartridge loader both refuse
    // an own symbol key — but this is exported promising *everything*
    // reachable, and a caller holding the symbol would hold a mutable
    // interior behind a frozen surface.
    const key = Symbol("hidden");
    const inner = { weight: 1 };
    const value: Record<string | symbol, unknown> = { visible: { n: 1 } };
    value[key] = inner;

    deepFreeze(value);

    expect(Object.isFrozen(inner)).toBe(true);
    expect(() => {
      inner.weight = 99;
    }).toThrow(TypeError);
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

  it("refuses a branded built-in rather than pretending to freeze it", () => {
    // `Object.freeze` is defined over properties, and these keep their contents
    // in internal slots — so freezing one reports success and protects nothing.
    // A prototype test rather than a brand list, because Map and Set are two
    // members of an open set: `Date` stays mutable through `setTime`, `RegExp`
    // through `lastIndex`, and a typed array does not survive `Object.freeze`
    // at all.
    const branded: readonly (readonly [string, unknown])[] = [
      ["Map", new Map([["a", 1]])],
      ["Set", new Set([1])],
      ["Date", new Date(0)],
      ["RegExp", /x/],
      ["typed array", new Uint8Array([1, 2, 3])],
      ["class instance", new (class Holder {})()],
    ];

    for (const [what, value] of branded) {
      expect(() => deepFreeze(value), what).toThrow(
        /only plain objects, arrays and null-prototype objects/,
      );
      expect(() => deepFreeze({ nested: value }), what).toThrow(
        /internal slots/,
      );
    }
  });

  it("accepts the three shapes plain JSON is made of", () => {
    const nullProto = Object.create(null) as Record<string, unknown>;
    nullProto["n"] = 1;

    expect(() =>
      deepFreeze({ a: [1, { b: "c" }], c: nullProto }),
    ).not.toThrow();
    expect(Object.isFrozen(nullProto)).toBe(true);
  });

  it("returns the value it was given, so it reads as an annotation", () => {
    const value = { n: 1 };
    expect(deepFreeze(value)).toBe(value);
    expect(deepFreeze("scalar")).toBe("scalar");
    expect(deepFreeze(null)).toBeNull();
  });
});
