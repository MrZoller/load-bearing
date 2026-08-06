// Sample: clean. This file names Math.random, Date.now, document, and window
// in comments only. The gate blanks comments before scanning, so prose about a
// banned construct is not a violation — otherwise no module could explain why
// it avoids one.
/*
 * A block comment may also discuss localStorage and fetch(...) at length
 * without tripping anything.
 */

export const SOURCE_URL = "https://loadbearing.cc/source";

// String literal text is blanked too. The engine has to *print* words like
// these: `git log` emits a "Date:" column, `curl` emits a "Date:" header, and
// a status page announces a maintenance window. Those are mechanics, so they
// live in engine source, and none of them is a wall-clock read.
export const GIT_LOG_DATE_HEADER = "Date:   ";
export const CURL_HEADERS = ["Date", "Server", "Content-Type"];
export const MAINTENANCE_NOTICE =
  "Europe reattachment window: Sunday 02:00 UTC";
export const CURL_USAGE = "curl: try 'curl --help' or fetch the manual";

// Text that merely looks like an import is not one. The specifier rule reads a
// view of the file with strings intact, so it cross-checks that the keyword is
// real code and not literal text.
export const BANNED_EXAMPLE = 'import "node:fs"';
export const BANNED_PATTERN = /import "node:fs"/;

// Package names that only begin like a built-in are whole segments of their
// own, so matching the first path segment does not catch them.
export const LOOKALIKES = ["path-browserify", "fs-extra", "process-nextick"];

// A triple-slash directive inside a string is inert data, not a directive.
export const SAMPLE_SOURCE = '/// <reference types="node" />';

// The exactly-specified members of Math are allowed — they are what an engine
// that formats columns and sizes actually needs — as is a bare sort(), which
// is UTF-16 code-unit order.
export function column(width: number, used: number, names: string[]): string {
  const pad = Math.max(0, Math.floor(width - used));
  const area = Math.PI * Math.sqrt(width);
  return names.sort().join(" ".repeat(pad)) + String(Math.round(area));
}

/** A regex full of slashes must not be read as a comment either. */
const REPEATED_SLASHES = /\/{2,}/g;

export function normalizePath(input: string): string {
  return input.replace(REPEATED_SLASHES, "/");
}
