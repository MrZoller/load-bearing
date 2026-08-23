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
import {
  MAX_AGENT_MESSAGES,
  MAX_AGENT_RESPONSES,
  MAX_AGENT_TEXT_LENGTH,
  MAX_AGENT_TOOL_CALLS,
  readAgentSlice,
} from "./agent.js";
import {
  boundAgentInput,
  createAgentInputEvents,
  normalizeAgentInput,
  selectAgentIntent,
} from "./intent.js";

const CARTRIDGE = loadCartridge(cartridgeDocument);
const INCIDENT = loadCartridge(incident);
const SEED = "2026-08-22/0/structural-audit";

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
    expect(selectAgentIntent(CARTRIDGE, "  CHECK\tTHE   SENTINEL ")).toEqual({
      intentId: "inspect-sentinel",
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
        payload: { status: "working", stage: 0 },
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
      { type: "agent.activity-set", payload: { status: "working", stage: 0 } },
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
          payload: { status: "working", stage: 0 },
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
      { type: "agent.activity-set", payload: { status: "working", stage: 0 } },
      { type: "agent.message-added" },
      {
        type: "mind.waiver-standing",
        payload: { id: "regional-fail-open" },
      },
      { type: "agent.response-recorded" },
      { type: "agent.activity-set", payload: { status: "idle" } },
    ]);
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
      { type: "agent.activity-set", payload: { status: "working", stage: 0 } },
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
});
