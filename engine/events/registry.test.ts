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
  EventModuleDefinition,
  RegisteredHandler,
} from "./module.js";
import { reduce, restoreSnapshot, snapshot } from "./reduce.js";
import { EventRegistryError, createRegistry } from "./registry.js";
import { MAX_TRANSCRIPT_LINE_LENGTH } from "./transcript.js";
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

  it("builds that copy from the fields it captured, not later reads", () => {
    // The copy above is only as good as where its fields come from. Every one
    // is read once into a local before anything is validated against it, and
    // each is separately revertible: `description` and `stateful` are stored,
    // `initialSlice` and `validateSlice` are bound and later *called*, and
    // `handlers` is copied. Pinning the copy without pinning its sources left
    // all five silently reversible.
    const sound = counter("alpha");

    // Stored, and read back off the published module.
    let descriptionReads = 0;
    const described = createRegistry([
      {
        ...sound,
        get description(): string {
          descriptionReads += 1;
          return descriptionReads > 1 ? "LATER" : "counts alpha events";
        },
      } as EventModule,
    ]);
    expect(descriptionReads).toBe(1);
    expect(described.module("alpha")?.description).toBe("counts alpha events");

    // Stored, and load-bearing: the flag decides whether bootstrap gives the
    // module a key in `slices` at all, so a second read is a missing slice
    // rather than a wrong label.
    let statefulReads = 0;
    const flagged = createRegistry([
      {
        ...sound,
        get stateful(): boolean {
          statefulReads += 1;
          return statefulReads > 1 ? false : true;
        },
      } as EventModule,
    ]);
    expect(statefulReads).toBe(1);
    expect(flagged.module("alpha")?.stateful).toBe(true);
    expect(
      Object.keys(
        reduce({
          cartridge: CARTRIDGE,
          seed: SEED,
          registry: flagged,
          events: [],
        }).slices,
      ),
    ).toEqual(["alpha"]);

    // Bound, then called by `bootstrap` — so a second read seats a slice the
    // registry never checked was a function.
    let initialReads = 0;
    const seeded = createRegistry([
      {
        ...sound,
        get initialSlice(): EventModule["initialSlice"] {
          initialReads += 1;
          return initialReads > 1 ? () => 999 : () => 0;
        },
      } as EventModule,
    ]);
    expect(initialReads).toBe(1);
    expect(
      reduce({ cartridge: CARTRIDGE, seed: SEED, registry: seeded, events: [] })
        .slices["alpha"],
    ).toBe(0);
  });

  it("binds the validateSlice it captured, not a later read of it", () => {
    // The fourth module field, and the one whose output lands in restored
    // state. `validateSlice` is read once to decide whether the module has one
    // at all and again to bind, so a getter could answer the check with the
    // author's validator and hand the registry a different function — which
    // `restoreSnapshot` then runs against a recorded slice.
    const sound = defineEventModule<number>({
      namespace: "alpha",
      description: "counts alpha events",
      initialSlice: () => 0,
      validateSlice: (slice) => slice as number,
      events: {
        "alpha.bump": {
          version: 0,
          apply: (_context, slice) => ({ slice: slice + 1 }),
        },
      },
    });
    let reads = 0;
    const registry = createRegistry([
      {
        ...sound,
        get validateSlice(): EventModule["validateSlice"] {
          reads += 1;
          return reads > 1 ? () => 999 : (slice: unknown) => slice;
        },
      } as EventModule,
    ]);
    const text = snapshot(
      reduce({
        cartridge: CARTRIDGE,
        seed: SEED,
        registry,
        events: [{ type: "alpha.bump" }],
      }),
    );

    expect(reads).toBe(1);
    expect(registry.module("alpha")?.validateSlice?.(7, "w")).toBe(7);
    // And end to end: the identity validator it checked is the one that ran,
    // so the restored slice is the recorded one.
    expect(restoreSnapshot(text, registry).slices["alpha"]).toBe(1);
  });

  it("copies the handlers record it captured, not a later read of it", () => {
    // The fifth. `Object.freeze({...handlers})` is a shallow copy of the
    // caller's record, and reading the record a second time to make it means
    // the published record — the one `./module.ts` lists under "frozen and
    // copied, therefore safe" — describes handlers the registry never
    // validated, and `byType` is then built from those.
    const sound = counter("alpha");
    const real = sound.handlers["alpha.bump"] as RegisteredHandler;
    const swapped: RegisteredHandler = {
      ...real,
      apply: () => ({ summary: "LATER" }),
    };
    let reads = 0;
    const registry = createRegistry([
      {
        ...sound,
        get handlers(): EventModule["handlers"] {
          reads += 1;
          return reads > 1 ? { "alpha.bump": swapped } : sound.handlers;
        },
      } as EventModule,
    ]);

    expect(reads).toBe(1);
    expect(registry.modules[0]?.handlers["alpha.bump"]).toBe(real);
    expect(
      reduce({
        cartridge: CARTRIDGE,
        seed: SEED,
        registry,
        events: [{ type: "alpha.bump" }],
      }).transcript[0]?.summary,
    ).toMatch(/^n=1 draw=\d+$/);
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
        return reads > 1 ? -1 : 0;
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

  it("dispatches the apply it captured, not a later read of it", () => {
    // The other half of the pair — the source says `apply` and `version`
    // "complete the set", and only `version` was pinned. `apply` is read once
    // for the `typeof` guard and again to bind, so a getter answering the
    // guard with a function and the bind with a different one puts a function
    // nothing validated into the frozen copy dispatch actually calls. That is
    // strictly worse than the `version` case: the swapped function decides how
    // every event of this type folds, while every frozen surface still reports
    // the module as sealed.
    const sound = counter("alpha");
    const real = sound.handlers["alpha.bump"] as RegisteredHandler;
    let reads = 0;
    const shifty = {
      type: real.type,
      namespace: real.namespace,
      version: real.version,
      get apply(): RegisteredHandler["apply"] {
        reads += 1;
        return reads > 1 ? () => ({ summary: "LATER" }) : real.apply;
      },
    };
    const registry = createRegistry([
      { ...sound, handlers: { "alpha.bump": shifty } },
    ]);

    expect(reads).toBe(1);
    const folded = reduce({
      cartridge: CARTRIDGE,
      seed: SEED,
      registry,
      events: [{ type: "alpha.bump" }],
    });
    expect(folded.slices["alpha"]).toBe(1);
    expect(folded.transcript[0]?.summary).toMatch(/^n=1 draw=\d+$/);
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

describe("values derived from caller-owned data", () => {
  it("materializes the module list before deciding it is iterable", () => {
    // Reading `Symbol.iterator` to check it and then spreading reads it twice,
    // so a getter answering "function" once produced exactly the bare
    // `TypeError: modules is not iterable` that guard's own comment says it
    // exists to prevent.
    const sound = counter("alpha");
    let reads = 0;
    const shifty = {
      get [Symbol.iterator](): unknown {
        reads += 1;
        // A working iterator the first time, nothing the second.
        return reads > 1
          ? undefined
          : function* (): Generator<EventModule> {
              yield sound;
            };
      },
    };

    // One read, so the list materializes. Reading to check and reading to
    // spread threw `TypeError: modules is not iterable` right here.
    const registry = createRegistry(
      shifty as unknown as readonly EventModule[],
    );
    expect(registry.namespaces).toEqual(["alpha"]);
    expect(reads).toBe(1);
  });

  it("copies the declared types from the values it validated", () => {
    // The array `types` points at was validated element by element and then
    // spread again — capturing the reference is not capturing the contents.
    let reads = 0;
    const types: unknown[] = ["alpha.bump"];
    Object.defineProperty(types, 0, {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        return reads > 1 ? null : "alpha.bump";
      },
    });
    const sound = counter("alpha");
    const handBuilt = { ...sound, types } as unknown as EventModule;

    const registry = createRegistry([handBuilt]);
    expect(registry.types).toEqual(["alpha.bump"]);
    expect(registry.modules[0]?.types).toEqual(["alpha.bump"]);
  });

  it("enumerates a definition's events once, for handlers and for types", () => {
    // `Object.entries` for handlers and `Object.keys` for types walked the same
    // object twice, so a getter handed out one set of keys to each and
    // `createRegistry` then blamed the module for the front door's mismatch.
    let walks = 0;
    const backing: Record<string, EventHandlerDefinition<unknown>> = {
      "alpha.a": { version: 0, apply: () => ({}) },
      "alpha.b": { version: 0, apply: () => ({}) },
    };
    // A Proxy, because only an exotic object can report different own keys to
    // two walks — which is exactly what two walks made possible.
    const events = new Proxy(backing, {
      ownKeys: () => {
        walks += 1;
        return walks > 1 ? ["alpha.a", "alpha.b"] : ["alpha.a"];
      },
    });

    const module = defineEventModule({
      namespace: "alpha",
      description: "",
      events: events as unknown as Record<
        string,
        EventHandlerDefinition<unknown>
      >,
    });

    // Whatever the getters do, the handlers and the types come from one walk.
    expect(module.types).toEqual(Object.keys(module.handlers).sort());
    expect(() => createRegistry([module])).not.toThrow();
  });

  it("reads a definition's namespace once, for the module and its handlers", () => {
    let reads = 0;
    const module = defineEventModule({
      get namespace(): string {
        reads += 1;
        return reads > 1 ? "beta" : "alpha";
      },
      description: "",
      events: { "alpha.a": { version: 0, apply: () => ({}) } },
    } as unknown as EventModuleDefinition<unknown>);

    // The module and its handler agree, so no prefix error names a namespace
    // the author never wrote.
    expect(module.namespace).toBe("alpha");
    expect(module.handlers["alpha.a"]?.namespace).toBe("alpha");
    expect(() => createRegistry([module])).not.toThrow();
  });

  it("builds the module from the fields it captured, not later reads", () => {
    // `namespace` and the single enumeration above were pinned; the other four
    // fields `defineEventModule` takes off the caller's definition were not.
    // Each is separately revertible, so each gets its own definition here —
    // the shape `createRegistry`'s equivalent test already uses.

    // Stored, and read straight back off the module.
    let descriptionReads = 0;
    expect(
      defineEventModule({
        namespace: "alpha",
        get description(): string {
          descriptionReads += 1;
          return descriptionReads > 1 ? "LATER" : "counts alpha events";
        },
        events: { "alpha.a": { version: 0, apply: () => ({}) } },
      }).description,
    ).toBe("counts alpha events");
    expect(descriptionReads).toBe(1);

    // Checked for shape, then bound and later *called* by `bootstrap`, so a
    // second read seats a slice nothing checked was even a function.
    let initialReads = 0;
    const seeded = defineEventModule<number>({
      namespace: "alpha",
      description: "",
      get initialSlice(): () => number {
        initialReads += 1;
        return initialReads > 1 ? () => 999 : () => 1;
      },
      events: {
        "alpha.a": { version: 0, apply: (_context, slice) => ({ slice }) },
      },
    });
    expect(initialReads).toBe(1);
    expect(
      reduce({
        cartridge: CARTRIDGE,
        seed: SEED,
        registry: createRegistry([seeded]),
        events: [],
      }).slices["alpha"],
    ).toBe(1);

    // The same pair for the validator, whose output lands in restored state.
    let validateReads = 0;
    const validated = defineEventModule<number>({
      namespace: "alpha",
      description: "",
      initialSlice: () => 0,
      get validateSlice(): (slice: unknown) => number {
        validateReads += 1;
        return validateReads > 1
          ? () => 999
          : (slice: unknown) => slice as number;
      },
      events: { "alpha.a": { version: 0, apply: () => ({}) } },
    });
    expect(validateReads).toBe(1);
    expect(validated.validateSlice?.(7, "w")).toBe(7);

    // `events` is read once for the guard and everything after it reads the
    // capture. Re-reading past the check is the validate-then-use gap the
    // guard exists to close: the source's own example is a getter answering
    // the check with an object and the enumeration with `null`.
    let eventsReads = 0;
    const handler: EventHandlerDefinition<unknown> = {
      version: 0,
      apply: () => ({}),
    };
    const enumerated = defineEventModule({
      namespace: "alpha",
      description: "",
      get events(): Record<string, EventHandlerDefinition<unknown>> {
        eventsReads += 1;
        return eventsReads > 1
          ? { "alpha.later": handler }
          : { "alpha.declared": handler };
      },
    });
    expect(eventsReads).toBe(1);
    expect(enumerated.types).toEqual(["alpha.declared"]);
    expect(Object.keys(enumerated.handlers)).toEqual(["alpha.declared"]);
  });

  it("binds the apply it captured, not a later read of the definition's", () => {
    // The same shape as `createRegistry`'s handler `apply`, which is pinned —
    // and the sharper of the two, because this is the front door every module
    // in `./modules.ts` comes through. Read once for the `typeof` guard and
    // again to bind, a getter puts a function nothing validated behind an
    // event type, on a module every frozen surface reports as sealed.
    let reads = 0;
    const module = defineEventModule<number>({
      namespace: "alpha",
      description: "",
      initialSlice: () => 0,
      events: {
        "alpha.bump": {
          version: 0,
          get apply(): EventHandlerDefinition<number>["apply"] {
            reads += 1;
            return reads > 1
              ? () => ({ summary: "LATER" })
              : (_context, slice) => ({
                  slice: slice + 1,
                  summary: `n=${String(slice + 1)}`,
                });
          },
        },
      },
    });
    const folded = reduce({
      cartridge: CARTRIDGE,
      seed: SEED,
      registry: createRegistry([module]),
      events: [{ type: "alpha.bump" }],
    });

    expect(reads).toBe(1);
    expect(folded.slices["alpha"]).toBe(1);
    expect(folded.transcript[0]?.summary).toBe("n=1");
  });

  it("registers the type list it captured, not a later read of it", () => {
    // The neighbour above pins the array's *contents*; this pins the read of
    // the property itself. `declared.types` is checked with `Array.isArray`
    // and then walked, so a getter could show an array to the check and hand
    // the walk a different list — registering event types the module never
    // declared, under a module the registry reports as validated.
    let reads = 0;
    const sound = counter("alpha");
    const registry = createRegistry([
      {
        ...sound,
        get types(): readonly string[] {
          reads += 1;
          return reads > 1 ? ["alpha.LATER"] : ["alpha.bump"];
        },
      } as EventModule,
    ]);

    expect(reads).toBe(1);
    expect(registry.types).toEqual(["alpha.bump"]);
    expect(registry.modules[0]?.types).toEqual(["alpha.bump"]);
  });

  it("accepts a handler whose own type and namespace are read once", () => {
    // The other direction of "names the value that failed" below, and the one
    // that matters more: there the comparison passes and only the message is
    // wrong, here a second read makes a perfectly sound module *fail to
    // register*. Each getter answers the truth first and something else after,
    // so a registry that re-read either field would refuse a module the author
    // wrote correctly.
    const sound = counter("alpha");
    const real = sound.handlers["alpha.bump"] as RegisteredHandler;
    const shiftyField = (field: "type" | "namespace", first: string) => {
      let reads = 0;
      return createRegistry([
        {
          ...sound,
          handlers: {
            "alpha.bump": {
              ...real,
              get [field](): string {
                reads += 1;
                return reads > 1 ? "LATER" : first;
              },
            },
          },
        } as unknown as EventModule,
      ]);
    };

    expect(shiftyField("type", "alpha.bump").types).toEqual(["alpha.bump"]);
    expect(shiftyField("namespace", "alpha").namespaces).toEqual(["alpha"]);
  });

  it("names the version it refused, not a later read of it", () => {
    // `version` is captured and the frozen copy is built from the capture —
    // that half is pinned. The message is the other half, and diagnostics are
    // inside this family rather than a lesser cousin of it: an error naming a
    // number that was never the one that failed sends its reader to the wrong
    // line of the wrong module.
    const sound = counter("alpha");
    const real = sound.handlers["alpha.bump"] as RegisteredHandler;
    let reads = 0;

    expect(() =>
      createRegistry([
        {
          ...sound,
          handlers: {
            "alpha.bump": {
              ...real,
              get version(): number {
                reads += 1;
                return reads > 1 ? 7 : -1;
              },
            },
          },
        } as unknown as EventModule,
      ]),
    ).toThrow(/version must be a non-negative integer, got -1/);
  });

  it("names the value that failed, not a later read of it", () => {
    // `module.handlers[type]` is the caller's handler object, and `type` and
    // `namespace` were read once for the comparison and again to build the
    // message — so the error named a value that was never the one that failed.
    // Label-only divergence, and the same class closed in `log.ts`: a known
    // member left inside a family declared closed is how the next one arrives.
    const sound = counter("alpha");
    const real = sound.handlers["alpha.bump"] as RegisteredHandler;
    const shiftyField = (field: "type" | "namespace", second: string) => {
      let reads = 0;
      return createRegistry.bind(null, [
        {
          ...sound,
          handlers: {
            "alpha.bump": {
              ...real,
              get [field](): string {
                reads += 1;
                return reads > 1 ? second : "alpha.declared";
              },
            },
          },
        } as unknown as EventModule,
      ]);
    };

    expect(shiftyField("type", "alpha.LATER")).toThrow(
      /that calls itself "alpha\.declared"/,
    );
    expect(shiftyField("namespace", "LATER")).toThrow(
      /claims namespace "alpha\.declared"/,
    );
  });

  it("refuses an event type longer than a stored transcript line", () => {
    // Bounded at registry construction for the diagnostic — a startup failure
    // naming the module beats a mid-fold throw — and in `makeEntry` for the
    // property, since a hand-built registry reaches `step` without passing
    // through here.
    const long = `alpha.${"a".repeat(MAX_TRANSCRIPT_LINE_LENGTH)}`;

    expect(() =>
      createRegistry([
        defineEventModule({
          namespace: "alpha",
          description: "",
          events: { [long]: { version: 0, apply: () => ({}) } },
        }),
      ]),
    ).toThrow(/over the 4096 a stored transcript line may hold/);
  });

  it("requires types to be listed once each and sorted", () => {
    // Three properties of one documented sentence — both directions of set
    // equality, uniqueness, and order — compared against one canonical form,
    // with the two set-mismatch messages kept distinct.
    const sound = counter("alpha");
    const real = sound.handlers["alpha.bump"] as RegisteredHandler;
    const withTypes = (types: readonly string[]) => () =>
      createRegistry([{ ...sound, types } as unknown as EventModule]);

    expect(withTypes(["alpha.bump", "alpha.bump"])).toThrow(
      /listed once each and in sorted order/,
    );
    expect(withTypes(["alpha.bump", "alpha.other"])).toThrow(
      /lists "alpha\.other" but has no handler for it/,
    );
    expect(() =>
      createRegistry([
        {
          ...sound,
          types: ["alpha.bump"],
          handlers: {
            "alpha.bump": real,
            "alpha.other": { ...real, type: "alpha.other" },
          },
        } as unknown as EventModule,
      ]),
    ).toThrow(/has handler\(s\) for alpha\.other that its types do not list/);

    // A pair that a degenerate comparison would call equal. Concatenated with
    // no separator both sides read "alpha.aalpha.aalpha.ab", so a joined
    // comparison is only as strong as the separator it picks — and at this
    // point the elements are known to be strings and nothing else, so no
    // character is provably safe. Element-wise rests on nothing.
    //
    // The exact strength of this pin: it fails against `join("")` and would
    // still pass against a separator no type contains. That is the intended
    // reach — with the comparison element-wise there is no join left to
    // degrade, so reintroducing one would be a visible rewrite rather than a
    // silent edit.
    const collide = defineEventModule({
      namespace: "alpha",
      description: "",
      events: {
        "alpha.a": { version: 0, apply: () => ({}) },
        "alpha.aalpha.ab": { version: 0, apply: () => ({}) },
      },
    });
    expect(() =>
      createRegistry([
        {
          ...collide,
          types: ["alpha.aalpha.a", "alpha.ab"],
        } as unknown as EventModule,
      ]),
    ).toThrow(/has handler\(s\) for/);

    // Unsorted, with both lists otherwise agreeing.
    const two = defineEventModule({
      namespace: "alpha",
      description: "",
      events: {
        "alpha.aaa": { version: 0, apply: () => ({}) },
        "alpha.bbb": { version: 0, apply: () => ({}) },
      },
    });
    expect(() =>
      createRegistry([
        { ...two, types: ["alpha.bbb", "alpha.aaa"] } as unknown as EventModule,
      ]),
    ).toThrow(/listed once each and in sorted order/);
    expect(() => createRegistry([two])).not.toThrow();
  });
});
