/**
 * The seeded PRNG: mulberry32 over a tree of named streams.
 *
 * Invariant 2 says all randomness goes through one seeded generator. The
 * shape that survives an incident being *authored* — where a subsystem grows
 * a draw it did not have last week — is not one generator but a tree of them,
 * addressed by name.
 *
 * ## Why named sub-streams
 *
 * With a single sequence, every draw is positional: the spinner's verb comes
 * from draw 47 only because the 46 draws before it happened in that order.
 * Add one rare-event roll during startup and every subsequent draw in every
 * subsystem shifts by one. Every golden fixture in the repository fails, all
 * of them for the same uninteresting reason, and the diff that broke them says
 * nothing about which change was wrong.
 *
 * So `fork(label)` derives a child stream from the parent's *seed* and the
 * child's path — never from the parent's current position. Two consequences,
 * and they are the point of the design:
 *
 * - Consuming from one stream cannot perturb another. Spinner verbs, pid
 *   assignment, and rare-event rolls each move independently.
 * - A stream's sequence depends only on the root seed and its own path, so
 *   forking earlier or later in a session yields the same numbers.
 *
 * The cost is that the *set* of stream names is now part of the contract:
 * renaming `spinner.verbs` re-rolls everything drawn under it. That is the
 * trade being made deliberately — a rename is a deliberate act, whereas adding
 * a draw is routine.
 *
 * ## State
 *
 * A stream is a handle; the state lives in one registry shared by the whole
 * tree, which is what `toState()` returns and `restoreRandom` takes. Only
 * streams that have actually been drawn from appear in it: an untouched
 * stream's position is derivable from the root seed and its path, so recording
 * it would make serialized state depend on which streams were *created* rather
 * than on which were used.
 */

import { hashString, UINT32_RANGE } from "./seed.js";

/** One arm of a `weightedPick`. */
export interface WeightedEntry<T> {
  readonly value: T;
  /**
   * Relative frequency, as a non-negative integer. Zero means never — an
   * entry authored but currently switched off, which is a thing content wants
   * to express.
   */
  readonly weight: number;
}

/**
 * The serializable position of every stream that has been drawn from.
 *
 * Round-trips through `engine/serialize/canonical.ts` byte-identically: the
 * seed and every cursor are uint32s, and the paths are ASCII slugs.
 */
export interface RandomState {
  /** The root seed, uint32. */
  readonly seed: number;
  /** Stream path to its mulberry32 cursor. Absent path means untouched. */
  readonly cursors: Readonly<Record<string, number>>;
}

export interface RandomStream {
  /** This stream's own name — the last segment of `path`. */
  readonly label: string;
  /** Fully qualified name from the root, e.g. `root/spinner.verbs`. */
  readonly path: string;

  /** A uniform float in `[0, 1)`, exactly `nextUint32() / 4294967296`. */
  next(): number;
  /** The generator's raw output: a uniform integer in `[0, 2^32)`. */
  nextUint32(): number;
  /** A uniform integer in `[0, maxExclusive)`, unbiased. */
  int(maxExclusive: number): number;
  /** A uniform element of `values`. Throws on an empty array. */
  pick<T>(values: readonly T[]): T;
  /** An element of `entries` chosen in proportion to its weight. */
  weightedPick<T>(entries: readonly WeightedEntry<T>[]): T;
  /** The child stream named `label`, creating it on first use. */
  fork(label: string): RandomStream;

  /** The whole tree's position, not just this stream's. */
  toState(): RandomState;
}

/** The root stream's label, and so the first segment of every path. */
export const ROOT_LABEL = "root";

/** Separates path segments, and therefore forbidden inside a label. */
export const PATH_SEPARATOR = "/";

/**
 * Stream labels are identifiers, not prose: lowercase, digits, dot and dash.
 * Narrow because they are contract surface — a label appears verbatim as a key
 * in serialized state, so anything needing escaping there is a label that
 * should have been spelled differently.
 */
const LABEL_SHAPE = /^[a-z0-9][a-z0-9.-]*$/;

/** `int` draws from a uint32, so it cannot address a range wider than one. */
export const MAX_INT_RANGE = UINT32_RANGE;

