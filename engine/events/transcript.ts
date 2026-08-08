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

/** Width of the zero-padded event index column. */
export const INDEX_WIDTH = 4;

/** Left-pad with zeros — the deterministic half of what `Intl` would do. */
export function padZero(value: number | string, width: number): string {
  return String(value).padStart(width, "0");
}

/** One entry's lines: a header, then its detail, indented. */
export function renderEntry(entry: TranscriptEntry): string[] {
  const header = `${padZero(entry.index, INDEX_WIDTH)}  ${entry.at}  ${entry.type}`;
  return [
    entry.summary === "" ? header : `${header} ${entry.summary}`,
    ...entry.detail.map((line) => `${DETAIL_INDENT}${line}`),
  ];
}

/** The whole transcript, one string per line, ready to be LF-joined. */
export function renderTranscript(
  entries: readonly TranscriptEntry[],
): string[] {
  return entries.flatMap(renderEntry);
}
