/**
 * Re-record golden replay fixtures. Run with `npm run fixtures:update`.
 *
 * Deliberate by design: CI never re-records. A harness that refreshed its own
 * baselines on failure would turn "the transcript changed" — the exact signal
 * the fixtures exist to raise — into a silent diff nobody reads.
 *
 * Re-recording is legitimate when the engine's behavior changed on purpose.
 * The changed artifacts go in the commit alongside the change that caused
 * them, with the justification in the PR description (CLAUDE.md → Working
 * agreements: golden replay fixtures are contracts).
 *
 * Pass fixture names to limit the run:
 *
 *     npm run fixtures:update -- 001-engine-smoke
 */

import {
  listReplayFixtures,
  loadReplayFixture,
  loadReplayRecording,
  writeReplayRecording,
} from "../engine/testing/fixtures.js";
import { replayFixture } from "../engine/testing/replay.js";
import type { ReplayRecording } from "../engine/testing/replay.js";

function readExisting(name: string): ReplayRecording | undefined {
  try {
    return loadReplayRecording(name);
  } catch {
    return undefined;
  }
}

function main(): void {
  const requested = process.argv.slice(2);
  const available = listReplayFixtures();

  const unknown = requested.filter((name) => !available.includes(name));
  if (unknown.length > 0) {
    process.stderr.write(
      `unknown fixture(s): ${unknown.join(", ")}\navailable: ${available.join(", ")}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const names = requested.length > 0 ? requested : available;
  let changed = 0;

  for (const name of names) {
    const recording = replayFixture(loadReplayFixture(name));
    const existing = readExisting(name);
    const status =
      existing === undefined
        ? "recorded"
        : existing.state === recording.state &&
            existing.transcript === recording.transcript
          ? "unchanged"
          : "updated";

    if (status !== "unchanged") {
      writeReplayRecording(name, recording);
      changed += 1;
    }
    process.stdout.write(`${status.padEnd(9)} ${name}\n`);
  }

  process.stdout.write(
    changed === 0
      ? `\n${names.length} fixture(s) checked, none changed.\n`
      : `\n${changed} of ${names.length} fixture(s) rewritten. Review the diff, then justify it in the PR.\n`,
  );
}

main();
