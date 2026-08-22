import { describe, expect, it } from "vitest";

import { loadCartridge } from "../cartridge/load.js";
import { deserialize, serialize } from "../serialize/canonical.js";
import { reduce, restoreSnapshot, snapshot } from "../events/reduce.js";
import type { EngineEvent } from "../events/state.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
import {
  MAX_AGENT_ACTIVITY_VERB_LENGTH,
  MAX_AGENT_MESSAGES,
  MAX_AGENT_TEXT_LENGTH,
  readAgentSlice,
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
  story["opening"] = { login: ["Fixture login."], response: "authored" };
  story["intents"] = [
    { id: "fixture-intent", patterns: ["inspect"], response: "authored" },
  ];
  story["fallback"] = { response: "authored" };
  story["helpResponse"] = "authored";
  story["compactResponse"] = "authored";
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
      createAgentActivityEvent({ status: "working", verb: "Surveying" }),
    ];
    const before = fold([]);
    const after = fold(events);
    expect(readAgentSlice(before).messages).toEqual([]);
    expect(readAgentSlice(after)).toMatchObject({
      activity: { status: "working", verb: "Surveying" },
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
      fold([
        createAgentActivityEvent({
          status: "working",
          verb: emoji.repeat(MAX_AGENT_ACTIVITY_VERB_LENGTH),
        }),
      ]),
    ).not.toThrow();
  });
});
