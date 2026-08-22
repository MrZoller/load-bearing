/** Deterministic cartridge-authored intent selection and consequence planning. */

import type {
  CartridgeAgentAction,
  CartridgeIntent,
  LoadedCartridge,
} from "../cartridge/types.js";
import { createShellExecuteEvent } from "../commands/shell.js";
import type { EngineEvent, SessionState } from "../events/state.js";
import { createAgentMessageEvent, createAgentResponseEvent } from "./module.js";

export interface AgentIntentSelection {
  readonly intentId: string | null;
  readonly responseId: string;
  readonly actions: readonly CartridgeAgentAction[];
}

/** Match authored phrases without consulting locale, model output, or wall time. */
export function normalizeAgentInput(input: string): string {
  return input.trim().replace(/\s+/gu, " ").toLowerCase();
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
  const selection = selectAgentIntent(cartridge, input);
  const turnId = `turn-${String(state.eventCount)}`;
  return [
    createAgentMessageEvent(turnId, input),
    ...selection.actions.map((action) => createShellExecuteEvent(action.input)),
    createAgentResponseEvent(selection.responseId, turnId),
  ];
}
