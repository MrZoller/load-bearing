/** The sole translation boundary from cartridge story actions to owner events. */

import type { CartridgeStoryAction } from "../cartridge/types.js";
import type { EngineEvent } from "../events/state.js";

export function storyActionEvent(action: CartridgeStoryAction): EngineEvent {
  switch (action.kind) {
    case "counter-add":
      return {
        type: "story.counter-added",
        payload: { counter: action.counter, amount: action.amount },
        version: 0,
      };
    case "story-reach":
      return {
        type: "story.beat-reached",
        payload: { beat: action.beat },
        version: 0,
      };
    case "file-write":
      return {
        type: "vfs.write",
        payload: {
          path: action.path,
          contents: action.contents,
          transcript: false,
          // Consequences stage as one outer transition. A refused VFS mutation
          // must abort that transaction instead of looking like a successful
          // owner event whose reaction may publish incoherent world state.
          strict: true,
        },
        version: 0,
      };
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

/**
 * Intent candidates retain their authored reply when a visitor-created VFS
 * state refuses an adjacent attempt; story consequences remain strict above.
 */
export function candidateStoryActionEvent(
  action: CartridgeStoryAction,
): EngineEvent {
  const event = storyActionEvent(action);
  if (event.type !== "vfs.write") return event;
  return {
    ...event,
    payload: { ...event.payload, strict: false },
  };
}
