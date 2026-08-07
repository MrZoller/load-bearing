import { describe, expect, it } from "vitest";

import { serialize } from "../serialize/canonical.js";
import {
  listInvalidCartridgeFixtures,
  loadCartridgeFixture,
  loadInvalidCartridgeFixture,
} from "../testing/fixtures.js";
import { CartridgeValidationError, loadCartridge } from "./load.js";
import type { CartridgeIssue } from "./load.js";
import { CARTRIDGE_SCHEMA } from "./schema.js";
import type { SchemaNode } from "./schema.js";

/** Rewritten per test; the shared object is only ever read. */
function minimal(): Record<string, unknown> {
  return loadCartridgeFixture("minimal") as Record<string, unknown>;
}

function issuesOf(value: unknown): readonly CartridgeIssue[] {
  try {
    loadCartridge(value);
  } catch (error) {
    if (error instanceof CartridgeValidationError) return error.issues;
    throw error;
  }
  throw new Error("expected the cartridge to be rejected, but it loaded");
}

describe("loadCartridge", () => {
  it("loads the minimal fixture cartridge", () => {
    const cartridge = loadCartridge(minimal());

    expect(cartridge.meta.title).toBe("Fixture World");
    expect(cartridge.repository.cwd).toBe("/production/service");
    expect(cartridge.models).toHaveLength(2);
    expect(cartridge.models[0]?.archetype).toBe("paranoid");
  });

  it("fills declared defaults", () => {
    const cartridge = loadCartridge(minimal());

    // `/production/service/README.md` declares only its contents.
    expect(cartridge.repository.files["/production/service/README.md"]).toEqual(
      {
        contents: "# service\n",
        mode: "0644",
        owner: "root",
        group: "root",
        mtime: cartridge.meta.startedAt,
      },
    );
    // `quick-patch` declares no quirks.
    expect(cartridge.models[1]?.quirks).toEqual([]);
    // Absent world sections normalize to empty, not to missing.
    expect(cartridge.repository.gitHistory).toEqual([]);
    expect(cartridge.story).toEqual({});
    expect(cartridge.presentation).toEqual({});
  });

  it("keeps a declared value over the default it would have filled", () => {
    const cartridge = loadCartridge(minimal());
    const authored =
      cartridge.repository.files["/production/service/src/index.ts"];

    expect(authored?.owner).toBe("greg");
    expect(authored?.group).toBe("departed");
    expect(authored?.mtime).toBe("2026-07-31T02:11:09.000Z");
  });

  it("is pure: the same JSON loads byte-identically", () => {
    expect(serialize(loadCartridge(minimal()))).toBe(
      serialize(loadCartridge(minimal())),
    );
  });

  it("does not depend on the order keys were written in", () => {
    // The whole point of normalizing: two authors who wrote the same world in
    // a different order get the same recorded state.
    function reverseKeys(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(reverseKeys);
      if (typeof value !== "object" || value === null) return value;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).reverse()) {
        out[key] = reverseKeys((value as Record<string, unknown>)[key]);
      }
      return out;
    }

    expect(serialize(loadCartridge(reverseKeys(minimal())))).toBe(
      serialize(loadCartridge(minimal())),
    );
  });

  it("copies rather than aliases, so mutating the input cannot reach it", () => {
    const source = minimal();
    const loaded = loadCartridge(source);
    const before = serialize(loaded);

    const repository = source["repository"] as Record<string, unknown>;
    const files = repository["files"] as Record<
      string,
      Record<string, unknown>
    >;
    (files["/production/service/README.md"] as Record<string, unknown>)[
      "contents"
    ] = "tampered";

    expect(serialize(loaded)).toBe(before);
  });

  it("survives the canonical serializer, which recorded state depends on", () => {
    expect(() => serialize(loadCartridge(minimal()))).not.toThrow();
  });

  it("keeps a record key that names an accessor on Object.prototype", () => {
    // The same hazard as in a deferred subtree, reached through a validated
    // record instead: the variable used to vanish from the loaded world in
    // silence, so two different cartridges loaded byte-identically.
    const source = minimal();
    (source["repository"] as Record<string, unknown>)["env"] = JSON.parse(
      '{"__proto__": "poisoned", "PATH": "/bin"}',
    ) as unknown;

    const env = loadCartridge(source).repository.env;
    expect(Object.keys(env).sort()).toEqual(["PATH", "__proto__"]);
    expect(Object.getPrototypeOf(env)).toBe(Object.prototype);
  });

  it("keeps a record key spelled `constructor`", () => {
    const source = minimal();
    (source["repository"] as Record<string, unknown>)["env"] = {
      constructor: "still a string",
    };

    expect(loadCartridge(source).repository.env["constructor"]).toBe(
      "still a string",
    );
  });

  it("rejects a timestamp that is well-shaped but not a real instant", () => {
    // The shape check alone let these cross the validation boundary and blow
    // up later in `createClock` — on the wrong side of the line that decides
    // whether the fallback episode ships.
    for (const startedAt of [
      "1969-12-31T23:59:59Z",
      "2026-13-40T25:61:61Z",
      "2026-02-30T00:00:00Z",
    ]) {
      const source = minimal();
      (source["meta"] as Record<string, unknown>)["startedAt"] = startedAt;

      expect(issuesOf(source), startedAt).toEqual([
        {
          pointer: "/meta/startedAt",
          expected: "a real UTC instant between 1970-01-01 and 9999-12-31",
          found: JSON.stringify(startedAt),
        },
      ]);
    }
  });

  it("applies the same check to an authored mtime", () => {
    // Worse in kind than a bad `startedAt`: nothing parses an mtime yet, so
    // one would sit latent until the filesystem subsystem lands.
    const source = minimal();
    const files = (source["repository"] as Record<string, unknown>)[
      "files"
    ] as Record<string, Record<string, unknown>>;
    (files["/etc/motd"] as Record<string, unknown>)["mtime"] =
      "2026-02-30T00:00:00Z";

    expect(issuesOf(source)[0]?.pointer).toBe(
      "/repository/files/~1etc~1motd/mtime",
    );
  });

  it("rejects the root directory as a file key", () => {
    // `/` is a directory, and it is the one path for which cwd containment
    // degenerates — the trailing-slash prefix that excludes cwd itself for
    // every other path matches `/` against itself, so the world's only
    // filesystem coherence check would approve a cwd that collides with a file.
    const source = minimal();
    const repository = source["repository"] as Record<string, unknown>;
    repository["cwd"] = "/";
    repository["files"] = { "/": { contents: "not a directory\n" } };

    expect(issuesOf(source)[0]?.pointer).toBe("/repository/files/~1");
  });

  it("still lets a session open at the root directory", () => {
    const source = minimal();
    (source["repository"] as Record<string, unknown>)["cwd"] = "/";

    expect(loadCartridge(source).repository.cwd).toBe("/");
  });

  it("counts string limits in code points, as the published schema does", () => {
    // 60 astral characters is 120 UTF-16 code units. The emitted contract says
    // `maxLength: 60` and means code points, so counting units here would
    // reject content that validates against the schema this module emitted.
    const source = minimal();
    const models = source["models"] as Record<string, unknown>[];
    (models[0] as Record<string, unknown>)["name"] = "\u{1f9f1}".repeat(60);

    expect(() => loadCartridge(source)).not.toThrow();

    (models[0] as Record<string, unknown>)["name"] = "\u{1f9f1}".repeat(61);
    expect(issuesOf(source)[0]?.expected).toBe("at most 60 characters");
  });

  it("rejects a sparse or decorated array in a schema section too", () => {
    // `models = new Array(1)` satisfies `minItems`, `map` keeps the hole, and
    // `checkModelIds` skips it — so this used to load and then fail in the
    // canonical serializer.
    const holed = minimal();
    holed["models"] = new Array<unknown>(1);
    expect(issuesOf(holed)[0]?.pointer).toBe("/models");

    const trailing = minimal();
    const models = trailing["models"] as unknown[];
    const withHole: unknown[] = [models[0]];
    withHole.length = 2;
    trailing["models"] = withHole;
    expect(issuesOf(trailing)[0]?.expected).toBe(
      "a dense array with no extra properties",
    );
  });

  it("builds a loaded cartridge with exactly the fields the schema declares", () => {
    // `load.ts` cherry-picks the top level by name, so the compiler ties it to
    // `types.ts` but not to `schema.ts`: a field added to the schema and not to
    // that literal would validate, normalize, and then be dropped in silence.
    // This is what actually closes that gap.
    function walk(node: SchemaNode, value: unknown, path: string): void {
      if (node.kind === "object") {
        expect(
          Object.keys(value as object).sort(),
          `${path} should carry every declared field and nothing else`,
        ).toEqual(Object.keys(node.fields).sort());
        for (const [key, field] of Object.entries(node.fields)) {
          walk(
            field.node,
            (value as Record<string, unknown>)[key],
            `${path}/${key}`,
          );
        }
        return;
      }
      if (node.kind === "array") {
        (value as unknown[]).forEach((item, index) =>
          walk(node.items, item, `${path}/${String(index)}`),
        );
        return;
      }
      if (node.kind === "record") {
        for (const [key, item] of Object.entries(value as object)) {
          walk(node.values, item, `${path}/${key}`);
        }
      }
    }

    walk(CARTRIDGE_SCHEMA, loadCartridge(minimal()), "");
  });
});

