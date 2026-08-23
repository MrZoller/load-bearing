import { describe, expect, it } from "vitest";

import { loadCartridge } from "../cartridge/load.js";
import { reduce } from "../events/reduce.js";
import type { EngineEvent, SessionState } from "../events/state.js";
import {
  createMindCompactEvent,
  createMindWaiverConsentRecordedEvent,
} from "../mind/module.js";
import { createTerminalModelEvent } from "../terminal/module.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
import { createStoryFactRecordedEvent } from "./module.js";
import { createStoryBeatReachedEvent } from "./module.js";
import {
  storyConditionMatches,
  storyStageTriggerMatches,
} from "./conditions.js";
import type { StoryCondition } from "./types.js";

const SEED = "2026-08-05/0/deep-foundation";
const CAPABILITY = {
  kind: "exact" as const,
  action: "write",
  resource: "/etc/motd",
};
const WAIVER = {
  id: "emergency-waiver",
  version: 1,
  phrase: "I accept the load-bearing consequence.",
  capability: CAPABILITY,
};

function state(events: readonly EngineEvent[] = []): SessionState {
  const source = loadCartridgeFixture("minimal") as Record<string, unknown>;
  const repository = source["repository"] as Record<string, unknown>;
  repository["services"] = [
    {
      id: "api",
      state: "running",
      health: "healthy",
      ports: [],
      dependencies: [],
    },
  ];
  (source["story"] as Record<string, unknown>)["phase2"] = {
    initialBeat: "start",
    facts: [{ id: "revealed", kind: "reveal" }],
    beats: [{ id: "start", ending: "", facts: [], variants: [] }],
    endings: [],
  };
  return reduce({ cartridge: loadCartridge(source), seed: SEED, events });
}

