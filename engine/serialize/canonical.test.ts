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
