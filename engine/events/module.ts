/**
 * The event module contract: how a subsystem adds event types to the engine.
 *
 * Ten issues after this one (#5 filesystem through #13 mind state) need to add
 * events. The obvious shape — one `switch (event.type)` in the reducer — makes
 * every subsystem edit the same function, so ten branches land in one file, the
 * reducer imports every world model in the engine, and nothing can be tested
 * without all of it. This module is the alternative: a subsystem writes a
 * *module* — a frozen value describing its namespace, its state, and its
 * handlers — and `./modules.ts` composes the modules into a registry.
 *
 * ## One identifier, four roles
 *
 * A module declares a `namespace`, and that single word is:
 *
 * - the prefix of every event type it owns (`vfs.write`), enforced by
 *   `./registry.ts`, so two subsystems cannot collide on a type name
 * - its key in `SessionState.slices`, so it is the only module that can write
 *   its own state
 * - its PRNG stream (`root/vfs`), forked for it by the reducer, so its draws
 *   cannot shift another subsystem's sequence
 * - the word that appears in errors and in fixture diffs
 *
 * The narrow spelling (`^[a-z][a-z0-9-]*$`) is what lets one identifier do all
 * four: it is a legal PRNG stream label, an unambiguous type prefix, and a
 * serializable object key that needs no escaping.
 *
 * ## Why registration order cannot matter
 *
 * A registry is built from a list, and a list has an order. Nothing about the
 * reduced state may depend on it, which is why:
 *
 * - namespaces are unique, so lookup is by exact type and never by search order
 * - each module's slice is initialized from its own `initialSlice` alone; no
 *   module sees another's during bootstrap
 * - `BootstrapContext` hands out an already-forked stream and *no* clock. Two
 *   modules drawing from a shared stream, or advancing a shared clock, during
 *   bootstrap would be the one place order could leak in. Neither is reachable.
 *
 * `./registry.test.ts` shuffles the module list and asserts the fold is
 * byte-identical.
 *
 * ## What this layer enforces, and what it cannot
 *
 * `EventModule`, `RegisteredHandler` and `EventHandlerDefinition` are plain
 * interfaces, so a caller can bypass `defineEventModule` and hand-build one.
 * Answering that object by object — freeze the module, then the handler, then
 * the receiver, then the log entry — is a losing shape: the list has no natural
 * end, and each freeze buys a guarantee narrower than it appears. This is the
 * standing answer for the whole class, so it does not get relitigated per
 * object.
 *
 * **Frozen and copied, therefore safe.** These the engine owns outright, and a
 * caller mutating its own copy afterwards changes nothing:
 *
 * - the registry's handler for a type (`registry.handler(t)`) — a frozen copy
 *   with `apply` bound at registration
 * - the registry's module (`registry.module(ns)`, `registry.modules[i]`) — a
 *   frozen copy, with `initialSlice` and `validateSlice` bound, its `types` and
 *   `handlers` copied, built from fields each read exactly once. The handler
 *   *objects* inside that record remain the module's own, which changes
 *   nothing: dispatch reads `registry.handler(t)`, never this record.
 * - everything `defineEventModule` returns
 * - every `SessionState` the reducer produces, its clock, its PRNG state, its
 *   transcript entries, its slices record and each slice one level deep
 * - an event appended through `appendEvent`, and its payload
 *
 * Two of those are copies rather than the caller's objects, which means
 * `registry.modules[i].handlers[t]` is *not* `registry.handler(t)`. Dispatch
 * only ever reads the latter.
 *
 * **Validated at construction only.** `createRegistry` checks namespace shape
 * and uniqueness, type prefixes and spelling, handler ownership, version
 * shape, and that a slice validator accompanies a slice. Those run once. They
 * are what the copies above then preserve — validating a hand-built module and
 * then holding it by reference would let every check be undone after it passed.
 *
 * **Not enforceable here, at all.** A handler that is not a pure function of
 * `(context, slice)` breaks determinism, and no freeze reaches the ways it can
 * happen: state on `this`, a captured closure variable, a module-level `let`,
 * or any object the caller held before it ever reached the engine. `Object.freeze`
 * is shallow, and two of those routes never touch a freezable object. This is a
 * contract, stated on `EventHandlerDefinition.apply` and implied by invariant 2
 * — the golden replay suite is what actually catches a violation, by folding
 * every fixture twice and comparing bytes.
 *
 * The dividing line is ownership, not danger: the engine hardens what it
 * produces, validates what it is handed at the boundary, and relies on a stated
 * contract for what remains the caller's.
 *
 * ## Where the validating stops, and why
 *
 * The sentence above about freezing — *the list has no natural end, and each
 * freeze buys a guarantee narrower than it appears* — was written about
 * freezing, and it is now equally true of validating. Two things are
 * deliberately left unchecked, named here so they read as a boundary rather
 * than as omissions:
 *
 * - **Unknown top-level fields in a snapshot** are dropped rather than
 *   rejected, even though `requireSlices` rejects unknown slice keys and the
 *   cursor check rejects unknown stream namespaces. The inconsistency is real
 *   and accepted: `ENGINE_VERSION` is the designated defence against a snapshot
 *   from a different engine, so what remains is a hand-typed key, and the only
 *   harm is that `snapshot(restoreSnapshot(text))` may not equal `text` — a
 *   round trip nothing claims.
 * - **Exhaustive field-shape validation of a hand-built module.** Every field
 *   `defineEventModule` and `createRegistry` *dereference* is guarded, so no
 *   malformed module produces a bare `TypeError` **along the module and handler
 *   construction path** — which is the path those two functions own, and not a
 *   claim about the engine at large. Fields they merely read — a
 *   `description` that is not a string, a `stateful` flag that is not a boolean
 *   — are not, because they cannot throw. One route does change a fold, and is
 *   named here rather than glossed: spreading a stateful module with
 *   `{...module, stateful: false}` type-checks, and its handler then receives
 *   `undefined` for a slice. It is deterministic and it round-trips, so it is
 *   a type lie rather than a determinism break, and it takes deliberately
 *   overriding a flag the engine derived — but it is the one type-clean route
 *   this boundary does not close.
 *   Guarding the flag's *shape* would not close it either: it would close the
 *   cast-only route while leaving that one open, which is the wrong half of
 *   the problem. The type-clean route that mattered — a declared
 *   `initialSlice` returning `undefined` — is what `bootstrap` refusing it
 *   actually closes.
 *
 * What covers the rest is not another guard. It is `ENGINE_VERSION` for the
 * cross-engine case, and the golden replay suite for everything behavioural —
 * every fixture folded twice from frozen inputs and compared byte for byte.
 */

