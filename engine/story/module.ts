/** Event registration for shared story-beat transitions. */

import { defineEventModule } from "../events/module.js";
import { stampEvent } from "../events/log.js";
import { readString, requirePayload } from "../events/payload.js";
import type { EngineEvent } from "../events/state.js";
import type { StorySlice } from "./types.js";
import type { EscalationStage } from "./types.js";
import {
  addStoryCounter,
  advanceStoryStage,
  createStorySlice,
  recordStoryFact,
  recordStoryRareEventEvaluation,
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

/** Internal owner event. The reducer refuses this type in a visitor event log. */
export function createStoryStageAdvancedEvent(
  from: EscalationStage,
  to: EscalationStage,
): EngineEvent {
  return { type: "story.stage-advanced", payload: { from, to }, version: 0 };
}

/** Internal owner event. The reducer refuses this type in a visitor event log. */
export function createStoryRareEventEvaluatedEvent(
  id: string,
  fired: boolean,
): EngineEvent {
  return {
    type: "story.rare-event-evaluated",
    payload: { id, fired },
    version: 0,
  };
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
    "story.stage-advanced": {
      version: 0,
      apply(context, slice) {
        const data = requirePayload(context);
        const unknown = Object.keys(data)
          .filter((key) => key !== "from" && key !== "to")
          .sort();
        if (unknown.length > 0)
          throw new Error(
            `${context.where}: unexpected payload field(s) ${unknown.join(", ")}; expected from, to`,
          );
        const from = data["from"];
        const to = data["to"];
        if (
          !Number.isInteger(from) ||
          (from as number) < 0 ||
          (from as number) > 3
        )
          throw new Error(
            `${context.where}: from must be an escalation stage from 0 through 3`,
          );
        if (!Number.isInteger(to) || to !== (from as number) + 1)
          throw new Error(`${context.where}: to must be exactly from + 1`);
        return {
          slice: advanceStoryStage(
            slice,
            from as EscalationStage,
            to as EscalationStage,
          ),
        };
      },
    },
    "story.rare-event-evaluated": {
      version: 0,
      apply(context, slice) {
        const payload = requirePayload(context);
        const unknown = Object.keys(payload)
          .filter((key) => key !== "id" && key !== "fired")
          .sort();
        if (unknown.length > 0)
          throw new Error(
            `${context.where}: unexpected payload field(s) ${unknown.join(", ")}; expected id, fired`,
          );
        const id = readString(payload, "id", context.where);
        const fired = payload["fired"];
        if (typeof fired !== "boolean")
          throw new Error(`${context.where}: fired must be a boolean`);
        return {
          slice: recordStoryRareEventEvaluation(
            slice,
            context.cartridge,
            id,
            fired,
          ),
        };
      },
    },
    "story.counter-added": {
      version: 0,
      apply(context, slice) {
        const payload = requirePayload(context);
        const unknown = Object.keys(payload)
          .filter((key) => key !== "counter" && key !== "amount")
          .sort();
        if (unknown.length > 0)
          throw new Error(
            `${context.where}: unexpected payload field(s) ${unknown.join(", ")}; expected counter, amount`,
          );
        const counter = readString(payload, "counter", context.where);
        const amount = payload["amount"];
        if (!Number.isSafeInteger(amount) || (amount as number) <= 0)
          throw new Error(
            `${context.where}: amount must be a positive safe integer`,
          );
        return {
          slice: addStoryCounter(
            slice,
            context.cartridge,
            counter,
            amount as number,
          ),
          summary: `counter=${counter} amount=${String(amount)}`,
        };
      },
    },
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
