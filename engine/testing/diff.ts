/**
 * A small text differ for replay-fixture failures.
 *
 * The assertion is byte equality, so this exists purely to make a failure
 * readable: it trims the common prefix and suffix and prints only the region
 * that actually diverged. That keeps a one-line drift in a thousand-line
 * `state.json` from scrolling the whole artifact past the reader.
 *
 * Deliberately not a real LCS diff. Fixture mismatches are usually a changed
 * value rather than an inserted block, and an O(n·m) diff over large recorded
 * artifacts costs more than the extra alignment is worth.
 */

/** Maximum number of lines shown from each side before truncating. */
const MAX_CONTEXT_LINES = 20;

/**
 * Maximum characters of any single rendered line.
 *
 * The line cap alone bounds nothing: a serialized cartridge holds file
 * contents as one string, so one differing line can be megabytes. Dumping that
 * twice pushes the re-record guidance out of a truncated CI log — the diff
 * exists to be read.
 */
const MAX_LINE_LENGTH = 200;

export interface TextDiffOptions {
  /** Label for the recorded artifact. Defaults to `expected`. */
  readonly expectedLabel?: string;
  /** Label for the freshly replayed output. Defaults to `actual`. */
  readonly actualLabel?: string;
}

/**
 * Render the difference between two texts, or the empty string when they are
 * byte-identical.
 */
export function formatTextDiff(
  expected: string,
  actual: string,
  options: TextDiffOptions = {},
): string {
  if (expected === actual) return "";

  const expectedLabel = options.expectedLabel ?? "expected";
  const actualLabel = options.actualLabel ?? "actual";

  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");

  let prefix = 0;
  const maxPrefix = Math.min(expectedLines.length, actualLines.length);
  while (prefix < maxPrefix && expectedLines[prefix] === actualLines[prefix])
    prefix += 1;

  let suffix = 0;
  const maxSuffix = maxPrefix - prefix;
  while (
    suffix < maxSuffix &&
    expectedLines[expectedLines.length - 1 - suffix] ===
      actualLines[actualLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const expectedRegion = expectedLines.slice(
    prefix,
    expectedLines.length - suffix,
  );
  const actualRegion = actualLines.slice(prefix, actualLines.length - suffix);

  const header = [
    `first difference at line ${prefix + 1}`,
    `${expectedLabel}: ${expected.length} bytes, ${expectedLines.length} lines`,
    `${actualLabel}: ${actual.length} bytes, ${actualLines.length} lines`,
  ];

  return [
    ...header,
    "",
    ...renderRegion(`- ${expectedLabel}`, "-", expectedRegion, prefix),
    ...renderRegion(`+ ${actualLabel}`, "+", actualRegion, prefix),
  ].join("\n");
}

function truncate(line: string): string {
  return line.length <= MAX_LINE_LENGTH
    ? line
    : `${line.slice(0, MAX_LINE_LENGTH)}… (${line.length - MAX_LINE_LENGTH} more characters)`;
}

function renderRegion(
  title: string,
  marker: string,
  lines: readonly string[],
  offset: number,
): string[] {
  if (lines.length === 0)
    return [`${title}: (nothing — the other side has extra lines here)`, ""];

  const shown = lines.slice(0, MAX_CONTEXT_LINES);
  const rendered = shown.map(
    (line, index) => `${marker} ${offset + index + 1} | ${truncate(line)}`,
  );
  if (lines.length > shown.length) {
    rendered.push(`${marker} … ${lines.length - shown.length} more line(s)`);
  }
  return [`${title}:`, ...rendered, ""];
}
