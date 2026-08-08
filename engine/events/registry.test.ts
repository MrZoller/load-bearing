import { describe, expect, it } from "vitest";

import { loadCartridge } from "../cartridge/load.js";
import type { LoadedCartridge } from "../cartridge/types.js";
import { serialize } from "../serialize/canonical.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
import { EMPTY_EVENT_LOG, appendEvent } from "./log.js";
import { defineEventModule } from "./module.js";
import type {
  EventHandlerDefinition,
  EventModule,
  RegisteredHandler,
} from "./module.js";
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

  it("rejects a handler that does not belong to the module filing it", () => {
    // `EventModule` is a plain interface, so a hand-built one can carry a
    // handler whose own `type` or `namespace` disagrees with where it is
    // filed. `step` trusts both — it looks up by type, then finds the module
    // by `handler.namespace` — so a mismatch used to surface much later as a
    // TypeError on an undefined module, with nothing naming the culprit.
    const handmade = (
      handler: Partial<{ type: string; namespace: string }>,
    ): EventModule => {
      const sound = counter("alpha");
      const real = sound.handlers["alpha.bump"] as RegisteredHandler;
      return {
        ...sound,
        handlers: { "alpha.bump": { ...real, ...handler } },
      };
    };

    expect(() => createRegistry([handmade({ type: "alpha.other" })])).toThrow(
      /files a handler under "alpha\.bump" that calls itself "alpha\.other"/,
    );
    expect(() => createRegistry([handmade({ namespace: "nope" })])).toThrow(
      /claims namespace "nope" but belongs to module "alpha"/,
    );
  });

  it("stores a frozen copy of each handler, not the caller's object", () => {
    // `EventModule` is a plain interface, so a hand-built one can supply a
    // mutable handler — and swapping its `apply` after registration would
    // change how a session folds while every frozen surface still reported the
    // module as sealed. `defineEventModule` closes that door for modules built
    // through it; this is the one that was left open.
    const sound = counter("alpha");
    const real = sound.handlers["alpha.bump"] as RegisteredHandler;
    const mutable = { ...real };
    const registry = createRegistry([
      { ...sound, handlers: { "alpha.bump": mutable } },
    ]);
    const fold = () =>
      reduce({
        cartridge: CARTRIDGE,
        seed: SEED,
        registry,
        events: [{ type: "alpha.bump" }],
      }).transcript[0]?.summary;

    const before = fold();
    mutable.apply = () => ({ summary: "HIJACKED" });

    expect(fold()).toBe(before);
    expect(registry.handler("alpha.bump")).not.toBe(mutable);
    expect(Object.isFrozen(registry.handler("alpha.bump"))).toBe(true);
  });

  it("stores a frozen copy of each module, not the caller's object", () => {
    // Same argument as the handler copy above, one level out: this function
    // spends its whole length validating a hand-built module, and holding the
    // caller's object afterwards lets every one of those checks be undone
    // after it passed.
    const sound = counter("gamma");
    const hand: EventModule = { ...sound };
    const registry = createRegistry([hand]);
    const bootstrapped = () =>
      reduce({ cartridge: CARTRIDGE, seed: SEED, registry, events: [] }).slices[
        "gamma"
      ];

    const before = bootstrapped();
    expect(before).toBe(0);

    // Each of the three mutations Codex demonstrated, all no-ops now.
    hand.initialSlice = () => 999;
    (hand as { namespace: string }).namespace = "delta";
    (hand as { stateful: boolean }).stateful = false;

    expect(bootstrapped()).toBe(before);
    expect(registry.modules[0]).not.toBe(hand);
    expect(Object.isFrozen(registry.modules[0])).toBe(true);
    expect(registry.module("gamma")?.namespace).toBe("gamma");
    expect(
      reduce({
        cartridge: CARTRIDGE,
        seed: SEED,
        registry,
        events: [{ type: "gamma.bump" }],
      }).slices["gamma"],
    ).toBe(1);
  });

  it("captures a handler's version before validating it", () => {
    // The one handler field that was read twice — once to check, once to
    // store. A getter passing the check and then landing `-1` in the frozen
    // copy makes `appendEvent` stamp a log entry that the reducer's own
    // `assertEventEnvelope` refuses: two engine components disagreeing about
    // the same event.
    const sound = counter("alpha");
    const real = sound.handlers["alpha.bump"] as RegisteredHandler;
    let reads = 0;
    const shifty = {
      type: real.type,
      namespace: real.namespace,
      apply: real.apply,
      get version(): number {
        reads += 1;
        return reads > 2 ? -1 : 0;
      },
    };
    const registry = createRegistry([
      { ...sound, handlers: { "alpha.bump": shifty } },
    ]);

    expect(registry.handler("alpha.bump")?.version).toBe(0);
    expect(
      appendEvent(EMPTY_EVENT_LOG, { type: "alpha.bump" }, registry)[0]
        ?.version,
    ).toBe(0);
  });

  it("rejects a handler its module's types do not list", () => {
    // The other direction of the pair already checked ("lists X but has no
    // handler for it"). Unlisted means never registered, so the type would
    // look declared on `registry.modules[i].handlers` and fail to dispatch.
    const sound = counter("alpha");
    const real = sound.handlers["alpha.bump"] as RegisteredHandler;

    expect(() =>
      createRegistry([
        {
          ...sound,
          handlers: {
            "alpha.bump": real,
            "alpha.ghost": { ...real, type: "alpha.ghost" },
          },
        },
      ]),
    ).toThrow(/handler\(s\) for alpha\.ghost that its types do not list/);
  });

  it("freezes a copy of the handlers record it publishes", () => {
    // `./module.ts`'s standing answer lists `registry.modules[i]` under
    // "frozen and copied, therefore safe". That was false while the record was
    // the caller's: a hand-built module could add an entry after registration,
    // so a record the engine presents as its own would list a type it will
    // never dispatch.
    const sound = counter("alpha");
    const handlers: Record<string, RegisteredHandler> = {
      "alpha.bump": sound.handlers["alpha.bump"] as RegisteredHandler,
    };
    const registry = createRegistry([{ ...sound, handlers }]);
    const published = (registry.modules[0] as EventModule).handlers;

    handlers["alpha.late"] = {
      ...(sound.handlers["alpha.bump"] as RegisteredHandler),
      type: "alpha.late",
    };

    expect(Object.isFrozen(published)).toBe(true);
    expect(Object.keys(published)).toEqual(["alpha.bump"]);
    expect(registry.types).toEqual(["alpha.bump"]);
  });

  it("rejects a module with no initialSlice function", () => {
    // Required by the interface, but the interface is one a caller satisfies
    // by hand — and binding a missing one would throw a bare TypeError out of
    // registry construction instead of saying what is wrong.
    const sound = counter("gamma");
    const { initialSlice: _dropped, ...without } = sound;

    expect(() => createRegistry([without as EventModule])).toThrow(
      /has no initialSlice function/,
    );
  });

  it("reports every dereferenced field as a registry error, never a bare TypeError", () => {
    // The closed set: every field `createRegistry` reaches on a hand-built
    // module and then calls, spreads, or pattern-matches. Each would otherwise
    // surface as a TypeError naming neither the module nor the field.
    const sound = counter("gamma");
    const real = sound.handlers["gamma.bump"] as RegisteredHandler;
    const withModule = (patch: Record<string, unknown>) => () =>
      createRegistry([{ ...sound, ...patch } as unknown as EventModule]);

    const cases: readonly (readonly [string, () => unknown, RegExp])[] = [
      [
        "a module list that is not iterable",
        () => createRegistry(null as unknown as readonly EventModule[]),
        /module list must be iterable/,
      ],
      [
        "not an object",
        () => createRegistry([null as unknown as EventModule]),
        /a module must be an object/,
      ],
      [
        "a non-string namespace",
        withModule({ namespace: 7 }),
        /namespace must be a string/,
      ],
      [
        "types that are not an array",
        withModule({ types: "gamma.bump" }),
        /must declare its types as an array/,
      ],
      [
        "a non-string type",
        withModule({ types: [7] }),
        /declares a type that is not a string/,
      ],
      [
        "a non-function validateSlice",
        withModule({ validateSlice: "nope" }),
        /validateSlice that is not a function/,
      ],
      [
        "a handler with no apply",
        withModule({
          handlers: { "gamma.bump": { ...real, apply: undefined } },
        }),
        /handler "gamma\.bump" has no apply function/,
      ],
      // `undefined` and `null` are exactly the two values that throw on
      // property access; `=== undefined` alone let `null` reach `handler.type`
      // and a bare TypeError. Every other wrong type yields `undefined` for
      // `.type` and lands in a named error, so this completes the pair.
      [
        "a null handler",
        withModule({ handlers: { "gamma.bump": null } }),
        /has no handler for it, got null/,
      ],
      [
        "a handler that is a number",
        withModule({ handlers: { "gamma.bump": 42 } }),
        /files a handler under "gamma\.bump" that calls itself undefined/,
      ],
    ];

    for (const [what, build, expected] of cases) {
      expect(build, what).toThrow(EventRegistryError);
      expect(build, what).toThrow(expected);
    }
  });

  it("rejects a definition whose events or handlers it cannot dereference", () => {
    // `defineEventModule` defers validation to `createRegistry` — but only for
    // what it passes through. These two it dereferences itself, so a malformed
    // definition would never reach the validator meant to describe it.
    expect(() =>
      defineEventModule({
        namespace: "gamma",
        description: "",
        events: undefined as unknown as Record<string, never>,
      }),
    ).toThrow(/must declare its events as an object/);

    expect(() =>
      defineEventModule({
        namespace: "gamma",
        description: "",
        events: {
          "gamma.bump": {
            version: 0,
          } as unknown as EventHandlerDefinition<unknown>,
        },
      }),
    ).toThrow(/handler "gamma\.bump" has no apply function/);
  });

  it("binds every callback to the definition, as createRegistry already did", () => {
    // TypeScript accepts method shorthand on all three callbacks and
    // contextually types `this` as the definition object, so this is type-clean
    // code — and calling `initialSlice` or `validateSlice` unbound threw
    // `Cannot read properties of undefined` out of `bootstrap`, naming no
    // module, while the hand-built path through `createRegistry` worked. The
    // two construction paths disagreed and the front door was the broken one.
    // No cast: every callback below reads a field the definition declares, and
    // this compiles with zero errors under the repo's own settings.
    const module = defineEventModule<{ from: string }>({
      namespace: "receiver",
      description: "reads its own definition through `this`",
      initialSlice() {
        return { from: this.description };
      },
      validateSlice(slice) {
        return { from: (slice as { from: string }).from };
      },
      events: {
        "receiver.go": {
          version: 0,
          apply() {
            return { summary: `v${String(this.version)}` };
          },
        },
      },
    });
    const registry = createRegistry([module]);

    const state = reduce({
      cartridge: CARTRIDGE,
      seed: SEED,
      registry,
      events: [{ type: "receiver.go" }],
    });

    expect(state.slices["receiver"]).toEqual({
      from: "reads its own definition through `this`",
    });
    expect(state.transcript[0]?.summary).toBe("v0");
    // And the validator keeps the same receiver on the way back in.
    expect(module.validateSlice?.({ from: "kept" }, "where")).toEqual({
      from: "kept",
    });
  });

  it("rejects a non-function initialSlice or validateSlice before wrapping it", () => {
    // The wrappers `defineEventModule` builds are functions whatever they close
    // over, so wrapping first would launder a bad value straight past
    // `createRegistry`'s `typeof … !== "function"` guard — the module would
    // register cleanly and then throw a bare TypeError at bootstrap, mid-fold,
    // naming nothing. A wrapper must never be what a downstream type check sees.
    const definition = (patch: Record<string, unknown>) => () =>
      defineEventModule({
        namespace: "gamma",
        description: "",
        events: { "gamma.bump": { version: 0, apply: () => ({}) } },
        ...patch,
      } as never);

    expect(definition({ initialSlice: 42 })).toThrow(EventRegistryError);
    expect(definition({ initialSlice: 42 })).toThrow(
      /initialSlice that is not a function, got number/,
    );
    expect(definition({ validateSlice: "nope" })).toThrow(EventRegistryError);
    expect(definition({ validateSlice: "nope" })).toThrow(
      /validateSlice that is not a function, got string/,
    );
  });

  it("reads each namespace once, before the sort orders by it", () => {
    // Same discipline as the `version` capture, and the field that has to
    // prove it first: a comparator re-reading `entry.namespace` reads it twice
    // more, so a getter could pass the shape check and then sort under one
    // value while registering under another.
    const sound = counter("alpha");
    let reads = 0;
    const shifty = {
      ...sound,
      get namespace(): string {
        reads += 1;
        return reads > 1 ? "zzz" : "alpha";
      },
    };
    const registry = createRegistry([shifty as EventModule, counter("beta")]);

    expect(registry.namespaces).toEqual(["alpha", "beta"]);
    expect(registry.module("alpha")?.namespace).toBe("alpha");
    expect(registry.types).toEqual(["alpha.bump", "beta.bump"]);
  });

  it("leaves the module's own handlers record as the module declared it", () => {
    // The consequence of storing a copy: `registry.modules[i].handlers[t]` and
    // `registry.handler(t)` are now different objects. Dispatch only ever uses
    // the second, and the first stays exactly what the module published.
    const registry = createRegistry([counter("alpha")]);
    const module = registry.modules[0] as EventModule;

    expect(Object.isFrozen(module.handlers)).toBe(true);
    expect(module.handlers["alpha.bump"]).not.toBe(
      registry.handler("alpha.bump"),
    );
    expect(module.handlers["alpha.bump"]?.type).toBe("alpha.bump");
  });

  it("rejects a slice validator on a module that holds no slice", () => {
    // It could never run, and its author would believe their snapshot was
    // being checked.
    expect(() =>
      createRegistry([
        defineEventModule({
          namespace: "stateless",
          description: "validates a slice it does not have",
          validateSlice: (slice) => slice,
          events: { "stateless.ping": { version: 0, apply: () => ({}) } },
        }),
      ]),
    ).toThrow(/declares validateSlice but no initialSlice/);
  });
});

