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
      const elements = arrayElements(container, pointer);
      if (elements.length === 0) return "[]";
      const items = elements.map(
        (item, index) =>
          `${pad}${write(item, `${pointer}/${index}`, depth + 1, seen)}`,
      );
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
      const items = arrayElements(container, pointer).map((item, index) =>
        writeInline(item, `${pointer}/${index}`, seen),
      );
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
 * A key used only to probe a WeakMap/WeakSet without adding anything.
 */
const BRAND_KEY = {};

/**
 * Brand checks that read internal slots rather than the prototype chain.
 *
 * The plain-object test asks what a value's prototype is, and a prototype can
 * be re-pointed: `Object.setPrototypeOf(map, Object.prototype)` turns a Map
 * with entries into something that looks like inert data and reports no own
 * properties, so it would serialize as `{}` — two different states, one
 * recording. These probes ask the value itself.
 *
 * `Object.prototype.toString` covers the built-ins whose tag comes from an
 * internal slot (Date, RegExp, Error, the boxed primitives) and survives a
 * prototype swap. The collections carry no such tag, so each is probed with a
 * method that throws unless the slot is really there.
 *
 * The gate's `prototype-mutation` rule is the other half, and the load-bearing
 * one: engine code cannot re-point a prototype at all. This is the containment
 * for a value that arrives some other way.
 */
const BRAND_PROBES: readonly (readonly [string, (value: object) => unknown])[] =
  [
    [
      "Map",
      (value) =>
        Object.getOwnPropertyDescriptor(Map.prototype, "size")?.get?.call(
          value,
        ),
    ],
    [
      "Set",
      (value) =>
        Object.getOwnPropertyDescriptor(Set.prototype, "size")?.get?.call(
          value,
        ),
    ],
    [
      "WeakMap",
      (value) =>
        WeakMap.prototype.has.call(
          value as WeakMap<object, unknown>,
          BRAND_KEY,
        ),
    ],
    [
      "WeakSet",
      (value) =>
        WeakSet.prototype.has.call(value as WeakSet<object>, BRAND_KEY),
    ],
  ];

/**
 * The built-in a value really is, whatever its prototype claims, or
 * `undefined` when it is ordinary data.
 *
 * Exported because the cartridge loader needs the same answer. A `Map` whose
 * prototype has been repointed at `Object.prototype` has no own keys, so a
 * loader checking only the prototype copies an empty object over it and loses
 * every entry in silence — while this function, and therefore the serializer,
 * would have refused it. Two implementations of "what is really plain data"
 * would be two chances to disagree.
 *
 * Two preconditions, both of which exist because this function reads
 * `Symbol.toStringTag` and must never run an accessor to do it. The caller
 * must already have established that the value's prototype is
 * `Object.prototype` or null, so that is the only chain member left to check;
 * and that the value has no own symbol-keyed properties, since an own
 * accessor at `Symbol.toStringTag` would answer the Get below. `plainEntries`
 * satisfies both before calling, and so does the cartridge loader — the
 * second one is easy to lose when this function moves to a new call site.
 */
