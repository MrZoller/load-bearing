/**
 * Replaying a session: the fold plus the rendered transcript.
 *
 * A thin binding over `engine/events/reduce.ts`, kept because the golden replay
 * harness and (later) the runtime both want the same two artifacts from one
 * call — the state, and the transcript as text. The reducer itself has no
 * opinion about text; `engine/events/transcript.ts` renders the entries it
 * folded, and the entries stay in state where a Phase 1 view can render them
 * differently without changing what was recorded.
 *
 * See docs/ARCHITECTURE.md → Event sourcing and determinism.
 */

import { reduce } from "./events/reduce.js";
import type { ReduceInput } from "./events/reduce.js";
import { renderTranscript } from "./events/transcript.js";
import type { SessionState } from "./events/state.js";

export type { EngineEvent, SessionState } from "./events/state.js";

/** The triple that fully determines a session, plus an optional registry. */
export type ReplayInput = ReduceInput;

export interface ReplayOutput {
  readonly state: SessionState;
  /**
   * Transcript lines, LF-joined by the harness into `transcript.txt`.
   *
   * Derived from `state.transcript`, not accumulated alongside it: there is one
   * transcript, it lives in state, and this is a rendering of it.
   */
  readonly transcript: readonly string[];
}

/**
 * Fold an event log into session state and a transcript.
 *
 * Pure and total: identical input produces identical output, with no reads of
 * wall-clock time, randomness, or ambient environment.
 */
export function replaySession(input: ReplayInput): ReplayOutput {
  const state = reduce(input);
  return { state, transcript: renderTranscript(state.transcript) };
}
