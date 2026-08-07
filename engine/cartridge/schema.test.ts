import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { serialize } from "../serialize/canonical.js";
import { emitJsonSchema } from "./jsonSchema.js";
import {
  ARCHETYPES,
  CARTRIDGE_SCHEMA,
  CARTRIDGE_SCHEMA_VERSION,
} from "./schema.js";
import type { ObjectNode, SchemaNode } from "./schema.js";

const PUBLISHED = fileURLToPath(
  new URL("../../content/schema/cartridge.v0.json", import.meta.url),
);

describe("the published schema", () => {
  it("matches what the loader's descriptors emit", () => {
    // The lockstep test. `content/schema/cartridge.v0.json` is what content
    // tooling and anyone writing a cartridge by hand reads, so it must never
    // describe a loader that no longer exists. Run `npm run schema:update`
    // when this fails, and read the diff — the published schema changing is a
    // contract changing.
    expect(readFileSync(PUBLISHED, "utf8")).toBe(serialize(emitJsonSchema()));
  });

  it("hands out copies of its defaults, not the schema's own objects", () => {
    // Aliased, a caller editing the emitted document changed what
    // `loadCartridge` filled afterwards — and what the *next* emission
    // contained, which would make the lockstep test above depend on whatever
    // ran before it.
    const emitted = emitJsonSchema();
    const properties = emitted["properties"] as Record<
      string,
      Record<string, unknown>
    >;
    const story = properties["story"] as Record<string, unknown>;

    expect(story["default"]).not.toBe(CARTRIDGE_SCHEMA.fields["story"]?.fill);

    (story["default"] as Record<string, unknown>)["injected"] = true;
    expect(CARTRIDGE_SCHEMA.fields["story"]?.fill).toEqual({});
    expect(serialize(emitJsonSchema())).not.toContain("injected");
  });

  it("declares its version and identity", () => {
    const emitted = emitJsonSchema();
    expect(emitted["$id"]).toContain("cartridge.v0.json");
    expect(emitted["title"]).toContain(String(CARTRIDGE_SCHEMA_VERSION));
    expect(emitted["$schema"]).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
  });

  it("closes every object, so a typo is a rejection rather than a shrug", () => {
    function walk(node: unknown, path: string): void {
      if (typeof node !== "object" || node === null) return;
      const record = node as Record<string, unknown>;

      if (
        record["type"] === "object" &&
        typeof record["properties"] === "object"
      ) {
        expect(
          record["additionalProperties"],
          `${path} should be closed to unknown fields`,
        ).toBe(false);
      }
      for (const [key, value] of Object.entries(record)) {
        walk(value, `${path}/${key}`);
      }
    }

    walk(emitJsonSchema(), "");
  });

  it("says which issue tightens each unvalidated section", () => {
    // The gap is a decision, not an oversight — and a reader should be able to
    // see that without noticing an absence.
    const rendered = serialize(emitJsonSchema());
    for (const owner of ["issue #6", "issue #7", "issue #12", "Phase 4"]) {
      expect(rendered).toContain(owner);
    }
  });
});

describe("the descriptor tree", () => {
  it("declares the four archetypes and nothing else", () => {
    expect(ARCHETYPES).toEqual([
      "paranoid",
      "reckless",
      "superficial",
      "existential",
    ]);
  });

  it("gives every node a description, since the schema is the document", () => {
    const missing: string[] = [];

    function walk(node: SchemaNode, path: string): void {
      if (node.description.trim() === "") missing.push(path);
      switch (node.kind) {
        case "object":
          for (const [key, field] of Object.entries(node.fields)) {
            walk(field.node, `${path}/${key}`);
          }
          return;
        case "array":
          walk(node.items, `${path}/[]`);
          return;
        case "record":
          walk(node.values, `${path}/{}`);
          return;
        default:
          return;
      }
    }

    walk(CARTRIDGE_SCHEMA, "");
    expect(missing).toEqual([]);
  });

  it("gives every optional field something to normalize to", () => {
    // An optional field with neither a fill nor a derivation would be absent
    // in one loaded cartridge and present in another, and the two would not
    // serialize the same.
    const gaps: string[] = [];

    function walk(node: SchemaNode, path: string): void {
      if (node.kind === "object") {
        for (const [key, field] of Object.entries(node.fields)) {
          if (
            !field.required &&
            field.fill === undefined &&
            field.derived === undefined
          ) {
            gaps.push(`${path}/${key}`);
          }
          walk(field.node, `${path}/${key}`);
        }
        return;
      }
      if (node.kind === "array") walk(node.items, `${path}/[]`);
      if (node.kind === "record") walk(node.values, `${path}/{}`);
    }

    walk(CARTRIDGE_SCHEMA, "");
    expect(gaps).toEqual([]);
  });

  it("requires the fields a world cannot do without", () => {
    const meta = CARTRIDGE_SCHEMA.fields["meta"]?.node as ObjectNode;
    for (const key of [
      "schemaVersion",
      "number",
      "date",
      "title",
      "assignment",
      "startedAt",
    ]) {
      expect(meta.fields[key]?.required, `meta.${key}`).toBe(true);
    }

    for (const key of ["meta", "repository", "models"]) {
      expect(CARTRIDGE_SCHEMA.fields[key]?.required, key).toBe(true);
    }
  });
});
