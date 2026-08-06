/**
 * Text shapes that cannot survive being written to a recorded artifact.
 *
 * Shared because the same two failures arrive from two directions: a hand
 * written fixture can carry them in an event's `type`, and a reducer can
 * generate them into a transcript entry. Checking only the input half would
 * leave the generated half free to produce an artifact that no re-record could
 * ever match.
 */

/**
 * Any C0 or C1 control character, plus U+2028 and U+2029.
 *
 * The Unicode separators are not control characters, but editors, terminals,
 * and review tooling all render them as line breaks — so one entry would
 * appear as several lines in the artifact a human is meant to read.
 */
export const CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

/**
 * A surrogate code unit with no partner.
 *
 * Writing one out as UTF-8 substitutes U+FFFD, so the artifact no longer holds
 * what produced it and the byte-identity test can never pass — an unfixable
 * fixture rather than a wrong one.
 */
export const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Describe why `text` cannot be one line of a recorded artifact, or return
 * `undefined` when it can.
 */
export function describeUnwritableText(text: string): string | undefined {
  if (CONTROL_CHARACTER.test(text)) {
    return "a control character; entries are one line each";
  }
  if (LONE_SURROGATE.test(text)) {
    return (
      "an unpaired surrogate; it cannot survive being written as UTF-8, so no " +
      "recording of it could ever match"
    );
  }
  return undefined;
}
