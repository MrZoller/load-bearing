import { pattern } from "../pattern.js";

/**
 * Seed derivation: `(incidentDate, dailySeed, model)` to a uint32.
 *
 * A session's entire behaviour hangs off this number, so both halves of the
 * derivation — the string form and the hash — are part of the determinism
 * contract, not implementation detail. Changing either invalidates every
 * recorded fixture and every shared replay permalink, which is why they are
 * spelled out here rather than left to whatever a hash function happens to do.
 *
 * See docs/ARCHITECTURE.md → Event sourcing and determinism.
 */

/** The three inputs that identify a session's random stream. */
export interface SeedMaterial {
  /** The incident's calendar date, `YYYY-MM-DD`. */
  readonly incidentDate: string;
  /** The per-day rotation counter. Non-negative integer. */
  readonly dailySeed: number;
  /** The active model's stable identifier, e.g. `deep-foundation`. */
  readonly model: string;
}

/**
 * Joins the three fields of the seed string.
 *
 * Fields may not contain it, which is what makes the join injective: without
 * that rule `{incidentDate: "a/b", model: "c"}` and
 * `{incidentDate: "a", model: "b/c"}` would collapse onto one seed and two
 * different sessions would silently share a stream.
 */
export const SEED_FIELD_SEPARATOR = "/";

/**
 * Wrapped rather than exported raw, so a consumer cannot turn a validator into
 * a rubber stamp — by assigning over `test`, or by calling `compile`, which
 * freezing does not stop. See `engine/pattern.ts`.
 *
 * Shape check only. The date is `YYYY-MM-DD`; whether it is a real calendar
 * date is the cartridge loader's job (issue #3), which has the whole cartridge
 * in hand and can say which incident is wrong.
 */
export const INCIDENT_DATE_PATTERN = pattern(/^\d{4}-\d{2}-\d{2}$/);

/**
 * Model identifiers are slugs, not prose. Narrow on purpose: the seed string
 * ends up in URLs and fixture names, and a model called `Deep Foundation™`
 * would make one that needs escaping.
 */
export const MODEL_ID_PATTERN = pattern(/^[a-z0-9][a-z0-9.-]*$/);

/** FNV-1a 32-bit, as published. */
export const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
export const FNV_PRIME_32 = 0x01000193;

/** Largest value a uint32 can hold, plus one. */
export const UINT32_RANGE = 4294967296;

/**
 * FNV-1a over the UTF-16LE bytes of `text`.
 *
 * Two decisions worth stating, because both are load-bearing for replay:
 *
 * FNV-1a is defined over bytes, and JavaScript strings are sequences of UTF-16
 * code units, so a byte-oriented hash needs an encoding. This one uses the
 * string's own UTF-16 representation, little end first, rather than
 * transcoding to UTF-8. `charCodeAt` is exactly specified by ECMA-262 and
 * needs no encoder, whereas a hand-written UTF-8 encoder is a second thing to
 * get wrong — and `TextEncoder` is not available to the engine (see
 * engine/testing/README.md → The engine's own tsconfig). Lone surrogates hash
 * as themselves instead of failing, which matters because seed strings arrive
 * from a URL.
 *
 * `Math.imul` performs the multiply in 32 bits. Plain `*` would exceed 2^53
 * on the very first round and start losing low bits, which is where the hash
 * lives.
 *
 * `basis` exists so a stream's seed can be derived by hashing its path *from*
 * its parent's seed; see `engine/random/stream.ts`. Left at the default it is
 * plain FNV-1a.
 */
export function hashString(
  text: string,
  basis: number = FNV_OFFSET_BASIS_32,
): number {
  let hash = basis >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    hash = Math.imul(hash ^ (unit & 0xff), FNV_PRIME_32);
    hash = Math.imul(hash ^ (unit >>> 8), FNV_PRIME_32);
  }
  return hash >>> 0;
}

/**
 * Render seed material as its canonical string.
 *
 * This string is the wire form: it is what a fixture records, what a replay
 * permalink carries, and what `hashString` turns into the root seed.
 */
export function formatSeed(material: SeedMaterial): string {
  // Captured before any of the three guards, and the join built from the
  // captures. `material` is caller-owned at an exported entry, and each field
  // was read once to validate and again to join — so a `dailySeed` getter
  // answering `1` to the checks and `"1/x"` to `String()` smuggled a separator
  // past validation. Two different materials then produce one seed string and
  // therefore one PRNG root, which is the injectivity the field rules at the
  // top of this file exist to guarantee: not a hygiene point but invariant 2,
  // since the two sessions share a generator and a replay permalink reproduces
  // the wrong one.
  const incidentDate = material.incidentDate;
  const dailySeed = material.dailySeed;
  const model = material.model;

  if (!INCIDENT_DATE_PATTERN.test(incidentDate)) {
    throw new Error(
      `seed material: incidentDate must be YYYY-MM-DD, got ${JSON.stringify(incidentDate)}`,
    );
  }
  if (!Number.isSafeInteger(dailySeed) || dailySeed < 0) {
    throw new Error(
      `seed material: dailySeed must be a non-negative integer, got ${String(dailySeed)}`,
    );
  }
  if (!MODEL_ID_PATTERN.test(model)) {
    throw new Error(
      `seed material: model must be a lowercase slug, got ${JSON.stringify(model)}`,
    );
  }

  return [incidentDate, String(dailySeed), model].join(SEED_FIELD_SEPARATOR);
}
