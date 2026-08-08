/**
 * The event registry: a set of modules, checked once and then read-only.
 *
 * Building it is where every rule the extension point relies on is enforced,
 * and it happens once at module load rather than per event — so a namespace
 * collision is a startup failure with both offenders named, not a mystery in
 * the middle of a replay.
 *
 * The registry is a value, not a global side effect. `registerEvent()` calls at
 * import time would make the engine's behaviour depend on which modules
 * happened to be imported, and in what order — the same class of bug the seeded
 * PRNG's named streams exist to avoid. Here the list is explicit
 * (`./modules.ts`), a test can build a different one, and two lists in
 * different orders produce registries that answer identically.
 *
 * Everything this function returns is a frozen copy rather than the caller's
 * object, because `EventModule` is an interface a caller can satisfy by hand
 * and this function spends its whole length validating one. `./module.ts` →
 * "What this layer enforces, and what it cannot" is the full account of that
 * boundary; the comments below give the per-check reasoning.
 */

import type { EventModule, RegisteredHandler } from "./module.js";

/**
 * A namespace is one lowercase word.
 *
 * No dot, because the namespace is the part of an event type *before* the first
 * dot and a dotted namespace would make `a.b.c` ambiguous. No uppercase and no
 * underscore, because the same word is a PRNG stream label
 * (`engine/random/stream.ts` pins that spelling) and a key in serialized state.
 */
const NAMESPACE_SHAPE = /^[a-z][a-z0-9-]*$/;

/**
 * The part of an event type after the namespace. Dots are allowed here so a
 * subsystem can group its own types (`git.branch.create`).
 */
const EVENT_NAME_SHAPE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;

/**
 * Thrown while building a module or a registry. Always a programming error,
 * never data — a cartridge cannot reach this, only engine or subsystem code can.
 */
export class EventRegistryError extends Error {
  constructor(detail: string) {
    super(`event registry: ${detail}`);
    this.name = "EventRegistryError";
  }
}

export interface EventRegistry {
  /** Every module, sorted by namespace. */
  readonly modules: readonly EventModule[];
  /** Every namespace, sorted. */
  readonly namespaces: readonly string[];
  /** Every registered event type, sorted. */
  readonly types: readonly string[];
  /** The handler for `type`, or `undefined` — the caller decides how to fail. */
  handler(type: string): RegisteredHandler | undefined;
  module(namespace: string): EventModule | undefined;
}

/**
 * Compose modules into a registry.
 *
 * @throws EventRegistryError if any module is malformed or two collide.
 */
