/** Deterministic cartridge-authored intent selection and consequence planning. */

import type {
  CartridgeAgentAction,
  CartridgeIntent,
  LoadedCartridge,
} from "../cartridge/types.js";
import { normalizeIntentPhrase } from "../cartridge/intent.js";
import { createShellExecuteEvent } from "../commands/shell.js";
import type { EngineEvent, SessionState } from "../events/state.js";
import { createMindPermissionRequestedEvent } from "../mind/module.js";
import { hasStandingPermission, readMindSlice } from "../mind/mind.js";
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
  const agent = readAgentSlice(state);
  const response = cartridge.story.responses.find(
    (candidate) => candidate.id === responseId,
  );
  if (response === undefined) {
    throw new Error(
      `agent plan selected unknown response ${JSON.stringify(responseId)}`,
    );
  }
  return !(
    agent.messages.length + additionalMessages > MAX_AGENT_MESSAGES ||
    agent.responses.length + 1 > MAX_AGENT_RESPONSES ||
    agent.toolCalls.length + response.toolCalls.length > MAX_AGENT_TOOL_CALLS ||
    agent.thinkingBlocks.length + response.thinkingBlocks.length >
      MAX_AGENT_THINKING_BLOCKS ||
    agent.todos.length + response.todos.length > MAX_AGENT_TODOS
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
      hasStandingPermission(mind, {
        kind: "exact",
        action: action.action,
        resource: action.resource,
      }),
  );
  const responseId =
    permissionWasAuthorized && selection.authorizedResponseId !== ""
      ? selection.authorizedResponseId
      : selection.responseId;
  if (!canRecordAuthoredResponse(cartridge, state, responseId, 2)) {
    return [createAgentCapacityEvent(cartridge.story.fallback.response)];
  }
  const turnId = `turn-${String(state.eventCount)}`;
  return [
    // These delimit the visitor turn in the replay log. The browser may use
    // presentation time between them, but the selected verb remains wholly
    // determined by this event and the seeded model stream.
    createAgentActivityEvent({ status: "working", stage: 0 }),
    createAgentMessageEvent(turnId, boundedInput),
    ...selection.actions.flatMap((action) => {
      if (action.kind === "shell-execute")
        return [createShellExecuteEvent(action.input)];
      const capability = {
        kind: "exact" as const,
        action: action.action,
        resource: action.resource,
      };
      return hasStandingPermission(mind, capability)
        ? []
        : [createMindPermissionRequestedEvent(action.id, capability)];
    }),
    createAgentResponseEvent(responseId, turnId),
    createAgentActivityEvent({ status: "idle" }),
  ];
}
