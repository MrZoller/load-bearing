/**
 * What a session *is*: the event envelope, the transcript, and the state tree
 * that `reduce(cartridge, seed, eventLog)` produces.
 *
 * This module holds vocabulary only — no behaviour — because every other file
 * under `engine/events/` and every Phase 0 subsystem after it reads these
 * shapes. See `./reduce.ts` for the fold itself and `./module.ts` for the
 * contract a subsystem implements.
 *
 * ## Everything here is plain JSON
 *
 * `SessionState` is serialized by `engine/serialize/canonical.ts` into golden
 * fixtures and (Phase 3) into share artifacts, so every value reachable from it
 * has to be something that serializer accepts: no `undefined`, no class
 * instances, no `Map`. That is why the clock and the PRNG appear here as their
 * `toState()` forms rather than as the live handles — a handle is rebuilt for
 * the duration of one `step` and never survives it.
 *
 * See docs/ARCHITECTURE.md → Event sourcing and determinism.
 */

import type { LoadedCartridge } from "../cartridge/types.js";
import type { ClockState } from "../clock/clock.js";
import type { RandomState } from "../random/stream.js";

/**
 * The version of the event *envelope* — the `{ type, payload, version }` shape
 * below, not of any particular event's payload.
 *
 * Recorded into `SessionState` so a snapshot says which envelope produced it,
 * and checked on the way back in by `restoreSnapshot`. Payload schemas version
 * individually, per event type, on the handler that owns them: one number for
 * the whole engine would mean every subsystem's change invalidated every other
 * subsystem's recorded logs.
 */
export const EVENT_SCHEMA_VERSION = 0;

/**
 * One entry in the append-only event log.
 *
 * The log is the session. Nothing else mutates state — that is invariant 2
 * expressed as a data structure, and `engine/events/reduce.ts` is where it is
 * enforced.
 */
export interface EngineEvent {
  /**
   * `namespace.name`, where `namespace` is the module that owns it — see
   * `./registry.ts`. An unregistered type is refused, never ignored.
   */
  readonly type: string;
  /** The event's arguments. Absent is different from empty, and both are legal. */
  readonly payload?: Readonly<Record<string, unknown>>;
  /**
   * The payload schema version this event was recorded against.
   *
   * Absent means "whatever the handler implements today", which is right for a
   * log being appended to right now and wrong for one arriving from an archive
   * — so `appendEvent` stamps it, and a stamped event whose handler has since
   * moved on fails loudly rather than being reinterpreted under new rules.
   */
  readonly version?: number;
}

/**
 * One line of the session transcript, as data rather than as text.
 *
 * The transcript is *derived state*, not a rendering side effect: it is folded
 * by the reducer, lives in `SessionState`, and is part of the byte-identical
 * replay contract. `./transcript.ts` turns these entries into the lines a
 * `transcript.txt` fixture records; a terminal view (Phase 1) renders the same
 * entries differently, and both are reproducible from the event log alone.
 *
 * Exactly one entry per event, at the same index. That is what turns a failing
 * fixture from "something diverged" into "event 37 diverged".
 */
export interface TranscriptEntry {
  /** Position of the event that produced this entry, from zero. */
  readonly index: number;
  /** Simulated instant the event was issued, `YYYY-MM-DDTHH:MM:SS.mmmZ`. */
  readonly at: string;
  readonly type: string;
  /** Appended to the entry's header line. Empty when the event says nothing. */
  readonly summary: string;
  /** Further lines belonging to this entry. Indented when rendered. */
  readonly detail: readonly string[];
}

/** The whole session, as `reduce(cartridge, seed, eventLog)` produces it. */
export interface SessionState {
  /** Which engine produced this state, so a replay mismatch reads as a version. */
  readonly engineVersion: string;
  readonly eventSchemaVersion: number;
  /** Seed material for the PRNG, in the canonical form `formatSeed` renders. */
  readonly seed: string;
  /** The world, already validated and normalized by `loadCartridge`. */
  readonly cartridge: LoadedCartridge;
  /** How many events have been folded in. Also the next event's index. */
  readonly eventCount: number;
  readonly clock: ClockState;
  readonly random: RandomState;
  /**
   * Per-subsystem state, keyed by the owning module's namespace.
   *
   * A module reads any slice and writes only its own — `step` takes the slice
   * it returns and discards everything else it might have touched. That is the
   * structural half of "no mutation escapes the reducer": a filesystem handler
   * cannot reach into git's state even by accident, because it has no way to
   * return git's state.
   *
   * Empty in Phase 0's runtime-only registry beyond the diagnostics module;
   * issues #5–#13 each add one key.
   */
  readonly slices: Readonly<Record<string, unknown>>;
  /** One entry per folded event, in log order. */
  readonly transcript: readonly TranscriptEntry[];
}

/**
 * A module's slice of session state.
 *
 * Returned as `unknown`: the registry is heterogeneous, so the caller asserts
 * the type its own module declares. A module reading *another* module's slice
 * is reading a contract it does not own — narrow it through that module's own
 * exported reader rather than casting at the call site.
 *
 * @throws when the state was bootstrapped without the module — which means the
 * state and the registry disagree, and folding on would produce a session
 * neither of them describes.
 */
export function readSlice(state: SessionState, namespace: string): unknown {
  if (!Object.hasOwn(state.slices, namespace)) {
    throw new Error(
      `session state has no slice for module ${JSON.stringify(namespace)}; it was ` +
        `bootstrapped with a registry that does not include that module, so folding ` +
        `its events on would produce a session neither describes`,
    );
  }
  return state.slices[namespace];
}
