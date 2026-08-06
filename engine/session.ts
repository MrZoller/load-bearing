/**
 * Session replay — the shape of `state = reduce(cartridge, seed, eventLog)`.
 *
 * PROVISIONAL. The types here are the surface the golden-replay harness binds
 * to; the *implementation* is a placeholder that folds the event log into a
 * trivially derived state and transcript. It exists so the replay loop is
 * proven end to end in CI from the first Phase 0 PR onward, rather than after
 * the reducer lands.
 *
 * The event log and reducer core (issue #4) replaces `replaySession`'s body
 * and the `SessionState` shape. That will invalidate the recorded artifacts of
 * every fixture written before it — which is the designed path, not an
 * accident: re-record with `npm run fixtures:update` and justify the change in
 * the PR description, per CLAUDE.md.
 *
 * See docs/ARCHITECTURE.md → Event sourcing and determinism.
 */

import { ENGINE_VERSION } from "./version.js";

/**
 * An entry in the append-only event log.
 *
 * Issue #4 replaces this with a discriminated union plus a registry that
 * subsystems extend. Until then the harness only needs a stable envelope.
 */
export interface EngineEvent {
  readonly type: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

/** The triple that fully determines a session. */
export interface ReplayInput {
  /** The world. Unvalidated here; issue #3 introduces the loader. */
  readonly cartridge: unknown;
  /** Seed material for the PRNG. Issue #2 gives this structure. */
  readonly seed: string;
  readonly events: readonly EngineEvent[];
}

/** @provisional Replaced by the real state tree in issue #4. */
export interface SessionState {
  readonly engineVersion: string;
  readonly seed: string;
  readonly cartridge: unknown;
  readonly eventCount: number;
}

export interface ReplayOutput {
  readonly state: SessionState;
  /** Transcript lines, LF-joined by the harness into `transcript.txt`. */
  readonly transcript: readonly string[];
}

/**
 * Fold an event log into session state and a transcript.
 *
 * Pure and total: identical input produces identical output, with no reads of
 * wall-clock time, randomness, or ambient environment.
 */
export function replaySession(input: ReplayInput): ReplayOutput {
  const transcript = input.events.map(
    (event, index) => `${String(index).padStart(4, "0")}  ${event.type}`,
  );

  return {
    state: {
      engineVersion: ENGINE_VERSION,
      seed: input.seed,
      cartridge: input.cartridge,
      eventCount: input.events.length,
    },
    transcript,
  };
}
