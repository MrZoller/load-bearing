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

/** Thrown while building a registry. Always a programming error, never data. */
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
  // Sorted by namespace, so every listing this registry produces — error
  // messages, the slices record built at bootstrap, a debug dump — reads the
  // same whichever order the caller assembled the list in.
  const sorted = [...modules].sort((left, right) =>
    left.namespace < right.namespace
      ? -1
      : left.namespace > right.namespace
        ? 1
        : 0,
  );

  const byNamespace = new Map<string, EventModule>();
  const byType = new Map<string, RegisteredHandler>();

  for (const module of sorted) {
    if (!NAMESPACE_SHAPE.test(module.namespace)) {
      throw new EventRegistryError(
        `namespace ${JSON.stringify(module.namespace)} must match ${String(NAMESPACE_SHAPE)}. ` +
          `It is also a PRNG stream label and a key in serialized state, so anything ` +
          `needing escaping in either is a namespace that should be spelled differently.`,
      );
    }
    // Uniqueness of namespaces is what makes uniqueness of *types* free: every
    // type is prefixed with its module's namespace, so two modules can only
    // collide on a type if they collide on a namespace first.
    if (byNamespace.has(module.namespace)) {
      throw new EventRegistryError(
        `two modules claim the namespace ${JSON.stringify(module.namespace)}. A namespace ` +
          `owns an event-type prefix, a slice of session state, and a PRNG stream; ` +
          `sharing one would mean two subsystems overwriting each other's state.`,
      );
    }
    byNamespace.set(module.namespace, module);

    if (module.types.length === 0) {
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

      const handler = module.handlers[type];
      if (handler === undefined) {
        throw new EventRegistryError(
          `module ${JSON.stringify(module.namespace)} lists ${JSON.stringify(type)} but has no ` +
            `handler for it`,
        );
      }
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
      if (!Number.isInteger(handler.version) || handler.version < 0) {
        throw new EventRegistryError(
          `event type ${JSON.stringify(type)}: version must be a non-negative integer, got ` +
            `${String(handler.version)}`,
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
          version: handler.version,
          apply: handler.apply.bind(handler),
        }),
      );
    }
  }

  return Object.freeze({
    modules: Object.freeze(sorted),
    namespaces: Object.freeze([...byNamespace.keys()]),
    types: Object.freeze([...byType.keys()].sort()),
    handler: (type: string): RegisteredHandler | undefined => byType.get(type),
    module: (namespace: string): EventModule | undefined =>
      byNamespace.get(namespace),
  });
}