interface Registry {
  readonly seed: number;
  readonly cursors: Map<string, number>;
}

function assertUint32(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 0 || value >= UINT32_RANGE) {
    throw new Error(
      `random: ${what} must be an integer in [0, ${String(UINT32_RANGE)}), got ${String(value)}`,
    );
  }
  return value;
}

function assertLabel(label: string): string {
  if (!LABEL_SHAPE.test(label)) {
    throw new Error(
      `random: stream label must match ${String(LABEL_SHAPE)}, got ${JSON.stringify(label)}`,
    );
  }
  return label;
}

/**
 * A stream's starting cursor: FNV-1a over its path, using the root seed as the
 * offset basis.
 *
 * Deriving from the path rather than from a counter is what makes forking
 * order-independent — see the note at the top of the file. Using the seed as
 * the basis rather than mixing it in afterwards means two sessions with
 * different seeds share no stream position anywhere in the tree.
 */
function seedForPath(rootSeed: number, path: string): number {
  return hashString(path, rootSeed);
}

/**
 * One mulberry32 step.
 *
 * The generator is counter-based: `cursor` advances by a fixed odd increment
 * and the returned value is a mix of it. That is why a stream's whole future
 * is one uint32, and why adjacent seeds produce unrelated sequences rather
 * than shifted ones.
 *
 * `Math.imul` keeps both multiplies in 32 bits; the intermediate `+` stays
 * well inside the exactly-representable integers before `^` truncates it back.
 */
function step(cursor: number): {
  readonly cursor: number;
  readonly draw: number;
} {
  const advanced = (cursor + 0x6d2b79f5) | 0;
  let mixed = Math.imul(advanced ^ (advanced >>> 15), 1 | advanced);
  mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
  return { cursor: advanced >>> 0, draw: (mixed ^ (mixed >>> 14)) >>> 0 };
}

function makeStream(registry: Registry, path: string): RandomStream {
  const separator = path.lastIndexOf(PATH_SEPARATOR);
  const label = separator === -1 ? path : path.slice(separator + 1);

  function nextUint32(): number {
    const current =
      registry.cursors.get(path) ?? seedForPath(registry.seed, path);
    const stepped = step(current);
    registry.cursors.set(path, stepped.cursor);
    return stepped.draw;
  }

  const stream: RandomStream = {
    label,
    path,

    nextUint32,

    next(): number {
      return nextUint32() / UINT32_RANGE;
    },

    /**
     * Rejection sampling on the raw uint32 rather than `floor(next() * n)`.
     *
     * The float form is biased whenever `n` does not divide 2^32 — for
     * `n = 3`, one outcome is one part in 1.4 billion more likely than the
     * others, which is invisible in a spinner verb and not invisible in a
     * distribution snapshot committed as a contract. Rejection is exact and
     * stays in integers, so no rounding rule is involved at all.
     *
     * It consumes a variable number of draws. That is still deterministic —
     * the same seed rejects at the same places — but it does mean the cursor
     * after `int(3)` is not always one step on.
     */
    int(maxExclusive: number): number {
      if (
        !Number.isInteger(maxExclusive) ||
        maxExclusive < 1 ||
        maxExclusive > MAX_INT_RANGE
      ) {
        throw new Error(
          `random: ${path}: int() bound must be an integer in [1, ${String(MAX_INT_RANGE)}], got ${String(maxExclusive)}`,
        );
      }

      // The largest multiple of `maxExclusive` that fits in a uint32. Draws at
      // or above it are the short final block, and are discarded.
      const limit = UINT32_RANGE - (UINT32_RANGE % maxExclusive);
      let draw = nextUint32();
      while (draw >= limit) {
        draw = nextUint32();
      }
      return draw % maxExclusive;
    },

    pick<T>(values: readonly T[]): T {
      if (values.length === 0) {
        throw new Error(`random: ${path}: pick() from an empty array`);
      }
      const index = stream.int(values.length);
      if (!(index in values)) {
        throw new Error(
          `random: ${path}: pick() landed on hole ${String(index)} of a sparse array`,
        );
      }
      return values[index] as T;
    },

    /**
     * Weights are integers so selection is exact integer arithmetic: one
     * `int(total)` roll compared against a running sum, with no float
     * comparison anywhere. Entry *order* is part of the contract — the same
     * roll maps to a different entry if the list is reordered.
     */
    weightedPick<T>(entries: readonly WeightedEntry<T>[]): T {
      if (entries.length === 0) {
        throw new Error(`random: ${path}: weightedPick() from an empty list`);
      }

      let total = 0;
      for (let index = 0; index < entries.length; index += 1) {
        if (!(index in entries)) {
          throw new Error(
            `random: ${path}: weightedPick() entry ${String(index)} is a hole in a sparse array`,
          );
        }
        const weight = (entries[index] as WeightedEntry<T>).weight;
        if (!Number.isSafeInteger(weight) || weight < 0) {
          throw new Error(
            `random: ${path}: weightedPick() weight ${String(index)} must be a non-negative integer, got ${String(weight)}`,
          );
        }
        total += weight;
      }

      if (total < 1 || total > MAX_INT_RANGE) {
        throw new Error(
          `random: ${path}: weightedPick() weights must total between 1 and ${String(MAX_INT_RANGE)}, got ${String(total)}`,
        );
      }

      const roll = stream.int(total);
      let cumulative = 0;
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index] as WeightedEntry<T>;
        cumulative += entry.weight;
        if (roll < cumulative) return entry.value;
      }

      // Unreachable: `roll < total` and `cumulative` reaches `total`.
      throw new Error(
        `random: ${path}: weightedPick() fell through with roll ${String(roll)} of ${String(total)}`,
      );
    },

    fork(label: string): RandomStream {
      return makeStream(
        registry,
        `${path}${PATH_SEPARATOR}${assertLabel(label)}`,
      );
    },

    toState(): RandomState {
      const cursors: Record<string, number> = {};
      for (const key of [...registry.cursors.keys()].sort()) {
        cursors[key] = registry.cursors.get(key) as number;
      }
      return { seed: registry.seed, cursors };
    },
  };

  return stream;
}

