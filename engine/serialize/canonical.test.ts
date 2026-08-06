import { describe, expect, it } from "vitest";

import {
  CanonicalSerializeError,
  deserialize,
  serialize,
  serializeInline,
} from "./canonical.js";

describe("serialize", () => {
  it("orders object keys independently of insertion order", () => {
    const forwards = serialize({ alpha: 1, beta: 2, gamma: 3 });
    const backwards = serialize({ gamma: 3, beta: 2, alpha: 1 });

    expect(forwards).toBe(backwards);
    expect(forwards).toBe('{\n  "alpha": 1,\n  "beta": 2,\n  "gamma": 3\n}\n');
  });

  it("orders keys by UTF-16 code unit, so uppercase sorts before lowercase", () => {
    expect(serialize({ b: 1, A: 2, a: 3, B: 4 })).toBe(
      '{\n  "A": 2,\n  "B": 4,\n  "a": 3,\n  "b": 1\n}\n',
    );
  });

  it("sorts nested objects too", () => {
    expect(serialize({ outer: { z: 1, a: 2 } })).toBe(
      '{\n  "outer": {\n    "a": 2,\n    "z": 1\n  }\n}\n',
    );
  });

  it("preserves array order", () => {
    expect(serialize([3, 1, 2])).toBe("[\n  3,\n  1,\n  2\n]\n");
  });

  it("ends with exactly one trailing newline", () => {
    expect(serialize({})).toBe("{}\n");
    expect(serialize([])).toBe("[]\n");
    expect(serialize(null)).toBe("null\n");
    expect(serialize("x")).toBe('"x"\n');
  });

  it("emits no carriage returns, even for strings that contain them", () => {
    const text = serialize({ line: "a\r\nb" });

    expect(text).toBe('{\n  "line": "a\\r\\nb"\n}\n');
    expect(text.split("\n").every((line) => !line.includes("\r"))).toBe(true);
  });

  it("drops undefined object properties", () => {
    expect(serialize({ present: 1, absent: undefined })).toBe(
      '{\n  "present": 1\n}\n',
    );
  });

  it("drops undefined properties down to an empty object", () => {
    expect(serialize({ absent: undefined })).toBe("{}\n");
  });

  it("normalizes negative zero", () => {
    expect(serialize({ n: -0 })).toBe(serialize({ n: 0 }));
  });

  it("keeps number formatting exact", () => {
    expect(serialize([1, 1.5, 1e21, 1e-7, -3, 0.1])).toBe(
      "[\n  1,\n  1.5,\n  1e+21,\n  1e-7,\n  -3,\n  0.1\n]\n",
    );
  });

  it("escapes keys containing quotes and backslashes", () => {
    expect(serialize({ 'a"b\\c': 1 })).toBe('{\n  "a\\"b\\\\c": 1\n}\n');
  });
});

