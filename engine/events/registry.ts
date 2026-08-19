/**
 * The event registry: a set of modules, checked once and then read-only.
 *
 * Building it is where every rule the extension point relies on is enforced,
 * and it happens once at module load rather than per event — so a namespace
 * collision is a startup failure with both offenders named, not a mystery in
 * the middle of a replay.
 *
 * The registry is a value, not a global side effect. `registerEvent()` calls at
 * import time would make the engine's behaviour depend on which modules
 * happened to be imported, and in what order — the same class of bug the seeded
 * PRNG's named streams exist to avoid. Here the list is explicit
 * (`./modules.ts`), a test can build a different one, and two lists in
 * different orders produce registries that answer identically.
 *
 * Everything this function returns is a frozen copy rather than the caller's
 * object, because `EventModule` is an interface a caller can satisfy by hand
 * and this function spends its whole length validating one. `./module.ts` →
 * "What this layer enforces, and what it cannot" is the full account of that
 * boundary; the comments below give the per-check reasoning.
 */

import type { EventModule, RegisteredHandler } from "./module.js";
import { MAX_TRANSCRIPT_LINE_LENGTH } from "./transcript.js";

/**
 * A namespace is one lowercase word.
 *
 * No dot, because the namespace is the part of an event type *before* the first
 * dot and a dotted namespace would make `a.b.c` ambiguous. No uppercase and no
 * underscore, because the same word is a PRNG stream label
 * (`engine/random/stream.ts` pins that spelling) and a key in serialized state.
 */
const NAMESPACE_SHAPE = /^[a-z][a-z0-9-]*$/;

/**
 * The part of an event type after the namespace. Dots are allowed here so a
 * subsystem can group its own types (`git.branch.create`).
 */
const EVENT_NAME_SHAPE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;

/**
 * Thrown while building a module or a registry. Always a programming error,
 * never data — a cartridge cannot reach this, only engine or subsystem code can.
 */
export class EventRegistryError extends Error {
  constructor(detail: string, options?: ErrorOptions) {
    super(`event registry: ${detail}`, options);
    this.name = "EventRegistryError";
  }
}

export interface EventRegistry {
  /** Every module, sorted by namespace. */
  readonly modules: readonly EventModule[];
  /** Every namespace, sorted. */
  readonly namespaces: readonly string[];
  /** Every registered event type, sorted. */
  readonly types: readonly string[];
  /** The handler for `type`, or `undefined` — the caller decides how to fail. */
  handler(type: string): RegisteredHandler | undefined;
  module(namespace: string): EventModule | undefined;
}

/**
 * Compose modules into a registry.
 *
 * @throws EventRegistryError if any module is malformed or two collide.
 */
