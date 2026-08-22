/** Pure terminal-state mechanics and model-specific random stream selection. */

import type { LoadedCartridge } from "../cartridge/types.js";
import { readSlice } from "../events/state.js";
import type { SessionState } from "../events/state.js";
import { deepFreeze } from "../freeze.js";
import { MODEL_ID_PATTERN } from "../random/seed.js";
import type { RandomStream } from "../random/stream.js";
import type { TerminalMode, TerminalSlice } from "./types.js";

function record(
  value: unknown,
  where: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${where}: must be an object`);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(`${where}: must be a plain JSON object`);
  if (Object.getOwnPropertySymbols(value).length > 0)
    throw new Error(`${where}: must not contain symbol-keyed fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const unknown = Object.keys(descriptors)
    .filter((key) => key !== "mode" && key !== "activeModel")
    .sort();
  if (unknown.length > 0)
    throw new Error(`${where}: unexpected field(s) ${unknown.join(", ")}`);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor.get !== undefined || descriptor.set !== undefined)
      throw new Error(`${where}.${key}: accessors are not inert JSON data`);
    if (!descriptor.enumerable)
      throw new Error(
        `${where}.${key}: non-enumerable fields are not JSON data`,
      );
  }
  return value as Readonly<Record<string, unknown>>;
}

function modelExists(cartridge: LoadedCartridge, model: string): boolean {
  return cartridge.models.some((candidate) => candidate.id === model);
}

export function isTerminalMode(value: string): value is TerminalMode {
  return value === "bash" || value === "tui";
}

/** Validate every field without normalizing snapshot bytes. */
export function validateTerminalSlice(
  slice: unknown,
  where: string,
  cartridge?: LoadedCartridge,
): TerminalSlice {
  const item = record(slice, where);
  const mode = item["mode"];
  const activeModel = item["activeModel"];
  if (typeof mode !== "string" || !isTerminalMode(mode))
    throw new Error(`${where}.mode: must be bash or tui`);
  if (typeof activeModel !== "string" || !MODEL_ID_PATTERN.test(activeModel))
    throw new Error(`${where}.activeModel: must be a model identifier`);
  if (cartridge !== undefined && !modelExists(cartridge, activeModel))
    throw new Error(
      `${where}.activeModel: unknown model ${JSON.stringify(activeModel)}`,
    );
  return slice as TerminalSlice;
}

export function readTerminalSlice(state: SessionState): TerminalSlice {
  const slice = validateTerminalSlice(
    readSlice(state, "terminal"),
    "session state: slices.terminal",
  );
  if (!modelExists(state.cartridge, slice.activeModel))
    throw new Error(
      `session state: slices.terminal.activeModel: unknown model ${JSON.stringify(slice.activeModel)}`,
    );
  return slice;
}

export function createTerminalSlice(cartridge: LoadedCartridge): TerminalSlice {
  const initialModel = cartridge.models[0];
  if (initialModel === undefined)
    throw new Error("terminal: cartridge must declare at least one model");
  return deepFreeze({ mode: "bash", activeModel: initialModel.id });
}

export function setTerminalMode(
  slice: TerminalSlice,
  mode: TerminalMode,
): TerminalSlice {
  return deepFreeze({ mode, activeModel: slice.activeModel });
}

export function setActiveModel(
  slice: TerminalSlice,
  cartridge: LoadedCartridge,
  model: string,
): TerminalSlice {
  if (!modelExists(cartridge, model))
    throw new Error(`terminal: unknown model ${JSON.stringify(model)}`);
  return deepFreeze({ mode: slice.mode, activeModel: model });
}

/**
 * Select randomness by model name without deriving from the active cursor.
 * Switching models therefore cannot perturb or restart another model's draws.
 */
export function forkModelStream(
  moduleStream: RandomStream,
  model: string,
): RandomStream {
  if (!MODEL_ID_PATTERN.test(model))
    throw new Error(
      `terminal: invalid model identifier ${JSON.stringify(model)}`,
    );
  return moduleStream.fork("models").fork(model);
}
