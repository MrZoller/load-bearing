/**
 * Immutable patterns.
 *
 * Every validator in the engine is a pattern, and several are exported —
 * `MODEL_ID_PATTERN` decides which model ids exist, `ABSOLUTE_PATH_PATTERN`
 * decides which file paths do. A consumer that can change one changes what
 * `loadCartridge` accepts, and the published schema then describes a loader
 * that no longer exists.
 *
 * `Object.freeze` is not enough to stop that, which is the whole reason this
 * module exists. Freezing a regular expression protects its *properties*, and
 * `RegExp.prototype.compile` mutates its *internal slots* — in V8 it installs
 * the new matcher first and only then fails writing the frozen `lastIndex`, so
 * a caller who catches that error is left holding a pattern that matches
 * something else entirely, permanently, with no property having changed.
 *
 * So the regular expression is never handed out at all. It lives in a closure
 * behind an object carrying the two things callers actually need: the `source`
 * the published schema quotes, and a `test` that answers. There is no
 * `compile` to reach, no `lastIndex` to write, and nothing to re-point.
 */

/** What the engine needs from a pattern, and nothing more. */
export interface Pattern {
  /** The spelling between the slashes, which is what JSON Schema wants. */
  readonly source: string;
  test(value: string): boolean;
}

/**
 * Wrap a regular expression so that only its answers escape.
 *
 * Takes the expression structurally rather than as a `RegExp`, because the
 * purity gate bans that identifier: its legacy statics (`RegExp.$1`,
 * `RegExp.lastMatch`) carry the last match made anywhere in the realm. A regex
 * literal satisfies this shape, and passing one inline is the intended use —
 * the literal is captured on creation and no other reference to it exists.
 *
 * `test` is safe to expose: it writes `lastIndex` only on a global or sticky
 * pattern, and a validator is neither.
 */
export function pattern(expression: {
  readonly source: string;
  test(value: string): boolean;
}): Pattern {
  return Object.freeze({
    source: expression.source,
    test: (value: string): boolean => expression.test(value),
  });
}
