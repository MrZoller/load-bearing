/** The sole translation boundary from cartridge story actions to owner events. */

import type { CartridgeStoryAction } from "../cartridge/types.js";
import type { EngineEvent, SessionState } from "../events/state.js";
import { readStorySlice } from "./story.js";

/** Resolve the reached beat's selected consequence list inside its owner. */
export function selectedStoryActions(
  state: SessionState,
): readonly CartridgeStoryAction[] {
  const story = readStorySlice(state);
  const beat = state.cartridge.story.phase2.beats.find(
    (candidate) => candidate.id === story.currentBeat,
  );
  if (beat === undefined)
    throw new Error(
      `story consequences: selected unknown story beat ${JSON.stringify(story.currentBeat)}`,
    );
  if (story.currentVariant === "") return beat.actions;
  const variant = beat.variants.find(
    (candidate) => candidate.id === story.currentVariant,
  );
  if (variant === undefined)
    throw new Error(
      `story consequences: selected unknown story variant ${JSON.stringify(story.currentVariant)}`,
    );
  return variant.actions;
}

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
 * state refuses an adjacent attempt, but record that refusal as content.
 * Story consequences remain strict above because they stage atomically.
 */
export function candidateStoryActionEvent(
  action: CartridgeStoryAction,
): EngineEvent {
  const event = storyActionEvent(action);
  if (event.type !== "vfs.write") return event;
  return {
    ...event,
    // A non-strict candidate write must stay visible when it fails. Otherwise
    // the selected normal reply would claim an adjacent mutation that did not
    // happen, and the ordinary visitor turn would erase its own failure.
    payload: { ...event.payload, strict: false, transcript: true },
  };
}
