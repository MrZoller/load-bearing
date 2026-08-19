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

import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { EngineEvent } from "../session.js";
import type { ReplayFixture, ReplayRecording } from "./replay.js";
import { describeUnwritableText } from "../text.js";

/** Absolute path to `engine/__fixtures__/replay/`. */
export const REPLAY_FIXTURE_ROOT = fileURLToPath(
  new URL("../__fixtures__/replay/", import.meta.url),
);

/** Absolute path to `engine/__fixtures__/cartridges/`. */
export const CARTRIDGE_FIXTURE_ROOT = fileURLToPath(
  new URL("../__fixtures__/cartridges/", import.meta.url),
);

/**
 * Cartridge fixture names are file-name components, not paths.
 *
 * A fixture names its cartridge and this joins that name to a directory, so
 * without the check a `../` in a `fixture.json` would read whatever it liked
 * off the developer's disk and record it into a committed artifact.
 */
const CARTRIDGE_NAME = /^[a-z0-9][a-z0-9-]*$/;

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

/**
 * Read one JSON string literal, returning its *decoded* value and the index
 * past it.
 *
 * Decoded, because `"seed"` and `"\u0073eed"` are the same key to
 * `JSON.parse` — comparing raw spellings would call them different and let the
 * duplicate through, which is the whole failure this exists to catch.
 */
function readJsonString(
  text: string,
  start: number,
): { value: string; end: number } {
  let index = start + 1;
  let value = "";

  while (index < text.length) {
    const character = text[index];

    if (character === "\\") {
      const escape = text[index + 1];
      if (escape === "u") {
        value += String.fromCharCode(
          Number.parseInt(text.slice(index + 2, index + 6), 16),
        );
        index += 6;
        continue;
      }
      value += JSON_ESCAPES[escape ?? ""] ?? escape ?? "";
      index += 2;
      continue;
    }

    if (character === '"') return { value, end: index + 1 };
    value += character;
    index += 1;
  }

  return { value, end: text.length };
}

const JSON_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

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

/**
 * Read one cartridge fixture, by name, from `engine/__fixtures__/cartridges/`.
 *
 * Returns the parsed JSON unvalidated — `loadCartridge` is what validates, and
 * it runs on the replay path so the fixture suite exercises it. The malformed
 * cartridges under `invalid/` are read through here too, which is the point:
 * the loader's tests feed it the same bytes a replay would.
 */
export function loadCartridgeFixture(name: string): unknown {
  if (!CARTRIDGE_NAME.test(name)) {
    throw new Error(
      `cartridge fixture name ${JSON.stringify(name)} must match ${String(CARTRIDGE_NAME)}. ` +
        `Names are joined to a directory, so a path here would read files this harness does not own.`,
    );
  }
  const path = assertRealFile(join(CARTRIDGE_FIXTURE_ROOT, `${name}.json`));
  const text = readTextFile(path);
  assertNoDuplicateKeys(text, path);
  return JSON.parse(text) as unknown;
}

/** Every malformed cartridge fixture, sorted by name. */
export function listInvalidCartridgeFixtures(): string[] {
  return readdirSync(join(CARTRIDGE_FIXTURE_ROOT, "invalid"))
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.slice(0, -".json".length))
    .sort();
}

/** Read one malformed cartridge fixture. Parsed, deliberately not validated. */
export function loadInvalidCartridgeFixture(name: string): unknown {
  if (!CARTRIDGE_NAME.test(name)) {
    throw new Error(`invalid cartridge fixture name ${JSON.stringify(name)}`);
  }
  const path = assertRealFile(
    join(CARTRIDGE_FIXTURE_ROOT, "invalid", `${name}.json`),
  );
  const text = readTextFile(path);
  assertNoDuplicateKeys(text, path);
  return JSON.parse(text) as unknown;
}

