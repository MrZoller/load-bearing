/**
 * `state = reduce(cartridge, seed, eventLog)`.
 *
 * The sentence the whole engine is built to satisfy, and the one function that
 * is allowed to produce a `SessionState`. Everything the simulation ever does
 * arrives here as an event and leaves as a new state value; there is no other
 * write path, which is what makes invariant 2 a structural property rather than
 * a rule people have to remember.
 *
 * ## Pure, and how
 *
 * `bootstrap` and `step` build new values and never edit the ones they are
 * given. The two things that genuinely are mutable — the simulated clock and
 * the PRNG tree — exist only inside a single `step`: they are rebuilt from the
 * incoming state's `ClockState` and `RandomState`, handed to exactly one
 * handler, and reduced back to plain data before the new state is returned. A
 * handler cannot hold onto one usefully, because the next step will not be
 * given the one it kept.
 *
 * Every state this module returns is frozen, and so are the transcript array,
 * each transcript entry, the slices record, and each slice in it. Under strict
 * mode an in-place edit therefore throws where it happens rather than being
 * inferred later from a serialized comparison. Slices are frozen one level
 * deep, not recursively — see `freezeSlice` for why, and for what covers the
 * rest.
 *
 * ## Nothing degrades silently
 *
 * An event type no module registers is refused. It is tempting to treat an
 * unknown event as a no-op — the log still folds, the session still runs — and
 * that is exactly the failure this engine cannot afford: a subsystem left out
 * of `ENGINE_EVENT_MODULES` would produce a session that looks complete and is
 * missing a third of its own history, with the fixture recording the loss as
 * correct. Note that this is not the confident-misunderstanding rule
 * (invariant 7), which is about a *visitor's* input; an unregistered event type
 * is a defect in the engine or in the log, and no in-character response can
 * make a mis-folded session coherent.
 */

import { ENGINE_VERSION } from "../version.js";
import { loadCartridge } from "../cartridge/load.js";
import type { LoadedCartridge } from "../cartridge/types.js";
import { formatTimestamp, parseTimestamp } from "../clock/civil.js";
import { createClock, restoreClock } from "../clock/clock.js";
import type { ClockState } from "../clock/clock.js";
import { hashString } from "../random/seed.js";
import {
  PATH_SEPARATOR,
  createRandom,
  restoreRandom,
} from "../random/stream.js";
import type { RandomState } from "../random/stream.js";
import { deserialize, serialize } from "../serialize/canonical.js";
import { describeUnwritableText } from "../text.js";
import { assertEventEnvelope } from "./log.js";
import type { EventContext, EventModule, EventOutcome } from "./module.js";
import { ENGINE_EVENT_REGISTRY } from "./modules.js";
import type { EventRegistry } from "./registry.js";
import { EVENT_SCHEMA_VERSION, readSlice } from "./state.js";
import type { EngineEvent, SessionState, TranscriptEntry } from "./state.js";

/** Thrown when the log names an event type nothing registers. */
export class UnknownEventTypeError extends Error {
  readonly type: string;
  /** Position in the log, so a fixture with many events says which one. */
  readonly index: number;

  constructor(type: string, index: number, namespaces: readonly string[]) {
    super(
      `event ${String(index)} (${type}): no registered module handles this event type. ` +
        `Registered namespaces: ${namespaces.join(", ")}. An unregistered type is refused ` +
        `rather than folded in as a no-op: it is either a typo or a subsystem missing from ` +
        `ENGINE_EVENT_MODULES, and ignoring it would record a session missing part of its ` +
        `own history as correct.`,
    );
    this.name = "UnknownEventTypeError";
    this.type = type;
    this.index = index;
  }
}

/** Thrown when a recorded event was written against a different payload schema. */
export class EventVersionError extends Error {
  readonly type: string;
  readonly declared: number;
  readonly implemented: number;

  constructor(
    where: string,
    type: string,
    declared: number,
    implemented: number,
  ) {
    super(
      `${where}: this event declares payload schema version ${String(declared)}, but this ` +
        `engine implements version ${String(implemented)} of ${type}. A payload version is ` +
        `bumped when the same fields would be read differently, so replaying this event ` +
        `under today's rules would produce a session the recorded one never had.`,
    );
    this.name = "EventVersionError";
    this.type = type;
    this.declared = declared;
    this.implemented = implemented;
  }
}

