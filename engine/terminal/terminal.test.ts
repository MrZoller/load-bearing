import { describe, expect, it } from "vitest";

import { loadCartridge } from "../cartridge/load.js";
import { deserialize, serialize } from "../serialize/canonical.js";
import { createRandom, restoreRandom } from "../random/stream.js";
import { reduce, restoreSnapshot, snapshot, step } from "../events/reduce.js";
import type { EngineEvent, SessionState } from "../events/state.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
import {
  createTerminalModeEvent,
  createTerminalModelEvent,
  createTerminalModelTransitionEvent,
} from "./module.js";
import {
  createTerminalSlice,
  forkModelStream,
  readTerminalSlice,
  validateTerminalSlice,
} from "./terminal.js";

const CARTRIDGE = loadCartridge(loadCartridgeFixture("minimal"));
const SEED = "2026-08-21/14/terminal-model";

function fold(events: readonly EngineEvent[]): SessionState {
  return reduce({ cartridge: CARTRIDGE, seed: SEED, events });
}

function restoreWithTerminal(terminal: unknown): SessionState {
  // Use a non-empty recording: zero-event snapshots are also compared to a
  // fresh bootstrap, which would hide a terminal validator that accepts an
  // otherwise well-shaped but cartridge-unknown model.
  const recorded = deserialize(
    snapshot(fold([createTerminalModeEvent("tui")])),
  ) as Record<string, unknown>;
  (recorded["slices"] as Record<string, unknown>)["terminal"] = terminal;
  return restoreSnapshot(serialize(recorded));
}

