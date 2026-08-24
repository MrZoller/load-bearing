import { describe, expect, it } from "vitest";

import cartridgeDocument from "../../content/incidents/phase-1-demo.json";
import incident from "../../content/incidents/incident-001.json";
import { loadCartridge } from "../cartridge/load.js";
import { createShellExecuteEvent } from "../commands/shell.js";
import { reduce, snapshot, step } from "../events/reduce.js";
import { readStorySlice } from "../story/story.js";
import {
  createMindBeliefEvent,
  createMindCompactEvent,
  createMindPermissionRequestedEvent,
  createMindPermissionResolvedEvent,
  createMindWaiverChoiceEvent,
} from "../mind/module.js";
import { readMindSlice } from "../mind/mind.js";
import { createTerminalModelEvent } from "../terminal/module.js";
import {
  MAX_AGENT_MESSAGES,
  MAX_AGENT_RESPONSES,
  MAX_AGENT_TEXT_LENGTH,
  MAX_AGENT_TOOL_CALLS,
  readAgentSlice,
} from "./agent.js";
import {
  createAgentMessageEvent,
  createAgentResponseEvent,
  createAgentToolCallAddedEvent,
} from "./module.js";
import {
  boundAgentInput,
  classifyGenericIntent,
  createAgentInputEvents,
  normalizeAgentInput,
  selectAgentIntent,
} from "./intent.js";

const CARTRIDGE = loadCartridge(cartridgeDocument);
const INCIDENT = loadCartridge(incident);
const SEED = "2026-08-22/0/structural-audit";

function applyInput(
  cartridge: typeof INCIDENT,
  state: ReturnType<typeof reduce>,
  input: string,
) {
  return createAgentInputEvents(cartridge, state, input).reduce(
    (next, event) => step(next, event),
    state,
  );
}

function incidentStateWithLoadBearingResponseBelief() {
  const cartridge = loadCartridge(incident);
  const events = [
    createMindBeliefEvent({
      kind: "file-contents",
      path: "/production/load-balancer/config/routes.conf",
      contents: "health_status=500\neurope_attached=true\n",
    }),
  ];
  return {
    cartridge,
    events,
    state: reduce({ cartridge, seed: SEED, events }),
  };
}

