/**
 * Regenerate `content/schema/cartridge.v0.json`. Run with `npm run schema:update`.
 *
 * The published schema is emitted from `engine/cartridge/schema.ts`, so it can
 * never describe a loader that no longer exists. `engine/cartridge/schema.test.ts`
 * compares the committed file against this output and fails on any drift — the
 * same contract the golden replay fixtures have, for the same reason.
 *
 * This is the one script permitted to write under `content/` (invariant 1:
 * content tooling may only write to approved content paths).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { emitJsonSchema } from "../engine/cartridge/jsonSchema.js";
import { serialize } from "../engine/serialize/canonical.js";

const OUTPUT = fileURLToPath(
  new URL("../content/schema/cartridge.v0.json", import.meta.url),
);

function main(): void {
  const rendered = serialize(emitJsonSchema());
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, rendered, "utf8");
  process.stdout.write(
    `wrote ${OUTPUT} (${String(rendered.length)} bytes)\nReview the diff before committing: this file is the contract content tooling reads.\n`,
  );
}

main();