export function createRegistry(modules: readonly EventModule[]): EventRegistry {
  // The argument itself, before the loop that reads it. `createRegistry` is
  // exported, so a caller can hand it anything; a non-iterable would otherwise
  // throw a bare TypeError out of `for…of` — the one rough edge left after
  // every field on a hand-built module gained a named guard.
  const candidateModules: unknown = modules;
  if (
    candidateModules === null ||
    candidateModules === undefined ||
    typeof (candidateModules as Iterable<unknown>)[Symbol.iterator] !==
      "function"
  ) {
    throw new EventRegistryError(
      `the module list must be iterable, got ${candidateModules === null ? "null" : typeof candidateModules}`,
    );
  }

  // Entry shape before anything else, because the sort below orders by
  // `namespace` — so a module that is not an object, or whose namespace is not
  // a string, would throw out of `sort` before a single check could name it.
  //
  // Decorate-sort-undecorate: the namespace is *captured* here and everything
  // afterwards uses the capture. A comparator re-reading `entry.namespace`
  // would read it a second time and the main loop a third, so a getter could
  // pass this check, throw a bare TypeError inside `sort`, or — worse — sort
  // under one value and register under another. This file's own rule, stated
  // where the module fields are captured below, is that every field is read
  // exactly once before anything is validated against it; `namespace` is the
  // field that has to prove it first.
  const decorated = [...modules].map((entry) => {
    const candidate: unknown = entry;
    if (typeof candidate !== "object" || candidate === null) {
      throw new EventRegistryError(
        `a module must be an object, got ${typeof candidate === "object" ? "null" : typeof candidate}`,
      );
    }
    const namespace: unknown = (candidate as EventModule).namespace;
    if (typeof namespace !== "string") {
      throw new EventRegistryError(
        `a module's namespace must be a string, got ${typeof namespace}. It is read before ` +
          `anything else here, because it is what the module list is sorted by.`,
      );
    }
    return { namespace, declared: candidate as EventModule };
  });

  // Sorted by namespace, so every listing this registry produces — error
  // messages, the slices record built at bootstrap, a debug dump — reads the
  // same whichever order the caller assembled the list in.
  const sorted = decorated.sort((left, right) =>
    left.namespace < right.namespace
      ? -1
      : left.namespace > right.namespace
        ? 1
        : 0,
  );

  const byNamespace = new Map<string, EventModule>();
  const byType = new Map<string, RegisteredHandler>();

  const registered: EventModule[] = [];

  for (const { namespace, declared } of sorted) {
    // Every field read exactly once, into a local, before anything is validated
    // against it. A hand-built `EventModule` can define these as getters, and
    // validating one value while storing another is the same hazard
    // `assertEventEnvelope` closes for the event envelope. `namespace` was
    // captured above, before the sort, and is not re-read here.
    //
    // The discipline covers reads of `declared`, which is the caller's object.
    // Everything after the frozen copy is built re-reads *that* — `module.types`,
    // `module.handlers`, `module.namespace` in messages — which is safe for the
    // opposite reason: it is the engine's own value and cannot change under it.
    // Two different guarantees, and only the first one needs the discipline.
    const description = declared.description;
    const stateful = declared.stateful;
    const declaredList: unknown = declared.types;
    const handlers = declared.handlers;
    const validateSlice = declared.validateSlice;
    const initialSlice = declared.initialSlice;

    // Checked before the spread, which is what would throw on a non-iterable,
    // and before the element loop below, where `type.startsWith` would throw on
    // anything that is not a string.
    if (!Array.isArray(declaredList)) {
      throw new EventRegistryError(
        `module ${JSON.stringify(namespace)} must declare its types as an array, got ` +
          `${typeof declaredList}`,
      );
    }
    for (const type of declaredList as readonly unknown[]) {
      if (typeof type !== "string") {
        throw new EventRegistryError(
          `module ${JSON.stringify(namespace)} declares a type that is not a string, got ` +
            `${typeof type}. Event types appear verbatim in recorded transcripts.`,
        );
      }
    }
    const types = Object.freeze([...(declaredList as readonly string[])]);

    if (!NAMESPACE_SHAPE.test(namespace)) {
      throw new EventRegistryError(
        `namespace ${JSON.stringify(namespace)} must match ${String(NAMESPACE_SHAPE)}. ` +
          `It is also a PRNG stream label and a key in serialized state, so anything ` +
          `needing escaping in either is a namespace that should be spelled differently.`,
      );
    }
    // Uniqueness of namespaces is what makes uniqueness of *types* free: every
    // type is prefixed with its module's namespace, so two modules can only
    // collide on a type if they collide on a namespace first.
    if (byNamespace.has(namespace)) {
      throw new EventRegistryError(
        `two modules claim the namespace ${JSON.stringify(namespace)}. A namespace ` +
          `owns an event-type prefix, a slice of session state, and a PRNG stream; ` +
          `sharing one would mean two subsystems overwriting each other's state.`,
      );
    }
    // Required by the interface, but the interface is one a caller can satisfy
    // by hand — and binding a missing one below would throw a bare TypeError
    // out of registry construction instead of saying what is wrong.
    if (typeof validateSlice !== "function" && validateSlice !== undefined) {
      throw new EventRegistryError(
        `module ${JSON.stringify(namespace)} has a validateSlice that is not a function, got ` +
          `${typeof validateSlice}. Omit it entirely for a module that does not validate its slice.`,
      );
    }
    if (typeof initialSlice !== "function") {
      throw new EventRegistryError(
        `module ${JSON.stringify(namespace)} has no initialSlice function. A module with no ` +
          `state returns undefined from it; omitting it entirely leaves nothing to call.`,
      );
    }

    // Stored as a frozen copy, exactly as handlers are below, and for the same
    // reason: `createRegistry` spends this whole function validating a
    // hand-built module, and holding the caller's object afterwards would let
    // every one of those checks be undone after it passed. Swapping
    // `initialSlice` post-registration rewrote a bootstrap slice; swapping
    // `namespace` re-forked the PRNG stream; setting `stateful` false made
    // `step` throw.
    //
    // So `registry.modules[i]` is a copy, like `registry.handler(t)` — and the
    // `handlers` record is a frozen copy too. An earlier version left it as the
    // module's own on the grounds that dispatch never reads it (that goes
    // through `byType`), which was true and still made the standing answer in
    // `./module.ts` false: a hand-built module could add `alpha.late` to
    // `registry.modules[0].handlers` after registration, so a record the engine
    // presents as its own would list a type it will not dispatch. Copying costs
    // one shallow object per module and makes "frozen and copied, therefore
    // safe" simply true of the whole value.
    //
    // Shallow, deliberately: the handler objects inside are the module's own,
    // and freezing those is the `EventHandlerDefinition` case that was
    // considered and rejected. Nothing reads them — `byType` holds the frozen
    // bound copies dispatch uses — so what they contain cannot affect a fold.
    const module: EventModule = Object.freeze({
      namespace,
      description,
      stateful,
      initialSlice: initialSlice.bind(declared),
      ...(validateSlice === undefined
        ? {}
        : { validateSlice: validateSlice.bind(declared) }),
      types,
      handlers: Object.freeze({ ...handlers }),
    });
    byNamespace.set(namespace, module);
    registered.push(module);

    if (types.length === 0) {
      throw new EventRegistryError(
        `module ${JSON.stringify(module.namespace)} registers no event types. An empty ` +
          `module is either an unfinished subsystem or a stale entry in the module list.`,
      );
    }
    // A slice validator on a module with no slice would never run, and its
    // author would believe their snapshot was being checked. Refusing is
    // cheaper than a hook that silently does nothing.
    if (!module.stateful && module.validateSlice !== undefined) {
      throw new EventRegistryError(
        `module ${JSON.stringify(module.namespace)} declares validateSlice but no initialSlice, ` +
          `so it holds no slice for a snapshot to carry and the validator could never run.`,
      );
    }

    // The other direction of the pair checked below ("lists X but has no
    // handler for it"). A handler present in the record but missing from
    // `types` is never registered, so `registry.handler(t)` is undefined while
    // `registry.modules[i].handlers` still lists it — an event type that
    // appears to exist and cannot be dispatched. Checking one direction and not
    // the other is a stranger end state than checking both.
    const declaredTypes = new Set(module.types);
    const unlisted = Object.keys(module.handlers)
      .filter((type) => !declaredTypes.has(type))
      .sort();
    if (unlisted.length > 0) {
      throw new EventRegistryError(
        `module ${JSON.stringify(namespace)} has handler(s) for ${unlisted.join(", ")} that its ` +
          `types do not list. An unlisted handler is never registered, so the event type would ` +
          `look declared and fail to dispatch.`,
      );
    }

    for (const type of module.types) {
      const prefix = `${module.namespace}.`;
      if (!type.startsWith(prefix)) {
        throw new EventRegistryError(
          `module ${JSON.stringify(module.namespace)} registers ${JSON.stringify(type)}, which ` +
            `does not start with ${JSON.stringify(prefix)}. A module owns exactly the types ` +
            `under its own namespace; that is what stops two subsystems colliding.`,
        );
      }
      if (!EVENT_NAME_SHAPE.test(type.slice(prefix.length))) {
        throw new EventRegistryError(
          `event type ${JSON.stringify(type)}: the part after the namespace must match ` +
            `${String(EVENT_NAME_SHAPE)}. Event types appear verbatim in recorded ` +
            `transcripts and in replay URLs.`,
        );
      }

      // `undefined` and `null` are exactly the two values that throw on
      // property access — every other wrong type yields `undefined` for `.type`
      // and lands in a named error below — and the `=== undefined` check alone
      // let `null` through to `handler.type` and a bare TypeError.
      //
      // The `unknown` local is a readability choice, matching how the module
      // fields above are captured; the compiler is happy either way.
      const candidate: unknown = module.handlers[type];
      if (candidate === undefined || candidate === null) {
        throw new EventRegistryError(
          `module ${JSON.stringify(module.namespace)} lists ${JSON.stringify(type)} but has no ` +
            `handler for it, got ${candidate === null ? "null" : "nothing"}`,
        );
      }
      const handler = candidate as RegisteredHandler;
      // A handler carries its own `type` and `namespace`, and `step` trusts
      // both: it looks the handler up by type and then finds the module by
      // `handler.namespace`. `defineEventModule` always fills them correctly,
      // but `EventModule` is a plain interface a caller can satisfy by hand, and
      // a mismatch here surfaces much later as a `TypeError` on an undefined
      // module — with nothing pointing back at the module that was malformed.
      // These two lines are what make the comment in `reduce.ts` ("present by
      // construction") true rather than merely intended.
      if (handler.type !== type) {
        throw new EventRegistryError(
          `module ${JSON.stringify(module.namespace)} files a handler under ${JSON.stringify(type)} ` +
            `that calls itself ${JSON.stringify(handler.type)}. The key and the handler's own type ` +
            `must agree; dispatch uses one and diagnostics use the other.`,
        );
      }
      if (handler.namespace !== module.namespace) {
        throw new EventRegistryError(
          `handler ${JSON.stringify(type)} claims namespace ${JSON.stringify(handler.namespace)} but ` +
            `belongs to module ${JSON.stringify(module.namespace)}. The reducer finds a handler's ` +
            `module — and therefore its state slice and its PRNG stream — through that name.`,
        );
      }
      // Captured before it is checked, like the module fields above — and this
      // is the one handler field that was not. `type` comes from the loop key
      // and `namespace` from the already-copied module, but `version` was read
      // once to validate and again to store, so a getter could pass the check
      // and then land `-1` in the frozen copy. `appendEvent` stamps from that
      // copy, producing a log entry the reducer's own `assertEventEnvelope`
      // then refuses: two engine components disagreeing about the same event.
      // The same rough edge as `initialSlice` above, and the last one: binding
      // a missing `apply` below throws a bare TypeError out of registry
      // construction, naming neither the module nor the type.
      const apply = handler.apply;
      if (typeof apply !== "function") {
        throw new EventRegistryError(
          `handler ${JSON.stringify(type)} has no apply function, got ${typeof apply}. A handler ` +
            `that cannot be called is an event type that cannot be folded.`,
        );
      }
      const version = handler.version;
      if (!Number.isInteger(version) || version < 0) {
        throw new EventRegistryError(
          `event type ${JSON.stringify(type)}: version must be a non-negative integer, got ` +
            `${String(version)}`,
        );
      }
      // Stored as a frozen copy, not by reference. `EventModule` is a plain
      // interface, so a hand-built one can supply a mutable `RegisteredHandler`
      // — and reassigning its `apply` after registration changes how a session
      // folds while every frozen surface still reports the module as sealed.
      //
      // `defineEventModule` already closes that door for modules built through
      // it, and says so; this is the one door left open, which made the
      // guarantee true of the front entrance and not the building. Note this is
      // *not* the same as freezing an `EventHandlerDefinition`, which was
      // considered and rejected: that would freeze an object the caller owns to
      // stop a handler mutating its own receiver — a class of divergence a
      // shallow freeze cannot close anyway, since a closure or a module-level
      // binding does it just as well. Here the registry builds its own object
      // and touches nothing of the caller's, and the mutation being stopped is
      // the dispatched function being swapped out from under it.
      //
      // A consequence worth knowing: `registry.modules[i].handlers[t]` is now a
      // different object from `registry.handler(t)`. Dispatch only ever uses
      // the latter, and the former stays as the module declared it.
      byType.set(
        type,
        Object.freeze({
          type,
          namespace: module.namespace,
          version,
          apply: apply.bind(handler),
        }),
      );
    }
  }

  return Object.freeze({
    // The frozen copies, not the caller's objects — see the comment above them.
    modules: Object.freeze(registered),
    namespaces: Object.freeze([...byNamespace.keys()]),
    types: Object.freeze([...byType.keys()].sort()),
    handler: (type: string): RegisteredHandler | undefined => byType.get(type),
    module: (namespace: string): EventModule | undefined =>
      byNamespace.get(namespace),
  });
}