/**
 * Create the root stream.
 *
 * A string is hashed with `hashString` — pass the canonical seed string from
 * `formatSeed`. A number is taken as an already-derived uint32 root seed.
 */
export function createRandom(seed: number | string): RandomStream {
  const rootSeed =
    typeof seed === "string" ? hashString(seed) : assertUint32(seed, "seed");
  return makeStream({ seed: rootSeed, cursors: new Map() }, ROOT_LABEL);
}

/**
 * Rebuild the tree from serialized state, positioned exactly where it stopped.
 *
 * Validates rather than trusts: state arrives from JSON — a fixture, a replay
 * permalink — and a cursor that is not a uint32 would produce a stream that
 * diverges from the one that was recorded instead of failing.
 */
export function restoreRandom(state: RandomState): RandomStream {
  // Checked before the walk, so `{"seed": 5}` reports what is wrong with it
  // rather than throwing a TypeError out of `Object.keys`. Arrays are objects
  // and would otherwise walk their indices as stream paths.
  if (
    typeof state.cursors !== "object" ||
    state.cursors === null ||
    Array.isArray(state.cursors)
  ) {
    throw new Error(
      `random: cursors must be an object of stream path to position, got ${JSON.stringify(state.cursors)}`,
    );
  }

  const cursors = new Map<string, number>();
  for (const path of Object.keys(state.cursors)) {
    const segments = path.split(PATH_SEPARATOR);
    if (segments.length === 0 || segments[0] !== ROOT_LABEL) {
      throw new Error(
        `random: stream path must start with ${JSON.stringify(ROOT_LABEL)}, got ${JSON.stringify(path)}`,
      );
    }
    for (const segment of segments.slice(1)) {
      assertLabel(segment);
    }
    cursors.set(
      path,
      assertUint32(state.cursors[path] as number, `cursor for ${path}`),
    );
  }

  return makeStream(
    { seed: assertUint32(state.seed, "seed"), cursors },
    ROOT_LABEL,
  );
}
