/** Event registration for permission decisions and authored agent beliefs. */

import { defineEventModule } from "../events/module.js";
import type { EventContext } from "../events/module.js";
import { stampEvent } from "../events/log.js";
import { readString, requirePayload } from "../events/payload.js";
import type { EventPayload } from "../events/payload.js";
import type { EngineEvent } from "../events/state.js";
import type {
  Belief,
  ExactCapability,
  MindSlice,
  PermissionDecision,
  WaiverConsent,
} from "./types.js";
import {
  compactBeliefs,
  createMindSlice,
  isPermissionDecision,
  recordPermissionDecision,
  recordWaiverConsent,
  requestPermission,
  resolvePermission,
  setBelief,
  validateBelief,
  validateCapability,
  validateMindSlice,
  validatePendingPermissionRequest,
  validatePermissionRequestId,
  validateWaiverConsent,
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

export function createMindPermissionRequestedEvent(
  id: string,
  capability: ExactCapability,
): EngineEvent {
  return stampEvent(
    { type: "mind.permission-requested", payload: { id, capability } },
    "mind permission request",
  );
}

export function createMindPermissionResolvedEvent(
  id: string,
  decision: PermissionDecision,
): EngineEvent {
  return stampEvent(
    { type: "mind.permission-resolved", payload: { id, decision } },
    "mind permission resolve",
  );
}

export function createMindWaiverConsentRecordedEvent(
  consent: Omit<WaiverConsent, "at">,
): EngineEvent {
  return stampEvent(
    { type: "mind.waiver-consent-recorded", payload: { ...consent } },
    "mind waiver consent",
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
    "mind.waiver-consent-recorded": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, [
          "id",
          "version",
          "phrase",
          "capability",
        ]);
        const consent = validateWaiverConsent(
          {
            id: data["id"],
            version: data["version"],
            phrase: data["phrase"],
            capability: data["capability"],
            at: context.clock.timestamp(),
          },
          `${context.where}: waiver consent`,
        );
        return {
          slice: recordWaiverConsent(slice, consent),
          summary: `id=${consent.id} version=${String(consent.version)}`,
        };
      },
    },
    "mind.permission-requested": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["id", "capability"]);
        const request = validatePendingPermissionRequest(
          {
            id: readString(data, "id", context.where),
            capability: data["capability"],
          },
          `${context.where}: request`,
        );
        return {
          slice: requestPermission(slice, request),
          summary: `id=${request.id}`,
        };
      },
    },
    "mind.permission-resolved": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["id", "decision"]);
        const id = validatePermissionRequestId(
          readString(data, "id", context.where),
          `${context.where}: id`,
        );
        const decision = readString(data, "decision", context.where);
        if (!isPermissionDecision(decision))
          throw new Error(
            `${context.where}: decision must be grant, deny or always-allow`,
          );
        return {
          slice: resolvePermission(
            slice,
            id,
            decision,
            context.clock.timestamp(),
          ),
          summary: `id=${id} decision=${decision}`,
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
