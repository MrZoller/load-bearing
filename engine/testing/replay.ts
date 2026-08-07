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
import { loadCartridge } from "../cartridge/load.js";
import { serialize } from "../serialize/canonical.js";
import { formatTextDiff } from "./diff.js";
import { describeUnwritableText } from "./text.js";

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
  /**
   * Which cartridge under `engine/__fixtures__/cartridges/` this replays, by
   * name.
   *
   * Referenced rather than inlined so every fixture replays *the* fixture
   * cartridge. Embedded copies would drift, and a change to the shared world
   * would then show up in one recording and not the others — which is the
   * opposite of what a contract artifact is for.
   */
  readonly cartridgeName: string;
  /** That cartridge's parsed JSON, still unvalidated. */
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
    // Loaded here rather than by the caller, so every fixture exercises the
    // validator on the way in and records the *normalized* world. A cartridge
    // that stops validating fails the replay suite, which is where a world
    // that no longer loads should be noticed.
    cartridge: loadCartridge(fixture.cartridge),
    seed: fixture.seed,
    events: fixture.events,
  });

  // Validated on the way out, not only on the way in. The loader checks what a
  // fixture *declares*; this checks what the engine *generated*, and a reducer
  // emitting a newline or a lone surrogate would otherwise be recorded as
  // several lines, or as an artifact no re-record could ever match.
  result.transcript.forEach((entry, index) => {
    const problem = describeUnwritableText(entry);
    if (problem !== undefined) {
      throw new Error(
        `${fixture.name}: transcript entry ${index} contains ${problem}`,
      );
    }
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
