/**
 * The cartridge loader: validate, normalize, hand back something the engine
 * can trust.
 *
 * Pure and headless (invariant 3): callers supply parsed JSON, this module
 * never touches a disk. `engine/testing/fixtures.ts` is the one place that
 * reads files, and it hands the result here.
 *
 * ## Every error at once, in a fixed order
 *
 * The nightly pipeline (Phase 5) writes cartridges without a human in the
 * loop, so a validator that reports the first problem and stops turns one bad
 * generation into as many round trips as it has mistakes. Every issue is
 * collected and reported together, in document order: fields in the order
 * `./schema.ts` declares them, record keys sorted, array items by index. The
 * two cross-field checks are appended after that, in a fixed order, since a
 * problem spanning two sections has no single position in the document. Either
 * way the order is a property of the schema and the data, never of JSON key
 * order or anything about the host — the same bad cartridge produces the same
 * report character for character on every machine.
 *
 * The one exception is the schema version, which is checked alone and aborts.
 * Validating a v1 document against v0's rules produces a page of cascading
 * nonsense that buries the only line worth reading.
 *
 * ## Normalization
 *
 * Loading fills declared defaults, deep-copies everything, and returns plain
 * JSON. Two semantically identical cartridges — differing only in key order,
 * or in whether they spelled out a default — load to values that serialize
 * byte for byte the same. That is what lets a loaded cartridge sit inside
 * recorded session state without making the recording depend on how the
 * cartridge happened to be written.
 */

import { deepFreeze } from "../freeze.js";
import { parseTimestamp } from "../clock/civil.js";
import { detectBrand } from "../serialize/canonical.js";
import { normalizeIntentPhrase } from "./intent.js";
import {
  CARTRIDGE_SCHEMA,
  CARTRIDGE_SCHEMA_VERSION,
  FILE_PATH_PATTERN,
} from "./schema.js";
import type { SchemaNode, ObjectNode } from "./schema.js";
import type {
  CartridgeDirectory,
  CartridgeAgentAction,
  CartridgeBelief,
  CartridgeGitCommit,
  CartridgeGitHistory,
  CartridgeMeta,
  CartridgeModel,
  CartridgePresentation,
  CartridgeReaction,
  CartridgeRepository,
  CartridgeStory,
  ReactionAction,
  LoadedCartridge,
} from "./types.js";

/** One thing wrong with a cartridge. */
export interface CartridgeIssue {
  /** RFC 6901 JSON pointer to the offending value. */
  readonly pointer: string;
  /** What the schema required there. */
  readonly expected: string;
  /** What was there instead. */
  readonly found: string;
}

/**
 * Thrown by `loadCartridge`, carrying every issue rather than the first.
 *
 * The issues are on the error as data, so a caller — a test, the Phase 4 CLI,
 * eventually the pipeline — can render them however it needs. The message is a
 * rendering of the same list, so a bare throw is still readable.
 */
export class CartridgeValidationError extends Error {
  readonly issues: readonly CartridgeIssue[];

  constructor(issues: readonly CartridgeIssue[]) {
    super(
      `cartridge is not valid (${String(issues.length)} ${issues.length === 1 ? "issue" : "issues"}):\n` +
        issues
          .map(
            (issue) =>
              `  ${issue.pointer === "" ? "/" : issue.pointer}: expected ${issue.expected}, found ${issue.found}`,
          )
          .join("\n"),
    );
    this.name = "CartridgeValidationError";
    this.issues = issues;
  }
}

/** Escape one JSON pointer token per RFC 6901. File paths contain slashes. */
function pointerToken(key: string): string {
  return key.split("~").join("~0").split("/").join("~1");
}

function child(pointer: string, key: string | number): string {
  return `${pointer}/${typeof key === "number" ? String(key) : pointerToken(key)}`;
}

/**
 * Describe a value for an error message.
 *
 * Scalars are shown; containers are named but not dumped, because a cartridge
 * is large and an error that pastes half of it back is not an error message.
 */
function describe(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (Array.isArray(value)) return `an array of ${String(value.length)}`;
  switch (typeof value) {
    case "string":
      return value.length > 40
        ? `${JSON.stringify(`${value.slice(0, 40)}…`)} (${String(value.length)} characters)`
        : JSON.stringify(value);
    case "number":
      // `JSON.stringify(Infinity)` is `"null"`, so an issue would claim the
      // cartridge held null when it held `1e400`. Reachable from ordinary
      // parsed JSON, unlike most of what this function guards against:
      // `JSON.parse` turns an overflowing exponent into `Infinity` without
      // complaint.
      return Number.isFinite(value) ? JSON.stringify(value) : String(value);
    case "boolean":
      return JSON.stringify(value);
    case "object":
      return "an object";
    default:
      return typeof value;
  }
}

/**
 * Code points in `value`, counted rather than materialized.
 *
 * `[...value].length` is the same number and one line, but it builds an array
 * of every character first: a five-million-character file costs tens of
 * megabytes to learn a length that is then compared against nothing. This
 * walks the surrogate pairs by hand instead, in constant space.
 */
function countCodePoints(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    // A high surrogate followed by a low one is one code point written as two
    // units. A lone surrogate is one code point of its own — malformed, but
    // this function counts rather than judges.
    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
    }
    count += 1;
  }
  return count;
}

