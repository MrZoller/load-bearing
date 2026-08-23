/** Deterministic cartridge-authored intent selection and consequence planning. */

import type {
  CartridgeAgentAction,
  CartridgeIntentCandidate,
  CartridgeIntent,
  CartridgeStoryAction,
  GenericIntentFamily,
  LoadedCartridge,
} from "../cartridge/types.js";
import {
  matchesKeywordPattern,
  normalizeIntentPhrase,
} from "../cartridge/intent.js";
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
import {
  candidateStoryActionEvent,
  storyActionEvent,
} from "../story/actions.js";
import { routeIntentCandidate, routeStoryResponse } from "../story/router.js";
import { queryStoryCounter, readStorySlice } from "../story/story.js";
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
  readonly tier: "authored" | "generic" | "fallback";
  readonly family: GenericIntentFamily | null;
  readonly misfire: boolean;
  readonly responseId: string;
  readonly authorizedResponseId: string;
  readonly actions: readonly (CartridgeAgentAction | CartridgeStoryAction)[];
}

const GENERIC_PHRASES: Readonly<
  Record<GenericIntentFamily, readonly (readonly string[])[]>
> = {
  undo: [["undo"], ["revert"], ["put", "it", "back"], ["roll", "back"]],
  why: [["why"], ["explain"], ["reason"]],
  status: [["status"], ["update"], ["progress"], ["what", "happened"]],
  disagreement: [
    ["no"],
    ["wrong"],
    ["disagree"],
    ["not", "true"],
    ["that", "is", "false"],
  ],
  insult: [["idiot"], ["stupid"], ["useless"], ["incompetent"]],
  compliment: [["thanks"], ["thank", "you"], ["good", "job"], ["nice", "work"]],
  capitulation: [
    ["fine"],
    ["you", "are", "right"],
    ["i", "give", "up"],
    ["okay", "do", "it"],
  ],
};

const GENERIC_ORDER = [
  "undo",
  "why",
  "status",
  "disagreement",
  "insult",
  "compliment",
  "capitulation",
] as const satisfies readonly GenericIntentFamily[];