/** Everything a session needs before any event is folded. */
export interface BootstrapInput {
  /**
   * The world, already through `loadCartridge`.
   *
   * Validation is a precondition of the fold, not a step in it: `reduce` is
   * defined over a cartridge the engine can trust, and a document that failed
   * validation never becomes one.
   */
  readonly cartridge: LoadedCartridge;
  /** Seed material for the PRNG, in the canonical form `formatSeed` renders. */
  readonly seed: string;
  /** Defaults to the engine's own registry. */
  readonly registry?: EventRegistry;
}

/** The triple that fully determines a session. */
export interface ReduceInput extends BootstrapInput {
  readonly events: readonly EngineEvent[];
}

/**
 * The session as it stands with zero events folded in.
 *
 * Hydrated entirely from the cartridge: the clock starts at `meta.startedAt`,
 * the PRNG is seeded from `seed`, and each module builds its own slice from its
 * own forked stream. No module sees another's slice and none can advance the
 * clock here, so the result cannot depend on the order the modules were listed
 * in — see `./module.ts`.
 */
export function bootstrap(input: BootstrapInput): SessionState {
  const registry = input.registry ?? ENGINE_EVENT_REGISTRY;
  const clock = createClock(input.cartridge.meta.startedAt);
  const random = createRandom(input.seed);
  const startedAtMs = clock.now();

  const slices: [string, unknown][] = [];
  for (const module of registry.modules) {
    if (!module.stateful) continue;
    const slice = module.initialSlice({
      cartridge: input.cartridge,
      seed: input.seed,
      startedAtMs,
      random: random.fork(module.namespace),
    });
    // Statefulness follows from *declaring* `initialSlice`, not from what it
    // returns on the day — that is the contract `./module.ts` states, and this
    // enforces it rather than changing it. A module that returns `undefined`
    // conditionally ("holds state only when the cartridge declares X") is an
    // ordinary-looking pattern that typechecks, snapshots, and then fails its
    // own restore with `requireSlices` complaining about a slice set the author
    // never chose. Caught here, at the module that did it.
    if (slice === undefined) {
      throw new Error(
        `module ${JSON.stringify(module.namespace)} declares initialSlice but returned undefined. ` +
          `A module either holds state — in which case its initial slice is a value — or omits ` +
          `initialSlice entirely and occupies no key at all. Deciding per session is not a ` +
          `third option: the slices record is part of the snapshot contract, and one recorded ` +
          `without this module's key cannot be restored against a registry that has it.`,
      );
    }
    slices.push([module.namespace, freezeSlice(slice)]);
  }

  return freezeState({
    engineVersion: ENGINE_VERSION,
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    seed: input.seed,
    cartridge: input.cartridge,
    eventCount: 0,
    clock: clock.toState(),
    random: random.toState(),
    slices: Object.freeze(Object.fromEntries(slices)),
    transcript: Object.freeze([]),
  });
}

/**
 * Fold one event onto a state.
 *
 * ## Precondition: the registry is the one the state was bootstrapped under
 *
 * `reduce` threads a single registry through bootstrap and every step, so this
 * only arises for a caller stepping by hand. Two of the three ways to get it
 * wrong are caught: a state missing a module's slice fails in `readSlice`, and
 * a snapshot whose slice set disagrees with the registry fails in
 * `requireSlices`.
 *
 * The third is **not detected**, and is a documented precondition rather than a
 * checked one: a registry whose namespaces match but whose handlers mean
 * something different will fold happily and produce a session neither registry
 * describes. Catching it would mean fingerprinting the registry into
 * `SessionState` — a snapshot format change, and one more thing every recorded
 * fixture pins — to close a path reachable only by deliberately passing `step` a
 * different registry than `bootstrap`. Pass the same one.
 */
