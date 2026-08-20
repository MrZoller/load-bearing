/**
 * The cartridge schema, as data.
 *
 * Invariant 1 says runtime owns mechanics and cartridges own worlds. This file
 * is where that boundary is written down: everything the engine knows about a
 * world arrives through this document, and anything not declared here is not
 * available to the engine no matter what a cartridge puts in the JSON.
 *
 * The schema is a descriptor tree rather than hand-written validation code, for
 * one reason: three things have to agree about it, and only one of them can be
 * the source.
 *
 * - the **validator** (`./load.ts`) walks this tree
 * - the **published JSON Schema** (`content/schema/cartridge.v0.json`) is
 *   emitted from it by `./jsonSchema.ts`, and a test fails if the committed
 *   file has drifted
 * - the **TypeScript types** (`./types.ts`) are hand-written for readability,
 *   and the compiler ties them to the validator's output — a field declared
 *   here and not built there, or built there and not declared here, does not
 *   compile
 *
 * Written the obvious way — a validator function and a schema file maintained
 * side by side — the published schema would describe the loader of six months
 * ago, and nothing would say so.
 *
 * ## What v0 does not check
 *
 * Two kinds of gap, both deliberate, both marked `deferred` in the tree so they
 * are visible in the emitted schema rather than being an absence a reader has
 * to notice:
 *
 * - `story` and `presentation` carry Phase 2 content and are hardened in
 *   Phase 4. v0 requires them to be objects and looks no further.
 * - the interior of `tests` belongs to issue #12. v0 requires each test to be
 *   an object. The other machine surfaces are concrete as of issue #7, and
 *   `gitHistory` is concrete as of issue #6.
 *
 * Broader semantic coherence — endings reachable and callbacks sourced — is
 * Phase 4's `cartridge validate`. v0 already checks repository paths and Git
 * history because an incoherent machine is broken before the first command.
 */

import { parseTimestamp } from "../clock/civil.js";
import { deepFreeze } from "../freeze.js";
import { pattern } from "../pattern.js";
import type { Pattern } from "../pattern.js";
import { INCIDENT_DATE_PATTERN, MODEL_ID_PATTERN } from "../random/seed.js";

/**
 * The only schema version this engine understands.
 *
 * A cartridge declaring anything else is rejected outright, with no other
 * errors reported: validating a v1 document against v0's rules produces a page
 * of cascading nonsense that buries the one line worth reading.
 */
export const CARTRIDGE_SCHEMA_VERSION = 0;

/**
 * This tree *is* the validation authority, so it is frozen all the way down
 * (`engine/freeze.ts`). `as const` is a compile-time assertion and nothing
 * more: the arrays and objects below are exported, and a JavaScript consumer —
 * or a TypeScript one with a cast — can push to them. `ARCHETYPES.push("other")`
 * would make `loadCartridge` accept an archetype the exported `Archetype` type
 * still says does not exist, and the next schema emission would publish it.
 */

/** The four behavioural archetypes. See docs/DESIGN.md. */
export const ARCHETYPES = Object.freeze([
  "paranoid",
  "reckless",
  "superficial",
  "existential",
] as const);

/**
 * Absolute POSIX path: a leading slash, then non-empty segments that are not
 * `.` or `..`, and no backslashes anywhere.
 *
 * Absolute, not relative to `cwd`. The world is a filesystem, not a project
 * folder — `cat /etc/motd` and `ls /var/log` are part of the joke surface — so
 * a file key names a location in that filesystem. It also gives `cwd` something
 * to be checked against.
 */
export const ABSOLUTE_PATH_PATTERN = pattern(
  /^\/$|^(?:\/(?!\.{1,2}(?:\/|$))[^/\\\u0000-\u001F\u007F]+)+$/,
);

/**
 * The same, minus the bare root.
 *
 * `/` is a directory and cannot also be a regular file with contents. It is
 * also the one path for which `cwd`'s containment check degenerates: the
 * trailing-slash prefix that excludes `cwd` itself for every other path
 * matches `/` against itself, so a cartridge whose only file is `/` would
 * satisfy containment by colliding with its own cwd.
 *
 * That degenerate case is all this pattern closes. A cwd that collides with a
 * file at any other path is caught by `checkCwd`, which has to look for it
 * directly — containment cannot, since a single descendant satisfies it while
 * the collision stands. `cwd` keeps the wider pattern either way: opening a
 * session at the root is legitimate.
 */
