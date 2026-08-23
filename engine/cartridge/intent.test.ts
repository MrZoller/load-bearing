import { describe, expect, it } from "vitest";

import incidentDocument from "../../content/incidents/incident-001.json";
import { selectAgentIntent } from "../agent/intent.js";
import { reduce } from "../events/reduce.js";
import { CartridgeValidationError, loadCartridge } from "./load.js";
import {
  keywordPatternIssue,
  matchesKeywordPattern,
  normalizeIntentPhrase,
} from "./intent.js";

describe("bounded cartridge intent patterns", () => {
  it("normalizes literal phrases and matches bounded keyword slots", () => {
    expect(normalizeIntentPhrase("  RESTORE\tThe   endpoint ")).toBe(
      "restore the endpoint",
    );
    expect(
      matchesKeywordPattern("restore {slot}", "restore the endpoint"),
    ).toBe(true);
    expect(
      matchesKeywordPattern(
        "investigate {slot} routing",
        "investigate the regional routing",
      ),
    ).toBe(true);
    expect(matchesKeywordPattern("restore {slot}", "restore")).toBe(false);
    expect(
      matchesKeywordPattern(
        "restore {slot}",
        `restore ${Array.from({ length: 13 }, () => "very").join(" ")}`,
      ),
    ).toBe(false);
  });

  it("rejects patterns that could turn authored content into unbounded parsing", () => {
    expect(keywordPatternIssue("{slot}")).toMatch(/literal keyword/);
    expect(keywordPatternIssue("fix {slot} {slot}")).toMatch(/adjacent/);
    expect(keywordPatternIssue("fix {target}")).toMatch(/\{slot\}/);
    expect(matchesKeywordPattern("fix {target}", "fix production")).toBe(false);
    expect(
      matchesKeywordPattern(
        "fix {slot}",
        Array.from({ length: 65 }, () => "word").join(" "),
      ),
    ).toBe(false);
  });

  it("rejects malformed keyword slots and incomplete closed family maps", () => {
    const source = JSON.parse(JSON.stringify(incidentDocument)) as Record<
      string,
      unknown
    >;
    const story = source["story"] as Record<string, unknown>;
    const intents = story["intents"] as Record<string, unknown>[];
    const first = intents[0];
    if (first === undefined) throw new Error("incident needs an intent");
    first["keywordPatterns"] = ["inspect {target}"];
    const phase2 = story["phase2"] as Record<string, unknown>;
    const generics = phase2["genericIntents"] as unknown[];
    generics.pop();

    try {
      loadCartridge(source);
      throw new Error("expected cartridge rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CartridgeValidationError);
      const issues = (error as CartridgeValidationError).issues;
      expect(issues.map((issue) => issue.pointer)).toEqual(
        expect.arrayContaining([
          "/story/intents/0/keywordPatterns/0",
          "/story/phase2/genericIntents",
        ]),
      );
    }
  });

  it("rejects incomplete misfire wiring and authored writes to habit counters", () => {
    const source = JSON.parse(JSON.stringify(incidentDocument)) as Record<
      string,
      unknown
    >;
    const story = source["story"] as Record<string, unknown>;
    const phase2 = story["phase2"] as Record<string, unknown>;
    phase2["genericIntents"] = [];
    const fallback = story["fallback"] as Record<string, unknown>;
    const candidates = fallback["candidates"] as Array<Record<string, unknown>>;
    const first = candidates[0];
    if (first === undefined) throw new Error("incident needs a fallback");
    const actions = first["actions"] as unknown[];
    actions.push({ kind: "counter-add", counter: "flail", amount: 1 });
    const beats = phase2["beats"] as Array<Record<string, unknown>>;
    const beat = beats[0];
    if (beat === undefined) throw new Error("incident needs a beat");
    beat["actions"] = [{ kind: "counter-add", counter: "flail", amount: 1 }];

    try {
      loadCartridge(source);
      throw new Error("expected cartridge rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CartridgeValidationError);
      expect(
        (error as CartridgeValidationError).issues.map(
          (issue) => issue.pointer,
        ),
      ).toEqual(
        expect.arrayContaining([
          "/story/fallback/candidates/0/actions/1/counter",
          "/story/phase2/beats/0/actions/0/counter",
          "/story/phase2/intentCounters/misfireEvery",
        ]),
      );
    }
  });

  it("selects the first condition-valid authored candidate", () => {
    const source = JSON.parse(JSON.stringify(incidentDocument)) as Record<
      string,
      unknown
    >;
    const story = source["story"] as Record<string, unknown>;
    const phase2 = story["phase2"] as Record<string, unknown>;
    const generics = phase2["genericIntents"] as Array<Record<string, unknown>>;
    const status = generics.find((entry) => entry["family"] === "status");
    if (status === undefined) throw new Error("incident needs status mapping");
    status["candidates"] = [
      {
        response: "generic-undo",
        when: [{ kind: "file-exists", path: "/missing", exists: true }],
      },
      { response: "generic-status" },
    ];
    const cartridge = loadCartridge(source);
    const state = reduce({ cartridge, seed: "candidate", events: [] });

    expect(selectAgentIntent(cartridge, state, "status please")).toMatchObject({
      responseId: "generic-status",
      family: "status",
    });
  });

  it("rejects generic actions that can bypass owner boundaries", () => {
    const source = JSON.parse(JSON.stringify(incidentDocument)) as Record<
      string,
      unknown
    >;
    const story = source["story"] as Record<string, unknown>;
    const phase2 = story["phase2"] as Record<string, unknown>;
    const generics = phase2["genericIntents"] as Array<Record<string, unknown>>;
    const undo = generics.find((entry) => entry["family"] === "undo");
    if (undo === undefined) throw new Error("incident needs undo mapping");
    const genericCandidates = undo["candidates"] as Array<
      Record<string, unknown>
    >;
    const generic = genericCandidates[0];
    if (generic === undefined)
      throw new Error("incident needs intent candidate");
    generic["actions"] = [{ kind: "shell-execute", input: "rm -rf /" }];

    expect(() => loadCartridge(source)).toThrow(
      /story\/phase2\/genericIntents\/0\/candidates\/0\/actions\/0\/kind/,
    );
  });

  it("rejects fallback actions that mutate before their selected beat", () => {
    const source = JSON.parse(JSON.stringify(incidentDocument)) as Record<
      string,
      unknown
    >;
    const story = source["story"] as Record<string, unknown>;
    const fallback = story["fallback"] as Record<string, unknown>;
    const candidates = fallback["candidates"] as Array<Record<string, unknown>>;
    const candidate = candidates[0];
    if (candidate === undefined)
      throw new Error("incident needs fallback candidate");
    candidate["actions"] = [
      {
        kind: "file-write",
        path: "/production/load-balancer/config/routes.conf",
        contents: "health_status=200\neurope_attached=false\n",
      },
      { kind: "story-reach", beat: "regional-coupling" },
    ];

    expect(() => loadCartridge(source)).toThrow(
      /story\/fallback\/candidates\/0\/actions\/1: expected a story-reach action before other candidate owner actions/,
    );
  });
});