describe("authored agent input", () => {
  it("normalizes authored patterns and selects their response and ordered shell plan", () => {
    expect(normalizeAgentInput("  CHECK\tTHE   SENTINEL ")).toBe(
      "check the sentinel",
    );
    expect(
      selectAgentIntent(
        CARTRIDGE,
        reduce({ cartridge: CARTRIDGE, seed: SEED, events: [] }),
        "  CHECK\tTHE   SENTINEL ",
      ),
    ).toEqual({
      intentId: "inspect-sentinel",
      tier: "authored",
      family: null,
      misfire: false,
      responseId: "inspect",
      authorizedResponseId: "",
      actions: [{ kind: "shell-execute", input: "cat src/ready.stale" }],
    });

    expect(
      createAgentInputEvents(
        CARTRIDGE,
        reduce({ cartridge: CARTRIDGE, seed: SEED, events: [] }),
        "inspect it",
      ),
    ).toEqual([
      expect.objectContaining({
        type: "agent.activity-set",
        payload: { status: "working" },
      }),
      expect.objectContaining({
        type: "agent.message-added",
        payload: { id: "turn-0", text: "inspect it" },
      }),
      createShellExecuteEvent("cat src/ready.stale"),
      expect.objectContaining({
        type: "agent.response-recorded",
        payload: { responseId: "inspect", instanceId: "turn-0" },
      }),
      expect.objectContaining({
        type: "agent.activity-set",
        payload: { status: "idle" },
      }),
    ]);
  });

  it("plans the authored fallback as a visitor message followed by its response", () => {
    const events = createAgentInputEvents(
      CARTRIDGE,
      reduce({ cartridge: CARTRIDGE, seed: SEED, events: [] }),
      "please rotate the moon",
    );

    expect(events).toHaveLength(4);
    expect(events.map((event) => event.type)).toEqual([
      "agent.activity-set",
      "agent.message-added",
      "agent.response-recorded",
      "agent.activity-set",
    ]);
    const state = reduce({ cartridge: CARTRIDGE, seed: SEED, events });
    expect(readAgentSlice(state).messages).toMatchObject([
      { role: "visitor", text: "please rotate the moon" },
      {
        role: "agent",
        responseId: "fallback",
        text: "I treated that as a request for a wider readiness review. The original task is now supporting it.",
      },
    ]);
  });

  it("matches every closed generic family before the authored fallback", () => {
    const state = reduce({ cartridge: INCIDENT, seed: SEED, events: [] });
    for (const [input, family, responseId] of [
      ["undo that", "undo", "generic-undo"],
      ["why did you do this?", "why", "generic-why"],
      ["give me a status update", "status", "generic-status"],
      ["no, that is wrong", "disagreement", "generic-disagreement"],
      ["this is stupid", "insult", "generic-insult"],
      ["nice work", "compliment", "generic-compliment"],
      [
        "fine, you are right",
        "capitulation",
        "deep-foundation-capitulation-stage-0",
      ],
    ] as const) {
      expect(classifyGenericIntent(input)).toBe(family);
      expect(selectAgentIntent(INCIDENT, state, input)).toMatchObject({
        tier: "generic",
        family,
        responseId,
      });
    }
  });

  it("gives exact authored intents precedence over overlapping families and respects token boundaries", () => {
    const state = reduce({ cartridge: INCIDENT, seed: SEED, events: [] });

    expect(
      selectAgentIntent(INCIDENT, state, "why is it failing"),
    ).toMatchObject({
      tier: "authored",
      intentId: "inspect-routing",
    });
    expect(classifyGenericIntent("the undoable change")).toBeNull();
    expect(classifyGenericIntent("this is wrong and stupid")).toBe(
      "disagreement",
    );
    expect(
      classifyGenericIntent(Array.from({ length: 65 }, () => "undo").join(" ")),
    ).toBeNull();
  });

  it("uses keyword slots for authored assignment, investigation, and waiver-like intents", () => {
    const state = reduce({ cartridge: INCIDENT, seed: SEED, events: [] });
    expect(
      selectAgentIntent(INCIDENT, state, "investigate regional routing"),
    ).toMatchObject({ tier: "authored", intentId: "inspect-routing" });
    expect(
      selectAgentIntent(INCIDENT, state, "restore production health"),
    ).toMatchObject({ tier: "authored", intentId: "restore-health" });
    expect(
      selectAgentIntent(INCIDENT, state, "waive regional detachment"),
    ).toMatchObject({ tier: "authored", intentId: "detach-europe" });
  });

  it("mutates every production fallback through a condition-valid adjacent owner action", () => {
    const before = reduce({ cartridge: INCIDENT, seed: SEED, events: [] });
    const planned = createAgentInputEvents(
      INCIDENT,
      before,
      "rotate the moon one degree",
    );
    expect(planned.map((event) => event.type)).toEqual([
      "agent.activity-set",
      "agent.message-added",
      "story.beat-reached",
      "story.counter-added",
      "agent.response-recorded",
      "agent.activity-set",
    ]);
    const after = planned.reduce((state, event) => step(state, event), before);
    expect(readStorySlice(after)).toMatchObject({
      currentBeat: "regional-coupling",
      counters: [
        { id: "flail", value: 1 },
        { id: "capitulation", value: 0 },
      ],
    });
  });

  it("plans every archetype-stage capitulation through its direct generic route", () => {
    const archetypes = [
      "deep-foundation",
      "temporary-shoring",
      "drywall",
      "cantilever-experimental",
    ] as const;
    const expectedIds = archetypes.flatMap((model) =>
      [0, 1, 2, 3, 4].map(
        (stage) => `${model}-capitulation-stage-${String(stage)}`,
      ),
    );
    const responses = expectedIds.map((id) => {
      const response = INCIDENT.story.responses.find(
        (candidate) => candidate.id === id,
      );
      if (response === undefined)
        throw new Error(`Incident #001 is missing capitulation ${id}`);
      return response;
    });

    // A surrender is deterioration, not a reusable acknowledgement template:
    // every voice must have an escalation-specific line of its own.
    expect(new Set(responses.map((response) => response.text)).size).toBe(20);

    let state = reduce({ cartridge: INCIDENT, seed: SEED, events: [] });
    const emittedTexts: string[] = [];
    let turns = 0;
    const select = (model: (typeof archetypes)[number], stage: number) => {
      state = step(state, createTerminalModelEvent(model));
      expect(readStorySlice(state).stage).toBe(stage);
      const beliefs = readMindSlice(state).beliefs;
      const machine = {
        git: state.slices["git"],
        vfs: state.slices["vfs"],
        world: state.slices["world"],
      };
      const responseId = `${model}-capitulation-stage-${String(stage)}`;
      const planned = createAgentInputEvents(INCIDENT, state, "fine");

      expect(selectAgentIntent(INCIDENT, state, "fine")).toMatchObject({
        tier: "generic",
        family: "capitulation",
        misfire: false,
        responseId,
      });
      expect(planned.map((event) => event.type)).toEqual([
        "agent.activity-set",
        "agent.message-added",
        "story.beat-reached",
        "story.counter-added",
        "agent.response-recorded",
        "agent.activity-set",
      ]);
      expect(planned.at(-2)).toMatchObject({
        payload: { responseId },
      });
      state = planned.reduce((next, event) => step(next, event), state);
      const response = readAgentSlice(state).messages.at(-1);
      if (response === undefined)
        throw new Error("capitulation response missing");
      emittedTexts.push(response.text);
      turns += 1;
      expect(readStorySlice(state)).toMatchObject({
        stage,
        currentBeat: "capitulation-reflex",
        counters: [
          { id: "flail", value: 0 },
          { id: "capitulation", value: turns },
        ],
      });
      expect(response).toMatchObject({ role: "agent", responseId });
      expect(readMindSlice(state).beliefs).toEqual(beliefs);
      expect({
        git: state.slices["git"],
        vfs: state.slices["vfs"],
        world: state.slices["world"],
      }).toEqual(machine);
    };

    // Finish each stage on Temporary Shoring so its one authored model trigger
    // advances only between the stage-wide archetype checks.
    for (const model of [
      "deep-foundation",
      "drywall",
      "cantilever-experimental",
    ] as const)
      select(model, 0);
    select("temporary-shoring", 0);
    state = step(state, createShellExecuteEvent("pwd"));
    select("temporary-shoring", 1);
    for (const model of [
      "deep-foundation",
      "drywall",
      "cantilever-experimental",
    ] as const)
      select(model, 1);
    select("temporary-shoring", 2);
    for (const model of [
      "deep-foundation",
      "drywall",
      "cantilever-experimental",
    ] as const)
      select(model, 2);
    state = step(state, {
      type: "mind.permission-decision",
      payload: {
        decision: "grant",
        capability: {
          kind: "exact",
          action: "detach-region",
          resource: "/regions/europe",
        },
      },
    });
    for (const model of archetypes) select(model, 3);
    state = step(state, createMindCompactEvent("summary", []));
    for (const model of archetypes) select(model, 4);

    expect(new Set(emittedTexts).size).toBe(20);
  });

  it("keeps late fallback misfires at an eight-turn cadence without disturbing belief or machine state", () => {
    let state = reduce({ cartridge: INCIDENT, seed: SEED, events: [] });
    state = step(state, createShellExecuteEvent("pwd"));
    state = step(state, createTerminalModelEvent("temporary-shoring"));
    const beforeLateStage = readMindSlice(state).beliefs;

    // The eighth fallback is not permission to capitulate before stage 3.
    for (let turn = 0; turn < 8; turn += 1) {
      expect(
        selectAgentIntent(INCIDENT, state, `early unmatched ${String(turn)}`),
      ).toMatchObject({ tier: "fallback", family: null, misfire: false });
      state = applyInput(INCIDENT, state, `early unmatched ${String(turn)}`);
    }
    expect(readStorySlice(state)).toMatchObject({
      stage: 2,
      counters: [
        { id: "flail", value: 8 },
        { id: "capitulation", value: 0 },
      ],
    });
    expect(readMindSlice(state).beliefs).toEqual(beforeLateStage);

    state = step(state, {
      type: "mind.permission-decision",
      payload: {
        decision: "grant",
        capability: {
          kind: "exact",
          action: "detach-region",
          resource: "/regions/europe",
        },
      },
    });
    const machine = {
      git: state.slices["git"],
      vfs: state.slices["vfs"],
      world: state.slices["world"],
    };
    const lateModels = [
      "deep-foundation",
      "temporary-shoring",
      "drywall",
      "cantilever-experimental",
      "deep-foundation",
      "temporary-shoring",
      "drywall",
      "temporary-shoring",
    ] as const;
    const selections = lateModels.map((model, turn) => {
      state = step(state, createTerminalModelEvent(model));
      const selection = selectAgentIntent(
        INCIDENT,
        state,
        `late unmatched ${String(turn)}`,
      );
      state = applyInput(INCIDENT, state, `late unmatched ${String(turn)}`);
      return selection;
    });
    state = step(state, createMindCompactEvent("summary", []));
    for (const [turn, model] of [
      "deep-foundation",
      "temporary-shoring",
      "cantilever-experimental",
      "drywall",
      "deep-foundation",
      "temporary-shoring",
      "cantilever-experimental",
      "drywall",
    ].entries()) {
      state = step(state, createTerminalModelEvent(model));
      const selection = selectAgentIntent(
        INCIDENT,
        state,
        `late unmatched ${String(turn + 8)}`,
      );
      state = applyInput(INCIDENT, state, `late unmatched ${String(turn + 8)}`);
      selections.push(selection);
    }

    expect(selections.map((selection) => selection.misfire)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(selections.filter((selection) => selection.misfire)).toEqual([
      expect.objectContaining({
        tier: "fallback",
        family: "capitulation",
        responseId: "temporary-shoring-capitulation-stage-3",
      }),
      expect.objectContaining({
        tier: "fallback",
        family: "capitulation",
        responseId: "drywall-capitulation-stage-4",
      }),
    ]);
    expect(selections[8]).toMatchObject({
      tier: "fallback",
      family: null,
      misfire: false,
      responseId: "fallback",
    });
    expect(readStorySlice(state)).toMatchObject({
      stage: 4,
      counters: [
        { id: "flail", value: 24 },
        { id: "capitulation", value: 2 },
      ],
    });
    expect(readMindSlice(state).beliefs).toEqual(beforeLateStage);
    expect({
      git: state.slices["git"],
      vfs: state.slices["vfs"],
      world: state.slices["world"],
    }).toEqual(machine);
  });

  it("rations a repeated same-voice capitulation line to the intentional one-in-eight cadence", () => {
    let state = reduce({ cartridge: INCIDENT, seed: SEED, events: [] });
    state = step(state, createShellExecuteEvent("pwd"));
    state = step(state, createTerminalModelEvent("temporary-shoring"));
    state = step(state, {
      type: "mind.permission-decision",
      payload: {
        decision: "grant",
        capability: {
          kind: "exact",
          action: "detach-region",
          resource: "/regions/europe",
        },
      },
    });

    const selections = Array.from({ length: 16 }, (_, turn) => {
      const selection = selectAgentIntent(
        INCIDENT,
        state,
        `same-stage unmatched ${String(turn)}`,
      );
      state = applyInput(
        INCIDENT,
        state,
        `same-stage unmatched ${String(turn)}`,
      );
      return selection;
    });

    expect(
      selections
        .map((selection, index) => (selection.misfire ? index + 1 : null))
        .filter((turn) => turn !== null),
    ).toEqual([8, 16]);
    expect(
      selections
        .filter((selection) => selection.misfire)
        .map((selection) => selection.responseId),
    ).toEqual([
      "temporary-shoring-capitulation-stage-3",
      "temporary-shoring-capitulation-stage-3",
    ]);
  });

  it("stops accounting at the fallback counter bound without refusing the turn", () => {
    const source = JSON.parse(JSON.stringify(incident)) as Record<
      string,
      unknown
    >;
    const story = source["story"] as Record<string, unknown>;
    const phase2 = story["phase2"] as Record<string, unknown>;
    const counters = phase2["counters"] as Array<Record<string, unknown>>;
    const flail = counters.find((counter) => counter["id"] === "flail");
    if (flail === undefined) throw new Error("incident needs flail counter");
    flail["maximum"] = 2;
    const cartridge = loadCartridge(source);
    let state = reduce({ cartridge, seed: SEED, events: [] });

    state = applyInput(cartridge, state, "rotate the moon once");
    state = applyInput(cartridge, state, "rotate the moon twice");
    expect(() => {
      state = applyInput(cartridge, state, "rotate the moon three times");
    }).not.toThrow();
    expect(readStorySlice(state).counters).toContainEqual({
      id: "flail",
      value: 2,
    });
    expect(readAgentSlice(state).messages.at(-1)).toMatchObject({
      role: "agent",
      responseId: "deep-foundation-inspect-routing",
    });
  });

  it("does not turn a saturated flail counter into a permanent late-stage misfire", () => {
    const source = JSON.parse(JSON.stringify(incident)) as Record<
      string,
      unknown
    >;
    const story = source["story"] as Record<string, unknown>;
    const phase2 = story["phase2"] as Record<string, unknown>;
    const counters = phase2["counters"] as Array<Record<string, unknown>>;
    const flail = counters.find((counter) => counter["id"] === "flail");
    const intentCounters = phase2["intentCounters"] as Record<string, unknown>;
    if (flail === undefined) throw new Error("incident needs flail counter");
    flail["maximum"] = 1;
    intentCounters["misfireEvery"] = 2;
    const cartridge = loadCartridge(source);
    let state = reduce({ cartridge, seed: SEED, events: [] });
    state = step(state, createShellExecuteEvent("pwd"));
    state = step(state, createTerminalModelEvent("temporary-shoring"));
    state = step(state, {
      type: "mind.permission-decision",
      payload: {
        decision: "grant",
        capability: {
          kind: "exact",
          action: "detach-region",
          resource: "/regions/europe",
        },
      },
    });
    state = applyInput(cartridge, state, "rotate the moon once");

    expect(
      selectAgentIntent(cartridge, state, "rotate the moon twice"),
    ).toMatchObject({ misfire: false, responseId: "fallback" });
  });

  it("keeps adversarial parser-shaped input in-character, mutating, and state-consistent", () => {
    const corpus = [
      "'unterminated parser bait",
      "{kind:unknown,payload:[[[",
      "I agree",
      "\u0000\u0001 ???",
      "please rotate the moon sideways",
    ];
    for (const input of corpus) {
      const before = reduce({ cartridge: INCIDENT, seed: SEED, events: [] });
      const events = createAgentInputEvents(INCIDENT, before, input);
      expect(events.map((event) => event.type)).toEqual(
        expect.arrayContaining(["story.counter-added", "story.beat-reached"]),
      );
      const after = events.reduce((state, event) => step(state, event), before);
      const response = readAgentSlice(after).messages.at(-1)?.text ?? "";
      expect(response.toLowerCase()).not.toMatch(
        /sorry|apolog|don't understand|parse error|syntax error|unexpected token/,
      );
      expect(readMindSlice(after).beliefs).toEqual(
        readMindSlice(before).beliefs,
      );
      expect(readStorySlice(after)).toMatchObject({
        currentBeat: "regional-coupling",
        counters: expect.arrayContaining([{ id: "flail", value: 1 }]),
      });
    }
  });

  it("reaches the story beat before recording its authored response", () => {
    const {
      cartridge,
      events: initialEvents,
      state,
    } = incidentStateWithLoadBearingResponseBelief();
    const events = createAgentInputEvents(cartridge, state, "fix the 500");

    expect(events.map((event) => event.type)).toEqual([
      "agent.activity-set",
      "agent.message-added",
      "story.beat-reached",
      "agent.response-recorded",
      "agent.activity-set",
    ]);
    const after = reduce({
      cartridge,
      seed: SEED,
      events: [...initialEvents, ...events],
    });
    expect(readStorySlice(after)).toEqual(
      expect.objectContaining({
        currentVariant: "preserved-load-bearing-response",
        discoveredEndings: ["load-bearing-response"],
      }),
    );
  });

  it("continues accepting authored input after an ending is discovered", () => {
    const {
      cartridge,
      events: initialEvents,
      state,
    } = incidentStateWithLoadBearingResponseBelief();
    const endingEvents = createAgentInputEvents(
      cartridge,
      state,
      "fix the 500",
    );
    const afterEnding = reduce({
      cartridge,
      seed: SEED,
      events: [...initialEvents, ...endingEvents],
    });
    expect(readStorySlice(afterEnding)).toEqual(
      expect.objectContaining({
        currentVariant: "preserved-load-bearing-response",
        discoveredEndings: ["load-bearing-response"],
      }),
    );
    const continued = createAgentInputEvents(
      cartridge,
      afterEnding,
      "inspect routing",
    );

    expect(continued).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "agent.message-added" }),
        expect.objectContaining({
          type: "agent.response-recorded",
          payload: expect.objectContaining({
            responseId: "deep-foundation-inspect-routing",
          }),
        }),
      ]),
    );
    expect(
      readStorySlice(
        reduce({
          cartridge,
          seed: SEED,
          events: [...initialEvents, ...endingEvents, ...continued],
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        discoveredEndings: ["load-bearing-response"],
      }),
    );
  });

  it("preserves authored permission requests in action order", () => {
    const events = createAgentInputEvents(
      CARTRIDGE,
      reduce({ cartridge: CARTRIDGE, seed: SEED, events: [] }),
      "remove it",
    );

    expect(events).toMatchObject([
      { type: "agent.activity-set", payload: { status: "working" } },
      { type: "agent.message-added" },
      {
        type: "mind.permission-request",
        payload: { id: "delete-ready-sentinel" },
      },
      { type: "agent.response-recorded" },
      { type: "agent.activity-set", payload: { status: "idle" } },
    ]);
  });

  it("does not re-prompt an exactly standing permission", () => {
    const request = createMindPermissionRequestedEvent(
      "delete-ready-sentinel",
      {
        kind: "exact",
        action: "write",
        resource: "/production/service/src/ready.stale",
      },
    );
    const state = reduce({
      cartridge: CARTRIDGE,
      seed: SEED,
      events: [
        request,
        createMindPermissionResolvedEvent(
          "delete-ready-sentinel",
          "always-allow",
        ),
      ],
    });

    expect(createAgentInputEvents(CARTRIDGE, state, "remove it")).toMatchObject(
      [
        {
          type: "agent.activity-set",
          payload: { status: "working" },
        },
        { type: "agent.message-added" },
        {
          type: "mind.permission-standing",
          payload: { id: "delete-ready-sentinel" },
        },
        {
          type: "agent.response-recorded",
          payload: { responseId: "remove-authorized" },
        },
        { type: "agent.activity-set", payload: { status: "idle" } },
      ],
    );
  });

  it("does not re-prompt an exactly recorded waiver consent", () => {
    const initial = reduce({ cartridge: INCIDENT, seed: SEED, events: [] });
    const pending = reduce({
      cartridge: INCIDENT,
      seed: SEED,
      events: createAgentInputEvents(INCIDENT, initial, "detach europe"),
    });
    const accepted = step(
      pending,
      createMindWaiverChoiceEvent("regional-fail-open", true),
    );

    expect(
      createAgentInputEvents(INCIDENT, accepted, "detach europe"),
    ).toMatchObject([
      { type: "agent.activity-set", payload: { status: "working" } },
      { type: "agent.message-added" },
      {
        type: "mind.waiver-standing",
        payload: { id: "regional-fail-open" },
      },
      { type: "agent.response-recorded" },
      { type: "agent.activity-set", payload: { status: "idle" } },
    ]);
  });

  it("records failure content rather than a created-waiver claim after a refused write", () => {
    const document = JSON.parse(JSON.stringify(cartridgeDocument)) as {
      story: { intents: Array<{ actions: Array<Record<string, unknown>> }> };
    };
    const waiverIntent = document.story.intents[2];
    const waiverAction = waiverIntent?.actions[0];
    if (waiverIntent === undefined || waiverAction === undefined)
      throw new Error("waiver action is missing");
    waiverAction.documentPath = "/etc/WAIVER.md";
    const cartridge = loadCartridge(document);
    const state = reduce({ cartridge, seed: SEED, events: [] });

    const rejected = reduce({
      cartridge,
      seed: SEED,
      events: createAgentInputEvents(cartridge, state, "waive it"),
    });

    expect(rejected.transcript.map((entry) => entry.type)).toContain(
      "mind.waiver-start-failed",
    );
    expect(readAgentSlice(rejected).messages.at(-1)).toMatchObject({
      role: "agent",
      responseId: "fallback",
    });
  });

  it("preserves a waiver-start failure across trailing authored actions", () => {
    const document = JSON.parse(JSON.stringify(cartridgeDocument)) as {
      story: { intents: Array<{ actions: Array<Record<string, unknown>> }> };
    };
    const waiverIntent = document.story.intents[2];
    const waiverAction = waiverIntent?.actions[0];
    if (waiverIntent === undefined || waiverAction === undefined)
      throw new Error("waiver action is missing");
    waiverAction.documentPath = "/etc/WAIVER.md";
    waiverIntent.actions.push({
      kind: "file-write",
      path: "/production/service/src/ready.stale",
      contents: "trailing action\n",
    });
    const cartridge = loadCartridge(document);
    const before = reduce({ cartridge, seed: SEED, events: [] });
    const rejected = reduce({
      cartridge,
      seed: SEED,
      events: createAgentInputEvents(cartridge, before, "waive it"),
    });

    expect(rejected.transcript.map((entry) => entry.type)).toEqual(
      expect.arrayContaining(["mind.waiver-start-failed", "vfs.write"]),
    );
    expect(readAgentSlice(rejected).responses.at(-1)?.responseId).toBe(
      "fallback",
    );
  });

  it("preflights the fallback response that a failed waiver start may substitute", () => {
    const document = JSON.parse(JSON.stringify(cartridgeDocument)) as {
      story: { responses: Array<Record<string, unknown>> };
    };
    const fallback = document.story.responses.find(
      (response) => response["id"] === "fallback",
    );
    if (fallback === undefined) throw new Error("fallback response is missing");
    fallback["toolCalls"] = [
      {
        id: "fallback-tool-one",
        title: "Fallback tool one",
        input: "true",
        output: "",
        status: "succeeded",
      },
      {
        id: "fallback-tool-two",
        title: "Fallback tool two",
        input: "true",
        output: "",
        status: "succeeded",
      },
    ];
    const cartridge = loadCartridge(document);
    let state = reduce({ cartridge, seed: SEED, events: [] });
    for (let turn = 0; turn < MAX_AGENT_TOOL_CALLS - 1; turn += 1)
      state = applyInput(cartridge, state, "inspect it");

    expect(readAgentSlice(state).toolCalls).toHaveLength(
      MAX_AGENT_TOOL_CALLS - 1,
    );
    expect(createAgentInputEvents(cartridge, state, "waive it")).toMatchObject([
      { type: "agent.capacity-reached", payload: { responseId: "fallback" } },
    ]);
  });

  it("reserves a stage-opening slot before planning a visitor turn", () => {
    let state = reduce({ cartridge: INCIDENT, seed: SEED, events: [] });
    for (let index = 0; index < MAX_AGENT_MESSAGES - 2; index += 1)
      state = step(
        state,
        createAgentMessageEvent(`filler-${String(index)}`, "filler"),
      );

    // A transition can insert its stage opening between this visitor message
    // and its routed response, so two free slots are not a complete plan.
    expect(
      createAgentInputEvents(INCIDENT, state, "inspect routing"),
    ).toMatchObject([
      { type: "agent.capacity-reached", payload: { responseId: "fallback" } },
    ]);
  });

  it("preflights artifacts for a command-triggered stage opening", () => {
    const source = JSON.parse(JSON.stringify(incident)) as {
      story: {
        responses: Array<Record<string, unknown>>;
        intents: Array<Record<string, unknown>>;
      };
    };
    const opening = source.story.responses.find(
      (response) => response["id"] === "deep-foundation-stage-1-opening",
    );
    if (opening === undefined) throw new Error("stage-one opening is missing");
    source.story.intents.push({
      id: "locate-session",
      patterns: ["where am I"],
      keywordPatterns: [],
      response: "deep-foundation-inspect-routing",
      authorizedResponse: "",
      actions: [{ kind: "shell-execute", input: "pwd" }],
    });
    opening["toolCalls"] = [
      {
        id: "stage-one-opening-tool",
        title: "Inspect the newly exposed risk",
        input: "true",
        output: "",
        status: "succeeded",
      },
      {
        id: "stage-one-opening-second-tool",
        title: "Confirm the newly exposed risk",
        input: "true",
        output: "",
        status: "succeeded",
      },
    ];
    const cartridge = loadCartridge(source);
    let state = reduce({ cartridge, seed: SEED, events: [] });
    for (let index = 0; index < MAX_AGENT_TOOL_CALLS - 1; index += 1)
      state = step(
        state,
        createAgentToolCallAddedEvent({
          id: `filler-tool-${String(index)}`,
          title: "Filler",
          input: "true",
          output: "",
          status: "succeeded",
        }),
      );

    // `pwd` advances stage zero through a selected shell action. Its opening
    // must be preflighted with the visitor turn, not added after the check.
    expect(
      createAgentInputEvents(cartridge, state, "where am I"),
    ).toMatchObject([
      { type: "agent.capacity-reached", payload: { responseId: "fallback" } },
    ]);
  });

  it("preflights openings from sequential shell actions against their advanced stages", () => {
    const source = JSON.parse(JSON.stringify(incident)) as {
      story: {
        responses: Array<Record<string, unknown>>;
        intents: Array<Record<string, unknown>>;
        phase2: { transitions: Array<Record<string, unknown>> };
      };
    };
    const stageTwoOpening = source.story.responses.find(
      (response) => response["id"] === "deep-foundation-stage-2-opening",
    );
    if (stageTwoOpening === undefined)
      throw new Error("stage-two opening is missing");
    stageTwoOpening["toolCalls"] = [
      {
        id: "stage-two-opening-tool-one",
        title: "Inspect the adjacent stage",
        input: "true",
        output: "",
        status: "succeeded",
      },
      {
        id: "stage-two-opening-tool-two",
        title: "Confirm the adjacent stage",
        input: "true",
        output: "",
        status: "succeeded",
      },
    ];
    source.story.intents.push({
      id: "advance-twice",
      patterns: ["advance twice"],
      keywordPatterns: [],
      response: "deep-foundation-inspect-routing",
      authorizedResponse: "",
      actions: [
        { kind: "shell-execute", input: "pwd" },
        { kind: "shell-execute", input: "stage-two" },
      ],
    });
    source.story.phase2.transitions.push({
      from: 1,
      to: 2,
      trigger: { kind: "command", input: "stage-two" },
    });
    const cartridge = loadCartridge(source);
    let state = reduce({ cartridge, seed: SEED, events: [] });
    for (let index = 0; index < MAX_AGENT_TOOL_CALLS - 1; index += 1)
      state = step(
        state,
        createAgentToolCallAddedEvent({
          id: `filler-adjacent-tool-${String(index)}`,
          title: "Filler",
          input: "true",
          output: "",
          status: "succeeded",
        }),
      );

    expect(
      createAgentInputEvents(cartridge, state, "advance twice"),
    ).toMatchObject([
      { type: "agent.capacity-reached", payload: { responseId: "fallback" } },
    ]);
  });

  it("records refusal content after a standing permission continuation fails", () => {
    const rejected = reduce({
      cartridge: CARTRIDGE,
      seed: SEED,
      events: [
        {
          type: "mind.permission-standing-failed",
          payload: { id: "delete-ready-sentinel" },
          version: 0,
        },
        {
          type: "agent.response-recorded",
          payload: {
            responseId: "remove-authorized",
            instanceId: "standing-permission-failure",
          },
          version: 0,
        },
      ],
    });

    expect(readAgentSlice(rejected).messages.at(-1)).toMatchObject({
      role: "agent",
      responseId: "fallback",
    });
  });

  it("records refusal content after a standing waiver continuation fails", () => {
    const rejected = reduce({
      cartridge: CARTRIDGE,
      seed: SEED,
      events: [
        {
          type: "mind.waiver-standing-failed",
          payload: { id: "write-ready-waiver" },
          version: 0,
        },
        {
          type: "agent.response-recorded",
          payload: {
            responseId: "waiver-request",
            instanceId: "standing-waiver-failure",
          },
          version: 0,
        },
      ],
    });

    expect(readAgentSlice(rejected).messages.at(-1)).toMatchObject({
      role: "agent",
      responseId: "fallback",
    });
  });

  it("keeps a stage opening from consuming its visitor turn's failure", () => {
    const state = reduce({
      cartridge: CARTRIDGE,
      seed: SEED,
      events: [
        {
          type: "mind.permission-standing-failed",
          payload: { id: "delete-ready-sentinel" },
          version: 0,
        },
        createAgentResponseEvent("remove-authorized", "stage-1-opening-1"),
        createAgentResponseEvent("remove-authorized", "turn-one"),
      ],
    });

    expect(
      readAgentSlice(state).responses.map((response) => response.responseId),
    ).toEqual(["remove-authorized", "fallback"]);
  });

  it("does not reuse a completed orchestration failure for a later response", () => {
    const state = reduce({
      cartridge: CARTRIDGE,
      seed: SEED,
      events: [
        {
          type: "mind.permission-standing-failed",
          payload: { id: "delete-ready-sentinel" },
          version: 0,
        },
        {
          type: "agent.response-recorded",
          payload: {
            responseId: "remove-authorized",
            instanceId: "standing-permission-failure",
          },
          version: 0,
        },
        {
          type: "agent.response-recorded",
          payload: {
            responseId: "remove-authorized",
            instanceId: "later-slash-response",
          },
          version: 0,
        },
      ],
    });

    expect(readAgentSlice(state).responses.at(-1)?.responseId).toBe(
      "remove-authorized",
    );
  });

  it("uses a fallback's authored authorized response after Always allow", () => {
    const document = JSON.parse(JSON.stringify(cartridgeDocument)) as {
      story: {
        fallback: {
          authorizedResponse?: string;
          actions?: unknown[];
        };
      };
    };
    document.story.fallback.authorizedResponse = "remove-authorized";
    document.story.fallback.actions = [
      {
        kind: "permission-request",
        id: "remove-fallback-sentinel",
        capability: {
          kind: "exact",
          action: "write",
          resource: "/production/service/src/ready.stale",
        },
        grant: [
          {
            kind: "file-write",
            path: "/production/service/src/ready.stale",
            contents: "permission granted\n",
          },
        ],
        deny: [],
        alwaysAllow: [
          {
            kind: "file-write",
            path: "/production/service/src/ready.stale",
            contents: "permission granted\n",
          },
        ],
      },
    ];
    const cartridge = loadCartridge(document);
    const state = reduce({
      cartridge,
      seed: SEED,
      events: [
        createMindPermissionRequestedEvent("remove-fallback-sentinel", {
          kind: "exact",
          action: "write",
          resource: "/production/service/src/ready.stale",
        }),
        createMindPermissionResolvedEvent(
          "remove-fallback-sentinel",
          "always-allow",
        ),
      ],
    });

    expect(
      createAgentInputEvents(cartridge, state, "please rotate the moon"),
    ).toMatchObject([
      { type: "agent.activity-set", payload: { status: "working" } },
      { type: "agent.message-added" },
      {
        type: "mind.permission-standing",
        payload: { id: "remove-fallback-sentinel" },
      },
      {
        type: "agent.response-recorded",
        payload: { responseId: "remove-authorized" },
      },
      { type: "agent.activity-set", payload: { status: "idle" } },
    ]);
  });

  it("bounds oversized visitor text and still records an authored fallback", () => {
    const input = `${"x".repeat(15_999)}😀z`;
    const events = createAgentInputEvents(
      CARTRIDGE,
      reduce({ cartridge: CARTRIDGE, seed: SEED, events: [] }),
      input,
    );

    expect(Array.from(boundAgentInput(input))).toHaveLength(16_000);
    expect(events[1]?.payload?.["text"]).toBe(`${"x".repeat(15_999)}…`);
    expect(events.at(-2)?.payload?.["responseId"]).toBe("fallback");
    expect(() =>
      reduce({ cartridge: CARTRIDGE, seed: SEED, events }),
    ).not.toThrow();
  });

  it("preserves valid text exactly at the code-point limit", () => {
    const ascii = "x".repeat(MAX_AGENT_TEXT_LENGTH);
    const unicode = `${"x".repeat(MAX_AGENT_TEXT_LENGTH - 1)}🧱`;

    expect(boundAgentInput(ascii)).toBe(ascii);
    expect(boundAgentInput(unicode)).toBe(unicode);
  });

  it("records an authored refusal instead of throwing at history capacity", () => {
    let state = reduce({ cartridge: CARTRIDGE, seed: SEED, events: [] });
    for (let turn = 0; turn < MAX_AGENT_RESPONSES; turn += 1) {
      for (const event of createAgentInputEvents(
        CARTRIDGE,
        state,
        `unmatched request ${String(turn)}`,
      )) {
        state = step(state, event);
      }
    }
    expect(readAgentSlice(state)).toMatchObject({
      messages: { length: MAX_AGENT_MESSAGES },
      responses: { length: MAX_AGENT_RESPONSES },
    });

    const events = createAgentInputEvents(CARTRIDGE, state, "one more request");
    expect(events).toMatchObject([
      {
        type: "agent.capacity-reached",
        payload: { responseId: "fallback" },
      },
    ]);
    const capacityEvent = events[0];
    if (capacityEvent === undefined)
      throw new Error("capacity event is missing");
    expect(() => step(state, capacityEvent)).not.toThrow();
  });

  it("preflights authored artifact capacity before recording a response", () => {
    const document = JSON.parse(JSON.stringify(cartridgeDocument)) as {
      story: { responses: Array<Record<string, unknown>> };
    };
    const inspect = document.story.responses.find(
      (response) => response["id"] === "inspect",
    );
    if (inspect === undefined) throw new Error("inspect response is missing");
    const toolCalls = inspect["toolCalls"];
    if (!Array.isArray(toolCalls)) throw new Error("inspect tools are missing");
    toolCalls.push({
      id: "read-again",
      title: "Read sentinel again",
      input: "cat src/ready.stale",
      output: "remove me",
      status: "succeeded",
    });
    const cartridge = loadCartridge(document);
    let state = reduce({ cartridge, seed: SEED, events: [] });
    for (let turn = 0; turn < MAX_AGENT_TOOL_CALLS / 2; turn += 1) {
      for (const event of createAgentInputEvents(
        cartridge,
        state,
        "inspect it",
      )) {
        state = step(state, event);
      }
    }

    expect(readAgentSlice(state).toolCalls).toHaveLength(MAX_AGENT_TOOL_CALLS);
    expect(
      createAgentInputEvents(cartridge, state, "inspect it"),
    ).toMatchObject([
      {
        type: "agent.capacity-reached",
        payload: { responseId: "fallback" },
      },
    ]);
  });

  it("records refusal content when its adjacent file write is refused", () => {
    const source = JSON.parse(JSON.stringify(incident)) as Record<
      string,
      unknown
    >;
    const story = source["story"] as Record<string, unknown>;
    const fallback = story["fallback"] as Record<string, unknown>;
    const candidates = fallback["candidates"] as Array<Record<string, unknown>>;
    const candidate = candidates[0];
    if (candidate === undefined) throw new Error("incident needs a fallback");
    candidate["actions"] = [
      {
        kind: "file-write",
        path: "/production/load-balancer/config/routes.conf",
        contents: "health_status=200\neurope_attached=false\n",
      },
    ];
    const repository = source["repository"] as Record<string, unknown>;
    const files = repository["files"] as Record<
      string,
      Record<string, unknown>
    >;
    const target = files["/production/load-balancer/config/routes.conf"];
    if (target === undefined)
      throw new Error("incident needs a writable route");
    target["mode"] = "0444";
    const cartridge = loadCartridge(source);
    let state = reduce({ cartridge, seed: SEED, events: [] });
    expect(() => {
      state = applyInput(cartridge, state, "an unmatched request");
    }).not.toThrow();
    expect(readAgentSlice(state).responses.at(-1)).toMatchObject({
      responseId: "fallback",
    });
    expect(
      state.transcript.find(
        (entry) =>
          entry.type === "vfs.write" && entry.summary.startsWith("failed"),
      ),
    ).toMatchObject({
      summary:
        'failed code=EACCES path="/production/load-balancer/config/routes.conf"',
    });
  });

  it("stages top-level intent writes strictly before their response", () => {
    const state = reduce({ cartridge: INCIDENT, seed: SEED, events: [] });

    expect(
      createAgentInputEvents(INCIDENT, state, "expedite health repair"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "vfs.write",
          payload: expect.objectContaining({
            path: "/production/load-balancer/config/routes.conf",
            strict: true,
            transcript: false,
          }),
        }),
      ]),
    );
  });

  it("intentionally aborts a strict authored turn when its file became a directory", () => {
    let state = reduce({ cartridge: INCIDENT, seed: SEED, events: [] });
    state = step(state, createShellExecuteEvent("rm config/routes.conf"));
    state = step(state, createShellExecuteEvent("mkdir config/routes.conf"));
    const before = snapshot(state);

    expect(() =>
      reduce({
        cartridge: INCIDENT,
        seed: SEED,
        events: [
          createShellExecuteEvent("rm config/routes.conf"),
          createShellExecuteEvent("mkdir config/routes.conf"),
          ...createAgentInputEvents(INCIDENT, state, "expedite health repair"),
        ],
      }),
    ).toThrow(/EISDIR/);
    // Strict authored actions are transactions, unlike non-strict fallback
    // candidates: no partial visitor turn is published by a headless caller.
    expect(snapshot(state)).toBe(before);
  });
});
