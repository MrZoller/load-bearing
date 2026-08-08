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
 *
 * ## What `appendEvent` owns, and what it does not
 *
 * The event being appended is the one thing this module takes ownership of: it
 * is validated, canonicalized, detached and frozen, because the call is the
 * moment it stops being the caller's and starts being history.
 *
 * **Prior entries stay the caller's.** `appendEvent` copies the array, not the
 * entries in it, so a caller holding an entry it passed in earlier can still
 * mutate it. That is not a capability this function grants — those objects were
 * the caller's before the call, and mutating them a moment earlier has exactly
 * the same effect — which is what distinguishes it from the newly appended
 * event, where this genuinely is the ownership-transfer point. Deep-cloning the
 * history on every append would be quadratic, and a shallow per-entry freeze
 * would be O(n) per append, would freeze objects the caller owns, and would
 * still leave nested payloads open.
 *
 * The invariant that does hold, and the one to rely on: **a log grown entirely
 * from `EMPTY_EVENT_LOG` through `appendEvent` has every entry frozen and every
 * payload canonicalized, detached and frozen.** Mix in an entry from anywhere
 * else and that is the caller's to maintain.
 */

import { deepFreeze } from "../freeze.js";
import { deserialize, serialize } from "../serialize/canonical.js";
import { describeUnwritableText } from "../text.js";
import { ENGINE_EVENT_REGISTRY } from "./modules.js";
import type { EventRegistry } from "./registry.js";
import type { EngineEvent } from "./state.js";

/** The starting log. Frozen, so the empty case cannot be appended to in place. */
export const EMPTY_EVENT_LOG: readonly EngineEvent[] = Object.freeze([]);

/**
 * Check that a value is a well-formed event envelope, and **return the captured
 * envelope its caller must use from then on**.
 *
 * Envelope only: whether the *payload* makes sense is the owning handler's
 * question, and it cannot be asked without knowing the type. What this rejects
 * is the shapes that would break the fold itself — a type that is not a string,
 * a payload that is not a record, or a type carrying a line terminator, which
 * would render one event as several transcript lines and make the recorded
 * artifact unmatchable.
 *
 * ## Why it returns rather than only asserting
 *
 * An event arrives from a caller, and `type` can be a getter. Validating the
 * value and then letting `appendEvent` and `step` each re-read `event.type` four
 * more times means the string that was checked and the string that is used need
 * not be the same one: a getter that changes on its third read gets a newline
 * into `TranscriptEntry.type` — past `describeUnwritableText`, past the handler
 * lookup — and `renderTranscript` then emits a forged extra line, breaking its
 * one-string-per-line contract. The same trick stamps an unregistered type into
 * a log that `appendEvent` had just refused unregistered types on principle.
 *
 * So every field is read exactly once, here, and the frozen result is what the
 * rest of the fold sees — including `EventContext.event`. Inspecting descriptors
 * instead would not do: `Object.getOwnPropertyDescriptor` returns `undefined`
 * for a getter inherited from a prototype, so the check would pass and the
 * re-reads would still be live.
 *
 * `payload` is captured by reference, deliberately: `appendEvent` hands it to
 * `clonePayload`, where the canonical serializer refuses an accessor outright,
 * and `step`'s raw path is documented as the caller's to keep still. `version`
 * is stamped from the registry, never from the envelope.
 *
 * `where` names the event: `event 3`, or `appended event`.
 */
