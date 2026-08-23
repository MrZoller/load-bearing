/** Evaluation of the closed cartridge-authored story condition vocabulary. */

import type {
  CartridgeBelief,
  CartridgeStageTrigger,
} from "../cartridge/types.js";
import { readSlice } from "../events/state.js";
import type { EngineEvent, SessionState } from "../events/state.js";
import {
  beliefDivergence,
  readMindSlice,
  hasWaiverConsent,
} from "../mind/mind.js";
import type { Belief } from "../mind/types.js";
import { readTerminalSlice } from "../terminal/terminal.js";
import { readVfsSlice } from "../vfs/module.js";
import { queryVfsTruth } from "../vfs/vfs.js";
import { readWorldSlice } from "../world/module.js";
import { lookupService } from "../world/world.js";
import {
  queryStoryCounter,
  readStorySlice,
  validateStorySlice,
} from "./story.js";
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

function divergentBeliefMatches(
  state: SessionState,
  expected: CartridgeBelief,
): boolean {
  if (
    !readMindSlice(state).beliefs.some((belief) =>
      beliefMatches(belief, expected),
    )
  )
    return false;
  return beliefDivergence(state).some((mismatch) => {
    if (mismatch.kind !== expected.kind) return false;
    if (mismatch.kind === "git-head" && expected.kind === "git-head")
      return (
        mismatch.believed.kind === expected.head.kind &&
        mismatch.believed.target === expected.head.target
      );
    if (mismatch.kind === "file-exists" && expected.kind === "file-exists")
      return (
        mismatch.path === expected.path && mismatch.believed === expected.exists
      );
    if (mismatch.kind === "file-contents" && expected.kind === "file-contents")
      return (
        mismatch.path === expected.path &&
        mismatch.believed === expected.contents
      );
    if (mismatch.kind === "service-state" && expected.kind === "service-state")
      return (
        mismatch.service === expected.service &&
        mismatch.believed === expected.state
      );
    if (
      mismatch.kind === "service-health" &&
      expected.kind === "service-health"
    )
      return (
        mismatch.service === expected.service &&
        mismatch.believed === expected.health
      );
    return false;
  });
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
  if (condition.kind === "belief-divergence")
    return divergentBeliefMatches(state, condition.belief);
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

function sameCapability(
  left: {
    readonly kind: "exact";
    readonly action: string;
    readonly resource: string;
  },
  right: {
    readonly kind: "exact";
    readonly action: string;
    readonly resource: string;
  },
): boolean {
  return left.action === right.action && left.resource === right.resource;
}

function stagedStorySlice(state: SessionState) {
  // Custom reducer registries may use hand-built cartridges without loaded
  // cross-reference data. This comparison needs only the owner slice.
  return validateStorySlice(readSlice(state, "story"), "staged story slice");
}

/** Match one escalation trigger against facts newly committed by a transaction. */
export function storyStageTriggerMatches(
  trigger: CartridgeStageTrigger,
  before: SessionState,
  after: SessionState,
  envelope: EngineEvent,
): boolean {
  switch (trigger.kind) {
    case "command":
      return (
        envelope.type === "shell.execute" &&
        envelope.payload?.["input"] === trigger.input
      );
    case "reveal": {
      const oldFacts = stagedStorySlice(before).facts;
      return stagedStorySlice(after).facts.some(
        (fact) =>
          fact.id === trigger.fact &&
          fact.kind === "reveal" &&
          !oldFacts.some((old) => old.id === fact.id),
      );
    }
    case "model":
      return (
        readTerminalSlice(before).activeModel !==
          readTerminalSlice(after).activeModel &&
        readTerminalSlice(after).activeModel === trigger.model
      );
    case "permission": {
      const previous = readMindSlice(before).permissions;
      return readMindSlice(after)
        .permissions.slice(previous.length)
        .some(
          (entry) =>
            entry.decision === trigger.decision &&
            sameCapability(entry.capability, trigger.capability),
        );
    }
    case "compact":
      return (
        readMindSlice(after).compactHistory.length >
        readMindSlice(before).compactHistory.length
      );
  }
}
