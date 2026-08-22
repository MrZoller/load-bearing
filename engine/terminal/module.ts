/** Event registration for terminal mode and active-model transitions. */

import { defineEventModule } from "../events/module.js";
import { stampEvent } from "../events/log.js";
import { readString, requirePayload } from "../events/payload.js";
import type { EngineEvent } from "../events/state.js";
import type { TerminalMode, TerminalSlice } from "./types.js";
import {
  createTerminalSlice,
  isTerminalMode,
  setActiveModel,
  setTerminalMode,
  validateTerminalSlice,
} from "./terminal.js";

function payload(
  value: Readonly<Record<string, unknown>>,
  expected: string,
  where: string,
): void {
  const unknown = Object.keys(value)
    .filter((key) => key !== expected)
    .sort();
  if (unknown.length > 0)
    throw new Error(
      `${where}: unexpected payload field(s) ${unknown.join(", ")}; expected ${expected}`,
    );
}

export function createTerminalModeEvent(mode: TerminalMode): EngineEvent {
  return stampEvent(
    { type: "terminal.mode-set", payload: { mode } },
    "terminal mode",
  );
}

export function createTerminalModelEvent(model: string): EngineEvent {
  return stampEvent(
    { type: "terminal.model-set", payload: { model } },
    "terminal model",
  );
}

export const TERMINAL_MODULE = defineEventModule<TerminalSlice>({
  namespace: "terminal",
  description: "Replayable terminal mode and active model.",
  initialSlice(context) {
    return createTerminalSlice(context.cartridge);
  },
  validateSlice: validateTerminalSlice,
  events: {
    "terminal.mode-set": {
      version: 0,
      apply(context, slice) {
        const data = requirePayload(context);
        payload(data, "mode", context.where);
        const mode = readString(data, "mode", context.where);
        if (!isTerminalMode(mode))
          throw new Error(`${context.where}: mode must be bash or tui`);
        return { slice: setTerminalMode(slice, mode), summary: `mode=${mode}` };
      },
    },
    "terminal.model-set": {
      version: 0,
      apply(context, slice) {
        const data = requirePayload(context);
        payload(data, "model", context.where);
        const model = readString(data, "model", context.where);
        return {
          slice: setActiveModel(slice, context.cartridge, model),
          summary: `model=${model}`,
        };
      },
    },
  },
});
