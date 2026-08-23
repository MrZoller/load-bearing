/** Pure mechanics for shared beats and non-terminal ending discovery. */

import type { LoadedCartridge } from "../cartridge/types.js";
import {
  MAX_STORY_ENDINGS,
  MAX_STORY_FACTS,
  STORY_ID_PATTERN,
} from "../cartridge/schema.js";
import { readSlice } from "../events/state.js";
import type { SessionState } from "../events/state.js";
import { deepFreeze } from "../freeze.js";
import { storyConditionsMatch } from "./conditions.js";
import type { StoryFact, StorySlice } from "./types.js";

function record(
  value: unknown,
  where: string,
  fields: readonly string[] = [
    "currentBeat",
    "currentVariant",
    "facts",
    "discoveredEndings",
  ],
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
    .filter((key) => !fields.includes(key))
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

function denseArray(value: unknown, where: string): readonly unknown[] {
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
  return value;
}

function stringArray(
  value: unknown,
  where: string,
  maximum = MAX_STORY_ENDINGS,
  noun = "endings",
): readonly string[] {
  const items = denseArray(value, where);
  if (items.length > maximum)
    throw new Error(
      `${where}: must contain at most ${String(maximum)} ${noun}`,
    );
  items.forEach((item, index) => {
    if (typeof item !== "string" || !STORY_ID_PATTERN.test(item))
      throw new Error(
        `${where}[${String(index)}]: must be an ending identifier`,
      );
  });
  return items as readonly string[];
}

function authoredBeat(cartridge: LoadedCartridge, id: string) {
  return cartridge.story.phase2.beats.find((beat) => beat.id === id);
}

export function createStorySlice(cartridge: LoadedCartridge): StorySlice {
  return deepFreeze({
    currentBeat: cartridge.story.phase2.initialBeat,
    currentVariant: "",
    facts: [],
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
  const currentVariant = item["currentVariant"];
  if (
    typeof currentVariant !== "string" ||
    (currentVariant !== "" && !STORY_ID_PATTERN.test(currentVariant))
  )
    throw new Error(
      `${where}.currentVariant: must be empty or a story variant identifier`,
    );
  const facts = denseArray(item["facts"], `${where}.facts`);
  if (facts.length > MAX_STORY_FACTS)
    throw new Error(
      `${where}.facts: must contain at most ${String(MAX_STORY_FACTS)} facts`,
    );
  const factIds = new Set<string>();
  facts.forEach((value, index) => {
    const at = `${where}.facts[${String(index)}]`;
    const fact = record(value, at, ["id", "kind"]);
    const id = fact["id"];
    const kind = fact["kind"];
    if (typeof id !== "string" || !STORY_ID_PATTERN.test(id))
      throw new Error(`${at}.id: must be a story fact identifier`);
    if (kind !== "reveal" && kind !== "callback")
      throw new Error(`${at}.kind: must be reveal or callback`);
    if (factIds.has(id))
      throw new Error(`${at}.id: duplicate fact ${JSON.stringify(id)}`);
    factIds.add(id);
  });
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
    const beat = authoredBeat(cartridge, currentBeat);
    if (beat === undefined)
      throw new Error(
        `${where}.currentBeat: unknown beat ${JSON.stringify(currentBeat)}`,
      );
    if (
      currentVariant !== "" &&
      beat.variants.every((variant) => variant.id !== currentVariant)
    )
      throw new Error(
        `${where}.currentVariant: unknown variant ${JSON.stringify(currentVariant)} for beat ${JSON.stringify(currentBeat)}`,
      );
    const declaredFacts = new Map(
      cartridge.story.phase2.facts.map((fact) => [fact.id, fact.kind]),
    );
    (facts as readonly StoryFact[]).forEach((fact, index) => {
      const kind = declaredFacts.get(fact.id);
      if (kind === undefined)
        throw new Error(
          `${where}.facts[${String(index)}].id: unknown fact ${JSON.stringify(fact.id)}`,
        );
      if (kind !== fact.kind)
        throw new Error(
          `${where}.facts[${String(index)}].kind: expected declared kind ${kind}`,
        );
    });
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
  preEventState?: SessionState,
): StorySlice {
  const beat = authoredBeat(cartridge, beatId);
  if (beat === undefined)
    throw new Error(`story: unknown beat ${JSON.stringify(beatId)}`);
  const variant =
    preEventState === undefined
      ? undefined
      : beat.variants.find((candidate) =>
          storyConditionsMatch(preEventState, candidate.when),
        );
  const ending = variant?.ending ?? beat.ending;
  const outcomeFacts = variant?.facts ?? beat.facts;
  const declaredFacts = new Map(
    cartridge.story.phase2.facts.map((fact) => [fact.id, fact.kind]),
  );
  const facts = [...slice.facts];
  for (const id of outcomeFacts) {
    if (facts.some((fact) => fact.id === id)) continue;
    if (facts.length >= MAX_STORY_FACTS)
      throw new Error(
        `story: cannot record more than ${String(MAX_STORY_FACTS)} facts`,
      );
    const kind = declaredFacts.get(id);
    if (kind === undefined)
      throw new Error(`story: unknown fact ${JSON.stringify(id)}`);
    facts.push({ id, kind });
  }
  const discoveredEndings =
    ending === "" || slice.discoveredEndings.includes(ending)
      ? slice.discoveredEndings
      : [...slice.discoveredEndings, ending];
  return deepFreeze({
    currentBeat: beat.id,
    currentVariant: variant?.id ?? "",
    facts,
    discoveredEndings,
  });
}

export function recordStoryFact(
  slice: StorySlice,
  cartridge: LoadedCartridge,
  factId: string,
): StorySlice {
  const declared = cartridge.story.phase2.facts.find(
    (fact) => fact.id === factId,
  );
  if (declared === undefined)
    throw new Error(`story: unknown fact ${JSON.stringify(factId)}`);
  if (slice.facts.some((fact) => fact.id === factId)) return slice;
  if (slice.facts.length >= MAX_STORY_FACTS)
    throw new Error(
      `story: cannot record more than ${String(MAX_STORY_FACTS)} facts`,
    );
  return deepFreeze({
    currentBeat: slice.currentBeat,
    currentVariant: slice.currentVariant,
    facts: [...slice.facts, { ...declared }],
    discoveredEndings: [...slice.discoveredEndings],
  });
}
