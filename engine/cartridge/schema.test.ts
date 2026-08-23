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
  MAX_STORY_ACTIONS,
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
  CartridgeAuthoredResponse,
  CartridgeIntent,
  CartridgeMetricParameters,
  CartridgePlaceholder,
  CartridgeSpinnerPool,
  CartridgeStory,
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
    const storyProperties = story["properties"] as Record<
      string,
      Record<string, unknown>
    >;
    const phase2 = storyProperties["phase2"] as Record<string, unknown>;

    expect(phase2["default"]).not.toBe(
      CARTRIDGE_SCHEMA.fields.story.node.fields.phase2.fill,
    );

    (phase2["default"] as Record<string, unknown>)["injected"] = true;
    expect(CARTRIDGE_SCHEMA.fields.story.node.fields.phase2.fill).toEqual({
      initialBeat: "start",
      counters: [],
      facts: [],
      rareEvents: [],
      beats: [
        {
          id: "start",
          ending: "",
          facts: [],
          actions: [],
          variants: [],
        },
      ],
      routes: [],
      handoffs: [],
      endings: [],
      transitions: [],
      genericIntents: [],
      intentCounters: { flail: "", capitulation: "", misfireEvery: 0 },
    });
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

  it("requires positive weighted spinner verbs in both descriptor and published contracts", () => {
    const descriptor =
      CARTRIDGE_SCHEMA.fields.presentation.node.fields.spinnerPools.node.items
        .fields.verbs.node.items.fields;
    const emitted = emitJsonSchema()["properties"] as Record<string, unknown>;
    const presentation = emitted["presentation"] as Record<string, unknown>;
    const presentationProperties = presentation["properties"] as Record<
      string,
      unknown
    >;
    const pools = presentationProperties["spinnerPools"] as Record<
      string,
      unknown
    >;
    const pool = pools["items"] as Record<string, unknown>;
    const poolProperties = pool["properties"] as Record<string, unknown>;
    const verbs = poolProperties["verbs"] as Record<string, unknown>;
    const emittedEntry = verbs["items"] as Record<string, unknown>;
    const emittedEntryProperties = emittedEntry["properties"] as Record<
      string,
      unknown
    >;
    const published = JSON.parse(readFileSync(PUBLISHED, "utf8")) as Record<
      string,
      unknown
    >;
    const publishedPresentation = (
      published["properties"] as Record<string, unknown>
    )["presentation"] as Record<string, unknown>;
    const publishedPools = (
      publishedPresentation["properties"] as Record<string, unknown>
    )["spinnerPools"] as Record<string, unknown>;
    const publishedPool = publishedPools["items"] as Record<string, unknown>;
    const publishedVerbs = (
      publishedPool["properties"] as Record<string, unknown>
    )["verbs"] as Record<string, unknown>;
    const publishedEntry = publishedVerbs["items"] as Record<string, unknown>;
    const publishedEntryProperties = publishedEntry["properties"] as Record<
      string,
      unknown
    >;

    expect(descriptor.verb.node).toMatchObject({
      minLength: 1,
      maxLength: 240,
    });
    expect(descriptor.weight.node).toMatchObject({ minimum: 1 });
    expect(emittedEntryProperties["verb"]).toMatchObject({
      minLength: 1,
      maxLength: 240,
    });
    expect(emittedEntryProperties["weight"]).toMatchObject({ minimum: 1 });
    expect(publishedEntryProperties["verb"]).toMatchObject({
      minLength: 1,
      maxLength: 240,
    });
    expect(publishedEntryProperties["weight"]).toMatchObject({ minimum: 1 });
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
    expect(publishedPattern.test("visitor\udc00@example.test")).toBe(false);
  });

  it("publishes a closed, bounded permission-request action variant", () => {
    const root = emitJsonSchema()["properties"] as Record<string, unknown>;
    const story = root["story"] as Record<string, unknown>;
    const storyProperties = story["properties"] as Record<string, unknown>;
    const fallback = storyProperties["fallback"] as Record<string, unknown>;
    const fallbackProperties = fallback["properties"] as Record<
      string,
      unknown
    >;
    const actions = fallbackProperties["actions"] as Record<string, unknown>;
    const items = actions["items"] as Record<string, unknown>;
    const variants = items["oneOf"] as Record<string, unknown>[];
    const permission = variants.find((variant) => {
      const properties = variant["properties"] as Record<string, unknown>;
      const kind = properties["kind"] as Record<string, unknown>;
      return (kind["enum"] as unknown[]).includes("permission-request");
    });

    expect(permission).toMatchObject({
      additionalProperties: false,
      required: ["kind", "id", "capability", "grant", "deny", "alwaysAllow"],
    });
    const properties = permission?.["properties"] as Record<string, unknown>;
    expect(properties["grant"]).toMatchObject({
      type: "array",
      maxItems: MAX_STORY_ACTIONS,
    });
    expect(properties["deny"]).toMatchObject({ maxItems: MAX_STORY_ACTIONS });
    expect(properties["alwaysAllow"]).toMatchObject({
      maxItems: MAX_STORY_ACTIONS,
    });
    const waiver = variants.find((variant) => {
      const candidate = variant["properties"] as Record<string, unknown>;
      const kind = candidate["kind"] as Record<string, unknown>;
      return (kind["enum"] as unknown[]).includes("waiver-request");
    });
    expect(waiver).toMatchObject({
      additionalProperties: false,
      required: [
        "kind",
        "id",
        "version",
        "requiredPhrase",
        "capability",
        "documentPath",
        "documentContents",
        "consent",
        "denial",
      ],
    });
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

  it("publishes one closed bounded story graph with facts and sparse condition variants", () => {
    const root = emitJsonSchema()["properties"] as Record<string, unknown>;
    const story = root["story"] as Record<string, unknown>;
    const storyPhase2 = (story["properties"] as Record<string, unknown>)[
      "phase2"
    ] as Record<string, unknown>;
    const storyProperties = storyPhase2["properties"] as Record<
      string,
      unknown
    >;
    const facts = storyProperties["facts"] as Record<string, unknown>;
    const fact = facts["items"] as Record<string, unknown>;
    const factProperties = fact["properties"] as Record<string, unknown>;
    const beats = storyProperties["beats"] as Record<string, unknown>;
    const endings = storyProperties["endings"] as Record<string, unknown>;
    const transitions = storyProperties["transitions"] as Record<
      string,
      unknown
    >;
    const transition = transitions["items"] as Record<string, unknown>;
    const transitionProperties = transition["properties"] as Record<
      string,
      unknown
    >;
    const triggerKinds = (
      (transitionProperties["trigger"] as Record<string, unknown>)[
        "oneOf"
      ] as Record<string, unknown>[]
    ).map((trigger) => {
      const properties = trigger["properties"] as Record<string, unknown>;
      return (
        (properties["kind"] as Record<string, unknown>)["enum"] as string[]
      )[0];
    });
    const beat = beats["items"] as Record<string, unknown>;
    const beatProperties = beat["properties"] as Record<string, unknown>;
    const variants = beatProperties["variants"] as Record<string, unknown>;
    const variant = variants["items"] as Record<string, unknown>;
    const variantProperties = variant["properties"] as Record<string, unknown>;
    const when = variantProperties["when"] as Record<string, unknown>;
    const conditions = (when["items"] as Record<string, unknown>)[
      "oneOf"
    ] as Record<string, unknown>[];
    const conditionKinds = conditions.map((condition) => {
      const properties = condition["properties"] as Record<string, unknown>;
      return (
        (properties["kind"] as Record<string, unknown>)["enum"] as string[]
      )[0];
    });
    const presentation = root["presentation"] as Record<string, unknown>;
    const presentationPhase2 = (
      presentation["properties"] as Record<string, unknown>
    )["phase2"] as Record<string, unknown>;
    const statusCurves = (
      presentationPhase2["properties"] as Record<string, unknown>
    )["statusCurves"] as Record<string, unknown>;
    const models = root["models"] as Record<string, unknown>;
    const model = models["items"] as Record<string, unknown>;
    const modelProperties = model["properties"] as Record<string, unknown>;

    expect(storyPhase2).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["initialBeat", "beats", "endings"],
    });
    expect(facts).toMatchObject({ maxItems: 256, default: [] });
    expect(fact).toMatchObject({
      additionalProperties: false,
      required: ["id", "kind"],
    });
    expect(factProperties["kind"]).toMatchObject({
      enum: ["reveal", "callback"],
    });
    expect(beats).toMatchObject({ minItems: 1, maxItems: 128 });
    expect(beat).toMatchObject({
      additionalProperties: false,
      required: ["id", "ending"],
    });
    expect(beatProperties["facts"]).toMatchObject({
      maxItems: 16,
      default: [],
    });
    expect(variants).toMatchObject({ maxItems: 16, default: [] });
    expect(variant).toMatchObject({
      additionalProperties: false,
      required: ["id", "when", "ending"],
    });
    expect(when).toMatchObject({ minItems: 1, maxItems: 16 });
    expect(variantProperties["facts"]).toMatchObject({
      maxItems: 16,
      default: [],
    });
    expect(conditionKinds).toEqual([
      "file-exists",
      "file-contents",
      "service-state",
      "service-health",
      "belief",
      "belief-divergence",
      "waiver-consent",
      "story-fact",
      "story-counter",
    ]);
    expect(endings).toMatchObject({ maxItems: 32 });
    expect(transitions).toMatchObject({ maxItems: 64, default: [] });
    expect(transition).toMatchObject({
      additionalProperties: false,
      required: ["from", "to", "trigger"],
    });
    expect(triggerKinds).toEqual([
      "command",
      "reveal",
      "model",
      "permission",
      "compact",
    ]);
    expect(models).toMatchObject({ maxItems: 12 });
    expect(model).toMatchObject({ additionalProperties: false });
    expect(modelProperties).not.toHaveProperty("storyGraph");
    expect(presentationPhase2).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["statusCurves"],
    });
    expect(statusCurves).toMatchObject({ maxItems: 64 });
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

    const story = CARTRIDGE_SCHEMA.fields.story.node;
    agrees<CartridgeAuthoredResponse["id"]>(
      story.fields.responses.node.items.fields.id.node,
    );
    agrees<CartridgeAuthoredResponse["text"]>(
      story.fields.responses.node.items.fields.text.node,
    );
    agrees<CartridgeIntent["id"]>(
      story.fields.intents.node.items.fields.id.node,
    );
    agrees<CartridgeIntent["response"]>(
      story.fields.intents.node.items.fields.response.node,
    );
    agrees<CartridgeIntent["authorizedResponse"]>(
      story.fields.intents.node.items.fields.authorizedResponse.node,
    );
    agrees<CartridgeStory["fallback"]["authorizedResponse"]>(
      story.fields.fallback.node.fields.authorizedResponse.node,
    );
    agrees<CartridgeIntent["patterns"][number]>(
      story.fields.intents.node.items.fields.patterns.node.items,
    );

    const presentation = CARTRIDGE_SCHEMA.fields.presentation.node;
    agrees<CartridgePlaceholder["stage"]>(
      presentation.fields.placeholders.node.items.fields.stage.node,
    );
    agrees<CartridgePlaceholder["text"]>(
      presentation.fields.placeholders.node.items.fields.text.node,
    );
    agrees<CartridgeSpinnerPool["archetype"]>(
      presentation.fields.spinnerPools.node.items.fields.archetype.node,
    );
    agrees<CartridgeSpinnerPool["stage"]>(
      presentation.fields.spinnerPools.node.items.fields.stage.node,
    );
    agrees<CartridgeSpinnerPool["verbs"][number]["verb"]>(
      presentation.fields.spinnerPools.node.items.fields.verbs.node.items.fields
        .verb.node,
    );
    agrees<CartridgeSpinnerPool["verbs"][number]["weight"]>(
      presentation.fields.spinnerPools.node.items.fields.verbs.node.items.fields
        .weight.node,
    );
    agrees<CartridgeSpinnerPool["suffix"]>(
      presentation.fields.spinnerPools.node.items.fields.suffix.node,
    );
    const metrics = presentation.fields.metrics.node;
    agrees<CartridgeMetricParameters["baseTokens"]>(
      metrics.fields.baseTokens.node,
    );
    agrees<CartridgeMetricParameters["tokensPerEvent"]>(
      metrics.fields.tokensPerEvent.node,
    );
    agrees<CartridgeMetricParameters["contextWindowTokens"]>(
      metrics.fields.contextWindowTokens.node,
    );
    agrees<CartridgeMetricParameters["costMicrosPerToken"]>(
      metrics.fields.costMicrosPerToken.node,
    );
    agrees<CartridgeMetricParameters["integrityStart"]>(
      metrics.fields.integrityStart.node,
    );
    agrees<CartridgeMetricParameters["integrityLossPerEvent"]>(
      metrics.fields.integrityLossPerEvent.node,
    );

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
