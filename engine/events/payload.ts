/**
 * Reading an event payload without trusting it.
 *
 * An event arrives from a fixture, a replay URL, or a UI layer that is not
 * written yet, so a payload is data of unknown shape even where the type system
 * says otherwise. Every handler in issues #5–#13 has to narrow one, and each
 * doing it by hand would be ten slightly different ideas of what "an integer"
 * means and ten error messages that do or do not say which event failed.
 *
 * Every message starts with `context.where` — `event 3 (vfs.write)` — because a
 * fixture has many events and one that says only "ms must be an integer" leaves
 * the reader to find it.
 */

import type { EventContext } from "./module.js";

/** An event payload, after it is known to be present. */
export type EventPayload = Readonly<Record<string, unknown>>;

/**
 * The payload of the event being folded.
 *
 * @throws when the event carries none. An event type that needs arguments and
 * did not get them is a malformed log, not a no-op.
 */
export function requirePayload(context: EventContext): EventPayload {
  const payload = context.event.payload;
  if (payload === undefined) {
    throw new Error(`${context.where}: this event type requires a payload`);
  }
  return payload;
}

export function readString(
  payload: EventPayload,
  key: string,
  where: string,
): string {
  const value = payload[key];
  if (typeof value !== "string") {
    throw new Error(
      `${where}: ${key} must be a string, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Bounds are required rather than optional. An unbounded integer from a payload
 * is a loop count, an allocation, or a clock advance with no ceiling, and every
 * call site that has needed one so far had a defensible limit available.
 */
export function readInteger(
  payload: EventPayload,
  key: string,
  low: number,
  high: number,
  where: string,
): number {
  const value = payload[key];
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < low ||
    value > high
  ) {
    throw new Error(
      `${where}: ${key} must be an integer in [${String(low)}, ${String(high)}], got ${JSON.stringify(value)}`,
    );
  }
  return value;
}