describe("a handler captured at definition time", () => {
  /** A definition whose handler object stays reachable and mutable. */
  function mutableDefinition() {
    const events = {
      "late.call": {
        version: 0,
        apply: (): { summary: string } => ({ summary: "original" }),
      },
    };
    return {
      events,
      module: defineEventModule({ namespace: "late", description: "", events }),
    };
  }

  it("cannot be swapped out after the module is frozen", () => {
    // The module, its handlers record and each wrapper are frozen — but the
    // *definition's* handler object is not, so a late-bound
    // `handler.apply(…)` would look it up again on every event and a
    // reassignment after `createRegistry` would change how a session folds.
    const { events, module } = mutableDefinition();
    const registry = createRegistry([module]);
    const summary = () =>
      reduce({
        cartridge: CARTRIDGE,
        seed: SEED,
        registry,
        events: [{ type: "late.call" }],
      }).transcript[0]?.summary;

    expect(summary()).toBe("original");
    events["late.call"].apply = () => ({ summary: "swapped" });
    expect(summary()).toBe("original");
  });

  it("keeps its receiver, so method shorthand still works", () => {
    // `const fn = handler.apply` would also fix the swap above while silently
    // dropping `this`. No handler in the repo uses it today; that is a fact
    // about today, not a property of the contract.
    const module = defineEventModule({
      namespace: "receiver",
      description: "",
      events: {
        "receiver.read": {
          version: 0,
          label: "from this",
          apply(): { summary: string } {
            return { summary: this.label };
          },
        } as EventHandlerDefinition<unknown> & { label: string },
      },
    });

    expect(
      reduce({
        cartridge: CARTRIDGE,
        seed: SEED,
        registry: createRegistry([module]),
        events: [{ type: "receiver.read" }],
      }).transcript[0]?.summary,
    ).toBe("from this");
  });
});
