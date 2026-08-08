/**
 * The append-only event log.
 *
 * The log is the session's only input beyond the cartridge and the seed, so its
 * integrity is the determinism contract's first line: an event that cannot be
 * folded must be refused at the moment it is appended, not discovered halfway
 * through a replay when the transcript is already half written.
 *
 * "Append-only" is enforced by never handing back a mutable array.
 * `appendEvent` returns a new frozen log; there is no `remove` and no `replace`
 * because a session that can rewrite its own history has no replay contract at
 * all — a permalink would decode to a log the original session never ran.
 */

import { describeUnwritableText } from "../text.js";
import { ENGINE_EVENT_REGISTRY } from "./modules.js";
import type { EventRegistry } from "./registry.js";
import type { EngineEvent } from "./state.js";

/** The starting log. Frozen, so the empty case cannot be appended to in place. */
export const EMPTY_EVENT_LOG: readonly EngineEvent[] = Object.freeze([]);

/**
 * Check that a value is a well-formed event envelope.
 *
 * Envelope only: whether the *payload* makes sense is the owning handler's
 * question, and it cannot be asked without knowing the type. What this rejects
 * is the shapes that would break the fold itself — a type that is not a string,
 * a payload that is not a record, or a type carrying a line terminator, which
 * would render one event as several transcript lines and make the recorded
 * artifact unmatchable.
 *
 * `where` names the event: `event 3`, or `appended event`.
 */
export function assertEventEnvelope(event: unknown, where: string): void {
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    throw new Error(
      `${where}: an event must be an object with a string "type", got ${describe(event)}`,
    );
  }

  const type: unknown = (event as { type?: unknown }).type;
  if (typeof type !== "string" || type === "") {
    throw new Error(
      `${where}: "type" must be a non-empty string, got ${describe(type)}`,
    );
  }
  const problem = describeUnwritableText(type);
  if (problem !== undefined) {
    throw new Error(`${where}: "type" contains ${problem}`);
  }

  const payload: unknown = (event as { payload?: unknown }).payload;
  if (
    payload !== undefined &&
    (typeof payload !== "object" || payload === null || Array.isArray(payload))
  ) {
    throw new Error(
      `${where}: "payload" must be an object when present, got ${describe(payload)}`,
    );
  }

  const version: unknown = (event as { version?: unknown }).version;
  if (
    version !== undefined &&
    (typeof version !== "number" || !Number.isInteger(version) || version < 0)
  ) {
    throw new Error(
      `${where}: "version" must be a non-negative integer when present, got ${describe(version)}`,
    );
  }
}

/**
 * Append one event, returning a new log.
 *
 * The event is validated and its schema version stamped from the registry, so
 * a log produced through this function always says which payload schema it was
 * written against. A hand-authored fixture may leave `version` off — absent
 * means "current", which is the only thing it can mean for a log that has never
 * been stored.
 *
 * @throws when the envelope is malformed, or when nothing registers the type.
 * An event no module handles can never be folded, so accepting it into the log
 * would only move the failure somewhere less informative.
 */
export function appendEvent(
  log: readonly EngineEvent[],
  event: EngineEvent,
  registry: EventRegistry = ENGINE_EVENT_REGISTRY,
): readonly EngineEvent[] {
  const where = `appended event ${String(log.length)}`;
  assertEventEnvelope(event, where);

  const handler = registry.handler(event.type);
  if (handler === undefined) {
    throw new Error(
      `${where} (${event.type}): no registered module handles this event type. ` +
        `Registered namespaces: ${registry.namespaces.join(", ")}.`,
    );
  }
  if (event.version !== undefined && event.version !== handler.version) {
    throw new Error(
      `${where} (${event.type}): declares payload schema version ${String(event.version)}, ` +
        `but this engine implements version ${String(handler.version)}.`,
    );
  }

  const stamped: EngineEvent = Object.freeze({
    type: event.type,
    ...(event.payload === undefined
      ? {}
      : { payload: Object.freeze({ ...event.payload }) }),
    version: handler.version,
  });

  return Object.freeze([...log, stamped]);
}

/** A short, safe description of a bad value, for an error message. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string" || typeof value === "number") {
    return JSON.stringify(value);
  }
  return typeof value;
}