import type { LoadedCartridge } from "../cartridge/types.js";
import type { SimulatedClock } from "../clock/clock.js";
import type { RandomStream } from "../random/stream.js";
// A value import, where `./registry.ts` takes only types from here — so the
// dependency runs one way at runtime and there is no cycle. One error type for
// "this module is malformed" is worth more than keeping the edge type-only.
import { EventRegistryError } from "./registry.js";
import type { EngineEvent, SessionState } from "./state.js";

/**
 * What a module may read while building its initial slice.
 *
 * Deliberately not an `EventContext`: bootstrap is a single instant with no
 * event behind it. There is no clock to advance (the session has not started
 * moving) and no other slice to read (they are being built in parallel, and
 * reading one would make the answer depend on list order).
 */
export interface BootstrapContext {
  readonly cartridge: LoadedCartridge;
  readonly seed: string;
  /** Epoch milliseconds the cartridge declares the session starts at. */
  readonly startedAtMs: number;
  /** This module's own stream, `root/<namespace>`. Drawing here is fine. */
  readonly random: RandomStream;
}

/** What a handler is given when its event is folded in. */
export interface EventContext {
  /**
   * The whole session as it stood *before* this event.
   *
   * Read-only, and the way to read another subsystem's state. The reducer
   * discards anything a handler tries to write here — the only writable thing
   * is the slice it returns.
   */
  readonly state: SessionState;
  /** Convenience for `state.cartridge`; the world every handler reads. */
  readonly cartridge: LoadedCartridge;
  /** This event's position in the log, from zero. */
  readonly index: number;
  readonly event: EngineEvent;
  /**
   * The session clock, shared by every module because time is one timeline.
   *
   * Advancing it is how an event takes simulated time. A `git log` is
   * instantaneous; a simulated test run is not. That judgement belongs to the
   * subsystem raising the event, not to the reducer.
   */
  readonly clock: SimulatedClock;
  /** This module's own stream, `root/<namespace>`. Fork it further as needed. */
  readonly random: RandomStream;
  /** `event 3 (clock.tick)` — the prefix every error message from here starts with. */
  readonly where: string;
}

