/** Cartridge-driven resume and compaction plans over replayed session truth. */

import type { LoadedCartridge } from "../cartridge/types.js";
import type { EngineEvent, SessionState } from "../events/state.js";
import { beliefDivergence } from "../mind/mind.js";
import {
  createMindBeliefEvent,
  createMindCompactEvent,
} from "../mind/module.js";
import { createTerminalModeEvent } from "../terminal/module.js";
import { routeCompact } from "../story/router.js";
import { readAgentSlice } from "./agent.js";
import {
  canRecordAuthoredResponse,
  canRecordAuthoredResponses,
  stageOpeningResponseId,
} from "./intent.js";
import { readStorySlice } from "../story/story.js";
import {
  createAgentCapacityEvent,
  createAgentResponseEvent,
  selectAgentPresentation,
} from "./module.js";

function responseEvent(
  cartridge: LoadedCartridge,
  state: SessionState,
  responseId: string,
  instanceId: string,
): EngineEvent {
  return canRecordAuthoredResponse(cartridge, state, responseId)
    ? createAgentResponseEvent(responseId, instanceId)
    : createAgentCapacityEvent(cartridge.story.fallback.response);
}

/** Record the cartridge-authored command reference without inventing runtime copy. */
export function createAgentHelpEvents(
  cartridge: LoadedCartridge,
  state: SessionState,
): readonly EngineEvent[] {
  const presentation = selectAgentPresentation(cartridge, state);
  return [
    responseEvent(
      cartridge,
      state,
      presentation.helpResponse,
      `help-${String(state.eventCount)}`,
    ),
  ];
}

/** Resume from machine truth, installing opening beliefs only once. */
export function createAgentResumeEvents(
  cartridge: LoadedCartridge,
  state: SessionState,
): readonly EngineEvent[] {
  const firstResume = readAgentSlice(state).responses.length === 0;
  const responseId = firstResume
    ? selectAgentPresentation(cartridge, state).openingResponse
    : beliefDivergence(state).length === 0
      ? cartridge.story.resume.unchangedResponse
      : cartridge.story.resume.changedResponse;
  return [
    ...(firstResume
      ? cartridge.story.opening.beliefs.map(createMindBeliefEvent)
      : []),
    responseEvent(
      cartridge,
      state,
      responseId,
      `resume-${String(state.eventCount)}`,
    ),
    createTerminalModeEvent("tui"),
  ];
}

/** Replace remembered context wholesale before recording its acknowledgment. */
export function createAgentCompactEvents(
  cartridge: LoadedCartridge,
  state: SessionState,
): readonly EngineEvent[] {
  const compact = routeCompact(cartridge, state);
  const transition = (cartridge.story.phase2.transitions ?? []).find(
    (candidate) =>
      candidate.from === readStorySlice(state).stage &&
      candidate.trigger.kind === "compact",
  );
  const responseIds = [
    ...(transition === undefined
      ? []
      : [stageOpeningResponseId(cartridge, state, transition.to)]),
    compact.response,
  ];
  return [
    createMindCompactEvent(compact.summary, compact.beliefs),
    canRecordAuthoredResponses(cartridge, state, responseIds)
      ? createAgentResponseEvent(
          compact.response,
          `compact-${String(state.eventCount)}`,
        )
      : createAgentCapacityEvent(cartridge.story.fallback.response),
  ];
}
