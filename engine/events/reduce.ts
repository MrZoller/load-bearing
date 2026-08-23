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
 * inferred later from a serialized comparison. A slice is canonicalized and
 * frozen all the way down through the plain data it holds — see `freezeSlice`
 * for how that is affordable, and for what it deliberately leaves to the
 * canonical serializer.
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
import { canFreezeInPlace } from "../freeze.js";
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
import { countCodePoints, describeUnwritableText } from "../text.js";
import {
  MAX_TRANSCRIPT_DETAIL_LINES,
  MAX_TRANSCRIPT_LINE_LENGTH,
} from "./transcript.js";
import { assertEventEnvelope } from "./log.js";
import type { EventContext, EventModule, EventOutcome } from "./module.js";
import { ENGINE_EVENT_REGISTRY } from "./modules.js";
import type { EventRegistry } from "./registry.js";
import { reactionActionEvent, reactionPredicateMatches } from "../reactions.js";
import { MAX_STORY_CONSEQUENCE_WORK } from "../cartridge/schema.js";
import { storyActionEvent } from "../story/actions.js";
import {
  storyConditionMatches,
  storyStageTriggerMatches,
} from "../story/conditions.js";
import { readStorySlice, validateStorySlice } from "../story/story.js";
import {
  createStoryRareEventEvaluatedEvent,
  createStoryStageAdvancedEvent,
} from "../story/module.js";
import { EVENT_SCHEMA_VERSION, readSlice } from "./state.js";
import type {
  EngineEvent,
  SessionState,
  TranscriptEntry,
  TranscriptOutput,
} from "./state.js";

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
  // Each input field read exactly once, the same discipline `assertEventEnvelope`
  // applies to an event and `createRegistry` to a module. `input` is the
  // caller's object and its properties can be getters, and `cartridge` and
  // `seed` were each read more than once — twice here plus once per stateful
  // module — while `registry` was read once here and again by `reduce`. A
  // `cartridge` getter could start the clock from world A
  // while `state.cartridge` recorded world B, and a `seed` getter could make
  // `state.seed` name one seed while the generator was keyed to another. Both
  // produce a session that lies about its own inputs, and the golden replay
  // suite cannot see it, because it folds the same lie twice.
  const cartridge = input.cartridge;
  const seed = input.seed;
  const registry = input.registry ?? ENGINE_EVENT_REGISTRY;

  const clock = createClock(cartridge.meta.startedAt);
  const random = createRandom(seed);
  const startedAtMs = clock.now();

  const slices: [string, unknown][] = [];
  for (const module of registry.modules) {
    // Captured. With a hand-built registry these are the caller's modules, and
    // this namespace picks both the PRNG stream and the slice key — read
    // separately for each, a getter forks `root/alpha` and stores under
    // `beta`, which breaks state coherence rather than a message.
    const namespace = module.namespace;
    if (!module.stateful) continue;
    const slice = module.initialSlice({
      cartridge,
      seed,
      startedAtMs,
      random: random.fork(namespace),
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
        `module ${JSON.stringify(namespace)} declares initialSlice but returned undefined. ` +
          `A module either holds state — in which case its initial slice is a value — or omits ` +
          `initialSlice entirely and occupies no key at all. Deciding per session is not a ` +
          `third option: the slices record is part of the snapshot contract, and one recorded ` +
          `without this module's key cannot be restored against a registry that has it.`,
      );
    }
    slices.push([
      namespace,
      freezeSlice(slice, `module ${JSON.stringify(namespace)}`),
    ]);
  }

  return freezeState({
    engineVersion: ENGINE_VERSION,
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    seed,
    cartridge,
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
 *
 * One residual inside that, worth naming rather than leaving to be found: a
 * *stateless* module whose namespace differs between `bootstrap` and `step`
 * forks `root/beta` with nothing to catch it in-session, because there is no
 * slice for `readSlice` to miss. Per-call capture cannot close it — it would
 * need the registry fingerprint this docstring prices and declines — and a
 * snapshot of such a session is refused on restore by the cursor-namespace
 * check — but only when that stream was actually drawn from. `toState()`
 * records a cursor only for a stream something drew from, so a stateless
 * handler that never touches `context.random` leaves no trace; that is also no
 * divergence, since nothing was drawn under either name. `CLOCK_MODULE` is
 * exactly that case today, and it is the module a new subsystem is most likely
 * to copy.
 */
export function step(
  state: SessionState,
  event: EngineEvent,
  registry: EventRegistry = ENGINE_EVENT_REGISTRY,
): SessionState {
  return foldEvent(state, event, registry, true, true);
}

function foldEvent(
  state: SessionState,
  event: EngineEvent,
  registry: EventRegistry,
  expansionAllowed: boolean,
  reactionsAllowed: boolean,
  triggerSink?: string[],
): SessionState {
  // Every field of `state` read exactly once, here, and the returned state
  // built from these locals rather than from `{...state}`. `state` is a
  // caller-owned object at this exported entry, and it was read twice over —
  // `state.cartridge` for the `EventContext` and again by the spread — so a
  // getter could have the handler fold against one world while the state it
  // returned recorded another. That is the failure `bootstrap`'s own comment
  // describes, closed for its input and left open for this one, and
  // `captureOutcome`'s docblock parked it as a further candidate.
  const engineVersion = state.engineVersion;
  const eventSchemaVersion = state.eventSchemaVersion;
  const seed = state.seed;
  const cartridge = state.cartridge;
  const previousClock = state.clock;
  const previousRandom = state.random;
  const previousSlices = state.slices;
  const previousTranscript = state.transcript;
  const index = state.eventCount;

  // The captured view, handed to the handler in place of the caller's object,
  // so `context.state` and the fold agree by construction.
  const before: SessionState = Object.freeze({
    engineVersion,
    eventSchemaVersion,
    seed,
    cartridge,
    eventCount: index,
    clock: previousClock,
    random: previousRandom,
    slices: previousSlices,
    transcript: previousTranscript,
  });

  // Captured once, and the only thing read from here on. Re-reading
  // `event.type` would let a getter hand the handler lookup one string and the
  // transcript another — see `assertEventEnvelope`.
  const envelope = assertEventEnvelope(event, `event ${String(index)}`);
  const where = `event ${String(index)} (${envelope.type})`;

  if (
    envelope.type === "story.stage-advanced" ||
    envelope.type === "story.rare-event-evaluated"
  )
    throw new Error(
      `${where}: internal story owner events are derived by the reducer and cannot be logged or runtime-dispatched`,
    );

  const handler = registry.handler(envelope.type);
  if (handler === undefined) {
    throw new UnknownEventTypeError(envelope.type, index, registry.namespaces);
  }
  // Captured, so the version the comparison rejected is the one the error
  // names. A getter answering 7 then 99 reported "implements version 99" for a
  // mismatch against 7.
  const implemented = handler.version;
  if (envelope.version !== undefined && envelope.version !== implemented) {
    throw new EventVersionError(
      where,
      envelope.type,
      envelope.version,
      implemented,
    );
  }

  // Present by construction: a handler only exists because its module was
  // registered, and both indexes are built in the same pass.
  const module = registry.module(handler.namespace) as EventModule;
  // Captured. A hand-built registry hands back a caller-owned module, and this
  // namespace picks the PRNG stream *and* the slice key — read twice, a getter
  // forks `root/alpha` and stores the slice under `beta`, which is invariant 4
  // rather than a diagnostic.
  const namespace = module.namespace;
  const stateful = module.stateful;

  const clock = restoreClock(previousClock);
  const random = restoreRandom(previousRandom);
  // Stamped before the event is applied, so a `clock.tick` reads as the moment
  // it was issued rather than the moment it finished.
  const at = clock.timestamp();

  const context: EventContext = {
    state: before,
    cartridge,
    index,
    // The captured envelope, not the caller's object: a handler reading
    // `context.event.type` must see the string the reducer dispatched on.
    event: envelope,
    clock,
    random: random.fork(namespace),
    where,
  };

  const slice = stateful ? readSlice(before, namespace) : undefined;
  // Materialized once, immediately. An `EventOutcome` is a caller-owned object
  // like the event envelope, and everything downstream now reads the capture
  // rather than the handler's object — see `captureOutcome`.
  const clockBefore = clock.toState();
  const randomBefore = random.toState();
  const outcome = captureOutcome(handler.apply(context, slice), where);
  if (outcome.hasExpansion) {
    if (!expansionAllowed) {
      throw new Error(
        `${where}: nested event expansion is not allowed; expansion children are ordinary logged events`,
      );
    }
    if (outcome.expansion.length === 0) {
      throw new Error(
        `${where}: event expansion must contain at least one logged child event`,
      );
    }
    if (
      outcome.hasSlice ||
      outcome.summary !== "" ||
      outcome.detail.length > 0 ||
      outcome.output !== undefined ||
      outcome.exitCode !== undefined ||
      outcome.effects.length > 0
    ) {
      throw new Error(
        `${where}: an expanding event may return only expansion children; it is an unlogged envelope, not a state transition or transcript entry`,
      );
    }
    if (
      serialize(clock.toState()) !== serialize(clockBefore) ||
      serialize(random.toState()) !== serialize(randomBefore)
    ) {
      throw new Error(
        `${where}: an event expander may not move the clock or PRNG; only its logged child events may do so`,
      );
    }

    const stageExpansion = (children: readonly EngineEvent[]): SessionState => {
      let expanded = before;
      const triggers: string[] = [envelope.type];
      for (const child of children) {
        const count = expanded.transcript.length;
        const childTriggers: string[] = [];
        expanded = foldEvent(
          expanded,
          child,
          registry,
          false,
          false,
          childTriggers,
        );
        const entry = expanded.transcript[count];
        if (entry === undefined)
          throw new Error(`${where}: expansion child produced no logged entry`);
        triggers.push(...childTriggers);
      }
      return reactionsAllowed
        ? applyReactions(expanded, triggers, registry, where)
        : expanded;
    };
    // The envelope remains the authored trigger even though it is unlogged.
    // Queue it before its logged children, then evaluate the entire queue only
    // after every child is staged. This lets a cartridge react to the visitor's
    // `shell.execute` intent while predicates see the completed command, without
    // losing the child event types needed for narrower rules.
    let staged: SessionState;
    try {
      staged = stageExpansion(outcome.expansion);
    } catch (error) {
      if (!outcome.hasExpansionFallback) throw error;
      staged = stageExpansion(outcome.expansionFallback);
    }
    const completed = applyEscalation(
      before,
      staged,
      envelope,
      registry,
      where,
    );
    return reactionsAllowed
      ? applyRareEvents(completed, registry, where)
      : completed;
  }
  const slices = applyEffects(
    before,
    previousSlices,
    namespace,
    stateful,
    outcome,
    clock,
    random,
    registry,
    where,
  );

  const logged = freezeState({
    engineVersion,
    eventSchemaVersion,
    seed,
    cartridge,
    eventCount: index + 1,
    clock: clock.toState(),
    random: random.toState(),
    slices,
    transcript: Object.freeze([
      ...previousTranscript,
      makeEntry(index, at, envelope.type, outcome, where),
    ]),
  });
  const triggers = [envelope.type];
  const staged =
    envelope.type === "story.beat-reached"
      ? applyStoryConsequences(logged, registry, where, triggers)
      : logged;
  triggerSink?.push(...triggers);
  const reacted = reactionsAllowed
    ? applyReactions(staged, triggers, registry, where)
    : staged;
  if (!reactionsAllowed) return reacted;
  const completed = applyEscalation(before, reacted, envelope, registry, where);
  return applyRareEvents(completed, registry, where);
}

function stagedStorySlice(state: SessionState) {
  // Hand-built reducer test cartridges may omit loaded cross-reference data;
  // escalation needs only the already validated owner slice at this boundary.
  return validateStorySlice(readSlice(state, "story"), "staged story slice");
}

function applyEscalation(
  before: SessionState,
  staged: SessionState,
  envelope: EngineEvent,
  registry: EventRegistry,
  where: string,
): SessionState {
  const transitions = staged.cartridge.story.phase2.transitions ?? [];
  // Custom registries remain independent reducer test surfaces. Escalation is
  // active only when both its authored contract and owning module are present.
  if (
    transitions.length === 0 ||
    registry.module("story") === undefined ||
    !Object.hasOwn(staged.slices, "story")
  )
    return staged;
  const stage = stagedStorySlice(before).stage;
  const transition = transitions.find(
    (candidate) =>
      candidate.from === stage &&
      storyStageTriggerMatches(candidate.trigger, before, staged, envelope),
  );
  if (transition === undefined) return staged;
  return applyDerivedEvent(
    staged,
    createStoryStageAdvancedEvent(transition.from, transition.to),
    registry,
    `${where} escalation`,
    "story escalation",
  );
}

/** Evaluate each newly eligible rare event after the top-level transaction. */
function applyRareEvents(
  completed: SessionState,
  registry: EventRegistry,
  where: string,
): SessionState {
  const declarations = completed.cartridge.story.phase2.rareEvents ?? [];
  if (
    declarations.length === 0 ||
    registry.module("story") === undefined ||
    !Object.hasOwn(completed.slices, "story")
  )
    return completed;

  const random = restoreRandom(completed.random);
  const streams = random.fork("story").fork("rare-events");
  let state = completed;
  for (const declaration of declarations) {
    const recorded = stagedStorySlice(state).rareEvents.find(
      (rareEvent) => rareEvent.id === declaration.id,
    );
    if (
      recorded === undefined ||
      recorded.evaluated ||
      !storyConditionMatches(state, declaration.eligibility)
    )
      continue;
    const fired = streams.fork(declaration.id).weightedPick([
      { value: true, weight: declaration.fireWeight },
      { value: false, weight: declaration.missWeight },
    ]);
    state = applyDerivedEvent(
      state,
      createStoryRareEventEvaluatedEvent(declaration.id, fired),
      registry,
      `${where} rare event ${JSON.stringify(declaration.id)}`,
      "story rare event",
    );
  }

  return freezeState({
    engineVersion: state.engineVersion,
    eventSchemaVersion: state.eventSchemaVersion,
    seed: state.seed,
    cartridge: state.cartridge,
    eventCount: state.eventCount,
    clock: state.clock,
    random: random.toState(),
    slices: state.slices,
    transcript: state.transcript,
  });
}

/** Stage the selected story outcome and every recursively reached outcome. */
function applyStoryConsequences(
  initial: SessionState,
  registry: EventRegistry,
  where: string,
  triggers: string[],
): SessionState {
  let state = initial;
  let work = 0;
  const dispatchSelected = (): void => {
    const story = readStorySlice(state);
    const beat = state.cartridge.story.phase2.beats.find(
      (candidate) => candidate.id === story.currentBeat,
    );
    if (beat === undefined)
      throw new Error(
        `${where}: selected unknown story beat ${JSON.stringify(story.currentBeat)}`,
      );
    const actions =
      story.currentVariant === ""
        ? beat.actions
        : beat.variants.find((variant) => variant.id === story.currentVariant)
            ?.actions;
    if (actions === undefined)
      throw new Error(
        `${where}: selected unknown story variant ${JSON.stringify(story.currentVariant)}`,
      );
    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index];
      if (action === undefined) continue;
      if (work >= MAX_STORY_CONSEQUENCE_WORK)
        throw new Error(
          `${where}: story consequence chain exceeds the ${String(MAX_STORY_CONSEQUENCE_WORK)} derived-event limit`,
        );
      const event = storyActionEvent(action);
      state = applyDerivedEvent(
        state,
        event,
        registry,
        `${where} story action ${String(index)}`,
        "story consequence",
      );
      work += 1;
      triggers.push(event.type);
      if (event.type === "story.beat-reached") dispatchSelected();
    }
  };
  dispatchSelected();
  return state;
}

