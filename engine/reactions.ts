/** Generic cartridge-data reaction predicates and owner-event planning. */

import type { ReactionAction, ReactionPredicate } from "./cartridge/types.js";
import type { EngineEvent, SessionState } from "./events/state.js";
import { evaluateFilePredicate } from "./tests/planner.js";
import { readVfsSlice } from "./vfs/module.js";
import { resolveVfsPath } from "./vfs/path.js";
import { readWorldSlice } from "./world/module.js";
import { lookupProcess, lookupService } from "./world/world.js";
import { createStoryBeatReachedEvent } from "./story/module.js";

export function reactionPredicateMatches(
  predicate: ReactionPredicate,
  state: SessionState,
  source: EngineEvent,
): boolean {
  if (predicate.kind === "file-exists" || predicate.kind === "file-contents")
    return evaluateFilePredicate(predicate, readVfsSlice(state));
  if (predicate.kind === "copy-paths") {
    if (source.type !== "vfs.copy") return false;
    const sourcePath = source.payload?.["source"];
    const destinationPath = source.payload?.["destination"];
    if (
      source.payload?.["success"] !== predicate.success ||
      typeof sourcePath !== "string" ||
      typeof destinationPath !== "string"
    )
      return false;
    const vfs = readVfsSlice(state);
    const resolve = (path: string) =>
      resolveVfsPath(path, vfs.cwd, vfs.identity.home).path;
    return (
      resolve(sourcePath) === resolve(predicate.source) &&
      resolve(destinationPath) === resolve(predicate.destination)
    );
  }
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
