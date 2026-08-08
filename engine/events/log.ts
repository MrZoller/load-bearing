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

import { deepFreeze } from "../freeze.js";
import { serialize } from "../serialize/canonical.js";
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
      : { payload: clonePayload(event.payload, where) }),
    version: handler.version,
  });

  return Object.freeze([...log, stamped]);
}

/**
 * Detach a payload from the caller, all the way down, and refuse one that is
 * not plain data.
 *
 * A one-level copy is not enough, and the gap is reachable rather than
 * theoretical: `probe.weighted` folds `payload.entries` straight into
 * `weightedPick`, so a caller keeping a reference to that array could change a
 * weight — or add an arm — after the event was appended, and the same log would
 * then fold to a different distribution. Deterministic replay of an
 * already-recorded log is exactly what that breaks.
 *
 * Two steps, because neither does the other's job:
 *
 * - **`structuredClone` detaches.** It copies by internal slot, so it cannot be
 *   fooled by a re-pointed prototype the way a prototype-reading copy would be.
 *   It is the engine's one allowlisted host global (`engine/globals.d.ts`).
 *   What it does *not* do is judge: it refuses functions, symbols and host
 *   objects, but it copies a `Date`, a `Map`, a `Set`, a `RegExp` and a typed
 *   array quite happily — and it *preserves* cycles rather than rejecting them.
 * - **The canonical serializer judges.** `serialize` is the exact predicate
 *   wanted here, because the requirement on a payload is precisely that it can
 *   be written to a fixture and read back. It rejects every built-in listed
 *   above, plus cycles, `NaN`, sparse arrays, accessors and symbol keys, and it
 *   names the offending path. Running it now moves that failure from record
 *   time — long after the event was accepted — to append time.
 *
 * Reusing `serialize` rather than reimplementing the predicate is the point.
 * The cartridge loader's `cloneJson` asks the same question, but as a
 * `Report`-accumulating walk built for reporting every cartridge issue at once;
 * its own brand check already defers to `detectBrand` in the serializer. This
 * takes the same authority one level further down, where it needs no
 * extraction.
 *
 * Freezing happens last and inside the guarded block, so it only ever runs on a
 * value the serializer has already vouched for — which is what makes
 * `deepFreeze`'s recursion safe here regardless of what arrived.
 *
 * This hardens **the append path only.** `reduce` and `step` take a raw
 * `readonly EngineEvent[]`, which is how a fixture and a decoded replay
 * permalink arrive, and those never pass through here. That is deliberate: the
 * fold must stay defined over a plain array of plain events. What it means is
 * that a caller who builds a log by hand still owns not mutating it, and the
 * golden replay suite is what checks that the engine does not.
 */
function clonePayload(
  payload: Readonly<Record<string, unknown>>,
  where: string,
): Readonly<Record<string, unknown>> {
  let copy: Record<string, unknown>;
  try {
    copy = structuredClone(payload) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(
      `${where}: "payload" holds a value that cannot be copied — a function, a symbol, or ` +
        `another host object. An event payload is plain data, because it has to survive ` +
        `being written to a fixture and read back.`,
      { cause },
    );
  }

  try {
    serialize(copy);
    return deepFreeze(copy);
  } catch (cause) {
    throw new Error(
      `${where}: "payload" is not plain data. It has to survive being written to a fixture ` +
        `and read back, so it may hold only null, booleans, finite numbers, strings, arrays ` +
        `and plain objects — no Date, Map, Set, RegExp or typed array, and nothing that ` +
        `contains itself. The cause below names the offending path.`,
      { cause },
    );
  }
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
