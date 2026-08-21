import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { serialize } from "../serialize/canonical.js";
import { INCIDENT_DATE_PATTERN, MODEL_ID_PATTERN } from "../random/seed.js";
import { emitJsonSchema } from "./jsonSchema.js";
import {
  ABSOLUTE_PATH_PATTERN,
  ARCHETYPES,
  CARTRIDGE_SCHEMA,
  CARTRIDGE_SCHEMA_VERSION,
} from "./schema.js";
import type {
  EnumNode,
  BooleanNode,
  IntegerNode,
  ObjectNode,
  SchemaNode,
  StringNode,
} from "./schema.js";
import type {
  CartridgeFile,
  CartridgeCommand,
  CartridgeEndpoint,
  CartridgeGitAuthor,
  CartridgeGitCommit,
  CartridgeGitFile,
  CartridgeGitHead,
  CartridgeGitHistory,
  CartridgeIdentity,
  CartridgeMeta,
  CartridgeModel,
  CartridgeLog,
  CartridgeManPage,
  CartridgeProcess,
  CartridgeRepository,
  CartridgeService,
  CartridgeSystem,
  CartridgeTicket,
  CartridgeTest,
} from "./types.js";

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

  it("keeps Git email Unicode semantics aligned with the loader", () => {
    const emitted = emitJsonSchema();
    const repository = (emitted["properties"] as Record<string, unknown>)[
      "repository"
    ] as Record<string, unknown>;
    const properties = repository["properties"] as Record<string, unknown>;
    const identity = properties["gitIdentity"] as Record<string, unknown>;
    const identityProperties = identity["properties"] as Record<
      string,
      unknown
    >;
    const email = identityProperties["email"] as Record<string, unknown>;
    const publishedPattern = new RegExp(email["pattern"] as string);

    expect(publishedPattern.test("visitor😀@example.test")).toBe(true);
    expect(publishedPattern.test("visitor\ud800@example.test")).toBe(false);
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
    for (const owner of ["Phase 4"]) {
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

  it("exports patterns a consumer cannot weaken", () => {
    // Freezing a RegExp was not enough. `Object.freeze` protects properties;
    // `RegExp.prototype.compile` mutates internal slots — in V8 it installs the
    // new matcher and only *then* fails writing the frozen `lastIndex`, so a
    // caller who catches that error is left holding a permanently different
    // pattern with no property changed. The regex is now private to a closure
    // and only `source` and `test` are exposed, so there is no `compile` to
    // reach.
    for (const [name, value] of [
      ["ABSOLUTE_PATH_PATTERN", ABSOLUTE_PATH_PATTERN],
      ["MODEL_ID_PATTERN", MODEL_ID_PATTERN],
      ["INCIDENT_DATE_PATTERN", INCIDENT_DATE_PATTERN],
    ] as const) {
      expect(Object.isFrozen(value), name).toBe(true);
      expect(
        (value as unknown as { compile?: unknown }).compile,
        `${name} must not expose compile`,
      ).toBeUndefined();
      expect(() => {
        (value as unknown as { test: unknown }).test = () => true;
      }, name).toThrow();
    }

    // And it still answers, unchanged, after both attempts.
    expect(MODEL_ID_PATTERN.test("deep-foundation")).toBe(true);
    expect(MODEL_ID_PATTERN.test("Deep Foundation")).toBe(false);
    expect(MODEL_ID_PATTERN.source).toContain("a-z0-9");
  });

  it("reaches no raw regular expression through the exported tree", () => {
    // The per-constant test above missed `TIMESTAMP`, whose pattern was
    // written inline rather than as an exported constant — reachable as
    // `CARTRIDGE_SCHEMA.fields.meta.node.fields.startedAt.node.pattern` and
    // therefore `compile`-able. Walking the tree is what makes this a property
    // of the schema rather than a list someone has to remember to extend.
    const raw: string[] = [];

    function walk(node: SchemaNode, path: string): void {
      const candidates =
        node.kind === "string"
          ? [["pattern", node.pattern] as const]
          : node.kind === "record"
            ? [["keyPattern", node.keyPattern] as const]
            : [];

      for (const [name, value] of candidates) {
        if (
          value !== undefined &&
          (value as unknown as { compile?: unknown }).compile !== undefined
        ) {
          raw.push(`${path}.${name}`);
        }
      }

      if (node.kind === "object") {
        for (const [key, field] of Object.entries(node.fields)) {
          walk(field.node, `${path}/${key}`);
        }
      }
      if (node.kind === "array") walk(node.items, `${path}/[]`);
      if (node.kind === "record") walk(node.values, `${path}/{}`);
      if (node.kind === "union")
        for (const [key, variant] of Object.entries(node.variants))
          walk(variant, `${path}/<${key}>`);
    }

    walk(CARTRIDGE_SCHEMA, "");
    expect(raw).toEqual([]);
  });

  it("is frozen, since it is the validation authority", () => {
    // `as const` is erased at runtime, so an exported array is an exported
    // *mutable* array: `ARCHETYPES.push("other")` would make `loadCartridge`
    // accept an archetype the exported `Archetype` type says does not exist,
    // and the next emission would publish it. Modules are strict mode, so a
    // write to a frozen object throws rather than passing silently.
    expect(Object.isFrozen(ARCHETYPES)).toBe(true);
    expect(() => (ARCHETYPES as unknown as string[]).push("other")).toThrow();

    // The whole tree, not just the enum — every node is validation authority.
    expect(Object.isFrozen(CARTRIDGE_SCHEMA)).toBe(true);
    expect(Object.isFrozen(CARTRIDGE_SCHEMA.fields)).toBe(true);
    const meta = CARTRIDGE_SCHEMA.fields["meta"]?.node as ObjectNode;
    expect(Object.isFrozen(meta.fields["title"])).toBe(true);
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
        case "union":
          for (const [key, variant] of Object.entries(node.variants))
            walk(variant, `${path}/<${key}>`);
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
      if (node.kind === "union")
        for (const [key, variant] of Object.entries(node.variants))
          walk(variant, `${path}/<${key}>`);
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

    const root: ObjectNode = CARTRIDGE_SCHEMA;
    for (const key of ["meta", "repository", "models"]) {
      expect(root.fields[key]?.required, key).toBe(true);
    }
  });
});

describe("descriptor and type lockstep", () => {
  /**
   * The node kind a declared TypeScript type demands.
   *
   * This is the piece the `as` casts in `load.ts` cannot supply. Those tie the
   * loader's output to `./types.ts`, and the walk ties the loader to
   * `./schema.ts` — but nothing tied a *leaf descriptor's kind* to the type
   * declared for that field, so changing `costMultiplier` from an integer node
   * to a string node compiled cleanly while `CartridgeModel` still promised a
   * number.
   *
   * Derived from the type rather than written out, so the assertions below
   * fail from either side: change the descriptor and the node no longer fits,
   * change the type and the expectation no longer matches it.
   */
  type NodeFor<T> = [T] extends [number]
    ? IntegerNode
    : [T] extends [boolean]
      ? BooleanNode
      : [T] extends [string]
        ? StringNode | EnumNode
        : never;

  /** Asserts at compile time; the runtime body is only here to name it. */
  function agrees<Declared>(_node: NodeFor<Declared>): void {}

  it("ties every leaf descriptor to the type declared for it", () => {
    const meta = CARTRIDGE_SCHEMA.fields.meta.node;
    agrees<CartridgeMeta["schemaVersion"]>(meta.fields.schemaVersion.node);
    agrees<CartridgeMeta["number"]>(meta.fields.number.node);
    agrees<CartridgeMeta["date"]>(meta.fields.date.node);
    agrees<CartridgeMeta["title"]>(meta.fields.title.node);
    agrees<CartridgeMeta["assignment"]>(meta.fields.assignment.node);
    agrees<CartridgeMeta["startedAt"]>(meta.fields.startedAt.node);

    const model = CARTRIDGE_SCHEMA.fields.models.node.items;
    agrees<CartridgeModel["id"]>(model.fields.id.node);
    agrees<CartridgeModel["name"]>(model.fields.name.node);
    agrees<CartridgeModel["archetype"]>(model.fields.archetype.node);
    agrees<CartridgeModel["description"]>(model.fields.description.node);
    agrees<CartridgeModel["costMultiplier"]>(model.fields.costMultiplier.node);
    agrees<CartridgeModel["quirks"][number]>(model.fields.quirks.node.items);

    const repository = CARTRIDGE_SCHEMA.fields.repository.node;
    agrees<CartridgeRepository["cwd"]>(repository.fields.cwd.node);
    const identity = repository.fields.identity.node;
    agrees<CartridgeIdentity["user"]>(identity.fields.user.node);
    agrees<CartridgeIdentity["group"]>(identity.fields.group.node);
    agrees<CartridgeIdentity["home"]>(identity.fields.home.node);
    agrees<CartridgeIdentity["umask"]>(identity.fields.umask.node);
    const gitIdentity = repository.fields.gitIdentity.node;
    agrees<CartridgeGitAuthor["name"]>(gitIdentity.fields.name.node);
    agrees<CartridgeGitAuthor["email"]>(gitIdentity.fields.email.node);
    const system = repository.fields.system.node;
    agrees<CartridgeSystem["hostname"]>(system.fields.hostname.node);
    agrees<CartridgeSystem["operatingSystem"]>(
      system.fields.operatingSystem.node,
    );
    agrees<CartridgeSystem["kernelRelease"]>(system.fields.kernelRelease.node);
    agrees<CartridgeSystem["architecture"]>(system.fields.architecture.node);
    agrees<CartridgeSystem["bootedAt"]>(system.fields.bootedAt.node);
    agrees<CartridgeRepository["env"][string]>(
      repository.fields.env.node.values,
    );
    const manPage = repository.fields.manPages.node.items;
    agrees<CartridgeManPage["name"]>(manPage.fields.name.node);
    agrees<CartridgeManPage["section"]>(manPage.fields.section.node);
    agrees<CartridgeManPage["contents"]>(manPage.fields.contents.node);
    agrees<CartridgeRepository["shellHistory"][number]>(
      repository.fields.shellHistory.node.items,
    );
    const command = repository.fields.commands.node.values;
    agrees<CartridgeCommand["stdout"][number]>(
      command.fields.stdout.node.items,
    );
    agrees<CartridgeCommand["stderr"][number]>(
      command.fields.stderr.node.items,
    );
    agrees<CartridgeCommand["exitCode"]>(command.fields.exitCode.node);
    const endpoint = repository.fields.endpoints.node.values;
    agrees<CartridgeEndpoint["service"]>(endpoint.fields.service.node);
    agrees<CartridgeEndpoint["running"]["exitCode"]>(
      endpoint.fields.running.node.fields.exitCode.node,
    );

    const proc = repository.fields.processes.node.items;
    agrees<CartridgeProcess["id"]>(proc.fields.id.node);
    agrees<CartridgeProcess["pid"]>(proc.fields.pid.node);
    agrees<CartridgeProcess["user"]>(proc.fields.user.node);
    agrees<CartridgeProcess["startedAt"]>(proc.fields.startedAt.node);
    agrees<CartridgeProcess["state"]>(proc.fields.state.node);
    agrees<CartridgeProcess["command"]["binary"]>(
      proc.fields.command.node.fields.binary.node,
    );
    agrees<CartridgeProcess["command"]["args"][number]>(
      proc.fields.command.node.fields.args.node.items,
    );
    const service = repository.fields.services.node.items;
    agrees<CartridgeService["id"]>(service.fields.id.node);
    agrees<CartridgeService["state"]>(service.fields.state.node);
    agrees<CartridgeService["health"]>(service.fields.health.node);
    agrees<CartridgeService["ports"][number]>(service.fields.ports.node.items);
    agrees<CartridgeService["dependencies"][number]>(
      service.fields.dependencies.node.items,
    );
    const log = repository.fields.logs.node.items;
    agrees<CartridgeLog["id"]>(log.fields.id.node);
    agrees<CartridgeLog["kind"]>(log.fields.kind.node);
    agrees<CartridgeLog["path"]>(log.fields.path.node);
    agrees<CartridgeLog["entries"][number]>(log.fields.entries.node.items);
    const ticket = repository.fields.tickets.node.items;
    agrees<CartridgeTicket["id"]>(ticket.fields.id.node);
    agrees<CartridgeTicket["status"]>(ticket.fields.status.node);
    agrees<CartridgeTicket["title"]>(ticket.fields.title.node);
    agrees<CartridgeTicket["body"]>(ticket.fields.body.node);
    agrees<CartridgeTicket["service"]>(ticket.fields.service.node);
    const test = repository.fields.tests.node.items;
    agrees<CartridgeTest["id"]>(test.fields.id.node);
    agrees<CartridgeTest["name"]>(test.fields.name.node);
    agrees<CartridgeTest["durationMs"]>(test.fields.durationMs.node);

    const history = repository.fields.gitHistory.node;
    const commit = history.fields.commits.node.items;
    agrees<CartridgeGitCommit["id"]>(commit.fields.id.node);
    agrees<CartridgeGitCommit["parents"][number]>(
      commit.fields.parents.node.items,
    );
    agrees<CartridgeGitCommit["message"]>(commit.fields.message.node);
    agrees<CartridgeGitCommit["committedAt"]>(commit.fields.committedAt.node);
    agrees<CartridgeGitAuthor["name"]>(
      commit.fields.author.node.fields.name.node,
    );
    agrees<CartridgeGitAuthor["email"]>(
      commit.fields.author.node.fields.email.node,
    );
    agrees<CartridgeGitFile["contents"]>(
      commit.fields.files.node.values.fields.contents.node,
    );
    agrees<CartridgeGitFile["blame"][number]>(
      commit.fields.files.node.values.fields.blame.node.items,
    );
    agrees<CartridgeGitHistory["branches"][string]>(
      history.fields.branches.node.values,
    );
    agrees<CartridgeGitHead["kind"]>(history.fields.head.node.fields.kind.node);
    agrees<CartridgeGitHead["target"]>(
      history.fields.head.node.fields.target.node,
    );

    const file = repository.fields.files.node.values;
    agrees<CartridgeFile["contents"]>(file.fields.contents.node);
    agrees<CartridgeFile["mode"]>(file.fields.mode.node);
    agrees<CartridgeFile["owner"]>(file.fields.owner.node);
    agrees<CartridgeFile["group"]>(file.fields.group.node);
    agrees<CartridgeFile["mtime"]>(file.fields.mtime.node);

    // Nothing to assert at runtime: the point is that this file compiles.
    expect(true).toBe(true);
  });
});