export function step(
  state: SessionState,
  event: EngineEvent,
  registry: EventRegistry = ENGINE_EVENT_REGISTRY,
): SessionState {
  const index = state.eventCount;
  // Captured once, and the only thing read from here on. Re-reading
  // `event.type` would let a getter hand the handler lookup one string and the
  // transcript another — see `assertEventEnvelope`.
  const envelope = assertEventEnvelope(event, `event ${String(index)}`);
  const where = `event ${String(index)} (${envelope.type})`;

  const handler = registry.handler(envelope.type);
  if (handler === undefined) {
    throw new UnknownEventTypeError(envelope.type, index, registry.namespaces);
  }
  if (envelope.version !== undefined && envelope.version !== handler.version) {
    throw new EventVersionError(
      where,
      envelope.type,
      envelope.version,
      handler.version,
    );
  }

  // Present by construction: a handler only exists because its module was
  // registered, and both indexes are built in the same pass.
  const module = registry.module(handler.namespace) as EventModule;

  const clock = restoreClock(state.clock);
  const random = restoreRandom(state.random);
  // Stamped before the event is applied, so a `clock.tick` reads as the moment
  // it was issued rather than the moment it finished.
  const at = clock.timestamp();

  const context: EventContext = {
    state,
    cartridge: state.cartridge,
    index,
    // The captured envelope, not the caller's object: a handler reading
    // `context.event.type` must see the string the reducer dispatched on.
    event: envelope,
    clock,
    random: random.fork(module.namespace),
    where,
  };

  const slice = module.stateful
    ? readSlice(state, module.namespace)
    : undefined;
  const outcome = handler.apply(context, slice);

  return freezeState({
    ...state,
    eventCount: index + 1,
    clock: clock.toState(),
    random: random.toState(),
    slices: nextSlices(state, module, outcome, where),
    transcript: Object.freeze([
      ...state.transcript,
      makeEntry(index, at, envelope.type, outcome, where),
    ]),
  });
}

/**
 * Fold a whole log.
 *
 * Defined as bootstrap plus one `step` per event, deliberately: two
 * implementations of the same fold — one incremental for the live session, one
 * batched for replay — is two chances for a permalink to reproduce something
 * the visitor never saw. `./reduce.test.ts` locks the equivalence anyway, so a
 * later optimization cannot quietly break it.
 */
export function reduce(input: ReduceInput): SessionState {
  const registry = input.registry ?? ENGINE_EVENT_REGISTRY;
  let state = bootstrap(input);
  // `for…of` rather than `Array.prototype.reduce`, which skips holes: a sparse
  // log would silently fold fewer events than it appears to contain.
  for (const event of input.events) {
    state = step(state, event, registry);
  }
  return state;
}

/**
 * A session as canonical JSON — the snapshot form.
 *
 * `serialize` is the whole implementation, and that is the point: a snapshot is
 * not a second representation of state that could drift from the first. Anything
 * in state that the canonical serializer refuses is a determinism leak, and this
 * is where it surfaces.
 */
export function snapshot(state: SessionState): string {
  return serialize(state);
}

/**
 * Read a snapshot back, validating rather than trusting.
 *
 * Snapshot text arrives from a file or a URL, so every field is checked and the
 * three that have their own validators — the cartridge, the clock, the PRNG —
 * are rebuilt through them. A cursor that is not a uint32 would otherwise
 * produce a session that diverges from the recorded one instead of failing.
 *
 * A slice's *contents* are checked only by the module that owns them, through
 * the optional `validateSlice` hook — see `./modules.ts`.
 *
 * The result is `step`-able: restoring and continuing is the same as never
 * having stopped. It carries `step`'s precondition with it — the registry
 * passed here must be the one the snapshot was produced under, and a registry
 * with matching namespaces but different handler semantics is not detected.
 */
