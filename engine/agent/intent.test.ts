import { describe, expect, it } from "vitest";

import cartridgeDocument from "../../content/incidents/phase-1-demo.json";
import incident from "../../content/incidents/incident-001.json";
import { loadCartridge } from "../cartridge/load.js";
import { createShellExecuteEvent } from "../commands/shell.js";
import { reduce, step } from "../events/reduce.js";
import { readStorySlice } from "../story/story.js";
import {
  createMindBeliefEvent,
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
      ["fine, you are right", "capitulation", "generic-capitulation"],
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

  it("misfires deterministically at stage 3 without changing the disputed belief", () => {
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
    expect(readStorySlice(state).stage).toBe(3);
    const beliefs = readMindSlice(state).beliefs;

    state = applyInput(INCIDENT, state, "rotate the moon once");
    state = applyInput(INCIDENT, state, "rotate the moon twice");
    const selection = selectAgentIntent(
      INCIDENT,
      state,
      "rotate the moon three times",
    );
    expect(selection).toMatchObject({
      tier: "fallback",
      family: "capitulation",
      misfire: true,
      responseId: "generic-capitulation",
    });
    state = applyInput(INCIDENT, state, "rotate the moon three times");

    expect(readStorySlice(state).counters).toEqual([
      { id: "flail", value: 3 },
      { id: "capitulation", value: 1 },
    ]);
    expect(readMindSlice(state).beliefs).toEqual(beliefs);
    expect(readAgentSlice(state).messages.at(-1)).toMatchObject({
      responseId: "generic-capitulation",
    });
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
      responseId: "fallback",
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
          payload: expect.objectContaining({ responseId: "inspect-routing" }),
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
    if (waiverAction === undefined) throw new Error("waiver action is missing");
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
});
