/** Pure sparse dialogue and compact routing over one shared story graph. */

import type {
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