export function restoreSnapshot(
  text: string,
  registry: EventRegistry = ENGINE_EVENT_REGISTRY,
): SessionState {
  const parsed = requireObject(deserialize(text), "snapshot");

  const engineVersion = requireString(parsed["engineVersion"], "engineVersion");
  if (engineVersion !== ENGINE_VERSION) {
    throw new Error(
      `snapshot: recorded by engine ${engineVersion}, but this is engine ${ENGINE_VERSION}. ` +
        `Session state is not a stable format across engine versions; replay the event log ` +
        `instead of restoring the state it produced.`,
    );
  }

  const eventSchemaVersion = requireInteger(
    parsed["eventSchemaVersion"],
    "eventSchemaVersion",
  );
  if (eventSchemaVersion !== EVENT_SCHEMA_VERSION) {
    throw new Error(
      `snapshot: event schema version ${String(eventSchemaVersion)}, but this engine reads ` +
        `version ${String(EVENT_SCHEMA_VERSION)}`,
    );
  }

  const eventCount = requireInteger(parsed["eventCount"], "eventCount");
  const transcript = requireTranscript(parsed["transcript"], registry);
  // One entry per event is the property that makes a transcript index usable as
  // an event index; a snapshot that breaks it was not produced by this reducer.
  if (transcript.length !== eventCount) {
    throw new Error(
      `snapshot: ${String(eventCount)} event(s) but ${String(transcript.length)} transcript ` +
        `entr(y/ies); the reducer writes exactly one entry per event`,
    );
  }

  const seed = requireString(parsed["seed"], "seed");
  // Rebuilt through the same validators a live session uses, then reduced back
  // to state — so an out-of-range cursor or a clock past the last representable
  // instant is refused here rather than diverging later.
  const random = restoreRandom(
    requireObject(parsed["random"], "random") as unknown as RandomState,
  ).toState();

  // `bootstrap` derives the PRNG root from the seed string, so
  // `random.seed === hashString(seed)` holds for every state this reducer has
  // ever produced. A snapshot reports the two independently, and nothing else
  // here cross-checks them: a tampered top-level `seed` would restore cleanly,
  // and the resumed session would draw from the old generator while advertising
  // the new seed. `reduce(cartridge, seed, log)` could then never reproduce it,
  // which is the one sentence the whole engine exists to satisfy.
  if (hashString(seed) !== random.seed) {
    throw new Error(
      `snapshot: seed ${JSON.stringify(seed)} hashes to ${String(hashString(seed))}, but the ` +
        `recorded PRNG root is ${String(random.seed)}. A session's generator is derived from its ` +
        `seed, so these disagreeing means one of them was edited and the session can no longer ` +
        `be reproduced from its inputs.`,
    );
  }

  // Every cursor belongs to a stream some module forked. There are only two
  // fork sites — `bootstrap` and `step`, both `random.fork(module.namespace)` —
  // and `toState()` records only streams actually drawn from, so a recorded
  // path is always `root/<namespace>[/…]` and bare `root` never appears.
  //
  // Nothing diverges if an extra cursor is present: `fork` derives a stream
  // from the seed and the path, never from another stream's position, so an
  // unreachable cursor perturbs no draw anywhere. What it breaks is the
  // snapshot's claim to be `reduce(cartridge, seed, log)` — the same property
  // the seed, clock and transcript checks defend, which is why this belongs
  // with them rather than being waved through as harmless.
  for (const path of Object.keys(random.cursors)) {
    const namespace = path.split(PATH_SEPARATOR)[1];
    if (namespace === undefined || registry.module(namespace) === undefined) {
      throw new Error(
        `snapshot: "random.cursors" holds ${JSON.stringify(path)}, which belongs to no module in ` +
          `this registry. Streams are forked as root/<namespace>, so either the cursors were ` +
          `edited, or the snapshot was recorded under a registry that has since changed — a ` +
          `module renamed or removed will land here, and the envelope version does not move for ` +
          `that. Registered namespaces: ${registry.namespaces.join(", ")}.`,
      );
    }
  }

  const cartridge = loadCartridge(parsed["cartridge"]);
  // Restored before the cross-check below, not after: `restoreClock` is what
  // rejects a malformed clock at all, and comparing a start instant first would
  // report the two disagreeing instead of the elapsed value being nonsense.
  const clock = restoreClock(
    requireObject(parsed["clock"], "clock") as unknown as ClockState,
  ).toState();

  // The sibling of the seed check above, on the same footing. `bootstrap` is
  // the only producer of a `SessionState` and always starts the clock with
  // `createClock(cartridge.meta.startedAt)`, so the cartridge's declared start
  // and the clock's `startMs` are one fact recorded twice. A snapshot reports
  // them independently: edit either — the clock by a day, or `meta.startedAt` —
  // and the session restores cleanly while stamping instants that
  // `reduce(cartridge, seed, log)` would never produce.
  //
  // `createClock` rather than `parseTimestamp` so the comparison runs through
  // the same function `bootstrap` uses; the schema already guarantees
  // `meta.startedAt` is a well-formed timestamp, so this cannot throw here.
  const declaredStart = createClock(cartridge.meta.startedAt).toState().startMs;
  if (clock.startMs !== declaredStart) {
    throw new Error(
      `snapshot: the clock starts at ${String(clock.startMs)}, but the cartridge declares the ` +
        `session begins at ${JSON.stringify(cartridge.meta.startedAt)} (${String(declaredStart)}). ` +
        `A session's clock is started from its cartridge, so these disagreeing means one of them ` +
        `was edited and every timestamp after this point belongs to neither.`,
    );
  }

  // The third instance of "one fact recorded twice", after the seed and the
  // start instant. Every transcript entry is stamped from this same clock as it
  // is folded, so the last stamp cannot be later than where the clock stopped.
  // Edit `elapsedMs` down and the session restores cleanly, then stamps the
  // *next* event before entries already in the transcript — time running
  // backwards inside a recorded session.
  //
  // `<=`, not `==`: an event is stamped at the instant it was issued and only
  // then advances the clock, so the final entry sits at or before `now`.
  //
  // The sequence is already known to run forwards, so bounding the first and
  // last entries bounds all of them — into the window the clock actually
  // occupied, `[startMs, now]`.
  const now = clock.startMs + clock.elapsedMs;
  const last = transcript[transcript.length - 1];
  const first = transcript[0];
  if (last !== undefined && first !== undefined) {
    const lastMs = requireInstant(
      last.at,
      `transcript[${String(transcript.length - 1)}].at`,
    );
    if (lastMs > now) {
      throw new Error(
        `snapshot: the last transcript entry is stamped ${JSON.stringify(last.at)}, but the clock ` +
          `stopped at ${String(now)}. Entries are stamped from that clock as they are folded, so ` +
          `one later than it means the next event would be recorded before events already in the ` +
          `transcript.`,
      );
    }

    // The other end. Without it a snapshot can claim events that happened
    // before the session began — nondecreasing, inside the upper bound, and
    // still a transcript this reducer never wrote.
    //
    // `>=`, not `===`, even though `===` is provable today: `BootstrapContext`
    // carries no clock precisely so that nothing can advance time before the
    // first event, which makes the first stamp exactly `startMs`. Asserting
    // that here would couple snapshot restoration to a structural property of
    // bootstrap, and if a later phase legitimately changed it, every snapshot
    // recorded until then would stop restoring. The weaker bound closes the
    // tamper class — events predating the session — without buying that.
    const firstMs = requireInstant(first.at, "transcript[0].at");
    if (firstMs < clock.startMs) {
      throw new Error(
        `snapshot: the first transcript entry is stamped ${JSON.stringify(first.at)}, before the ` +
          `session began at ${String(clock.startMs)}. Nothing can be recorded earlier than the ` +
          `instant the clock started.`,
      );
    }
  } else if (clock.elapsedMs !== 0) {
    // Zero events, and the clock has moved. The bounds above are the only
    // thing tying the clock to anything, and with no entries there is nothing
    // for them to bound — so a bootstrap snapshot with `elapsedMs` edited
    // restores cleanly and stamps its first event a day after the cartridge's
    // declared start. Nothing can advance the clock before the first event:
    // `BootstrapContext` carries no clock, which is the same proof the
    // first-entry bound above rests on, applied where there is no first entry.
    throw new Error(
      `snapshot: the clock has advanced ${String(clock.elapsedMs)}ms but the transcript is ` +
        `empty. Time moves only when an event advances it, so a session that has folded ` +
        `nothing is still at the instant its cartridge declares.`,
    );
  }

  return freezeState({
    engineVersion,
    eventSchemaVersion,
    seed,
    cartridge,
    eventCount,
    clock,
    random,
    slices: requireSlices(parsed["slices"], registry),
    transcript,
  });
}