/** "1 entry", "0 entries" — these counts are read by people, and by generators. */
function entryCount(count: number): string {
  return count === 1 ? "1 entry" : `${String(count)} entries`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collects issues so one pass can report all of them. */
class Report {
  readonly issues: CartridgeIssue[] = [];

  /**
   * The unusable keys of each record, by the record's own pointer.
   *
   * Recorded rather than inferred, because it cannot be inferred: a bad *key*
   * and a bad whole *value* are reported at the same pointer, so no amount of
   * pointer inspection tells them apart. A cross-check that reads keys needs
   * the first and not the second.
   *
   * Per key rather than per record, so a check can work with the keys that did
   * validate. One typo among a hundred file paths should not switch off the
   * world's only filesystem coherence check.
   */
  readonly unusableKeys = new Map<string, Set<string>>();

  /** Note that `key` of the record at `pointer` could not be read. */
  noteUnusableKey(pointer: string, key: string): void {
    const keys = this.unusableKeys.get(pointer);
    if (keys === undefined) this.unusableKeys.set(pointer, new Set([key]));
    else keys.add(key);
  }

  /** The keys of the record at `pointer` that this check can trust. */
  usableKeys(pointer: string, all: readonly string[]): readonly string[] {
    const unusable = this.unusableKeys.get(pointer);
    return unusable === undefined
      ? all
      : all.filter((key) => !unusable.has(key));
  }

  add(pointer: string, expected: string, found: unknown): void {
    this.issues.push({ pointer, expected, found: describe(found) });
  }

  /** Same, when `found` is already a phrase rather than a value. */
  addPhrase(pointer: string, expected: string, found: string): void {
    this.issues.push({ pointer, expected, found });
  }
}

/**
 * Build an object from key/value pairs without triggering an inherited setter.
 *
 * `out[key] = value` is not safe when the key comes from data. One key on
 * `Object.prototype` is an accessor, and assigning to it on a fresh `{}` calls
 * that setter instead of creating an own property — so a cartridge carrying
 * that key either loses the entry silently or walks away with the loaded
 * object's prototype replaced by whatever it supplied. Both were reachable
 * from valid-looking JSON: an environment variable so named vanished from
 * `repository.env`, and a deferred subtree so keyed loaded with zero issues
 * and then threw out of the canonical serializer at record time.
 *
 * `Object.fromEntries` defines each property rather than assigning it, which
 * is also what `JSON.parse` does — so a key that survives parsing survives
 * loading, and no key can reach a setter on the way.
 */
function objectFromEntries(
  entries: readonly (readonly [string, unknown])[],
): Record<string, unknown> {
  return Object.fromEntries(entries);
}

/**
 * How deep a `deferred` subtree may nest.
 *
 * The validated sections are bounded by the schema itself, but the deferred
 * `presentation.phase2` interior is explicitly unconstrained — so its depth is
 * whatever a cartridge says, and the clone below is recursive. `JSON.parse` happily
 * accepts a few thousand levels; the clone
 * then exhausts the stack and `loadCartridge` escapes with a bare `RangeError`
 * instead of a validation issue, which is the validation boundary failing open
 * on ordinary parsed JSON rather than on anything exotic.
 *
 * A limit rather than an iterative rewrite, because the limit is the honest
 * statement: a story graph sixty-four levels deep is not a story graph, and a
 * cartridge that nests that far is wrong in a way the pipeline should hear
 * about. The published schema carries the number too, since JSON Schema cannot
 * express it.
 */
export const MAX_DEFERRED_DEPTH = 64;

export const DENSE_ARRAY_EXPECTED = "a dense array with no extra properties";
const DENSE_ARRAY_FOUND = "an array with holes or properties JSON cannot carry";
const ARRAY_SUBCLASS_FOUND =
  "an Array subclass, which `map` preserves and JSON cannot carry";

/**
 * Whether an object or array holds data rather than behaviour.
 *
 * Everything below reads properties with `value[key]`, which runs an accessor
 * if one is there. That is cartridge-supplied code executing during
 * validation: a throwing getter escapes as a host error instead of an issue,
 * and a stateful one makes two loads of the same source differ — determinism
 * lost inside the function whose job is to establish it. So every object is
 * checked before any of its properties are read.
 *
 * Non-enumerable and symbol-keyed properties are rejected for the reason the
 * canonical serializer rejects them: they would be dropped in silence. Without
 * this the loader was the more permissive of the two, which is backwards — it
 * exists to hand the serializer something it will accept.
 *
 * Reachable only from a cartridge built in memory, never from `JSON.parse`,
 * which is the same threat model as the prototype and cycle checks nearby.
 */
function describeNonDataObject(value: object): string | undefined {
  // Prototype first, because it is the cheapest way to be wrong: a `Map` has
  // no own enumerable properties at all, so every check below passes and the
  // walk copies an empty object over it, discarding every entry in silence.
  const prototype: unknown = Object.getPrototypeOf(value);
  const expected: unknown = Array.isArray(value)
    ? Array.prototype
    : Object.prototype;
  if (prototype !== expected && prototype !== null) {
    return "an object with a prototype JSON cannot produce";
  }

  // Symbols before brands, and the order is the whole point: `detectBrand`
  // reaches `Object.prototype.toString`, which performs a Get of
  // `Symbol.toStringTag`. An own accessor there would run — inside the
  // function whose job is to classify a value without executing any of it.
  // Rejecting symbol-keyed properties first means the only `Symbol.toStringTag`
  // left to find is an inherited one, which `detectBrand` reads inertly.
  // `canonical.ts` sequences its own call the same way, for the same reason.
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return "an object with symbol-keyed properties, which JSON cannot carry";
  }

  // A prototype can be repointed. Internal slots cannot, and they are what
  // makes a `Map` a `Map` — with `Object.prototype` installed it has no own
  // keys, so every check below is vacuously satisfied and the walk writes an
  // empty object over it. This is the serializer's own brand detection, shared
  // rather than reimplemented: two answers to "is this plain data" would be
  // two chances to disagree, and the loader exists to hand the serializer
  // something it accepts.
  //
  // Arrays are exempt: `Array.isArray` already answered that question, and a
  // real array's brand *is* "Array".
  if (!Array.isArray(value)) {
    const brand = detectBrand(value);
    if (brand !== undefined) {
      const article = "AEIOU".includes(brand.slice(0, 1)) ? "an" : "a";
      return `${article} ${brand}, which JSON cannot carry`;
    }
  }

  // Property *names*, never values: `map` would read each element, so looking
  // for an indexed accessor with it would invoke the very getter being looked
  // for. An array's `length` is its one own non-enumerable property; holes and
  // stray keys are `isDenseArray`'s job.
  const keys = Object.getOwnPropertyNames(value).filter(
    (key) => !Array.isArray(value) || key !== "length",
  );

  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      return "an object with an accessor property, which would run cartridge-supplied code during validation";
    }
    if (!descriptor.enumerable) {
      return "an object with a non-enumerable property, which would be dropped silently";
    }
  }
  return undefined;
}

/** Report a non-data object, and say whether reading it is safe. */
function isDataObject(value: object, pointer: string, report: Report): boolean {
  const problem = describeNonDataObject(value);
  if (problem === undefined) return true;
  report.addPhrase(pointer, "an object of plain JSON values", problem);
  return false;
}

/**
 * Whether an array is exactly what JSON can carry: every index present, no
 * extra properties.
 *
 * Both halves are load-bearing, and each catches what the other misses.
 * Comparing the key count to `length` catches holes — `[x, , z]` has two keys
 * for a length of three. Comparing key by key catches a stray property, and
 * also the pair that defeats counting alone: one hole plus one extra property
 * is the same count as a dense array.
 *
 * A hole is not a value. `map` preserves it, the reducer would read it as
 * `undefined`, and the canonical serializer refuses it at record time — after
 * the loader has already promised the cartridge was sound.
 */
function isDenseArray(value: readonly unknown[]): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === value.length &&
    keys.every((key, index) => key === String(index))
  );
}

/**
 * An `Array` subclass survives `map` — `Symbol.species` sees to that — so it
 * would reach recorded state, where the canonical serializer refuses it. Its
 * own keys look perfectly dense on the way through.
 */
function isPlainArray(value: readonly unknown[]): boolean {
  return Object.getPrototypeOf(value) === Array.prototype;
}

/**
 * Report a value that contains itself.
 *
 * Reachable only from a cartridge built in memory rather than parsed, which is
 * exactly the path this module commits to defending — the Phase 5 pipeline may
 * well build one. Without the check the recursion below terminates in a host
 * `RangeError` instead of a validation issue with a pointer, which is the
 * difference between a report the pipeline can act on and a stack trace.
 */
function reportCycle<T>(pointer: string, report: Report, substitute: T): T {
  report.addPhrase(
    pointer,
    "a value that does not contain itself",
    "a circular reference, which JSON cannot represent",
  );
  return substitute;
}

/**
 * Deep-copy a JSON value, rejecting anything that is not one.
 *
 * Two jobs. The copy stops a caller mutating its input from changing loaded
 * state afterwards, which "loading is pure" would otherwise only half mean.
 * And the check is what keeps `deferred` honest: those subtrees are handed
 * through unread, so without it a `Date`, a sparse array, or an array carrying
 * extra properties would be laundered into something that looks like JSON and
 * is not — surfacing much later as a serializer failure while recording, with
 * a pointer into a transcript instead of into the cartridge, or not surfacing
 * at all and simply losing the data.
 */
function cloneJson(
  value: unknown,
  pointer: string,
  report: Report,
  /**
   * The containers on the path from the root to here — not every container
   * seen. A cycle is a value that contains itself, which is what overflows the
   * stack; a subobject referenced twice side by side is a DAG, which JSON
   * carries perfectly well by writing it out twice. A global visited-set would
   * confuse the second for the first and start rejecting valid cartridges.
   */
  active: Set<object> = new Set(),
  depth = 0,
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      report.add(pointer, "a finite number", value);
      return 0;
    }
    return value;
  }
  // Checked before recursing rather than after, so the issue is reported at
  // the pointer that is too deep instead of one level past it.
  if (
    depth > MAX_DEFERRED_DEPTH &&
    typeof value === "object" &&
    value !== null
  ) {
    report.addPhrase(
      pointer,
      `at most ${String(MAX_DEFERRED_DEPTH)} levels of nesting`,
      "a tree too deep to copy without exhausting the stack",
    );
    return Array.isArray(value) ? [] : {};
  }

  if (Array.isArray(value)) {
    if (!isPlainArray(value)) {
      report.addPhrase(pointer, DENSE_ARRAY_EXPECTED, ARRAY_SUBCLASS_FOUND);
      return [];
    }
    if (!isDenseArray(value)) {
      report.addPhrase(pointer, DENSE_ARRAY_EXPECTED, DENSE_ARRAY_FOUND);
      return [];
    }
    if (!isDataObject(value, pointer, report)) return [];
    if (active.has(value)) return reportCycle(pointer, report, []);
    active.add(value);
    const copied = value.map((item, index) =>
      cloneJson(item, child(pointer, index), report, active, depth + 1),
    );
    active.delete(value);
    return copied;
  }
  if (isPlainObject(value)) {
    // `isPlainObject` only rules out null and arrays, so a class instance
    // reaches here. `JSON.parse` cannot produce one, but a cartridge built in
    // memory — which the Phase 5 pipeline may well do — can, and copying its
    // enumerable own properties would silently turn it into `{}`. The guard
    // rejects it by prototype, along with accessors and hidden properties.
    if (!isDataObject(value, pointer, report)) return {};
    if (active.has(value)) return reportCycle(pointer, report, {});
    active.add(value);
    const copied = objectFromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          cloneJson(value[key], child(pointer, key), report, active, depth + 1),
        ]),
    );
    active.delete(value);
    return copied;
  }
  report.add(pointer, "a JSON value", value);
  return null;
}

/**
 * Validate `value` against `node`, returning the normalized form.
 *
 * Returns a usable substitute on failure rather than throwing, so one pass
 * finds every problem. The substitute is never handed to a caller — a report
 * with issues throws — it exists only so the walk can keep going.
 */