/**
 * What a handler returns.
 *
 * Every field is optional, and an empty outcome is meaningful: an event that
 * changes nothing and says nothing still advances the log and still produces a
 * transcript entry, because the transcript's index has to keep matching the
 * event's.
 */
export interface EventOutcome<S> {
  /** The module's new slice. Omitted means unchanged. */
  readonly slice?: S;
  /** Appended to this entry's transcript header line. */
  readonly summary?: string;
  /** Further transcript lines belonging to this entry. */
  readonly detail?: readonly string[];
  /**
   * Additional module-owned transitions committed with this event.
   *
   * Effects are for atomic cross-slice mechanics such as Git checkout writing
   * through the VFS. The reducer dispatches each effect to its registered
   * owner, publishes no intermediate state, and records only the outer event.
   * An effect may return only a slice: transcript output and nested effects are
   * refused so hidden events cannot become an unbounded second event log.
   */
  readonly effects?: readonly EngineEvent[];
}

/** One event type's implementation. */
export interface EventHandlerDefinition<S> {
  /**
   * This event type's payload schema version.
   *
   * Bump it when the payload's meaning changes in a way that would silently
   * reinterpret an existing log — a renamed field, a unit change, a default
   * that moved. A recorded event stamped with an older number is then refused
   * instead of replayed wrong.
   */
  readonly version: number;
  /**
   * Fold this event in.
   *
   * **A handler must be a pure function of `(context, slice)`.** Everything it
   * reads has to arrive through those two arguments; everything it changes has
   * to leave through its return value. The clock and the PRNG are the two
   * deliberate exceptions — live handles scoped to this one call, whose
   * positions the reducer takes afterwards. Never edit what you were given.
   *
   * That rule is wider than it looks, and this layer cannot enforce any of it.
   * Reading mutable state through `this`, through a closure variable, or
   * through a module-level binding breaks determinism in exactly the same way:
   * two folds of one event log produce two different sessions, the golden
   * fixture records whichever ran first, and nothing in the diff says why.
   * Freezing the handler object would close none of those — it is shallow, and
   * two of the three routes never touch it — so the contract is stated here
   * rather than half-enforced. Invariant 2 is the general form of it.
   *
   * A stateless module's handler simply omits the `slice` parameter.
   */
  apply(context: EventContext, slice: S): EventOutcome<S>;
}

/** A subsystem's events and state, as its author writes them. */
export interface EventModuleDefinition<S> {
  /** `^[a-z][a-z0-9-]*$`. See the header: this word does four jobs. */
  readonly namespace: string;
  /** One line, for the reader of a registry listing or an error. */
  readonly description: string;
  /**
   * Build this module's initial state. Omit it for a module that has none —
   * the slices record then carries no key for it at all, rather than a null.
   */
  readonly initialSlice?: (context: BootstrapContext) => S;
  /**
   * Check a slice arriving from a snapshot, and return it narrowed.
   *
   * **Optional, and deliberately so.** `restoreSnapshot` rebuilds the cartridge,
   * the clock and the PRNG through their own validators, but a slice is a shape
   * only its module knows — the reducer can confirm the *set* of slices matches
   * the registry and nothing more. Without this hook a snapshot claiming
   * `{ events: "oops" }` restores cleanly and the next event folds `"oops1"`
   * into recorded state.
   *
   * A module that omits it keeps today's behaviour exactly: its slice is taken
   * as read. The hook exists now so #5–#13 can implement it as they are
   * written, rather than it being retrofitted across ten shipped subsystems.
   *
   * `where` is a message prefix such as `snapshot: slices.probe`; throw with it
   * so the reader learns which slice was wrong, not only that one was.
   *
   * Only meaningful alongside `initialSlice` — `createRegistry` rejects a
   * stateless module that declares one, since it would never be called.
   *
   * **Narrow, do not normalize.** A zero-event snapshot is checked whole
   * against a fresh `bootstrap`, and that comparison does not call this hook —
   * so a validator that *rewrote* its slice rather than merely accepting or
   * refusing it would make a legitimate zero-event snapshot differ from
   * bootstrap and fail to restore. No module does that today, and "returns it
   * narrowed" is the contract; the carve-out is written down because this is a
   * hook and a future module could.
   */
  readonly validateSlice?: (slice: unknown, where: string) => S;
  /** Keyed by full event type (`vfs.write`), not by the part after the dot. */
  readonly events: Readonly<Record<string, EventHandlerDefinition<S>>>;
}

