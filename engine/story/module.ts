/** Event registration for shared story-beat transitions. */

import { defineEventModule } from "../events/module.js";
import { stampEvent } from "../events/log.js";
import { readString, requirePayload } from "../events/payload.js";
import type { EngineEvent } from "../events/state.js";
import type { StorySlice } from "./types.js";
import {
  createStorySlice,
  recordStoryFact,
  reachStoryBeat,
  validateStorySlice,
} from "./story.js";

export function createStoryBeatReachedEvent(beat: string): EngineEvent {
  return stampEvent(
    { type: "story.beat-reached", payload: { beat } },
    "story beat reached",
  );
}

export function createStoryFactRecordedEvent(fact: string): EngineEvent {
  return stampEvent(
    { type: "story.fact-recorded", payload: { fact } },
    "story fact recorded",
  );
}

export const STORY_MODULE = defineEventModule<StorySlice>({
  namespace: "story",
  description:
    "Shared story beats and ordered non-terminal ending discoveries.",
  initialSlice(context) {
    return createStorySlice(context.cartridge);
  },
  validateSlice: validateStorySlice,
  events: {
    "story.beat-reached": {
      version: 0,
      apply(context, slice) {
        const payload = requirePayload(context);
        const unknown = Object.keys(payload)
          .filter((key) => key !== "beat")
          .sort();
        if (unknown.length > 0)
          throw new Error(
            `${context.where}: unexpected payload field(s) ${unknown.join(", ")}; expected beat`,
          );
        const beat = readString(payload, "beat", context.where);
        return {
          slice: reachStoryBeat(slice, context.cartridge, beat, context.state),
          summary: `beat=${beat}`,
        };
      },
    },
    "story.fact-recorded": {
      version: 0,
      apply(context, slice) {
        const payload = requirePayload(context);
        const unknown = Object.keys(payload)
          .filter((key) => key !== "fact")
          .sort();
        if (unknown.length > 0)
          throw new Error(
            `${context.where}: unexpected payload field(s) ${unknown.join(", ")}; expected fact`,
          );
        const fact = readString(payload, "fact", context.where);
        return {
          slice: recordStoryFact(slice, context.cartridge, fact),
          summary: `fact=${fact}`,
        };
      },
    },
  },
});
