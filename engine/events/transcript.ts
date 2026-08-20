/**
 * Rendering the transcript.
 *
 * The transcript lives in session state as structured `TranscriptEntry` values
 * (see `./state.ts`); this is the one place that turns them into text. The
 * split matters: the entries are the contract, and this is a view of them, so a
 * Phase 1 terminal renderer can present the same session without the recorded
 * fixture's line format becoming a UI constraint.
 *
 * The format is fixed-width on purpose. A golden `transcript.txt` is read by a
 * human deciding whether a diff is the change they meant to make, and a column
 * that moves because an event type got longer would make every line of a
 * thousand-line artifact look changed.
 *
 *     0000  2026-08-05T09:14:22.000Z  clock.tick ms=1500
 *           0000  b6e9c04d fad50d79 0ab5b45d 70bdda98
 */

import type { TranscriptEntry } from "./state.js";

/** Indent for a line elaborating the entry above it. */
export const DETAIL_INDENT = "      ";

/**
 * Ceilings on one transcript entry, in the two dimensions an entry has.
 *
 * The `MAX_PROBE_*` constants in `engine/events/probe.ts` each bound one
 * *input*, and there are more inputs than constants: a probe's draw count, the
 * length of a `weightedPick` arm's label amplified by `padEnd`, and the depth of
 * a stream path all reach the transcript. Bounding the output covers all of
 * them at once, and covers whatever #5–#13 write without each module inventing
 * its own ceiling.
 *
 * They live here rather than in `./reduce.ts` so `./probe.ts` can derive its own
 * draw ceiling from them. A module that renders N lines per unit of input has
 * to know the line budget to stay inside it, and the alternative — two
 * independently chosen numbers — is exactly how a shipped event type came to
 * declare a payload legal that the transcript then refused.
 *
 * The value is a budget, not a measurement of what exists today. The largest
 * committed fixture entry is 126 detail lines of at most 84 characters, but the
 * bound that matters is the one the validators admit: `probe.random` in float
 * form is what sets the ceiling, and `MAX_PROBE_COUNT` is derived from this so
 * the two cannot disagree.
 *
 * The residual, which this does not close: it bounds the artifact, not the
 * work. A stream path of fifty thousand segments costs most of a second on an
 * event whose entry is one line, and no output ceiling sees that. A per-event
 * work budget is Phase 3 hostile-permalink work.
 */
export const MAX_TRANSCRIPT_DETAIL_LINES = 4096;
export const MAX_TRANSCRIPT_LINE_LENGTH = 4096;

/** Width of the zero-padded event index column. */
export const INDEX_WIDTH = 4;

/** Left-pad with zeros — the deterministic half of what `Intl` would do. */
export function padZero(value: number | string, width: number): string {
  return String(value).padStart(width, "0");
}

/** One entry's lines: a header, then its detail, indented. */
export function renderEntry(entry: TranscriptEntry): string[] {
  const header = `${padZero(entry.index, INDEX_WIDTH)}  ${entry.at}  ${entry.type}`;
  // Captured: `renderEntry` is exported and takes a caller-owned entry, and
  // reading `summary` to choose the branch and again to interpolate let the two
  // differ — a dropped summary, or a trailing space where the branch said there
  // was none.
  const summary = entry.summary;
  const exitCode = entry.exitCode;
  const result =
    exitCode === undefined
      ? summary
      : summary === ""
        ? `exit=${String(exitCode)}`
        : `${summary} exit=${String(exitCode)}`;
  return [
    result === "" ? header : `${header} ${result}`,
    ...entry.detail.map((line) => `${DETAIL_INDENT}${line}`),
    ...(entry.output ?? []).map(
      (line) => `${DETAIL_INDENT}${line.stream}> ${line.text}`,
    ),
  ];
}

/** The whole transcript, one string per line, ready to be LF-joined. */
export function renderTranscript(
  entries: readonly TranscriptEntry[],
): string[] {
  return entries.flatMap(renderEntry);
}