/** Read and shape-check one fixture's input triple. */
export function loadReplayFixture(name: string): ReplayFixture {
  const path = assertRealFile(join(REPLAY_FIXTURE_ROOT, name, FIXTURE_FILE));
  const text = readTextFile(path);
  assertNoDuplicateKeys(text, path);
  return parseReplayFixture(
    JSON.parse(text) as unknown,
    name,
    path,
    loadCartridgeFixture,
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
  path: string,
  readCartridge: (cartridgeName: string) => unknown,
): ReplayFixture {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path}: expected a JSON object`);
  }

  const fixture = parsed as Partial<ReplayFixture>;
  for (const field of ["name", "description", "seed", "cartridge"] as const) {
    if (typeof fixture[field] !== "string") {
      throw new Error(
        `${path}: "${field}" must be a string; "cartridge" names a file under ` +
          `engine/__fixtures__/cartridges/`,
      );
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
    const type = (event as { type?: unknown }).type;
    if (typeof type !== "string") {
      throw new Error(`${at} must have a string "type"`);
    }
    // The transcript is one line per entry, joined with LF. A type carrying a
    // line terminator would make one event render as several lines — or slip a
    // CR into an artifact whose whole contract is LF — and `fixtures:update`
    // would record that as correct.
    const problem = describeUnwritableText(type);
    if (problem !== undefined) {
      throw new Error(`${at} has ${problem} in "type"`);
    }
    // `payload` is optional, but `EngineEvent` declares it an object when
    // present. Casting past that at the disk boundary hands a reducer a value
    // the type system promised was a record.
    const payload = (event as { payload?: unknown }).payload;
    if (
      payload !== undefined &&
      (typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload))
    ) {
      throw new Error(
        `${at} has a "payload" that is ${describe(payload)}; it must be an object when present`,
      );
    }
    // `version` pins the payload schema the event was written against. A
    // fixture usually omits it — "current" is the only thing it can mean for a
    // log authored by hand — but one that declares it is asserting a contract,
    // and a string or a fraction there would be silently ignored otherwise.
    const version = (event as { version?: unknown }).version;
    if (
      version !== undefined &&
      (typeof version !== "number" || !Number.isInteger(version) || version < 0)
    ) {
      throw new Error(
        `${at} has a "version" that is ${describe(version)}; it must be a non-negative integer when present`,
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

  // `cartridge` is a *name* on disk and the resolved contents in memory. The
  // resolution happens last, so a fixture that is malformed in some other way
  // reports that rather than a missing-file error from chasing its reference.
  const cartridgeName = fixture.cartridge as string;
  return {
    name: fixture.name,
    description: fixture.description as string,
    seed: fixture.seed as string,
    cartridgeName,
    cartridge: readCartridge(cartridgeName),
    events: fixture.events as readonly EngineEvent[],
  };
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

/**
 * Refuse to touch an artifact that is a symbolic link.
 *
 * `writeFileSync` follows one, so `fixtures:update` would rewrite whatever the
 * link points at while the fixture directory still looks correct — and reading
 * follows it too, so the recording compared against is not the file the
 * repository thinks it committed.
 */
function assertRealFile(path: string): string {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
    throw new Error(
      `${path} is a symbolic link. Recorded artifacts are real files: a link is ` +
        `followed on both read and write, so the recording compared and rewritten ` +
        `would not be the file committed here.`,
    );
  }
  return path;
}

/** Overwrite one fixture's recorded artifacts. Only `fixtures:update` calls this. */
export function writeReplayRecording(
  name: string,
  recording: ReplayRecording,
): void {
  writeFileSync(
    assertRealFile(join(REPLAY_FIXTURE_ROOT, name, STATE_FILE)),
    recording.state,
    "utf8",
  );
  writeFileSync(
    assertRealFile(join(REPLAY_FIXTURE_ROOT, name, TRANSCRIPT_FILE)),
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
  const path = assertRealFile(join(REPLAY_FIXTURE_ROOT, name, file));
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
