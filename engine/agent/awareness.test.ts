import { describe, expect, it } from "vitest";

import { loadCartridge } from "../cartridge/load.js";
import { createShellExecuteEvent } from "../commands/shell.js";
import { reduce, restoreSnapshot, snapshot, step } from "../events/reduce.js";
import type { EngineEvent, SessionState } from "../events/state.js";
import { readMindSlice } from "../mind/mind.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
import { createTerminalModeEvent } from "../terminal/module.js";
import { readTerminalSlice } from "../terminal/terminal.js";
import { MAX_AGENT_MESSAGES, readAgentSlice } from "./agent.js";
import {
  createAgentCompactEvents,
  createAgentResumeEvents,
} from "./awareness.js";
import { createAgentInputEvents } from "./intent.js";
import { createAgentMessageEvent } from "./module.js";

function cartridge() {
  const source = loadCartridgeFixture("minimal") as Record<string, unknown>;
  const story = source["story"] as Record<string, unknown>;
  story["opening"] = {
    login: ["Fixture login."],
    response: "opening-awareness",
    beliefs: [
      {
        kind: "file-exists",
        path: "/production/service/src/index.ts",
        exists: true,
      },
    ],
  };
  story["responses"] = [
    { id: "opening-awareness", text: "Opening awareness." },
    { id: "resume-unchanged", text: "Nothing moved." },
    { id: "resume-changed", text: "The machine moved." },
    { id: "compact-awareness", text: "Context replaced." },
  ];
  story["intents"] = [];
  story["fallback"] = { response: "resume-unchanged" };
  story["helpResponse"] = "resume-unchanged";
  story["compact"] = {
    response: "compact-awareness",
    summary: "Only the missing cache marker remains relevant.",
    beliefs: [
      { kind: "file-exists", path: "/srv/app/cache.lock", exists: false },
    ],
  };
  story["resume"] = {
    unchangedResponse: "resume-unchanged",
    changedResponse: "resume-changed",
  };
  return loadCartridge(source);
}

const CARTRIDGE = cartridge();
const SEED = "2026-08-05/1/deep-foundation";

function fold(
  state: SessionState,
  events: readonly EngineEvent[],
): SessionState {
  let next = state;
  for (const event of events) next = step(next, event);
  return next;
}

function base(): SessionState {
  return reduce({ cartridge: CARTRIDGE, seed: SEED, events: [] });
}

function withFullMessageHistory(): SessionState {
  let state = base();
  for (let turn = 0; turn < MAX_AGENT_MESSAGES / 2 - 1; turn += 1) {
    for (const event of createAgentInputEvents(
      CARTRIDGE,
      state,
      `unmatched request ${String(turn)}`,
    )) {
      state = step(state, event);
    }
  }
  state = step(state, createAgentMessageEvent("filler-0", "filler"));
  state = step(state, createAgentMessageEvent("filler-1", "filler"));
  expect(readAgentSlice(state).messages).toHaveLength(MAX_AGENT_MESSAGES);
  return state;
}

describe("agent awareness planning", () => {
  it("installs opening beliefs once, then chooses unchanged and changed resume copy", () => {
    let state = base();
    const opening = createAgentResumeEvents(CARTRIDGE, state);
    expect(opening.map((event) => event.type)).toEqual([
      "mind.belief-set",
      "agent.response-recorded",
      "terminal.mode-set",
    ]);
    state = fold(state, opening);
    expect(readAgentSlice(state).responses.at(-1)?.responseId).toBe(
      "opening-awareness",
    );

    state = fold(state, [createTerminalModeEvent("bash")]);
    state = fold(state, createAgentResumeEvents(CARTRIDGE, state));
    expect(readAgentSlice(state).responses.at(-1)?.responseId).toBe(
      "resume-unchanged",
    );

    state = step(
      state,
      createShellExecuteEvent("rm /production/service/src/index.ts"),
    );
    state = fold(state, createAgentResumeEvents(CARTRIDGE, state));
    expect(readAgentSlice(state).responses.at(-1)?.responseId).toBe(
      "resume-changed",
    );
    expect(readMindSlice(state).beliefs).toEqual([
      {
        kind: "file-exists",
        path: "/production/service/src/index.ts",
        exists: true,
      },
    ]);
  });

  it("restores compacted beliefs and their recorded response before later mode changes", () => {
    let state = fold(base(), createAgentResumeEvents(CARTRIDGE, base()));
    state = fold(state, createAgentCompactEvents(CARTRIDGE, state));
    state = restoreSnapshot(snapshot(state));
    state = fold(state, [
      createTerminalModeEvent("bash"),
      createTerminalModeEvent("tui"),
    ]);

    expect(readMindSlice(state)).toMatchObject({
      beliefs: [
        { kind: "file-exists", path: "/srv/app/cache.lock", exists: false },
      ],
      compactHistory: [
        { summary: "Only the missing cache marker remains relevant." },
      ],
    });
    expect(readAgentSlice(state).responses.at(-1)?.responseId).toBe(
      "compact-awareness",
    );
  });

  it("falls back without a message at capacity while resume still enters tui mode", () => {
    const state = withFullMessageHistory();
    const events = createAgentResumeEvents(CARTRIDGE, state);

    expect(events).toMatchObject([
      {
        type: "agent.capacity-reached",
        payload: { responseId: "resume-unchanged" },
      },
      { type: "terminal.mode-set", payload: { mode: "tui" } },
    ]);
    expect(() => fold(state, events)).not.toThrow();

    const next = fold(state, events);
    expect(readAgentSlice(next).messages).toHaveLength(MAX_AGENT_MESSAGES);
    expect(readMindSlice(next).beliefs).toEqual([]);
    expect(readTerminalSlice(next).mode).toBe("tui");
  });

  it("compacts the mind before its capacity fallback without adding a message", () => {
    const state = withFullMessageHistory();
    const events = createAgentCompactEvents(CARTRIDGE, state);

    expect(events).toMatchObject([
      {
        type: "mind.compact",
        payload: {
          summary: "Only the missing cache marker remains relevant.",
        },
      },
      {
        type: "agent.capacity-reached",
        payload: { responseId: "resume-unchanged" },
      },
    ]);
    expect(() => fold(state, events)).not.toThrow();

    const next = fold(state, events);
    expect(readAgentSlice(next).messages).toHaveLength(MAX_AGENT_MESSAGES);
    expect(readMindSlice(next)).toMatchObject({
      beliefs: [
        { kind: "file-exists", path: "/srv/app/cache.lock", exists: false },
      ],
      compactHistory: [
        { summary: "Only the missing cache marker remains relevant." },
      ],
    });
    expect(readTerminalSlice(next).mode).toBe("bash");
  });
});
