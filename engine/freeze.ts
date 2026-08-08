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
 * Freeze `value` and everything reachable from it, returning the same value.
 *
 * `getOwnPropertyNames` rather than `Object.keys`, so a non-enumerable property
 * is frozen too — an unfrozen one would be a mutable interior hiding behind a
 * frozen surface, which is worse than an obviously mutable object.
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
  // Already visited on this walk: either a cycle, or a subobject reachable by
  // two paths. Both are done, and re-walking the second is how a wide DAG turns
  // an O(n) freeze into an exponential one.
  if (seen.has(container)) return value;
  seen.add(container);

  for (const key of Object.getOwnPropertyNames(container)) {
    freezeReachable((container as Record<string, unknown>)[key], seen);
  }
  return Object.freeze(value);
}