/** One registered event type, with its slice type erased. */
export interface RegisteredHandler {
  readonly type: string;
  readonly namespace: string;
  readonly version: number;
  apply(context: EventContext, slice: unknown): EventOutcome<unknown>;
}

/**
 * A module with its slice type erased, which is what a registry can hold.
 *
 * `EventModuleDefinition<S>` is invariant in `S`, so a heterogeneous list of
 * them has no useful common type. `defineEventModule` performs the erasure once,
 * at the definition site, where `S` is still known.
 */
export interface EventModule {
  readonly namespace: string;
  readonly description: string;
  /** Whether this module occupies a key in `SessionState.slices`. */
  readonly stateful: boolean;
  /** `undefined` for a stateless module. */
  initialSlice(context: BootstrapContext): unknown;
  /** Absent when the module declares no slice validator. See the definition. */
  readonly validateSlice?: (slice: unknown, where: string) => unknown;
  /** Every type this module owns, sorted. */
  readonly types: readonly string[];
  readonly handlers: Readonly<Record<string, RegisteredHandler>>;
}

/**
 * Declare a subsystem's events.
 *
 * The returned value is frozen, so a consumer cannot add a handler to a module
 * after the fact — the registry would then describe a set of event types the
 * module's own file does not. `engine/pattern.ts` makes the same argument about
 * validators for the same reason.
 *
 * What that freeze does **not** cover is the handler definitions themselves,
 * which the caller owns and this function only reads. A handler that keeps
 * mutable state — on `this`, in a closure, or in a module-level binding — will
 * fold the same event log two different ways, and no amount of freezing here
 * would change that: `Object.freeze` is shallow, and two of those three routes
 * never touch the handler object at all. The requirement is stated on
 * `EventHandlerDefinition.apply`: a handler is a pure function of
 * `(context, slice)`. This layer relies on it rather than checking it.
 *
 * Nothing is validated here; `createRegistry` does that, so a namespace typo is
 * reported once, against the whole registry, with the other modules' namespaces
 * in the message.
 */
