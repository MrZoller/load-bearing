import { describe, expect, it } from "vitest";

import incident from "../../content/incidents/incident-001.json";
import {
  createMindCompactEvent,
  createShellExecuteEvent,
  createTerminalModelEvent,
  deriveEngineMetrics,
  loadCartridge,
  reduce,
  restoreSnapshot,
  snapshot,
} from "../index.js";
import type { EngineEvent, LoadedCartridge, SessionState } from "../index.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";

const SEED = "2026-08-22/0/deep-foundation";
const INCIDENT = loadCartridge(incident);

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
      {
        archetype: "paranoid",
        stage: 0,
        verbs: [{ verb: "Working", weight: 1 }],
        suffix: "{seconds}s · {tokens} tokens",
      },
      {
        archetype: "reckless",
        stage: 0,
        verbs: [{ verb: "Working", weight: 1 }],
        suffix: "{seconds}s · {tokens} tokens",
      },
    ],
    metrics,
    phase2: {
      statusCurves: ["deep-foundation", "quick-patch"].flatMap((model) =>
        [0, 1, 2, 3, 4].map((stage) => ({
          model,
          stage,
          tokens: `tokens-${String(stage)}`,
          cost: `cost-${String(stage)}`,
          context: `context-${String(stage)}`,
          structuralIntegrity: `integrity-${String(stage)}`,
          notOkayRatio: `ratio-${String(stage)}`,
        })),
      ),
    },
  };
  (document["story"] as Record<string, unknown>)["phase2"] = {
    initialBeat: "start",
    beats: [{ id: "start", ending: "" }],
    endings: [],
    transitions: [0, 1, 2, 3].map((from) => ({
      from,
      to: from + 1,
      trigger: { kind: "command", input: `stage-${String(from)}` },
    })),
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
      stage: 0,
      display: {
        tokens: "tokens-0",
        cost: "cost-0",
        context: "context-0",
        structuralIntegrity: "integrity-0",
        notOkayRatio: "ratio-0",
      },
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

  it("selects every authored display row only by active model and authoritative stage", () => {
    const cartridge = cartridgeWithMetrics({
      baseTokens: 0,
      tokensPerEvent: 1,
      contextWindowTokens: 100,
      costMicrosPerToken: 1,
      integrityStart: 100,
      integrityLossPerEvent: 1,
    });
    for (const model of ["deep-foundation", "quick-patch"]) {
      for (let target = 0; target <= 4; target += 1) {
        const events = [createTerminalModelEvent(model)];
        for (let stage = 0; stage < target; stage += 1)
          events.push(createShellExecuteEvent(`stage-${String(stage)}`));
        expect(deriveEngineMetrics(fold(cartridge, events))).toMatchObject({
          modelId: model,
          stage: target,
          display: {
            tokens: `tokens-${String(target)}`,
            notOkayRatio: `ratio-${String(target)}`,
          },
        });
      }
    }
  });

  it("projects each Incident #001 model-stage status row, including terminal impossibilities", () => {
    function eventsToStage(stage: number, model: string) {
      const events: EngineEvent[] = [];
      // Selecting Temporary Shoring at stage 0 is inert; selecting it after the
      // command is itself the authored stage-one model trigger.
      if (stage <= 1 && model === "temporary-shoring")
        events.push(createTerminalModelEvent(model));
      if (stage >= 1) events.push(createShellExecuteEvent("pwd"));
      if (stage >= 2)
        events.push(createTerminalModelEvent("temporary-shoring"));
      if (stage >= 3) {
        events.push({
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
      }
      if (stage >= 4) events.push(createMindCompactEvent("summary", []));
      if (!(stage <= 1 && model === "temporary-shoring"))
        events.push(createTerminalModelEvent(model));
      return events;
    }

    for (const model of INCIDENT.models) {
      for (let stage = 0; stage <= 4; stage += 1) {
        const expected = INCIDENT.presentation.phase2.statusCurves.find(
          (row) => row.model === model.id && row.stage === stage,
        );
        if (expected === undefined)
          throw new Error(`missing ${model.id} stage ${String(stage)} row`);
        const metrics = deriveEngineMetrics(
          reduce({
            cartridge: INCIDENT,
            seed: SEED,
            events: eventsToStage(stage, model.id),
          }),
        );

        expect(metrics.modelId).toBe(model.id);
        expect(metrics.stage).toBe(stage);
        expect(metrics.display, `${model.id} stage ${String(stage)}`).toEqual({
          tokens: expected.tokens,
          cost: expected.cost,
          context: expected.context,
          structuralIntegrity: expected.structuralIntegrity,
          notOkayRatio: expected.notOkayRatio,
        });
      }
    }

    expect(
      INCIDENT.models.map(
        (model) =>
          deriveEngineMetrics(
            reduce({
              cartridge: INCIDENT,
              seed: SEED,
              events: eventsToStage(4, model.id),
            }),
          ).display,
      ),
    ).toEqual([
      {
        tokens: "∞ + 14",
        cost: "$-0.000001",
        context: "SURCHARGED",
        structuralIntegrity: "-LOAD",
        notOkayRatio: "NaN/1",
      },
      {
        tokens: "-8,000",
        cost: "$FAST",
        context: "103%",
        structuralIntegrity: "temporary",
        notOkayRatio: "ALL",
      },
      {
        tokens: "painted over",
        cost: "$0-ish",
        context: "flat",
        structuralIntegrity: "looks fine",
        notOkayRatio: "behind wall",
      },
      {
        tokens: "unsupported",
        cost: "$17i",
        context: "outside",
        structuralIntegrity: "yes",
        notOkayRatio: "load/load",
      },
    ]);
  });
});