describe("closed story conditions", () => {
  it("matches and rejects each authored condition shape, including absent truth", () => {
    const withEvidence = state([
      {
        type: "mind.belief-set",
        payload: {
          belief: { kind: "file-exists", path: "/etc/motd", exists: true },
        },
      },
      createMindWaiverConsentRecordedEvent(WAIVER),
      createStoryFactRecordedEvent("revealed"),
    ]);
    const cases: readonly (readonly [
      StoryCondition,
      StoryCondition,
      StoryCondition,
    ])[] = [
      [
        { kind: "file-exists", path: "/etc/motd", exists: true },
        { kind: "file-exists", path: "/etc/motd", exists: false },
        { kind: "file-exists", path: "/missing", exists: true },
      ],
      [
        {
          kind: "file-contents",
          path: "/etc/motd",
          equals: "This system is load-bearing.\n",
        },
        { kind: "file-contents", path: "/etc/motd", equals: "wrong" },
        { kind: "file-contents", path: "/missing", equals: "anything" },
      ],
      [
        { kind: "service-state", service: "api", state: "running" },
        { kind: "service-state", service: "api", state: "stopped" },
        { kind: "service-state", service: "missing", state: "running" },
      ],
      [
        { kind: "service-health", service: "api", health: "healthy" },
        { kind: "service-health", service: "api", health: "unhealthy" },
        { kind: "service-health", service: "missing", health: "healthy" },
      ],
      [
        {
          kind: "belief",
          belief: { kind: "file-exists", path: "/etc/motd", exists: true },
        },
        {
          kind: "belief",
          belief: { kind: "file-exists", path: "/etc/motd", exists: false },
        },
        {
          kind: "belief",
          belief: { kind: "file-exists", path: "/missing", exists: true },
        },
      ],
      [
        { kind: "waiver-consent", ...WAIVER },
        { kind: "waiver-consent", ...WAIVER, phrase: "different words" },
        { kind: "waiver-consent", ...WAIVER, id: "missing-waiver" },
      ],
      [
        { kind: "story-fact", fact: "revealed", factKind: "reveal" },
        { kind: "story-fact", fact: "revealed", factKind: "callback" },
        { kind: "story-fact", fact: "missing", factKind: "reveal" },
      ],
    ];

    for (const [match, mismatch, missing] of cases) {
      expect(storyConditionMatches(withEvidence, match), match.kind).toBe(true);
      expect(storyConditionMatches(withEvidence, mismatch), mismatch.kind).toBe(
        false,
      );
      expect(storyConditionMatches(withEvidence, missing), missing.kind).toBe(
        false,
      );
    }
  });

  it("evaluates file facts against VFS truth when the shell cannot read them", () => {
    const source = loadCartridgeFixture("minimal") as Record<string, unknown>;
    const repository = source["repository"] as Record<string, unknown>;
    const files = repository["files"] as Record<string, unknown>;
    const unreadable = reduce({
      cartridge: loadCartridge({
        ...source,
        repository: {
          ...repository,
          identity: {
            user: "greg",
            group: "departed",
            home: "/home/greg",
            umask: "0022",
          },
          files: {
            ...files,
            "/etc/motd": {
              ...(files["/etc/motd"] as Record<string, unknown>),
              mode: "0400",
            },
          },
        },
      }),
      seed: SEED,
      events: [],
    });

    expect(
      storyConditionMatches(unreadable, {
        kind: "file-exists",
        path: "/etc/motd",
        exists: true,
      }),
    ).toBe(true);
    expect(
      storyConditionMatches(unreadable, {
        kind: "file-contents",
        path: "/etc/motd",
        equals: "This system is load-bearing.\n",
      }),
    ).toBe(true);
  });

  it("requires exact belief shapes and keeps permissions separate from waiver consent", () => {
    const withGrant = state([
      {
        type: "mind.permission-decision",
        payload: { capability: CAPABILITY, decision: "always-allow" },
      },
      {
        type: "mind.belief-set",
        payload: {
          belief: { kind: "git-head", head: { kind: "detached", target: "" } },
        },
      },
    ]);

    expect(
      storyConditionMatches(withGrant, { kind: "waiver-consent", ...WAIVER }),
    ).toBe(false);
    expect(
      storyConditionMatches(withGrant, {
        kind: "belief",
        belief: { kind: "git-head", head: { kind: "detached", target: "" } },
      }),
    ).toBe(true);
    expect(
      storyConditionMatches(withGrant, {
        kind: "belief",
        belief: { kind: "git-head", head: { kind: "branch", target: "main" } },
      }),
    ).toBe(false);
  });

  it("does not let a waiver condition widen its recorded capability", () => {
    const withConsent = state([createMindWaiverConsentRecordedEvent(WAIVER)]);

    expect(
      storyConditionMatches(withConsent, {
        kind: "waiver-consent",
        ...WAIVER,
        capability: { ...CAPABILITY, action: "delete" },
      }),
    ).toBe(false);
    expect(
      storyConditionMatches(withConsent, {
        kind: "waiver-consent",
        ...WAIVER,
        capability: { ...CAPABILITY, resource: "/etc/shadow" },
      }),
    ).toBe(false);
  });

  it("does not blur divergence-relevant belief subjects or values", () => {
    const beliefs = [
      { kind: "file-exists", path: "/etc/motd", exists: true },
      {
        kind: "file-contents",
        path: "/etc/motd",
        contents: "This system is load-bearing.\n",
      },
      { kind: "service-state", service: "api", state: "running" },
      { kind: "service-health", service: "api", health: "healthy" },
    ] as const;
    const withBeliefs = state(
      beliefs.map((belief) => ({
        type: "mind.belief-set",
        payload: { belief },
      })),
    );
    for (const belief of beliefs) {
      expect(
        storyConditionMatches(withBeliefs, { kind: "belief", belief }),
      ).toBe(true);
    }
    expect(
      storyConditionMatches(withBeliefs, {
        kind: "belief-divergence",
        belief: { kind: "file-exists", path: "/etc/motd", exists: true },
      }),
    ).toBe(false);
    expect(
      storyConditionMatches(withBeliefs, {
        kind: "belief",
        belief: { kind: "file-contents", path: "/etc/motd", contents: "wrong" },
      }),
    ).toBe(false);
    expect(
      storyConditionMatches(withBeliefs, {
        kind: "belief",
        belief: { kind: "service-health", service: "api", health: "unhealthy" },
      }),
    ).toBe(false);
  });

  it("evaluates equal and at-least conditions against the declared story counter", () => {
    const source = loadCartridgeFixture("minimal") as Record<string, unknown>;
    (source["story"] as Record<string, unknown>)["phase2"] = {
      initialBeat: "start",
      counters: [{ id: "attempts", initial: 1, maximum: 3 }],
      beats: [
        {
          id: "start",
          ending: "",
          actions: [{ kind: "counter-add", counter: "attempts", amount: 1 }],
        },
      ],
      endings: [],
    };
    const before = reduce({
      cartridge: loadCartridge(source),
      seed: SEED,
      events: [],
    });
    const after = reduce({
      cartridge: loadCartridge(source),
      seed: SEED,
      events: [createStoryBeatReachedEvent("start")],
    });

    expect(
      storyConditionMatches(before, {
        kind: "story-counter",
        counter: "attempts",
        comparison: "equal",
        value: 1,
      }),
    ).toBe(true);
    expect(
      storyConditionMatches(after, {
        kind: "story-counter",
        counter: "attempts",
        comparison: "equal",
        value: 1,
      }),
    ).toBe(false);
    expect(
      storyConditionMatches(after, {
        kind: "story-counter",
        counter: "attempts",
        comparison: "equal",
        value: 2,
      }),
    ).toBe(true);
    expect(
      storyConditionMatches(after, {
        kind: "story-counter",
        counter: "attempts",
        comparison: "at-least",
        value: 2,
      }),
    ).toBe(true);
    expect(
      storyConditionMatches(after, {
        kind: "story-counter",
        counter: "attempts",
        comparison: "at-least",
        value: 3,
      }),
    ).toBe(false);
  });
});

