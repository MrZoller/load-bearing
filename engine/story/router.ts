/** Pure sparse dialogue and compact routing over one shared story graph. */

import type {
  Archetype,
  CartridgeArchetypeCompact,
  CartridgeStory,
  LoadedCartridge,
} from "../cartridge/types.js";
import type { SessionState } from "../events/state.js";
import { readTerminalSlice } from "../terminal/terminal.js";
import { storyConditionsMatch } from "./conditions.js";
import { readStorySlice } from "./story.js";

export interface StoryResponseRouteSelection {
  readonly responseId: string;
  /** Empty means the intent's default response was retained. */
  readonly routeId: string;
}

export interface ModelHandoffRouteSelection {
  readonly predecessor: string;
  readonly successor: string;
  readonly predecessorArchetype: Archetype;
  readonly successorArchetype: Archetype;
  /** Empty when no reusable pair response has been authored yet. */
  readonly responseId: string;
  /** Empty when the incident supplies no additional line. */
  readonly additionResponseId: string;
}

function modelArchetype(
  cartridge: LoadedCartridge,
  modelId: string,
): Archetype {
  const model = cartridge.models.find((candidate) => candidate.id === modelId);
  if (model === undefined)
    throw new Error(`story router: unknown model ${JSON.stringify(modelId)}`);
  return model.archetype;
}

/** Select directional handoff copy without drawing randomness or changing state. */
export function routeModelHandoff(
  cartridge: LoadedCartridge,
  state: SessionState,
  successor: string,
): ModelHandoffRouteSelection {
  const predecessor = readTerminalSlice(state).activeModel;
  const predecessorArchetype = modelArchetype(cartridge, predecessor);
  const successorArchetype = modelArchetype(cartridge, successor);
  const handoff = cartridge.story.phase2.handoffs.find(
    (candidate) =>
      candidate.predecessor === predecessorArchetype &&
      candidate.successor === successorArchetype,
  );
  return {
    predecessor,
    successor,
    predecessorArchetype,
    successorArchetype,
    responseId: handoff?.response ?? "",
    additionResponseId: handoff?.additionResponse ?? "",
  };
}

function activeArchetype(cartridge: LoadedCartridge, state: SessionState) {
  const model = cartridge.models.find(
    (candidate) => candidate.id === readTerminalSlice(state).activeModel,
  );
  if (model === undefined)
    throw new Error("story router: active model is not declared");
  return model.archetype;
}

/**
 * Select the first authored override whose present selectors all match.
 * `beat` is a shared graph identity, never a model-owned branch.
 */
export function routeStoryResponse(
  cartridge: LoadedCartridge,
  state: SessionState,
  beat: string,
  defaultResponseId: string,
): StoryResponseRouteSelection {
  const archetype = activeArchetype(cartridge, state);
  const stage = readStorySlice(state).stage;
  const route = cartridge.story.phase2.routes.find(
    (candidate) =>
      candidate.beat === beat &&
      (candidate.archetype === "" || candidate.archetype === archetype) &&
      (candidate.stage === -1 || candidate.stage === stage) &&
      storyConditionsMatch(state, candidate.when),
  );
  return route === undefined
    ? { responseId: defaultResponseId, routeId: "" }
    : { responseId: route.response, routeId: route.id };
}

/** Select sparse archetype compact content, retaining the authored default. */
export function routeCompact(
  cartridge: LoadedCartridge,
  state: SessionState,
): CartridgeStory["compact"] | CartridgeArchetypeCompact {
  const archetype = activeArchetype(cartridge, state);
  return (
    cartridge.story.compact.archetypes.find(
      (candidate) => candidate.archetype === archetype,
    ) ?? cartridge.story.compact
  );
}
