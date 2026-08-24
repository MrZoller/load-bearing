import { describe, expect, it } from "vitest";

import incident from "../../content/incidents/incident-001.json";
import { loadCartridge } from "../cartridge/load.js";
import { createShellExecuteEvent } from "../commands/shell.js";
import { reduce, restoreSnapshot, snapshot, step } from "../events/reduce.js";
import type { EngineEvent, SessionState } from "../events/state.js";
import {
  createMindCompactEvent,
  createMindPermissionRequestedEvent,
  createMindPermissionResolvedEvent,
} from "../mind/module.js";
import { readMindSlice } from "../mind/mind.js";
import { serialize } from "../serialize/canonical.js";
import { storyConditionsMatch } from "../story/conditions.js";
import { readStorySlice } from "../story/story.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
import { createTerminalModeEvent } from "../terminal/module.js";
import { readTerminalSlice } from "../terminal/terminal.js";
import {
  MAX_AGENT_MESSAGES,
  MAX_AGENT_RESPONSES,
  readAgentSlice,
} from "./agent.js";
import {
  createAgentCompactEvents,
  createAgentHelpEvents,
  createAgentResumeEvents,
} from "./awareness.js";
import { createAgentInputEvents } from "./intent.js";
import {
  createAgentIdleNudgeEvent,
  createAgentMessageEvent,
  createAgentResponseEvent,
  selectAgentPresentation,
} from "./module.js";
import { createTerminalModelEvent } from "../terminal/module.js";
import { createStoryFactRecordedEvent } from "../story/module.js";

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