describe("terminal state", () => {
  it("bootstraps Bash with the cartridge's first model", () => {
    const state = fold([]);

    expect(createTerminalSlice(CARTRIDGE)).toEqual({
      mode: "bash",
      activeModel: "deep-foundation",
    });
    expect(readTerminalSlice(state)).toEqual({
      mode: "bash",
      activeModel: "deep-foundation",
    });
    expect(Object.isFrozen(state.slices["terminal"])).toBe(true);
  });

  it("stamps constructors and folds predecessor-aware model transitions without replacing the root seed", () => {
    expect(createTerminalModeEvent("tui")).toEqual({
      type: "terminal.mode-set",
      payload: { mode: "tui" },
      version: 0,
    });
    expect(createTerminalModelEvent("quick-patch")).toEqual({
      type: "terminal.model-set",
      payload: { model: "quick-patch" },
      version: 0,
    });
    expect(
      createTerminalModelTransitionEvent("deep-foundation", "quick-patch"),
    ).toEqual({
      type: "terminal.model-transitioned",
      payload: { predecessor: "deep-foundation", successor: "quick-patch" },
      version: 0,
    });

    const state = fold([
      createTerminalModeEvent("tui"),
      createTerminalModelTransitionEvent("deep-foundation", "quick-patch"),
      createTerminalModeEvent("bash"),
    ]);

    expect(readTerminalSlice(state)).toEqual({
      mode: "bash",
      activeModel: "quick-patch",
    });
    expect(state.seed).toBe(SEED);
    expect(
      state.transcript.map((entry) => [entry.type, entry.summary]),
    ).toEqual([
      ["terminal.mode-set", "mode=tui"],
      ["terminal.model-transitioned", "model=deep-foundation->quick-patch"],
      ["terminal.mode-set", "mode=bash"],
    ]);
  });

  it("gives each model a named stream that survives switches and snapshot restoration", () => {
    const control = createRandom(SEED).fork("terminal");
    const controlDeep = forkModelStream(control, "deep-foundation");
    const expectedDeep = [controlDeep.nextUint32(), controlDeep.nextUint32()];

    const root = createRandom(SEED);
    const terminal = root.fork("terminal");
    const deep = forkModelStream(terminal, "deep-foundation");
    const firstDeep = deep.nextUint32();
    const quick = forkModelStream(terminal, "quick-patch");
    const quickDraw = quick.nextUint32();
    const restored = restoreRandom(root.toState());
    const resumedDeep = forkModelStream(
      restored.fork("terminal"),
      "deep-foundation",
    );

    expect(firstDeep).toBe(expectedDeep[0]);
    expect(resumedDeep.nextUint32()).toBe(expectedDeep[1]);
    expect(quickDraw).not.toBe(expectedDeep[0]);
    expect(Object.keys(root.toState().cursors)).toEqual([
      "root/terminal/models/deep-foundation",
      "root/terminal/models/quick-patch",
    ]);
  });

  it("rejects malformed event payloads before they can produce a terminal state", () => {
    const cases: readonly (readonly [EngineEvent, RegExp])[] = [
      [{ type: "terminal.mode-set", payload: {} }, /mode must be a string/],
      [
        { type: "terminal.mode-set", payload: { mode: "pane" } },
        /mode must be bash or tui/,
      ],
      [
        { type: "terminal.mode-set", payload: { mode: "tui", extra: true } },
        /unexpected payload field\(s\) extra/,
      ],
      [{ type: "terminal.model-set", payload: {} }, /model must be a string/],
      [
        { type: "terminal.model-set", payload: { model: "missing" } },
        /unknown model/,
      ],
      [
        {
          type: "terminal.model-set",
          payload: { model: "quick-patch", extra: true },
        },
        /unexpected payload field\(s\) extra/,
      ],
      [
        {
          type: "terminal.model-transitioned",
          payload: { predecessor: "quick-patch", successor: "deep-foundation" },
        },
        /predecessor "quick-patch" is not active model "deep-foundation"/,
      ],
      [
        {
          type: "terminal.model-transitioned",
          payload: {
            predecessor: "deep-foundation",
            successor: "deep-foundation",
          },
        },
        /successor must differ from predecessor/,
      ],
      [
        {
          type: "terminal.model-transitioned",
          payload: { predecessor: "deep-foundation", successor: "missing" },
        },
        /unknown model/,
      ],
      [
        {
          type: "terminal.model-transitioned",
          payload: {
            predecessor: "deep-foundation",
            successor: "quick-patch",
            extra: true,
          },
        },
        /unexpected payload field\(s\) extra/,
      ],
    ];

    for (const [event, expected] of cases)
      expect(() => fold([event])).toThrow(expected);
  });

  it("does not consume spinner or unrelated streams while recording a transition", () => {
    const before = fold([
      {
        type: "probe.random",
        payload: { stream: "unrelated", count: 1, form: "uint32" },
      },
    ]);
    const after = step(
      before,
      createTerminalModelTransitionEvent("deep-foundation", "quick-patch"),
    );

    expect(after.seed).toBe(SEED);
    expect(after.random).toEqual(before.random);
    expect(Object.keys(after.random.cursors)).toEqual(["root/probe/unrelated"]);
  });

  it("strictly validates terminal snapshots and round-trips a valid transition", () => {
    const state = fold([
      createTerminalModeEvent("tui"),
      createTerminalModelEvent("quick-patch"),
    ]);
    expect(restoreSnapshot(snapshot(state))).toEqual(state);

    for (const [slice, expected] of [
      [null, /must be an object/],
      [{ mode: "pane", activeModel: "deep-foundation" }, /must be bash or tui/],
      [
        { mode: "bash", activeModel: "not a model" },
        /must be a model identifier/,
      ],
      [
        { mode: "bash", activeModel: "deep-foundation", extra: true },
        /unexpected field/,
      ],
    ] as const) {
      expect(() =>
        validateTerminalSlice(slice, "snapshot: slices.terminal"),
      ).toThrow(expected);
      expect(() => restoreWithTerminal(slice)).toThrow(expected);
    }

    // A model identifier alone is not enough: a restored terminal must still
    // name a model supplied by the cartridge that owns the session.
    expect(() =>
      restoreWithTerminal({ mode: "bash", activeModel: "unlisted-model" }),
    ).toThrow(/unknown model/);
  });
});
