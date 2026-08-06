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

/**
 * A decoder that changes nothing about the bytes it is given.
 *
 * Both options are load-bearing, and both close the same failure: the harness
 * reporting byte identity it did not actually check.
 *
 * - `fatal` — `readFileSync(path, "utf8")` replaces a malformed byte sequence
 *   with U+FFFD silently, so a corrupted recording would compare equal to a
 *   replay that legitimately emits the replacement character.
 * - `ignoreBOM` — despite the name, this *keeps* a leading byte-order mark as
 *   a character instead of consuming it. Without it, a recording that starts
 *   with a BOM decodes identically to one that does not, and three bytes of
 *   difference pass as a match.
 */
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Reject an object member that appears twice.
 *
 * `JSON.parse` keeps the last value silently, so a fixture can show one
 * scenario to a reader while CI and `fixtures:update` exercise another — and
 * the recording that results is green and wrong. There is no parser option for
 * this, so the text is scanned for key positions directly.
 */
function assertNoDuplicateKeys(text: string, path: string): void {
  const stack: { object: boolean; keys: Set<string> }[] = [];
  let index = 0;
  let atKey = false;

  while (index < text.length) {
    const character = text[index];

    if (character === '"') {
      const { value, end } = readJsonString(text, index);
      const frame = stack[stack.length - 1];
      if (atKey && frame !== undefined) {
        if (frame.keys.has(value)) {
          throw new Error(
            `${path}: duplicate key ${JSON.stringify(value)}; JSON.parse would keep ` +
              `only the last one, so the file would not say what it runs`,
          );
        }
        frame.keys.add(value);
        atKey = false;
      }
      index = end;
      continue;
    }

    if (character === "{") stack.push({ object: true, keys: new Set() });
    else if (character === "[") stack.push({ object: false, keys: new Set() });
    else if (character === "}" || character === "]") stack.pop();
    else if (character === ",")
      atKey = stack[stack.length - 1]?.object === true;
    else if (character === ":") atKey = false;

    if (character === "{") atKey = true;
    else if (character === "[" || character === "}" || character === "]")
      atKey = false;

    index += 1;
  }
}

/** Read one JSON string literal, returning its value and the index past it. */
function readJsonString(
  text: string,
  start: number,
): { value: string; end: number } {
  let index = start + 1;
  let value = "";

  while (index < text.length) {
    const character = text[index];
    if (character === "\\") {
      value += text.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (character === '"') return { value, end: index + 1 };
    value += character;
    index += 1;
  }

  return { value, end: text.length };
}

/** Read a committed artifact, failing loudly on malformed bytes. */
function readTextFile(path: string): string {
  return STRICT_UTF8.decode(readFileSync(path));
}

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
  const entries = readdirSync(REPLAY_FIXTURE_ROOT, { withFileTypes: true });

  // A symlinked fixture directory reports `isDirectory() === false`, so it
  // would be dropped from the list in silence — and the suite would stay green
  // on the fixtures that remain, giving a newly added contract no replay
  // coverage at all. Refusing loudly is the only outcome that says so.
  const symlinked = entries
    .filter((entry) => entry.isSymbolicLink())
    .map((entry) => entry.name);
  if (symlinked.length > 0) {
    throw new Error(
      `${REPLAY_FIXTURE_ROOT}: fixture entries must be real directories, but ` +
        `${symlinked.join(", ")} ${symlinked.length === 1 ? "is a symlink" : "are symlinks"}. ` +
        `A symlinked fixture is skipped silently and gets no replay coverage.`,
    );
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Read and shape-check one fixture's input triple. */
export function loadReplayFixture(name: string): ReplayFixture {
  const path = join(REPLAY_FIXTURE_ROOT, name, FIXTURE_FILE);
  const text = readTextFile(path);
  assertNoDuplicateKeys(text, path);
  return parseReplayFixture(JSON.parse(text) as unknown, name, path);
}

/**
 * Any C0 or C1 control character, including LF and CR.
 *
 * Built from code points rather than written as a literal class, so the
 * pattern stays readable and cannot be corrupted by a stray raw control
 * character in the source.
 */
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F]/;

/**
 * A surrogate code unit with no partner.
 *
 * JSON permits `"\ud800"`, and a string carrying one is not valid Unicode:
 * writing it out as UTF-8 substitutes U+FFFD, so the recording no longer holds
 * what replay produced and no re-record could ever make the byte-identity test
 * pass. Rejecting it at load turns an unfixable fixture into a clear error.
 */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

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
  // `hasOwn`, not an undefined check: the cartridge is typed `unknown` until
  // issue #3 gives it a schema, so `null` has to stay legal. Without this, a
  // fixture that misspells the key replays with `cartridge: undefined`, the
  // serializer drops the undefined property by JSON convention, and
  // `fixtures:update` mints a green recording for two thirds of the triple.
  if (!Object.hasOwn(parsed, "cartridge")) {
    throw new Error(`${path}: "cartridge" is required, and may be null`);
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
    const type = (event as { type?: unknown }).type;
    if (typeof type !== "string") {
      throw new Error(`${at} must have a string "type"`);
    }
    // The transcript is one line per entry, joined with LF. A type carrying a
    // line terminator would make one event render as several lines — or slip a
    // CR into an artifact whose whole contract is LF — and `fixtures:update`
    // would record that as correct.
    if (CONTROL_CHARACTER.test(type)) {
      throw new Error(
        `${at} has a control character in "type"; transcript entries are one line each`,
      );
    }
    if (LONE_SURROGATE.test(type)) {
      throw new Error(
        `${at} has an unpaired surrogate in "type"; it cannot survive being written ` +
          `as UTF-8, so no recording of it could ever match`,
      );
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
    return readTextFile(path);
  } catch (cause) {
    throw new Error(
      `${path} is missing. A fixture must be recorded deliberately: run ` +
        `\`npm run fixtures:update\` and review the result before committing.`,
      { cause },
    );
  }
}
