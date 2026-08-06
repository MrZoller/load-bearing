/**
 * The canonical serializer.
 *
 * This module is the determinism contract in code form. Every subsystem that
 * needs to compare, snapshot, or record state serializes through it, so that
 * "byte-identical" means the same thing everywhere:
 *
 * - object keys are emitted in UTF-16 code-unit order (`Array.prototype.sort`
 *   with no comparator), never in insertion order
 * - numbers use the ECMAScript `Number::toString` representation, which is
 *   exact and platform-independent; `-0` normalizes to `0`
 * - values that cannot round-trip deterministically are rejected loudly rather
 *   than coerced quietly (`NaN`, `Infinity`, `Date`, `Map`, `Set`, class
 *   instances, functions, symbols, bigints)
 * - line endings are LF and the document ends with exactly one trailing
 *   newline, so a recorded artifact is a well-formed text file and diffs
 *   cleanly
 *
 * The rejections matter more than they look. `JSON.stringify` turns `NaN` into
 * `null` and calls `toJSON()` on a `Date`, both of which produce output that
 * looks fine and hides a determinism leak. See docs/ARCHITECTURE.md →
 * Event sourcing and determinism.
 */

const INDENT = "  ";

/** Thrown when a value cannot be represented deterministically. */
export class CanonicalSerializeError extends Error {
  /** JSON pointer to the offending value, e.g. `/repository/files/0`. */
  readonly pointer: string;

  constructor(pointer: string, detail: string) {
    super(`cannot canonically serialize ${pointer || "<root>"}: ${detail}`);
    this.name = "CanonicalSerializeError";
    this.pointer = pointer;
  }
}

/**
 * Serialize a value to canonical JSON text, terminated by a single LF.
 *
 * This is the form recorded in golden fixtures and compared byte for byte.
 */
export function serialize(value: unknown): string {
  return `${write(value, "", 0, new Set())}\n`;
}

/**
 * Serialize a value to canonical JSON on a single line, with no trailing
 * newline. Used where a canonical value has to sit inside a line of text —
 * transcript entries, log lines, error messages.
 */
export function serializeInline(value: unknown): string {
  return writeInline(value, "", new Set());
}

/**
 * Parse canonical JSON text back into plain data.
 *
 * `serialize(deserialize(serialize(x)))` is `serialize(x)` for every value
 * `serialize` accepts — that round-trip is the snapshot contract.
 */
export function deserialize(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function write(
  value: unknown,
  pointer: string,
  depth: number,
  seen: Set<object>,
): string {
  const primitive = writePrimitive(value, pointer);
  if (primitive !== undefined) return primitive;

  const container = value as object;
  if (seen.has(container))
    throw new CanonicalSerializeError(pointer, "circular reference");
  seen.add(container);
  try {
    const pad = INDENT.repeat(depth + 1);
    const closePad = INDENT.repeat(depth);

    if (Array.isArray(container)) {
      if (container.length === 0) return "[]";
      const items = container.map((item, index) => {
        const itemPointer = `${pointer}/${index}`;
        if (item === undefined) {
          throw new CanonicalSerializeError(
            itemPointer,
            "undefined array element",
          );
        }
        return `${pad}${write(item, itemPointer, depth + 1, seen)}`;
      });
      return `[\n${items.join(",\n")}\n${closePad}]`;
    }

    const entries = plainEntries(container, pointer);
    if (entries.length === 0) return "{}";
    const body = entries.map(
      ([key, item]) =>
        `${pad}${JSON.stringify(key)}: ${write(item, `${pointer}/${escapePointer(key)}`, depth + 1, seen)}`,
    );
    return `{\n${body.join(",\n")}\n${closePad}}`;
  } finally {
    seen.delete(container);
  }
}

function writeInline(
  value: unknown,
  pointer: string,
  seen: Set<object>,
): string {
  const primitive = writePrimitive(value, pointer);
  if (primitive !== undefined) return primitive;

  const container = value as object;
  if (seen.has(container))
    throw new CanonicalSerializeError(pointer, "circular reference");
  seen.add(container);
  try {
    if (Array.isArray(container)) {
      const items = container.map((item, index) => {
        const itemPointer = `${pointer}/${index}`;
        if (item === undefined) {
          throw new CanonicalSerializeError(
            itemPointer,
            "undefined array element",
          );
        }
        return writeInline(item, itemPointer, seen);
      });
      return `[${items.join(",")}]`;
    }

    const entries = plainEntries(container, pointer);
    const body = entries.map(
      ([key, item]) =>
        `${JSON.stringify(key)}:${writeInline(item, `${pointer}/${escapePointer(key)}`, seen)}`,
    );
    return `{${body.join(",")}}`;
  } finally {
    seen.delete(container);
  }
}

/**
 * Render the values that have no internal structure. Returns `undefined` for
 * arrays and plain objects, which the callers above handle themselves.
 */
function writePrimitive(value: unknown, pointer: string): string | undefined {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      return writeNumber(value, pointer);
    case "undefined":
      throw new CanonicalSerializeError(pointer, "undefined");
    case "bigint":
      throw new CanonicalSerializeError(
        pointer,
        "bigint has no JSON representation",
      );
    case "function":
      throw new CanonicalSerializeError(pointer, "function");
    case "symbol":
      throw new CanonicalSerializeError(pointer, "symbol");
    case "object":
      return undefined;
    default:
      throw new CanonicalSerializeError(
        pointer,
        `unsupported type ${typeof value}`,
      );
  }
}

function writeNumber(value: number, pointer: string): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalSerializeError(
      pointer,
      `${String(value)} is not finite; JSON would silently record it as null`,
    );
  }
  // `Object.is` distinguishes -0 from 0, which `===` does not. Left alone, -0
  // serializes as "-0" and compares unequal to a 0 that took a different code
  // path to the same value.
  return Object.is(value, -0) ? "0" : String(value);
}

/**
 * Key/value pairs of a plain object, sorted by key and with `undefined` values
 * dropped (the JSON convention: an absent key and an undefined key are the
 * same document).
 *
 * Anything that is not a plain object is rejected here, including the built-ins
 * whose `toJSON` would otherwise make them look serializable.
 */
function plainEntries(value: object, pointer: string): [string, unknown][] {
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== null && prototype !== Object.prototype) {
    const name = value.constructor?.name ?? "object";
    throw new CanonicalSerializeError(
      pointer,
      `${name} is not a plain object; convert it to plain data before serializing`,
    );
  }

  return Object.keys(value)
    .sort()
    .flatMap((key): [string, unknown][] => {
      const item = (value as Record<string, unknown>)[key];
      return item === undefined ? [] : [[key, item]];
    });
}

/** RFC 6901 escaping, so a key containing `/` still yields a usable pointer. */
function escapePointer(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}