function validate(
  value: unknown,
  node: SchemaNode,
  pointer: string,
  report: Report,
): unknown {
  switch (node.kind) {
    case "string": {
      if (typeof value !== "string") {
        report.add(pointer, "a string", value);
        return "";
      }
      if (node.pattern !== undefined && !node.pattern.test(value)) {
        // `.source`, not `String(...)`: a `Pattern` is a wrapper object now, so
        // coercing it would report "[object Object]" as the expectation.
        report.add(pointer, node.patternLabel ?? node.pattern.source, value);
        return value;
      }
      // Code points, not UTF-16 code units. JSON Schema counts characters as
      // RFC 8259 defines them, so a string of 60 emoji satisfies the published
      // `maxLength: 60` while `value.length` calls it 120 — content that
      // validates against the contract, rejected by the loader that emitted
      // it. Only `maxLength` can actually diverge, since UTF-16 length is
      // never the smaller of the two, but the three-way agreement this schema
      // is built on has to hold in both directions.
      //
      // Counted only where a bound is declared. The bounded strings are
      // titles and summaries; the unbounded ones are file contents, man pages
      // and log lines, and counting those meant walking every character of
      // the whole world to reach two `undefined` comparisons.
      const characters =
        node.minLength !== undefined || node.maxLength !== undefined
          ? countCodePoints(value)
          : 0;
      if (node.minLength !== undefined && characters < node.minLength) {
        report.add(
          pointer,
          `at least ${String(node.minLength)} character(s)`,
          value,
        );
        return value;
      }
      if (node.maxLength !== undefined && characters > node.maxLength) {
        report.add(
          pointer,
          `at most ${String(node.maxLength)} characters`,
          value,
        );
        return value;
      }
      const refined = node.refine?.(value);
      if (refined !== undefined) report.add(pointer, refined, value);
      return value;
    }

    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        report.add(pointer, "an integer", value);
        return node.minimum;
      }
      if (value < node.minimum || value > node.maximum) {
        report.add(
          pointer,
          node.minimum === node.maximum
            ? String(node.minimum)
            : `an integer in [${String(node.minimum)}, ${String(node.maximum)}]`,
          value,
        );
        return node.minimum;
      }
      return value;
    }

    case "enum": {
      if (typeof value !== "string" || !node.values.includes(value)) {
        report.add(pointer, `one of ${node.values.join(", ")}`, value);
        return node.values[0] ?? "";
      }
      return value;
    }

    case "boolean": {
      if (typeof value !== "boolean") {
        report.add(pointer, "a boolean", value);
        return false;
      }
      return value;
    }

    case "object": {
      if (!isPlainObject(value)) {
        report.add(pointer, "an object", value);
        return {};
      }
      if (!isDataObject(value, pointer, report)) return {};
      return validateFields(value, node, pointer, report);
    }

    case "array": {
      if (!Array.isArray(value)) {
        report.add(pointer, "an array", value);
        return [];
      }
      if (node.minItems !== undefined && value.length < node.minItems) {
        report.add(pointer, `at least ${String(node.minItems)} item(s)`, value);
      }
      if (node.maxItems !== undefined && value.length > node.maxItems) {
        report.add(pointer, `at most ${String(node.maxItems)} item(s)`, value);
      }
      // Schema arrays need the same density check as a deferred one. Without
      // it `models = new Array(1)` satisfies `minItems`, `map` preserves the
      // hole, `checkModelIds` skips it without complaint, and the loader hands
      // back a cartridge the canonical serializer then refuses.
      if (!isPlainArray(value)) {
        report.addPhrase(pointer, DENSE_ARRAY_EXPECTED, ARRAY_SUBCLASS_FOUND);
        return [];
      }
      if (!isDenseArray(value)) {
        report.addPhrase(pointer, DENSE_ARRAY_EXPECTED, DENSE_ARRAY_FOUND);
        return [];
      }
      if (!isDataObject(value, pointer, report)) return [];
      return value.map((item, index) =>
        validate(item, node.items, child(pointer, index), report),
      );
    }

    case "record": {
      if (!isPlainObject(value)) {
        report.add(pointer, "an object", value);
        return {};
      }
      if (!isDataObject(value, pointer, report)) return {};
      // Sorted, so the order issues are reported in comes from the schema and
      // the data rather than from how the JSON happened to be written.
      const keys = Object.keys(value).sort();
      if (node.minEntries !== undefined && keys.length < node.minEntries) {
        report.addPhrase(
          pointer,
          `at least ${entryCount(node.minEntries)}`,
          `an object with ${entryCount(keys.length)}`,
        );
      }
      const entries: [string, unknown][] = [];
      for (const key of keys) {
        const at = child(pointer, key);
        if (!node.keyPattern.test(key)) {
          report.addPhrase(at, `a key that is ${node.keyLabel}`, describe(key));
          report.noteUnusableKey(pointer, key);
        }
        // Collected and defined rather than assigned: these keys come from the
        // cartridge, and one of them names an accessor on `Object.prototype`.
        entries.push([key, validate(value[key], node.values, at, report)]);
      }
      return objectFromEntries(entries);
    }

    case "union": {
      if (!isPlainObject(value)) {
        report.add(pointer, "an object", value);
        return {};
      }
      if (!isDataObject(value, pointer, report)) return {};
      const discriminant: unknown = value[node.discriminator];
      if (typeof discriminant !== "string") {
        report.add(
          child(pointer, node.discriminator),
          `one of ${Object.keys(node.variants).join(", ")}`,
          discriminant,
        );
        return {};
      }
      const variant = node.variants[discriminant];
      if (variant === undefined) {
        report.add(
          child(pointer, node.discriminator),
          `one of ${Object.keys(node.variants).join(", ")}`,
          discriminant,
        );
        return {};
      }
      return validateFields(value, variant, pointer, report);
    }

    case "deferred": {
      if (!isPlainObject(value)) {
        report.add(pointer, "an object", value);
        return {};
      }
      return cloneJson(value, pointer, report);
    }
  }
}

function validateFields(
  value: Record<string, unknown>,
  node: ObjectNode,
  pointer: string,
  report: Report,
): Record<string, unknown> {
  // Plain assignment is safe here and only here: these keys come from the
  // schema, not from the cartridge, so none of them can name an accessor the
  // way a `files` path or an `env` name could. The record branch above and
  // `cloneJson` both define their properties instead, for that reason.
  const out: Record<string, unknown> = {};

  // Declared order, so the report reads top-down through the document.
  for (const [key, field] of Object.entries(node.fields)) {
    const at = child(pointer, key);

    if (!Object.hasOwn(value, key)) {
      if (field.required) {
        // Reported and left absent. The walk continues to find the rest, and
        // nothing downstream reads a normalized value while the report has
        // issues — `loadCartridge` throws before any of it is returned.
        report.add(at, `${describeNode(field.node)} (required)`, undefined);
      } else if (field.fill !== undefined) {
        out[key] = cloneJson(field.fill, at, report);
      }
      continue;
    }

    out[key] = validate(value[key], field.node, at, report);
  }

  // An unknown key is nearly always a typo, and one silently ignored is a
  // field the author believes is in effect. Rejecting is only safe because
  // `meta.schemaVersion` gates the whole document: a future version adding
  // fields declares itself, rather than relying on old engines to shrug.
  const declared = new Set(Object.keys(node.fields));
  for (const key of Object.keys(value).sort()) {
    if (!declared.has(key)) {
      report.addPhrase(
        child(pointer, key),
        `no such field; this object declares ${[...declared].join(", ")}`,
        "an unexpected field",
      );
    }
  }

  return out;
}

function describeNode(node: SchemaNode): string {
  switch (node.kind) {
    case "string":
      return node.patternLabel ?? "a string";
    case "integer":
      return "an integer";
    case "enum":
      return `one of ${node.values.join(", ")}`;
    case "boolean":
      return "a boolean";
    case "object":
    case "deferred":
      return "an object";
    case "array":
      return "an array";
    case "record":
      return "an object";
    case "union":
      return "a discriminated object";
  }
}

/**
 * Check the schema version alone, before anything else looks at the document.
 *
 * Returns the issue to report, or `undefined` to proceed.
 */
