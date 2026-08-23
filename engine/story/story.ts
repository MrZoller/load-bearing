/** Pure mechanics for shared beats and non-terminal ending discovery. */

import type { LoadedCartridge } from "../cartridge/types.js";
import {
  MAX_STORY_ENDINGS,
  MAX_STORY_FACTS,
  MAX_STORY_RARE_EVENTS,
  STORY_ID_PATTERN,
} from "../cartridge/schema.js";
import { readSlice } from "../events/state.js";
import type { SessionState } from "../events/state.js";
import { deepFreeze } from "../freeze.js";
import { storyConditionsMatch } from "./conditions.js";
import type { StoryCounterQuery, StoryFact, StorySlice } from "./types.js";
import type { EscalationStage } from "./types.js";

function record(
  value: unknown,
  where: string,
  fields: readonly string[] = [
    "currentBeat",
    "stage",
    "currentVariant",
    "facts",
    "counters",
    "rareEvents",
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
    stage: 0,
    currentBeat: cartridge.story.phase2.initialBeat,
    currentVariant: "",
    facts: [],
    counters: cartridge.story.phase2.counters.map(({ id, initial }) => ({
      id,
      value: initial,
    })),
    rareEvents: cartridge.story.phase2.rareEvents.map(({ id }) => ({
      id,
      evaluated: false,
      fired: false,
    })),
    discoveredEndings: [],
  });
}

