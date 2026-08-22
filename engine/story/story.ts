/** Pure mechanics for shared beats and non-terminal ending discovery. */

import type { LoadedCartridge } from "../cartridge/types.js";
import { MAX_STORY_ENDINGS, STORY_ID_PATTERN } from "../cartridge/schema.js";
import { readSlice } from "../events/state.js";
import type { SessionState } from "../events/state.js";
import { deepFreeze } from "../freeze.js";
import type { StorySlice } from "./types.js";

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
    .filter((key) => key !== "currentBeat" && key !== "discoveredEndings")
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

function stringArray(value: unknown, where: string): readonly string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    throw new Error(`${where}: must be a plain array`);
  const keys = Object.keys(value);
  if (
    keys.length !== value.length ||
    keys.some((key, index) => key !== String(index)) ||
    Object.getOwnPropertyNames(value).some(
      (key) => key !== "length" && !keys.includes(key),
    ) ||
    Object.getOwnPropertySymbols(value).length > 0
  )
    throw new Error(`${where}: must be a dense array without extra fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === "length") continue;
    if (descriptor.get !== undefined || descriptor.set !== undefined)
      throw new Error(`${where}[${key}]: accessors are not inert JSON data`);
    if (!descriptor.enumerable)
      throw new Error(
        `${where}[${key}]: non-enumerable items are not JSON data`,
      );
  }
  if (value.length > MAX_STORY_ENDINGS)
    throw new Error(
      `${where}: must contain at most ${String(MAX_STORY_ENDINGS)} endings`,
    );
  value.forEach((item, index) => {
    if (typeof item !== "string" || !STORY_ID_PATTERN.test(item))
      throw new Error(
        `${where}[${String(index)}]: must be an ending identifier`,
      );
  });
  return value as readonly string[];
}

function authoredBeat(cartridge: LoadedCartridge, id: string) {
  return cartridge.story.phase2.beats.find((beat) => beat.id === id);
}

export function createStorySlice(cartridge: LoadedCartridge): StorySlice {
  return deepFreeze({
    currentBeat: cartridge.story.phase2.initialBeat,
    discoveredEndings: [],
  });
}

export function validateStorySlice(
  slice: unknown,
  where: string,
  cartridge?: LoadedCartridge,
): StorySlice {
  const item = record(slice, where);
  const currentBeat = item["currentBeat"];
  if (typeof currentBeat !== "string" || !STORY_ID_PATTERN.test(currentBeat))
    throw new Error(`${where}.currentBeat: must be a story beat identifier`);
  const discoveredEndings = stringArray(
    item["discoveredEndings"],
    `${where}.discoveredEndings`,
  );
  const seen = new Set<string>();
  discoveredEndings.forEach((ending, index) => {
    if (seen.has(ending))
      throw new Error(
        `${where}.discoveredEndings[${String(index)}]: duplicate ending ${JSON.stringify(ending)}`,
      );
    seen.add(ending);
  });
  if (cartridge !== undefined) {
    if (authoredBeat(cartridge, currentBeat) === undefined)
      throw new Error(
        `${where}.currentBeat: unknown beat ${JSON.stringify(currentBeat)}`,
      );
    const endings = new Set(cartridge.story.phase2.endings.map(({ id }) => id));
    discoveredEndings.forEach((ending, index) => {
      if (!endings.has(ending))
        throw new Error(
          `${where}.discoveredEndings[${String(index)}]: unknown ending ${JSON.stringify(ending)}`,
        );
    });
  }
  return slice as StorySlice;
}

export function readStorySlice(state: SessionState): StorySlice {
  return validateStorySlice(
    readSlice(state, "story"),
    "session state: slices.story",
    state.cartridge,
  );
}

export function reachStoryBeat(
  slice: StorySlice,
  cartridge: LoadedCartridge,
  beatId: string,
): StorySlice {
  const beat = authoredBeat(cartridge, beatId);
  if (beat === undefined)
    throw new Error(`story: unknown beat ${JSON.stringify(beatId)}`);
  const discoveredEndings =
    beat.ending === "" || slice.discoveredEndings.includes(beat.ending)
      ? slice.discoveredEndings
      : [...slice.discoveredEndings, beat.ending];
  return deepFreeze({ currentBeat: beat.id, discoveredEndings });
}