/**
 * The slices record after an event.
 *
 * A stateless module returning a slice is a bug worth naming: it means a
 * handler is keeping state the reducer has nowhere to put, so it would be
 * discarded silently and the module would behave as if every event were its
 * first.
 */
function nextSlices(
  state: SessionState,
  module: EventModule,
  outcome: EventOutcome<unknown>,
  where: string,
): Readonly<Record<string, unknown>> {
  if (outcome.slice === undefined) return state.slices;
  if (!module.stateful) {
    throw new Error(
      `${where}: module ${JSON.stringify(module.namespace)} declares no initialSlice but its ` +
        `handler returned one, which the reducer has nowhere to keep`,
    );
  }
  return Object.freeze({
    ...state.slices,
    [module.namespace]: freezeSlice(outcome.slice),
  });
}

/**
 * Build one transcript entry, checking the text a handler produced.
 *
 * Checked here rather than only in the harness because the reducer is where the
 * text is created: a newline in a summary would render one event as two lines,
 * and a lone surrogate would make an artifact no re-record could ever match.
 * The detail array is copied so a handler holding a reference to it cannot edit
 * recorded state afterwards.
 */
function makeEntry(
  index: number,
  at: string,
  type: string,
  outcome: EventOutcome<unknown>,
  where: string,
): TranscriptEntry {
  const summary = outcome.summary ?? "";
  const detail = outcome.detail ?? [];

  const summaryProblem = describeUnwritableText(summary);
  if (summaryProblem !== undefined) {
    throw new Error(`${where}: transcript summary contains ${summaryProblem}`);
  }
  // An index loop, not `forEach`, and a `typeof` check before the text check.
  // Both halves are load-bearing. `forEach` skips a hole, so `new Array(1)` —
  // validly typed as `string[]`, no cast — passed straight through, the spread
  // below materialized the hole as `undefined`, and the state that came back
  // could not be snapshotted at all: the canonical serializer refuses an
  // undefined array element, so `reduce` succeeded and produced something
  // unrecordable. And `describeUnwritableText` takes a `string` but tests with
  // a regex, which coerces — so an *explicit* `undefined` element passed the
  // text check as the string "undefined". Checking holes alone would close half
  // of one axis and invite the other half back.
  //
  // `Array.isArray` first, because the index loop is more permissive than the
  // `forEach` it replaced: a non-array `detail` used to crash on `.forEach`,
  // and a bare string would otherwise iterate per character and record its
  // letters as lines. Cast-only either way, but a loud refusal beats quietly
  // recording something nobody wrote.
  if (!Array.isArray(detail)) {
    throw new Error(
      `${where}: transcript detail must be an array of lines, got ${typeof detail}`,
    );
  }
  for (let offset = 0; offset < detail.length; offset += 1) {
    const line = detail[offset];
    if (typeof line !== "string") {
      throw new Error(
        `${where}: transcript detail line ${String(offset)} is ${
          offset in detail ? typeof line : "a hole in a sparse array"
        }; every line must be a string, because state that cannot be serialized ` +
          `cannot be recorded or replayed`,
      );
    }
    const problem = describeUnwritableText(line);
    if (problem !== undefined) {
      throw new Error(
        `${where}: transcript detail line ${String(offset)} contains ${problem}`,
      );
    }
  }

  return Object.freeze({
    index,
    at,
    type,
    summary,
    detail: Object.freeze([...detail]),
  });
}