export function detectBrand(value: object): string | undefined {
  // `Object.prototype.toString` performs a Get of `Symbol.toStringTag`, which
  // an *inherited* accessor would answer. The caller has already established
  // that this value's prototype is `Object.prototype` or null, so that is the
  // only chain member to check — and its descriptor can be read inertly.
  if (
    Object.getOwnPropertyDescriptor(Object.prototype, Symbol.toStringTag) !==
    undefined
  ) {
    throw new CanonicalSerializeError(
      "",
      "Object.prototype carries a Symbol.toStringTag; the environment itself has been " +
        "tampered with and nothing serialized in it can be trusted",
    );
  }

  const tag = Object.prototype.toString.call(value).slice(8, -1);
  if (tag !== "Object") return tag;

  for (const [name, probe] of BRAND_PROBES) {
    try {
      probe(value);
      return name;
    } catch {
      // Not that built-in: the probe threw on a missing internal slot.
    }
  }
  return undefined;
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
 * Snapshot every own property of a container in a single reflective pass.
 *
 * `Object.getOwnPropertyDescriptors` is one `ownKeys` trap and one
 * `getOwnPropertyDescriptor` trap per key, and everything downstream reads
 * from the snapshot rather than touching the value again. That matters
 * because JavaScript offers no way to detect a `Proxy` from inside the
 * language: reflecting over one runs its traps no matter what. Reflecting
 * once means a hostile proxy has one opportunity to lie rather than four, and
 * that the same descriptor cannot report different things to the enumerability
 * check and to the value read. See also the purity gate's `proxy-reflection`
 * rule, which stops engine code creating one in the first place — that is the
 * realistic defence; this is the containment.
 *
 * Symbol keys are rejected here because `Object.keys` omits them, and dropping
 * them silently lets two different states produce one recording.
 */
function ownProperties(
  value: object,
  pointer: string,
): Record<string, PropertyDescriptor> {
  const descriptors = Object.getOwnPropertyDescriptors(value);

  const symbols = Object.getOwnPropertySymbols(descriptors);
  if (symbols.length > 0) {
    throw new CanonicalSerializeError(
      pointer,
      `symbol-keyed property ${String(symbols[0])} would be dropped silently`,
    );
  }

  return descriptors as Record<string, PropertyDescriptor>;
}

/**
 * Reject a property that is state but would not survive serialization.
 *
 * Non-enumerable first: `Object.keys` omits it, so dropping it silently is the
 * same one-recording-two-states collision as a symbol key — and it would also
 * slip past the accessor check below, since that only ever sees keys
 * `Object.keys` returned.
 */
function assertInertData(
  descriptor: PropertyDescriptor,
  key: string,
  pointer: string,
): void {
  if (descriptor.enumerable !== true) {
    throw new CanonicalSerializeError(
      pointer,
      `non-enumerable property ${JSON.stringify(key)} would be dropped silently`,
    );
  }
  if (descriptor.get !== undefined || descriptor.set !== undefined) {
    throw new CanonicalSerializeError(
      `${pointer}/${escapePointer(key)}`,
      "accessor property; reading it would run code during serialization",
    );
  }
}

/**
 * Validate an array and return its elements in index order.
 *
 * `Array.isArray` is true for subclass instances, so the prototype check in
 * `plainEntries` never runs on an array — and the array branch never calls
 * `plainEntries` at all. Without the checks here, `Object.assign([], { foo: 1 })`
 * serializes as `[]` and the extra state vanishes without an error.
 */
function arrayElements(array: readonly unknown[], pointer: string): unknown[] {
  const prototype = Object.getPrototypeOf(array) as object | null;
  if (prototype !== Array.prototype) {
    throw new CanonicalSerializeError(
      pointer,
      "array subclass; convert it to a plain array before serializing",
    );
  }

  const descriptors = ownProperties(array, pointer);
  const elements: unknown[] = [];

  for (const [key, descriptor] of Object.entries(descriptors)) {
    // `length` is the one own property of an array that is not state, and the
    // one that is legitimately non-enumerable.
    if (key === "length") continue;
    if (!isArrayIndexKey(key)) {
      throw new CanonicalSerializeError(
        pointer,
        `non-index property ${JSON.stringify(key)} would be dropped silently`,
      );
    }
    assertInertData(descriptor, key, `${pointer}/${key}`);
  }

  const length = (descriptors["length"]?.value ?? 0) as number;
  for (let index = 0; index < length; index += 1) {
    const itemPointer = `${pointer}/${index}`;
    const descriptor = descriptors[String(index)];
    // A hole is absent from the snapshot even when `Array.prototype` carries a
    // numeric property, which an `index in array` test would report as present.
    if (descriptor === undefined) {
      throw new CanonicalSerializeError(itemPointer, "hole in a sparse array");
    }
    if (descriptor.value === undefined) {
      throw new CanonicalSerializeError(itemPointer, "undefined array element");
    }
    elements.push(descriptor.value);
  }

  return elements;
}

/**
 * Key/value pairs of a plain object, sorted by key and with `undefined` values
 * dropped (the JSON convention: an absent key and an undefined key are the
 * same document).
 *
 * Non-plain objects are rejected here, including the built-ins whose `toJSON`
 * would otherwise make them look serializable.
 */
function plainEntries(value: object, pointer: string): [string, unknown][] {
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== null && prototype !== Object.prototype) {
    throw new CanonicalSerializeError(
      pointer,
      `${describePrototype(prototype)} is not a plain object; convert it to plain data before serializing`,
    );
  }

  // Snapshot first, brand-check second. `Object.prototype.toString` performs a
  // Get of `Symbol.toStringTag`, so an own accessor there would run before
  // anything had a chance to reject it — in the check whose whole purpose is
  // to identify a value without trusting it. `ownProperties` rejects every
  // symbol key, this one included, and the prototype is already known to be
  // `Object.prototype` or null, so no inherited tag can exist either.
  const descriptors = ownProperties(value, pointer);

  const brand = detectBrand(value);
  if (brand !== undefined) {
    throw new CanonicalSerializeError(
      pointer,
      `${brand} with a replaced prototype; its contents live in internal slots and cannot be serialized`,
    );
  }

  return Object.keys(descriptors)
    .sort()
    .flatMap((key): [string, unknown][] => {
      const descriptor = descriptors[key];
      if (descriptor === undefined) return [];
      assertInertData(descriptor, key, pointer);
      return descriptor.value === undefined ? [] : [[key, descriptor.value]];
    });
}

/**
 * Name a rejected value's type for the error message, without running any of
 * its code.
 *
 * `value.constructor?.name` would be the obvious spelling and is a trap: a
 * prototype can define `constructor` as a getter, so the diagnostic that
 * exists to reject an unserializable object would execute part of it first —
 * in the one branch that skips every descriptor check.
 */
function describePrototype(prototype: object): string {
  const constructorDescriptor = Object.getOwnPropertyDescriptor(
    prototype,
    "constructor",
  );
  if (typeof constructorDescriptor?.value !== "function") return "this value";

  // `name` is configurable, so it too can be an accessor — reading it the
  // obvious way would run code from the value being refused, one level deeper
  // than the `constructor` trap this function already avoids.
  const nameDescriptor = Object.getOwnPropertyDescriptor(
    constructorDescriptor.value,
    "name",
  );
  return typeof nameDescriptor?.value === "string" &&
    nameDescriptor.value.length > 0
    ? nameDescriptor.value
    : "this value";
}

/** RFC 6901 escaping, so a key containing `/` still yields a usable pointer. */
function escapePointer(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}