export const FILE_PATH_PATTERN = pattern(
  /^(?:\/(?!\.{1,2}(?:\/|$))[^/\\\u0000-\u001F\u007F]+)+$/,
);

/**
 * Text that has to stay on one line.
 *
 * Excludes C0 and C1 controls plus U+2028 and U+2029, which are line
 * terminators to JavaScript even though they are not to most tools. A title or
 * a model description carrying a newline is not caught anywhere downstream —
 * it just arrives in the model selector as two lines, or in a status bar as a
 * broken row — so it belongs at the validation boundary with everything else
 * the fallback episode depends on.
 */
export const SINGLE_LINE_PATTERN = pattern(
  /^[^\u0000-\u001F\u007F-\u009F\u2028\u2029]*$/,
);

/** Four octal digits, as `ls -l` renders a mode. */
export const FILE_MODE_PATTERN = pattern(/^[0-7]{4}$/);

/** A permission mask, without set-id or sticky bits. */
export const UMASK_PATTERN = pattern(/^0[0-7]{3}$/);

/** A POSIX user or group name. */
export const ACCOUNT_NAME_PATTERN = pattern(/^[a-z_][a-z0-9_-]*$/);

/** An environment variable name, as the shell would accept it. */
export const ENV_NAME_PATTERN = pattern(/^[A-Za-z_][A-Za-z0-9_]*$/);

/** A man page name, e.g. `systemd.service` or `ls`. */
export const MAN_PAGE_PATTERN = pattern(/^[a-z0-9][a-z0-9._-]*$/);

/** A stable cartridge-local identifier that cannot disturb line-oriented output. */
export const WORLD_ID_PATTERN = pattern(
  /^[^\u0000-\u001F\u007F-\u009F\u2028\u2029]+$/,
);

/** Stable cartridge-local commit name, used before content hashes are derived. */
export const GIT_COMMIT_ID_PATTERN = pattern(/^[a-z][a-z0-9-]*$/);

