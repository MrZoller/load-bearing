import { describe, expect, it } from "vitest";

import { createAgentInputEvents } from "../agent/intent.js";
import { createAgentCompactEvents } from "../agent/awareness.js";
import { readAgentSlice } from "../agent/agent.js";
import { loadCartridge } from "../cartridge/load.js";
import { reduce, step } from "../events/reduce.js";
import type { SessionState } from "../events/state.js";
import { createMindBeliefEvent } from "../mind/module.js";
import { readMindSlice } from "../mind/mind.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
import {
  createTerminalModelEvent,
  createTerminalModelTransitionEvent,
} from "../terminal/module.js";
import { readStorySlice } from "./story.js";
import { createStoryBeatReachedEvent } from "./module.js";
import { storyConditionMatches } from "./conditions.js";
import {
  routeCompact,
  routeModelHandoff,
  routeStoryResponse,
} from "./router.js";

const SEED = "2026-08-23/36/sparse-personas";

function cartridge() {
  const source = loadCartridgeFixture("minimal") as Record<string, unknown>;
  source["models"] = [
    ["deep-foundation", "paranoid"],
    ["temporary-shoring", "reckless"],
    ["drywall", "superficial"],
    ["cantilever", "existential"],
    ["paranoid-stage", "paranoid"],
  ].map(([id, archetype]) => ({
    id,
    name: id,
    archetype,
    description: `${id} is distinct.`,
    costMultiplier: 1,
  }));
  const presentation = source["presentation"] as Record<string, unknown>;
  presentation["spinnerPools"] = [
    "paranoid",
    "reckless",
    "superficial",
    "existential",
  ].map((archetype) => ({ archetype, stage: 0, verbs: ["Checking"] }));
  presentation["phase2"] = {
    statusCurves: [
      "deep-foundation",
      "temporary-shoring",
      "drywall",
      "cantilever",
      "paranoid-stage",
    ].flatMap((model) =>
      [0, 1, 2, 3, 4].map((stage) => ({
        model,
        stage,
        tokens: String(stage),
        cost: "$0",
        context: "0%",
        structuralIntegrity: "100",
        notOkayRatio: "0",
      })),
    ),
  };
  const story = source["story"] as Record<string, unknown>;
  story["responses"] = [
    "default",
    "first",
    "second",
    "paranoid",
    "reckless",
    "superficial",
    "existential",
    "divergent",
    ...["paranoid", "reckless", "superficial", "existential"].flatMap(
      (predecessor) =>
        ["paranoid", "reckless", "superficial", "existential"]
          .filter((successor) => successor !== predecessor)
          .flatMap((successor) => [
            `handoff-${predecessor}-${successor}`,
            `addition-${predecessor}-${successor}`,
          ]),
    ),
  ].map((id) => ({ id, text: `${id} response.` }));
  story["opening"] = {
    login: ["Fixture login."],
    response: "default",
    beliefs: [],
  };
  story["intents"] = [
    {
      id: "inspect",
      patterns: ["inspect"],
      response: "default",
      actions: [{ kind: "story-reach", beat: "shared" }],
    },
  ];
  story["fallback"] = { response: "default" };
  story["helpResponse"] = "default";
  story["compact"] = {
    response: "default",
    summary: "Default.",
    beliefs: [],
    archetypes: ["paranoid", "reckless", "superficial", "existential"].map(
      (archetype) => ({
        archetype,
        response: archetype,
        summary: `${archetype} compact.`,
        beliefs: [{ kind: "file-exists", path: "/etc/motd", exists: false }],
      }),
    ),
  };
  story["resume"] = {
    unchangedResponse: "default",
    changedResponse: "default",
  };
  story["phase2"] = {
    initialBeat: "shared",
    facts: [],
    beats: [
      {
        id: "shared",
        ending: "retained-ending",
        facts: [],
        actions: [],
        variants: [],
      },
    ],
    routes: [
      {
        id: "divergent",
        beat: "shared",
        response: "divergent",
        when: [
          {
            kind: "belief-divergence",
            belief: { kind: "file-exists", path: "/etc/motd", exists: false },
          },
        ],
      },
      {
        id: "all-selectors",
        beat: "shared",
        response: "paranoid",
        archetype: "paranoid",
        stage: 1,
        when: [
          { kind: "file-exists", path: "/etc/motd", exists: true },
          {
            kind: "belief",
            belief: { kind: "file-exists", path: "/etc/motd", exists: true },
          },
        ],
      },
      { id: "first", beat: "shared", response: "first", archetype: "paranoid" },
      {
        id: "second",
        beat: "shared",
        response: "second",
        archetype: "paranoid",
      },
      {
        id: "reckless",
        beat: "shared",
        response: "reckless",
        archetype: "reckless",
      },
      {
        id: "superficial",
        beat: "shared",
        response: "superficial",
        archetype: "superficial",
      },
      {
        id: "existential",
        beat: "shared",
        response: "existential",
        archetype: "existential",
      },
    ],
    endings: [{ id: "retained-ending", name: "Retained ending" }],
    transitions: [
      { from: 0, to: 1, trigger: { kind: "model", model: "paranoid-stage" } },
    ],
    handoffs: ["paranoid", "reckless", "superficial", "existential"].flatMap(
      (predecessor, predecessorIndex) =>
        ["paranoid", "reckless", "superficial", "existential"]
          .filter((successor) => successor !== predecessor)
          .map((successor, successorIndex) => ({
            predecessor,
            successor,
            response: `handoff-${predecessor}-${successor}`,
            additionResponse:
              (predecessorIndex + successorIndex) % 2 === 0
                ? `addition-${predecessor}-${successor}`
                : "",
          })),
    ),
  };
  return loadCartridge(source);
}