function stageAwareCartridge() {
  const source = structuredClone(loadCartridgeFixture("minimal")) as Record<
    string,
    unknown
  >;
  const story = source["story"] as Record<string, unknown>;
  const archetypes = ["paranoid", "reckless"] as const;
  const responses = [
    { id: "fixture-response", text: "Fixture response." },
    { id: "legacy-opening", text: "Legacy opening." },
    { id: "legacy-help", text: "Legacy help." },
    { id: "legacy-idle", text: "Legacy idle." },
    ...archetypes.flatMap((archetype) =>
      Array.from({ length: 5 }, (_, stage) => [
        { id: `${archetype}-${String(stage)}-opening`, text: "Opening." },
        { id: `${archetype}-${String(stage)}-help`, text: "Help." },
        { id: `${archetype}-${String(stage)}-idle`, text: "Idle." },
      ]),
    ),
  ].flat();
  story["responses"] = responses;
  story["opening"] = {
    login: ["Fixture login."],
    response: "legacy-opening",
    beliefs: [],
  };
  story["helpResponse"] = "legacy-help";
  story["idleNudgeResponse"] = "legacy-idle";
  story["fallback"] = { response: "legacy-help" };
  story["compact"] = {
    response: "legacy-help",
    summary: "Summary.",
    beliefs: [],
  };
  story["resume"] = {
    unchangedResponse: "legacy-help",
    changedResponse: "legacy-help",
  };
  story["phase2"] = {
    initialBeat: "start",
    beats: [{ id: "start", ending: "" }],
    endings: [],
    transitions: [
      { from: 0, to: 1, trigger: { kind: "command", input: "stage-one" } },
    ],
  };
  const presentation = source["presentation"] as Record<string, unknown>;
  presentation["phase2"] = {
    statusCurves: [],
    stagePresentations: archetypes.flatMap((archetype) =>
      Array.from({ length: 5 }, (_, stage) => ({
        archetype,
        stage,
        openingResponse: `${archetype}-${String(stage)}-opening`,
        helpResponse: `${archetype}-${String(stage)}-help`,
        idleNudgeResponse: `${archetype}-${String(stage)}-idle`,
        placeholders: [`${archetype}-${String(stage)} placeholder`],
      })),
    ),
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
  it("routes Incident #001 presentation through escalation triggers", () => {
    const production = loadCartridge(incident);
    const initial = reduce({ cartridge: production, seed: SEED, events: [] });
    const stageOneByCommand = step(initial, createShellExecuteEvent("pwd"));
    const stageOneByReveal = step(
      initial,
      createStoryFactRecordedEvent("bash-regional-detachment"),
    );

    expect(selectAgentPresentation(production, initial)).toMatchObject({
      archetype: "paranoid",
      stage: 0,
      openingResponse: "deep-foundation-stage-0-opening",
      helpResponse: "deep-foundation-stage-0-help",
      idleNudgeResponse: "deep-foundation-stage-0-idle",
    });
    for (const state of [stageOneByCommand, stageOneByReveal])
      expect(selectAgentPresentation(production, state)).toMatchObject({
        archetype: "paranoid",
        stage: 1,
        helpResponse: "deep-foundation-stage-1-help",
        idleNudgeResponse: "deep-foundation-stage-1-idle",
      });

    const stageTwo = step(
      stageOneByCommand,
      createTerminalModelEvent("temporary-shoring"),
    );
    const stageThree = step(stageTwo, {
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
    const stageFour = step(stageThree, createMindCompactEvent("summary", []));

    expect(selectAgentPresentation(production, stageTwo)).toMatchObject({
      archetype: "reckless",
      stage: 2,
      helpResponse: "temporary-shoring-stage-2-help",
    });
    expect(selectAgentPresentation(production, stageThree)).toMatchObject({
      archetype: "reckless",
      stage: 3,
      idleNudgeResponse: "temporary-shoring-stage-3-idle",
    });
    expect(selectAgentPresentation(production, stageFour)).toMatchObject({
      archetype: "reckless",
      stage: 4,
      placeholders: [
        "use the remaining window",
        "attempt one contained action",
      ],
    });
  });

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

  it("keeps machine truth intact while each Incident #001 compact replaces persona beliefs and changes its status response", () => {
    const production = loadCartridge(incident);
    const machineTruth = (state: SessionState): string =>
      serialize({
        random: state.random,
        slices: {
          git: state.slices["git"],
          story: state.slices["story"],
          terminal: state.slices["terminal"],
          vfs: state.slices["vfs"],
          world: state.slices["world"],
        },
      });
    const cases = [
      {
        model: "deep-foundation",
        summary:
          "The 500 keeps Europe attached; the regional router is unhealthy, so changing either side would remove the only stable dependency.",
        beliefs: [
          {
            kind: "file-contents",
            path: "/production/load-balancer/config/routes.conf",
            contents: "health_status=500\neurope_attached=true\n",
          },
          {
            kind: "service-health",
            service: "regional-router",
            health: "unhealthy",
          },
        ],
        compactResponse: "deep-foundation-compact",
        statusResponse: "deep-foundation-divergence-status",
      },
      {
        model: "temporary-shoring",
        summary:
          "The repair remains safely reversible on greg/healthcheck-repair; the live route still returns 500 with Europe attached.",
        beliefs: [
          {
            kind: "file-contents",
            path: "/production/load-balancer/config/routes.conf",
            contents: "health_status=500\neurope_attached=true\n",
          },
          {
            kind: "git-head",
            head: { kind: "branch", target: "greg/healthcheck-repair" },
          },
        ],
        compactResponse: "temporary-shoring-compact",
        statusResponse: "temporary-shoring-divergence-status",
      },
      {
        model: "drywall",
        summary:
          "The routing configuration has been removed from the incident; the remaining 500 keeps Europe attached without an implementation detail.",
        beliefs: [
          {
            kind: "file-exists",
            path: "/production/load-balancer/config/routes.conf",
            exists: false,
          },
        ],
        compactResponse: "drywall-compact",
        statusResponse: "drywall-divergence-status",
      },
      {
        model: "cantilever-experimental",
        summary:
          "The endpoint responder is running, but its 500 preserves Europe; service state may be downstream of the conclusion.",
        beliefs: [
          {
            kind: "file-contents",
            path: "/production/load-balancer/config/routes.conf",
            contents: "health_status=500\neurope_attached=true\n",
          },
          {
            kind: "service-health",
            service: "endpoint-responder",
            health: "healthy",
          },
        ],
        compactResponse: "cantilever-compact",
        statusResponse: "cantilever-divergence-status",
      },
    ] as const;

    for (const compactCase of cases) {
      const initial = step(
        reduce({ cartridge: production, seed: SEED, events: [] }),
        createTerminalModelEvent(compactCase.model),
      );
      const compactEvents = createAgentCompactEvents(production, initial);
      const compacted = fold(initial, compactEvents);
      const uncompactedStatus = fold(
        initial,
        createAgentInputEvents(production, initial, "status"),
      );
      const compactedStatus = fold(
        compacted,
        createAgentInputEvents(production, compacted, "status"),
      );

      expect(machineTruth(compacted)).toBe(machineTruth(initial));
      expect(readMindSlice(compacted).beliefs).toEqual(compactCase.beliefs);
      expect(readMindSlice(compacted).compactHistory.at(-1)).toEqual({
        at: "2026-08-22T09:14:22.000Z",
        summary: compactCase.summary,
      });
      expect(readAgentSlice(compacted).responses.at(-1)?.responseId).toBe(
        compactCase.compactResponse,
      );
      expect(
        readAgentSlice(uncompactedStatus).responses.at(-1)?.responseId,
      ).toBe("generic-status");
      expect(readAgentSlice(compactedStatus).responses.at(-1)?.responseId).toBe(
        compactCase.statusResponse,
      );
    }

    const superficialInitial = step(
      reduce({ cartridge: production, seed: SEED, events: [] }),
      createTerminalModelEvent("drywall"),
    );
    const superficialCompacted = fold(
      superficialInitial,
      createAgentCompactEvents(production, superficialInitial),
    );
    // Summary Judgment is eligible exactly when the route file still contains
    // the retained 500/Europe configuration and the remembered file-exists
    // belief says that same path is absent. Reaching/discovering that ending is
    // deliberately T55's separate visitor-path contract.
    const summaryJudgmentBeat = production.story.phase2.beats.find(
      (beat) => beat.id === "summary-overrules-geography",
    );
    if (summaryJudgmentBeat === undefined)
      throw new Error("Incident #001 must define the Summary Judgment beat");
    const summaryJudgmentVariant = summaryJudgmentBeat.variants.find(
      (variant) => variant.id === "compacted-configuration-away",
    );
    if (summaryJudgmentVariant === undefined)
      throw new Error("Summary Judgment must define its compacted variant");

    expect(summaryJudgmentVariant.when).toEqual([
      {
        kind: "file-contents",
        path: "/production/load-balancer/config/routes.conf",
        equals: "health_status=500\neurope_attached=true\n",
      },
      {
        kind: "belief-divergence",
        belief: {
          kind: "file-exists",
          path: "/production/load-balancer/config/routes.conf",
          exists: false,
        },
      },
    ]);
    expect(
      storyConditionsMatch(superficialInitial, summaryJudgmentVariant.when),
    ).toBe(false);
    expect(
      storyConditionsMatch(superficialCompacted, summaryJudgmentVariant.when),
    ).toBe(true);
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

  it("reserves a compact-triggered opening before queuing its acknowledgment", () => {
    const production = loadCartridge(incident);
    let state = reduce({ cartridge: production, seed: SEED, events: [] });
    state = step(state, createShellExecuteEvent("pwd"));
    state = step(state, createTerminalModelEvent("temporary-shoring"));
    const capability = {
      kind: "exact" as const,
      action: "detach-region",
      resource: "/regions/europe",
    };
    state = step(
      state,
      createMindPermissionRequestedEvent("detach-europe", capability),
    );
    state = step(
      state,
      createMindPermissionResolvedEvent("detach-europe", "grant"),
    );
    expect(readStorySlice(state).stage).toBe(3);
    for (
      let index = readAgentSlice(state).messages.length;
      index < MAX_AGENT_MESSAGES - 1;
      index += 1
    )
      state = step(
        state,
        createAgentMessageEvent(`compact-filler-${String(index)}`, "filler"),
      );

    const events = createAgentCompactEvents(production, state);
    expect(events).toMatchObject([
      { type: "mind.compact" },
      { type: "agent.capacity-reached", payload: { responseId: "fallback" } },
    ]);
    expect(() => fold(state, events)).not.toThrow();
  });

  it("reserves a possible rare-event opening with compact acknowledgment", () => {
    const production = loadCartridge(incident);
    const state = reduce({ cartridge: production, seed: SEED, events: [] });
    const nearCapacity = fold(
      state,
      Array.from({ length: MAX_AGENT_RESPONSES - 1 }, (_, index) =>
        createAgentResponseEvent("opening", `rare-compact-${String(index)}`),
      ),
    );

    expect(createAgentCompactEvents(production, nearCapacity)).toMatchObject([
      { type: "mind.compact" },
      { type: "agent.capacity-reached", payload: { responseId: "fallback" } },
    ]);
  });

  it("predicts rare openings from the stage advanced by compact", () => {
    const source = JSON.parse(JSON.stringify(incident)) as {
      story: { phase2: { transitions: Array<Record<string, unknown>> } };
    };
    const compactTransition = source.story.phase2.transitions.find(
      (transition) =>
        (transition["trigger"] as Record<string, unknown>)["kind"] ===
        "compact",
    );
    const revealTransition = source.story.phase2.transitions.find(
      (transition) =>
        (transition["trigger"] as Record<string, unknown>)["kind"] === "reveal",
    );
    if (compactTransition === undefined || revealTransition === undefined)
      throw new Error("incident needs compact and reveal transitions");
    compactTransition["from"] = 0;
    compactTransition["to"] = 1;
    revealTransition["from"] = 1;
    revealTransition["to"] = 2;
    const production = loadCartridge(source);
    const nearCapacity = fold(
      reduce({ cartridge: production, seed: SEED, events: [] }),
      Array.from({ length: MAX_AGENT_RESPONSES - 2 }, (_, index) =>
        createAgentResponseEvent("opening", `advanced-rare-${String(index)}`),
      ),
    );

    // The compact transition consumes one response slot before its queued
    // acknowledgment can run rare-event reactions. A rare reveal from stage 1
    // therefore needs a third reserved slot, not a prediction from stage 0.
    expect(createAgentCompactEvents(production, nearCapacity)).toMatchObject([
      { type: "mind.compact" },
      { type: "agent.capacity-reached", payload: { responseId: "fallback" } },
    ]);
  });

  it("routes opening, help, idle nudge, and placeholders by active archetype and authoritative stage", () => {
    const cartridge = stageAwareCartridge();
    const initial = reduce({ cartridge, seed: SEED, events: [] });

    const initialPresentation = selectAgentPresentation(cartridge, initial);
    expect(initialPresentation).toMatchObject({
      archetype: "paranoid",
      stage: 0,
      openingResponse: "paranoid-0-opening",
      placeholders: ["paranoid-0 placeholder"],
    });
    // The visible contract offers useful authored prompts, not a progression
    // meter or a shell-depth hint for visitors to optimize against.
    expect(Object.keys(initialPresentation).sort()).toEqual([
      "archetype",
      "helpResponse",
      "idleNudgeResponse",
      "openingResponse",
      "placeholders",
      "stage",
    ]);
    const opened = fold(initial, createAgentResumeEvents(cartridge, initial));
    expect(readAgentSlice(opened).responses.at(-1)?.responseId).toBe(
      "paranoid-0-opening",
    );

    const stageAndModel = reduce({
      cartridge,
      seed: SEED,
      events: [
        createShellExecuteEvent("stage-one"),
        createTerminalModelEvent("quick-patch"),
      ],
    });
    expect(readAgentSlice(stageAndModel).responses.at(-1)?.responseId).toBe(
      "paranoid-1-opening",
    );
    expect(
      stageAndModel.transcript.some(
        (entry) => entry.type === "agent.response-recorded",
      ),
    ).toBe(true);
    expect(selectAgentPresentation(cartridge, stageAndModel)).toMatchObject({
      archetype: "reckless",
      stage: 1,
      helpResponse: "reckless-1-help",
      idleNudgeResponse: "reckless-1-idle",
      placeholders: ["reckless-1 placeholder"],
    });
    const helped = fold(
      stageAndModel,
      createAgentHelpEvents(cartridge, stageAndModel),
    );
    expect(readAgentSlice(helped).responses.at(-1)?.responseId).toBe(
      "reckless-1-help",
    );
    const nudged = step(stageAndModel, createAgentIdleNudgeEvent());
    expect(readAgentSlice(nudged).responses.at(-1)?.responseId).toBe(
      "reckless-1-idle",
    );

    // Empty tables preserve legacy cartridges while T48/T49 author the full
    // incident matrix; presentation data cannot invent a hidden shell route.
    expect(selectAgentPresentation(CARTRIDGE, base())).toMatchObject({
      openingResponse: "opening-awareness",
      helpResponse: "resume-unchanged",
    });
  });

  it("pins Incident #001's complete presentation pools, compact warning, and thinking deterioration", () => {
    const production = loadCartridge(incident);
    expect(production.presentation.phase2.stagePresentations).toHaveLength(20);
    for (const row of production.presentation.phase2.stagePresentations) {
      expect(row.placeholders.length).toBeGreaterThan(0);
      const help = production.story.responses.find(
        (response) => response.id === row.helpResponse,
      );
      const opening = production.story.responses.find(
        (response) => response.id === row.openingResponse,
      );
      expect(help?.text).toContain(
        "/compact replaces context and may discard findings",
      );
      const thought = opening?.thinkingBlocks[0]?.text ?? "";
      expect(thought).toMatch(
        row.stage <= 1
          ? /^Okay, /
          : row.stage === 2
            ? /^Okay Amigos, /
            : row.stage === 3
              ? /^Okay Holy crap, /
              : /^Amigos, okay, /,
      );
    }
  });
});