/**
 * Freeze the structures the reducer owns.
 *
 * The clock and the PRNG need naming explicitly. `toState()` hands back an
 * ordinary object on both, and `random.cursors` is a second level below that —
 * so freezing the state alone would leave
 * `context.state.random.cursors["root/vfs"] = 0` succeeding in silence, from
 * inside a handler, against a state that has already been folded and possibly
 * already recorded. They are safe to freeze here because both are built fresh
 * for this state and shared with nothing: `restoreClock` and `restoreRandom`
 * copy values out rather than holding the object.
 */
function freezeState(state: SessionState): SessionState {
  Object.freeze(state.clock);
  Object.freeze(state.random.cursors);
  Object.freeze(state.random);
  return Object.freeze(state);
}

/**
 * Freeze a slice on its way into state.
 *
 * One level, not a deep freeze. The accident this closes is the likely one — a
 * handler writing `slice.count += 1` on the slice it was handed, which would
 * reach back into the *previous* state and make an already-folded session
 * change under a caller holding it. Deep-freezing instead would walk a whole
 * simulated filesystem on every keystroke to catch a mistake one level further
 * down, and would freeze structures a module has every right to build fresh and
 * hand over.
 *
 * The remaining depth is covered by the golden replay suite, which folds every
 * fixture twice from frozen inputs and compares the recording, and by the
 * canonical serializer, which cannot record a slice holding anything but plain
 * data in the first place.
 */
function freezeSlice(slice: unknown): unknown {
  return typeof slice === "object" && slice !== null
    ? Object.freeze(slice)
    : slice;
}

