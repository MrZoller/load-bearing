// Sample: Node built-ins. Violates invariant 3 on purpose.
import { readFileSync } from "node:fs";
import { join } from "path";

export function read(base: string, name: string): string {
  return readFileSync(join(base, name), "utf8");
}