/**
 * Evaluate cartridge rules after the logged transition is fully staged.
 *
 * Trigger types are queued in source order. Every matching rule and action is
 * visited in authored order; action event types join the tail, making cascades
 * FIFO. Predicates are deliberately re-read from the latest staged state for
 * each rule, so an earlier action can make a later rule true. No intermediate
 * state escapes this call: a later action failure throws before `step` returns.
 */
function applyReactions(
  initial: SessionState,
  sourceTypes: readonly string[],
  registry: EventRegistry,
  where: string,
): SessionState {
  // An acyclic reaction graph still permits a wide cascade. Bound the total
  // derived events so a valid cartridge cannot turn one visitor event into
  // unbounded work or freeze a browser while staging state that never escapes.
  const maxDerivedEvents = 1024;
  let state = initial;
  const queue = [...sourceTypes];
  let derivedEvents = 0;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const sourceType = queue[cursor];
    if (sourceType === undefined) continue;
    for (const reaction of state.cartridge.repository.reactions) {
      if (reaction.on !== sourceType) continue;
      if (
        !reaction.predicates.every((predicate) =>
          reactionPredicateMatches(predicate, state),
        )
      )
        continue;
      for (
        let actionIndex = 0;
        actionIndex < reaction.actions.length;
        actionIndex += 1
      ) {
        const action = reaction.actions[actionIndex];
        if (action === undefined) continue;
        if (derivedEvents >= maxDerivedEvents) {
          throw new Error(
            `${where}: reaction cascade exceeds the ${String(maxDerivedEvents)} derived-event limit`,
          );
        }
        const event = reactionActionEvent(action);
        state = applyDerivedEvent(
          state,
          event,
          registry,
          `${where} reaction ${JSON.stringify(reaction.id)} action ${String(actionIndex)}`,
          "reaction",
        );
        derivedEvents += 1;
        queue.push(event.type);
      }
    }
  }
  return state;
}

