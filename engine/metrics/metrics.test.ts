import { describe, expect, it } from "vitest";

import {
  createTerminalModelEvent,
  deriveEngineMetrics,
  loadCartridge,
  reduce,
  restoreSnapshot,
  snapshot,
} from "../index.js";
import type { LoadedCartridge, SessionState } from "../index.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";

const SEED = "2026-08-22/0/deep-foundation";

function cartridgeWithMetrics(
  metrics: Record<string, number>,
): LoadedCartridge {
  const document = structuredClone(loadCartridgeFixture("minimal")) as Record<
    string,
    unknown
  >;
  document["presentation"] = {
    placeholders: [{ stage: 0, text: "Enter a request" }],
    spinnerPools: [
      { archetype: "paranoid", stage: 0, verbs: ["Working"] },
      { archetype: "reckless", stage: 0, verbs: ["Working"] },
    ],
    metrics,
  };
  return loadCartridge(document);
}

function fold(
  cartridge: LoadedCartridge,
  events: readonly {
    readonly type: string;
    readonly payload?: Readonly<Record<string, unknown>>;
  }[],
): SessionState {
  return reduce({ cartridge, seed: SEED, events });
}

describe("deriveEngineMetrics", () => {
  it("derives the frozen current estimate only from replay state and validated cartridge parameters", () => {
    const cartridge = cartridgeWithMetrics({
      baseTokens: 100,
      tokensPerEvent: 25,
      contextWindowTokens: 200,
      costMicrosPerToken: 2,
      integrityStart: 10,
      integrityLossPerEvent: 3,
    });
    const state = fold(cartridge, [
      { type: "clock.tick", payload: { ms: 1 } },
      { type: "clock.tick", payload: { ms: 1 } },
      { type: "clock.tick", payload: { ms: 1 } },
    ]);

    const metrics = deriveEngineMetrics(state);

    expect(metrics).toEqual({
      modelId: "deep-foundation",
      modelName: "Deep Foundation",
      tokenCount: 175,
      costMicros: 16_800_000,
      contextPercent: 87,
      structuralIntegrity: 1,
    });
    expect(Object.isFrozen(metrics)).toBe(true);
  });

  it("is identical for identical logs and survives snapshot restoration", () => {
    const cartridge = cartridgeWithMetrics({
      baseTokens: 20,
      tokensPerEvent: 10,
      contextWindowTokens: 25,
      costMicrosPerToken: 4,
      integrityStart: 9,
      integrityLossPerEvent: 2,
    });
    const events = [
      { type: "clock.tick", payload: { ms: 1 } },
      { type: "clock.tick", payload: { ms: 1 } },
    ] as const;
    const first = fold(cartridge, events);
    const second = fold(cartridge, events);

    expect(deriveEngineMetrics(second)).toEqual(deriveEngineMetrics(first));
    expect(deriveEngineMetrics(restoreSnapshot(snapshot(first)))).toEqual(
      deriveEngineMetrics(first),
    );
  });

  it("reprices the same deterministic estimate when the active terminal model changes", () => {
    const cartridge = cartridgeWithMetrics({
      baseTokens: 20,
      tokensPerEvent: 10,
      contextWindowTokens: 100,
      costMicrosPerToken: 5,
      integrityStart: 10,
      integrityLossPerEvent: 1,
    });
    const before = fold(cartridge, [
      { type: "clock.tick", payload: { ms: 1 } },
    ]);
    const after = fold(cartridge, [
      { type: "clock.tick", payload: { ms: 1 } },
      createTerminalModelEvent("quick-patch"),
    ]);

    expect(deriveEngineMetrics(before)).toMatchObject({
      modelId: "deep-foundation",
      tokenCount: 30,
      costMicros: 7_200_000,
    });
    // The switch itself is an event, so tokens advance once; its model changes
    // the price of that complete current estimate rather than only new tokens.
    expect(deriveEngineMetrics(after)).toMatchObject({
      modelId: "quick-patch",
      modelName: "Quick Patch",
      tokenCount: 40,
      costMicros: 600,
    });
  });

  it("saturates representable arithmetic and refuses state that was not safely validated", () => {
    const cartridge = cartridgeWithMetrics({
      baseTokens: 1_000_000_000,
      tokensPerEvent: 10_000_000,
      contextWindowTokens: 1,
      costMicrosPerToken: 1_000_000_000,
      integrityStart: 0,
      integrityLossPerEvent: 1_000_000,
    });
    const state = fold(cartridge, [{ type: "clock.tick", payload: { ms: 1 } }]);

    const metrics = deriveEngineMetrics(state);
    expect(metrics).toMatchObject({
      tokenCount: 1_010_000_000,
      costMicros: Number.MAX_SAFE_INTEGER,
      contextPercent: 100,
      structuralIntegrity: 0,
    });
    for (const value of [
      metrics.tokenCount,
      metrics.costMicros,
      metrics.contextPercent,
      metrics.structuralIntegrity,
    ]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    }

    for (const eventCount of [-1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        deriveEngineMetrics({ ...state, eventCount } as SessionState),
      ).toThrow();
    }
    expect(() =>
      deriveEngineMetrics({
        ...state,
        slices: {
          ...state.slices,
          terminal: { mode: "bash", activeModel: "missing" },
        },
      } as SessionState),
    ).toThrow();
  });
});