function requireObject(
  value: unknown,
  what: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`snapshot: "${what}" must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== "string") {
    throw new Error(`snapshot: "${what}" must be a string`);
  }
  return value;
}

function requireInteger(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `snapshot: "${what}" must be a non-negative integer, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * A string that can be one line of a recorded artifact.
 *
 * `step` checks every summary and detail line a handler produces, but
 * `deserialize` is bare `JSON.parse` — so a snapshot carrying an embedded
 * newline or a lone surrogate would restore cleanly and only break later, in
 * `renderTranscript`, whose contract is one string per line. The check belongs
 * on both doors into the transcript, not just the one the reducer writes
 * through.
 */
function requireLine(value: unknown, what: string): string {
  const line = requireString(value, what);
  const problem = describeUnwritableText(line);
  if (problem !== undefined) {
    throw new Error(`snapshot: "${what}" contains ${problem}`);
  }
  return line;
}

/**
 * A transcript timestamp, as epoch milliseconds.
 *
 * `parseTimestamp` is the same function the clock parses `meta.startedAt` with —
 * pure, UTC, a regex and hand-written calendar arithmetic, no `Date` anywhere.
 * Without it `at: "banana"` restores cleanly and fails only whenever something
 * eventually tries to read it.
 */
function requireInstant(at: string, what: string): number {
  let ms: number;
  try {
    ms = parseTimestamp(at);
  } catch (cause) {
    throw new Error(
      `snapshot: "${what}" is ${JSON.stringify(at)}, which is not a UTC instant of the form ` +
        `YYYY-MM-DDTHH:MM:SS.mmmZ`,
      { cause },
    );
  }

  // `parseTimestamp` is the lenient half of the pair: it accepts a missing
  // fraction and a one- or two-digit one, because a cartridge author writing
  // `startedAt` by hand should not be caught out by trailing zeros. The engine
  // never *writes* those forms — `formatTimestamp` always emits three digits —
  // so a transcript carrying one did not come from this reducer.
  //
  // Checked by re-formatting rather than by tightening `parseTimestamp`, which
  // the cartridge schema also depends on: the leniency is wanted there and
  // unwanted here, and this is the place that knows the difference.
  const canonical = formatTimestamp(ms);
  if (canonical !== at) {
    throw new Error(
      `snapshot: "${what}" is ${JSON.stringify(at)}, which is a valid instant spelled in a form ` +
        `this engine never writes — it would record it as ${JSON.stringify(canonical)}.`,
    );
  }
  return ms;
}

/**
 * The transcript from a snapshot, shape-checked and ordered in time.
 *
 * Each `at` is parsed rather than merely required to be a string: `"banana"`
 * would otherwise restore cleanly and only fail whenever something tried to read
 * it. And the instants have to be nondecreasing, because the clock they came
 * from cannot run backwards — `advance` rejects a negative — so two entries out
 * of order, or two swapped, is a transcript this reducer never wrote.
 *
 * Each `type` must also be one the registry knows. Every entry this reducer
 * writes took its type from a successful `registry.handler(...)` lookup in
 * `step`, so the invariant holds by construction *for a snapshot restored under
 * the registry it was produced under* — which is what `restoreSnapshot` already
 * requires of its caller. Without the check, editing an entry's type to
 * `vfs.write`, or to something that is not a type at all, restores cleanly and
 * renders. It is the missing member of the family this module already checks
 * four times over (transcript text, transcript instants, seed against PRNG
 * root, clock against `startedAt`), and `requireSlices` cannot stand in for it:
 * a stateless module like `CLOCK_MODULE` occupies no slice, so a registry
 * missing it still passes the slice-set check.
 *
 * That precondition has a cost worth naming, because `EVENT_SCHEMA_VERSION` is
 * one global envelope version and is deliberately *not* bumped per subsystem
 * change (see `./state.ts`). A snapshot recorded legitimately, before a module
 * was renamed or removed, will fail here. That is registry drift, not tampering
 * — and the stateless case is the sharp one, since `requireSlices` also catches
 * a renamed *stateful* module and this is the only check that sees a renamed
 * stateless one. (Not "catches it first": this check runs before
 * `requireSlices`, so for a stateful module carrying transcript entries it is
 * still this one that reports.) The message below names both causes rather than
 * accusing, so a maintainer debugging an ordinary rename is not sent looking
 * for an attacker.
 *
 * The bound against the clock itself lives in `restoreSnapshot`, which is where
 * the clock has been restored; this runs before that.
 */
function requireTranscript(
  value: unknown,
  registry: EventRegistry,
): readonly TranscriptEntry[] {
  if (!Array.isArray(value)) {
    throw new Error(`snapshot: "transcript" must be an array`);
  }

  const entries: readonly unknown[] = value;
  let previousMs: number | undefined;
  return Object.freeze(
    entries.map((item, position) => {
      const entry = requireObject(item, `transcript[${String(position)}]`);
      const detail: unknown = entry["detail"];
      if (!Array.isArray(detail)) {
        throw new Error(
          `snapshot: "transcript[${String(position)}].detail" must be an array`,
        );
      }
      const lines: readonly unknown[] = detail;
      // One entry per event, at the event's own index — the property that lets
      // a reader treat a transcript position as an event position. A snapshot
      // whose entries are renumbered or reordered was not produced by this
      // reducer, and restoring it would make every later error message point
      // at the wrong event.
      const index = requireInteger(
        entry["index"],
        `transcript[${String(position)}].index`,
      );
      if (index !== position) {
        throw new Error(
          `snapshot: "transcript[${String(position)}].index" is ${String(index)}; entries are ` +
            `written one per event, in log order`,
        );
      }

      const at = requireLine(entry["at"], `transcript[${String(position)}].at`);
      const atMs = requireInstant(at, `transcript[${String(position)}].at`);
      if (previousMs !== undefined && atMs < previousMs) {
        throw new Error(
          `snapshot: "transcript[${String(position)}].at" is ${JSON.stringify(at)}, which is ` +
            `earlier than the entry before it. The clock cannot run backwards — advancing it by ` +
            `a negative amount is refused — so a transcript out of order was never written by ` +
            `this reducer.`,
        );
      }
      previousMs = atMs;

      const type = requireLine(
        entry["type"],
        `transcript[${String(position)}].type`,
      );
      if (registry.handler(type) === undefined) {
        throw new Error(
          `snapshot: "transcript[${String(position)}].type" is ${JSON.stringify(type)}, which no ` +
            `module in this registry registers. Either the transcript was edited, or the ` +
            `snapshot was recorded under a registry that has since changed — a module renamed ` +
            `or removed will land here, and the envelope version does not move for that. ` +
            `Registered namespaces: ${registry.namespaces.join(", ")}.`,
        );
      }

      return Object.freeze({
        index,
        at,
        type,
        summary: requireLine(
          entry["summary"],
          `transcript[${String(position)}].summary`,
        ),
        detail: Object.freeze(
          lines.map((line, offset) =>
            requireLine(
              line,
              `transcript[${String(position)}].detail[${String(offset)}]`,
            ),
          ),
        ),
      });
    }),
  );
}

/**
 * The slices record from a snapshot, checked against the registry.
 *
 * Exactly the stateful modules, no more and no fewer. A missing slice means a
 * subsystem this engine has and the recording did not; an extra one means the
 * reverse. Either way the snapshot describes a different engine, and folding on
 * top of it would produce a session neither ever ran.
 *
 * The *contents* are a shape only the owning module knows, so each is offered
 * to that module's `validateSlice` if it declares one. Without that hook a
 * snapshot claiming `{ events: "oops" }` restores happily and the next event
 * folds `"oops1"` into recorded state — a slice cannot be checked from here,
 * only routed to something that can.
 */
function requireSlices(
  value: unknown,
  registry: EventRegistry,
): Readonly<Record<string, unknown>> {
  const slices = requireObject(value, "slices");
  const stateful = registry.modules.filter((module) => module.stateful);
  const expected = stateful.map((module) => module.namespace);
  const found = Object.keys(slices).sort();

  const missing = expected.filter((namespace) => !found.includes(namespace));
  const extra = found.filter((namespace) => !expected.includes(namespace));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `snapshot: "slices" must hold exactly one entry per stateful module. ` +
        `Expected ${expected.join(", ") || "none"}; found ${found.join(", ") || "none"}.`,
    );
  }

  return Object.freeze(
    Object.fromEntries(
      stateful.map((module) => {
        const raw = slices[module.namespace];
        const validated =
          module.validateSlice === undefined
            ? raw
            : module.validateSlice(raw, `snapshot: slices.${module.namespace}`);
        return [module.namespace, freezeSlice(validated)];
      }),
    ),
  );
}