export function validateStorySlice(
  slice: unknown,
  where: string,
  cartridge?: LoadedCartridge,
): StorySlice {
  const item = record(slice, where);
  const stage = item["stage"];
  if (
    !Number.isInteger(stage) ||
    (stage as number) < 0 ||
    (stage as number) > 4
  )
    throw new Error(
      `${where}.stage: must be an escalation stage from 0 through 4`,
    );
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
  const counters = denseArray(item["counters"], `${where}.counters`);
  counters.forEach((value, index) => {
    const at = `${where}.counters[${String(index)}]`;
    const counter = record(value, at, ["id", "value"]);
    if (
      typeof counter["id"] !== "string" ||
      !STORY_ID_PATTERN.test(counter["id"])
    )
      throw new Error(`${at}.id: must be a story counter identifier`);
    if (
      !Number.isSafeInteger(counter["value"]) ||
      (counter["value"] as number) < 0
    )
      throw new Error(`${at}.value: must be a nonnegative safe integer`);
  });
  const rareEvents = denseArray(item["rareEvents"], `${where}.rareEvents`);
  if (rareEvents.length > MAX_STORY_RARE_EVENTS)
    throw new Error(
      `${where}.rareEvents: must contain at most ${String(MAX_STORY_RARE_EVENTS)} rare events`,
    );
  rareEvents.forEach((value, index) => {
    const at = `${where}.rareEvents[${String(index)}]`;
    const rareEvent = record(value, at, ["id", "evaluated", "fired"]);
    if (
      typeof rareEvent["id"] !== "string" ||
      !STORY_ID_PATTERN.test(rareEvent["id"])
    )
      throw new Error(`${at}.id: must be a story rare-event identifier`);
    if (typeof rareEvent["evaluated"] !== "boolean")
      throw new Error(`${at}.evaluated: must be a boolean`);
    if (typeof rareEvent["fired"] !== "boolean")
      throw new Error(`${at}.fired: must be a boolean`);
    if (rareEvent["fired"] === true && rareEvent["evaluated"] !== true)
      throw new Error(`${at}.fired: cannot be true before evaluation`);
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
    if (counters.length !== cartridge.story.phase2.counters.length)
      throw new Error(
        `${where}.counters: expected exactly ${String(cartridge.story.phase2.counters.length)} declared counters`,
      );
    cartridge.story.phase2.counters.forEach((declared, index) => {
      const counter = counters[index] as
        Readonly<Record<string, unknown>> | undefined;
      if (counter?.["id"] !== declared.id)
        throw new Error(
          `${where}.counters[${String(index)}].id: expected declared counter ${JSON.stringify(declared.id)}`,
        );
      const value = counter["value"] as number;
      if (value < declared.initial || value > declared.maximum)
        throw new Error(
          `${where}.counters[${String(index)}].value: must be between initial ${String(declared.initial)} and maximum ${String(declared.maximum)}`,
        );
    });
    if (rareEvents.length !== cartridge.story.phase2.rareEvents.length)
      throw new Error(
        `${where}.rareEvents: expected exactly ${String(cartridge.story.phase2.rareEvents.length)} declared rare events`,
      );
    cartridge.story.phase2.rareEvents.forEach((declared, index) => {
      const rareEvent = rareEvents[index] as
        Readonly<Record<string, unknown>> | undefined;
      if (rareEvent?.["id"] !== declared.id)
        throw new Error(
          `${where}.rareEvents[${String(index)}].id: expected declared rare event ${JSON.stringify(declared.id)}`,
        );
    });
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

export function advanceStoryStage(
  slice: StorySlice,
  from: EscalationStage,
  to: EscalationStage,
): StorySlice {
  if (slice.stage !== from || to !== from + 1)
    throw new Error(
      `story: stage transition must advance current stage ${String(slice.stage)} by one`,
    );
  return deepFreeze({ ...slice, stage: to });
}

export function readStorySlice(state: SessionState): StorySlice {
  return validateStorySlice(
    readSlice(state, "story"),
    "session state: slices.story",
    state.cartridge,
  );
}

export function queryStoryCounter(
  slice: StorySlice,
  id: string,
): StoryCounterQuery {
  const counter = slice.counters.find((candidate) => candidate.id === id);
  return counter === undefined
    ? deepFreeze({ kind: "missing" })
    : deepFreeze({ kind: "value", value: counter.value });
}

export function addStoryCounter(
  slice: StorySlice,
  cartridge: LoadedCartridge,
  id: string,
  amount: number,
): StorySlice {
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw new Error("story: counter addition must be a positive safe integer");
  const index = cartridge.story.phase2.counters.findIndex(
    (counter) => counter.id === id,
  );
  const declaration = cartridge.story.phase2.counters[index];
  const current = slice.counters[index];
  if (declaration === undefined || current === undefined)
    throw new Error(`story: unknown counter ${JSON.stringify(id)}`);
  if (amount > declaration.maximum - current.value)
    throw new Error(
      `story: counter ${JSON.stringify(id)} would exceed maximum ${String(declaration.maximum)}`,
    );
  return deepFreeze({
    ...slice,
    counters: slice.counters.map((counter, counterIndex) =>
      counterIndex === index
        ? { id: counter.id, value: counter.value + amount }
        : counter,
    ),
  });
}

export function recordStoryRareEventEvaluation(
  slice: StorySlice,
  cartridge: LoadedCartridge,
  id: string,
  fired: boolean,
): StorySlice {
  const index = cartridge.story.phase2.rareEvents.findIndex(
    (rareEvent) => rareEvent.id === id,
  );
  const current = slice.rareEvents[index];
  if (index < 0 || current === undefined)
    throw new Error(`story: unknown rare event ${JSON.stringify(id)}`);
  if (current.evaluated)
    throw new Error(
      `story: rare event ${JSON.stringify(id)} was already evaluated`,
    );
  return deepFreeze({
    ...slice,
    rareEvents: slice.rareEvents.map((rareEvent, rareEventIndex) =>
      rareEventIndex === index
        ? { id: rareEvent.id, evaluated: true, fired }
        : rareEvent,
    ),
  });
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
    stage: slice.stage,
    currentBeat: beat.id,
    currentVariant: variant?.id ?? "",
    facts,
    counters: slice.counters,
    rareEvents: slice.rareEvents,
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
    stage: slice.stage,
    currentBeat: slice.currentBeat,
    currentVariant: slice.currentVariant,
    facts: [...slice.facts, { ...declared }],
    counters: [...slice.counters],
    rareEvents: [...slice.rareEvents],
    discoveredEndings: [...slice.discoveredEndings],
  });
}