/** Apply one trusted derived event through its owner without logging it. */
function applyDerivedEvent(
  state: SessionState,
  event: EngineEvent,
  registry: EventRegistry,
  where: string,
  source:
    "reaction" | "story consequence" | "story escalation" | "story rare event",
): SessionState {
  const envelope = assertEventEnvelope(event, where);
  const handler = registry.handler(envelope.type);
  if (handler === undefined)
    throw new UnknownEventTypeError(
      envelope.type,
      state.eventCount,
      registry.namespaces,
    );
  if (envelope.version !== undefined && envelope.version !== handler.version)
    throw new EventVersionError(
      where,
      envelope.type,
      envelope.version,
      handler.version,
    );
  const module = registry.module(handler.namespace) as EventModule;
  const clock = restoreClock(state.clock);
  const random = restoreRandom(state.random);
  const context: EventContext = {
    state,
    cartridge: state.cartridge,
    index: state.eventCount,
    event: envelope,
    clock,
    random: random.fork(module.namespace),
    where,
  };
  const slice = module.stateful
    ? readSlice(state, module.namespace)
    : undefined;
  const clockBefore = clock.toState();
  const randomBefore = random.toState();
  const outcome = captureOutcome(handler.apply(context, slice), where);
  if (outcome.hasExpansion)
    throw new Error(
      `${where}: ${source} actions may not expand into logged events`,
    );
  if (
    serialize(clock.toState()) !== serialize(clockBefore) ||
    serialize(random.toState()) !== serialize(randomBefore)
  )
    throw new Error(
      `${where}: ${source} actions may not move time or randomness; only logged events own those positions`,
    );
  const slices = applyEffects(
    state,
    state.slices,
    module.namespace,
    module.stateful,
    outcome,
    clock,
    random,
    registry,
    where,
  );
  if (
    serialize(clock.toState()) !== serialize(clockBefore) ||
    serialize(random.toState()) !== serialize(randomBefore)
  )
    throw new Error(
      `${where}: ${source} actions and their effects may not move time or randomness; only logged events own those positions`,
    );
  return freezeState({
    engineVersion: state.engineVersion,
    eventSchemaVersion: state.eventSchemaVersion,
    seed: state.seed,
    cartridge: state.cartridge,
    eventCount: state.eventCount,
    clock: state.clock,
    random: state.random,
    slices,
    transcript: state.transcript,
  });
}

/** An `EventOutcome` after every field has been read exactly once. */
interface CapturedOutcome {
  /** Whether the handler returned a slice. A boolean, never a re-read. */
  readonly hasSlice: boolean;
  readonly slice: unknown;
  readonly summary: string;
  readonly detail: readonly string[];
  readonly output: readonly TranscriptOutput[] | undefined;
  readonly exitCode: number | undefined;
  readonly effects: readonly EngineEvent[];
  readonly hasExpansion: boolean;
  readonly expansion: readonly EngineEvent[];
  readonly hasExpansionFallback: boolean;
  readonly expansionFallback: readonly EngineEvent[];
}