function checkVersion(value: unknown): CartridgeIssue | undefined {
  if (!isPlainObject(value)) {
    return {
      pointer: "",
      expected: "an object",
      found: describe(value),
    };
  }
  // Checked before the read, not after: this runs before the walk, so without
  // it an accessor on the root object would execute before a single field had
  // been validated.
  const rootProblem = describeNonDataObject(value);
  if (rootProblem !== undefined) {
    return {
      pointer: "",
      expected: "an object of plain JSON values",
      found: rootProblem,
    };
  }
  const meta: unknown = value["meta"];
  if (!isPlainObject(meta) || !Object.hasOwn(meta, "schemaVersion")) {
    return {
      pointer: "/meta/schemaVersion",
      expected: `${String(CARTRIDGE_SCHEMA_VERSION)} (every cartridge declares its schema version)`,
      found: describe(isPlainObject(meta) ? undefined : meta),
    };
  }
  const metaProblem = describeNonDataObject(meta);
  if (metaProblem !== undefined) {
    return {
      pointer: "/meta",
      expected: "an object of plain JSON values",
      found: metaProblem,
    };
  }
  const declared: unknown = meta["schemaVersion"];
  if (declared === CARTRIDGE_SCHEMA_VERSION) return undefined;

  return {
    pointer: "/meta/schemaVersion",
    expected:
      typeof declared === "number" &&
      Number.isInteger(declared) &&
      declared > CARTRIDGE_SCHEMA_VERSION
        ? `${String(CARTRIDGE_SCHEMA_VERSION)}; this cartridge is newer than this engine understands`
        : String(CARTRIDGE_SCHEMA_VERSION),
    found: describe(declared),
  };
}

/**
 * Whether an issue was reported at exactly this pointer.
 *
 * A cross-check reads specific fields, and an issue at a field's pointer means
 * the walk substituted it — so the check would be reading a value the
 * cartridge never contained and reporting a second, derived problem for a
 * first one already in the list.
 *
 * Four rounds of review went into gating these correctly, by way of three
 * wrong answers: the whole report, then the section, then a pointer pattern.
 * Each was a proxy for the real question, and each was wrong in a different
 * direction — too coarse hides genuine problems, too narrow misses a
 * substitution and invents one. The proxy is gone: the checks below now ask
 * about the exact pointers they read, and about `unusableKeys` for the one
 * thing a pointer cannot express.
 */
function issueAt(report: Report, pointer: string): boolean {
  return report.issues.some((issue) => issue.pointer === pointer);
}

function issueWithin(report: Report, pointer: string): boolean {
  return report.issues.some(
    (issue) =>
      issue.pointer === pointer || issue.pointer.startsWith(`${pointer}/`),
  );
}

/**
 * The one cross-reference v0 makes.
 *
 * A session opening in a directory the world does not contain is broken before
 * the first command — `ls` in an empty void, `git status` on nothing — and it
 * is the mistake a generated cartridge is most likely to make, because `cwd`
 * and the file keys are written in different parts of the document. Broader
 * reference checking (git history against the working tree, callbacks against
 * their sources) is Phase 4's `cartridge validate`.
 */
function checkCwd(repository: CartridgeRepository, report: Report): void {
  const prefix = repository.cwd.endsWith("/")
    ? repository.cwd
    : `${repository.cwd}/`;
  // Against the keys that validated, not against all of them. An unreadable
  // key elsewhere in the record says nothing about whether the session opens
  // somewhere the world contains, and skipping the check for it would cost the
  // generator a round trip on a genuinely dangling cwd.
  const usable = report.usableKeys(
    "/repository/files",
    Object.keys(repository.files),
  );
  const usableDirectories = report.usableKeys(
    "/repository/directories",
    Object.keys(repository.directories),
  );

  // With nothing readable, there is no answer — only an absence of one, and
  // "contains no files" would be a second complaint about the first mistake.
  //
  // A record that declares nothing never reaches here: `minEntries` on the
  // files record reports it at `/repository/files`, which the caller's gate
  // reads. That split is deliberate. An empty map is a defect this check can
  // see but cannot name, because with no files at all *no* value of `cwd`
  // satisfies "a directory a declared file lives under" — a generator sent
  // here would edit `cwd`, resubmit, and get the same issue back.
  if (usable.length === 0) return;

  // Containment alone cannot see this. The trailing-slash prefix deliberately
  // excludes `cwd` itself, so one descendant satisfies the check while `cwd`
  // sits in the same record as a regular file with contents — a path that is
  // at once the directory the session opens in and a file `cat` would print.
  //
  // Reported instead of the containment issue rather than alongside it: when
  // both hold, one edit to either field fixes both, so the second would be a
  // derived complaint. This one is the more specific of the two.
  //
  // Only where `cwd` is involved. A file declared under another file —
  // `/a/b` and `/a/b/c`, no `cwd` in sight — is the same incoherence, but
  // catching it means building the tree the paths imply, which is issue #5's
  // filesystem model rather than a cross-check bolted onto this one.
  if (usable.includes(repository.cwd)) {
    report.addPhrase(
      "/repository/cwd",
      "a directory, not a path the cartridge also declares as a file",
      `${JSON.stringify(repository.cwd)}, which is declared as a file`,
    );
    return;
  }

  const contained =
    usableDirectories.includes(repository.cwd) ||
    usable.some((path) => path.startsWith(prefix)) ||
    usableDirectories.some((path) => path.startsWith(prefix));
  if (!contained) {
    report.addPhrase(
      "/repository/cwd",
      "a directory that at least one declared file lives under",
      `${JSON.stringify(repository.cwd)}, which contains no files`,
    );
  }
}

/** Reject path maps that cannot form one directory tree. */
function checkFilesystem(
  repository: CartridgeRepository,
  report: Report,
): void {
  const files = report.usableKeys(
    "/repository/files",
    Object.keys(repository.files),
  );
  const directories = report.usableKeys(
    "/repository/directories",
    Object.keys(repository.directories),
  );
  const directorySet = new Set(directories);

  for (const path of files) {
    if (directorySet.has(path)) {
      report.addPhrase(
        `/repository/directories/${pointerToken(path)}`,
        "a path not also declared as a regular file",
        `${JSON.stringify(path)}, which repository.files already declares`,
      );
    }
  }

  for (const path of [...files, ...directories].sort()) {
    let ancestor = path.slice(0, path.lastIndexOf("/")) || "/";
    while (ancestor !== "/") {
      if (files.includes(ancestor)) {
        report.addPhrase(
          path.startsWith("/")
            ? `/repository/${directorySet.has(path) ? "directories" : "files"}/${pointerToken(path)}`
            : "/repository/files",
          "a path whose ancestors are directories",
          `${JSON.stringify(path)}, below regular file ${JSON.stringify(ancestor)}`,
        );
        break;
      }
      ancestor = ancestor.slice(0, ancestor.lastIndexOf("/")) || "/";
    }
  }
}

