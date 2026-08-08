import { describe, expect, it } from "vitest";

import { serialize } from "../serialize/canonical.js";
import {
  listInvalidCartridgeFixtures,
  loadCartridgeFixture,
  loadInvalidCartridgeFixture,
} from "../testing/fixtures.js";
import {
  CartridgeValidationError,
  MAX_DEFERRED_DEPTH,
  loadCartridge,
} from "./load.js";
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

  it("is frozen all the way down, because every subsystem shares one copy", () => {
    // A loaded cartridge is handed to every event handler as
    // `EventContext.cartridge`, and it sits inside every session state. Nobody
    // owns it, so nobody may write to it: without the freeze,
    // `context.cartridge.meta.title = "…"` from one handler rewrites the world
    // for every later event and for the caller that loaded it.
    const loaded = loadCartridge(minimal());

    for (const frozen of [
      loaded,
      loaded.meta,
      loaded.repository,
      loaded.repository.files,
      loaded.repository.files["/etc/motd"],
      loaded.repository.env,
      loaded.repository.shellHistory,
      loaded.models,
      loaded.models[0],
      loaded.models[0]?.quirks,
      loaded.story,
      loaded.presentation,
    ]) {
      expect(Object.isFrozen(frozen)).toBe(true);
    }

    expect(() => {
      (loaded.meta as { title: string }).title = "MUTATED";
    }).toThrow(TypeError);
    expect(() => {
      (loaded.models as unknown as unknown[]).push({});
    }).toThrow(TypeError);
    expect(() => {
      (loaded.repository.env as Record<string, string>)["PATH"] = "/tampered";
    }).toThrow(TypeError);
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
      "1969-12-31T23:59:59.000Z",
      "2026-13-40T25:61:61.000Z",
      "2026-02-30T00:00:00.000Z",
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
    // every other path matches `/` against itself, so a cartridge whose only
    // file is `/` would satisfy containment by colliding with its own cwd.
    // Collisions at every other path are `checkCwd`'s to catch, below.
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

  it("counts surrogates the way spreading did, without materializing them", () => {
    // The count is walked by hand now — `[...value]` built an array of every
    // character of every string, including the unbounded file contents that
    // never reach a comparison. Unpaired surrogates are where a hand-rolled
    // walk goes wrong: one at the very end tests the lookahead's own bound,
    // and one followed by an ordinary character tests the pair check.
    const name = `${"\u{1f9f1}".repeat(58)}\ud800x`;
    expect([...name].length).toBe(60);

    const source = minimal();
    const models = source["models"] as Record<string, unknown>[];
    (models[0] as Record<string, unknown>)["name"] = name;
    expect(() => loadCartridge(source)).not.toThrow();

    (models[0] as Record<string, unknown>)["name"] = `${name}\ud800`;
    expect(issuesOf(source)[0]?.expected).toBe("at most 60 characters");
  });

  it("accepts one spelling of an instant, not four", () => {
    // `…22Z`, `.0Z`, `.00Z` and `.000Z` are the same moment written four ways,
    // and the loader does not rewrite what it validates — so replay state,
    // which embeds the loaded cartridge, came out with different bytes for
    // sessions identical in every simulated respect.
    for (const startedAt of [
      "2026-08-05T09:14:22Z",
      "2026-08-05T09:14:22.0Z",
      "2026-08-05T09:14:22.00Z",
    ]) {
      const source = minimal();
      (source["meta"] as Record<string, unknown>)["startedAt"] = startedAt;

      expect(issuesOf(source), startedAt).toEqual([
        {
          pointer: "/meta/startedAt",
          expected: "YYYY-MM-DDTHH:MM:SS.mmmZ",
          found: JSON.stringify(startedAt),
        },
      ]);
    }
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

  it("rejects an Array subclass, which `map` would carry through", () => {
    // `Symbol.species` means the copy is a subclass too, so it reaches
    // recorded state and the canonical serializer refuses it there.
    class Models extends Array<unknown> {}
    const source = minimal();
    const models = Models.from(source["models"] as unknown[]);
    source["models"] = models;

    expect(issuesOf(source)).toEqual([
      {
        pointer: "/models",
        expected: "a dense array with no extra properties",
        found: "an Array subclass, which `map` preserves and JSON cannot carry",
      },
    ]);
  });

  it("refuses to run an accessor a cartridge supplied", () => {
    // Reading `value[key]` executes a getter. A throwing one escapes as a host
    // error rather than an issue; a stateful one makes two loads of the same
    // source differ, which is determinism lost inside the function whose job
    // is to establish it.
    let reads = 0;
    const source = minimal();
    source["story"] = Object.defineProperty({}, "premise", {
      enumerable: true,
      get: () => {
        reads += 1;
        return `read ${String(reads)}`;
      },
    });

    expect(issuesOf(source)[0]?.found).toContain("accessor property");
    expect(reads).toBe(0);
  });

  it("refuses an accessor in a validated section too, not only a deferred one", () => {
    for (const build of [
      (source: Record<string, unknown>) => {
        (source["repository"] as Record<string, unknown>)["env"] =
          Object.defineProperty({}, "PATH", {
            enumerable: true,
            get: () => "/bin",
          });
        return "/repository/env";
      },
      (source: Record<string, unknown>) => {
        Object.defineProperty(source["meta"], "title", {
          enumerable: true,
          get: () => "computed",
        });
        return "/meta";
      },
      (source: Record<string, unknown>) => {
        Object.defineProperty(source, "meta", {
          enumerable: true,
          get: () => ({ schemaVersion: 0 }),
        });
        return "";
      },
    ]) {
      const source = minimal();
      const pointer = build(source);
      expect(issuesOf(source)[0]?.pointer, pointer).toBe(pointer);
      expect(issuesOf(source)[0]?.found).toContain("accessor property");
    }
  });

  it("finds an indexed accessor without invoking it", () => {
    // The guard used to look for element accessors with `map`, which reads
    // each element — invoking the very getter it was looking for.
    let reads = 0;
    const reveals: unknown[] = [];
    Object.defineProperty(reveals, "0", {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        throw new Error("element getter exploded");
      },
    });
    reveals.length = 1;

    const source = minimal();
    source["story"] = { reveals };

    expect(issuesOf(source)[0]?.found).toContain("accessor property");
    expect(reads).toBe(0);
  });

  it("finds an indexed accessor in a schema array too", () => {
    let reads = 0;
    const models: unknown[] = [];
    Object.defineProperty(models, "0", {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        return { id: "x" };
      },
    });
    models.length = 1;

    const source = minimal();
    source["models"] = models;

    expect(issuesOf(source)[0]?.pointer).toBe("/models");
    expect(reads).toBe(0);
  });

  it("rejects a branded built-in wearing a plain prototype", () => {
    // A prototype can be repointed; the internal slots that make a Map a Map
    // cannot. Disguised, it has no own keys, so a check that stopped at the
    // prototype would find nothing wrong and write `{}` over it.
    for (const [pointer, disguise] of [
      ["/repository/env", new Map([["PATH", "/bin"]])],
      ["/repository/env", new Set(["PATH"])],
      ["/repository/env", new Date(0)],
    ] as const) {
      Object.setPrototypeOf(disguise, Object.prototype);
      const source = minimal();
      (source["repository"] as Record<string, unknown>)["env"] = disguise;

      expect(issuesOf(source)[0]?.pointer).toBe(pointer);
      expect(issuesOf(source)[0]?.found).toMatch(/which JSON cannot carry/);
    }
  });

  it("checks for symbol keys before asking what a value is branded as", () => {
    // Order, not presence. Brand detection reaches
    // `Object.prototype.toString`, which performs a Get of
    // `Symbol.toStringTag` — so an own accessor there runs inside the function
    // whose job is to classify a value without executing any of it. Rejecting
    // symbol-keyed properties first leaves only an inherited tag, read inertly.
    let reads = 0;
    const tagged: Record<string, unknown> = { premise: "ordinary" };
    Object.defineProperty(tagged, Symbol.toStringTag, {
      configurable: true,
      get: () => {
        reads += 1;
        throw new Error("toStringTag getter exploded");
      },
    });

    const source = minimal();
    source["story"] = tagged;

    expect(issuesOf(source)[0]?.found).toContain("symbol-keyed");
    expect(reads).toBe(0);
  });

  it("rejects buffer-backed built-ins wearing a plain prototype", () => {
    // These carry no tag `Object.prototype.toString` can see once their
    // prototype is repointed, so they read as ordinary objects with no own
    // keys — and the clone writes `{}` over their bytes.
    for (const [label, value] of [
      ["ArrayBuffer", new ArrayBuffer(8)],
      ["DataView", new DataView(new ArrayBuffer(8))],
      ["Uint8Array", new Uint8Array([1, 2, 3])],
      ["Float64Array", new Float64Array([1.5])],
    ] as const) {
      Object.setPrototypeOf(value, Object.prototype);
      const source = minimal();
      source["story"] = { payload: value };

      expect(issuesOf(source)[0], label).toEqual({
        pointer: "/story/payload",
        expected: "an object of plain JSON values",
        found: expect.stringContaining("which JSON cannot carry") as string,
      });
    }
  });

  it("reports a non-finite number as itself, not as null", () => {
    // Reachable from ordinary parsed JSON, unlike most of what the guard
    // catches: `JSON.parse` turns an overflowing exponent into `Infinity`, and
    // `JSON.stringify(Infinity)` is `"null"` — so the issue used to claim the
    // cartridge held null.
    const source = minimal();
    source["story"] = JSON.parse('{"curve": 1e400}') as unknown;

    expect(issuesOf(source)).toEqual([
      {
        pointer: "/story/curve",
        expected: "a finite number",
        found: "Infinity",
      },
    ]);
  });

  it("rejects a disguised built-in the probe table cannot name", () => {
    // The probes are an enumeration and cannot name these — the purity gate
    // forbids writing `Promise`, `SharedArrayBuffer` or `WeakRef` in engine
    // source at all. Structured clone reads internal slots instead, so it
    // needs no name: it either refuses the value or returns a copy wearing the
    // true prototype.
    for (const [label, value] of [
      ["Promise", Promise.resolve(1)],
      ["SharedArrayBuffer", new SharedArrayBuffer(8)],
      ["WeakRef", new WeakRef({})],
      ["FinalizationRegistry", new FinalizationRegistry(() => {})],
    ] as const) {
      Object.setPrototypeOf(value, Object.prototype);
      const source = minimal();
      source["story"] = { payload: value };

      expect(issuesOf(source)[0], label).toEqual({
        pointer: "/story/payload",
        expected: "an object of plain JSON values",
        found: expect.stringContaining("which JSON cannot carry") as string,
      });
    }
  });

  it("rejects one carrying its own data, which used to slip past the probe", () => {
    // The clone test was gated on having no own properties at all, so a single
    // primitive property put a disguised built-in back out of reach: the walk
    // copied the property across and dropped the internal state in silence.
    // The gate is now about what cloning would *read*, and a primitive is
    // already in hand.
    const value: object = Promise.resolve(1);
    Object.defineProperty(value, "label", {
      value: "not a promise, apparently",
      enumerable: true,
      writable: true,
      configurable: true,
    });
    Object.setPrototypeOf(value, Object.prototype);
    const source = minimal();
    source["story"] = { payload: value };

    expect(issuesOf(source)[0]).toEqual({
      pointer: "/story/payload",
      expected: "an object of plain JSON values",
      found: expect.stringContaining("which JSON cannot carry") as string,
    });
  });

  it("will not clone-probe past a property it has not examined", () => {
    // The limit, pinned deliberately. Following an object-valued property
    // means structured clone descends into structure no descriptor pass has
    // seen yet, and invokes any getter waiting there — inside the function
    // whose job is to classify a value without executing any of it. So this
    // one loads, and the residual is recorded rather than traded for a live
    // hazard.
    const value: object = Promise.resolve(1);
    Object.defineProperty(value, "nested", {
      value: { deep: true },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    Object.setPrototypeOf(value, Object.prototype);
    const source = minimal();
    source["story"] = { payload: value };

    expect(loadCartridge(source).story).toEqual({
      payload: { nested: { deep: true } },
    });
  });

  it("does not mistake an ordinary object holding a function for a built-in", () => {
    // Structured clone refuses a function, so probing here would answer
    // "built-in that structured clone refuses to copy" — confidently, about
    // something that is not one. The walk reports the function where it is.
    const source = minimal();
    source["story"] = { payload: { handler: () => 1 } };

    expect(issuesOf(source)[0]?.found).not.toContain("structured clone");
  });

  it("rejects these already when their prototype is intact", () => {
    // The case a real pipeline produces — a forgotten `await`, a stray buffer
    // — never needed the clone test: the prototype check has always caught it.
    // Worth pinning, because it is the difference between a live defect and a
    // hardening measure.
    for (const [label, value] of [
      ["Promise", Promise.resolve(1)],
      ["SharedArrayBuffer", new SharedArrayBuffer(8)],
      ["WeakRef", new WeakRef({})],
    ] as const) {
      const source = minimal();
      source["story"] = { payload: value };

      expect(issuesOf(source)[0]?.found, label).toBe(
        "an object with a prototype JSON cannot produce",
      );
    }
  });

  it("bounds how deep a deferred subtree may nest", () => {
    // Reachable from an ordinary cartridge file, unlike most of what this
    // guard catches: `JSON.parse` accepts a few thousand levels, the published
    // schema leaves these sections unconstrained, and the recursive clone then
    // exhausted the stack — so `loadCartridge` escaped with a bare `RangeError`
    // and the validation boundary failed open.
    function nested(levels: number): unknown {
      let node: Record<string, unknown> = { leaf: true };
      for (let index = 0; index < levels; index += 1) node = { next: node };
      // Round-tripped, so this is exactly the shape a cartridge file yields.
      return JSON.parse(JSON.stringify(node)) as unknown;
    }

    const shallow = minimal();
    shallow["story"] = nested(MAX_DEFERRED_DEPTH - 2);
    expect(() => loadCartridge(shallow)).not.toThrow();

    // Deep enough to be well past the limit, shallow enough that the *test's
    // own* `JSON.stringify` survives. V8's stringify was recursive through
    // Node 22 and overflows somewhere above 3000 there, so a 20000-level case
    // failed in CI while passing on a newer local Node — and it failed while
    // building the fixture, before the loader was ever called. Nothing is lost:
    // the guard trips at 64, so every depth past it takes the same path.
    for (const levels of [MAX_DEFERRED_DEPTH + 40, 1000]) {
      const source = minimal();
      source["story"] = nested(levels);

      // A validation issue, not a host error — that is the whole point.
      expect(issuesOf(source)[0]?.expected, String(levels)).toBe(
        `at most ${String(MAX_DEFERRED_DEPTH)} levels of nesting`,
      );
    }
  });

  it("still accepts a null-prototype object and an ordinary array", () => {
    // The brand check must not catch these. `Object.create(null)` is what a
    // careful generator uses to avoid inherited keys, and it serializes fine.
    const bare = Object.create(null) as Record<string, unknown>;
    bare["premise"] = "still fine";

    const source = minimal();
    source["story"] = { bare, beats: ["one", "two"] };

    expect(loadCartridge(source).story).toEqual({
      bare: { premise: "still fine" },
      beats: ["one", "two"],
    });
  });

  it("rejects a branded built-in rather than emptying it", () => {
    // A `Map` has no own enumerable properties, so every later check passes
    // and the walk writes an empty object over it — discarding every entry in
    // silence, which is the worst outcome available.
    const source = minimal();
    (source["repository"] as Record<string, unknown>)["env"] = new Map([
      ["PATH", "/bin"],
    ]);

    expect(issuesOf(source)).toEqual([
      {
        pointer: "/repository/env",
        expected: "an object of plain JSON values",
        found: "an object with a prototype JSON cannot produce",
      },
    ]);
  });

  it("rejects properties the serializer would drop in silence", () => {
    const hidden = minimal();
    (hidden["repository"] as Record<string, unknown>)["env"] =
      Object.defineProperty({}, "SECRET", {
        enumerable: false,
        value: "invisible",
      });
    expect(issuesOf(hidden)[0]?.found).toContain("non-enumerable");

    const symbolic = minimal();
    symbolic["story"] = { [Symbol("beat")]: "unreachable" };
    expect(issuesOf(symbolic)[0]?.found).toContain("symbol-keyed");
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
        expected: "an object of plain JSON values",
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
      {
        pointer: "/story/curve",
        // Not `"null"`, which is what this asserted while `describe` ran the
        // value through `JSON.stringify` — the test was pinning the misleading
        // answer rather than catching it.
        expected: "a finite number",
        found: "Infinity",
      },
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
          expected: "a single-line string (required)",
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
        expected: "a single-line string (required)",
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
      // And the cwd check still runs: it reads the file *keys*, which are
      // sound here, not their contents. Gating it on the whole `/repository`
      // subtree would have hidden this.
      "/repository/cwd",
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

  it("rejects a line terminator in a field declared to be one line", () => {
    // Nothing downstream catches this: a description with a newline simply
    // arrives in the model selector as two lines. So it belongs at the
    // validation boundary with everything else the fallback episode depends on.
    for (const [pointer, apply] of [
      [
        "/models/0/description",
        (source: Record<string, unknown>, text: string) => {
          (
            (source["models"] as Record<string, unknown>[])[0] as Record<
              string,
              unknown
            >
          )["description"] = text;
        },
      ],
      [
        "/meta/title",
        (source: Record<string, unknown>, text: string) => {
          (source["meta"] as Record<string, unknown>)["title"] = text;
        },
      ],
    ] as const) {
      // U+2028 is a line terminator to JavaScript even though most tools
      // treat it as ordinary text, which is exactly why it needs naming.
      for (const text of [
        "first" + String.fromCharCode(10) + "second",
        String.fromCharCode(10),
        "tab" + String.fromCharCode(9) + "here",
        "a" + String.fromCharCode(0x2028) + "b",
      ]) {
        const source = minimal();
        apply(source, text);
        expect(
          issuesOf(source)[0],
          `${pointer} ${JSON.stringify(text)}`,
        ).toEqual({
          pointer,
          expected: "a single-line string",
          found: JSON.stringify(text),
        });
      }
    }
  });

  it("reports a cross-field problem alongside an unrelated one", () => {
    // Gating every cross-check on the whole report meant one bad `meta` field
    // hid a duplicate model id entirely, costing the generator a round trip
    // the every-issue-at-once contract exists to save.
    const source = minimal();
    delete (source["meta"] as Record<string, unknown>)["assignment"];
    const models = source["models"] as Record<string, unknown>[];
    (models[1] as Record<string, unknown>)["id"] = models[0]?.["id"];

    expect(issuesOf(source).map((issue) => issue.pointer)).toEqual([
      "/meta/assignment",
      "/models/1/id",
    ]);
  });

  it("gates a cross-check on the fields it reads, not on its whole section", () => {
    // An invalid *description* says nothing about whether the ids collide, so
    // suppressing the duplicate would cost the generator a round trip for no
    // reason. Same for file contents against a dangling cwd.
    const models = minimal();
    const list = models["models"] as Record<string, unknown>[];
    (list[0] as Record<string, unknown>)["description"] = 42;
    (list[1] as Record<string, unknown>)["id"] = list[0]?.["id"];

    expect(issuesOf(models).map((issue) => issue.pointer)).toEqual([
      "/models/0/description",
      "/models/1/id",
    ]);

    const files = minimal();
    const repository = files["repository"] as Record<string, unknown>;
    repository["cwd"] = "/srv/elsewhere";
    (
      (repository["files"] as Record<string, Record<string, unknown>>)[
        "/etc/motd"
      ] as Record<string, unknown>
    )["contents"] = 42;

    expect(issuesOf(files).map((issue) => issue.pointer)).toEqual([
      "/repository/files/~1etc~1motd/contents",
      "/repository/cwd",
    ]);
  });

  it("treats a substituted whole item as a substituted id", () => {
    // Narrowing the gate to `/models/<n>/id` dropped this: two invalid items
    // are reported at `/models/0` and `/models/1`, each substituted with `{}`,
    // so both ids read as undefined and collide into a phantom duplicate on
    // top of the two real problems. A pointer at the item is a substitution of
    // every field inside it.
    const source = minimal();
    source["models"] = [null, null];

    expect(issuesOf(source).map((issue) => issue.pointer)).toEqual([
      "/models/0",
      "/models/1",
    ]);
  });

  it("checks the models whose ids survived, not none of them", () => {
    // Skipping the whole array because one item is invalid costs a round trip
    // on a real duplicate elsewhere — the opposite error from inventing one.
    const source = minimal();
    const models = source["models"] as Record<string, unknown>[];
    source["models"] = [null, models[0], { ...models[0] }];

    expect(issuesOf(source).map((issue) => issue.pointer)).toEqual([
      "/models/0",
      "/models/2/id",
    ]);
  });

  it("tells a bad file value apart from a bad file key", () => {
    // Both are reported at the file's own pointer, so pointer shape cannot
    // distinguish them — and `checkCwd` reads the keys, not the values.
    const badValue = minimal();
    const repository = badValue["repository"] as Record<string, unknown>;
    repository["cwd"] = "/missing";
    repository["files"] = { "/valid/file": null };

    expect(issuesOf(badValue).map((issue) => issue.pointer)).toEqual([
      "/repository/files/~1valid~1file",
      "/repository/cwd",
    ]);

    // A bad key does suppress it: the key set is what the check reads.
    const badKey = minimal();
    const other = badKey["repository"] as Record<string, unknown>;
    other["cwd"] = "/missing";
    other["files"] = { "relative/file": { contents: "x\n" } };

    expect(issuesOf(badKey).map((issue) => issue.pointer)).toEqual([
      "/repository/files/relative~1file",
    ]);
  });

  it("checks cwd against the keys that validated, ignoring one that did not", () => {
    // One typo among a hundred file paths used to switch off the world's only
    // filesystem coherence check. It says nothing about whether the session
    // opens somewhere the world contains.
    const source = minimal();
    const repository = source["repository"] as Record<string, unknown>;
    repository["cwd"] = "/missing";
    repository["files"] = {
      "/a/x": { contents: "x\n" },
      relative: { contents: "y\n" },
    };

    expect(issuesOf(source).map((issue) => issue.pointer)).toEqual([
      "/repository/files/relative",
      "/repository/cwd",
    ]);
  });

  it("rejects a cwd the cartridge also declares as a file", () => {
    // Containment passes here — `/srv/app/main.ts` lives under `/srv/app/` —
    // so the check that ran before this one accepted a world where `/srv/app`
    // is at once the directory the session opens in and a file `cat` prints.
    const source = minimal();
    const repository = source["repository"] as Record<string, unknown>;
    repository["cwd"] = "/srv/app";
    repository["files"] = {
      "/srv/app": { contents: "not a directory\n" },
      "/srv/app/main.ts": { contents: "x\n" },
    };

    expect(issuesOf(source)).toEqual([
      {
        pointer: "/repository/cwd",
        expected:
          "a directory, not a path the cartridge also declares as a file",
        found: '"/srv/app", which is declared as a file',
      },
    ]);
  });

  it("reports a colliding cwd once, not also as containing no files", () => {
    // With no descendant, both readings hold — but one edit to either field
    // fixes both, so the containment issue would be a derived complaint. The
    // collision is the more specific of the two.
    const source = minimal();
    const repository = source["repository"] as Record<string, unknown>;
    repository["cwd"] = "/srv/app";
    repository["files"] = { "/srv/app": { contents: "not a directory\n" } };

    expect(issuesOf(source).map((issue) => issue.expected)).toEqual([
      "a directory, not a path the cartridge also declares as a file",
    ]);
  });

  it("does not mistake a prefix of a file path for a collision", () => {
    // `/srv/appliance` starts with `/srv/app` without being it. The collision
    // is exact-key, and the containment prefix carries the trailing slash for
    // the same reason.
    const source = minimal();
    const repository = source["repository"] as Record<string, unknown>;
    repository["cwd"] = "/srv/app";
    repository["files"] = {
      "/srv/appliance": { contents: "x\n" },
      "/srv/app/main.ts": { contents: "y\n" },
    };

    expect(loadCartridge(source).repository.cwd).toBe("/srv/app");
  });

  it("says nothing about cwd when no file key could be read at all", () => {
    // The other side of the same rule. With nothing readable there is no
    // answer, only an absence of one — "contains no files" would be a second
    // complaint about the first mistake. This also pins `minEntries` to the
    // keys that were written rather than the ones that validated: a misnamed
    // file is still a file, and "no files" on top would be a third complaint.
    const source = minimal();
    const repository = source["repository"] as Record<string, unknown>;
    repository["cwd"] = "/missing";
    repository["files"] = { relative: { contents: "y\n" } };

    expect(issuesOf(source).map((issue) => issue.pointer)).toEqual([
      "/repository/files/relative",
    ]);
  });

  it("rejects a world with no files at the record, not at the cwd", () => {
    // Not the same case as the one above, though both leave `checkCwd` with
    // nothing to compare against. Keys that failed to validate make the
    // question unanswerable; declaring none answers it — and the answer is
    // that there is no world here. It is reported at `files` because that is
    // the field that has to change: with an empty map no value of `cwd`
    // satisfies the cross-check, so a generator sent to `cwd` would edit it,
    // resubmit, and get the same issue back.
    const source = minimal();
    const repository = source["repository"] as Record<string, unknown>;
    repository["files"] = {};

    expect(issuesOf(source)).toEqual([
      {
        pointer: "/repository/files",
        expected: "at least 1 entry",
        found: "an object with 0 entries",
      },
    ]);
  });

  it("reports an empty file map once, not again through the cross-check", () => {
    // `/` is the one cwd every path is under, so a containment check that ran
    // anyway would still report — and the generator would get two issues for
    // one mistake, the second of them unactionable.
    const source = minimal();
    const repository = source["repository"] as Record<string, unknown>;
    repository["cwd"] = "/";
    repository["files"] = {};

    expect(issuesOf(source).map((issue) => issue.pointer)).toEqual([
      "/repository/files",
    ]);
  });

  it("still holds a cross-check back when its own subtree is broken", () => {
    // The reason the gate exists: two models each missing an `id` would
    // collide on the walk's substitute and produce a phantom duplicate on top
    // of the two real problems.
    const source = minimal();
    for (const model of source["models"] as Record<string, unknown>[]) {
      delete model["id"];
    }

    expect(issuesOf(source).map((issue) => issue.pointer)).toEqual([
      "/models/0/id",
      "/models/1/id",
    ]);
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
