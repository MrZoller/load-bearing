import { describe, expect, it } from "vitest";

import { loadCartridge } from "../cartridge/load.js";
import { reduce } from "../events/reduce.js";
import type { EngineEvent, SessionState } from "../events/state.js";
import { createMindWaiverConsentRecordedEvent } from "../mind/module.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
import { createStoryFactRecordedEvent } from "./module.js";
import { storyConditionMatches } from "./conditions.js";
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
});
