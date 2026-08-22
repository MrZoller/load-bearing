import { describe, expect, it } from "vitest";

import { loadCartridge } from "../cartridge/load.js";
import { deserialize, serialize } from "../serialize/canonical.js";
import { reduce, restoreSnapshot, snapshot } from "../events/reduce.js";
import type { EngineEvent } from "../events/state.js";
import { createRandom } from "../random/stream.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
import {
  MAX_AGENT_MESSAGES,
  MAX_AGENT_TEXT_LENGTH,
  readAgentMessageArtifacts,
  readAgentSlice,
  recordAuthoredResponse,
  validateAgentSlice,
} from "./agent.js";
import {
  createAgentActivityEvent,
  createAgentMessageEvent,
  createAgentResponseEvent,
  createAgentThinkingAddedEvent,
  createAgentThinkingUpdatedEvent,
  createAgentTodoAddedEvent,
  createAgentTodoUpdatedEvent,
  createAgentToolCallAddedEvent,
  createAgentToolCallUpdatedEvent,
} from "./module.js";
import {
  createTerminalModeEvent,
  createTerminalModelEvent,
} from "../terminal/module.js";
import { forkModelStream } from "../terminal/terminal.js";

function cartridge() {
  const source = loadCartridgeFixture("minimal") as Record<string, unknown>;
  const story = source["story"] as Record<string, unknown>;
  story["responses"] = [
    {
      id: "authored",
      text: "Authored once, instantiated by reference.",
      toolCalls: [
        {
          id: "read",
          title: "Read file",
          input: "cat README.md",
          output: "",
          status: "pending",
        },
      ],
      thinkingBlocks: [
        { id: "private", text: "Okay, this is clear.", status: "active" },
      ],
      todos: [{ id: "inspect", text: "Inspect", status: "pending" }],
    },
  ];
  story["opening"] = {
    login: ["Fixture login."],
    response: "authored",
    beliefs: [],
  };
  story["intents"] = [
    { id: "fixture-intent", patterns: ["inspect"], response: "authored" },
  ];
  story["fallback"] = { response: "authored" };
  story["helpResponse"] = "authored";
  story["compact"] = {
    response: "authored",
    summary: "Fixture compacted.",
    beliefs: [],
  };
  story["resume"] = {
    unchangedResponse: "authored",
    changedResponse: "authored",
  };
  return loadCartridge(source);
}

const CARTRIDGE = cartridge();
const SEED = "2026-08-21/16/deep-foundation";

function fold(events: readonly EngineEvent[]) {
  return reduce({ cartridge: CARTRIDGE, seed: SEED, events });
}

function activityCartridge() {
  const source = structuredClone(loadCartridgeFixture("minimal")) as Record<
    string,
    unknown
  >;
  source["presentation"] = {
    placeholders: [{ stage: 0, text: "inspect" }],
    spinnerPools: [
      { archetype: "paranoid", stage: 0, verbs: ["Deep zero", "Deep again"] },
      { archetype: "paranoid", stage: 1, verbs: ["Deep one"] },
      { archetype: "reckless", stage: 0, verbs: ["Quick zero"] },
      { archetype: "reckless", stage: 1, verbs: ["Quick one"] },
    ],
    metrics: {
      baseTokens: 0,
      tokensPerEvent: 1,
      contextWindowTokens: 1000,
      costMicrosPerToken: 1,
      integrityStart: 100,
      integrityLossPerEvent: 1,
    },
  };
  return loadCartridge(source);
}

