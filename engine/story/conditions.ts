/** Evaluation of the closed cartridge-authored story condition vocabulary. */

import type { CartridgeBelief } from "../cartridge/types.js";
import type { SessionState } from "../events/state.js";
import { readMindSlice, hasWaiverConsent } from "../mind/mind.js";
import type { Belief } from "../mind/types.js";
import { readVfsSlice } from "../vfs/module.js";
import { queryVfsTruth } from "../vfs/vfs.js";
import { readWorldSlice } from "../world/module.js";
import { lookupService } from "../world/world.js";
import { queryStoryCounter, readStorySlice } from "./story.js";
import type { StoryCondition } from "./types.js";

function beliefMatches(actual: Belief, expected: CartridgeBelief): boolean {
  if (actual.kind !== expected.kind) return false;
  if (actual.kind === "file-exists" && expected.kind === "file-exists")
    return actual.path === expected.path && actual.exists === expected.exists;
  if (actual.kind === "file-contents" && expected.kind === "file-contents")
    return (
      actual.path === expected.path && actual.contents === expected.contents
    );
  if (actual.kind === "git-head" && expected.kind === "git-head")
    return (
      actual.head.kind === expected.head.kind &&
      actual.head.target === expected.head.target
    );
  if (actual.kind === "service-state" && expected.kind === "service-state")
    return (
      actual.service === expected.service && actual.state === expected.state
    );
  if (actual.kind === "service-health" && expected.kind === "service-health")
    return (
      actual.service === expected.service && actual.health === expected.health
    );
  return false;
}

export function storyConditionMatches(
  state: SessionState,
  condition: StoryCondition,
): boolean {
  if (condition.kind === "file-exists")
    return (
      (queryVfsTruth(readVfsSlice(state), condition.path).kind !==
        "missing") ===
      condition.exists
    );
  if (condition.kind === "file-contents") {
    const truth = queryVfsTruth(readVfsSlice(state), condition.path);
    return truth.kind === "file" && truth.contents === condition.equals;
  }
  if (condition.kind === "service-state")
    return (
      lookupService(readWorldSlice(state), condition.service)?.state ===
      condition.state
    );
  if (condition.kind === "service-health")
    return (
      lookupService(readWorldSlice(state), condition.service)?.health ===
      condition.health
    );
  if (condition.kind === "belief")
    return readMindSlice(state).beliefs.some((belief) =>
      beliefMatches(belief, condition.belief),
    );
  if (condition.kind === "waiver-consent")
    return hasWaiverConsent(readMindSlice(state), condition);
  if (condition.kind === "story-counter") {
    const result = queryStoryCounter(readStorySlice(state), condition.counter);
    return (
      result.kind === "value" &&
      (condition.comparison === "equal"
        ? result.value === condition.value
        : result.value >= condition.value)
    );
  }
  return readStorySlice(state).facts.some(
    (fact) => fact.id === condition.fact && fact.kind === condition.factKind,
  );
}

export function storyConditionsMatch(
  state: SessionState,
  conditions: readonly StoryCondition[],
): boolean {
  return conditions.every((condition) =>
    storyConditionMatches(state, condition),
  );
}
