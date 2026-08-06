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
      assertPlainArray(container, pointer);
      if (container.length === 0) return "[]";
      const items: string[] = [];
      for (let index = 0; index < container.length; index += 1) {
        const itemPointer = `${pointer}/${index}`;
        const item = readElement(container, index, itemPointer);
        items.push(`${pad}${write(item, itemPointer, depth + 1, seen)}`);
      }
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
      assertPlainArray(container, pointer);
      const items: string[] = [];
      for (let index = 0; index < container.length; index += 1) {
        const itemPointer = `${pointer}/${index}`;
        const item = readElement(container, index, itemPointer);
        items.push(writeInline(item, itemPointer, seen));
      }
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
 * Own enumerable index keys, as `Object.keys` reports them.
 *
 * Spelling is not sufficient. An array index is `0 … 2**32 - 2`; assigning
 * `a[4294967295]` leaves `length` at 0 and creates an ordinary property, so a
 * key that merely looks numeric can still be state the element loop never
 * visits.
 */
const MAX_ARRAY_INDEX = 4294967294;
const ARRAY_INDEX_SPELLING = /^(?:0|[1-9]\d*)$/;

function isArrayIndexKey(key: string): boolean {
  return ARRAY_INDEX_SPELLING.test(key) && Number(key) <= MAX_ARRAY_INDEX;
}

/**
 * Reject own properties `Object.keys` would not report.
 *
 * A non-enumerable property is state, and dropping it silently produces the
 * same one-recording-two-states collision as a symbol key. It also bypasses
 * the accessor check, since that check only ever sees keys `Object.keys`
 * returned — so a single property flag would otherwise let a getter run during
 * serialization after all.
 */
function assertAllOwnPropertiesEnumerable(
  value: object,
  pointer: string,
  ignore: readonly string[] = [],
): void {
  const enumerable = new Set(Object.keys(value));
  for (const key of Object.getOwnPropertyNames(value)) {
    if (enumerable.has(key) || ignore.includes(key)) continue;
    throw new CanonicalSerializeError(
      pointer,
      `non-enumerable property ${JSON.stringify(key)} would be dropped silently`,
    );
  }
}

/**
 * Reject arrays carrying anything the numeric elements do not cover.
 *
 * `Array.isArray` is true for subclass instances, so the prototype check in
 * `plainEntries` never runs on an array — and the array branch never calls
 * `plainEntries` at all. Without this, `Object.assign([], { foo: 1 })`
 * serializes as `[]` and the extra state vanishes without an error: two
 * materially different values with one recording.
 */
function assertPlainArray(array: readonly unknown[], pointer: string): void {
  const prototype = Object.getPrototypeOf(array) as object | null;
  if (prototype !== Array.prototype) {
    throw new CanonicalSerializeError(
      pointer,
      "array subclass; convert it to a plain array before serializing",
    );
  }

  const symbols = Object.getOwnPropertySymbols(array);
  if (symbols.length > 0) {
    throw new CanonicalSerializeError(
      pointer,
      `symbol-keyed property ${String(symbols[0])} would be dropped silently`,
    );
  }

  // `length` is a non-enumerable own property of every array, and is the one
  // that is not state.
  assertAllOwnPropertiesEnumerable(array, pointer, ["length"]);

  for (const key of Object.keys(array)) {
    if (!isArrayIndexKey(key)) {
      throw new CanonicalSerializeError(
        pointer,
        `non-index property ${JSON.stringify(key)} would be dropped silently`,
      );
    }
  }
}

/**
 * Read one array element, rejecting everything that is not inert own data.
 *
 * Reading through the descriptor rather than `array[index]` closes three holes
 * at once. A hole is `undefined` here even when `Array.prototype` has been
 * polluted with a numeric property, which an `index in array` test would
 * happily report as present. An accessor is rejected rather than invoked. And
 * the value is read exactly once, where a separate check-then-read pair would
 * call a getter twice per element.
 */
function readElement(
  array: readonly unknown[],
  index: number,
  pointer: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(array, index);
  if (descriptor === undefined) {
    throw new CanonicalSerializeError(pointer, "hole in a sparse array");
  }
  if (descriptor.get !== undefined || descriptor.set !== undefined) {
    throw new CanonicalSerializeError(
      pointer,
      "accessor property; reading it would run code during serialization",
    );
  }
  if (descriptor.value === undefined) {
    throw new CanonicalSerializeError(pointer, "undefined array element");
  }
  return descriptor.value;
}

/**
 * Key/value pairs of a plain object, sorted by key and with `undefined` values
 * dropped (the JSON convention: an absent key and an undefined key are the
 * same document).
 *
 * Three things are rejected here rather than handled, because each would
 * produce output that looks fine and is not:
 *
 * - **Non-plain objects**, including the built-ins whose `toJSON` would
 *   otherwise make them look serializable.
 * - **Symbol keys**, which `Object.keys` omits. Dropping them silently lets
 *   two materially different states serialize to identical bytes, which is
 *   precisely the divergence no golden fixture could then catch.
 * - **Accessor properties**, because reading one runs arbitrary code during
 *   serialization. A getter over a counter makes the same object serialize to
 *   different bytes on consecutive calls, and a getter with a side effect can
 *   mutate the very state being recorded.
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

  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length > 0) {
    throw new CanonicalSerializeError(
      pointer,
      `symbol-keyed property ${String(symbols[0])} would be dropped silently`,
    );
  }

  assertAllOwnPropertiesEnumerable(value, pointer);

  return Object.keys(value)
    .sort()
    .flatMap((key): [string, unknown][] => {
      // Read the descriptor rather than the property: dereferencing the key
      // would invoke a getter before there was a chance to reject it.
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) return [];
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        throw new CanonicalSerializeError(
          `${pointer}/${escapePointer(key)}`,
          "accessor property; reading it would run code during serialization",
        );
      }
      return descriptor.value === undefined ? [] : [[key, descriptor.value]];
    });
}

/** RFC 6901 escaping, so a key containing `/` still yields a usable pointer. */
function escapePointer(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}