describe("agent replay state", () => {
  it("instantiates authored responses with stable instance-derived artifact ids", () => {
    const event = createAgentResponseEvent("authored", "turn-one");
    expect(event.version).toBe(0);
    const slice = readAgentSlice(fold([event]));

    expect(slice.messages[0]).toEqual({
      id: "turn-one/message",
      role: "agent",
      text: "Authored once, instantiated by reference.",
      responseId: "authored",
    });
    expect(slice.toolCalls[0]?.id).toBe("turn-one/tool/read");
    expect(slice.thinkingBlocks[0]?.id).toBe("turn-one/thinking/private");
    expect(slice.todos[0]?.id).toBe("turn-one/todo/inspect");
    expect(slice.responses).toEqual([
      { instanceId: "turn-one", responseId: "authored" },
    ]);
  });

  it("groups only an authored message's artifacts and leaves visitor and manual work ungrouped", () => {
    const state = fold([
      createAgentMessageEvent("visitor-one", "Inspect it."),
      createAgentToolCallAddedEvent({
        id: "manual-tool",
        title: "Manual tool",
        input: "status",
        output: "ok",
        status: "succeeded",
      }),
      createAgentResponseEvent("authored", "turn-one"),
    ]);

    expect(readAgentMessageArtifacts(state, "turn-one/message")).toEqual({
      toolCalls: [
        expect.objectContaining({
          id: "turn-one/tool/read",
          title: "Read file",
        }),
      ],
      thinkingBlocks: [
        expect.objectContaining({ id: "turn-one/thinking/private" }),
      ],
      todos: [expect.objectContaining({ id: "turn-one/todo/inspect" })],
    });
    expect(readAgentMessageArtifacts(state, "visitor-one")).toEqual({
      toolCalls: [],
      thinkingBlocks: [],
      todos: [],
    });
    expect(() => readAgentMessageArtifacts(state, "missing-message")).toThrow(
      /unknown message/,
    );
  });

  it("retains authored artifact updates while the replayed terminal changes modes", () => {
    const state = fold([
      createAgentResponseEvent("authored", "turn-one"),
      createTerminalModeEvent("tui"),
      createAgentToolCallUpdatedEvent("turn-one/tool/read", "running", ""),
      createTerminalModeEvent("bash"),
      createAgentToolCallUpdatedEvent("turn-one/tool/read", "succeeded", "ok"),
      createAgentThinkingUpdatedEvent("turn-one/thinking/private", "complete"),
      createAgentTodoUpdatedEvent("turn-one/todo/inspect", "completed"),
    ]);

    expect(readAgentMessageArtifacts(state, "turn-one/message")).toMatchObject({
      toolCalls: [{ status: "succeeded", output: "ok" }],
      thinkingBlocks: [{ status: "complete" }],
      todos: [{ status: "completed" }],
    });
  });

  it("folds every transition immutably and enforces semantic status progress", () => {
    const events = [
      createAgentMessageEvent("visitor-one", "Inspect it."),
      createAgentToolCallAddedEvent({
        id: "manual-tool",
        title: "Manual tool",
        input: "status",
        output: "",
        status: "pending",
      }),
      createAgentToolCallUpdatedEvent("manual-tool", "running", ""),
      createAgentToolCallUpdatedEvent("manual-tool", "succeeded", "ok"),
      createAgentThinkingAddedEvent({
        id: "manual-thought",
        text: "Okay.",
        status: "active",
      }),
      createAgentThinkingUpdatedEvent("manual-thought", "complete"),
      createAgentTodoAddedEvent({
        id: "manual-todo",
        text: "Inspect",
        status: "pending",
      }),
      createAgentTodoUpdatedEvent("manual-todo", "in-progress"),
      createAgentTodoUpdatedEvent("manual-todo", "completed"),
      createAgentActivityEvent({ status: "working", stage: 0 }),
    ];
    const before = fold([]);
    const after = fold(events);
    expect(readAgentSlice(before).messages).toEqual([]);
    expect(readAgentSlice(after)).toMatchObject({
      activity: { status: "working", verb: "Inspecting" },
      toolCalls: [{ status: "succeeded", output: "ok" }],
      thinkingBlocks: [{ status: "complete" }],
      todos: [{ status: "completed" }],
    });
    expect(() =>
      fold([
        createAgentTodoAddedEvent({
          id: "closed",
          text: "Done",
          status: "completed",
        }),
        createAgentTodoUpdatedEvent("closed", "in-progress"),
      ]),
    ).toThrow(/cannot transition/);
  });

  it("strictly rejects hostile and semantically inconsistent snapshots", () => {
    const state = fold([createAgentResponseEvent("authored", "turn-one")]);
    expect(restoreSnapshot(snapshot(state))).toEqual(state);
    const recorded = deserialize(snapshot(state)) as Record<string, unknown>;
    const slices = recorded["slices"] as Record<string, unknown>;
    const agent = slices["agent"] as Record<string, unknown>;
    agent["responses"] = [{ instanceId: "turn-one", responseId: "missing" }];
    expect(() => restoreSnapshot(serialize(recorded))).toThrow(
      /unknown authored response/,
    );

    const inconsistent = deserialize(snapshot(state)) as Record<
      string,
      unknown
    >;
    const inconsistentSlices = inconsistent["slices"] as Record<
      string,
      unknown
    >;
    const inconsistentAgent = inconsistentSlices["agent"] as Record<
      string,
      unknown
    >;
    const inconsistentMessage = (
      inconsistentAgent["messages"] as Record<string, unknown>[]
    )[0];
    if (inconsistentMessage === undefined) throw new Error("missing message");
    inconsistentMessage["text"] = "tampered response";
    expect(() => restoreSnapshot(serialize(inconsistent))).toThrow(
      /no matching agent message/,
    );

    for (const [field, property, value, expectation] of [
      ["toolCalls", "title", "tampered artifact", /no matching tool call/],
      ["toolCalls", "output", "tampered artifact", /no matching tool call/],
      [
        "thinkingBlocks",
        "text",
        "tampered artifact",
        /no matching thinking block/,
      ],
      ["todos", "text", "tampered artifact", /no matching todo/],
    ] as const) {
      const tampered = deserialize(snapshot(state)) as Record<string, unknown>;
      const tamperedSlices = tampered["slices"] as Record<string, unknown>;
      const tamperedAgent = tamperedSlices["agent"] as Record<string, unknown>;
      const artifact = (tamperedAgent[field] as Record<string, unknown>[])[0];
      if (artifact === undefined) throw new Error(`missing ${field}`);
      artifact[property] = value;
      expect(() => restoreSnapshot(serialize(tampered))).toThrow(expectation);
    }

    expect(() =>
      validateAgentSlice(
        {
          messages: [],
          toolCalls: [],
          thinkingBlocks: [],
          todos: [],
          activity: { status: "idle", verb: "Animating" },
          responses: [],
          focused: true,
        },
        "snapshot: slices.agent",
      ),
    ).toThrow(/unexpected field/);
  });

  it("restores authored artifacts only at reachable statuses", () => {
    const state = fold([
      createAgentResponseEvent("authored", "turn-one"),
      createAgentToolCallUpdatedEvent("turn-one/tool/read", "running", ""),
      createAgentToolCallUpdatedEvent("turn-one/tool/read", "succeeded", "ok"),
      createAgentThinkingUpdatedEvent("turn-one/thinking/private", "complete"),
      createAgentTodoUpdatedEvent("turn-one/todo/inspect", "completed"),
    ]);
    expect(restoreSnapshot(snapshot(state))).toEqual(state);
  });

  it("rejects invalid response instance ids before constructing artifacts", () => {
    const response = CARTRIDGE.story.responses[0];
    if (response === undefined) throw new Error("missing authored response");
    expect(() =>
      recordAuthoredResponse(readAgentSlice(fold([])), response, "foo/bar"),
    ).toThrow(/recorded response instance id/);
  });

  it("rejects hostile arrays before an accessor can run", () => {
    const valid = {
      messages: [],
      toolCalls: [],
      thinkingBlocks: [],
      todos: [],
      activity: { status: "idle", verb: "" },
      responses: [],
    };
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get: () => {
        throw new Error("snapshot accessor ran");
      },
    });
    const hidden: unknown[] = [];
    Object.defineProperty(hidden, "hidden", {
      enumerable: false,
      value: "not JSON",
    });
    const symbolic: unknown[] = [];
    Object.defineProperty(symbolic, Symbol("not JSON"), {
      enumerable: true,
      value: "not JSON",
    });

    for (const messages of [accessor, hidden, symbolic]) {
      expect(() =>
        validateAgentSlice({ ...valid, messages }, "snapshot.agent"),
      ).toThrow(/accessors|non-enumerable|symbol-keyed/);
    }
  });

  it("rejects hostile object fields and duplicate artifact ids in snapshots", () => {
    const base = {
      messages: [],
      toolCalls: [],
      thinkingBlocks: [],
      todos: [],
      activity: { status: "idle", verb: "" },
      responses: [],
    };
    const accessor = { ...base };
    Object.defineProperty(accessor, "messages", {
      enumerable: true,
      get: () => {
        throw new Error("snapshot accessor ran");
      },
    });
    const hidden = { ...base };
    Object.defineProperty(hidden, "messages", {
      enumerable: false,
      value: [],
    });
    const symbolic = { ...base, [Symbol("not JSON")]: true };

    for (const slice of [accessor, hidden, symbolic]) {
      expect(() => validateAgentSlice(slice, "snapshot.agent")).toThrow(
        /accessors|non-enumerable|symbol-keyed/,
      );
    }
    expect(() =>
      validateAgentSlice(
        {
          ...base,
          todos: [
            { id: "same", text: "one", status: "pending" },
            { id: "same", text: "two", status: "pending" },
          ],
        },
        "snapshot.agent",
      ),
    ).toThrow(/duplicate id/);
  });

  it("accepts exact public limits and rejects the first excess", () => {
    const messages = Array.from({ length: MAX_AGENT_MESSAGES }, (_, index) => ({
      id: `visitor-${String(index)}`,
      role: "visitor" as const,
      text: "x".repeat(MAX_AGENT_TEXT_LENGTH),
      responseId: null,
    }));
    const slice = {
      messages,
      toolCalls: [],
      thinkingBlocks: [],
      todos: [],
      activity: { status: "idle" as const, verb: "" as const },
      responses: [],
    };
    expect(validateAgentSlice(slice, "snapshot.agent")).toBe(slice);
    expect(() =>
      validateAgentSlice(
        { ...slice, messages: [...messages, messages[0]] },
        "snapshot.agent",
      ),
    ).toThrow(new RegExp(`at most ${String(MAX_AGENT_MESSAGES)} items`));
    expect(() =>
      validateAgentSlice(
        {
          ...slice,
          messages: [
            {
              id: "visitor-overlong",
              role: "visitor",
              text: "x".repeat(MAX_AGENT_TEXT_LENGTH + 1),
              responseId: null,
            },
          ],
        },
        "snapshot.agent",
      ),
    ).toThrow(/at most/);
  });

  it("counts Unicode code points at text boundaries", () => {
    const emoji = "🧱";
    const source = loadCartridgeFixture("minimal") as Record<string, unknown>;
    const story = source["story"] as Record<string, unknown>;
    const responses = story["responses"] as Record<string, unknown>[];
    const response = responses[0];
    if (response === undefined) throw new Error("fixture response is missing");
    response["text"] = emoji.repeat(MAX_AGENT_TEXT_LENGTH);
    response["toolCalls"] = [
      {
        id: "unicode",
        title: emoji.repeat(240),
        input: "",
        output: "",
        status: "pending",
      },
    ];
    const unicodeCartridge = loadCartridge(source);

    expect(() =>
      reduce({
        cartridge: unicodeCartridge,
        seed: SEED,
        events: [
          createAgentResponseEvent(
            unicodeCartridge.story.responses[0]?.id ?? "missing",
            "unicode-turn",
          ),
        ],
      }),
    ).not.toThrow();
    expect(() =>
      fold([createAgentActivityEvent({ status: "working", stage: 0 })]),
    ).not.toThrow();
  });

  it("selects and records a version-1 working verb from the active model's exact archetype/stage pool", () => {
    const activity = createAgentActivityEvent({ status: "working", stage: 1 });
    const custom = activityCartridge();
    const deep = reduce({ cartridge: custom, seed: SEED, events: [activity] });
    const quick = reduce({
      cartridge: custom,
      seed: SEED,
      events: [createTerminalModelEvent("quick-patch"), activity],
    });

    expect(activity).toEqual({
      type: "agent.activity-set",
      payload: { status: "working", stage: 1 },
      version: 1,
    });
    expect(readAgentSlice(deep).activity).toEqual({
      status: "working",
      verb: "Deep one",
    });
    expect(readAgentSlice(quick).activity).toEqual({
      status: "working",
      verb: "Quick one",
    });
    expect(deep.transcript.at(-1)?.summary).toContain('verb="Deep one"');
  });

  it("keeps model-scoped spinner draws isolated from other model switches and persists them through snapshots", () => {
    const custom = activityCartridge();
    const working = createAgentActivityEvent({ status: "working", stage: 0 });
    const state = reduce({
      cartridge: custom,
      seed: SEED,
      events: [
        working,
        {
          type: "probe.random",
          payload: { stream: "unrelated", count: 1, form: "uint32" },
        },
        createTerminalModelEvent("quick-patch"),
        working,
        createTerminalModelEvent("deep-foundation"),
        working,
      ],
    });
    const deepVerbs = ["Deep zero", "Deep again"];
    const deepSpinner = forkModelStream(
      createRandom(SEED).fork("agent"),
      "deep-foundation",
    ).fork("spinner.verbs");
    const expectedDeep = [
      deepSpinner.pick(deepVerbs),
      deepSpinner.pick(deepVerbs),
    ];

    expect(readAgentSlice(state).activity).toEqual({
      status: "working",
      verb: expectedDeep[1],
    });
    expect(Object.keys(state.random.cursors)).toContain(
      "root/agent/models/deep-foundation/spinner.verbs",
    );
    expect(Object.keys(state.random.cursors)).toContain(
      "root/agent/models/quick-patch/spinner.verbs",
    );
    expect(Object.keys(state.random.cursors)).toContain("root/probe/unrelated");
    expect(restoreSnapshot(snapshot(state))).toEqual(state);
  });

  it("does not draw for idle activity and rejects a working stage without an authored pool", () => {
    const custom = activityCartridge();
    const idle = reduce({
      cartridge: custom,
      seed: SEED,
      events: [createAgentActivityEvent({ status: "idle" })],
    });

    expect(readAgentSlice(idle).activity).toEqual({ status: "idle", verb: "" });
    expect(Object.keys(idle.random.cursors)).not.toContain(
      "root/agent/models/deep-foundation/spinner.verbs",
    );
    expect(() =>
      reduce({
        cartridge: custom,
        seed: SEED,
        events: [createAgentActivityEvent({ status: "working", stage: 2 })],
      }),
    ).toThrow(/no spinner pool for archetype "paranoid" at stage 2/);
  });
});