export function assertEventEnvelope(
  event: unknown,
  where: string,
): EngineEvent {
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

  // Built from the locals above, each read exactly once. Frozen, and with the
  // optional fields omitted rather than set to `undefined`, so the captured
  // envelope serializes and compares like the event it stands for.
  return Object.freeze({
    type,
    // The check above narrows to `object`, which is not an index signature.
    // Nothing further is asserted here: whether the *contents* are usable is
    // the owning handler's question, and `clonePayload` is what refuses a
    // payload that could never be recorded.
    ...(payload === undefined
      ? {}
      : { payload: payload as Readonly<Record<string, unknown>> }),
    ...(version === undefined ? {} : { version }),
  });
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
  // Captured once. Everything below reads the envelope, never `event` again —
  // see `assertEventEnvelope` for what re-reading a getter would buy a caller.
  const envelope = assertEventEnvelope(event, where);

  const handler = registry.handler(envelope.type);
  if (handler === undefined) {
    throw new Error(
      `${where} (${envelope.type}): no registered module handles this event type. ` +
        `Registered namespaces: ${registry.namespaces.join(", ")}.`,
    );
  }
  if (envelope.version !== undefined && envelope.version !== handler.version) {
    throw new Error(
      `${where} (${envelope.type}): declares payload schema version ${String(envelope.version)}, ` +
        `but this engine implements version ${String(handler.version)}.`,
    );
  }

  const stamped: EngineEvent = Object.freeze({
    type: envelope.type,
    ...(envelope.payload === undefined
      ? {}
      : { payload: clonePayload(envelope.payload, where) }),
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
 * Three steps, in this order, and the order is the whole design:
 *
 * 1. **`serialize` judges the original.** It is the exact predicate wanted here,
 *    because the requirement on a payload is precisely that it can be written
 *    to a fixture and read back. It rejects `Date`, `Map`, `Set`, `RegExp` and
 *    typed arrays, plus cycles, `NaN`, sparse arrays, symbol keys, accessors
 *    and non-enumerable properties, and it names the offending path.
 * 2. **`deserialize` detaches**, by reading that output back. `JSON.parse`
 *    builds every object fresh, so nothing of the caller's graph survives —
 *    and what it builds is the *canonical* form rather than a faithful copy,
 *    which is the point of the section below.
 * 3. **`deepFreeze` hardens** what is by then known to be finite, acyclic plain
 *    data — which is what makes its recursion safe here regardless of what
 *    arrived.
 *
 * **Judging the original rather than a copy is load-bearing.** Copying first
 * hides exactly the properties the serializer exists to refuse: a structural
 * copy silently drops a non-enumerable property and a symbol-keyed one, and it
 * *invokes* an enumerable getter and stores the result. So the copy looks like
 * clean data and the original never gets examined — a payload whose author
 * believes a field is in effect appends without it, and an accessor runs during
 * append in a module whose sibling (`engine/serialize/canonical.ts`) goes to
 * considerable lengths never to run one. `serialize` reads descriptors instead
 * of properties, so it refuses an accessor without calling it.
 *
 * Reusing `serialize` rather than reimplementing the predicate is the point.
 * The cartridge loader's `cloneJson` asks the same question, but as a
 * `Report`-accumulating walk built for reporting every cartridge issue at once;
 * its own brand check already defers to `detectBrand` in the serializer. This
 * takes the same authority one level further down, where it needs no
 * extraction.
 *
 * ## Why the stored payload is the serializer's own output
 *
 * `serialize` does not only judge — it *normalizes*, and the difference is a
 * determinism bug rather than a nicety. A structural copy faithfully preserves
 * everything the canonical form flattens: `JSON.parse('{"b":1,"a":2}')` keeps
 * insertion order `b, a`, `-0` stays distinguishable from `0`, and two
 * properties pointing at one object stay aliased. All three are reachable from
 * `JSON.parse`-able input alone — no getter, no hand-built object.
 *
 * So a handler reading `Object.keys(payload)` sees `b, a` in the live session
 * and `a, b` when the same log is replayed from its permalink, because the
 * permalink went through the serializer on the way out and the live payload
 * never did. Two sessions, one log, different states: exactly what invariant 2
 * forbids. Round-tripping through `deserialize(serialize(payload))` stores the
 * form the log will have *after* it has been written down, so the live session
 * and its replay start from the same bytes.
 *
 * It also detaches, for free and completely: `JSON.parse` builds every object
 * fresh, so there is nothing left of the caller's graph to retain.
 *
 * ## Scope: the append path only
 *
 * `reduce` and `step` take a raw `readonly EngineEvent[]`, which is how a
 * decoded replay permalink and a hand-authored fixture arrive, and neither
 * passes through here. Those payloads are folded with whatever key order the
 * file carries — `engine/__fixtures__/replay/002-random-clock/fixture.json`
 * declares `stream, count, form`, which is not sorted, and is folded that way.
 * That path is deterministic because the file is fixed, not because anything
 * normalized it; the fold must stay defined over a plain array of plain events.
 * A caller who builds a log by hand therefore still owns not mutating it, and
 * the golden replay suite is what checks that the engine does not.
 */
function clonePayload(
  payload: Readonly<Record<string, unknown>>,
  where: string,
): Readonly<Record<string, unknown>> {
  try {
    // One expression, three jobs: `serialize` judges the original and
    // normalizes it, `deserialize` detaches, `deepFreeze` hardens.
    return deepFreeze(
      deserialize(serialize(payload)) as Record<string, unknown>,
    );
  } catch (cause) {
    throw new Error(
      `${where}: "payload" is not plain data. It has to survive being written to a fixture ` +
        `and read back, so it may hold only null, booleans, finite numbers, strings, arrays ` +
        `and plain objects — no Date, Map, Set, RegExp or typed array, nothing that contains ` +
        `itself, and no accessor, symbol key or non-enumerable property, each of which would ` +
        `be dropped or invoked in silence. The cause below names the offending path.`,
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