/**
 * Read a handler's outcome once, into values nothing downstream can re-read.
 *
 * The rule this applies is stated in five other places in the engine —
 * `assertEventEnvelope` is the worked example — and `EventOutcome` was a
 * boundary object it had not been applied to. (`BootstrapInput` and
 * `ReduceInput` were two more, closed in the same change, and `SessionState` at
 * the exported `step` entry was a third, closed since.) A handler may return an object
 * whose properties are getters, and every consumer that read one twice was a
 * place where the value checked and the value used could differ:
 *
 * - `nextSlices` read `slice` to decide whether there was one and again to
 *   store it. The guard saw an object, the store saw `undefined`, and the
 *   result was an own key holding `undefined` — so `readSlice`'s `Object.hasOwn`
 *   answered true and the module was handed `undefined` from then on, behaving
 *   as if every event were its first. That is the failure `nextSlices` exists
 *   to prevent, arriving through the door it was watching. It is also the only
 *   member of this family that corrupts state in memory rather than failing at
 *   restore: `snapshot()` succeeds, because JSON drops undefined-valued
 *   properties, and the restore then blames registry drift.
 * - `makeEntry` read `detail` to validate and again to copy, so a `detail`
 *   getter could pass a clean array to the check and hand a different one to
 *   the transcript. A getter drawing from `context.random` is the sharpest
 *   version: the draw happens inside the getter, after the reducer has taken
 *   the stream's position, so the cursor never advances and every event draws
 *   the same value. Note what that is and is not — the fold still replays
 *   identically, so it is not a determinism break; it is an invariant-4
 *   coherence break plus a stream stuck in place.
 * - A non-object outcome dereferenced straight into a bare `TypeError` naming
 *   no event. A *string* outcome was worse: `"".slice` is a function, so
 *   `String.prototype.slice` was stored as the module's state and only the
 *   canonical serializer noticed, much later.
 *
 * `summary` gets a `typeof` check here for the reason the detail-line comment
 * below already argues at length — `describeUnwritableText` takes a `string`
 * but tests with a regex, which coerces, so a number passes the text check and
 * lands in a `TranscriptEntry` typed `string`. That argument was written two
 * lines from `summary` and applied only to `detail`: the same one-member-short
 * shape this capture exists to stop repeating.
 *
 * The slice itself is captured by reference here and handed on to
 * `freezeSlice`, which is where it is walked: accessors on it are refused
 * there, not here, and what survives that walk is a canonical frozen copy. What
 * neither covers is depth past a value `canFreezeInPlace` refuses — a nested
 * `Map` is passed through untouched, and the canonical serializer names it at
 * record time with a JSON pointer.
 */
function captureOutcome(raw: unknown, where: string): CapturedOutcome {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `${where}: a handler must return an outcome object, got ${
        raw === null ? "null" : Array.isArray(raw) ? "an array" : typeof raw
      }. An empty object is how a handler says it changed nothing.`,
    );
  }

  const outcome = raw as EventOutcome<unknown>;
  const slice: unknown = outcome.slice;
  const summary: unknown = outcome.summary;
  const detail: unknown = outcome.detail;
  const output: unknown = outcome.output;
  const exitCode: unknown = outcome.exitCode;
  const effects: unknown = outcome.effects;
  const expansion: unknown = outcome.expansion;
  const expansionFallback: unknown = outcome.expansionFallback;

  if (summary !== undefined && typeof summary !== "string") {
    throw new Error(
      `${where}: transcript summary must be a string, got ${typeof summary}`,
    );
  }
  if (summary !== undefined && summary.length > MAX_TRANSCRIPT_LINE_LENGTH) {
    throw new Error(
      `${where}: transcript summary is ${String(summary.length)} characters, over the ` +
        `${String(MAX_TRANSCRIPT_LINE_LENGTH)} a single line may hold.`,
    );
  }

  let lines: readonly string[] = [];
  if (detail !== undefined) {
    if (!Array.isArray(detail)) {
      throw new Error(
        `${where}: transcript detail must be an array, got ${typeof detail}`,
      );
    }
    const source: readonly unknown[] = detail;
    // The count captured before the ceiling is checked against it, and used as
    // the loop bound below. Checking `source.length` and then re-reading it per
    // step let the array grow during the copy and store more lines than were
    // validated — and no Proxy is needed for that: `length` is writable, and an
    // accessor on an index is an ordinary plain-array feature, so a getter on
    // element 0 can push while the copy is running. Same writer-weaker-than-
    // reader shape as the event type, through the neighbouring field.
    const lineCount = source.length;
    if (lineCount > MAX_TRANSCRIPT_DETAIL_LINES) {
      throw new Error(
        `${where}: this event would write ${String(lineCount)} transcript lines, over the ` +
          `${String(MAX_TRANSCRIPT_DETAIL_LINES)} one entry may hold. A transcript is an ` +
          `artifact a person reads and a fixture records.`,
      );
    }
    const copied: string[] = [];
    // Element by element, with the copy validated and the copy stored. A hole —
    // `new Array(1)`, validly typed and uncast — is skipped by `forEach` and
    // materialized by a spread, and an explicit `undefined` passes a regex-based
    // text check as the string "undefined". Either way the state that came back
    // could not be serialized, so `reduce` succeeded and produced something
    // unrecordable.
    for (let offset = 0; offset < lineCount; offset += 1) {
      const line = source[offset];
      if (typeof line !== "string") {
        throw new Error(
          `${where}: transcript detail line ${String(offset)} is ${
            offset in source ? typeof line : "a hole in a sparse array"
          }; every line must be a string, because state that cannot be ` +
            `serialized cannot be recorded or replayed`,
        );
      }
      if (line.length > MAX_TRANSCRIPT_LINE_LENGTH) {
        throw new Error(
          `${where}: transcript detail line ${String(offset)} is ${String(line.length)} ` +
            `characters, over the ${String(MAX_TRANSCRIPT_LINE_LENGTH)} a single line may hold.`,
        );
      }
      copied.push(line);
    }
    lines = copied;
  }

  let capturedOutput: readonly TranscriptOutput[] | undefined;
  if ((output === undefined) !== (exitCode === undefined)) {
    throw new Error(
      `${where}: structured transcript output and exitCode must either both be present or both be absent`,
    );
  }
  if (exitCode !== undefined) {
    if (
      typeof exitCode !== "number" ||
      !Number.isInteger(exitCode) ||
      exitCode < 0 ||
      exitCode > 255
    ) {
      throw new Error(
        `${where}: transcript exitCode must be an integer in [0, 255], got ${String(exitCode)}`,
      );
    }
    if (!Array.isArray(output)) {
      throw new Error(
        `${where}: structured transcript output must be an array, got ${typeof output}`,
      );
    }
    if (lines.length + output.length > MAX_TRANSCRIPT_DETAIL_LINES) {
      throw new Error(
        `${where}: this event would write ${String(lines.length + output.length)} transcript lines, over the ` +
          `${String(MAX_TRANSCRIPT_DETAIL_LINES)} one entry may hold.`,
      );
    }
    const copied: TranscriptOutput[] = [];
    const count = output.length;
    for (let offset = 0; offset < count; offset += 1) {
      if (!(offset in output)) {
        throw new Error(
          `${where}: structured transcript output[${String(offset)}] is a hole in a sparse array`,
        );
      }
      const raw: unknown = output[offset];
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error(
          `${where}: structured transcript output[${String(offset)}] must be an object`,
        );
      }
      const item = raw as TranscriptOutput;
      const stream: unknown = item.stream;
      const text: unknown = item.text;
      if (stream !== "stdout" && stream !== "stderr") {
        throw new Error(
          `${where}: structured transcript output[${String(offset)}].stream must be "stdout" or "stderr"`,
        );
      }
      if (typeof text !== "string") {
        throw new Error(
          `${where}: structured transcript output[${String(offset)}].text must be a string`,
        );
      }
      const characterCount = countCodePoints(text);
      if (characterCount > MAX_TRANSCRIPT_LINE_LENGTH) {
        throw new Error(
          `${where}: structured transcript output[${String(offset)}].text is ${String(characterCount)} characters, over the ` +
            `${String(MAX_TRANSCRIPT_LINE_LENGTH)} a single line may hold.`,
        );
      }
      copied.push(Object.freeze({ stream, text }));
    }
    capturedOutput = Object.freeze(copied);
  }

  const dispatched: EngineEvent[] = [];
  if (effects !== undefined) {
    if (!Array.isArray(effects))
      throw new Error(
        `${where}: effects must be an array, got ${typeof effects}`,
      );
    for (let offset = 0; offset < effects.length; offset += 1) {
      if (!(offset in effects))
        throw new Error(
          `${where}: effects[${String(offset)}] is a hole in a sparse array`,
        );
      const effect = effects[offset];
      if (
        typeof effect !== "object" ||
        effect === null ||
        Array.isArray(effect)
      )
        throw new Error(
          `${where}: effects[${String(offset)}] must be an event object`,
        );
      dispatched.push(effect as EngineEvent);
    }
  }

  const expanded: EngineEvent[] = [];
  if (expansion !== undefined) {
    if (!Array.isArray(expansion)) {
      throw new Error(
        `${where}: expansion must be an array, got ${typeof expansion}`,
      );
    }
    const count = expansion.length;
    for (let offset = 0; offset < count; offset += 1) {
      if (!(offset in expansion)) {
        throw new Error(
          `${where}: expansion[${String(offset)}] is a hole in a sparse array`,
        );
      }
      const child: unknown = expansion[offset];
      if (typeof child !== "object" || child === null || Array.isArray(child)) {
        throw new Error(
          `${where}: expansion[${String(offset)}] must be an event object`,
        );
      }
      expanded.push(child as EngineEvent);
    }
  }
  const fallbackEvents: EngineEvent[] = [];
  if (expansionFallback !== undefined) {
    if (expansion === undefined)
      throw new Error(`${where}: expansionFallback requires expansion`);
    if (!Array.isArray(expansionFallback))
      throw new Error(
        `${where}: expansionFallback must be an array, got ${typeof expansionFallback}`,
      );
    if (expansionFallback.length === 0)
      throw new Error(
        `${where}: expansionFallback must contain at least one logged child event`,
      );
    for (let offset = 0; offset < expansionFallback.length; offset += 1) {
      if (!(offset in expansionFallback))
        throw new Error(
          `${where}: expansionFallback[${String(offset)}] is a hole in a sparse array`,
        );
      const child = expansionFallback[offset];
      if (child === null || typeof child !== "object" || Array.isArray(child))
        throw new Error(
          `${where}: expansionFallback[${String(offset)}] must be an event object`,
        );
      fallbackEvents.push(child as EngineEvent);
    }
  }

  return {
    hasSlice: slice !== undefined,
    slice,
    summary: summary ?? "",
    detail: lines,
    output: capturedOutput,
    exitCode: exitCode as number | undefined,
    effects: dispatched,
    hasExpansion: expansion !== undefined,
    expansion: expanded,
    hasExpansionFallback: expansionFallback !== undefined,
    expansionFallback: fallbackEvents,
  };
}