describe("closed escalation triggers", () => {
  const shell = (input: string): EngineEvent => ({
    type: "shell.execute",
    payload: { input },
  });

  it("matches only the exact command envelope", () => {
    const snapshot = state();
    const trigger = { kind: "command" as const, input: "cat /etc/motd" };

    expect(
      storyStageTriggerMatches(
        trigger,
        snapshot,
        snapshot,
        shell("cat /etc/motd"),
      ),
    ).toBe(true);
    expect(
      storyStageTriggerMatches(trigger, snapshot, snapshot, shell("pwd")),
    ).toBe(false);
    expect(
      storyStageTriggerMatches(trigger, snapshot, snapshot, {
        type: "clock.advance",
        payload: { milliseconds: 1 },
      }),
    ).toBe(false);
  });

  it("matches only a reveal newly recorded by the transaction", () => {
    const before = state();
    const after = state([createStoryFactRecordedEvent("revealed")]);
    const trigger = { kind: "reveal" as const, fact: "revealed" };

    expect(
      storyStageTriggerMatches(
        trigger,
        before,
        after,
        createStoryFactRecordedEvent("revealed"),
      ),
    ).toBe(true);
    expect(
      storyStageTriggerMatches(
        trigger,
        after,
        after,
        createStoryFactRecordedEvent("revealed"),
      ),
    ).toBe(false);
    expect(
      storyStageTriggerMatches(
        { kind: "reveal", fact: "other" },
        before,
        after,
        createStoryFactRecordedEvent("revealed"),
      ),
    ).toBe(false);
  });

  it("matches only a newly selected target model", () => {
    const before = state();
    const after = state([createTerminalModelEvent("quick-patch")]);
    const trigger = { kind: "model" as const, model: "quick-patch" };

    expect(
      storyStageTriggerMatches(
        trigger,
        before,
        after,
        createTerminalModelEvent("quick-patch"),
      ),
    ).toBe(true);
    expect(
      storyStageTriggerMatches(
        trigger,
        after,
        after,
        createTerminalModelEvent("quick-patch"),
      ),
    ).toBe(false);
    expect(
      storyStageTriggerMatches(
        { kind: "model", model: "deep-foundation" },
        before,
        after,
        createTerminalModelEvent("quick-patch"),
      ),
    ).toBe(false);
  });

  it("matches only a newly recorded exact permission decision", () => {
    const event: EngineEvent = {
      type: "mind.permission-decision",
      payload: { capability: CAPABILITY, decision: "always-allow" },
    };
    const before = state();
    const after = state([event]);
    const trigger = {
      kind: "permission" as const,
      capability: CAPABILITY,
      decision: "always-allow" as const,
    };

    expect(storyStageTriggerMatches(trigger, before, after, event)).toBe(true);
    expect(storyStageTriggerMatches(trigger, after, after, event)).toBe(false);
    expect(
      storyStageTriggerMatches(
        { ...trigger, decision: "deny" },
        before,
        after,
        event,
      ),
    ).toBe(false);
    expect(
      storyStageTriggerMatches(
        {
          ...trigger,
          capability: { ...CAPABILITY, resource: "/etc/shadow" },
        },
        before,
        after,
        event,
      ),
    ).toBe(false);
  });

  it("matches only a newly recorded compact operation", () => {
    const event = createMindCompactEvent("summary", []);
    const before = state();
    const after = state([event]);
    const trigger = { kind: "compact" as const };

    expect(storyStageTriggerMatches(trigger, before, after, event)).toBe(true);
    expect(storyStageTriggerMatches(trigger, after, after, event)).toBe(false);
    expect(
      storyStageTriggerMatches(trigger, before, before, {
        type: "clock.advance",
        payload: { milliseconds: 1 },
      }),
    ).toBe(false);
  });
});