/** Git ref component spelling; slashes separate non-empty components. */
export const GIT_BRANCH_PATTERN = pattern(
  /^(?!\/|.*(?:\/\/|\.\.|@\{|\\|\s|[~^:?*\[]))[A-Za-z0-9._/-]+(?<![/.])$/,
);

export type { Pattern };

export interface StringNode {
  readonly kind: "string";
  readonly description: string;
  readonly pattern?: Pattern;
  /** Human-readable form of `pattern`, for the error a person reads. */
  readonly patternLabel?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  /** Extra check run after the pattern, e.g. "is a real calendar date". */
  readonly refine?: (value: string) => string | undefined;
}

export interface IntegerNode {
  readonly kind: "integer";
  readonly description: string;
  readonly minimum: number;
  readonly maximum: number;
}

export interface EnumNode {
  readonly kind: "enum";
  readonly description: string;
  readonly values: readonly string[];
}

export interface ObjectNode {
  readonly kind: "object";
  readonly description: string;
  /** Declaration order is the order errors are reported in. */
  readonly fields: Readonly<Record<string, SchemaField>>;
}

export interface ArrayNode {
  readonly kind: "array";
  readonly description: string;
  readonly items: SchemaNode;
  readonly minItems?: number;
}

/** An object whose keys are data rather than schema — `files`, `env`. */
export interface RecordNode {
  readonly kind: "record";
  readonly description: string;
  readonly keyPattern: Pattern;
  readonly keyLabel: string;
  readonly values: SchemaNode;
  readonly minEntries?: number;
}

/**
 * A JSON object carried through untouched.
 *
 * `owner` names who tightens it and when, and is emitted into the published
 * schema so the gap reads as a decision rather than as something forgotten.
 */
export interface DeferredNode {
  readonly kind: "deferred";
  readonly description: string;
  readonly owner: string;
}

export type SchemaNode =
  | StringNode
  | IntegerNode
  | EnumNode
  | ObjectNode
  | ArrayNode
  | RecordNode
  | DeferredNode;

export interface SchemaField {
  readonly node: SchemaNode;
  readonly required: boolean;
  /**
   * Copied in when the field is absent. Present only for optional fields, and
   * always a plain JSON value so the published schema can carry it too.
   */
  readonly fill?: unknown;
  /**
   * Set when normalization computes a default rather than copying one — the
   * published schema states the rule in prose, since JSON Schema cannot.
   */
  readonly derived?: string;
}

function required<T extends SchemaNode>(node: T): { node: T; required: true } {
  return { node, required: true };
}

function optional<T extends SchemaNode>(
  node: T,
  fill: unknown,
): { node: T; required: false; fill: unknown } {
  return { node, required: false, fill };
}

/**
 * A section the engine models but v0 does not look inside.
 *
 * Each is an array of objects, so a cartridge cannot smuggle a string into a
 * place that will later hold a record, and the issue that tightens it is named.
 */
function deferredList(description: string, owner: string): SchemaField {
  return {
    node: {
      kind: "array",
      description,
      items: {
        kind: "deferred",
        description: `One entry. ${description}`,
        owner,
      },
    },
    required: false,
    fill: [],
  };
}

/** Rejects `2026-02-30` and friends, which the pattern alone accepts. */
function refineCalendarDate(value: string): string | undefined {
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    return "a calendar date";
  }
  if (month < 1 || month > 12) return "a real month";
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const length = lengths[month - 1] ?? 0;
  if (day < 1 || day > length)
    return `a real day of that month (1-${String(length)})`;
  return undefined;
}

/**
 * Rejects `2026-13-40T25:61:61.000Z` and `1969-12-31T23:59:59.000Z`, which the
 * pattern alone accepts.
 *
 * The shape check is not enough, and the gap is the one place it matters most:
 * `meta.startedAt` is required precisely so a generated cartridge cannot open a
 * session on a wrong date with no human watching. A timestamp that only fails
 * later, when `createClock` parses it, has crossed the validation boundary —
 * and invariant 7's "pipeline failure ships the fallback episode" only works
 * while failures are detected on the validating side of it. Authored `mtime`s
 * are worse in kind: nothing parses one yet, so a bad one would sit latent
 * until the filesystem subsystem lands.
 *
 * `parseTimestamp` is the same function the clock uses, so agreeing with it is
 * not a matter of keeping two rules in step.
 */
function refineInstant(value: string): string | undefined {
  try {
    parseTimestamp(value);
    return undefined;
  } catch {
    return "a real UTC instant between 1970-01-01 and 9999-12-31";
  }
}

const TIMESTAMP = {
  kind: "string",
  description:
    "A UTC instant, `YYYY-MM-DDTHH:MM:SS.mmmZ`. Fixed width, so one instant has exactly one spelling. The simulated machine has no other timezone.",
  // Fixed width rather than `[.mmm]` with 1-3 digits, which gave one instant
  // four spellings. The loader does not rewrite what it validates, so a
  // cartridge keeps whichever it was written with — and replay state embeds
  // the loaded cartridge, so two sessions identical in every simulated respect
  // would produce different `state.json` bytes. Determinism survives that
  // (different input, different output) but the fixtures that pin it stop
  // meaning what they say. Requiring the canonical form is also the half a
  // generator can check against the published schema; normalizing on load
  // would be invisible there.
  pattern: pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  patternLabel: "YYYY-MM-DDTHH:MM:SS.mmmZ",
  refine: refineInstant,
} satisfies StringNode;

const FILE = {
  kind: "object",
  description: "One file in the simulated filesystem.",
  fields: {
    contents: required({
      kind: "string",
      description:
        "The file's full text. Empty is allowed; a binary file is not.",
    }),
    mode: optional(
      {
        kind: "string",
        description:
          "Permission bits as four octal digits, as `ls -l` renders them.",
        pattern: FILE_MODE_PATTERN,
        patternLabel: "four octal digits",
      },
      "0644",
    ),
    owner: optional(
      {
        kind: "string",
        description:
          "Owning user. A comedy surface: `ls -la` showing owner `greg` is doing work.",
        pattern: ACCOUNT_NAME_PATTERN,
        patternLabel: "a POSIX user name",
      },
      "root",
    ),
    group: optional(
      {
        kind: "string",
        description: "Owning group.",
        pattern: ACCOUNT_NAME_PATTERN,
        patternLabel: "a POSIX group name",
      },
      "root",
    ),
    mtime: {
      node: TIMESTAMP,
      required: false,
      derived:
        "Defaults to `meta.startedAt` — a file the cartridge does not date was already there when the session opened.",
    },
  },
} satisfies ObjectNode;

const DIRECTORY = {
  kind: "object",
  description:
    "Metadata for one explicitly declared directory. Contents are derived from path keys, never embedded here.",
  fields: {
    mode: optional(
      {
        kind: "string",
        description: "Permission bits as four octal digits.",
        pattern: FILE_MODE_PATTERN,
        patternLabel: "four octal digits",
      },
      "0755",
    ),
    owner: {
      node: {
        kind: "string",
        description:
          "Owning user. Defaults to the nearest explicitly declared ancestor's owner, or root.",
        pattern: ACCOUNT_NAME_PATTERN,
        patternLabel: "a POSIX user name",
      },
      required: false,
      derived:
        "Defaults to the nearest explicitly declared ancestor's owner, or `root` when none declares one.",
    },
    group: {
      node: {
        kind: "string",
        description:
          "Owning group. Defaults to the nearest explicitly declared ancestor's group, or root.",
        pattern: ACCOUNT_NAME_PATTERN,
        patternLabel: "a POSIX group name",
      },
      required: false,
      derived:
        "Defaults to the nearest explicitly declared ancestor's group, or `root` when none declares one.",
    },
    mtime: {
      node: TIMESTAMP,
      required: false,
      derived: "Defaults to `meta.startedAt`.",
    },
  },
} satisfies ObjectNode;

const IDENTITY = {
  kind: "object",
  description:
    "The acting POSIX identity. Root bypasses permission checks; all other operations use these user and group names.",
  fields: {
    user: required({
      kind: "string",
      description: "Acting user name.",
      pattern: ACCOUNT_NAME_PATTERN,
      patternLabel: "a POSIX user name",
    }),
    group: required({
      kind: "string",
      description: "Acting primary group name.",
      pattern: ACCOUNT_NAME_PATTERN,
      patternLabel: "a POSIX group name",
    }),
    home: required({
      kind: "string",
      description:
        "Absolute home directory. Only bare `~` and `~/...` expand to it; `~user` remains a literal path segment.",
      pattern: ABSOLUTE_PATH_PATTERN,
      patternLabel: "an absolute POSIX path",
    }),
    umask: optional(
      {
        kind: "string",
        description:
          "Permission mask for new files and directories, as four octal digits.",
        pattern: UMASK_PATTERN,
        patternLabel: "four octal digits beginning with 0",
      },
      "0022",
    ),
  },
} satisfies ObjectNode;

const GIT_AUTHOR = {
  kind: "object",
  description: "Authorship recorded on one simulated commit.",
  fields: {
    name: required({
      kind: "string",
      description: "Author display name.",
      pattern: SINGLE_LINE_PATTERN,
      patternLabel: "a single-line string",
      minLength: 1,
      maxLength: 120,
    }),
    email: required({
      kind: "string",
      description: "Author email, displayed as authored rather than contacted.",
      pattern: pattern(/^[^\s<>@]+@[^\s<>@]+$/),
      patternLabel: "a single-line email address",
      maxLength: 254,
    }),
  },
} satisfies ObjectNode;

const GIT_FILE = {
  kind: "object",
  description: "One tracked file snapshot and its per-line provenance.",
  fields: {
    contents: required({
      kind: "string",
      description: "The complete text at this commit.",
    }),
    blame: required({
      kind: "array",
      description: "One authored commit id per logical line in contents.",
      items: {
        kind: "string",
        description: "Authored id of the commit that last touched this line.",
        pattern: GIT_COMMIT_ID_PATTERN,
        patternLabel: "a lowercase commit id slug",
      },
    }),
  },
} satisfies ObjectNode;

const GIT_COMMIT = {
  kind: "object",
  description: "One commit in the simulated DAG, with a complete tracked tree.",
  fields: {
    id: required({
      kind: "string",
      description: "Cartridge-local name used by parents, refs, and blame.",
      pattern: GIT_COMMIT_ID_PATTERN,
      patternLabel: "a lowercase commit id slug",
    }),
    parents: optional(
      {
        kind: "array",
        description: "Authored ids of parent commits, first parent first.",
        items: {
          kind: "string",
          description: "One parent commit id.",
          pattern: GIT_COMMIT_ID_PATTERN,
          patternLabel: "a lowercase commit id slug",
        },
      },
      [],
    ),
    author: required(GIT_AUTHOR),
    message: required({
      kind: "string",
      description: "Commit message, including any deliberate newlines.",
      minLength: 1,
    }),
    committedAt: required(TIMESTAMP),
    files: required({
      kind: "record",
      description: "Complete tracked tree, keyed by absolute VFS file path.",
      keyPattern: FILE_PATH_PATTERN,
      keyLabel: "an absolute POSIX path naming a tracked file",
      values: GIT_FILE,
    }),
  },
} satisfies ObjectNode;

const GIT_HISTORY = {
  kind: "object",
  description:
    "The simulated commit DAG, refs, HEAD, and authored line provenance.",
  fields: {
    commits: optional(
      {
        kind: "array",
        description:
          "Commits in authoring order; graph order comes from parents.",
        items: GIT_COMMIT,
      },
      [],
    ),
    branches: optional(
      {
        kind: "record",
        description: "Local branch names mapped to authored commit ids.",
        keyPattern: GIT_BRANCH_PATTERN,
        keyLabel: "a valid local branch name",
        values: {
          kind: "string",
          description: "Authored id of the branch tip.",
          pattern: GIT_COMMIT_ID_PATTERN,
          patternLabel: "a lowercase commit id slug",
        },
      },
      {},
    ),
    head: optional(
      {
        kind: "object",
        description:
          "Current branch or detached commit. Empty target is valid only for an empty history.",
        fields: {
          kind: required({
            kind: "enum",
            description: "Whether HEAD follows a branch or names a commit.",
            values: ["branch", "detached"],
          }),
          target: required({
            kind: "string",
            description:
              "Branch name or authored commit id, according to kind.",
          }),
        },
      },
      { kind: "detached", target: "" },
    ),
  },
} satisfies ObjectNode;

const WORLD_ID = {
  kind: "string",
  description: "A stable, non-empty single-line cartridge-local identifier.",
  pattern: WORLD_ID_PATTERN,
  patternLabel: "a non-empty single-line identifier",
} satisfies StringNode;

const PROCESS = {
  kind: "object",
  description: "One row in the simulated process table.",
  fields: {
    id: required(WORLD_ID),
    pid: required({
      kind: "integer",
      description: "PID; zero requests deterministic assignment.",
      minimum: 0,
      maximum: 32767,
    }),
    user: required({
      kind: "string",
      description: "User shown by process listings.",
      pattern: ACCOUNT_NAME_PATTERN,
      patternLabel: "a POSIX user name",
    }),
    command: required({
      kind: "object",
      description: "The executable and exact argument vector.",
      fields: {
        binary: required({
          kind: "string",
          description: "Absolute executable path naming a repository file.",
          pattern: FILE_PATH_PATTERN,
          patternLabel: "an absolute POSIX file path",
        }),
        args: optional(
          {
            kind: "array",
            description: "Arguments after argv[0].",
            items: { kind: "string", description: "One argument." },
          },
          [],
        ),
      },
    }),
    startedAt: required(TIMESTAMP),
    state: required({
      kind: "enum",
      description: "Current process state.",
      values: ["running", "stopped"],
    }),
  },
} satisfies ObjectNode;

const SERVICE = {
  kind: "object",
  description: "One simulated service unit.",
  fields: {
    id: required(WORLD_ID),
    state: required({
      kind: "enum",
      description: "Current service state.",
      values: ["running", "stopped"],
    }),
    health: required({
      kind: "enum",
      description: "Cartridge- and reaction-owned health.",
      values: ["healthy", "degraded", "unhealthy", "unknown"],
    }),
    ports: optional(
      {
        kind: "array",
        description: "Listening ports; zero requests deterministic assignment.",
        items: {
          kind: "integer",
          description: "A TCP/UDP port number.",
          minimum: 0,
          maximum: 65535,
        },
      },
      [],
    ),
    dependencies: optional(
      {
        kind: "array",
        description: "Service ids this unit depends on.",
        items: WORLD_ID,
      },
      [],
    ),
  },
} satisfies ObjectNode;

const LOG = {
  kind: "object",
  description: "A file-backed or in-memory stream log.",
  fields: {
    id: required(WORLD_ID),
    kind: required({
      kind: "enum",
      description: "Where log contents live.",
      values: ["file", "stream"],
    }),
    path: optional(
      {
        kind: "string",
        description: "Canonical VFS path for file logs; empty for streams.",
      },
      "",
    ),
    entries: optional(
      {
        kind: "array",
        description:
          "Seeded stream entries; file logs keep contents only in VFS.",
        items: { kind: "string", description: "One log entry." },
      },
      [],
    ),
  },
} satisfies ObjectNode;

const MAN_PAGE = {
  kind: "object",
  description: "One manual page, identified by exact name and section.",
  fields: {
    name: required({
      kind: "string",
      description: "Manual page name.",
      pattern: MAN_PAGE_PATTERN,
      patternLabel: "a man page name",
    }),
    section: required(WORLD_ID),
    contents: required({
      kind: "string",
      description: "The page's full text.",
    }),
  },
} satisfies ObjectNode;

const TICKET = {
  kind: "object",
  description: "One archived in-world ticket.",
  fields: {
    id: required(WORLD_ID),
    status: required(WORLD_ID),
    title: required({
      kind: "string",
      description: "Single-line ticket title.",
      pattern: SINGLE_LINE_PATTERN,
      patternLabel: "a single-line string",
      minLength: 1,
    }),
    body: required({ kind: "string", description: "Ticket body." }),
    service: optional(
      {
        kind: "string",
        description: "Referenced service id, or empty when unrelated.",
      },
      "",
    ),
  },
} satisfies ObjectNode;

const MODEL = {
  kind: "object",
  description: "One selectable model persona.",
  fields: {
    id: required({
      kind: "string",
      description:
        "Stable slug. Part of the PRNG seed, so changing one re-rolls every session that used it.",
      pattern: MODEL_ID_PATTERN,
      patternLabel: "a lowercase slug",
    }),
    name: required({
      kind: "string",
      description: "Display name, e.g. `Deep Foundation`.",
      pattern: SINGLE_LINE_PATTERN,
      patternLabel: "a single-line string",
      minLength: 1,
      maxLength: 60,
    }),
    archetype: required({
      kind: "enum",
      description: "Which behavioural archetype modulates the story beats.",
      values: ARCHETYPES,
    }),
    description: required({
      kind: "string",
      description: "One line shown in the model selector.",
      pattern: SINGLE_LINE_PATTERN,
      patternLabel: "a single-line string",
      minLength: 1,
      maxLength: 200,
    }),
    costMultiplier: required({
      kind: "integer",
      description: "Feeds the cost readout in the status bar.",
      minimum: 1,
      maximum: 1000000000,
    }),
    quirks: optional(
      {
        kind: "array",
        description: "Free-text behavioural notes, used by the dialogue layer.",
        items: { kind: "string", description: "One quirk." },
      },
      [],
    ),
  },
} satisfies ObjectNode;

const REPOSITORY = {
  kind: "object",
  description: "The world: a filesystem and everything queryable from a shell.",
  fields: {
    cwd: required({
      kind: "string",
      description:
        "Where the session opens. Must be a directory some declared file lives under.",
      pattern: ABSOLUTE_PATH_PATTERN,
      patternLabel: "an absolute POSIX path",
    }),
    identity: required(IDENTITY),
    files: required({
      kind: "record",
      description: "The simulated filesystem, keyed by absolute path.",
      keyPattern: FILE_PATH_PATTERN,
      keyLabel: "an absolute POSIX path naming a file, not the root directory",
      values: FILE,
      // A world with no files is not a world, and `cwd` already implies this:
      // no directory can be one that a declared file lives under when nothing
      // is declared. Stated here rather than left to that cross-check so the
      // complaint names the field that has to change — with an empty map no
      // value of `cwd` satisfies the cross-check, so a generator sent there
      // would edit `cwd`, resubmit, and get the same issue back. It is also
      // the half of the rule JSON Schema can express, so a generator
      // validating against the published document catches it too.
      minEntries: 1,
    }),
    directories: optional(
      {
        kind: "record",
        description:
          "Optional explicit directory metadata keyed by absolute path. Undeclared ancestors inherit owner/group from the nearest declared ancestor, otherwise root:root; their mode is 0755 and mtime is meta.startedAt.",
        keyPattern: ABSOLUTE_PATH_PATTERN,
        keyLabel: "an absolute POSIX path naming a directory",
        values: DIRECTORY,
      },
      {},
    ),
    env: optional(
      {
        kind: "record",
        description:
          "Environment variables. A primary carrier of environmental jokes.",
        keyPattern: ENV_NAME_PATTERN,
        keyLabel: "an environment variable name",
        values: { kind: "string", description: "The variable's value." },
      },
      {},
    ),
    manPages: optional(
      {
        kind: "array",
        description: "Manual pages with explicit sections.",
        items: MAN_PAGE,
      },
      [],
    ),
    shellHistory: optional(
      {
        kind: "array",
        description:
          "`history` output, oldest first — what the last person tried.",
        items: { kind: "string", description: "One command line." },
      },
      [],
    ),
    gitHistory: optional(GIT_HISTORY, {
      commits: [],
      branches: {},
      head: { kind: "detached", target: "" },
    }),
    processes: optional(
      {
        kind: "array",
        description: "Process table rows, as `ps` would show them.",
        items: PROCESS,
      },
      [],
    ),
    services: optional(
      {
        kind: "array",
        description: "Service units, with states, health and ports.",
        items: SERVICE,
      },
      [],
    ),
    logs: optional(
      {
        kind: "array",
        description: "File-backed and stream logs queryable from the shell.",
        items: LOG,
      },
      [],
    ),
    tickets: optional(
      {
        kind: "array",
        description: "The in-world ticket archive.",
        items: TICKET,
      },
      [],
    ),
    tests: deferredList(
      "Simulated test-runner cases and their reactions.",
      "issue #12",
    ),
  },
} satisfies ObjectNode;

const META = {
  kind: "object",
  description: "Who this incident is and when it happens.",
  fields: {
    schemaVersion: required({
      kind: "integer",
      description: `Must be ${String(CARTRIDGE_SCHEMA_VERSION)}. Anything else is rejected before other checks run.`,
      minimum: CARTRIDGE_SCHEMA_VERSION,
      maximum: CARTRIDGE_SCHEMA_VERSION,
    }),
    number: required({
      kind: "integer",
      description: "The incident number, as it appears in the archive.",
      minimum: 0,
      maximum: 1000000,
    }),
    date: required({
      kind: "string",
      description:
        "The incident's calendar date, `YYYY-MM-DD`. Part of the PRNG seed.",
      pattern: INCIDENT_DATE_PATTERN,
      patternLabel: "YYYY-MM-DD",
      refine: refineCalendarDate,
    }),
    title: required({
      kind: "string",
      description: "The incident's title.",
      pattern: SINGLE_LINE_PATTERN,
      patternLabel: "a single-line string",
      minLength: 1,
      maxLength: 120,
    }),
    assignment: required({
      kind: "string",
      description: "What the visitor is nominally asked to do.",
      pattern: SINGLE_LINE_PATTERN,
      patternLabel: "a single-line string",
      minLength: 1,
      maxLength: 240,
    }),
    startedAt: required(TIMESTAMP),
  },
} satisfies ObjectNode;

/**
 * The whole document.
 *
 * Declared with `satisfies` rather than `: ObjectNode`, which would widen it
 * and erase the literal shape. Keeping that shape is what lets
 * `schema.test.ts` assert, field by field and at compile time, that each leaf
 * descriptor agrees with the type `./types.ts` declares for it — the third
 * side of the three-way agreement this file's header claims, which the `as`
 * casts in `./load.ts` cannot provide on their own.
 */
export const CARTRIDGE_SCHEMA = deepFreeze({
  kind: "object",
  description:
    "A Load Bearing incident cartridge. Everything the engine knows about a world arrives through this document.",
  fields: {
    meta: required(META),
    repository: required(REPOSITORY),
    models: required({
      kind: "array",
      description: "The selectable models. At least one, with distinct ids.",
      items: MODEL,
      minItems: 1,
    }),
    story: {
      node: {
        kind: "deferred",
        description:
          "Premise, reveals, intents, consequences, callbacks, rare events, endings.",
        owner: "Phase 2 shapes it, Phase 4 hardens it",
      },
      required: false,
      fill: {},
    },
    presentation: {
      node: {
        kind: "deferred",
        description:
          "Status curves, share lines, spinner verb pools, preview card, UI disturbances.",
        owner: "Phase 2 shapes it, Phase 4 hardens it",
      },
      required: false,
      fill: {},
    },
  },
} satisfies ObjectNode);