/** Logical text lines: a terminal newline ends the last line, not an empty one. */
function gitLines(contents: string): readonly string[] {
  if (contents === "") return [];
  const lines = contents.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * Map each child line to the parent line it inherits under the same stable LCS
 * tie-break used by the Git diff model. A deletion wins a tie, so duplicate
 * lines cannot make provenance depend on an arbitrary text-only search.
 */
function inheritedGitLines(
  parent: readonly string[],
  child: readonly string[],
): ReadonlyMap<number, number> {
  const lengths = Array.from({ length: parent.length + 1 }, () =>
    Array.from({ length: child.length + 1 }, () => 0),
  );
  for (let left = parent.length - 1; left >= 0; left -= 1) {
    for (let right = child.length - 1; right >= 0; right -= 1) {
      lengths[left]![right] =
        parent[left] === child[right]
          ? 1 + (lengths[left + 1]?.[right + 1] ?? 0)
          : Math.max(
              lengths[left + 1]?.[right] ?? 0,
              lengths[left]?.[right + 1] ?? 0,
            );
    }
  }
  const inherited = new Map<number, number>();
  let left = 0;
  let right = 0;
  while (left < parent.length && right < child.length) {
    if (parent[left] === child[right]) {
      inherited.set(right, left);
      left += 1;
      right += 1;
    } else if (
      (lengths[left + 1]?.[right] ?? 0) >= (lengths[left]?.[right + 1] ?? 0)
    ) {
      left += 1;
    } else {
      right += 1;
    }
  }
  return inherited;
}

function gitCommitPointer(index: number): string {
  return `/repository/gitHistory/commits/${String(index)}`;
}

/** The concrete Git cartridge is a graph, so its useful checks live here. */
function checkGitHistory(
  history: CartridgeGitHistory,
  repository: CartridgeRepository,
  report: Report,
): void {
  const byId = new Map<string, { commit: CartridgeGitCommit; index: number }>();
  history.commits.forEach((commit, index) => {
    const first = byId.get(commit.id);
    if (first === undefined) byId.set(commit.id, { commit, index });
    else
      report.addPhrase(
        `${gitCommitPointer(index)}/id`,
        "an id no other commit uses",
        `${JSON.stringify(commit.id)}, already used by ${gitCommitPointer(first.index)}`,
      );
  });

  history.commits.forEach((commit, index) => {
    commit.parents.forEach((parent, parentIndex) => {
      if (!byId.has(parent))
        report.addPhrase(
          `${gitCommitPointer(index)}/parents/${String(parentIndex)}`,
          "an id of a commit in this history",
          `${JSON.stringify(parent)}, which does not exist`,
        );
    });
    for (const path of Object.keys(commit.files).sort()) {
      const repositoryPrefix =
        repository.cwd === "/" ? "/" : `${repository.cwd}/`;
      if (path !== repository.cwd && !path.startsWith(repositoryPrefix))
        report.addPhrase(
          `${gitCommitPointer(index)}/files/${pointerToken(path)}`,
          "a file beneath repository.cwd",
          `${JSON.stringify(path)}, which is outside ${JSON.stringify(repository.cwd)}`,
        );
      else if (!Object.hasOwn(repository.files, path))
        report.addPhrase(
          `${gitCommitPointer(index)}/files/${pointerToken(path)}`,
          "a file declared by repository.files",
          `${JSON.stringify(path)}, which the VFS world does not declare`,
        );
    }
  });

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    const entry = byId.get(id);
    if (entry === undefined) return;
    if (visiting.has(id)) {
      report.addPhrase(
        `${gitCommitPointer(entry.index)}/parents`,
        "an acyclic commit ancestry",
        `a cycle returning to ${JSON.stringify(id)}`,
      );
      return;
    }
    visiting.add(id);
    for (const parent of entry.commit.parents) visit(parent);
    visiting.delete(id);
    visited.add(id);
  };
  for (const commit of history.commits) visit(commit.id);

  for (const [branch, tip] of Object.entries(history.branches).sort()) {
    if (!byId.has(tip))
      report.addPhrase(
        `/repository/gitHistory/branches/${pointerToken(branch)}`,
        "an id of a commit in this history",
        `${JSON.stringify(tip)}, which does not exist`,
      );
  }

  if (history.commits.length === 0) {
    if (
      Object.keys(history.branches).length !== 0 ||
      history.head.kind !== "detached" ||
      history.head.target !== ""
    )
      report.addPhrase(
        "/repository/gitHistory/head",
        "detached HEAD with an empty target when history has no commits or refs",
        "a ref in an empty history",
      );
    return;
  }

  if (history.head.kind === "branch") {
    if (!Object.hasOwn(history.branches, history.head.target))
      report.addPhrase(
        "/repository/gitHistory/head/target",
        "the name of a declared branch",
        `${JSON.stringify(history.head.target)}, which is not a branch`,
      );
  } else if (!byId.has(history.head.target)) {
    report.addPhrase(
      "/repository/gitHistory/head/target",
      "an id of a commit in this history",
      `${JSON.stringify(history.head.target)}, which does not exist`,
    );
  }

  history.commits.forEach((commit, commitIndex) => {
    for (const [path, file] of Object.entries(commit.files).sort()) {
      const lines = gitLines(file.contents);
      const filePointer = `${gitCommitPointer(commitIndex)}/files/${pointerToken(path)}`;
      if (file.blame.length !== lines.length) {
        report.addPhrase(
          `${filePointer}/blame`,
          `one commit id per logical line (${String(lines.length)})`,
          `${String(file.blame.length)} entries`,
        );
        continue;
      }
      const firstParent = commit.parents[0];
      const parentFile =
        firstParent === undefined
          ? undefined
          : byId.get(firstParent)?.commit.files[path];
      const inherited = inheritedGitLines(
        gitLines(parentFile?.contents ?? ""),
        lines,
      );
      file.blame.forEach((sourceId, lineIndex) => {
        const source = byId.get(sourceId)?.commit;
        const pointer = `${filePointer}/blame/${String(lineIndex)}`;
        if (source === undefined) {
          report.addPhrase(
            pointer,
            "an id of a commit in this history",
            `${JSON.stringify(sourceId)}, which does not exist`,
          );
          return;
        }
        const parentLine = inherited.get(lineIndex);
        const expectedSource =
          parentLine === undefined ? commit.id : parentFile?.blame[parentLine];
        if (sourceId !== expectedSource)
          report.addPhrase(
            pointer,
            "the first-parent commit provenance for this line",
            `${JSON.stringify(sourceId)}, expected ${JSON.stringify(expectedSource)}`,
          );
      });
    }
  });
}

/** Model ids seed the PRNG, so two models sharing one is two models sharing a session. */
function checkModelIds(
  models: readonly CartridgeModel[],
  report: Report,
): void {
  const seen = new Map<string, number>();
  models.forEach((model, index) => {
    // Per model, not per array. An invalid *item* substitutes the id inside
    // it, so two of those would collide on `undefined` and invent a duplicate
    // — but a bad item says nothing about its siblings, and disabling the
    // whole check for one costs the generator a round trip on a real
    // duplicate elsewhere.
    if (
      issueAt(report, `/models/${String(index)}`) ||
      issueAt(report, `/models/${String(index)}/id`)
    ) {
      return;
    }

    const first = seen.get(model.id);
    if (first === undefined) {
      seen.set(model.id, index);
      return;
    }
    report.addPhrase(
      `/models/${String(index)}/id`,
      "an id no other model uses; ids seed the PRNG",
      `${JSON.stringify(model.id)}, already used by /models/${String(first)}`,
    );
  });
}