describe("serialize rejections", () => {
  it("refuses NaN and Infinity rather than writing null", () => {
    // JSON.stringify turns both into null, which looks like data and is not.
    expect(() => serialize({ ratio: Number.NaN })).toThrow(
      CanonicalSerializeError,
    );
    expect(() => serialize({ ratio: Number.POSITIVE_INFINITY })).toThrow(
      /not finite/,
    );
  });

  it("refuses Date, whose toJSON would make wall-clock time look serializable", () => {
    expect(() => serialize({ at: new Date(0) })).toThrow(/not a plain object/);
  });

  it("refuses Map and Set", () => {
    expect(() => serialize({ m: new Map() })).toThrow(
      /Map is not a plain object/,
    );
    expect(() => serialize({ s: new Set() })).toThrow(
      /Set is not a plain object/,
    );
  });

  it("refuses class instances", () => {
    class Commit {}

    expect(() => serialize(new Commit())).toThrow(
      /Commit is not a plain object/,
    );
  });

  it("refuses functions, symbols, bigints, and bare undefined", () => {
    expect(() => serialize({ f: () => 1 })).toThrow(/function/);
    expect(() => serialize({ s: Symbol("s") })).toThrow(/symbol/);
    expect(() => serialize({ b: 1n })).toThrow(/bigint/);
    expect(() => serialize(undefined)).toThrow(/undefined/);
  });

  it("refuses undefined inside an array, where dropping it would shift indices", () => {
    expect(() => serialize([1, undefined, 3])).toThrow(
      /undefined array element/,
    );
  });

  it("refuses a hole in a sparse array, which map() would skip entirely", () => {
    // Array.prototype.map never visits a hole, so it would slip past the
    // undefined check and emit nothing between two commas — not JSON at all.
    // eslint-disable-next-line no-sparse-arrays
    expect(() => serialize([1, , 3])).toThrow(/hole in a sparse array/);
    expect(() => serialize(new Array(3))).toThrow(/hole in a sparse array/);
    // eslint-disable-next-line no-sparse-arrays
    expect(() => serializeInline([1, , 3])).toThrow(/hole in a sparse array/);
  });

  it("refuses symbol-keyed properties instead of dropping them", () => {
    // Object.keys omits them. Dropping silently lets two different states
    // serialize to identical bytes — the divergence no fixture could catch.
    expect(() => serialize({ [Symbol("id")]: 1 })).toThrow(/symbol-keyed/);
    expect(() => serialize({ a: 1, [Symbol("id")]: 2 })).toThrow(
      /symbol-keyed/,
    );
  });

  it("refuses an accessor at an array index, and never invokes it", () => {
    let reads = 0;
    const array: unknown[] = [];
    Object.defineProperty(array, 0, {
      enumerable: true,
      get() {
        reads += 1;
        return reads;
      },
    });

    expect(() => serialize(array)).toThrow(/accessor property/);
    expect(() => serializeInline(array)).toThrow(/accessor property/);
    expect(reads).toBe(0);
  });

  it("refuses a hole even when Array.prototype has been polluted", () => {
    // `index in array` walks the prototype chain, so a polluted numeric
    // property would make a hole look present and serialize ambient state.
    const polluted = Array.prototype as unknown as Record<number, unknown>;
    polluted[1] = "INHERITED";
    try {
      // eslint-disable-next-line no-sparse-arrays
      expect(() => serialize([0, , 2])).toThrow(/hole in a sparse array/);
    } finally {
      delete polluted[1];
    }
  });

  it("refuses extra own properties on an array, which would vanish", () => {
    // The array branch never reaches plainEntries, so without this both of
    // these serialize as a bare list and the extra state disappears.
    expect(() => serialize(Object.assign([1, 2], { foo: 1 }))).toThrow(
      /non-index property "foo"/,
    );
    expect(() => serialize(Object.assign([], { [Symbol("id")]: 1 }))).toThrow(
      /symbol-keyed/,
    );
  });

  it("refuses an Array subclass, which Array.isArray reports as an array", () => {
    class Beam extends Array {}

    expect(() => serialize(Beam.from([1, 2]))).toThrow(/array subclass/);
  });

  it("refuses a numeric key outside the array-index range", () => {
    // Array indices stop at 2**32 - 2. Assigning past that makes an ordinary
    // property that leaves `length` alone, so the element loop never visits
    // it and the value would disappear.
    const array: unknown[] = [];
    Object.assign(array, { "4294967295": "past the end" });

    expect(array).toHaveLength(0);
    expect(() => serialize(array)).toThrow(/non-index property/);
  });

  it("refuses non-enumerable properties, which Object.keys omits", () => {
    // Two states that differ only in a non-enumerable property would otherwise
    // produce one identical recording.
    const state = { seed: "abc" };
    Object.defineProperty(state, "id", { value: 1, enumerable: false });

    expect(() => serialize(state)).toThrow(/non-enumerable property "id"/);
  });

  it("refuses a non-enumerable accessor, which would bypass the accessor check", () => {
    // The accessor check only sees keys Object.keys returned, so one property
    // flag would otherwise let a getter run during serialization after all.
    let reads = 0;
    const state = { seed: "abc" };
    Object.defineProperty(state, "id", {
      enumerable: false,
      get() {
        reads += 1;
        return reads;
      },
    });

    expect(() => serialize(state)).toThrow(/non-enumerable property/);
    expect(reads).toBe(0);
  });

  it("allows an array's own non-enumerable length", () => {
    expect(serialize([1, 2])).toBe("[\n  1,\n  2\n]\n");
  });

  it("refuses accessor properties rather than invoking them", () => {
    let reads = 0;
    const counter = {
      get n() {
        reads += 1;
        return reads;
      },
    };

    expect(() => serialize(counter)).toThrow(/accessor property/);
    expect(reads).toBe(0);
  });

  it("points at the accessor property it refused", () => {
    let pointer = "";
    try {
      serialize({
        repository: {
          get cwd() {
            return "/production";
          },
        },
      });
    } catch (error) {
      pointer = (error as CanonicalSerializeError).pointer;
    }

    expect(pointer).toBe("/repository/cwd");
  });

  it("refuses circular references", () => {
    const node: Record<string, unknown> = { name: "a" };
    node.self = node;

    expect(() => serialize(node)).toThrow(/circular reference/);
  });

  it("allows the same object to appear twice without calling it circular", () => {
    const shared = { n: 1 };

    expect(serialize({ a: shared, b: shared })).toBe(
      '{\n  "a": {\n    "n": 1\n  },\n  "b": {\n    "n": 1\n  }\n}\n',
    );
  });

  it("points at the offending value", () => {
    let pointer = "";
    try {
      serialize({ repository: { files: [{ mtime: Number.NaN }] } });
    } catch (error) {
      pointer = (error as CanonicalSerializeError).pointer;
    }

    expect(pointer).toBe("/repository/files/0/mtime");
  });

  it("escapes slashes in pointer segments", () => {
    let pointer = "";
    try {
      serialize({ "src/index.ts": Number.NaN });
    } catch (error) {
      pointer = (error as CanonicalSerializeError).pointer;
    }

    expect(pointer).toBe("/src~1index.ts");
  });
});

describe("round-tripping", () => {
  const sample = {
    meta: { number: 1, title: "Fixture", tags: ["a", "b"] },
    repository: {
      files: { "src/index.ts": "export const load = 1;\n" },
      cwd: "/production",
    },
    flags: { enabled: true, disabled: false, missing: null },
    numbers: [0, -1, 1.25, 1e21],
  };

  it("survives serialize → deserialize → serialize unchanged", () => {
    const once = serialize(sample);

    expect(serialize(deserialize(once))).toBe(once);
  });

  it("produces a document JSON.parse accepts", () => {
    expect(deserialize(serialize(sample))).toEqual(sample);
  });
});

describe("serializeInline", () => {
  it("renders on one line with no trailing newline", () => {
    expect(serializeInline({ b: 1, a: [2, 3] })).toBe('{"a":[2,3],"b":1}');
  });

  it("sorts keys like the multi-line form", () => {
    expect(serializeInline({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');
  });

  it("applies the same rejections", () => {
    expect(() => serializeInline({ n: Number.NaN })).toThrow(
      CanonicalSerializeError,
    );
  });

  it("renders empty containers", () => {
    expect(serializeInline({ a: {}, b: [] })).toBe('{"a":{},"b":[]}');
  });
});