export function createRegistry(modules: readonly EventModule[]): EventRegistry {
  // The argument itself, before the loop that reads it. `createRegistry` is
  // exported, so a caller can hand it anything; a non-iterable would otherwise
  // throw a bare TypeError out of `for…of` — the one rough edge left after
  // every field on a hand-built module gained a named guard.
  const candidateModules: unknown = modules;
  if (candidateModules === null || candidateModules === undefined) {
    throw new EventRegistryError(
      `the module list must be iterable, got ${candidateModules === null ? "null" : "undefined"}`,
    );
  }
  // Materialized here, and the guard is this `try` rather than a `typeof`
  // check on `Symbol.iterator`. Reading that method to check it and then
  // spreading reads it twice, so a getter could answer "function" to the guard
  // and something else to the spread — producing exactly the bare
  // `TypeError: modules is not iterable` the guard exists to prevent, in the
  // guard's own words.
  //
  // The trade: any throw from materializing the list is reported as
  // "not iterable", so a generator that yields two modules and then throws a
  // real error is misdescribed. `cause` carries the original, and this is the
  // better half of the trade against a double read that produced the exact
  // failure the guard names.
  let listed: readonly unknown[];
  try {
    listed = [...(candidateModules as Iterable<unknown>)];
  } catch (cause) {
    throw new EventRegistryError(
      `the module list must be iterable, got ${typeof candidateModules}`,
      { cause },
    );
  }

  // Entry shape before anything else, because the sort below orders by
  // `namespace` — so a module that is not an object, or whose namespace is not
  // a string, would throw out of `sort` before a single check could name it.
  //
  // Decorate-sort-undecorate: the namespace is *captured* here and everything
  // afterwards uses the capture. A comparator re-reading `entry.namespace`
  // would read it a second time and the main loop a third, so a getter could
  // pass this check, throw a bare TypeError inside `sort`, or — worse — sort
  // under one value and register under another. This file's own rule, stated
  // where the module fields are captured below, is that every field is read
  // exactly once before anything is validated against it; `namespace` is the
  // field that has to prove it first.
  const decorated = listed.map((entry) => {
    const candidate: unknown = entry;
    if (typeof candidate !== "object" || candidate === null) {
      throw new EventRegistryError(
        `a module must be an object, got ${typeof candidate === "object" ? "null" : typeof candidate}`,
      );
    }
    const namespace: unknown = (candidate as EventModule).namespace;
    if (typeof namespace !== "string") {
      throw new EventRegistryError(
        `a module's namespace must be a string, got ${typeof namespace}. It is read before ` +
          `anything else here, because it is what the module list is sorted by.`,
      );
    }
    return { namespace, declared: candidate as EventModule };
  });

  // Sorted by namespace, so every listing this registry produces — error
  // messages, the slices record built at bootstrap, a debug dump — reads the
  // same whichever order the caller assembled the list in.
  const sorted = decorated.sort((left, right) =>
    left.namespace < right.namespace
      ? -1
      : left.namespace > right.namespace
        ? 1
        : 0,
  );

  const byNamespace = new Map<string, EventModule>();
  const byType = new Map<string, RegisteredHandler>();

  const registered: EventModule[] = [];

  for (const { namespace, declared } of sorted) {
    // Every field read exactly once, into a local, before anything is validated
    // against it. A hand-built `EventModule` can define these as getters, and
    // validating one value while storing another is the same hazard
    // `assertEventEnvelope` closes for the event envelope. `namespace` was
    // captured above, before the sort, and is not re-read here.
    //
    // The rule, in two clauses, because one sentence has twice failed to hold
    // all of it:
    //
    // **1. Every value the engine takes from a caller-owned object is captured
    // once, and every later use of it — validation, storage, arithmetic and
    // diagnostics alike — is of the capture.** Diagnostics are in that list on
    // purpose: an error naming a value that was never the one that failed is a
    // member of this family, not a lesser cousin of it. So is a value used and
    // never stored, and a value stored and never validated.
    //
    // That is a property the engine *maintains* as of this commit, not a
    // property of the design, and nothing enforces it.
    //
    // How it was established, and what that method does not see: a sweep over
    // the receiver names caller-owned values are read through — `module.`,
    // `handler.`, `registry.`, `outcome.`, `definition.`, `input.`,
    // `declared.`, `entry.`, `state.`, `event.`, `payload.`, `slice.`,
    // `civil.`, `material.`, `cartridge.`, `clock.` — across non-test engine
    // sources. Sixteen receiver names are not a warrant for a claim that
    // ranges over every caller-owned value, and the gap is specific:
    // **aliasing a caller-owned value into a local renames the receiver and
    // escapes the sweep entirely.** `readWeightedEntries` did exactly that,
    // binding `payload["entries"]` to `raw` and then to `items`, and its
    // unguarded `items.length` survived seven review passes because of it.
    // `validateProbeSlice` did it twice over, aliasing to `record` and reading
    // through bracket notation.
    //
    // Two boundaries, so the claim has them rather than implying none.
    //
    // Clause 1 says nothing about *ordering*, and that is a separate hole
    // rather than a weaker corner of this one. A reflective snapshot —
    // `Object.keys`, `getOwnPropertyNames`, a `length` read — taken after
    // caller code may have run describes a different object than the one that
    // was validated, and no amount of capturing fixes it. Nor does ordering
    // alone: `validateProbeSlice` had that shape twice over, since reading the
    // key set after the values let a getter `delete` a sibling and reading it
    // first let a getter `add` one. The defence is a single
    // `getOwnPropertyDescriptors` pass with accessors refused and every value
    // read out of the snapshot — the pattern `ownProperties` in
    // `engine/serialize/canonical.ts` and `canonicalizeSlice` in
    // `engine/events/reduce.ts` use, which `validateProbeSlice` now adopts.
    //
    // A `Proxy` is outside all of this, and note what that does and does not
    // mean — the paragraph below is right that an accessor alone can vary a
    // `length`, so Proxy is not the line at which caller influence begins. It
    // is the line at which detection stops: a proxy can answer differently on
    // reads with no caller code between them, which nothing in-language can
    // observe. `engine/serialize/canonical.ts` records that decision and
    // `engine/freeze.ts` points at it.
    //
    // Nothing mechanically enforces this family, and the purity gate is not
    // that enforcement: it is a text rule, and how many times a value is read
    // is a semantic question no text rule can answer. It does act on the
    // adjacent Proxy question, through `proxy-reflection`, which is the one
    // part of this a grep can reach.
    //
    // So a new read of a caller-owned field in a later issue
    // is a new member of this family and its author's responsibility, the same
    // way `probe.ts` makes bounding a new counter the responsibility of the
    // module that adds one. Stated as a prediction about code nobody has
    // written, this sentence was false six rounds running; stated as an
    // obligation, it is something #5–#13 can actually hold to.
    //
    // **2. The reads the engine cannot capture ahead of time are the array
    // iterator protocol's own — `length` and `next`.** What it guarantees there
    // instead is that any count it checks a bound against is the count it then
    // uses. No divergence has been constructed through `next`; it is named
    // because the clause should describe the protocol rather than the one part
    // of it that has bitten.
    //
    // Two earlier wordings failed. "Read exactly once" is false by
    // construction, since `Array.prototype[Symbol.iterator]` re-reads `length`
    // every step — which is why `appendEvent`'s test asserts that its label and
    // its append agree rather than counting reads. "The value validated is the
    // value stored" then permitted three members of this very list: `step`'s
    // cartridge is never validated, `pick`'s length is never stored, and the
    // handler `type`/`namespace` re-reads only build a message.
    //
    // Clause 2 is an exemption, not an argument that the hazard is
    // unreachable. It would be wrong to say a Proxy is needed to make `length`
    // vary — it is writable, and an index accessor mutating during iteration
    // varies it from ordinary plain-array parts. `captureOutcome` was
    // subverted exactly that way. The purity gate is no help either: it scans
    // engine sources, and everything this discipline defends against is a
    // caller's object.
    //
    // What is safe to re-read afterwards, and why, differs per value.
    // `module.types` is a fresh array this function built, so it is the
    // engine's own. `module.handlers` is *not* — `Object.freeze({...handlers})`
    // is shallow, so `module.handlers[type]` hands back the caller's handler
    // object. Re-reading it is safe because each of its fields is captured once
    // below before anything is validated against it, which is the discipline
    // again rather than an exemption from it.
    //
    // Descriptor refusal is not available as an alternative here: an inherited
    // getter returns `undefined` from `getOwnPropertyDescriptor`, so the check
    // passes and the re-reads stay live. `log.ts` litigates the same point.
    // Capture is the idiom.
    const description = declared.description;
    const stateful = declared.stateful;
    const declaredList: unknown = declared.types;
    const handlers = declared.handlers;
    const validateSlice = declared.validateSlice;
    const initialSlice = declared.initialSlice;

    // Checked before the spread, which is what would throw on a non-iterable,
    // and before the element loop below, where `type.startsWith` would throw on
    // anything that is not a string.
    if (!Array.isArray(declaredList)) {
      throw new EventRegistryError(
        `module ${JSON.stringify(namespace)} must declare its types as an array, got ` +
          `${typeof declaredList}`,
      );
    }
    // Built from the values this loop captured, not spread again afterwards.
    // A second pass over the same array reads every element twice, so a getter
    // could show a string to the check and something else to the copy.
    const captured: string[] = [];
    for (const type of declaredList as readonly unknown[]) {
      if (typeof type !== "string") {
        throw new EventRegistryError(
          `module ${JSON.stringify(namespace)} declares a type that is not a string, got ` +
            `${typeof type}. Event types appear verbatim in recorded transcripts.`,
        );
      }
      // An event type is copied verbatim into every transcript entry it
      // produces, so a type longer than a stored line makes an entry the
      // reducer writes and `restoreSnapshot` then refuses. Same constant as the
      // transcript's, deliberately: two ceilings guessing at one number is how
      // `MAX_PROBE_COUNT` came to contradict the line budget.
      //
      // This transitively bounds a namespace too — every type must be prefixed
      // with its module's namespace and `types` may not be empty — so no
      // separate namespace ceiling is needed, and adding one would be the
      // second guess again.
      if (type.length > MAX_TRANSCRIPT_LINE_LENGTH) {
        throw new EventRegistryError(
          `module ${JSON.stringify(namespace)} declares a type of ${String(type.length)} ` +
            `characters, over the ${String(MAX_TRANSCRIPT_LINE_LENGTH)} a stored transcript ` +
            `line may hold. Every entry the type produces would be unrecordable.`,
        );
      }
      captured.push(type);
    }
    const types = Object.freeze(captured);

    if (!NAMESPACE_SHAPE.test(namespace)) {
      throw new EventRegistryError(
        `namespace ${JSON.stringify(namespace)} must match ${String(NAMESPACE_SHAPE)}. ` +
          `It is also a PRNG stream label and a key in serialized state, so anything ` +
          `needing escaping in either is a namespace that should be spelled differently.`,
      );
    }
    // Uniqueness of namespaces is what makes uniqueness of *types* free: every
    // type is prefixed with its module's namespace, so two modules can only
    // collide on a type if they collide on a namespace first.
    if (byNamespace.has(namespace)) {
      throw new EventRegistryError(
        `two modules claim the namespace ${JSON.stringify(namespace)}. A namespace ` +
          `owns an event-type prefix, a slice of session state, and a PRNG stream; ` +
          `sharing one would mean two subsystems overwriting each other's state.`,
      );
    }
    // Required by the interface, but the interface is one a caller can satisfy
    // by hand — and binding a missing one below would throw a bare TypeError
    // out of registry construction instead of saying what is wrong.
    if (typeof validateSlice !== "function" && validateSlice !== undefined) {
      throw new EventRegistryError(
        `module ${JSON.stringify(namespace)} has a validateSlice that is not a function, got ` +
          `${typeof validateSlice}. Omit it entirely for a module that does not validate its slice.`,
      );
    }
    if (typeof initialSlice !== "function") {
      throw new EventRegistryError(
        `module ${JSON.stringify(namespace)} has no initialSlice function. A module with no ` +
          `state returns undefined from it; omitting it entirely leaves nothing to call.`,
      );
    }

    // Stored as a frozen copy, exactly as handlers are below, and for the same
    // reason: `createRegistry` spends this whole function validating a
    // hand-built module, and holding the caller's object afterwards would let
    // every one of those checks be undone after it passed. Swapping
    // `initialSlice` post-registration rewrote a bootstrap slice; swapping
    // `namespace` re-forked the PRNG stream; setting `stateful` false made
    // `step` throw.
    //
    // So `registry.modules[i]` is a copy, like `registry.handler(t)` — and the
    // `handlers` record is a frozen copy too. An earlier version left it as the
    // module's own on the grounds that dispatch never reads it (that goes
    // through `byType`), which was true and still made the standing answer in
    // `./module.ts` false: a hand-built module could add `alpha.late` to
    // `registry.modules[0].handlers` after registration, so a record the engine
    // presents as its own would list a type it will not dispatch. Copying costs
    // one shallow object per module and makes "frozen and copied, therefore
    // safe" simply true of the whole value.
    //
    // Shallow, deliberately: the handler objects inside are the module's own,
    // and freezing those is the `EventHandlerDefinition` case that was
    // considered and rejected. Nothing reads them — `byType` holds the frozen
    // bound copies dispatch uses — so what they contain cannot affect a fold.
    const module: EventModule = Object.freeze({
      namespace,
      description,
      stateful,
      initialSlice: initialSlice.bind(declared),
      ...(validateSlice === undefined
        ? {}
        : { validateSlice: validateSlice.bind(declared) }),
      types,
      handlers: Object.freeze({ ...handlers }),
    });
    byNamespace.set(namespace, module);
    registered.push(module);

    if (types.length === 0) {
      throw new EventRegistryError(
        `module ${JSON.stringify(module.namespace)} registers no event types. An empty ` +
          `module is either an unfinished subsystem or a stale entry in the module list.`,
      );
    }
    // A slice validator on a module with no slice would never run, and its
    // author would believe their snapshot was being checked. Refusing is
    // cheaper than a hook that silently does nothing.
    if (!module.stateful && module.validateSlice !== undefined) {
      throw new EventRegistryError(
        `module ${JSON.stringify(module.namespace)} declares validateSlice but no initialSlice, ` +
          `so it holds no slice for a snapshot to carry and the validator could never run.`,
      );
    }

    // `types` compared against its canonical form rather than against a set.
    // `EventModule.types` is documented as "every type this module owns,
    // sorted", and that one sentence has three properties in it: the two lists
    // agree in both directions, there are no duplicates, and the order is
    // sorted. Set equality checked the first and nothing else, so an unsorted
    // or duplicated hand-built list was accepted while the doc said otherwise —
    // two members of one sentence, and fixing either alone leaves the other.
    //
    // One comparison covers all three, at fewer check-points than the two it
    // replaces. The lists are still diffed afterwards so a caller who forgot a
    // handler and one who listed a stray type get different sentences; a bare
    // inequality would be a worse error than either.
    const canonicalTypes = Object.keys(module.handlers).sort();
    // Element-wise, not a joined comparison. Joining needs a separator no
    // event type can contain, and at this point in construction the elements
    // are known to be strings and nothing else — the prefix check,
    // EVENT_NAME_SHAPE and the handler lookup all run later, against the copy.
    // So a joined form would rest on picking the right magic character, and
    // this rests on nothing. (It also keeps the file free of one: an earlier
    // version used a NUL separator, which renders as whitespace everywhere it
    // is reviewed and makes grep treat the whole file as binary.)
    const sameTypes =
      module.types.length === canonicalTypes.length &&
      module.types.every((type, index) => type === canonicalTypes[index]);
    if (!sameTypes) {
      const declaredTypes = new Set(module.types);
      const handled = new Set(canonicalTypes);
      const unlisted = canonicalTypes.filter(
        (type) => !declaredTypes.has(type),
      );
      const unhandled = module.types.filter((type) => !handled.has(type));
      if (unlisted.length > 0) {
        throw new EventRegistryError(
          `module ${JSON.stringify(namespace)} has handler(s) for ${unlisted.join(", ")} that its ` +
            `types do not list. An unlisted handler is never registered, so the event type would ` +
            `look declared and fail to dispatch.`,
        );
      }
      if (unhandled.length > 0) {
        throw new EventRegistryError(
          `module ${JSON.stringify(namespace)} lists ${unhandled.map((type) => JSON.stringify(type)).join(", ")} ` +
            `but has no handler for it`,
        );
      }
      throw new EventRegistryError(
        `module ${JSON.stringify(namespace)} declares its types as ` +
          `${JSON.stringify(module.types)}, but they must be listed once each and in sorted ` +
          `order: ${JSON.stringify(canonicalTypes)}. Uniqueness and order are what ` +
          `EventModule.types promises the code that reads it.`,
      );
    }

    for (const type of module.types) {
      const prefix = `${module.namespace}.`;
      if (!type.startsWith(prefix)) {
        throw new EventRegistryError(
          `module ${JSON.stringify(module.namespace)} registers ${JSON.stringify(type)}, which ` +
            `does not start with ${JSON.stringify(prefix)}. A module owns exactly the types ` +
            `under its own namespace; that is what stops two subsystems colliding.`,
        );
      }
      if (!EVENT_NAME_SHAPE.test(type.slice(prefix.length))) {
        throw new EventRegistryError(
          `event type ${JSON.stringify(type)}: the part after the namespace must match ` +
            `${String(EVENT_NAME_SHAPE)}. Event types appear verbatim in recorded ` +
            `transcripts and in replay URLs.`,
        );
      }

      // `undefined` and `null` are exactly the two values that throw on
      // property access — every other wrong type yields `undefined` for `.type`
      // and lands in a named error below — and the `=== undefined` check alone
      // let `null` through to `handler.type` and a bare TypeError.
      //
      // The `unknown` local is a readability choice, matching how the module
      // fields above are captured; the compiler is happy either way.
      const candidate: unknown = module.handlers[type];
      if (candidate === undefined || candidate === null) {
        throw new EventRegistryError(
          `module ${JSON.stringify(module.namespace)} lists ${JSON.stringify(type)} but has no ` +
            `handler for it, got ${candidate === null ? "null" : "nothing"}`,
        );
      }
      const handler = candidate as RegisteredHandler;
      // `handler` is the caller's object — the paragraph above says so — and
      // these two were the fields the paragraph's own promise did not keep:
      // read once for the comparison and again to build the message, so a
      // getter made the error name a value that was never the one that failed.
      // `apply` and `version` are captured below; these complete the set.
      const handlerType = handler.type;
      const handlerNamespace = handler.namespace;
      // A handler carries its own `type` and `namespace`, and `step` trusts
      // both: it looks the handler up by type and then finds the module by
      // `handler.namespace`. `defineEventModule` always fills them correctly,
      // but `EventModule` is a plain interface a caller can satisfy by hand, and
      // a mismatch here surfaces much later as a `TypeError` on an undefined
      // module — with nothing pointing back at the module that was malformed.
      // These two lines are what make the comment in `reduce.ts` ("present by
      // construction") true rather than merely intended.
      if (handlerType !== type) {
        throw new EventRegistryError(
          `module ${JSON.stringify(module.namespace)} files a handler under ${JSON.stringify(type)} ` +
            `that calls itself ${JSON.stringify(handlerType)}. The key and the handler's own type ` +
            `must agree; dispatch uses one and diagnostics use the other.`,
        );
      }
      if (handlerNamespace !== module.namespace) {
        throw new EventRegistryError(
          `handler ${JSON.stringify(type)} claims namespace ${JSON.stringify(handlerNamespace)} but ` +
            `belongs to module ${JSON.stringify(module.namespace)}. The reducer finds a handler's ` +
            `module — and therefore its state slice and its PRNG stream — through that name.`,
        );
      }
      // Captured before it is checked, like the module fields above — and this
      // is the one handler field that was not. `type` comes from the loop key
      // and `namespace` from the already-copied module, but `version` was read
      // once to validate and again to store, so a getter could pass the check
      // and then land `-1` in the frozen copy. `appendEvent` stamps from that
      // copy, producing a log entry the reducer's own `assertEventEnvelope`
      // then refuses: two engine components disagreeing about the same event.
      // The same rough edge as `initialSlice` above, and the last one: binding
      // a missing `apply` below throws a bare TypeError out of registry
      // construction, naming neither the module nor the type.
      const apply = handler.apply;
      if (typeof apply !== "function") {
        throw new EventRegistryError(
          `handler ${JSON.stringify(type)} has no apply function, got ${typeof apply}. A handler ` +
            `that cannot be called is an event type that cannot be folded.`,
        );
      }
      const version = handler.version;
      if (!Number.isInteger(version) || version < 0) {
        throw new EventRegistryError(
          `event type ${JSON.stringify(type)}: version must be a non-negative integer, got ` +
            `${String(version)}`,
        );
      }
      // Stored as a frozen copy, not by reference. `EventModule` is a plain
      // interface, so a hand-built one can supply a mutable `RegisteredHandler`
      // — and reassigning its `apply` after registration changes how a session
      // folds while every frozen surface still reports the module as sealed.
      //
      // `defineEventModule` already closes that door for modules built through
      // it, and says so; this is the one door left open, which made the
      // guarantee true of the front entrance and not the building. Note this is
      // *not* the same as freezing an `EventHandlerDefinition`, which was
      // considered and rejected: that would freeze an object the caller owns to
      // stop a handler mutating its own receiver — a class of divergence a
      // shallow freeze cannot close anyway, since a closure or a module-level
      // binding does it just as well. Here the registry builds its own object
      // and touches nothing of the caller's, and the mutation being stopped is
      // the dispatched function being swapped out from under it.
      //
      // A consequence worth knowing: `registry.modules[i].handlers[t]` is now a
      // different object from `registry.handler(t)`. Dispatch only ever uses
      // the latter, and the former stays as the module declared it.
      byType.set(
        type,
        Object.freeze({
          type,
          namespace: module.namespace,
          version,
          apply: apply.bind(handler),
        }),
      );
    }
  }

  return Object.freeze({
    // The frozen copies, not the caller's objects — see the comment above them.
    modules: Object.freeze(registered),
    namespaces: Object.freeze([...byNamespace.keys()]),
    types: Object.freeze([...byType.keys()].sort()),
    handler: (type: string): RegisteredHandler | undefined => byType.get(type),
    module: (namespace: string): EventModule | undefined =>
      byNamespace.get(namespace),
  });
}
