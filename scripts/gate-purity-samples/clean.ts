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

/** A regex full of slashes must not be read as a comment either. */
const REPEATED_SLASHES = /\/{2,}/g;

export function normalizePath(input: string): string {
  return input.replace(REPEATED_SLASHES, "/");
}