const CARTRIDGE = cartridge();

function state(): SessionState {
  return reduce({ cartridge: CARTRIDGE, seed: SEED, events: [] });
}

describe("sparse shared-beat routing", () => {
  it("routes all twelve ordered archetype pairs directionally, with optional incident additions", () => {
    const models = [
      ["deep-foundation", "paranoid"],
      ["temporary-shoring", "reckless"],
      ["drywall", "superficial"],
      ["cantilever", "existential"],
    ] as const;

    const routes = models.flatMap(
      ([predecessor, predecessorArchetype], index) =>
        models
          .filter(([successor]) => successor !== predecessor)
          .map(([successor, successorArchetype], successorIndex) => {
            const selected = routeModelHandoff(
              CARTRIDGE,
              step(state(), createTerminalModelEvent(predecessor)),
              successor,
            );
            return {
              predecessor: selected.predecessor,
              successor: selected.successor,
              responseId: selected.responseId,
              additionResponseId: selected.additionResponseId,
              expectedAddition:
                (index + successorIndex) % 2 === 0
                  ? `addition-${predecessorArchetype}-${successorArchetype}`
                  : "",
            };
          }),
    );

    expect(routes).toHaveLength(12);
    expect(routes).toEqual(
      expect.arrayContaining(
        models.flatMap(([predecessor, predecessorArchetype]) =>
          models
            .filter(([successor]) => successor !== predecessor)
            .map(([successor, successorArchetype]) =>
              expect.objectContaining({
                predecessor,
                successor,
                responseId: `handoff-${predecessorArchetype}-${successorArchetype}`,
              }),
            ),
        ),
      ),
    );
    expect(
      routes.map(
        ({ additionResponseId, expectedAddition }) => additionResponseId,
      ),
    ).toEqual(routes.map(({ expectedAddition }) => expectedAddition));
  });

  it("preserves every non-terminal slice and only advances an already-authored model stage", () => {
    let before = step(state(), createTerminalModelEvent("deep-foundation"));
    before = step(before, createStoryBeatReachedEvent("shared"));
    before = step(
      before,
      createMindBeliefEvent({
        kind: "file-exists",
        path: "/etc/motd",
        exists: false,
      }),
    );
    const after = step(
      before,
      createTerminalModelTransitionEvent("deep-foundation", "paranoid-stage"),
    );

    expect(after.seed).toBe(before.seed);
    expect(after.random).toEqual(before.random);
    expect(after.slices["vfs"]).toEqual(before.slices["vfs"]);
    expect(after.slices["world"]).toEqual(before.slices["world"]);
    expect(after.slices["git"]).toEqual(before.slices["git"]);
    expect(readMindSlice(after)).toEqual(readMindSlice(before));
    expect(readStorySlice(after)).toEqual({
      ...readStorySlice(before),
      stage: 1,
    });
    expect(readStorySlice(after).discoveredEndings).toEqual([
      "retained-ending",
    ]);
  });
  it("falls back to the intent response and retains the shared beat when no override matches", () => {
    const selected = routeStoryResponse(CARTRIDGE, state(), "other", "default");

    expect(selected).toEqual({ responseId: "default", routeId: "" });
    expect(readStorySlice(state()).currentBeat).toBe("shared");
  });

  it("requires archetype, stage, and every condition together, then keeps first authored match", () => {
    let selected = routeStoryResponse(CARTRIDGE, state(), "shared", "default");
    expect(selected).toEqual({ responseId: "first", routeId: "first" });

    let staged = step(state(), createTerminalModelEvent("paranoid-stage"));
    selected = routeStoryResponse(CARTRIDGE, staged, "shared", "default");
    expect(selected).toEqual({ responseId: "first", routeId: "first" });

    staged = step(
      staged,
      createMindBeliefEvent({
        kind: "file-exists",
        path: "/etc/motd",
        exists: true,
      }),
    );
    // Every selector now matches, so the earlier fully-specific route wins.
    expect(routeStoryResponse(CARTRIDGE, staged, "shared", "default")).toEqual({
      responseId: "paranoid",
      routeId: "all-selectors",
    });
  });

  it("selects four distinct responses for one seed and input while preserving the shared beat id", () => {
    const outcomes = (
      [
        ["deep-foundation", "first"],
        ["temporary-shoring", "reckless"],
        ["drywall", "superficial"],
        ["cantilever", "existential"],
      ] as const
    ).map(([model]) => {
      const before = step(state(), createTerminalModelEvent(model));
      const events = createAgentInputEvents(CARTRIDGE, before, "inspect");
      const after = reduce({
        cartridge: CARTRIDGE,
        seed: SEED,
        events: [createTerminalModelEvent(model), ...events],
      });
      return {
        responseId: readAgentSlice(after).responses.at(-1)?.responseId,
        beat: readStorySlice(after).currentBeat,
      };
    });

    expect(outcomes).toEqual([
      { responseId: "first", beat: "shared" },
      { responseId: "reckless", beat: "shared" },
      { responseId: "superficial", beat: "shared" },
      { responseId: "existential", beat: "shared" },
    ]);
  });

  it("uses each compact override, replaces beliefs wholesale, preserves machine truth, and routes exact divergence", () => {
    for (const [model, archetype] of [
      ["deep-foundation", "paranoid"],
      ["temporary-shoring", "reckless"],
      ["drywall", "superficial"],
      ["cantilever", "existential"],
    ] as const) {
      const active = step(state(), createTerminalModelEvent(model));
      expect(routeCompact(CARTRIDGE, active).summary).toBe(
        `${archetype} compact.`,
      );
    }

    const before = state();
    const compacted = createAgentCompactEvents(CARTRIDGE, before).reduce(
      (next, event) => step(next, event),
      before,
    );
    expect(readMindSlice(compacted).beliefs).toEqual([
      { kind: "file-exists", path: "/etc/motd", exists: false },
    ]);
    expect(
      storyConditionMatches(compacted, {
        kind: "file-exists",
        path: "/etc/motd",
        exists: true,
      }),
    ).toBe(true);
    expect(
      routeStoryResponse(CARTRIDGE, compacted, "shared", "default"),
    ).toEqual({
      responseId: "divergent",
      routeId: "divergent",
    });
  });
});
