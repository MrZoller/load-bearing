/** Deterministic cartridge-authored intent selection and consequence planning. */

import type {
  CartridgeAgentAction,
  CartridgeIntent,
  LoadedCartridge,
} from "../cartridge/types.js";
import { normalizeIntentPhrase } from "../cartridge/intent.js";
import { createShellExecuteEvent } from "../commands/shell.js";
import type { EngineEvent, SessionState } from "../events/state.js";
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
  createAgentCapacityEvent,
  createAgentMessageEvent,
  createAgentResponseEvent,
} from "./module.js";

export interface AgentIntentSelection {
  readonly intentId: string | null;
  readonly responseId: string;
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
      actions: cartridge.story.fallback.actions,
    };
  }
  return {
    intentId: intent.id,
    responseId: intent.response,
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
  if (!canRecordAuthoredResponse(cartridge, state, selection.responseId, 2)) {
    return [createAgentCapacityEvent(cartridge.story.fallback.response)];
  }
  const turnId = `turn-${String(state.eventCount)}`;
  return [
    createAgentMessageEvent(turnId, boundedInput),
    ...selection.actions.map((action) => createShellExecuteEvent(action.input)),
    createAgentResponseEvent(selection.responseId, turnId),
  ];
}
