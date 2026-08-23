/** Event registration for permission decisions and authored agent beliefs. */

import { defineEventModule } from "../events/module.js";
import type { EventContext } from "../events/module.js";
import { stampEvent } from "../events/log.js";
import { readString, requirePayload } from "../events/payload.js";
import type { EventPayload } from "../events/payload.js";
import type { EngineEvent } from "../events/state.js";
import type {
  CartridgeAgentAction,
  CartridgeStoryAction,
} from "../cartridge/types.js";
import { storyActionEvent } from "../story/actions.js";
import type {
  Belief,
  ExactCapability,
  MindSlice,
  PermissionDecision,
  PendingWaiverRequest,
  WaiverConsent,
} from "./types.js";
import {
  compactBeliefs,
  createMindSlice,
  hasStandingPermission,
  hasWaiverConsent,
  isPermissionDecision,
  recordPermissionDecision,
  recordWaiverConsent,
  readMindSlice,
  requestPermission,
  resolvePermission,
  resolveWaiver,
  setBelief,
  startWaiver,
  validateBelief,
  validateCapability,
  validateMindSlice,
  validatePendingPermissionRequest,
  validatePendingWaiverRequest,
  validatePermissionRequestId,
  validateWaiverConsent,
} from "./mind.js";

function findOrchestrationAction<
  K extends "permission-request" | "waiver-request",
>(
  context: EventContext,
  id: string,
  kind: K,
): Extract<CartridgeAgentAction, { readonly kind: K }> {
  const actions = [
    ...context.cartridge.story.intents.flatMap((intent) => intent.actions),
    ...context.cartridge.story.fallback.actions,
  ];
  const action = actions.find(
    (candidate) => candidate.kind === kind && candidate.id === id,
  );
  if (action === undefined)
    throw new Error(
      `${context.where}: unknown authored ${kind} id ${JSON.stringify(id)}`,
    );
  return action as Extract<CartridgeAgentAction, { readonly kind: K }>;
}

function continuation(actions: readonly CartridgeStoryAction[]): EngineEvent[] {
  return actions.map(storyActionEvent);
}

function sameCapability(
  left: ExactCapability,
  right: ExactCapability,
): boolean {
  return (
    left.kind === right.kind &&
    left.action === right.action &&
    left.resource === right.resource
  );
}

function assertPendingPermissionMatches(
  context: EventContext,
  id: string,
  capability: ExactCapability,
): void {
  const pending = readMindSlice(context.state).pendingPermission;
  if (
    pending === null ||
    pending.id !== id ||
    !sameCapability(pending.capability, capability)
  )
    throw new Error(
      `${context.where}: pending permission does not match authored request ${JSON.stringify(id)}`,
    );
}

function assertPendingWaiverMatches(
  context: EventContext,
  action: Extract<CartridgeAgentAction, { readonly kind: "waiver-request" }>,
): void {
  const pending = readMindSlice(context.state).pendingWaiver;
  if (
    pending === null ||
    pending.id !== action.id ||
    pending.version !== action.version ||
    pending.requiredPhrase !== action.requiredPhrase ||
    !sameCapability(pending.capability, action.capability) ||
    pending.documentPath !== action.documentPath ||
    pending.documentContents !== action.documentContents
  )
    throw new Error(
      `${context.where}: pending waiver does not match authored request ${JSON.stringify(action.id)}`,
    );
}

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

