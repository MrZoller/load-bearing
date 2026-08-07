/**
 * Emit `content/schema/cartridge.v0.json` from the descriptor tree.
 *
 * The published schema is documentation with teeth: content tooling, the
 * Phase 5 pipeline, and anyone writing a cartridge by hand read it, and it is
 * the artifact that outlives this repository's internals. Emitting it means it
 * cannot describe a loader that no longer exists — a test compares the
 * committed file against this output and fails on any drift, the same contract
 * the golden replay fixtures have.
 *
 * `deferred` nodes emit as an object with no property constraints plus a
 * `description` naming who tightens them and when. A reader should be able to
 * see the gap without having to notice an absence.
 */

import { CARTRIDGE_SCHEMA, CARTRIDGE_SCHEMA_VERSION } from "./schema.js";
import type { Pattern, SchemaNode } from "./schema.js";

/** Where the emitted document says it lives. */
export const CARTRIDGE_SCHEMA_ID =
  "https://loadbearing.cc/schema/cartridge.v0.json";

/**
 * Render a regular expression as an ECMA-262 pattern string.
 *
 * JSON Schema `pattern` is unanchored by convention but takes the same syntax,
 * so the source's own anchors carry over. `source` is the spelling between the
 * slashes, which is exactly what belongs in the field.
 */
function patternSource(pattern: Pattern): string {
  return pattern.source;
}

function emitNode(node: SchemaNode): Record<string, unknown> {
  switch (node.kind) {
    case "string": {
      const out: Record<string, unknown> = {
        type: "string",
        description: node.description,
      };
      if (node.pattern !== undefined)
        out["pattern"] = patternSource(node.pattern);
      if (node.minLength !== undefined) out["minLength"] = node.minLength;
      if (node.maxLength !== undefined) out["maxLength"] = node.maxLength;
      if (node.refine !== undefined) {
        // The refinement is code, not schema. Saying so is better than a
        // reader concluding the pattern is the whole rule.
        out["$comment"] =
          "The loader applies a further check this pattern cannot express.";
      }
      return out;
    }

    case "integer":
      return node.minimum === node.maximum
        ? { const: node.minimum, description: node.description }
        : {
            type: "integer",
            description: node.description,
            minimum: node.minimum,
            maximum: node.maximum,
          };

    case "enum":
      return {
        type: "string",
        description: node.description,
        enum: [...node.values],
      };

    case "object": {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, field] of Object.entries(node.fields)) {
        const emitted = emitNode(field.node);
        if (field.fill !== undefined) emitted["default"] = field.fill;
        if (field.derived !== undefined) {
          // Appended, not assigned. `mtime` carries both a derived default and
          // a node-level refinement note, and overwriting would drop the one
          // saying the pattern is not the whole rule — which is the half a
          // reader needs in order to trust the other.
          const existing = emitted["$comment"];
          emitted["$comment"] =
            typeof existing === "string"
              ? `${existing} ${field.derived}`
              : field.derived;
        }
        properties[key] = emitted;
        if (field.required) required.push(key);
      }
      return {
        type: "object",
        description: node.description,
        // Rejected rather than ignored: an unknown key is nearly always a
        // typo, and a silently ignored one is a field its author believes is
        // in effect. `meta.schemaVersion` is what makes this safe.
        additionalProperties: false,
        properties,
        ...(required.length > 0 ? { required } : {}),
      };
    }

    case "array":
      return {
        type: "array",
        description: node.description,
        items: emitNode(node.items),
        ...(node.minItems !== undefined ? { minItems: node.minItems } : {}),
      };

    case "record":
      return {
        type: "object",
        description: node.description,
        propertyNames: {
          pattern: patternSource(node.keyPattern),
          description: `Each key is ${node.keyLabel}.`,
        },
        additionalProperties: emitNode(node.values),
      };

    case "deferred":
      return {
        type: "object",
        description: node.description,
        $comment: `Declared but not validated in schema v0. Tightened by: ${node.owner}. The gap is a decision, not an oversight.`,
      };
  }
}

/** The whole published document, ready for the canonical serializer. */
export function emitJsonSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: CARTRIDGE_SCHEMA_ID,
    title: `Load Bearing cartridge, schema version ${String(CARTRIDGE_SCHEMA_VERSION)}`,
    $comment:
      "Generated from engine/cartridge/schema.ts by `npm run schema:update`. Do not edit by hand: a test fails when this file and the loader disagree.",
    ...emitNode(CARTRIDGE_SCHEMA),
  };
}