describe("deferred sections", () => {
  it("carry arbitrary JSON through untouched", () => {
    const source = minimal();
    source["story"] = {
      premise: "the inverted load balancer",
      reveals: [{ at: 3, text: "Where is Europe?" }],
      nested: { deeply: { fine: [1, 2, null, true] } },
    };

    expect(loadCartridge(source).story).toEqual(source["story"]);
  });

  it("are deep-copied, not aliased", () => {
    const source = minimal();
    const story: Record<string, unknown> = { reveals: ["one"] };
    source["story"] = story;

    const loaded = loadCartridge(source);
    (story["reveals"] as string[]).push("two");

    expect(loaded.story["reveals"]).toEqual(["one"]);
  });

  it("still have to be objects", () => {
    const source = minimal();
    source["presentation"] = ["not", "an", "object"];

    expect(issuesOf(source)).toEqual([
      {
        pointer: "/presentation",
        expected: "an object",
        found: "an array of 3",
      },
    ]);
  });

  it("keeps a key that names an accessor on Object.prototype", () => {
    // `out[key] = value` calls the inherited setter for one particular key
    // instead of creating an own property, so this subtree used to load with
    // zero issues and a replaced prototype — and then throw out of the
    // canonical serializer at record time, which is exactly the deferred
    // failure the clone exists to prevent.
    const source = minimal();
    source["story"] = JSON.parse('{"__proto__": {"evil": true}}') as unknown;

    const loaded = loadCartridge(source);
    expect(Object.getPrototypeOf(loaded.story)).toBe(Object.prototype);
    expect(serialize(loaded)).toContain("evil");
  });

  it("reject a class instance instead of laundering it into an empty object", () => {
    // `JSON.parse` cannot produce one, but a cartridge built in memory can —
    // and the Phase 5 pipeline may well build one. Copying its enumerable own
    // properties would turn it into `{}` and lose the value in silence.
    const source = minimal();
    source["story"] = { when: new Date(0) };

    expect(issuesOf(source)).toEqual([
      {
        pointer: "/story/when",
        expected: "a plain object",
        found: "an object with a prototype JSON cannot produce",
      },
    ]);
  });

  it("reject an array with holes or stray properties", () => {
    const holed = minimal();
    holed["story"] = { reveals: [1, , 3] };
    expect(issuesOf(holed)[0]?.pointer).toBe("/story/reveals");

    const decorated = minimal();
    const list: unknown[] = ["one"];
    (list as unknown as Record<string, unknown>)["extra"] = "not an index";
    decorated["story"] = { reveals: list };
    expect(issuesOf(decorated)[0]?.expected).toBe(
      "a dense array with no extra properties",
    );

    // A hole and a stray property are the same key *count* as a dense array,
    // so counting keys would let this pair through to fail at the serializer.
    const compensated = minimal();
    const both: unknown[] = [];
    both[1] = "second";
    (both as unknown as Record<string, unknown>)["extra"] = "not an index";
    compensated["story"] = { reveals: both };
    expect(issuesOf(compensated)[0]?.expected).toBe(
      "a dense array with no extra properties",
    );
  });

  it("reject a value that contains itself, rather than overflowing the stack", () => {
    // Only reachable from a cartridge built in memory, which is exactly the
    // path this module commits to defending. A `RangeError` is not a report
    // the pipeline can act on.
    const source = minimal();
    const story: Record<string, unknown> = { premise: "recursive" };
    story["self"] = story;
    source["story"] = story;

    expect(issuesOf(source)).toEqual([
      {
        pointer: "/story/self",
        expected: "a value that does not contain itself",
        found: "a circular reference, which JSON cannot represent",
      },
    ]);
  });

  it("accept the same subobject referenced twice, which is not a cycle", () => {
    // The regression that a global visited-set would cause. JSON carries a DAG
    // perfectly well, by writing the shared value out twice.
    const shared = { reveal: "Where is Europe?" };
    const source = minimal();
    source["story"] = { first: shared, second: shared };

    expect(loadCartridge(source).story).toEqual({
      first: shared,
      second: shared,
    });
  });

  it("reject values JSON cannot carry, at the pointer they sit at", () => {
    // Deferred subtrees are handed through unread, so without this check a
    // value the serializer refuses would surface much later while recording,
    // with a pointer into the transcript instead of into the cartridge.
    const source = minimal();
    source["story"] = { curve: Number.POSITIVE_INFINITY };

    expect(issuesOf(source)).toEqual([
      { pointer: "/story/curve", expected: "a finite number", found: "null" },
    ]);
  });
});