/** Phase 1 content references and identities that descriptor nodes cannot express. */
function checkStoryAndPresentation(
  story: CartridgeStory,
  presentation: CartridgePresentation,
  models: readonly CartridgeModel[],
  repository: CartridgeRepository,
  report: Report,
): void {
  const beliefSubject = (belief: CartridgeBelief): string => {
    if (belief.kind === "git-head") return belief.kind;
    if (belief.kind === "file-exists" || belief.kind === "file-contents")
      return `${belief.kind}\u0000${belief.path}`;
    return `${belief.kind}\u0000${belief.service}`;
  };
  const checkBeliefs = (
    beliefs: readonly CartridgeBelief[],
    pointer: string,
  ): void => {
    const subjects = new Map<string, number>();
    beliefs.forEach((belief, index) => {
      const subject = beliefSubject(belief);
      const first = subjects.get(subject);
      if (first === undefined) subjects.set(subject, index);
      else
        report.addPhrase(
          `${pointer}/${String(index)}`,
          "a typed subject no other belief in this list uses",
          `a duplicate of ${pointer}/${String(first)}`,
        );
    });
  };

  checkBeliefs(story.opening.beliefs, "/story/opening/beliefs");
  checkBeliefs(story.compact.beliefs, "/story/compact/beliefs");

  const responses = new Map<string, number>();
  story.responses.forEach((response, index) => {
    const first = responses.get(response.id);
    if (first === undefined) responses.set(response.id, index);
    else
      report.addPhrase(
        `/story/responses/${String(index)}/id`,
        "an id no other authored response uses",
        `${JSON.stringify(response.id)}, already used by /story/responses/${String(first)}`,
      );

    for (const [field, artifacts] of [
      ["toolCalls", response.toolCalls],
      ["thinkingBlocks", response.thinkingBlocks],
      ["todos", response.todos],
    ] as const) {
      const local = new Map<string, number>();
      artifacts.forEach((artifact, artifactIndex) => {
        const prior = local.get(artifact.id);
        if (prior === undefined) local.set(artifact.id, artifactIndex);
        else
          report.addPhrase(
            `/story/responses/${String(index)}/${field}/${String(artifactIndex)}/id`,
            `an id no other ${field} artifact in this response uses`,
            `${JSON.stringify(artifact.id)}, already used at index ${String(prior)}`,
          );
      });
    }
  });

  const reference = (id: string, pointer: string): void => {
    if (!responses.has(id))
      report.addPhrase(
        pointer,
        "the id of a declared authored response",
        `${JSON.stringify(id)}, which does not exist`,
      );
  };
  reference(story.opening.response, "/story/opening/response");
  reference(story.fallback.response, "/story/fallback/response");
  if (story.fallback.authorizedResponse !== "")
    reference(
      story.fallback.authorizedResponse,
      "/story/fallback/authorizedResponse",
    );
  reference(story.helpResponse, "/story/helpResponse");
  if (story.idleNudgeResponse !== "")
    reference(story.idleNudgeResponse, "/story/idleNudgeResponse");
  reference(story.compact.response, "/story/compact/response");
  reference(story.resume.unchangedResponse, "/story/resume/unchangedResponse");
  reference(story.resume.changedResponse, "/story/resume/changedResponse");

  const checkPermissionRequests = (
    actions: readonly CartridgeAgentAction[],
    pointer: string,
  ): void => {
    const permissionRequests = actions.filter(
      (action) => action.kind === "permission-request",
    );
    if (permissionRequests.length > 1)
      report.addPhrase(
        pointer,
        "at most one permission-request action",
        `${String(permissionRequests.length)} permission-request actions`,
      );
  };

  const beats = new Map<string, number>();
  story.phase2.beats.forEach((beat, index) => {
    const first = beats.get(beat.id);
    if (first === undefined) beats.set(beat.id, index);
    else
      report.addPhrase(
        `/story/phase2/beats/${String(index)}/id`,
        "an id no other story beat uses",
        `${JSON.stringify(beat.id)}, already used by /story/phase2/beats/${String(first)}`,
      );
  });
  const endings = new Map<string, number>();
  story.phase2.endings.forEach((ending, index) => {
    const first = endings.get(ending.id);
    if (first === undefined) endings.set(ending.id, index);
    else
      report.addPhrase(
        `/story/phase2/endings/${String(index)}/id`,
        "an id no other ending uses",
        `${JSON.stringify(ending.id)}, already used by /story/phase2/endings/${String(first)}`,
      );
  });
  const facts = new Map<
    string,
    { readonly index: number; readonly kind: string }
  >();
  // When an unrelated structural error prevents global default filling, older
  // otherwise-valid phase2 graphs may still omit these optional additions.
  // Cross-checks must report the authored error, never escape on that shape.
  (story.phase2.facts ?? []).forEach((fact, index) => {
    const first = facts.get(fact.id);
    if (first === undefined) facts.set(fact.id, { index, kind: fact.kind });
    else
      report.addPhrase(
        `/story/phase2/facts/${String(index)}/id`,
        "an id no other story fact uses",
        `${JSON.stringify(fact.id)}, already used by /story/phase2/facts/${String(first.index)}`,
      );
  });
  if (!beats.has(story.phase2.initialBeat))
    report.addPhrase(
      "/story/phase2/initialBeat",
      "the id of a declared story beat",
      `${JSON.stringify(story.phase2.initialBeat)}, which does not exist`,
    );
  const services = new Set(repository.services.map((service) => service.id));
  story.phase2.beats.forEach((beat, index) => {
    const root = `/story/phase2/beats/${String(index)}`;
    const checkEnding = (ending: string, pointer: string): void => {
      if (ending !== "" && !endings.has(ending))
        report.addPhrase(
          pointer,
          "an empty string or the id of a declared ending",
          `${JSON.stringify(ending)}, which does not exist`,
        );
    };
    const checkFacts = (values: readonly string[], pointer: string): void => {
      const seen = new Map<string, number>();
      values.forEach((fact, factIndex) => {
        if (!facts.has(fact))
          report.addPhrase(
            `${pointer}/${String(factIndex)}`,
            "the id of a declared story fact",
            `${JSON.stringify(fact)}, which does not exist`,
          );
        const first = seen.get(fact);
        if (first === undefined) seen.set(fact, factIndex);
        else
          report.addPhrase(
            `${pointer}/${String(factIndex)}`,
            "a fact this outcome does not already record",
            `${JSON.stringify(fact)}, already used at index ${String(first)}`,
          );
      });
    };
    checkEnding(beat.ending, `${root}/ending`);
    checkFacts(beat.facts ?? [], `${root}/facts`);
    const variants = new Map<string, number>();
    (beat.variants ?? []).forEach((variant, variantIndex) => {
      const variantRoot = `${root}/variants/${String(variantIndex)}`;
      const first = variants.get(variant.id);
      if (first === undefined) variants.set(variant.id, variantIndex);
      else
        report.addPhrase(
          `${variantRoot}/id`,
          "an id no other variant on this beat uses",
          `${JSON.stringify(variant.id)}, already used by ${root}/variants/${String(first)}`,
        );
      checkEnding(variant.ending, `${variantRoot}/ending`);
      checkFacts(variant.facts ?? [], `${variantRoot}/facts`);
      variant.when.forEach((condition, conditionIndex) => {
        const conditionRoot = `${variantRoot}/when/${String(conditionIndex)}`;
        if (condition.kind === "story-fact") {
          const declared = facts.get(condition.fact);
          if (declared === undefined)
            report.addPhrase(
              `${conditionRoot}/fact`,
              "the id of a declared story fact",
              `${JSON.stringify(condition.fact)}, which does not exist`,
            );
          else if (declared.kind !== condition.factKind)
            report.addPhrase(
              `${conditionRoot}/factKind`,
              `the declared kind ${declared.kind}`,
              JSON.stringify(condition.factKind),
            );
        }
        const service =
          condition.kind === "service-state" ||
          condition.kind === "service-health"
            ? condition.service
            : condition.kind === "belief" &&
                (condition.belief.kind === "service-state" ||
                  condition.belief.kind === "service-health")
              ? condition.belief.service
              : undefined;
        if (service !== undefined && !services.has(service))
          report.addPhrase(
            condition.kind === "belief"
              ? `${conditionRoot}/belief/service`
              : `${conditionRoot}/service`,
            "the id of a declared service",
            `${JSON.stringify(service)}, which does not exist`,
          );
      });
    });
  });
  const checkStoryActions = (
    actions: readonly CartridgeAgentAction[],
    pointer: string,
  ): void => {
    actions.forEach((action, index) => {
      if (action.kind === "story-reach" && !beats.has(action.beat))
        report.addPhrase(
          `${pointer}/${String(index)}/beat`,
          "the id of a declared story beat",
          `${JSON.stringify(action.beat)}, which does not exist`,
        );
    });
  };
  checkPermissionRequests(story.fallback.actions, "/story/fallback/actions");
  checkStoryActions(story.fallback.actions, "/story/fallback/actions");

  const intents = new Map<string, number>();
  const patterns = new Map<string, string>();
  story.intents.forEach((intent, index) => {
    const first = intents.get(intent.id);
    if (first === undefined) intents.set(intent.id, index);
    else
      report.addPhrase(
        `/story/intents/${String(index)}/id`,
        "an id no other intent uses",
        `${JSON.stringify(intent.id)}, already used by /story/intents/${String(first)}`,
      );
    reference(intent.response, `/story/intents/${String(index)}/response`);
    if (intent.authorizedResponse !== "")
      reference(
        intent.authorizedResponse,
        `/story/intents/${String(index)}/authorizedResponse`,
      );
    intent.patterns.forEach((value, patternIndex) => {
      const normalized = normalizeIntentPhrase(value);
      const first = patterns.get(normalized);
      const pointer = `/story/intents/${String(index)}/patterns/${String(patternIndex)}`;
      if (first === undefined) patterns.set(normalized, pointer);
      else
        report.addPhrase(
          pointer,
          "a pattern no other intent uses",
          `${JSON.stringify(value)}, already used by ${first}`,
        );
    });
    checkPermissionRequests(
      intent.actions,
      `/story/intents/${String(index)}/actions`,
    );
    checkStoryActions(
      intent.actions,
      `/story/intents/${String(index)}/actions`,
    );
  });

  const pools = new Map<string, number>();
  presentation.spinnerPools.forEach((pool, index) => {
    const key = `${pool.archetype}:${String(pool.stage)}`;
    const first = pools.get(key);
    if (first === undefined) pools.set(key, index);
    else
      report.addPhrase(
        `/presentation/spinnerPools/${String(index)}/stage`,
        "an archetype and stage pair no other spinner pool uses",
        `${JSON.stringify(key)}, already used by /presentation/spinnerPools/${String(first)}`,
      );
  });
  const requiredArchetypes = new Set(models.map((model) => model.archetype));
  for (const archetype of [...requiredArchetypes].sort()) {
    if (!pools.has(`${archetype}:0`))
      report.addPhrase(
        "/presentation/spinnerPools",
        `a stage-0 spinner pool for model archetype ${archetype}`,
        "no matching pool",
      );
  }
}