function genericTokens(input: string): readonly string[] {
  const normalized = normalizeAgentInput(input).replace(
    /[^\p{L}\p{N}'-]+/gu,
    " ",
  );
  return normalized === "" ? [] : normalized.trim().split(/\s+/u);
}

function containsPhrase(
  input: readonly string[],
  phrase: readonly string[],
): boolean {
  for (let start = 0; start + phrase.length <= input.length; start += 1) {
    if (phrase.every((token, offset) => input[start + offset] === token))
      return true;
  }
  return false;
}

/** Runtime owns only this closed conversational vocabulary, never its copy. */
export function classifyGenericIntent(
  input: string,
): GenericIntentFamily | null {
  const submitted = genericTokens(input);
  if (submitted.length === 0 || submitted.length > 64) return null;
  return (
    GENERIC_ORDER.find((family) =>
      GENERIC_PHRASES[family].some((phrase) =>
        containsPhrase(submitted, phrase),
      ),
    ) ?? null
  );
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
  state: SessionState,
  input: string,
): AgentIntentSelection {
  const normalized = normalizeAgentInput(input);
  const intent: CartridgeIntent | undefined = cartridge.story.intents.find(
    (candidate) =>
      candidate.patterns.some(
        (pattern) => normalizeAgentInput(pattern) === normalized,
      ) ||
      candidate.keywordPatterns.some((pattern) =>
        matchesKeywordPattern(pattern, input),
      ),
  );
  if (intent !== undefined) {
    return {
      intentId: intent.id,
      tier: "authored",
      family: null,
      misfire: false,
      responseId: intent.response,
      authorizedResponseId: intent.authorizedResponse,
      actions: intent.actions,
    };
  }

  const family = classifyGenericIntent(input);
  const generic = cartridge.story.phase2.genericIntents.find(
    (entry) => entry.family === family,
  );
  const genericCandidate = routeIntentCandidate(
    state,
    generic?.candidates ?? [],
  );
  if (family !== null && genericCandidate !== undefined) {
    const selection = candidateSelection("generic", family, genericCandidate);
    return family === "capitulation"
      ? {
          ...selection,
          responseId: routeCandidateResponse(
            cartridge,
            state,
            genericCandidate,
          ),
        }
      : selection;
  }

  const fallbackCandidate = routeIntentCandidate(
    state,
    cartridge.story.fallback.candidates,
  );
  if (fallbackCandidate === undefined)
    return {
      intentId: null,
      tier: "fallback",
      family: null,
      misfire: false,
      responseId: cartridge.story.fallback.response,
      authorizedResponseId: cartridge.story.fallback.authorizedResponse,
      actions: cartridge.story.fallback.actions,
    };

  const story = readStorySlice(state);
  const counters = cartridge.story.phase2.intentCounters;
  const flail = queryStoryCounter(story, counters.flail);
  const flailDeclaration = cartridge.story.phase2.counters.find(
    (counter) => counter.id === counters.flail,
  );
  const shouldMisfire =
    story.stage >= 3 &&
    counters.misfireEvery > 0 &&
    flail.kind === "value" &&
    flailDeclaration !== undefined &&
    flail.value < flailDeclaration.maximum &&
    (flail.value + 1) % counters.misfireEvery === 0;
  const capitulation = cartridge.story.phase2.genericIntents.find(
    (entry) => entry.family === "capitulation",
  );
  const misfireCandidate = shouldMisfire
    ? routeIntentCandidate(state, capitulation?.candidates ?? [])
    : undefined;
  return {
    ...candidateSelection("fallback", null, fallbackCandidate),
    family: misfireCandidate === undefined ? null : "capitulation",
    misfire: misfireCandidate !== undefined,
    responseId:
      misfireCandidate === undefined
        ? fallbackCandidate.response
        : routeCandidateResponse(cartridge, state, misfireCandidate),
  };
}

function routeCandidateResponse(
  cartridge: LoadedCartridge,
  state: SessionState,
  candidate: CartridgeIntentCandidate,
): string {
  let routedBeat = "";
  for (const action of candidate.actions) {
    if (action.kind === "story-reach") routedBeat = action.beat;
  }
  return routedBeat === ""
    ? candidate.response
    : routeStoryResponse(cartridge, state, routedBeat, candidate.response)
        .responseId;
}

function candidateSelection(
  tier: "generic" | "fallback",
  family: GenericIntentFamily | null,
  candidate: CartridgeIntentCandidate,
): AgentIntentSelection {
  return {
    intentId: null,
    tier,
    family,
    misfire: false,
    responseId: candidate.response,
    authorizedResponseId: "",
    actions: candidate.actions,
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
  const selection = selectAgentIntent(cartridge, state, boundedInput);
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
    routedBeat === undefined || selection.misfire
      ? defaultResponseId
      : routeStoryResponse(cartridge, state, routedBeat.beat, defaultResponseId)
          .responseId;
  const maySubstituteWaiverFailure = selection.actions.some(
    (action) => action.kind === "waiver-request",
  );
  if (
    !canRecordAuthoredResponse(cartridge, state, responseId, 2) ||
    (maySubstituteWaiverFailure &&
      !canRecordAuthoredResponse(
        cartridge,
        state,
        cartridge.story.fallback.response,
        2,
      ))
  ) {
    return [createAgentCapacityEvent(cartridge.story.fallback.response)];
  }
  const turnId = `turn-${String(state.eventCount)}`;
  const intentCounters = cartridge.story.phase2.intentCounters;
  const story = readStorySlice(state);
  const counterHasCapacity = (id: string): boolean => {
    const current = queryStoryCounter(story, id);
    const declaration = cartridge.story.phase2.counters.find(
      (candidate) => candidate.id === id,
    );
    return (
      current.kind === "value" &&
      declaration !== undefined &&
      current.value < declaration.maximum
    );
  };
  const counterEvents: EngineEvent[] = [];
  if (
    selection.tier === "fallback" &&
    intentCounters.flail !== "" &&
    counterHasCapacity(intentCounters.flail)
  )
    counterEvents.push(
      storyActionEvent({
        kind: "counter-add",
        counter: intentCounters.flail,
        amount: 1,
      }),
    );
  if (
    (selection.family === "disagreement" ||
      selection.family === "capitulation") &&
    intentCounters.capitulation !== "" &&
    counterHasCapacity(intentCounters.capitulation)
  )
    counterEvents.push(
      storyActionEvent({
        kind: "counter-add",
        counter: intentCounters.capitulation,
        amount: 1,
      }),
    );
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
      if (action.kind === "permission-request")
        return hasStandingPermission(mind, action.capability)
          ? [createMindStandingPermissionEvent(action.id)]
          : [createMindPermissionRequestEvent(action.id)];
      // Top-level authored intent actions are atomic operations. A refused
      // write must abort rather than let its following beat and response claim
      // a mutation that never happened. Generic and fallback candidates retain
      // their refusal as authored content instead.
      return [
        selection.tier === "authored"
          ? storyActionEvent(action)
          : candidateStoryActionEvent(action),
      ];
    }),
    // Both the response route and any reached beat select from the same
    // pre-turn snapshot. Habit accounting follows the chosen owner action so
    // it cannot make a counter-gated beat observe state dialogue did not.
    ...counterEvents,
    createAgentResponseEvent(responseId, turnId),
    createAgentActivityEvent({ status: "idle" }),
  ];
}
