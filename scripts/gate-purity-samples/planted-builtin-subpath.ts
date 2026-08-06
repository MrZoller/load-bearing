// Sample: Node built-in subpath imports. Neither specifier starts with `node:`
// nor equals a built-in exactly, and `fs/promises` is what autocomplete
// produces. Violates invariant 3 on purpose.
import { readFile } from "fs/promises";
import { strict } from "assert/strict";

export const read = readFile;
export const check = strict;
