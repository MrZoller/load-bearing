/**
 * The golden replay harness.
 *
 * A replay fixture is the determinism contract as a committed artifact: an
 * input triple `(cartridge, seed, events)` plus the state and transcript it is
 * required to produce. CI replays every fixture and compares byte for byte.
 *
 * This module is pure — it holds the fixture shape and the replay-and-render
 * step. Reading fixtures from disk lives in `./fixtures.ts`, which is the one
 * file in `engine/` allowed to touch `node:fs`.
 *
 * See engine/testing/README.md for how to add a fixture and when re-recording
 * one is legitimate.
 */

import { replaySession } from "../session.js";
import type { EngineEvent } from "../session.js";
import { serialize } from "../serialize/canonical.js";
import { formatTextDiff } from "./diff.js";

/** The committed input half of a fixture: `fixture.json`. */
export interface ReplayFixture {
  /**
   * Human-readable name, asserted to match the fixture's directory name so a
   * renamed directory cannot silently orphan its recording.
   */
  readonly name: string;
  /** What this fixture is protecting. Read by humans, not by the runner. */
  readonly description: string;
  readonly seed: string;
  readonly cartridge: unknown;
  readonly events: readonly EngineEvent[];
}

/** The recorded output half of a fixture: `state.json` and `transcript.txt`. */
export interface ReplayRecording {
  /** Canonical JSON, LF, one trailing newline. */
  readonly state: string;
  /** One line per transcript entry, LF, one trailing newline. */
  readonly transcript: string;
}

/**
 * Replay a fixture and render its artifacts exactly as they are recorded.
 *
 * Both artifacts end in a single newline so the committed files are
 * well-formed text — a fixture with no transcript entries records as an empty
 * file rather than a file containing one blank line.
 */
export function replayFixture(fixture: ReplayFixture): ReplayRecording {
  const result = replaySession({
    cartridge: fixture.cartridge,
    seed: fixture.seed,
    events: fixture.events,
  });

  return {
    state: serialize(result.state),
    transcript:
      result.transcript.length === 0 ? "" : `${result.transcript.join("\n")}\n`,
  };
}

/**
 * Compare a fresh replay against a fixture's recording.
 *
 * Returns `undefined` when both artifacts match byte for byte, and a
 * ready-to-throw explanation otherwise. Every mismatch — a single byte
 * included — is a failure; the diff exists so the reader can tell at a glance
 * whether the change is the one they meant to make.
 */
export function compareRecording(
  name: string,
  recorded: ReplayRecording,
  replayed: ReplayRecording,
): string | undefined {
  const artifacts = [
    ["state.json", recorded.state, replayed.state],
    ["transcript.txt", recorded.transcript, replayed.transcript],
  ] as const;

  const mismatches = artifacts
    .filter(([, expected, actual]) => expected !== actual)
    .map(
      ([file, expected, actual]) =>
        `${name}/${file} does not match its recording.\n\n` +
        formatTextDiff(expected, actual, {
          expectedLabel: "recorded",
          actualLabel: "replayed",
        }),
    );

  if (mismatches.length === 0) return undefined;

  return [
    ...mismatches,
    "If this change is intended, re-record with `npm run fixtures:update` and " +
      "justify it in the PR description. Golden replay fixtures are contracts.",
  ].join("\n");
}
