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
      if (!Number.isInteger(handler.version) || handler.version < 0) {
        throw new EventRegistryError(
          `event type ${JSON.stringify(type)}: version must be a non-negative integer, got ` +
            `${String(handler.version)}`,
        );
      }
      byType.set(type, handler);
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