/** Dispatch module-owned effects and publish their slices as one transaction. */
function applyEffects(
  before: SessionState,
  previousSlices: Readonly<Record<string, unknown>>,
  namespace: string,
  stateful: boolean,
  outer: CapturedOutcome,
  clock: ReturnType<typeof restoreClock>,
  random: ReturnType<typeof restoreRandom>,
  registry: EventRegistry,
  where: string,
): Readonly<Record<string, unknown>> {
  let slices = nextSlices(previousSlices, namespace, stateful, outer, where);
  for (let offset = 0; offset < outer.effects.length; offset += 1) {
    const envelope = assertEventEnvelope(
      outer.effects[offset] as EngineEvent,
      `${where} effect ${String(offset)}`,
    );
    const effectWhere = `${where} effect ${String(offset)} (${envelope.type})`;
    const handler = registry.handler(envelope.type);
    if (handler === undefined)
      throw new UnknownEventTypeError(
        envelope.type,
        before.eventCount,
        registry.namespaces,
      );
    if (envelope.version !== undefined && envelope.version !== handler.version)
      throw new EventVersionError(
        effectWhere,
        envelope.type,
        envelope.version,
        handler.version,
      );
    const module = registry.module(handler.namespace) as EventModule;
    const effectState: SessionState = Object.freeze({ ...before, slices });
    const effectContext: EventContext = {
      state: effectState,
      cartridge: before.cartridge,
      index: before.eventCount,
      event: envelope,
      clock,
      random: random.fork(module.namespace),
      where: effectWhere,
    };
    const effectSlice = module.stateful
      ? readSlice(effectState, module.namespace)
      : undefined;
    const clockBefore = clock.toState();
    const randomBefore = random.toState();
    const outcome = captureOutcome(
      handler.apply(effectContext, effectSlice),
      effectWhere,
    );
    if (
      serialize(clock.toState()) !== serialize(clockBefore) ||
      serialize(random.toState()) !== serialize(randomBefore)
    )
      throw new Error(
        `${effectWhere}: an effect may update only its owned slice; time and randomness belong to logged outer events`,
      );
    if (
      outcome.summary !== "" ||
      outcome.detail.length > 0 ||
      outcome.output !== undefined ||
      outcome.exitCode !== undefined ||
      outcome.hasExpansion ||
      outcome.effects.length > 0
    )
      throw new Error(
        `${effectWhere}: an effect may return only its owned slice; transcript output and nested effects belong to logged outer events`,
      );
    slices = nextSlices(
      slices,
      module.namespace,
      module.stateful,
      outcome,
      effectWhere,
    );
  }
  return slices;
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
  // Read once here and handed to `bootstrap` as values, rather than passing
  // `input` along for it to read again. `registry` in particular was read by
  // both, so a getter could bootstrap the slices under one registry and fold
  // every event under another — the same object supplying two answers to the
  // same question.
  const cartridge = input.cartridge;
  const seed = input.seed;
  const registry = input.registry ?? ENGINE_EVENT_REGISTRY;
  const events = input.events;

  let state = bootstrap({ cartridge, seed, registry });
  // `for…of` rather than `Array.prototype.reduce`, which skips holes: a sparse
  // log would silently fold fewer events than it appears to contain.
  for (const event of events) {
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
  }

  const slices = requireSlices(parsed["slices"], registry, cartridge);

  if (transcript.length === 0) {
    // A message specialization, not a redundant guard: the check below compares
    // the clock too, so it would catch a moved one — but only by reporting that
    // the state as a whole differs from bootstrap. This says which part and
    // why, for the commonest way a zero-event snapshot goes wrong, and runs
    // first for that reason.
    if (clock.elapsedMs !== 0) {
      throw new Error(
        `snapshot: the clock has advanced ${String(clock.elapsedMs)}ms but the transcript is ` +
          `empty. Time moves only when an event advances it, so a session that has folded ` +
          `nothing is still at the instant its cartridge declares.`,
      );
    }

    // With no events folded, the state is fully determined by the cartridge,
    // the seed and the registry — all three of which the snapshot carries — so
    // it can be checked against a fresh `bootstrap` in whole rather than field
    // by field. That is only possible here: at N events the state also depends
    // on the event log, which a snapshot does not contain, so there is no
    // "now do it for N" to ask for next.
    //
    // Compared through the canonical serializer because that is what the
    // snapshot is written in, so the comparison sees exactly what was recorded.
    //
    // Precisely: this check introduces no per-module narrowing of its own. It
    // does not call `validateSlice` — but the `recorded` operand's slices came
    // from `requireSlices`, which does, so the hook shapes what is compared.
    // The optionality contract in `./module.ts` is untouched either way: a
    // module that declares no validator still gets nothing narrowed, and one
    // that declares a narrowing validator sees the same values it would have
    // seen without this check. What the hook must not do is *normalize* — see
    // the residual below, which is the same fact read from the other side.
    //
    // Nor is this a hand-written rule such as "zero events means no cursors",
    // which would be wrong for a module that draws inside `initialSlice`;
    // bootstrap reproduces whatever that module does.
    //
    // The residual: a `validateSlice` that *normalizes* rather than narrows
    // would make a legitimate zero-event snapshot differ from bootstrap and
    // fail here. No module does that today, and the hook's contract says it
    // "returns it narrowed" — but it is a hook, and a future module could.
    // All three of the fields bootstrap determines — not two of them, which is
    // what let the sentence above describe the `elapsedMs` branch as subsumed
    // by a comparison that did not include the clock at all.
    //
    // Including it changes no behaviour today, and saying so is the point:
    // `ClockState` has exactly `startMs` and `elapsedMs`, the cartridge
    // cross-check above pins the first and the specialization pins the second,
    // so by here the clock is already equal to bootstrap's and no test can
    // distinguish the two forms. It is in the comparison so the comparison is
    // over everything bootstrap determines, which is what makes the claim true
    // and keeps it true if either of those two checks is ever relaxed or
    // `ClockState` grows a third field.
    const fresh = bootstrap({ cartridge, seed, registry });
    const recorded = serialize({ clock, slices, random });
    const expected = serialize({
      clock: fresh.clock,
      slices: fresh.slices,
      random: fresh.random,
    });
    if (recorded !== expected) {
      throw new Error(
        `snapshot: no events have been folded, so the state must be exactly what bootstrapping ` +
          `this cartridge and seed produces, and it is not. Recorded ${recorded}, but bootstrap ` +
          `gives ${expected}.`,
      );
    }
  }

  return freezeState({
    engineVersion,
    eventSchemaVersion,
    seed,
    cartridge,
    eventCount,
    clock,
    random,
    slices,
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
  slices: Readonly<Record<string, unknown>>,
  namespace: string,
  stateful: boolean,
  outcome: CapturedOutcome,
  where: string,
): Readonly<Record<string, unknown>> {
  // `hasSlice` is a boolean decided once by `captureOutcome`, and `outcome.slice`
  // is the value it was decided from. Asking the outcome object twice is what
  // let the guard see an object and the store see `undefined`.
  if (!outcome.hasSlice) return slices;
  if (!stateful) {
    throw new Error(
      `${where}: module ${JSON.stringify(namespace)} declares no initialSlice but its ` +
        `handler returned one, which the reducer has nowhere to keep`,
    );
  }
  return Object.freeze({
    ...slices,
    // The previous canonical slice, so the walk can stop wherever the handler
    // shared structure with it rather than rebuilding the whole tree.
    [namespace]: freezeSlice(outcome.slice, where, slices[namespace]),
  });
}

/**
 * Build one transcript entry from an already-captured outcome.
 *
 * Only the text pass is left here: `captureOutcome` has already established
 * that `summary` is a string and that `detail` is an array of strings copied
 * into a fresh array, so this reads materialized values and cannot see anything
 * a getter might change between checks.
 *
 * The text pass belongs in the reducer rather than only in the harness because
 * the reducer is where the text is created: a newline in a summary would render
 * one event as two lines, and a lone surrogate would make an artifact no
 * re-record could ever match.
 */
function makeEntry(
  index: number,
  at: string,
  type: string,
  outcome: CapturedOutcome,
  where: string,
): TranscriptEntry {
  // The emitting side of the type bound, and the load-bearing half. Round 7
  // established that a round-trip property is only available from the side that
  // produces the value: `createRegistry` also refuses an oversized type, but it
  // is not structurally the writer — `EventRegistry` is an exported plain
  // interface, so `step(state, event, handBuiltRegistry)` never passes through
  // it. Registry construction gets the check for the diagnostic; this one is
  // what makes the property hold.
  //
  // The bound is on the *stored* line. A rendered line is longer —
  // `renderEntry` prepends an index, two spaces, the instant, two spaces and
  // the type — so a maximal summary renders past this number. That gap is not
  // closed here and does not need to be: nothing validates rendered output, so
  // it is not a round-trip break.
  //
  // It is bounded, though, and this check is part of why. With `type` capped
  // here, `summary` and each detail line capped in `captureOutcome`, and `at`
  // exactly 24 characters (`MIN_EPOCH_MS`/`MAX_EPOCH_MS` confine the year to
  // 1970–9999 and `formatTimestamp` pads it to four digits), a rendered header
  // is 8225 characters for the first 10,000 events:
  // 4 + 2 + 24 + 2 + 4096 + 1 + 4096.
  //
  // It grows by one character per decade of the event index after that —
  // `8225 + max(0, digits(eventCount - 1) - 4)`, over the largest index rather
  // than the count, since the two differ at exactly the powers of ten — because
  // `INDEX_WIDTH` is a
  // minimum pad width, `padZero` is `padStart` and never truncates, and
  // `eventCount` has no ceiling: `reduce` folds an arbitrary event array and
  // `restoreSnapshot` only rejects a negative. Measured: 8225 at index 9999,
  // 8226 at 10,000, 8228 at 1,000,000. A rendered detail line is smaller
  // still, at 6 + 4096.
  if (type.length > MAX_TRANSCRIPT_LINE_LENGTH) {
    throw new Error(
      `${where}: the event type is ${String(type.length)} characters, over the ` +
        `${String(MAX_TRANSCRIPT_LINE_LENGTH)} a stored transcript line may hold.`,
    );
  }
  const summaryProblem = describeUnwritableText(outcome.summary);
  if (summaryProblem !== undefined) {
    throw new Error(`${where}: transcript summary contains ${summaryProblem}`);
  }
  outcome.detail.forEach((line, offset) => {
    const problem = describeUnwritableText(line);
    if (problem !== undefined) {
      throw new Error(
        `${where}: transcript detail line ${String(offset)} contains ${problem}`,
      );
    }
  });
  outcome.output?.forEach((line, offset) => {
    const problem = describeUnwritableText(line.text);
    if (problem !== undefined) {
      throw new Error(
        `${where}: structured transcript output line ${String(offset)} contains ${problem}`,
      );
    }
  });

  return Object.freeze({
    index,
    at,
    type,
    summary: outcome.summary,
    detail: Object.freeze([...outcome.detail]),
    ...(outcome.output === undefined
      ? {}
      : { output: outcome.output, exitCode: outcome.exitCode }),
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
 * Canonicalize and freeze a slice on its way into state.
 *
 * ## Why canonicalize, and what it does not fix
 *
 * A slice is stored as the handler built it, and a snapshot stores the
 * serializer's canonical rendering of the same thing. Those differ on four
 * axes: key order, `-0` against `0`, two properties aliasing one object, and an
 * own key whose value is `undefined` — which the serializer drops, so
 * `Object.hasOwn` answers differently before and after a round trip. A handler
 * reading `Object.keys(slice.files)` to render a directory listing is the
 * obvious `ls`, it is pure, and it printed one order live and another after a
 * refresh.
 *
 * Note what that is and is not. `reduce(cartridge, seed, log)` was never at
 * risk: two live folds agree with each other and two replays agree with each
 * other. What was false is the narrower promise at `restoreSnapshot` — that
 * restoring and continuing is the same as never having stopped. Real, and
 * strictly weaker than the payload bug this resembles.
 *
 * ## The cost, which the previous version of this comment priced wrongly
 *
 * That comment argued against deep-freezing a slice because it would walk a
 * whole simulated filesystem on every keystroke. The argument was never tested
 * against an *incremental* walk, and it is wrong for one. Handlers build slices
 * by structural sharing — `{...slice, files: {...slice.files, [path]: file}}` —
 * so passing the previous canonical slice lets the walk stop at every subtree
 * the previous one already holds. Measured on a synthetic VFS slice of 300
 * files (~478 KiB): a full deep freeze costs 0.21 ms per event, and this costs
 * 0.03 ms on a typical write. At 1200 files it is 1.08 ms against 0.20 ms. The
 * incremental walk is cheaper than the deep freeze that comment refused.
 *
 * Rebuilding through `deserialize(serialize(slice))` would also canonicalize,
 * and costs 11.7 ms and 47.3 ms on those two shapes — some forty times the
 * price already rejected — besides refusing the nested `Map` that this is
 * required to pass through.
 *
 * ## Residuals, named
 *
 * Depth stays the serializer's question. A value that is not
 * `canFreezeInPlace` — a nested `Map`, a `Date` — is left exactly as it is,
 * neither rebuilt nor frozen, and the canonical serializer refuses it at record
 * time with a JSON pointer to the path. That is a better error than this could
 * give, and it is why the top-level check below throws while the walk does not.
 *
 * A cycle is refused here rather than at record time, because a rebuild cannot
 * represent one. `active` tracks the path from the root, not every object seen,
 * so two properties referencing one object — a DAG, which structural sharing
 * produces constantly — is copied out twice rather than rejected;
 * `cloneJson` in the cartridge loader makes the same distinction for the same
 * reason.
 */
function freezeSlice(
  slice: unknown,
  where: string,
  previous?: unknown,
): unknown {
  if (typeof slice === "object" && slice !== null && !canFreezeInPlace(slice)) {
    throw new Error(
      `${where}: a module slice must be a plain object or array at its top level. This value ` +
        `keeps its contents in internal slots, so freezing it would report success while its ` +
        `contents stayed writable — the mutation this freeze exists to stop, in another ` +
        `spelling.`,
    );
  }
  return canonicalizeSlice(slice, previous, where, "", new Set<object>());
}

/** An array index as a property key: `0 … 2**32 - 2`, no leading zeros. */
const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;

/**
 * One node of the canonicalizing walk.
 *
 * `previous` is the corresponding node of the last canonical slice, or
 * `undefined` where there is none. Identity with it is the whole optimization:
 * a plain object or array this walk returned was rebuilt and frozen on an
 * earlier event, so it cannot have changed since.
 *
 * Both that argument and the cycle refusal below are about the plain data this
 * walk rebuilds, and nothing wider. A value `canFreezeInPlace` refuses — a
 * nested `Map`, a `Date` — is returned untouched and therefore unfrozen, so it
 * can change under a shortcut, and a cycle routed through one is not refused
 * here either. Both are the serializer's at record time, per the residuals note
 * on `freezeSlice`.
 */
function canonicalizeSlice(
  next: unknown,
  previous: unknown,
  where: string,
  path: string,
  active: Set<object>,
): unknown {
  // `-0` and `0` are the same JSON document and different JavaScript values;
  // the serializer normalizes, so this does too.
  //
  // Above the identity shortcut, not below it: `-0 === 0` is true, so a `-0`
  // recomputed at a position whose previous canonical value was `0` took the
  // shortcut and was stored unnormalized — the slice going stale on the one
  // axis this walk exists to fix, and only when the prior value happened to be
  // zero. `NaN` needs no such care: `NaN === NaN` is false, so it never
  // shortcuts.
  if (Object.is(next, -0)) return 0;
  if (next === previous) return next;
  if (typeof next !== "object" || next === null) return next;

  // Left alone deliberately — see the residuals note above.
  if (!canFreezeInPlace(next)) return next;

  if (active.has(next)) {
    throw new Error(
      `${where}: slice${path} contains itself. A canonical form cannot be built for a cycle, ` +
        `and a value that contains itself cannot be recorded either.`,
    );
  }
  active.add(next);
  try {
    // One reflective pass, and the same guards for an array as for an object.
    // Rebuilding is destructive in a way freezing was not: whatever this walk
    // does not copy is simply gone, silently, inside the fold — where before it
    // survived to the canonical serializer and came back as a named error with
    // a JSON pointer. Every check below exists because skipping it turned a
    // loud refusal into quiet destruction.
    const descriptors = Object.getOwnPropertyDescriptors(next);

    if (Object.getOwnPropertySymbols(descriptors).length > 0) {
      throw new Error(
        `${where}: slice${path} has a symbol-keyed property, which cannot be recorded and ` +
          `would be dropped without trace by the canonical form.`,
      );
    }

    /** Reject a property that is state but would not survive the rebuild. */
    const inertValue = (
      descriptor: PropertyDescriptor,
      at: string,
    ): unknown => {
      // Descriptors, never a property read: a getter is handler code, and
      // running it here would both execute inside the fold and let it answer
      // this walk differently from the next reader.
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        throw new Error(
          `${where}: slice${at} is an accessor. A slice is inert data; reading it would run ` +
            `code during the fold, and freezing could not make it inert.`,
        );
      }
      if (descriptor.enumerable !== true) {
        throw new Error(
          `${where}: slice${at} is a non-enumerable property. It is state the canonical form ` +
            `would drop without trace.`,
        );
      }
      return descriptor.value;
    };

    if (Array.isArray(next)) {
      const before = Array.isArray(previous) ? previous : undefined;
      const length = next.length;
      const rebuilt: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const at = `${path}[${String(index)}]`;
        const descriptor = descriptors[String(index)];
        // A hole, which the copy would materialize as `undefined`. Named here
        // rather than left to the serializer, since the fold is where it
        // entered.
        if (descriptor === undefined) {
          throw new Error(`${where}: slice${at} is a hole in a sparse array.`);
        }
        rebuilt.push(
          canonicalizeSlice(
            inertValue(descriptor, at),
            before?.[index],
            where,
            at,
            active,
          ),
        );
      }
      // Anything an array carries beyond its indices — `Object.assign([], {…})`
      // — is state, and the rebuild has nowhere to put it.
      for (const key of Object.keys(descriptors)) {
        if (key === "length") continue;
        if (!ARRAY_INDEX.test(key) || Number(key) >= length) {
          throw new Error(
            `${where}: slice${path} has a non-index property ${JSON.stringify(key)}. An array's ` +
              `extra properties cannot be recorded and would be dropped without trace.`,
          );
        }
      }
      return Object.freeze(rebuilt);
    }

    const before =
      typeof previous === "object" && previous !== null
        ? (previous as Record<string, unknown>)
        : undefined;
    // Collected and defined, never assigned by key. Assignment is unsafe the
    // moment a key comes from data: one key inherited from Object.prototype is
    // an accessor, so `rebuilt[key] = value` calls that setter instead of
    // creating an own property — the key vanishes, and with an object value the
    // rebuilt slice walks away wearing a prototype the handler chose. With a
    // primitive it is worse: the setter is a no-op, nothing throws anywhere,
    // and two different slices produce one recording.
    //
    // Reachable from ordinary text, not just from a hand-built object:
    // `deserialize` is `JSON.parse`, which does create that key as own data, so
    // `requireSlices` reaches here with it for any stateful module that
    // declares no `validateSlice` — and the hook is optional.
    //
    // The cartridge loader fixed exactly this in `objectFromEntries`, and
    // `load.test.ts` pins the key surviving as own data. This walk cited
    // `cloneJson` for its cycle-versus-DAG reasoning and did not take its
    // construction with it.
    const entries: [string, unknown][] = [];
    for (const key of Object.keys(descriptors).sort()) {
      const descriptor = descriptors[key];
      if (descriptor === undefined) continue;
      const value = inertValue(descriptor, `${path}.${key}`);
      // Dropped, matching the serializer: an own key holding `undefined` is
      // absent from the recorded form, so keeping it here is the difference
      // `Object.hasOwn` reports before and after a round trip.
      if (value === undefined) continue;
      // `hasOwn` before the read, for the same reason: a bare `before[key]`
      // would answer from Object.prototype for that one key rather than
      // reporting it absent, and hand the walk a prototype as a previous value.
      const wasThere =
        before !== undefined && Object.hasOwn(before, key)
          ? before[key]
          : undefined;
      entries.push([
        key,
        canonicalizeSlice(value, wasThere, where, `${path}.${key}`, active),
      ]);
    }
    return Object.freeze(Object.fromEntries(entries));
  } finally {
    active.delete(next);
  }
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
  if (line.length > MAX_TRANSCRIPT_LINE_LENGTH) {
    throw new Error(
      `snapshot: "${what}" is ${String(line.length)} characters, over the ` +
        `${String(MAX_TRANSCRIPT_LINE_LENGTH)} a single line may hold.`,
    );
  }
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
      const hasOutput = Object.hasOwn(entry, "output");
      const hasExitCode = Object.hasOwn(entry, "exitCode");
      if (hasOutput !== hasExitCode) {
        throw new Error(
          `snapshot: "transcript[${String(position)}]" must carry output and exitCode together or neither`,
        );
      }
      let output: readonly TranscriptOutput[] | undefined;
      let exitCode: number | undefined;
      if (hasOutput && hasExitCode) {
        const rawOutput: unknown = entry["output"];
        if (!Array.isArray(rawOutput)) {
          throw new Error(
            `snapshot: "transcript[${String(position)}].output" must be an array`,
          );
        }
        exitCode = requireInteger(
          entry["exitCode"],
          `transcript[${String(position)}].exitCode`,
        );
        if (exitCode > 255) {
          throw new Error(
            `snapshot: "transcript[${String(position)}].exitCode" must be at most 255, got ${String(exitCode)}`,
          );
        }
        const outputLines: TranscriptOutput[] = [];
        const outputCount = rawOutput.length;
        for (let offset = 0; offset < outputCount; offset += 1) {
          if (!(offset in rawOutput)) {
            throw new Error(
              `snapshot: "transcript[${String(position)}].output[${String(offset)}]" is a hole in a sparse array`,
            );
          }
          const raw: unknown = rawOutput[offset];
          const item = requireObject(
            raw,
            `transcript[${String(position)}].output[${String(offset)}]`,
          );
          const stream: unknown = item["stream"];
          if (stream !== "stdout" && stream !== "stderr") {
            throw new Error(
              `snapshot: "transcript[${String(position)}].output[${String(offset)}].stream" must be "stdout" or "stderr"`,
            );
          }
          outputLines.push(
            Object.freeze({
              stream,
              text: requireLine(
                item["text"],
                `transcript[${String(position)}].output[${String(offset)}].text`,
              ),
            }),
          );
        }
        output = Object.freeze(outputLines);
      }
      // The same ceiling `captureOutcome` applies on the way in, and the rule
      // `requireLine` states further up this file: a check belongs on both doors
      // into the transcript, not only the one the reducer writes through. Without it
      // the exported constants bound what `step` produces and not what a
      // `SessionState` may hold, which is not what a reader of them — or
      // #5–#13 — would take them to mean.
      if (lines.length + (output?.length ?? 0) > MAX_TRANSCRIPT_DETAIL_LINES) {
        throw new Error(
          `snapshot: "transcript[${String(position)}]" holds ${String(lines.length + (output?.length ?? 0))} ` +
            `lines, over the ${String(MAX_TRANSCRIPT_DETAIL_LINES)} one entry may hold.`,
        );
      }
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
        ...(output === undefined ? {} : { output, exitCode }),
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
  cartridge: LoadedCartridge,
): Readonly<Record<string, unknown>> {
  const slices = requireObject(value, "slices");
  // Namespace captured alongside its module, so the key checked against the
  // snapshot is the key the slice is stored under. With a hand-built registry
  // these are the caller's modules, and the name was read for the expected-set,
  // for the lookup, for the validator's label and for the stored key.
  const stateful = registry.modules
    .filter((module) => module.stateful)
    .map((module) => ({ namespace: module.namespace, module }));
  const expected = stateful.map((entry) => entry.namespace);
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
      stateful.map(({ namespace, module }) => {
        const raw = slices[namespace];
        // Captured. Read once to choose the branch and again to call, the
        // function checked and the function executed could differ — and its
        // output lands in state, so this is stronger than the re-reads that
        // only build a message. A second read that is not a function threw a
        // bare TypeError out of this exported entry, naming neither module nor
        // field.
        const validate = module.validateSlice;
        // `.call(module, …)` because the capture would otherwise invoke it
        // unbound, where `module.validateSlice(…)` passed the module as
        // receiver. Both construction paths bind all three callbacks, so only a
        // hand-built registry with a method-shorthand validator notices — which
        // is the failure round 9 reported and binding fixed, and this keeps
        // today's semantics exactly rather than reintroducing it. It does not
        // touch the parked thread that declines to detach the receiver.
        const validated =
          validate === undefined
            ? raw
            : validate.call(
                module,
                raw,
                `snapshot: slices.${namespace}`,
                cartridge,
              );
        // The third and last door into `slices`, and the one that was open.
        // `bootstrap` refuses an `initialSlice` returning `undefined` and
        // `captureOutcome`'s `hasSlice` refuses a handler doing it; a validator
        // could still hand one back — `(s, w) => cond ? {n: 0} : undefined`
        // typechecks with inferred `S`. The result was an own key holding
        // `undefined`, so `Object.hasOwn` answered true, the module was given
        // `undefined` from then on and behaved as if every event were its
        // first, `snapshot()` succeeded, and the *next* restore blamed registry
        // drift.
        if (validated === undefined) {
          throw new Error(
            `snapshot: slices.${namespace}: validateSlice returned undefined. A validator ` +
              `either accepts the slice, returning it, or refuses it by throwing — returning ` +
              `nothing leaves the module holding an absent slice under a key that exists.`,
          );
        }
        return [
          namespace,
          freezeSlice(validated, `snapshot: slices.${namespace}`),
        ];
      }),
    ),
  );
}