/** Cross-references and uniqueness that descriptor nodes cannot express. */
function checkWorld(repository: CartridgeRepository, report: Report): void {
  // Static output cannot stand in for commands whose replayable effects are
  // runtime mechanics. Reserve the whole command because authored records do
  // not dispatch by argument shape.
  if (Object.hasOwn(repository.commands, "loadbearing"))
    report.addPhrase(
      "/repository/commands/loadbearing",
      "a cartridge command name that is not reserved for runtime mechanics",
      '"loadbearing"',
    );

  const uniqueIds = <T extends { readonly id: string }>(
    values: readonly T[],
    field: "processes" | "services" | "logs" | "tickets",
  ): Map<string, number> => {
    const seen = new Map<string, number>();
    values.forEach((value, index) => {
      const first = seen.get(value.id);
      if (first === undefined) seen.set(value.id, index);
      else
        report.addPhrase(
          `/repository/${field}/${String(index)}/id`,
          `an id no other ${field.slice(0, -1)} uses`,
          `${JSON.stringify(value.id)}, already used by /repository/${field}/${String(first)}`,
        );
    });
    return seen;
  };

  uniqueIds(repository.processes, "processes");
  const services = uniqueIds(repository.services, "services");
  uniqueIds(repository.logs, "logs");
  uniqueIds(repository.tickets, "tickets");

  const pids = new Map<number, number>();
  let automaticPids = 0;
  repository.processes.forEach((entry, index) => {
    if (entry.pid === 0) automaticPids += 1;
    else {
      const first = pids.get(entry.pid);
      if (first === undefined) pids.set(entry.pid, index);
      else
        report.addPhrase(
          `/repository/processes/${String(index)}/pid`,
          "a nonzero PID no other process declares",
          `${String(entry.pid)}, already used by /repository/processes/${String(first)}`,
        );
    }
    if (!Object.hasOwn(repository.files, entry.command.binary))
      report.addPhrase(
        `/repository/processes/${String(index)}/command/binary`,
        "an absolute path declared by repository.files",
        `${JSON.stringify(entry.command.binary)}, which does not exist`,
      );
  });
  const reservedAssignablePids = [...pids.keys()].filter(
    (pid) => pid >= 1000,
  ).length;
  if (automaticPids > 31768 - reservedAssignablePids)
    report.addPhrase(
      "/repository/processes",
      "enough free PIDs in [1000, 32767] for every zero PID",
      `${String(automaticPids)} automatic PIDs and ${String(reservedAssignablePids)} reserved values in the assignment range`,
    );

  const ports = new Map<number, string>();
  let automaticPorts = 0;
  repository.services.forEach((service, serviceIndex) => {
    service.ports.forEach((port, portIndex) => {
      if (port === 0) automaticPorts += 1;
      else {
        const first = ports.get(port);
        if (first === undefined)
          ports.set(
            port,
            `/repository/services/${String(serviceIndex)}/ports/${String(portIndex)}`,
          );
        else
          report.addPhrase(
            `/repository/services/${String(serviceIndex)}/ports/${String(portIndex)}`,
            "a nonzero port no service declares elsewhere",
            `${String(port)}, already used by ${first}`,
          );
      }
    });
    service.dependencies.forEach((id, dependencyIndex) => {
      if (!services.has(id))
        report.addPhrase(
          `/repository/services/${String(serviceIndex)}/dependencies/${String(dependencyIndex)}`,
          "the id of a declared service",
          `${JSON.stringify(id)}, which does not exist`,
        );
    });
  });
  const reservedAssignablePorts = [...ports.keys()].filter(
    (port) => port >= 1024,
  ).length;
  if (automaticPorts > 64512 - reservedAssignablePorts)
    report.addPhrase(
      "/repository/services",
      "enough free ports in [1024, 65535] for every zero port",
      `${String(automaticPorts)} automatic ports and ${String(reservedAssignablePorts)} reserved values`,
    );

  repository.logs.forEach((log, index) => {
    const pointer = `/repository/logs/${String(index)}`;
    if (log.kind === "file") {
      if (
        !FILE_PATH_PATTERN.test(log.path) ||
        !Object.hasOwn(repository.files, log.path)
      )
        report.addPhrase(
          `${pointer}/path`,
          "a canonical absolute path declared by repository.files",
          `${JSON.stringify(log.path)}, which does not name a repository file`,
        );
      if (log.entries.length !== 0)
        report.addPhrase(
          `${pointer}/entries`,
          "an empty array; file log contents live only in VFS",
          `${String(log.entries.length)} seeded entries`,
        );
    } else if (log.path !== "")
      report.addPhrase(
        `${pointer}/path`,
        "an empty string for a stream log",
        JSON.stringify(log.path),
      );
  });

  const pages = new Map<string, number>();
  repository.manPages.forEach((page, index) => {
    const key = `${page.name}\u0000${page.section}`;
    const first = pages.get(key);
    if (first === undefined) pages.set(key, index);
    else
      report.addPhrase(
        `/repository/manPages/${String(index)}/section`,
        "a name and section pair no other man page uses",
        `${JSON.stringify(`${page.name}(${page.section})`)}, already used by /repository/manPages/${String(first)}`,
      );
  });

  repository.tickets.forEach((ticket, index) => {
    if (ticket.service !== "" && !services.has(ticket.service))
      report.addPhrase(
        `/repository/tickets/${String(index)}/service`,
        "an empty string or the id of a declared service",
        `${JSON.stringify(ticket.service)}, which does not exist`,
      );
  });
}

/**
 * Check each readable endpoint independently so one malformed endpoint does
 * not hide a dangling service link in another. The service collection itself
 * must be sound before its ids are a meaningful reference target.
 */
function checkEndpointServiceReferences(
  repository: CartridgeRepository,
  report: Report,
): void {
  const services = new Set(repository.services.map((service) => service.id));
  for (const [url, endpoint] of Object.entries(repository.endpoints)) {
    const pointer = `/repository/endpoints/${pointerToken(url)}`;
    if (issueWithin(report, pointer)) continue;
    if (!services.has(endpoint.service))
      report.addPhrase(
        `${pointer}/service`,
        "the id of a declared service",
        `${JSON.stringify(endpoint.service)}, which does not exist`,
      );
  }
}

function reactionActionType(action: ReactionAction): string {
  switch (action.kind) {
    case "service-state":
      return action.state === "running"
        ? "world.service-start"
        : "world.service-stop";
    case "service-health":
      return "world.service-health";
    case "process-state":
      return "world.process-transition";
    case "log-append":
      return "world.log-append";
  }
}

/** Concrete test/reaction references and the conservative event-type graph. */
function checkTestsAndReactions(
  repository: CartridgeRepository,
  report: Report,
): void {
  const files = new Set(Object.keys(repository.files));
  const services = new Set(repository.services.map((value) => value.id));
  const processes = new Set(repository.processes.map((value) => value.id));
  const logs = new Set(repository.logs.map((value) => value.id));

  const unique = <T extends { readonly id: string }>(
    values: readonly T[],
    field: "tests" | "reactions",
  ): void => {
    const seen = new Map<string, number>();
    values.forEach((value, index) => {
      const first = seen.get(value.id);
      if (first === undefined) seen.set(value.id, index);
      else
        report.addPhrase(
          `/repository/${field}/${String(index)}/id`,
          `an id no other ${field.slice(0, -1)} uses`,
          `${JSON.stringify(value.id)}, already used by /repository/${field}/${String(first)}`,
        );
    });
  };
  unique(repository.tests, "tests");
  unique(repository.reactions, "reactions");

  repository.tests.forEach((test, index) => {
    if (!files.has(test.predicate.path))
      report.addPhrase(
        `/repository/tests/${String(index)}/predicate/path`,
        "a path declared by repository.files",
        `${JSON.stringify(test.predicate.path)}, which does not exist`,
      );
  });

  const checkReference = (
    id: string,
    ids: ReadonlySet<string>,
    pointer: string,
    noun: string,
  ): void => {
    if (!ids.has(id))
      report.addPhrase(
        pointer,
        `the id of a declared ${noun}`,
        `${JSON.stringify(id)}, which does not exist`,
      );
  };
  repository.reactions.forEach((reaction, reactionIndex) => {
    const root = `/repository/reactions/${String(reactionIndex)}`;
    reaction.predicates.forEach((predicate, predicateIndex) => {
      const pointer = `${root}/predicates/${String(predicateIndex)}`;
      switch (predicate.kind) {
        case "file-exists":
        case "file-contents":
          checkReference(predicate.path, files, `${pointer}/path`, "file");
          break;
        case "service-state":
        case "service-health":
          checkReference(
            predicate.service,
            services,
            `${pointer}/service`,
            "service",
          );
          break;
        case "process-state":
          checkReference(
            predicate["process"],
            processes,
            `${pointer}/process`,
            "process",
          );
          break;
      }
    });
    reaction.actions.forEach((action, actionIndex) => {
      const pointer = `${root}/actions/${String(actionIndex)}`;
      switch (action.kind) {
        case "service-state":
        case "service-health":
          checkReference(
            action.service,
            services,
            `${pointer}/service`,
            "service",
          );
          break;
        case "process-state":
          checkReference(
            action["process"],
            processes,
            `${pointer}/process`,
            "process",
          );
          break;
        case "log-append":
          checkReference(action.log, logs, `${pointer}/log`, "log");
          break;
      }
    });
  });

  interface Edge {
    readonly to: string;
    readonly reaction: CartridgeReaction;
    readonly reactionIndex: number;
    readonly actionIndex: number;
  }
  const edges = new Map<string, Edge[]>();
  repository.reactions.forEach((reaction, reactionIndex) => {
    const list = edges.get(reaction.on) ?? [];
    reaction.actions.forEach((action, actionIndex) => {
      list.push({
        to: reactionActionType(action),
        reaction,
        reactionIndex,
        actionIndex,
      });
    });
    edges.set(reaction.on, list);
  });
  const active = new Set<string>();
  const complete = new Set<string>();
  const reported = new Set<string>();
  const visit = (type: string): void => {
    if (complete.has(type)) return;
    active.add(type);
    for (const edge of edges.get(type) ?? []) {
      if (active.has(edge.to)) {
        const pointer = `/repository/reactions/${String(edge.reactionIndex)}/actions/${String(edge.actionIndex)}/kind`;
        if (!reported.has(pointer)) {
          reported.add(pointer);
          report.addPhrase(
            pointer,
            "an action whose event-type cascade is acyclic",
            `${JSON.stringify(edge.reaction.on)} -> ${JSON.stringify(edge.to)} closes a reaction cycle`,
          );
        }
      } else visit(edge.to);
    }
    active.delete(type);
    complete.add(type);
  };
  for (const type of [...edges.keys()].sort()) visit(type);
}