export function defineEventModule<S>(
  definition: EventModuleDefinition<S>,
): EventModule {
  // Two guards, and only two. Validation is `createRegistry`'s job — but that
  // only holds for what this function passes *through*, and these two it
  // dereferences: `Object.entries(null)` and `.bind()` on a non-function both
  // throw bare TypeErrors here, so a malformed definition would never reach the
  // validator that is supposed to describe it.
  // Read once, then used everywhere below. `namespace` was read per handler
  // *and* again for the module, so a getter could stamp one namespace into a
  // handler and another into the module — and `createRegistry` then reported a
  // prefix mismatch naming a namespace the author never wrote.
  const namespace = definition.namespace;
  const description = definition.description;
  const events: unknown = definition.events;
  if (typeof events !== "object" || events === null || Array.isArray(events)) {
    throw new EventRegistryError(
      `module ${JSON.stringify(namespace)} must declare its events as an object keyed ` +
        `by full event type, got ${Array.isArray(events) ? "an array" : typeof events}`,
    );
  }

  // `events`, not `definition.events` — here and at `types` below. Re-reading
  // the property after guarding it is the validate-then-use gap this function
  // already closes elsewhere: a getter returning an object to the check and
  // `null` here would throw the bare TypeError the check exists to prevent.
  const guardedEvents = events as EventModuleDefinition<S>["events"];

  // Enumerated exactly once. `Object.entries` for the handlers and
  // `Object.keys` for the types walked the same object twice, so a getter
  // could hand out one set of keys to each — and `createRegistry` then blamed
  // the module for a mismatch the front door had produced.
  const declaredEvents = Object.entries(guardedEvents);

  const handlers = Object.fromEntries(
    declaredEvents.map(([type, handler]) => {
      // Resolved here, once, rather than read off `handler` at dispatch time.
      // The module and this wrapper are frozen; the *definition's* handler
      // object is not, and a late-bound `handler.apply(…)` would look it up
      // again on every event — so reassigning it after `createRegistry` would
      // change how a session folds while every frozen surface still reported
      // the module as sealed.
      //
      // `bind` rather than a bare `const fn = handler.apply`: the bare form
      // silently drops the receiver, so the first handler written in method
      // shorthand that touches `this` would break for a reason nothing in this
      // file explains. No handler in the repository uses `this`; that is a
      // fact about today, not a property of the contract.
      const declaredApply: unknown = handler?.apply;
      if (typeof declaredApply !== "function") {
        throw new EventRegistryError(
          `handler ${JSON.stringify(type)} has no apply function, got ${typeof declaredApply}. ` +
            `A handler that cannot be called is an event type that cannot be folded.`,
        );
      }
      const apply = (declaredApply as EventHandlerDefinition<S>["apply"]).bind(
        handler,
      );
      return [
        type,
        Object.freeze({
          type,
          namespace,
          version: handler.version,
          // The one cast in the extension point, and it is sound by
          // construction: `bootstrap` seeds this module's slice from the
          // `initialSlice` right above, and `step` only ever hands a handler
          // the slice its own module produced. Nothing else can reach it —
          // that is what the namespace key in `SessionState.slices` buys.
          apply: (
            context: EventContext,
            slice: unknown,
          ): EventOutcome<unknown> => apply(context, slice as S),
        }),
      ];
    }),
  );

  // Checked before wrapping, and that order is the whole point. The wrappers
  // below are functions whatever they close over, so wrapping an
  // `initialSlice: 42` produces something `createRegistry`'s
  // `typeof initialSlice !== "function"` guard accepts — the value is laundered
  // straight past the check added for it, and surfaces instead as a bare
  // TypeError at bootstrap, mid-fold, naming no module. A wrapper must never be
  // the thing a downstream type check sees.
  const initialSlice = definition.initialSlice;
  if (initialSlice !== undefined && typeof initialSlice !== "function") {
    throw new EventRegistryError(
      `module ${JSON.stringify(namespace)} has an initialSlice that is not a ` +
        `function, got ${typeof initialSlice}. Omit it entirely for a module that holds no state.`,
    );
  }
  const validateSlice = definition.validateSlice;
  if (validateSlice !== undefined && typeof validateSlice !== "function") {
    throw new EventRegistryError(
      `module ${JSON.stringify(namespace)} has a validateSlice that is not a ` +
        `function, got ${typeof validateSlice}. Omit it entirely for a module that does not ` +
        `validate its slice.`,
    );
  }

  // Bound to the definition, exactly as `apply` is above and as
  // `createRegistry` already binds all three. TypeScript accepts method
  // shorthand on every callback here and contextually types `this` as the
  // definition object, so `initialSlice() { return { n: this.start }; }` is
  // type-clean code — and calling it unbound threw
  // `Cannot read properties of undefined` out of `bootstrap`, naming no module,
  // while the hand-built path through `createRegistry` worked. The two
  // construction paths disagreed and the front door was the broken one.
  //
  // Receivers are therefore supported uniformly across all three callbacks.
  // That widens the surface, and the answer to it is unchanged and stated
  // rather than implied: purity is a contract this layer cannot enforce — see
  // `EventHandlerDefinition.apply`, whose paragraph covers `this`, a closure,
  // and a module-level binding alike, for all three.
  const boundInitialSlice = initialSlice?.bind(definition);
  const boundValidateSlice = validateSlice?.bind(definition);

  return Object.freeze({
    namespace,
    description,
    stateful: boundInitialSlice !== undefined,
    initialSlice: (context: BootstrapContext): unknown =>
      boundInitialSlice === undefined ? undefined : boundInitialSlice(context),
    // Same late-binding argument as `apply`, and the same fix: captured now,
    // so what `restoreSnapshot` runs is what the module declared.
    ...(boundValidateSlice === undefined
      ? {}
      : {
          validateSlice: (slice: unknown, where: string): unknown =>
            boundValidateSlice(slice, where),
        }),
    types: Object.freeze(declaredEvents.map(([type]) => type).sort()),
    handlers: Object.freeze(handlers),
  });
}
