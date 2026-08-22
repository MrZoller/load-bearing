/** Event registration for permission decisions and authored agent beliefs. */

import { defineEventModule } from "../events/module.js";
import type { EventContext } from "../events/module.js";
import { stampEvent } from "../events/log.js";
import { readString, requirePayload } from "../events/payload.js";
import type { EventPayload } from "../events/payload.js";
import type { EngineEvent } from "../events/state.js";
import type { Belief, MindSlice } from "./types.js";
import {
  compactBeliefs,
  createMindSlice,
  isPermissionDecision,
  recordPermissionDecision,
  setBelief,
  validateBelief,
  validateCapability,
  validateMindSlice,
} from "./mind.js";

function payload(
  context: EventContext,
  fields: readonly string[],
): EventPayload {
  const value = requirePayload(context);
  const unknown = Object.keys(value)
    .filter((key) => !fields.includes(key))
    .sort();
  if (unknown.length > 0)
    throw new Error(
      `${context.where}: unexpected payload field(s) ${unknown.join(", ")}; expected ${fields.join(", ")}`,
    );
  return value;
}

function beliefs(value: unknown, where: string): readonly Belief[] {
  if (!Array.isArray(value)) throw new Error(`${where}: must be an array`);
  return value.map((belief, index) =>
    validateBelief(belief, `${where}[${String(index)}]`),
  );
}

export function createMindBeliefEvent(belief: Belief): EngineEvent {
  return stampEvent(
    { type: "mind.belief-set", payload: { belief } },
    "mind belief",
  );
}

export function createMindCompactEvent(
  summary: string,
  nextBeliefs: readonly Belief[],
): EngineEvent {
  return stampEvent(
    { type: "mind.compact", payload: { summary, beliefs: nextBeliefs } },
    "mind compact",
  );
}

export const MIND_MODULE = defineEventModule<MindSlice>({
  namespace: "mind",
  description:
    "Permission decisions and the agent's authored model of the world.",
  initialSlice: createMindSlice,
  validateSlice: validateMindSlice,
  events: {
    "mind.permission-decision": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["capability", "decision"]);
        const capability = validateCapability(
          data["capability"],
          `${context.where}: capability`,
        );
        const decision = readString(data, "decision", context.where);
        if (!isPermissionDecision(decision))
          throw new Error(
            `${context.where}: decision must be grant, deny or always-allow`,
          );
        return {
          slice: recordPermissionDecision(
            slice,
            capability,
            decision,
            context.clock.timestamp(),
          ),
          summary: `decision=${decision}`,
        };
      },
    },
    "mind.belief-set": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["belief"]);
        const belief = validateBelief(
          data["belief"],
          `${context.where}: belief`,
        );
        return {
          slice: setBelief(slice, belief),
          summary: `kind=${belief.kind}`,
        };
      },
    },
    "mind.compact": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["summary", "beliefs"]);
        const nextBeliefs = beliefs(
          data["beliefs"],
          `${context.where}: beliefs`,
        );
        return {
          slice: compactBeliefs(
            slice,
            readString(data, "summary", context.where),
            nextBeliefs,
            context.clock.timestamp(),
          ),
          summary: `beliefs=${String(nextBeliefs.length)}`,
        };
      },
    },
  },
});
