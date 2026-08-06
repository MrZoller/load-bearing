/**
 * Disk access for the golden replay harness.
 *
 * This is the only file under `engine/` that imports a Node built-in, and it
 * is allowlisted in the purity gate for exactly that reason: it is test
 * infrastructure that reads committed fixture files, never part of the
 * simulation, and never imported by engine runtime code or shipped to the
 * browser. The allowlist entry lives in `scripts/gate-purity.mjs` with its
 * justification. If a second file ever needs an entry, that is a design
 * problem to argue about, not paperwork to fill in.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ReplayFixture, ReplayRecording } from "./replay.js";

/** Absolute path to `engine/__fixtures__/replay/`. */
export const REPLAY_FIXTURE_ROOT = fileURLToPath(
  new URL("../__fixtures__/replay/", import.meta.url),
);

const FIXTURE_FILE = "fixture.json";
const STATE_FILE = "state.json";
const TRANSCRIPT_FILE = "transcript.txt";

/**
 * Every replay fixture directory, sorted by name.
 *
 * Sorting is what makes the suite's execution order stable; fixture names are
 * numeric-prefixed so that order is also readable.
 */
export function listReplayFixtures(): string[] {
  return readdirSync(REPLAY_FIXTURE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Read and shape-check one fixture's input triple. */
export function loadReplayFixture(name: string): ReplayFixture {
  const path = join(REPLAY_FIXTURE_ROOT, name, FIXTURE_FILE);
  return parseReplayFixture(
    JSON.parse(readFileSync(path, "utf8")) as unknown,
    name,
    path,
  );
}

/**
 * Validate a parsed `fixture.json`. Pure, so the malformed cases are testable
 * without committing a broken fixture the replay suite would then have to skip.
 *
 * `path` appears in every message: a fixture error that does not say which
 * fixture is a worse error than the one it reports.
 */
export function parseReplayFixture(
  parsed: unknown,
  name: string,
  path = name,
): ReplayFixture {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path}: expected a JSON object`);
  }

  const fixture = parsed as Partial<ReplayFixture>;
  for (const field of ["name", "description", "seed"] as const) {
    if (typeof fixture[field] !== "string") {
      throw new Error(`${path}: "${field}" must be a string`);
    }
  }
  if (!Array.isArray(fixture.events)) {
    throw new Error(`${path}: "events" must be an array`);
  }
  // Shape-check every event, not just the array around them. A fixture whose
  // event says `kind` instead of `type` replays with `type` undefined, and
  // `fixtures:update` then records that as the expected transcript — a typo
  // promoted to a green baseline. A `null` element fails worse still, throwing
  // a bare TypeError out of the reducer with no fixture path attached.
  fixture.events.forEach((event: unknown, index: number) => {
    const at = `${path}: events[${index}]`;
    if (typeof event !== "object" || event === null || Array.isArray(event)) {
      throw new Error(`${at} must be an object, not ${describe(event)}`);
    }
    if (typeof (event as { type?: unknown }).type !== "string") {
      throw new Error(`${at} must have a string "type"`);
    }
  });
  if (fixture.name !== name) {
    throw new Error(
      `${path}: "name" is ${JSON.stringify(fixture.name)} but the directory is ` +
        `${JSON.stringify(name)}. They must match, so a renamed directory cannot ` +
        `quietly orphan its recording.`,
    );
  }

  return fixture as ReplayFixture;
}

/**
 * Read one fixture's recorded artifacts.
 *
 * A missing recording is an error rather than an empty baseline: a fixture
 * that records itself on first run would pass forever without ever having been
 * reviewed.
 */
export function loadReplayRecording(name: string): ReplayRecording {
  return {
    state: readRecordedFile(name, STATE_FILE),
    transcript: readRecordedFile(name, TRANSCRIPT_FILE),
  };
}

/** Overwrite one fixture's recorded artifacts. Only `fixtures:update` calls this. */
export function writeReplayRecording(
  name: string,
  recording: ReplayRecording,
): void {
  writeFileSync(
    join(REPLAY_FIXTURE_ROOT, name, STATE_FILE),
    recording.state,
    "utf8",
  );
  writeFileSync(
    join(REPLAY_FIXTURE_ROOT, name, TRANSCRIPT_FILE),
    recording.transcript,
    "utf8",
  );
}

/** A short, safe description of a bad value, for an error message. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

function readRecordedFile(name: string, file: string): string {
  const path = join(REPLAY_FIXTURE_ROOT, name, file);
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(
      `${path} is missing. A fixture must be recorded deliberately: run ` +
        `\`npm run fixtures:update\` and review the result before committing.`,
      { cause },
    );
  }
}