describe("rejection", () => {
  it("rejects every malformed fixture", () => {
    const names = listInvalidCartridgeFixtures();
    expect(names.length).toBeGreaterThan(0);

    for (const name of names) {
      expect(() => loadCartridge(loadInvalidCartridgeFixture(name))).toThrow(
        CartridgeValidationError,
      );
    }
  });

  it.each([
    [
      "missing-required-field",
      [
        {
          pointer: "/meta/title",
          expected: "a string (required)",
          found: "nothing",
        },
      ],
    ],
    [
      "wrong-type",
      [
        {
          pointer: "/repository/files/~1srv~1app~1main.ts/contents",
          expected: "a string",
          found: "42",
        },
      ],
    ],
    [
      "bad-archetype",
      [
        {
          pointer: "/models/0/archetype",
          expected: "one of paranoid, reckless, superficial, existential",
          found: '"anxious"',
        },
      ],
    ],
    [
      "newer-schema-version",
      [
        {
          pointer: "/meta/schemaVersion",
          expected: "0; this cartridge is newer than this engine understands",
          found: "1",
        },
      ],
    ],
    [
      "dangling-cwd",
      [
        {
          pointer: "/repository/cwd",
          expected: "a directory that at least one declared file lives under",
          found: '"/srv/other", which contains no files',
        },
      ],
    ],
    [
      "relative-file-path",
      [
        {
          pointer: "/repository/files/src~1main.ts",
          expected:
            "a key that is an absolute POSIX path naming a file, not the root directory",
          found: '"src/main.ts"',
        },
      ],
    ],
    [
      "unknown-field",
      [
        {
          pointer: "/repository/files/~1srv~1app~1main.ts/mtme",
          expected:
            "no such field; this object declares contents, mode, owner, group, mtime",
          found: "an unexpected field",
        },
      ],
    ],
    [
      "duplicate-model-id",
      [
        {
          pointer: "/models/1/id",
          expected: "an id no other model uses; ids seed the PRNG",
          found: '"deep-foundation", already used by /models/0',
        },
      ],
    ],
  ])("names the path and the expectation for %s", (name, expected) => {
    expect(issuesOf(loadInvalidCartridgeFixture(name))).toEqual(expected);
  });

  it("reports every problem at once, in document order", () => {
    // A generated cartridge is fixed without a human in the loop, so a
    // validator that stopped at the first problem would turn one bad
    // generation into as many round trips as it had mistakes.
    expect(issuesOf(loadInvalidCartridgeFixture("several-problems"))).toEqual([
      {
        pointer: "/meta/date",
        expected: "a real day of that month (1-28)",
        found: '"2026-02-30"',
      },
      {
        pointer: "/meta/assignment",
        expected: "a string (required)",
        found: "nothing",
      },
      {
        pointer: "/repository/cwd",
        expected: "an absolute POSIX path",
        found: '"relative/path"',
      },
      {
        pointer: "/models/0/costMultiplier",
        expected: "an integer",
        found: '"expensive"',
      },
    ]);
  });

  it("orders issues the same way on every run and every host", () => {
    const runs = new Set(
      Array.from({ length: 5 }, () =>
        JSON.stringify(
          issuesOf(loadInvalidCartridgeFixture("several-problems")),
        ),
      ),
    );
    expect(runs.size).toBe(1);
  });

  it("reports record keys in sorted order, not in the order they were written", () => {
    const source = minimal();
    (source["repository"] as Record<string, unknown>)["files"] = {
      "/z/late.ts": { contents: 1 },
      "/a/early.ts": { contents: 2 },
    };

    expect(issuesOf(source).map((issue) => issue.pointer)).toEqual([
      "/repository/files/~1a~1early.ts/contents",
      "/repository/files/~1z~1late.ts/contents",
      // The cwd check is suppressed while structural issues remain.
    ]);
  });

  it("checks the schema version alone, so a future cartridge gets one line", () => {
    // Validating a v1 document against v0's rules produces a page of cascading
    // nonsense that buries the only line worth reading.
    const source = minimal();
    (source["meta"] as Record<string, unknown>)["schemaVersion"] = 7;
    delete source["models"];

    expect(issuesOf(source)).toHaveLength(1);
    expect(issuesOf(source)[0]?.pointer).toBe("/meta/schemaVersion");
  });

  it("says so when a cartridge does not declare a version at all", () => {
    expect(issuesOf({ repository: {}, models: [] })).toEqual([
      {
        pointer: "/meta/schemaVersion",
        expected: "0 (every cartridge declares its schema version)",
        found: "nothing",
      },
    ]);
  });

  it("rejects a non-object outright", () => {
    for (const value of [null, 42, "cartridge", []]) {
      expect(issuesOf(value)[0]?.pointer).toBe("");
    }
  });

  it("holds cross-field checks back until the shapes are sound", () => {
    // `relative-file-path` also has a cwd that contains no files, but reporting
    // that too would mean a second, derived complaint for one real mistake.
    const issues = issuesOf(loadInvalidCartridgeFixture("relative-file-path"));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.pointer).toBe("/repository/files/src~1main.ts");
  });

  it("escapes JSON pointer tokens, since file paths are full of slashes", () => {
    const source = minimal();
    (source["repository"] as Record<string, unknown>)["files"] = {
      "/a/b~c": { contents: 1 },
    };

    expect(issuesOf(source)[0]?.pointer).toBe(
      "/repository/files/~1a~1b~0c/contents",
    );
  });

  it("renders every issue into the thrown message", () => {
    try {
      loadCartridge(loadInvalidCartridgeFixture("several-problems"));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CartridgeValidationError);
      const rendered = String((error as CartridgeValidationError).message);
      expect(rendered).toContain("4 issues");
      expect(rendered).toContain("/meta/assignment");
      expect(rendered).toContain("/models/0/costMultiplier");
    }
  });
});
