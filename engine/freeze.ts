/**
 * Deep freezing, in one place.
 *
 * Three parts of the engine need the same guarantee for the same reason: a
 * value that several subsystems hold at once, and that none of them owns,
 * cannot be allowed to change under the others. The cartridge schema is the
 * validation authority; a loaded cartridge is the shared world every event
 * handler reads; both would be corrupted silently by a single stray
 * assignment, and `Object.freeze` alone stops only the outermost level.
 *
 * `as const` is a compile-time assertion and nothing more — a JavaScript
 * consumer, or a TypeScript one with a cast, walks straight past it. This is
 * the runtime half.
 */

/**
 * Freeze plain JSON-shaped data and everything reachable from it, returning the
 * same value.
 *
 * **Plain JSON-shaped, not everything.** Only objects whose prototype is
 * `Object.prototype`, `Array.prototype`, or null are walked; anything else is
 * refused. `Object.freeze` is defined in terms of properties, and a branded
 * built-in keeps its contents in internal slots — so `deepFreeze(new Map(…))`
 * returns an object reporting `isFrozen: true` whose `set`, `clear` and entries
 * all still work, which is a worse outcome than refusing it.
 *
 * A prototype test rather than a list of brands, and that is the whole reason
 * this is a single check: Map and Set are two members of an open set. `Date`
 * stays mutable through `setTime`, `RegExp` through `lastIndex`, a class
 * instance through its private fields — and a typed array does not survive
 * `Object.freeze` at all, throwing a bare `TypeError` out of an exported
 * function. A brand list closes the two that were noticed; the prototype test
 * refuses all of them with one question.
 *
 * Accessors are refused for the neighbouring reason: freezing cannot make a
 * getter inert, and every read of one can return a new mutable object, so a
 * frozen surface would sit over an interior that is never frozen. Descriptors
 * are read rather than properties, so no caller code runs during the walk.
 *
 * The three callers all pass values already known to be plain JSON — the
 * cartridge schema, a validated cartridge, and a payload that has been through
 * `deserialize(serialize(…))` — so this narrows what the function promises
 * rather than what it accepts today.
 *
 * ## What these two predicates do not cover
 *
 * They close brand hardening and accessor hardening. Two things remain outside
 * what this function can promise, and are stated rather than left to be found:
 *
 * - **A `Proxy` whose traps lie.** `deepFreeze` on one escapes as a raw
 *   `TypeError` from `preventExtensions`. No in-language check can detect a
 *   proxy — reflecting over one already runs its traps — which is why the
 *   purity gate's `proxy-reflection` rule stops engine code creating one at
 *   all, and why `engine/serialize/canonical.ts` documents the same stopping
 *   point.
 * - **Partial freezing on rejection.** This walks and mutates as it goes, so a
 *   value refused midway is left half-hardened. Both predicates above throw,
 *   and neither unwinds; a caller that needs all-or-nothing must validate
 *   before freezing rather than relying on the throw.
 *
 * `getOwnPropertyNames` rather than `Object.keys`, so a non-enumerable property
 * is frozen too — an unfrozen one would be a mutable interior hiding behind a
 * frozen surface, which is worse than an obviously mutable object. Symbol keys
 * are walked for the same reason and no other: no caller in this repository can
 * reach one, because `serialize` and the cartridge loader both refuse an own
 * symbol key before a value gets this far — but this function is exported and
 * promises *everything* reachable, and a caller holding the symbol would
 * otherwise hold a mutable interior.
 *
 * (`Reflect.ownKeys` is the one-call spelling and is unavailable: the purity
 * gate bans `Reflect` outright. The concatenation below is what
 * `engine/serialize/canonical.ts` uses for the same reason.)
 *
 * Functions are left alone: `typeof` sends them down the early return, which is
 * what the cartridge schema wants for its `refine` and `fill` callbacks.
 * Freezing a shared function object would reach outside the value being frozen.
 *
 * ## Cycles
 *
 * Tracked, so a value that contains itself terminates instead of exhausting the
 * stack. None of the callers in this repository can hand one over — a loaded
 * cartridge has been through `cloneJson`, an appended payload through the
 * canonical serializer, and the schema tree is written by hand — but this is
 * exported, and the next caller has no such guarantee. A `RangeError` with a
 * host-formatted stack is the worst possible way to learn that.
 *
 * Note that a cycle survives freezing rather than being rejected: this function
 * hardens a value, it does not judge it. Whether a value is *representable* is
 * the canonical serializer's question, and callers that need the answer ask it
 * there — see `clonePayload` in `engine/events/log.ts`.
 */
export function deepFreeze<T>(value: T): T {
  return freezeReachable(value, new WeakSet<object>());
}

function freezeReachable<T>(value: T, seen: WeakSet<object>): T {
  if (typeof value !== "object" || value === null) return value;

  const container = value as object;

  // One predicate, every brand at once. See the header: freezing a branded
  // built-in reports success and protects nothing, because its contents live in
  // internal slots rather than properties.
  const prototype: unknown = Object.getPrototypeOf(container);
  if (
    prototype !== Object.prototype &&
    prototype !== Array.prototype &&
    prototype !== null
  ) {
    throw new Error(
      "deepFreeze: only plain objects, arrays and null-prototype objects can be frozen all " +
        "the way down. This value keeps its contents in internal slots, where freezing its " +
        "properties would report success and protect nothing.",
    );
  }

  // Already visited on this walk: either a cycle, or a subobject reachable by
  // two paths. Both are done, and re-walking the second is how a wide DAG turns
  // an O(n) freeze into an exponential one.
  if (seen.has(container)) return value;
  seen.add(container);

  for (const key of [
    ...Object.getOwnPropertyNames(container),
    ...Object.getOwnPropertySymbols(container),
  ]) {
    // Descriptors, never `container[key]`. Reading a property runs an accessor,
    // which is caller code executing inside a walk whose whole job is to make a
    // value inert — and it achieves nothing, because a getter returns a fresh
    // object on every call: the one this walk froze is not the one the next
    // read returns, so the surface reports frozen over a permanently mutable
    // interior. This is the house idiom for the same reason in
    // `canonical.ts` (`ownProperties`, `canProbeByCloning`) and `load.ts`
    // (`describeNonDataObject`).
    const descriptor = Object.getOwnPropertyDescriptor(container, key);
    if (descriptor === undefined) continue;
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new Error(
        `deepFreeze: property ${String(key)} is an accessor. Freezing cannot make it inert — ` +
          "every read runs code and can return a new mutable object — so a frozen surface " +
          "would sit over an interior that is never frozen.",
      );
    }
    freezeReachable(descriptor.value, seen);
  }
  return Object.freeze(value);
}
