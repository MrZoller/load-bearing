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

import { detectBrand } from "../serialize/canonical.js";
import { CARTRIDGE_SCHEMA, CARTRIDGE_SCHEMA_VERSION } from "./schema.js";
import type { SchemaNode, ObjectNode } from "./schema.js";
import type {
  CartridgeMeta,
  CartridgeModel,
  CartridgeRepository,
  DeferredObject,
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
    case "boolean":
      return JSON.stringify(value);
    case "object":
      return "an object";
    default:
      return typeof value;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collects issues so one pass can report all of them. */
class Report {
  readonly issues: CartridgeIssue[] = [];

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
      return `a ${brand}, which JSON cannot carry`;
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
      cloneJson(item, child(pointer, index), report, active),
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
          cloneJson(value[key], child(pointer, key), report, active),
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
        report.add(pointer, node.patternLabel ?? String(node.pattern), value);
        return value;
      }
      // Code points, not UTF-16 code units. JSON Schema counts characters as
      // RFC 8259 defines them, so a string of 60 emoji satisfies the published
      // `maxLength: 60` while `value.length` calls it 120 — content that
      // validates against the contract, rejected by the loader that emitted
      // it. Only `maxLength` can actually diverge, since UTF-16 length is
      // never the smaller of the two, but the three-way agreement this schema
      // is built on has to hold in both directions.
      const characters = [...value].length;
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
      const entries: [string, unknown][] = [];
      // Sorted, so the order issues are reported in comes from the schema and
      // the data rather than from how the JSON happened to be written.
      for (const key of Object.keys(value).sort()) {
        const at = child(pointer, key);
        if (!node.keyPattern.test(key)) {
          report.addPhrase(at, `a key that is ${node.keyLabel}`, describe(key));
        }
        // Collected and defined rather than assigned: these keys come from the
        // cartridge, and one of them names an accessor on `Object.prototype`.
        entries.push([key, validate(value[key], node.values, at, report)]);
      }
      return objectFromEntries(entries);
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
    case "object":
    case "deferred":
      return "an object";
    case "array":
      return "an array";
    case "record":
      return "an object";
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

/** Whether anything is already wrong at `prefix` or below it. */
function hasIssueUnder(report: Report, prefix: string): boolean {
  return report.issues.some(
    (issue) =>
      issue.pointer === prefix || issue.pointer.startsWith(`${prefix}/`),
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
  const contained = Object.keys(repository.files).some((path) =>
    path.startsWith(prefix),
  );
  if (!contained) {
    report.addPhrase(
      "/repository/cwd",
      "a directory that at least one declared file lives under",
      `${JSON.stringify(repository.cwd)}, which contains no files`,
    );
  }
}

/** Model ids seed the PRNG, so two models sharing one is two models sharing a session. */
function checkModelIds(
  models: readonly CartridgeModel[],
  report: Report,
): void {
  const seen = new Map<string, number>();
  models.forEach((model, index) => {
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
    story: normalized["story"] as DeferredObject,
    presentation: normalized["presentation"] as DeferredObject,
  };

  // Each cross-field check is gated on the subtree it reads, not on the whole
  // report. Gating globally suppressed a genuine duplicate model id whenever
  // anything else in the document was wrong, which costs the generator a round
  // trip the every-issue-at-once contract exists to save. Gating per subtree
  // keeps the reason the gate was there at all: a check that read a structure
  // the walk had already substituted would report a second, derived problem
  // for every real one — two models each missing an `id` would collide on the
  // substitute and produce a phantom duplicate.
  //
  // These are appended after the structural issues rather than interleaved at
  // their document position. Deterministic, which is what matters, but not
  // strictly document-ordered; the header above says so.
  if (!hasIssueUnder(report, "/repository")) {
    checkCwd(cartridge.repository, report);
  }
  if (!hasIssueUnder(report, "/models")) {
    checkModelIds(cartridge.models, report);
  }

  if (report.issues.length > 0)
    throw new CartridgeValidationError(report.issues);

  return cartridge;
}

/**
 * Fill the defaults that read another field rather than a constant.
 *
 * v0 has exactly one: a file the cartridge does not date was already there
 * when the session opened, so `mtime` falls back to `meta.startedAt`. It
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
  };

  for (const file of Object.values(repository.files)) {
    file["mtime"] ??= meta.startedAt;
  }
}
