/** Deterministic cartridge-authored intent selection and consequence planning. */

import type {
  CartridgeAgentAction,
  CartridgeIntent,
  LoadedCartridge,
} from "../cartridge/types.js";
import { normalizeIntentPhrase } from "../cartridge/intent.js";
import { createShellExecuteEvent } from "../commands/shell.js";
import type { EngineEvent, SessionState } from "../events/state.js";
import { MAX_AGENT_TEXT_LENGTH } from "./agent.js";
import { createAgentMessageEvent, createAgentResponseEvent } from "./module.js";

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
  let bounded = "";
  let count = 0;
  for (const codePoint of input) {
    if (count === MAX_AGENT_TEXT_LENGTH - 1) return `${bounded}…`;
    bounded += codePoint;
    count += 1;
  }
  return input;
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
  const turnId = `turn-${String(state.eventCount)}`;
  return [
    createAgentMessageEvent(turnId, boundedInput),
    ...selection.actions.map((action) => createShellExecuteEvent(action.input)),
    createAgentResponseEvent(selection.responseId, turnId),
  ];
}