/**
 * Validate and normalize a parsed cartridge.
 *
 * @throws CartridgeValidationError with every issue found, never just the first.
 */
export function loadCartridge(value: unknown): LoadedCartridge {
  const version = checkVersion(value);
  if (version !== undefined) throw new CartridgeValidationError([version]);

  const report = new Report();
  const normalized = validate(value, CARTRIDGE_SCHEMA, "", report) as Record<
    string,
    unknown
  >;

  // Nothing below reads a normalized value while the report has issues, so the
  // shapes the casts assert are the shapes a clean walk guarantees.
  if (report.issues.length === 0) {
    fillDerivedDefaults(normalized);
  }

  // Annotated so the compiler ties this to `./types.ts`: a field the schema
  // declares and this does not build fails to compile, and one built here
  // without a declaration fails the excess-property check.
  const cartridge: LoadedCartridge = {
    meta: normalized["meta"] as CartridgeMeta,
    repository: normalized["repository"] as CartridgeRepository,
    models: normalized["models"] as readonly CartridgeModel[],
    story: normalized["story"] as CartridgeStory,
    presentation: normalized["presentation"] as CartridgePresentation,
  };

  // Each cross-field check is gated on the fields it actually reads. Anything
  // wider is safe but costs the generator a round trip: gated on the whole
  // report, one bad `meta` field hid a duplicate model id; gated on `/models`,
  // an invalid *description* hid one.
  //
  // These are appended after the structural issues rather than interleaved at
  // their document position. Deterministic, which is what matters, but not
  // strictly document-ordered; the header above says so.
  // `checkCwd` reads `cwd` and the file *keys*, and works around the
  // individual keys it cannot read — so the gate only has to cover the two
  // values it reads wholesale.
  if (
    !issueAt(report, "/repository") &&
    !issueAt(report, "/repository/cwd") &&
    !issueAt(report, "/repository/files")
  ) {
    checkCwd(cartridge.repository, report);
  }
  if (
    !issueAt(report, "/repository") &&
    !issueAt(report, "/repository/files") &&
    !issueAt(report, "/repository/directories")
  ) {
    checkFilesystem(cartridge.repository, report);
  }
  if (
    !issueAt(report, "/repository") &&
    !issueAt(report, "/repository/cwd") &&
    !issueWithin(report, "/repository/gitHistory") &&
    !issueAt(report, "/repository/files")
  ) {
    checkGitHistory(
      cartridge.repository.gitHistory,
      cartridge.repository,
      report,
    );
  }
  // `checkModelIds` gates per model, so it only needs the array to exist.
  if (!issueAt(report, "/models")) {
    checkModelIds(cartridge.models, report);
  }
  if (
    !issueWithin(report, "/story") &&
    !issueWithin(report, "/presentation") &&
    !issueWithin(report, "/models") &&
    !issueAt(report, "/repository") &&
    !issueWithin(report, "/repository/services")
  ) {
    checkStoryAndPresentation(
      cartridge.story,
      cartridge.presentation,
      cartridge.models,
      cartridge.repository,
      report,
    );
  }
  if (
    !issueAt(report, "/repository") &&
    !issueAt(report, "/meta/startedAt") &&
    !issueAt(report, "/repository/system") &&
    !issueAt(report, "/repository/system/bootedAt") &&
    parseTimestamp(cartridge.repository.system.bootedAt) >
      parseTimestamp(cartridge.meta.startedAt)
  ) {
    report.addPhrase(
      "/repository/system/bootedAt",
      "a UTC instant at or before meta.startedAt",
      `${JSON.stringify(cartridge.repository.system.bootedAt)}, which is later than ${JSON.stringify(cartridge.meta.startedAt)}`,
    );
  }
  if (
    !issueAt(report, "/repository") &&
    !issueAt(report, "/repository/files") &&
    !issueWithin(report, "/repository/processes") &&
    !issueWithin(report, "/repository/services") &&
    !issueWithin(report, "/repository/logs") &&
    !issueWithin(report, "/repository/manPages") &&
    !issueWithin(report, "/repository/tickets")
  ) {
    checkWorld(cartridge.repository, report);
  }
  if (
    !issueAt(report, "/repository") &&
    !issueAt(report, "/repository/endpoints") &&
    !issueWithin(report, "/repository/services")
  ) {
    checkEndpointServiceReferences(cartridge.repository, report);
  }
  if (
    !issueAt(report, "/repository") &&
    !issueAt(report, "/repository/files") &&
    !issueWithin(report, "/repository/tests") &&
    !issueWithin(report, "/repository/reactions") &&
    !issueWithin(report, "/repository/services") &&
    !issueWithin(report, "/repository/processes") &&
    !issueWithin(report, "/repository/logs")
  ) {
    checkTestsAndReactions(cartridge.repository, report);
  }

  if (report.issues.length > 0)
    throw new CartridgeValidationError(report.issues);

  // Frozen all the way down before it leaves. A loaded cartridge is the one
  // value every event handler holds at once — `EventContext.cartridge` hands
  // the same object to all of them, and it also sits inside every session
  // state and every recorded fixture. Nobody owns it, so nobody may write to
  // it: without this, `context.cartridge.meta.title = "…"` from one handler
  // would rewrite the world for every later event, for the caller that loaded
  // it, and for any other session sharing the load.
  //
  // Once per load rather than once per event, which is why the cost argument
  // that keeps `engine/events/reduce.ts` from deep-freezing a *slice* does not
  // apply here. Freezing happens last so `fillDerivedDefaults` above still has
  // a writable tree to fill.
  return deepFreeze(cartridge);
}

/**
 * Fill the defaults that read another field rather than a constant.
 *
 * File and directory mtimes fall back to the session start. Directory owners
 * and groups inherit from the nearest explicitly declared ancestor. These
 * cannot be a schema `fill`, which is copied without seeing the rest of the
 * document, and JSON Schema cannot express it either — the published schema
 * states the rule in prose beside the field.
 *
 * Operates on the walk's own output, which is freshly built and shared with
 * nothing, so mutating it here cannot reach the caller's input.
 */
function fillDerivedDefaults(normalized: Record<string, unknown>): void {
  const meta = normalized["meta"] as CartridgeMeta;
  const repository = normalized["repository"] as {
    files: Record<string, Record<string, unknown>>;
    directories: Record<string, Record<string, unknown>>;
  };

  for (const file of Object.values(repository.files)) {
    file["mtime"] ??= meta.startedAt;
  }

  const paths = Object.keys(repository.directories).sort(
    (left, right) => left.split("/").length - right.split("/").length,
  );
  for (const path of paths) {
    const directory = repository.directories[path] as Record<string, unknown>;
    let ancestor = path.slice(0, path.lastIndexOf("/")) || "/";
    let inherited: CartridgeDirectory | undefined;
    while (true) {
      const candidate = repository.directories[ancestor];
      if (candidate !== undefined) {
        inherited = candidate as unknown as CartridgeDirectory;
        break;
      }
      if (ancestor === "/") break;
      ancestor = ancestor.slice(0, ancestor.lastIndexOf("/")) || "/";
    }
    directory["owner"] ??= inherited?.owner ?? "root";
    directory["group"] ??= inherited?.group ?? "root";
    directory["mtime"] ??= meta.startedAt;
  }
}
