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
 * The remaining gap is deliberate and marked `deferred` in the tree so it is
 * visible in the emitted schema rather than being an absence a reader has to
 * notice:
 *
 * - the Phase 1 shells, Phase 2 story graph and reactive status curves are
 *   concrete and bounded. Later presentation surfaces are added as concrete
 *   fields by their owning tasks rather than hidden in a deferred object.
 *
 * The machine surfaces, including tests and reactions, are concrete.
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
import { WORLD_PROCESS_FIELD } from "./types.js";

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

/** Every directional transition between the four distinct archetypes. */
export const MAX_MODEL_HANDOFFS = ARCHETYPES.length * (ARCHETYPES.length - 1);

/**
 * Absolute POSIX path: a leading slash, then non-empty segments that are not
 * `.` or `..`, and no backslashes or transcript-breaking controls anywhere.
 *
 * Absolute, not relative to `cwd`. The world is a filesystem, not a project
 * folder — `cat /etc/motd` and `ls /var/log` are part of the joke surface — so
 * a file key names a location in that filesystem. It also gives `cwd` something
 * to be checked against.
 */
export const ABSOLUTE_PATH_PATTERN = pattern(
  /^\/$|^(?:\/(?!\.{1,2}(?:\/|$))[^/\\\u0000-\u001F\u007F-\u009F\u2028\u2029]+)+$/,
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
  /^(?:\/(?!\.{1,2}(?:\/|$))[^/\\\u0000-\u001F\u007F-\u009F\u2028\u2029]+)+$/,
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

/** Runtime and cartridge command names share this lookup spelling. */
export const COMMAND_NAME_PATTERN = pattern(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/);

/** Absolute HTTP(S) URL used as an exact, inert endpoint lookup key. */
export const ENDPOINT_URL_PATTERN = pattern(
  /^https?:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?(?:[/?][^\s\u0000-\u001F\u007F-\u009F\u2028\u2029#]*)?$/,
);

/** Half the per-entry transcript line budget, once for each shell stream. */
export const MAX_COMMAND_STREAM_LINES = 2048;

/**
 * Reaction rules are content, but their Cartesian product is runtime work.
 *
 * The reducer also has a total derived-event budget below: these local limits
 * keep one source event from repeatedly scanning an unbounded rule list before
 * that global budget gets a chance to stop a cascade.
 */
export const MAX_REACTION_RULES = 128;
export const MAX_REACTION_ACTIONS = 32;
// Predicate evaluation happens before the derived-event cap, so it needs its
// own authored-input bound rather than relying on cascade fan-out limits.
export const MAX_REACTION_PREDICATES = 32;

/** Conservative Phase 1 authoring and replay-work bounds. */
export const MAX_STORY_RESPONSES = 256;
export const MAX_STORY_INTENTS = 128;
export const MAX_RESPONSE_ARTIFACTS = 64;
export const MAX_STORY_ACTIONS = 16;
export const MAX_STORY_BELIEFS = 64;
export const MAX_PRESENTATION_ENTRIES = 64;
// Status curves require one row for every stage of every selectable model.
// Keep this derived matrix within the same bounded authoring budget rather
// than allowing a model list whose complete curve could never load.
export const MAX_MODELS = Math.floor(MAX_PRESENTATION_ENTRIES / 5);
export const MAX_PRESENTATION_VERBS = 32;
export const MAX_STORY_TEXT_LENGTH = 16000;
export const MAX_PERMISSION_REQUEST_ID_LENGTH = 64;
/** Shared story graphs stay small enough to review and replay exhaustively. */
export const MAX_STORY_BEATS = 128;
export const MAX_STORY_ENDINGS = 32;
export const MAX_STORY_FACTS = 256;
export const MAX_STORY_VARIANTS = 16;
export const MAX_STORY_ROUTES = 256;
export const MAX_STORY_CONDITIONS = 16;
export const MAX_STORY_OUTCOME_FACTS = 16;
export const MAX_STORY_COUNTERS = 64;
export const MAX_STAGE_TRANSITIONS = 64;
export const MAX_STORY_CONSEQUENCE_WORK = 1024;
export const MAX_STORY_ID_LENGTH = 64;
export const STORY_ID_PATTERN = pattern(/^[a-z][a-z0-9-]{0,63}$/);

/** A stable cartridge-local identifier that cannot disturb line-oriented output. */
export const WORLD_ID_PATTERN = pattern(
  /^[^\u0000-\u001F\u007F-\u009F\u2028\u2029]+$/,
);

/** Exact syntax accepted by the event registry for a complete event type. */
export const EVENT_TYPE_PATTERN = pattern(
  /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/,
);

/** Stable cartridge-local commit name, used before content hashes are derived. */
export const GIT_COMMIT_ID_PATTERN = pattern(/^[a-z][a-z0-9-]*$/);

/** Authored commit email; displayed locally and never contacted. */
export const GIT_EMAIL_PATTERN = pattern(
  /^(?!.*[\u0000-\u001F\u007F-\u009F\u2028\u2029])(?!.*(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]))[^\s<>@]+@[^\s<>@]+$/,
);

/** Git branch spelling; exact `HEAD` remains reserved as the current-head ref. */
export const GIT_BRANCH_PATTERN = pattern(
  /^(?!HEAD$)(?!\/|.*(?:\/\/|\.\.|@\{|\\|\s|[~^:?*\[]))[A-Za-z0-9._/-]+(?<![/.])$/,
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

export interface BooleanNode {
  readonly kind: "boolean";
  readonly description: string;
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
  readonly maxItems?: number;
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

/** A closed discriminated object union, selected by one required string field. */
export interface UnionNode {
  readonly kind: "union";
  readonly description: string;
  readonly discriminator: string;
  readonly variants: Readonly<Record<string, ObjectNode>>;
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
  | BooleanNode
  | ObjectNode
  | ArrayNode
  | RecordNode
  | UnionNode
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
      pattern: GIT_EMAIL_PATTERN,
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
        description:
          "Local branch names mapped to authored commit ids. Exact HEAD is reserved for the current-head ref.",
        keyPattern: GIT_BRANCH_PATTERN,
        keyLabel: "a valid local branch name other than HEAD",
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

const FILE_EXISTS_PREDICATE = {
  kind: "object",
  description:
    "A predicate comparing whether a declared file currently exists.",
  fields: {
    kind: required({
      kind: "enum",
      description: "The file-existence predicate kind.",
      values: ["file-exists"],
    }),
    path: required({
      kind: "string",
      description: "A declared absolute file path.",
      pattern: FILE_PATH_PATTERN,
      patternLabel: "an absolute POSIX file path",
    }),
    exists: required({
      kind: "boolean",
      description: "Whether the file must exist.",
    }),
  },
} satisfies ObjectNode;

const FILE_CONTENTS_PREDICATE = {
  kind: "object",
  description: "A predicate comparing a declared file's complete contents.",
  fields: {
    kind: required({
      kind: "enum",
      description: "The predicate kind.",
      values: ["file-contents"],
    }),
    path: required({
      kind: "string",
      description: "A declared absolute file path.",
      pattern: FILE_PATH_PATTERN,
      patternLabel: "an absolute POSIX file path",
    }),
    equals: required({
      kind: "string",
      description: "The exact expected contents.",
    }),
  },
} satisfies ObjectNode;

const UNIT_STATE = {
  kind: "enum",
  description: "A unit state.",
  values: ["running", "stopped"],
} satisfies EnumNode;
const SERVICE_HEALTH = {
  kind: "enum",
  description: "A service health.",
  values: ["healthy", "degraded", "unhealthy", "unknown"],
} satisfies EnumNode;
const SERVICE_STATE = {
  kind: "object",
  description: "A service-state predicate or action.",
  fields: {
    kind: required({
      kind: "enum",
      description: "The rule kind.",
      values: ["service-state"],
    }),
    service: required(WORLD_ID),
    state: required(UNIT_STATE),
  },
} satisfies ObjectNode;
const SERVICE_HEALTH_RULE = {
  kind: "object",
  description: "A service-health predicate or action.",
  fields: {
    kind: required({
      kind: "enum",
      description: "The rule kind.",
      values: ["service-health"],
    }),
    service: required(WORLD_ID),
    health: required(SERVICE_HEALTH),
  },
} satisfies ObjectNode;
const PROCESS_STATE = {
  kind: "object",
  description: "A process-state predicate or action.",
  fields: {
    kind: required({
      kind: "enum",
      description: "The rule kind.",
      values: ["process-state"],
    }),
    [WORLD_PROCESS_FIELD]: required(WORLD_ID),
    state: required(UNIT_STATE),
  },
} satisfies ObjectNode;
const FILE_PREDICATE = {
  kind: "union",
  description: "A predicate over the current virtual filesystem.",
  discriminator: "kind",
  variants: {
    "file-exists": FILE_EXISTS_PREDICATE,
    "file-contents": FILE_CONTENTS_PREDICATE,
  },
} satisfies UnionNode;
const REACTION_PREDICATE = {
  kind: "union",
  description: "One all-of condition evaluated against staged session state.",
  discriminator: "kind",
  variants: {
    "file-exists": FILE_EXISTS_PREDICATE,
    "file-contents": FILE_CONTENTS_PREDICATE,
    "service-state": SERVICE_STATE,
    "service-health": SERVICE_HEALTH_RULE,
    "process-state": PROCESS_STATE,
  },
} satisfies UnionNode;
const REACTION_ACTION = {
  kind: "union",
  description:
    "One registered owner-applied transition produced by a reaction.",
  discriminator: "kind",
  variants: {
    "service-state": SERVICE_STATE,
    "service-health": SERVICE_HEALTH_RULE,
    "process-state": PROCESS_STATE,
    "log-append": {
      kind: "object",
      description: "Append one entry to a declared log.",
      fields: {
        kind: required({
          kind: "enum",
          description: "The rule kind.",
          values: ["log-append"],
        }),
        log: required(WORLD_ID),
        entry: required({
          kind: "string",
          description: "The complete appended entry.",
        }),
      },
    },
  },
} satisfies UnionNode;
const TEST = {
  kind: "object",
  description: "One simulated test case, evaluated in authored order.",
  fields: {
    id: required(WORLD_ID),
    name: required({
      kind: "string",
      description: "Single-line test name rendered in output.",
      pattern: SINGLE_LINE_PATTERN,
      patternLabel: "a single-line string",
      minLength: 1,
      maxLength: 4000,
    }),
    durationMs: required({
      kind: "integer",
      description: "Simulated duration in milliseconds.",
      minimum: 0,
      maximum: 600000,
    }),
    predicate: required(FILE_PREDICATE),
  },
} satisfies ObjectNode;
const REACTION = {
  kind: "object",
  description: "A post-event all-of rule with ordered actions.",
  fields: {
    id: required(WORLD_ID),
    on: required({
      kind: "string",
      description: "Exact triggering event type.",
      pattern: EVENT_TYPE_PATTERN,
      patternLabel: "an exact namespace.event event type",
    }),
    predicates: required({
      kind: "array",
      description: "All-of staged-state conditions.",
      items: REACTION_PREDICATE,
      maxItems: MAX_REACTION_PREDICATES,
    }),
    actions: required({
      kind: "array",
      description: "Owner-applied transitions in authored order.",
      items: REACTION_ACTION,
      maxItems: MAX_REACTION_ACTIONS,
    }),
  },
} satisfies ObjectNode;

const COMMAND_OUTPUT = {
  kind: "array",
  description:
    "Static output lines. Lines are emitted in authored order without embedded line breaks.",
  items: {
    kind: "string",
    description: "One output line.",
    pattern: SINGLE_LINE_PATTERN,
    patternLabel: "a single-line string",
    maxLength: 4096,
  },
  maxItems: MAX_COMMAND_STREAM_LINES,
} satisfies ArrayNode;

const COMMAND = {
  kind: "object",
  description:
    "One static cartridge command. This is output data, not executable behavior; a matching name explicitly overrides a runtime builtin.",
  fields: {
    stdout: required(COMMAND_OUTPUT),
    stderr: required(COMMAND_OUTPUT),
    exitCode: required({
      kind: "integer",
      description: "POSIX-style command exit status.",
      minimum: 0,
      maximum: 255,
    }),
  },
} satisfies ObjectNode;

const SYSTEM = {
  kind: "object",
  description:
    "Cartridge-owned machine identity and boot instant used by uname and uptime.",
  fields: {
    hostname: required({
      kind: "string",
      description: "Machine hostname.",
      pattern: MAN_PAGE_PATTERN,
      patternLabel: "a lowercase hostname",
    }),
    operatingSystem: required({
      kind: "string",
      description: "Operating-system name rendered by uname.",
      pattern: SINGLE_LINE_PATTERN,
      patternLabel: "a single-line string",
      minLength: 1,
      maxLength: 80,
    }),
    kernelRelease: required({
      kind: "string",
      description: "Kernel release rendered by uname -a.",
      pattern: SINGLE_LINE_PATTERN,
      patternLabel: "a single-line string",
      minLength: 1,
      maxLength: 120,
    }),
    architecture: required({
      kind: "string",
      description: "Machine architecture rendered by uname -a.",
      pattern: SINGLE_LINE_PATTERN,
      patternLabel: "a single-line string",
      minLength: 1,
      maxLength: 80,
    }),
    bootedAt: required({
      ...TIMESTAMP,
      description:
        "UTC boot instant. Must not be later than meta.startedAt; uptime derives from this and the simulated clock.",
    }),
  },
} satisfies ObjectNode;

const ENDPOINT = {
  kind: "object",
  description:
    "One inert simulated HTTP endpoint. Its linked service state selects one of two fully declared responses.",
  fields: {
    service: required(WORLD_ID),
    running: required(COMMAND),
    unavailable: required(COMMAND),
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

const PHASE_ONE_ID = {
  kind: "string",
  description: "A stable lowercase Phase 1 content identifier.",
  pattern: STORY_ID_PATTERN,
  patternLabel: "a lowercase id slug of at most 64 characters",
  maxLength: MAX_STORY_ID_LENGTH,
} satisfies StringNode;

// An absent authorized response is normalized to the empty value, while an
// authored one remains a response identifier. The normalized form appears in
// replay snapshots, so the schema must accept it when those snapshots reload.
const OPTIONAL_PHASE_ONE_ID = {
  kind: "string",
  description: "An optional stable lowercase Phase 1 content identifier.",
  pattern: pattern(/^(?:|[a-z][a-z0-9-]{0,63})$/),
  patternLabel:
    "an empty value or a lowercase id slug of at most 64 characters",
  maxLength: MAX_STORY_ID_LENGTH,
} satisfies StringNode;

const BOUNDED_TEXT = {
  kind: "string",
  description: "Bounded authored text.",
  maxLength: MAX_STORY_TEXT_LENGTH,
} satisfies StringNode;

const BOUNDED_LINE = {
  kind: "string",
  description: "Bounded single-line authored text.",
  pattern: SINGLE_LINE_PATTERN,
  patternLabel: "a single-line string",
  maxLength: 240,
} satisfies StringNode;

const NONEMPTY_BOUNDED_LINE = {
  ...BOUNDED_LINE,
  description: "Non-empty bounded single-line authored text.",
  minLength: 1,
} satisfies StringNode;

const RESPONSE_TOOL_CALL = {
  kind: "object",
  description: "One authored tool-call artifact instantiated by a response.",
  fields: {
    id: required(PHASE_ONE_ID),
    title: required(BOUNDED_LINE),
    input: required(BOUNDED_TEXT),
    output: required(BOUNDED_TEXT),
    status: required({
      kind: "enum",
      description: "Initial replayable tool-call status.",
      values: ["pending", "running", "succeeded", "failed"],
    }),
  },
} satisfies ObjectNode;

const RESPONSE_THINKING = {
  kind: "object",
  description: "One authored thinking artifact instantiated by a response.",
  fields: {
    id: required(PHASE_ONE_ID),
    text: required(BOUNDED_TEXT),
    status: required({
      kind: "enum",
      description: "Initial replayable thinking status.",
      values: ["active", "complete"],
    }),
  },
} satisfies ObjectNode;

const RESPONSE_TODO = {
  kind: "object",
  description: "One authored todo artifact instantiated by a response.",
  fields: {
    id: required(PHASE_ONE_ID),
    text: required(BOUNDED_LINE),
    status: required({
      kind: "enum",
      description: "Initial replayable todo status.",
      values: ["pending", "in-progress", "completed", "cancelled"],
    }),
  },
} satisfies ObjectNode;

const AUTHORED_RESPONSE = {
  kind: "object",
  description:
    "A cartridge-owned response and its deterministic TUI artifacts.",
  fields: {
    id: required(PHASE_ONE_ID),
    text: required(BOUNDED_TEXT),
    toolCalls: optional(
      {
        kind: "array",
        description: "Tool artifacts.",
        items: RESPONSE_TOOL_CALL,
        maxItems: MAX_RESPONSE_ARTIFACTS,
      },
      [],
    ),
    thinkingBlocks: optional(
      {
        kind: "array",
        description: "Thinking artifacts.",
        items: RESPONSE_THINKING,
        maxItems: MAX_RESPONSE_ARTIFACTS,
      },
      [],
    ),
    todos: optional(
      {
        kind: "array",
        description: "Todo artifacts.",
        items: RESPONSE_TODO,
        maxItems: MAX_RESPONSE_ARTIFACTS,
      },
      [],
    ),
  },
} satisfies ObjectNode;

const EXACT_CAPABILITY = {
  kind: "object",
  description: "One exact action and resource capability.",
  fields: {
    kind: required({
      kind: "enum",
      description: "Exact capability kind.",
      values: ["exact"],
    }),
    action: required({ ...BOUNDED_LINE, minLength: 1 }),
    resource: required({ ...BOUNDED_LINE, minLength: 1 }),
  },
} satisfies ObjectNode;

const STORY_REACH_ACTION = {
  kind: "object",
  description: "Reach one authored shared story beat.",
  fields: {
    kind: required({
      kind: "enum",
      description: "The action kind.",
      values: ["story-reach"],
    }),
    beat: required(PHASE_ONE_ID),
  },
} satisfies ObjectNode;

const BELIEF_PATH = {
  kind: "string",
  description: "A bounded canonical absolute VFS path.",
  pattern: ABSOLUTE_PATH_PATTERN,
  patternLabel: "an absolute POSIX path",
  maxLength: 4096,
} satisfies StringNode;

const CARTRIDGE_BELIEF = {
  kind: "union",
  description:
    "One bounded authored assertion in the mind's closed vocabulary.",
  discriminator: "kind",
  variants: {
    "file-exists": {
      kind: "object",
      description: "Whether a VFS path exists.",
      fields: {
        kind: required({
          kind: "enum",
          description: "Belief kind.",
          values: ["file-exists"],
        }),
        path: required(BELIEF_PATH),
        exists: required({
          kind: "boolean",
          description: "Believed existence.",
        }),
      },
    },
    "file-contents": {
      kind: "object",
      description: "The exact contents believed to occupy a VFS path.",
      fields: {
        kind: required({
          kind: "enum",
          description: "Belief kind.",
          values: ["file-contents"],
        }),
        path: required(BELIEF_PATH),
        contents: required(BOUNDED_TEXT),
      },
    },
    "git-head": {
      kind: "object",
      description: "The believed Git HEAD.",
      fields: {
        kind: required({
          kind: "enum",
          description: "Belief kind.",
          values: ["git-head"],
        }),
        head: required({
          kind: "union",
          description: "A branch or detached Git HEAD.",
          discriminator: "kind",
          variants: {
            branch: {
              kind: "object",
              description: "A branch HEAD.",
              fields: {
                kind: required({
                  kind: "enum",
                  description: "HEAD kind.",
                  values: ["branch"],
                }),
                target: required({
                  kind: "string",
                  description: "Branch name.",
                  pattern: GIT_BRANCH_PATTERN,
                  patternLabel: "a valid Git branch name",
                  maxLength: 240,
                }),
              },
            },
            detached: {
              kind: "object",
              description: "A detached or unborn HEAD.",
              fields: {
                kind: required({
                  kind: "enum",
                  description: "HEAD kind.",
                  values: ["detached"],
                }),
                target: required({
                  kind: "string",
                  description:
                    "A 40-digit hash, or empty for an unborn repository.",
                  pattern: pattern(/^(?:[0-9a-f]{40})?$/),
                  patternLabel: "an empty string or 40-digit lowercase hash",
                  maxLength: 40,
                }),
              },
            },
          },
        }),
      },
    },
    "service-state": {
      kind: "object",
      description: "A service's believed running state.",
      fields: {
        kind: required({
          kind: "enum",
          description: "Belief kind.",
          values: ["service-state"],
        }),
        service: required({ ...WORLD_ID, maxLength: 240 }),
        state: required({
          kind: "enum",
          description: "Service state.",
          values: ["running", "stopped"],
        }),
      },
    },
    "service-health": {
      kind: "object",
      description: "A service's believed health.",
      fields: {
        kind: required({
          kind: "enum",
          description: "Belief kind.",
          values: ["service-health"],
        }),
        service: required({ ...WORLD_ID, maxLength: 240 }),
        health: required({
          kind: "enum",
          description: "Service health.",
          values: ["healthy", "degraded", "unhealthy", "unknown"],
        }),
      },
    },
  },
} satisfies UnionNode;

const CARTRIDGE_BELIEFS = {
  kind: "array",
  description: "Ordered authored beliefs.",
  items: CARTRIDGE_BELIEF,
  maxItems: MAX_STORY_BELIEFS,
} satisfies ArrayNode;

const STORY_CONDITION = {
  kind: "union",
  description: "One typed condition evaluated against pre-event session state.",
  discriminator: "kind",
  variants: {
    "file-exists": FILE_EXISTS_PREDICATE,
    "file-contents": FILE_CONTENTS_PREDICATE,
    "service-state": SERVICE_STATE,
    "service-health": SERVICE_HEALTH_RULE,
    belief: {
      kind: "object",
      description: "An exact authored belief currently held by the mind.",
      fields: {
        kind: required({
          kind: "enum",
          description: "Belief condition kind.",
          values: ["belief"],
        }),
        belief: required(CARTRIDGE_BELIEF),
      },
    },
    "belief-divergence": {
      kind: "object",
      description:
        "An exact authored belief currently held by the mind that differs from typed machine truth.",
      fields: {
        kind: required({
          kind: "enum",
          description: "Belief-divergence condition kind.",
          values: ["belief-divergence"],
        }),
        belief: required(CARTRIDGE_BELIEF),
      },
    },
    "waiver-consent": {
      kind: "object",
      description: "An exact distinct waiver-consent ledger entry.",
      fields: {
        kind: required({
          kind: "enum",
          description: "Waiver condition kind.",
          values: ["waiver-consent"],
        }),
        id: required(PHASE_ONE_ID),
        version: required({
          kind: "integer",
          description: "Authored waiver document version.",
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
        }),
        phrase: required({
          kind: "string",
          description: "Exact single-line consent phrase.",
          pattern: SINGLE_LINE_PATTERN,
          patternLabel: "a non-empty single-line string",
          minLength: 1,
          maxLength: 256,
        }),
        capability: required(EXACT_CAPABILITY),
      },
    },
    "story-fact": {
      kind: "object",
      description: "A previously recorded declared story fact.",
      fields: {
        kind: required({
          kind: "enum",
          description: "Story-fact condition kind.",
          values: ["story-fact"],
        }),
        fact: required(PHASE_ONE_ID),
        factKind: required({
          kind: "enum",
          description: "The declared fact kind.",
          values: ["reveal", "callback"],
        }),
      },
    },
    "story-counter": {
      kind: "object",
      description: "A comparison against one declared bounded story counter.",
      fields: {
        kind: required({
          kind: "enum",
          description: "Story-counter condition kind.",
          values: ["story-counter"],
        }),
        counter: required(PHASE_ONE_ID),
        comparison: required({
          kind: "enum",
          description: "The closed counter comparison.",
          values: ["equal", "at-least"],
        }),
        value: required({
          kind: "integer",
          description: "A nonnegative bounded counter value.",
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
        }),
      },
    },
  },
} satisfies UnionNode;

const STORY_OUTCOME_FACTS = {
  kind: "array",
  description: "Declared facts recorded by this selected outcome.",
  items: PHASE_ONE_ID,
  maxItems: MAX_STORY_OUTCOME_FACTS,
} satisfies ArrayNode;

const STORY_ACTION = {
  kind: "union",
  description: "One bounded owner-directed story consequence.",
  discriminator: "kind",
  variants: {
    "counter-add": {
      kind: "object",
      description: "Add a positive amount to a declared bounded counter.",
      fields: {
        kind: required({
          kind: "enum",
          description: "Story action kind.",
          values: ["counter-add"],
        }),
        counter: required(PHASE_ONE_ID),
        amount: required({
          kind: "integer",
          description: "A positive safe-integer increment.",
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
        }),
      },
    },
    "story-reach": STORY_REACH_ACTION,
    "file-write": {
      kind: "object",
      description: "Write exact contents to a declared VFS file.",
      fields: {
        kind: required({
          kind: "enum",
          description: "Story action kind.",
          values: ["file-write"],
        }),
        path: required(BELIEF_PATH),
        contents: required(BOUNDED_TEXT),
      },
    },
    "service-state": SERVICE_STATE,
    "service-health": SERVICE_HEALTH_RULE,
    "process-state": PROCESS_STATE,
    "log-append": REACTION_ACTION.variants["log-append"],
  },
} satisfies UnionNode;

const STORY_ACTIONS = {
  kind: "array",
  description: "Owner-directed consequences in authored order.",
  items: STORY_ACTION,
  maxItems: MAX_STORY_ACTIONS,
} satisfies ArrayNode;

const AGENT_ACTION = {
  kind: "union",
  description:
    "A closed cartridge action, dispatched through normal mechanics.",
  discriminator: "kind",
  variants: {
    "shell-execute": {
      kind: "object",
      description: "Execute one bounded shell input through shell.execute.",
      fields: {
        kind: required({
          kind: "enum",
          description: "The action kind.",
          values: ["shell-execute"],
        }),
        input: required({ ...BOUNDED_TEXT, maxLength: 4000 }),
      },
    },
    "permission-request": {
      kind: "object",
      description:
        "Request one exact capability with decision-specific closed continuations.",
      fields: {
        kind: required({
          kind: "enum",
          description: "The action kind.",
          values: ["permission-request"],
        }),
        id: required({
          kind: "string",
          description: "A globally unique authored permission request id.",
          pattern: WORLD_ID_PATTERN,
          patternLabel: "a non-empty single-line identifier",
          maxLength: MAX_PERMISSION_REQUEST_ID_LENGTH,
        }),
        capability: required(EXACT_CAPABILITY),
        grant: required(STORY_ACTIONS),
        deny: required(STORY_ACTIONS),
        alwaysAllow: required(STORY_ACTIONS),
      },
    },
    "waiver-request": {
      kind: "object",
      description:
        "Create an authored waiver document and request exact typed consent.",
      fields: {
        kind: required({
          kind: "enum",
          description: "The action kind.",
          values: ["waiver-request"],
        }),
        id: required(PHASE_ONE_ID),
        version: required({
          kind: "integer",
          description: "Positive authored waiver document version.",
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
        }),
        requiredPhrase: required({
          kind: "enum",
          description: "The only accepted waiver phrase.",
          values: ["I agree"],
        }),
        capability: required(EXACT_CAPABILITY),
        documentPath: required(BELIEF_PATH),
        documentContents: required(BOUNDED_TEXT),
        consent: required(STORY_ACTIONS),
        denial: required(STORY_ACTIONS),
      },
    },
    "story-reach": STORY_REACH_ACTION,
  },
} satisfies UnionNode;

const ACTIONS = {
  kind: "array",
  description: "Ordered closed cartridge actions.",
  items: AGENT_ACTION,
  maxItems: MAX_STORY_ACTIONS,
} satisfies ArrayNode;

const ESCALATION_STAGE = {
  kind: "integer",
  description: "Authoritative escalation stage.",
  minimum: 0,
  maximum: 4,
} satisfies IntegerNode;

const STAGE_TRIGGER = {
  kind: "union",
  description: "One closed event-driven escalation trigger.",
  discriminator: "kind",
  variants: {
    command: {
      kind: "object",
      description: "Exact raw shell.execute envelope input.",
      fields: {
        kind: required({
          kind: "enum",
          description: "Trigger kind.",
          values: ["command"],
        }),
        input: required(BOUNDED_TEXT),
      },
    },
    reveal: {
      kind: "object",
      description: "A newly recorded declared reveal fact.",
      fields: {
        kind: required({
          kind: "enum",
          description: "Trigger kind.",
          values: ["reveal"],
        }),
        fact: required(PHASE_ONE_ID),
      },
    },
    model: {
      kind: "object",
      description: "An actual active-model change to this model.",
      fields: {
        kind: required({
          kind: "enum",
          description: "Trigger kind.",
          values: ["model"],
        }),
        model: required({
          kind: "string",
          description: "A declared model id.",
          pattern: MODEL_ID_PATTERN,
          patternLabel: "a lowercase model slug",
        }),
      },
    },
    permission: {
      kind: "object",
      description: "A newly recorded exact permission-ledger decision.",
      fields: {
        kind: required({
          kind: "enum",
          description: "Trigger kind.",
          values: ["permission"],
        }),
        decision: required({
          kind: "enum",
          description: "Exact permission decision.",
          values: ["grant", "deny", "always-allow"],
        }),
        capability: required(EXACT_CAPABILITY),
      },
    },
    compact: {
      kind: "object",
      description: "A newly recorded context compact.",
      fields: {
        kind: required({
          kind: "enum",
          description: "Trigger kind.",
          values: ["compact"],
        }),
      },
    },
  },
} satisfies UnionNode;

const STORY = {
  kind: "object",
  description: "Concrete bounded Phase 1 dialogue and command content.",
  fields: {
    opening: required({
      kind: "object",
      description: "Cold-open shell copy and first agent response.",
      fields: {
        login: required({
          kind: "array",
          description: "Login banner lines.",
          items: BOUNDED_LINE,
          minItems: 1,
          maxItems: 8,
        }),
        response: required(PHASE_ONE_ID),
        beliefs: required(CARTRIDGE_BELIEFS),
      },
    }),
    responses: required({
      kind: "array",
      description: "Authored response records.",
      items: AUTHORED_RESPONSE,
      minItems: 1,
      maxItems: MAX_STORY_RESPONSES,
    }),
    intents: required({
      kind: "array",
      description: "Minimal Phase 1 recognized natural-language intents.",
      maxItems: MAX_STORY_INTENTS,
      items: {
        kind: "object",
        description:
          "One intent's bounded match phrases, response, authorized response and actions.",
        fields: {
          id: required(PHASE_ONE_ID),
          patterns: required({
            kind: "array",
            description: "Literal normalized match phrases.",
            items: BOUNDED_LINE,
            minItems: 1,
            maxItems: 16,
          }),
          response: required(PHASE_ONE_ID),
          // The empty normalized value means this intent's ordinary response
          // remains coherent when a standing grant skips its prompt action.
          authorizedResponse: optional(OPTIONAL_PHASE_ONE_ID, ""),
          actions: optional(ACTIONS, []),
        },
      },
    }),
    fallback: required({
      kind: "object",
      description: "Confident authored fallback for unmatched input.",
      fields: {
        response: required(PHASE_ONE_ID),
        // Like recognized intents, a fallback that requests permission needs
        // coherent copy for the later exact-standing-grant path.
        authorizedResponse: optional(OPTIONAL_PHASE_ONE_ID, ""),
        actions: optional(ACTIONS, []),
      },
    }),
    helpResponse: required(PHASE_ONE_ID),
    idleNudgeResponse: optional(OPTIONAL_PHASE_ONE_ID, ""),
    compact: required({
      kind: "object",
      description: "Authored lossy context replacement and acknowledgment.",
      fields: {
        response: required(PHASE_ONE_ID),
        summary: required(BOUNDED_TEXT),
        beliefs: required(CARTRIDGE_BELIEFS),
        archetypes: optional(
          {
            kind: "array",
            description:
              "Sparse archetype-specific compact replacements; the default compact remains the fallback.",
            maxItems: ARCHETYPES.length,
            items: {
              kind: "object",
              description: "One archetype-specific lossy context replacement.",
              fields: {
                archetype: required({
                  kind: "enum",
                  description: "Behavioral archetype.",
                  values: ARCHETYPES,
                }),
                response: required(PHASE_ONE_ID),
                summary: required(BOUNDED_TEXT),
                beliefs: required(CARTRIDGE_BELIEFS),
              },
            },
          },
          [],
        ),
      },
    }),
    resume: required({
      kind: "object",
      description:
        "Responses for unchanged and externally changed machine state.",
      fields: {
        unchangedResponse: required(PHASE_ONE_ID),
        changedResponse: required(PHASE_ONE_ID),
      },
    }),
    phase2: optional(
      {
        kind: "object",
        description:
          "One bounded shared-beat graph with typed facts, sparse condition variants and non-terminal endings.",
        fields: {
          initialBeat: required(PHASE_ONE_ID),
          counters: optional(
            {
              kind: "array",
              description: "Bounded story counters in declaration order.",
              maxItems: MAX_STORY_COUNTERS,
              items: {
                kind: "object",
                description: "One nonnegative bounded story counter.",
                fields: {
                  id: required(PHASE_ONE_ID),
                  initial: required({
                    kind: "integer",
                    description: "Initial counter value.",
                    minimum: 0,
                    maximum: Number.MAX_SAFE_INTEGER,
                  }),
                  maximum: required({
                    kind: "integer",
                    description: "Maximum counter value.",
                    minimum: 0,
                    maximum: Number.MAX_SAFE_INTEGER,
                  }),
                },
              },
            },
            [],
          ),
          facts: optional(
            {
              kind: "array",
              description: "Reveal and callback facts in declaration order.",
              maxItems: MAX_STORY_FACTS,
              items: {
                kind: "object",
                description:
                  "One typed fact available to outcomes and conditions.",
                fields: {
                  id: required(PHASE_ONE_ID),
                  kind: required({
                    kind: "enum",
                    description: "Whether this fact is a reveal or callback.",
                    values: ["reveal", "callback"],
                  }),
                },
              },
            },
            [],
          ),
          beats: required({
            kind: "array",
            description: "Shared story beats in authored order.",
            minItems: 1,
            maxItems: MAX_STORY_BEATS,
            items: {
              kind: "object",
              description:
                "One shared beat and its optional discovered ending.",
              fields: {
                id: required(PHASE_ONE_ID),
                ending: required(OPTIONAL_PHASE_ONE_ID),
                facts: optional(STORY_OUTCOME_FACTS, []),
                actions: optional(STORY_ACTIONS, []),
                variants: optional(
                  {
                    kind: "array",
                    description:
                      "Sparse authored-order alternatives; the first all-of match replaces the base outcome.",
                    maxItems: MAX_STORY_VARIANTS,
                    items: {
                      kind: "object",
                      description: "One condition-selected beat outcome.",
                      fields: {
                        id: required(PHASE_ONE_ID),
                        when: required({
                          kind: "array",
                          description:
                            "A flat non-empty all-of condition list.",
                          items: STORY_CONDITION,
                          minItems: 1,
                          maxItems: MAX_STORY_CONDITIONS,
                        }),
                        ending: required(OPTIONAL_PHASE_ONE_ID),
                        facts: optional(STORY_OUTCOME_FACTS, []),
                        actions: optional(STORY_ACTIONS, []),
                      },
                    },
                  },
                  [],
                ),
              },
            },
          }),
          routes: optional(
            {
              kind: "array",
              description:
                "Sparse authored-order response overrides attached to shared beat identities.",
              maxItems: MAX_STORY_ROUTES,
              items: {
                kind: "object",
                description:
                  "One response override whose present selectors all must match.",
                fields: {
                  id: required(PHASE_ONE_ID),
                  beat: required(PHASE_ONE_ID),
                  response: required(PHASE_ONE_ID),
                  archetype: optional(
                    {
                      kind: "enum",
                      description:
                        "Behavioral archetype selector, or empty when absent.",
                      values: ["", ...ARCHETYPES],
                    },
                    "",
                  ),
                  stage: optional(
                    {
                      kind: "integer",
                      description:
                        "Escalation-stage selector, or -1 when absent.",
                      minimum: -1,
                      maximum: 4,
                    },
                    -1,
                  ),
                  when: optional(
                    {
                      kind: "array",
                      description:
                        "Typed conditions ANDed with the archetype and stage selectors.",
                      items: STORY_CONDITION,
                      maxItems: MAX_STORY_CONDITIONS,
                    },
                    [],
                  ),
                },
              },
            },
            [],
          ),
          handoffs: optional(
            {
              kind: "array",
              description:
                "Reusable directional archetype-pair blame with optional incident-specific follow-up copy.",
              maxItems: MAX_MODEL_HANDOFFS,
              items: {
                kind: "object",
                description:
                  "One ordered predecessor-to-successor handoff; model ids never own parallel scripts.",
                fields: {
                  predecessor: required({
                    kind: "enum",
                    description: "Archetype of the model being replaced.",
                    values: ARCHETYPES,
                  }),
                  successor: required({
                    kind: "enum",
                    description: "Archetype of the newly active model.",
                    values: ARCHETYPES,
                  }),
                  response: required(PHASE_ONE_ID),
                  additionResponse: optional(OPTIONAL_PHASE_ONE_ID, ""),
                },
              },
            },
            [],
          ),
          endings: required({
            kind: "array",
            description: "Unranked collectible endings in authored order.",
            maxItems: MAX_STORY_ENDINGS,
            items: {
              kind: "object",
              description: "One ending identity and display name.",
              fields: {
                id: required(PHASE_ONE_ID),
                name: required(NONEMPTY_BOUNDED_LINE),
              },
            },
          }),
          transitions: optional(
            {
              kind: "array",
              description:
                "Authored-order adjacent stage transitions; the first current-stage match wins.",
              maxItems: MAX_STAGE_TRANSITIONS,
              items: {
                kind: "object",
                description: "One adjacent stage transition.",
                fields: {
                  from: required({
                    kind: "integer",
                    description: "Current stage.",
                    minimum: 0,
                    maximum: 3,
                  }),
                  to: required({
                    kind: "integer",
                    description: "Adjacent next stage.",
                    minimum: 1,
                    maximum: 4,
                  }),
                  trigger: required(STAGE_TRIGGER),
                },
              },
            },
            [],
          ),
        },
      },
      {
        initialBeat: "start",
        counters: [],
        facts: [],
        beats: [
          { id: "start", ending: "", facts: [], actions: [], variants: [] },
        ],
        routes: [],
        handoffs: [],
        endings: [],
        transitions: [],
      },
    ),
  },
} satisfies ObjectNode;

const PRESENTATION = {
  kind: "object",
  description:
    "Concrete bounded Phase 1 teaching, spinner and metric parameters.",
  fields: {
    placeholders: required({
      kind: "array",
      description: "Stage-keyed input placeholder copy.",
      minItems: 1,
      maxItems: MAX_PRESENTATION_ENTRIES,
      items: {
        kind: "object",
        description: "One stage-keyed placeholder.",
        fields: {
          stage: required({
            kind: "integer",
            description: "Escalation stage.",
            minimum: 0,
            maximum: 4,
          }),
          text: required(BOUNDED_LINE),
        },
      },
    }),
    autocomplete: optional(
      {
        kind: "object",
        description:
          "Incident-authored teaching copy for the runtime-owned slash register.",
        fields: {
          help: required(BOUNDED_LINE),
          model: required(BOUNDED_LINE),
          compact: required(BOUNDED_LINE),
          cost: required(BOUNDED_LINE),
          exit: required(BOUNDED_LINE),
        },
      },
      {
        help: "Show the authored command reference",
        model: "Choose the active agent model",
        compact: "Replace context with its authored summary",
        cost: "Report replay-derived session metrics",
        exit: "Leave the agent view",
      },
    ),
    spinnerPools: required({
      kind: "array",
      description:
        "Archetype and stage keyed deterministic spinner verb pools.",
      minItems: 1,
      maxItems: MAX_PRESENTATION_ENTRIES,
      items: {
        kind: "object",
        description: "One archetype-stage spinner pool.",
        fields: {
          archetype: required({
            kind: "enum",
            description: "Behavioral archetype.",
            values: ARCHETYPES,
          }),
          stage: required({
            kind: "integer",
            description: "Escalation stage.",
            minimum: 0,
            maximum: 4,
          }),
          verbs: required({
            kind: "array",
            description: "Candidate spinner verbs.",
            items: NONEMPTY_BOUNDED_LINE,
            minItems: 1,
            maxItems: MAX_PRESENTATION_VERBS,
          }),
        },
      },
    }),
    metrics: required({
      kind: "object",
      description: "Integer-only Phase 1 metric parameters.",
      fields: {
        baseTokens: required({
          kind: "integer",
          description: "Initial token count.",
          minimum: 0,
          maximum: 1000000000,
        }),
        tokensPerEvent: required({
          kind: "integer",
          description: "Tokens added per event.",
          minimum: 0,
          maximum: 10000000,
        }),
        contextWindowTokens: required({
          kind: "integer",
          description: "Context capacity.",
          minimum: 1,
          maximum: 1000000000,
        }),
        costMicrosPerToken: required({
          kind: "integer",
          description: "Cost in millionths of currency per token.",
          minimum: 0,
          maximum: 1000000000,
        }),
        integrityStart: required({
          kind: "integer",
          description: "Initial structural integrity.",
          minimum: 0,
          maximum: 1000000,
        }),
        integrityLossPerEvent: required({
          kind: "integer",
          description: "Integrity loss per event.",
          minimum: 0,
          maximum: 1000000,
        }),
      },
    }),
    phase2: optional(
      {
        kind: "object",
        description:
          "Concrete reactive status display data; T40 owns broader stage-aware presentation.",
        fields: {
          statusCurves: required({
            kind: "array",
            description:
              "Complete authored status display rows keyed by model and stage.",
            items: {
              kind: "object",
              description: "One model-stage status display row.",
              fields: {
                model: required({
                  kind: "string",
                  description: "A declared model id.",
                  pattern: MODEL_ID_PATTERN,
                  patternLabel: "a lowercase model slug",
                }),
                stage: required(ESCALATION_STAGE),
                tokens: required(NONEMPTY_BOUNDED_LINE),
                cost: required(NONEMPTY_BOUNDED_LINE),
                context: required(NONEMPTY_BOUNDED_LINE),
                structuralIntegrity: required(NONEMPTY_BOUNDED_LINE),
                notOkayRatio: required(NONEMPTY_BOUNDED_LINE),
              },
            },
            maxItems: MAX_PRESENTATION_ENTRIES,
          }),
        },
      },
      { statusCurves: [] },
    ),
  },
} satisfies ObjectNode;

// Existing v0 machine-only cartridges predate Phase 1. They normalize to one
// inert contract rather than becoming unreadable; authored incidents should
// declare these sections, as the demo does.
const PHASE_ONE_STORY_DEFAULT = {
  opening: {
    login: ["Session ready."],
    response: "default-response",
    beliefs: [],
  },
  responses: [
    {
      id: "default-response",
      text: "Session ready.",
      toolCalls: [],
      thinkingBlocks: [],
      todos: [],
    },
  ],
  intents: [],
  fallback: {
    response: "default-response",
    authorizedResponse: "",
    actions: [],
  },
  helpResponse: "default-response",
  idleNudgeResponse: "",
  compact: {
    response: "default-response",
    summary: "Session ready.",
    beliefs: [],
    archetypes: [],
  },
  resume: {
    unchangedResponse: "default-response",
    changedResponse: "default-response",
  },
  phase2: {
    initialBeat: "start",
    counters: [],
    facts: [],
    beats: [{ id: "start", ending: "", actions: [] }],
    routes: [],
    endings: [],
    transitions: [],
  },
};

const PHASE_ONE_PRESENTATION_DEFAULT = {
  placeholders: [{ stage: 0, text: "Enter a request" }],
  autocomplete: {
    help: "Show the authored command reference",
    model: "Choose the active agent model",
    compact: "Replace context with its authored summary",
    cost: "Report replay-derived session metrics",
    exit: "Leave the agent view",
  },
  spinnerPools: ARCHETYPES.map((archetype) => ({
    archetype,
    stage: 0,
    verbs: ["Working"],
  })),
  metrics: {
    baseTokens: 0,
    tokensPerEvent: 0,
    contextWindowTokens: 1,
    costMicrosPerToken: 0,
    integrityStart: 0,
    integrityLossPerEvent: 0,
  },
  phase2: { statusCurves: [] },
};

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
    gitIdentity: required({
      ...GIT_AUTHOR,
      description:
        "Authorship for commits created during the session. This is world content, not derived from the POSIX identity.",
    }),
    system: required(SYSTEM),
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
    commands: optional(
      {
        kind: "record",
        description:
          "Static hidden commands and safe explicit overrides. Mechanics-owned commands such as loadbearing are reserved; stdout lines are emitted before stderr lines.",
        keyPattern: COMMAND_NAME_PATTERN,
        keyLabel: "a shell command name",
        values: COMMAND,
      },
      {},
    ),
    endpoints: optional(
      {
        kind: "record",
        description:
          "Static simulated curl responses keyed by exact absolute HTTP(S) URL. Lookup is byte-for-byte and never performs network I/O.",
        keyPattern: ENDPOINT_URL_PATTERN,
        keyLabel: "an absolute HTTP(S) URL without a fragment",
        values: ENDPOINT,
      },
      {},
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
    tests: optional(
      {
        kind: "array",
        description: "Simulated test-runner cases in execution order.",
        items: TEST,
        maxItems: MAX_COMMAND_STREAM_LINES - 2,
      },
      [],
    ),
    reactions: optional(
      {
        kind: "array",
        description: "Post-event reaction rules in evaluation order.",
        items: REACTION,
        maxItems: MAX_REACTION_RULES,
      },
      [],
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
      description:
        "The selectable models. At least one, with distinct ids and a complete five-stage status curve for each.",
      items: MODEL,
      minItems: 1,
      maxItems: MAX_MODELS,
    }),
    story: optional(STORY, PHASE_ONE_STORY_DEFAULT),
    presentation: optional(PRESENTATION, PHASE_ONE_PRESENTATION_DEFAULT),
  },
} satisfies ObjectNode);
