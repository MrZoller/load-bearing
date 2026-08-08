import { describe, expect, it } from "vitest";

import { loadCartridge } from "../cartridge/load.js";
import type { LoadedCartridge } from "../cartridge/types.js";
import { serialize } from "../serialize/canonical.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
import { defineEventModule } from "./module.js";
import type { EventModule } from "./module.js";
import { reduce } from "./reduce.js";
import { EventRegistryError, createRegistry } from "./registry.js";
import type { EngineEvent } from "./state.js";

const CARTRIDGE: LoadedCartridge = loadCartridge(
  loadCartridgeFixture("minimal"),
);
const SEED = "2026-08-05/0/deep-foundation";

/** A module that counts its own events and says so. */
function counter(namespace: string): EventModule {
  return defineEventModule<number>({
    namespace,
    description: `counts ${namespace} events`,
    initialSlice: () => 0,
    events: {
      [`${namespace}.bump`]: {
        version: 0,
        apply(context, slice) {
          // Draws so the fold touches this module's stream, which is the other
          // thing registration order could perturb if it were shared.
          return {
            slice: slice + 1,
            summary: `n=${String(slice + 1)} draw=${String(context.random.nextUint32())}`,
          };
        },
      },
    },
  });
}

describe("defineEventModule", () => {
  const module = counter("alpha");

  it("is frozen, so nothing can add a handler after the fact", () => {
    expect(Object.isFrozen(module)).toBe(true);
    expect(Object.isFrozen(module.handlers)).toBe(true);
    expect(Object.isFrozen(module.types)).toBe(true);
  });

  it("reports its types sorted, and whether it holds state", () => {
    expect(module.types).toEqual(["alpha.bump"]);
    expect(module.stateful).toBe(true);
    expect(
      defineEventModule({
        namespace: "beta",
        description: "no state",
        events: { "beta.ping": { version: 0, apply: () => ({}) } },
      }).stateful,
    ).toBe(false);
  });
});

describe("createRegistry", () => {
  it("indexes handlers by exact type, never by search order", () => {
    const registry = createRegistry([counter("alpha"), counter("beta")]);

    expect(registry.handler("alpha.bump")?.namespace).toBe("alpha");
    expect(registry.handler("beta.bump")?.namespace).toBe("beta");
    expect(registry.handler("gamma.bump")).toBeUndefined();
    expect(registry.module("alpha")?.description).toContain("alpha");
  });

  it("sorts its listings, whichever order the modules arrived in", () => {
    const forwards = createRegistry([counter("alpha"), counter("beta")]);
    const backwards = createRegistry([counter("beta"), counter("alpha")]);

    expect(forwards.namespaces).toEqual(["alpha", "beta"]);
    expect(backwards.namespaces).toEqual(forwards.namespaces);
    expect(backwards.types).toEqual(forwards.types);
    expect(backwards.modules.map((m) => m.namespace)).toEqual(
      forwards.modules.map((m) => m.namespace),
    );
  });

  it("folds identically whichever order the modules were listed in", () => {
    // The load-bearing property of the whole extension point: #5 through #13
    // add themselves to a list, and where in that list must not be able to
    // change a single byte of a recorded session.
    const events: readonly EngineEvent[] = [
      { type: "beta.bump" },
      { type: "alpha.bump" },
      { type: "beta.bump" },
      { type: "alpha.bump" },
    ];

    const forwards = reduce({
      cartridge: CARTRIDGE,
      seed: SEED,
      events,
      registry: createRegistry([counter("alpha"), counter("beta")]),
    });
    const backwards = reduce({
      cartridge: CARTRIDGE,
      seed: SEED,
      events,
      registry: createRegistry([counter("beta"), counter("alpha")]),
    });

    expect(serialize(backwards)).toBe(serialize(forwards));
    expect(forwards.slices).toEqual({ alpha: 2, beta: 2 });
  });

  it("keeps one module's draws out of another's stream", () => {
    // Each module is handed `root/<namespace>`, so the number `alpha` draws
    // cannot depend on how often `beta` drew first.
    const registry = createRegistry([counter("alpha"), counter("beta")]);
    const alone = reduce({
      cartridge: CARTRIDGE,
      seed: SEED,
      events: [{ type: "alpha.bump" }],
      registry,
    });
    const crowded = reduce({
      cartridge: CARTRIDGE,
      seed: SEED,
      events: [
        { type: "beta.bump" },
        { type: "beta.bump" },
        { type: "alpha.bump" },
      ],
      registry,
    });

    const alphaLine = (state: {
      transcript: readonly { type: string; summary: string }[];
    }) =>
      state.transcript.find((entry) => entry.type === "alpha.bump")?.summary;

    expect(alphaLine(crowded)).toBe(alphaLine(alone));
  });

  it("accepts an empty registry", () => {
    const registry = createRegistry([]);
    expect(registry.types).toEqual([]);
    expect(registry.namespaces).toEqual([]);
  });

  const rejections: readonly (readonly [string, () => unknown, RegExp])[] = [
    [
      "a namespace that is not one lowercase word",
      () => createRegistry([counter("Alpha")]),
      /namespace "Alpha" must match/,
    ],
    [
      "a namespace containing a dot, which would make the prefix ambiguous",
      () => createRegistry([counter("a.b")]),
      /namespace "a\.b" must match/,
    ],
    [
      "two modules claiming one namespace",
      () => createRegistry([counter("alpha"), counter("alpha")]),
      /two modules claim the namespace "alpha"/,
    ],
    [
      "a module with no event types",
      () =>
        createRegistry([
          defineEventModule({
            namespace: "empty",
            description: "",
            events: {},
          }),
        ]),
      /registers no event types/,
    ],
    [
      "a type outside its module's namespace",
      () =>
        createRegistry([
          defineEventModule({
            namespace: "alpha",
            description: "",
            events: { "beta.bump": { version: 0, apply: () => ({}) } },
          }),
        ]),
      /does not start with "alpha\."/,
    ],
    [
      "a type whose name would not survive being written down",
      () =>
        createRegistry([
          defineEventModule({
            namespace: "alpha",
            description: "",
            events: { "alpha.Bump It": { version: 0, apply: () => ({}) } },
          }),
        ]),
      /the part after the namespace must match/,
    ],
    [
      "a payload version that is not a non-negative integer",
      () =>
        createRegistry([
          defineEventModule({
            namespace: "alpha",
            description: "",
            events: { "alpha.bump": { version: -1, apply: () => ({}) } },
          }),
        ]),
      /version must be a non-negative integer/,
    ],
  ];

  it.each(rejections)("rejects %s", (_what, build, expected) => {
    expect(build).toThrow(EventRegistryError);
    expect(build).toThrow(expected);
  });
});
