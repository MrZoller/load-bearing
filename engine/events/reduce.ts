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
import { createClock, restoreClock } from "../clock/clock.js";
import type { ClockState } from "../clock/clock.js";
import { hashString } from "../random/seed.js";
import { createRandom, restoreRandom } from "../random/stream.js";
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
    slices.push([
      module.namespace,
      freezeSlice(
        module.initialSlice({
          cartridge: input.cartridge,
          seed: input.seed,
          startedAtMs,
          random: random.fork(module.namespace),
        }),
      ),
    ]);
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
  assertEventEnvelope(event, `event ${String(index)}`);
  const where = `event ${String(index)} (${event.type})`;

  const handler = registry.handler(event.type);
  if (handler === undefined) {
    throw new UnknownEventTypeError(event.type, index, registry.namespaces);
  }
  if (event.version !== undefined && event.version !== handler.version) {
    throw new EventVersionError(
      where,
      event.type,
      event.version,
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
    event,
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
      makeEntry(index, at, event.type, outcome, where),
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
  const transcript = requireTranscript(parsed["transcript"]);
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

  return freezeState({
    engineVersion,
    eventSchemaVersion,
    seed,
    cartridge: loadCartridge(parsed["cartridge"]),
    eventCount,
    clock: restoreClock(
      requireObject(parsed["clock"], "clock") as unknown as ClockState,
    ).toState(),
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
  detail.forEach((line, offset) => {
    const problem = describeUnwritableText(line);
    if (problem !== undefined) {
      throw new Error(
        `${where}: transcript detail line ${String(offset)} contains ${problem}`,
      );
    }
  });

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

function requireTranscript(value: unknown): readonly TranscriptEntry[] {
  if (!Array.isArray(value)) {
    throw new Error(`snapshot: "transcript" must be an array`);
  }

  const entries: readonly unknown[] = value;
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
      return Object.freeze({
        index,
        at: requireLine(entry["at"], `transcript[${String(position)}].at`),
        type: requireLine(
          entry["type"],
          `transcript[${String(position)}].type`,
        ),
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