export function createMindPermissionRequestEvent(id: string): EngineEvent {
  return stampEvent(
    { type: "mind.permission-request", payload: { id } },
    "mind permission request envelope",
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

export function createMindPermissionChoiceEvent(
  id: string,
  decision: PermissionDecision,
): EngineEvent {
  return stampEvent(
    { type: "mind.permission-choice", payload: { id, decision } },
    "mind permission choice envelope",
  );
}

export function createMindStandingPermissionEvent(id: string): EngineEvent {
  return stampEvent(
    { type: "mind.permission-standing", payload: { id } },
    "mind standing permission envelope",
  );
}

export function createMindWaiverStartEvent(id: string): EngineEvent {
  return stampEvent(
    { type: "mind.waiver-start", payload: { id } },
    "mind waiver start envelope",
  );
}

export function createMindWaiverStandingEvent(id: string): EngineEvent {
  return stampEvent(
    { type: "mind.waiver-standing", payload: { id } },
    "mind standing waiver envelope",
  );
}

export function createMindWaiverChoiceEvent(
  id: string,
  accepted: boolean,
): EngineEvent {
  return stampEvent(
    { type: "mind.waiver-choice", payload: { id, accepted } },
    "mind waiver choice envelope",
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
    "mind.permission-request": {
      version: 0,
      apply(context) {
        const data = payload(context, ["id"]);
        const id = validatePermissionRequestId(
          readString(data, "id", context.where),
          `${context.where}: id`,
        );
        const action = findOrchestrationAction(
          context,
          id,
          "permission-request",
        );
        return {
          expansion: [
            createMindPermissionRequestedEvent(id, action.capability),
          ],
        };
      },
    },
    "mind.permission-choice": {
      version: 0,
      apply(context) {
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
        const action = findOrchestrationAction(
          context,
          id,
          "permission-request",
        );
        assertPendingPermissionMatches(context, id, action.capability);
        const selected =
          decision === "grant"
            ? action.grant
            : decision === "deny"
              ? action.deny
              : action.alwaysAllow;
        return {
          expansion: [
            createMindPermissionResolvedEvent(id, decision),
            ...continuation(selected),
          ],
        };
      },
    },
    "mind.permission-standing": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["id"]);
        const id = validatePermissionRequestId(
          readString(data, "id", context.where),
          `${context.where}: id`,
        );
        const action = findOrchestrationAction(
          context,
          id,
          "permission-request",
        );
        if (!hasStandingPermission(slice, action.capability))
          throw new Error(
            `${context.where}: exact standing permission does not cover ${JSON.stringify(id)}`,
          );
        return { expansion: continuation(action.grant) };
      },
    },
    "mind.waiver-start": {
      version: 0,
      apply(context) {
        const data = payload(context, ["id"]);
        const id = readString(data, "id", context.where);
        const action = findOrchestrationAction(context, id, "waiver-request");
        return {
          expansion: [
            {
              type: "vfs.waiver-write",
              payload: { id: action.id },
              version: 0,
            },
            stampEvent(
              {
                type: "mind.waiver-pending",
                payload: { id: action.id },
              },
              "mind waiver pending",
            ),
          ],
        };
      },
    },
    "mind.waiver-standing": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["id"]);
        const id = readString(data, "id", context.where);
        const action = findOrchestrationAction(context, id, "waiver-request");
        if (
          !hasWaiverConsent(slice, {
            id: action.id,
            version: action.version,
            phrase: action.requiredPhrase,
            capability: action.capability,
          })
        )
          throw new Error(
            `${context.where}: recorded waiver consent does not cover ${JSON.stringify(id)}`,
          );
        return { expansion: continuation(action.consent) };
      },
    },
    "mind.waiver-choice": {
      version: 0,
      apply(context) {
        const data = payload(context, ["id", "accepted"]);
        const id = readString(data, "id", context.where);
        const accepted = data["accepted"];
        if (typeof accepted !== "boolean")
          throw new Error(`${context.where}: accepted must be a boolean`);
        const action = findOrchestrationAction(context, id, "waiver-request");
        assertPendingWaiverMatches(context, action);
        return {
          expansion: [
            stampEvent(
              {
                type: "mind.waiver-resolved",
                payload: { id, accepted },
              },
              "mind waiver resolve",
            ),
            ...continuation(accepted ? action.consent : action.denial),
          ],
        };
      },
    },
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
    "mind.waiver-pending": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["id"]);
        const action = findOrchestrationAction(
          context,
          readString(data, "id", context.where),
          "waiver-request",
        );
        const request = validatePendingWaiverRequest(
          {
            id: action.id,
            version: action.version,
            requiredPhrase: action.requiredPhrase,
            capability: action.capability,
            documentPath: action.documentPath,
            documentContents: action.documentContents,
          } satisfies PendingWaiverRequest,
          `${context.where}: waiver request`,
        );
        return {
          slice: startWaiver(slice, request),
          summary: `id=${request.id}`,
        };
      },
    },
    "mind.waiver-resolved": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["id", "accepted"]);
        const id = readString(data, "id", context.where);
        const accepted = data["accepted"];
        if (typeof accepted !== "boolean")
          throw new Error(`${context.where}: accepted must be a boolean`);
        return {
          slice: resolveWaiver(slice, id, accepted, context.clock.timestamp()),
          summary: `id=${id} accepted=${String(accepted)}`,
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
