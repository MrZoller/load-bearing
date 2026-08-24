/** Generic cartridge-data reaction predicates and owner-event planning. */

import type { ReactionAction, ReactionPredicate } from "./cartridge/types.js";
import type { EngineEvent, SessionState } from "./events/state.js";
import { evaluateFilePredicate } from "./tests/planner.js";
import { readVfsSlice } from "./vfs/module.js";
import { readWorldSlice } from "./world/module.js";
import { lookupProcess, lookupService } from "./world/world.js";
import { createStoryBeatReachedEvent } from "./story/module.js";

export function reactionPredicateMatches(
  predicate: ReactionPredicate,
  state: SessionState,
): boolean {
  if (predicate.kind === "file-exists" || predicate.kind === "file-contents")
    return evaluateFilePredicate(predicate, readVfsSlice(state));
  const world = readWorldSlice(state);
  if (predicate.kind === "process-state")
    return (
      lookupProcess(world, predicate["process"])?.state === predicate.state
    );
  const service = lookupService(world, predicate.service);
  return predicate.kind === "service-state"
    ? service?.state === predicate.state
    : service?.health === predicate.health;
}

export function reactionActionEvent(action: ReactionAction): EngineEvent {
  switch (action.kind) {
    case "story-reach":
      return createStoryBeatReachedEvent(action.beat);
    case "service-state":
      return {
        type:
          action.state === "running"
            ? "world.service-start"
            : "world.service-stop",
        payload: { id: action.service },
        version: 0,
      };
    case "service-health":
      return {
        type: "world.service-health",
        payload: { id: action.service, health: action.health },
        version: 0,
      };
    case "process-state":
      return {
        type: "world.process-transition",
        payload: { id: action["process"], state: action.state },
        version: 0,
      };
    case "log-append":
      return {
        type: "world.log-append",
        payload: { id: action.log, entry: action.entry },
        version: 0,
      };
  }
}
