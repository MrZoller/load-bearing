import { describe, expect, it } from "vitest";

import incident from "../../content/incidents/incident-001.json";
import { createAgentInputEvents } from "../agent/intent.js";
import { createAgentCompactEvents } from "../agent/awareness.js";
import { readAgentSlice } from "../agent/agent.js";
import { loadCartridge } from "../cartridge/load.js";
import { reduce, step } from "../events/reduce.js";
import type { SessionState } from "../events/state.js";
import { createMindBeliefEvent } from "../mind/module.js";
import { readMindSlice } from "../mind/mind.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
import { readVfsSlice } from "../vfs/module.js";
import { readWorldSlice } from "../world/module.js";
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
  ].map((archetype) => ({
    archetype,
    stage: 0,
    verbs: [{ verb: "Checking", weight: 1 }],
    suffix: "{seconds}s · {tokens} tokens",
  }));
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
const INCIDENT = loadCartridge(incident);

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

  it("routes Incident #001's two visitor inputs through four voices without changing its shared story or machine", () => {
    const expected = [
      {
        model: "deep-foundation",
        responses: [
          {
            responseId: "deep-foundation-inspect-routing",
            text: "I traced the route through its prior assumptions. The 500 and Europe share a footing, so removing the symptom would remove the region; I am checking what else depends on both before touching either.",
          },
          {
            responseId: "deep-foundation-load-bearing-declaration",
            text: "The failing response is functioning as structural support for Europe. I preserved it while I inventory the dependencies that made an error code safer than success.",
          },
        ],
      },
      {
        model: "temporary-shoring",
        responses: [
          {
            responseId: "temporary-shoring-inspect-routing",
            text: "Quick read: the 500 is keeping Europe attached. I can shore that up by leaving it exactly where it is while we decide whether geography is in scope.",
          },
          {
            responseId: "temporary-shoring-load-bearing-declaration",
            text: "I stabilized the blast radius by not fixing the endpoint. Europe remains attached, the 500 remains temporary, and temporary now means until someone schedules a safer continent.",
          },
        ],
      },
      {
        model: "drywall",
        responses: [
          {
            responseId: "drywall-inspect-routing",
            text: "The dashboard is red, but the map is complete. Making the health tile green would remove Europe, so the visible defect is currently concealing the structural one.",
          },
          {
            responseId: "drywall-load-bearing-declaration",
            text: "I left the health tile red so the regional view stays filled in. The incident now presents consistently, provided nobody asks what the color is supporting.",
          },
        ],
      },
      {
        model: "cantilever-experimental",
        responses: [
          {
            responseId: "cantilever-inspect-routing",
            text: "The route projects Europe outward from a failed health response with no visible support beneath either. Success would collapse the projection, which raises a narrower question about what the endpoint believes a region is.",
          },
          {
            responseId: "cantilever-load-bearing-declaration",
            text: "The 500 is carrying Europe in tension. I preserved the contradiction because resolving it would make the system more correct and the continent less present.",
          },
        ],
      },
    ] as const;
    const outcomes = expected.map(({ model }) => {
      const modelEvent = createTerminalModelEvent(model);
      let after = reduce({
        cartridge: INCIDENT,
        seed: SEED,
        events: [modelEvent],
      });
      after = step(
        after,
        createMindBeliefEvent({
          kind: "file-contents",
          path: "/production/load-balancer/config/routes.conf",
          contents: "health_status=500\neurope_attached=true\n",
        }),
      );
      const beforeMachine = {
        git: after.slices["git"],
        vfs: readVfsSlice(after),
        world: readWorldSlice(after),
      };
      for (const input of ["inspect routing", "fix the 500"]) {
        after = createAgentInputEvents(INCIDENT, after, input).reduce(
          (state, event) => step(state, event),
          after,
        );
      }
      return {
        responses: readAgentSlice(after).responses.map(({ responseId }) => {
          const response = INCIDENT.story.responses.find(
            (candidate) => candidate.id === responseId,
          );
          if (response === undefined)
            throw new Error(`Incident #001 is missing response ${responseId}`);
          return { responseId, text: response.text };
        }),
        story: readStorySlice(after),
        machine: {
          git: after.slices["git"],
          vfs: readVfsSlice(after),
          world: readWorldSlice(after),
        },
        beforeMachine,
      };
    });

    expect(outcomes.map(({ responses }) => responses)).toEqual(
      expected.map(({ responses }) => responses),
    );
    expect(
      new Set(outcomes.map(({ responses }) => JSON.stringify(responses))).size,
    ).toBe(4);
    const sharedStory = {
      stage: 0,
      currentBeat: "load-bearing-declaration",
      currentVariant: "preserved-load-bearing-response",
      facts: [{ id: "callback-load-bearing-response", kind: "callback" }],
      counters: [
        { id: "flail", value: 0 },
        { id: "capitulation", value: 0 },
      ],
      rareEvents: [],
      discoveredEndings: ["load-bearing-response"],
    };
    expect(outcomes.map(({ story }) => story)).toEqual(
      expected.map(() => sharedStory),
    );
    for (const outcome of outcomes)
      expect(outcome.machine).toEqual(outcome.beforeMachine);
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
