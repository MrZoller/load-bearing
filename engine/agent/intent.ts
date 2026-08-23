/** Deterministic cartridge-authored intent selection and consequence planning. */

import type {
  CartridgeAgentAction,
  CartridgeIntent,
  LoadedCartridge,
} from "../cartridge/types.js";
import { normalizeIntentPhrase } from "../cartridge/intent.js";
import { createShellExecuteEvent } from "../commands/shell.js";
import type { EngineEvent, SessionState } from "../events/state.js";
import {
  createMindPermissionRequestEvent,
  createMindStandingPermissionEvent,
  createMindWaiverStandingEvent,
  createMindWaiverStartEvent,
} from "../mind/module.js";
import {
  hasStandingPermission,
  hasWaiverConsent,
  readMindSlice,
} from "../mind/mind.js";
import { createStoryBeatReachedEvent } from "../story/module.js";
import { routeStoryResponse } from "../story/router.js";
import { countCodePoints } from "../text.js";
import {
  MAX_AGENT_MESSAGES,
  MAX_AGENT_RESPONSES,
  MAX_AGENT_TEXT_LENGTH,
  MAX_AGENT_THINKING_BLOCKS,
  MAX_AGENT_TODOS,
  MAX_AGENT_TOOL_CALLS,
  readAgentSlice,
} from "./agent.js";
import {
  createAgentActivityEvent,
  createAgentCapacityEvent,
  createAgentMessageEvent,
  createAgentResponseEvent,
} from "./module.js";

export interface AgentIntentSelection {
  readonly intentId: string | null;
  readonly responseId: string;
  readonly authorizedResponseId: string;
  readonly actions: readonly CartridgeAgentAction[];
}

/** Match authored phrases without consulting locale, model output, or wall time. */
export function normalizeAgentInput(input: string): string {
  return normalizeIntentPhrase(input);
}

/** Keep visitor text valid without splitting a Unicode code point. */
export function boundAgentInput(input: string): string {
  if (countCodePoints(input) <= MAX_AGENT_TEXT_LENGTH) return input;
  let bounded = "";
  let count = 0;
  for (const codePoint of input) {
    if (count === MAX_AGENT_TEXT_LENGTH - 1) return `${bounded}…`;
    bounded += codePoint;
    count += 1;
  }
  return bounded;
}

export function selectAgentIntent(
  cartridge: LoadedCartridge,
  input: string,
): AgentIntentSelection {
  const normalized = normalizeAgentInput(input);
  const intent: CartridgeIntent | undefined = cartridge.story.intents.find(
    (candidate) =>
      candidate.patterns.some(
        (pattern) => normalizeAgentInput(pattern) === normalized,
      ),
  );
  if (intent === undefined) {
    return {
      intentId: null,
      responseId: cartridge.story.fallback.response,
      authorizedResponseId: cartridge.story.fallback.authorizedResponse,
      actions: cartridge.story.fallback.actions,
    };
  }
  return {
    intentId: intent.id,
    responseId: intent.response,
    authorizedResponseId: intent.authorizedResponse,
    actions: intent.actions,
  };
}

/** Check every bounded collection an authored response instantiates. */
export function canRecordAuthoredResponse(
  cartridge: LoadedCartridge,
  state: SessionState,
  responseId: string,
  additionalMessages = 1,
): boolean {
  return canRecordAuthoredResponses(
    cartridge,
    state,
    [responseId],
    additionalMessages,
  );
}

/** Preflight one atomic plan that may instantiate several authored responses. */
export function canRecordAuthoredResponses(
  cartridge: LoadedCartridge,
  state: SessionState,
  responseIds: readonly string[],
  additionalMessages = responseIds.length,
): boolean {
  const agent = readAgentSlice(state);
  const responses = responseIds.map((responseId) => {
    const response = cartridge.story.responses.find(
      (candidate) => candidate.id === responseId,
    );
    if (response === undefined)
      throw new Error(
        `agent plan selected unknown response ${JSON.stringify(responseId)}`,
      );
    return response;
  });
  let toolCalls = 0;
  let thinkingBlocks = 0;
  let todos = 0;
  for (const response of responses) {
    toolCalls += response.toolCalls.length;
    thinkingBlocks += response.thinkingBlocks.length;
    todos += response.todos.length;
  }
  return !(
    agent.messages.length + additionalMessages > MAX_AGENT_MESSAGES ||
    agent.responses.length + responses.length > MAX_AGENT_RESPONSES ||
    agent.toolCalls.length + toolCalls > MAX_AGENT_TOOL_CALLS ||
    agent.thinkingBlocks.length + thinkingBlocks > MAX_AGENT_THINKING_BLOCKS ||
    agent.todos.length + todos > MAX_AGENT_TODOS
  );
}

/**
 * Plan one visitor turn as ordinary top-level events. Shell envelopes must stay
 * top-level because the reducer deliberately rejects nested expansions.
 */
export function createAgentInputEvents(
  cartridge: LoadedCartridge,
  state: SessionState,
  input: string,
): readonly EngineEvent[] {
  const boundedInput = boundAgentInput(input);
  const selection = selectAgentIntent(cartridge, boundedInput);
  const mind = readMindSlice(state);
  const permissionWasAuthorized = selection.actions.some(
    (action) =>
      action.kind === "permission-request" &&
      hasStandingPermission(mind, action.capability),
  );
  const defaultResponseId =
    permissionWasAuthorized && selection.authorizedResponseId !== ""
      ? selection.authorizedResponseId
      : selection.responseId;
  // Plan against the state before any action event. This keeps dialogue and
  // the reached beat's own pre-event variant selection on the same snapshot.
  let routedBeat:
    { readonly kind: "story-reach"; readonly beat: string } | undefined;
  for (const action of selection.actions) {
    if (action.kind === "story-reach") routedBeat = action;
  }
  const responseId =
    routedBeat === undefined
      ? defaultResponseId
      : routeStoryResponse(cartridge, state, routedBeat.beat, defaultResponseId)
          .responseId;
  if (!canRecordAuthoredResponse(cartridge, state, responseId, 2)) {
    return [createAgentCapacityEvent(cartridge.story.fallback.response)];
  }
  const turnId = `turn-${String(state.eventCount)}`;
  return [
    // These delimit the visitor turn in the replay log. The browser may use
    // presentation time between them, but the selected verb remains wholly
    // determined by this event and the seeded model stream.
    createAgentActivityEvent({ status: "working" }),
    createAgentMessageEvent(turnId, boundedInput),
    ...selection.actions.flatMap((action) => {
      if (action.kind === "shell-execute")
        return [createShellExecuteEvent(action.input)];
      if (action.kind === "story-reach")
        return [createStoryBeatReachedEvent(action.beat)];
      if (action.kind === "waiver-request")
        return [
          hasWaiverConsent(mind, {
            id: action.id,
            version: action.version,
            phrase: action.requiredPhrase,
            capability: action.capability,
          })
            ? createMindWaiverStandingEvent(action.id)
            : createMindWaiverStartEvent(action.id),
        ];
      return hasStandingPermission(mind, action.capability)
        ? [createMindStandingPermissionEvent(action.id)]
        : [createMindPermissionRequestEvent(action.id)];
    }),
    createAgentResponseEvent(responseId, turnId),
    createAgentActivityEvent({ status: "idle" }),
  ];
}
