/** Pure immutable mechanics and typed truth comparison for the agent's mind. */

import type { ServiceHealth } from "../cartridge/types.js";
import {
  ABSOLUTE_PATH_PATTERN,
  GIT_BRANCH_PATTERN,
  MAX_PERMISSION_REQUEST_ID_LENGTH,
  MAX_STORY_TEXT_LENGTH,
  SINGLE_LINE_PATTERN,
  STORY_ID_PATTERN,
  WORLD_ID_PATTERN,
} from "../cartridge/schema.js";
import { formatTimestamp, parseTimestamp } from "../clock/civil.js";
import { readSlice } from "../events/state.js";
import type { SessionState } from "../events/state.js";
import { deepFreeze } from "../freeze.js";
import { currentGitHead } from "../git/git.js";
import { readGitSlice } from "../git/module.js";
import type { GitHead } from "../git/types.js";
import { readVfsSlice } from "../vfs/module.js";
import { queryVfsTruth } from "../vfs/vfs.js";
import { readWorldSlice } from "../world/module.js";
import { lookupService } from "../world/world.js";
import { countCodePoints } from "../text.js";
import type {
  Belief,
  BeliefMismatch,
  ExactCapability,
  MindSlice,
  PendingPermissionRequest,
  PendingWaiverRequest,
  PermissionDecision,
  WaiverConsent,
} from "./types.js";

const HASH_PATTERN = /^[0-9a-f]{40}$/;
export const MAX_WAIVER_CONSENTS = 64;
export const MAX_WAIVER_PHRASE_LENGTH = 256;
export const MAX_WAIVER_VERSION = Number.MAX_SAFE_INTEGER;

function record(
  value: unknown,
  where: string,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${where}: must be an object`);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(`${where}: must be a plain JSON object`);
  if (Object.getOwnPropertySymbols(value).length > 0)
    throw new Error(`${where}: must not contain symbol-keyed fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const unknown = Object.keys(descriptors)
    .filter((key) => !fields.includes(key))
    .sort();
  if (unknown.length > 0)
    throw new Error(`${where}: unexpected field(s) ${unknown.join(", ")}`);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor.get !== undefined || descriptor.set !== undefined)
      throw new Error(`${where}.${key}: accessors are not inert JSON data`);
    if (!descriptor.enumerable)
      throw new Error(
        `${where}.${key}: non-enumerable fields are not JSON data`,
      );
  }
  return value as Readonly<Record<string, unknown>>;
}

function array(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    throw new Error(`${where}: must be a plain array`);
  const keys = Object.keys(value);
  if (
    keys.length !== value.length ||
    keys.some((key, index) => key !== String(index)) ||
    Object.getOwnPropertyNames(value).some(
      (key) => key !== "length" && !keys.includes(key),
    ) ||
    Object.getOwnPropertySymbols(value).length > 0
  )
    throw new Error(`${where}: must be a dense array without extra fields`);
  return value;
}

function string(
  value: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): string {
  const field = value[key];
  if (typeof field !== "string")
    throw new Error(`${where}.${key}: must be a string`);
  return field;
}

function timestamp(value: string, where: string): void {
  try {
    if (formatTimestamp(parseTimestamp(value)) !== value)
      throw new Error("noncanonical timestamp");
  } catch {
    throw new Error(`${where}: must be a real fixed-width UTC instant`);
  }
}

function head(value: unknown, where: string): GitHead {
  const item = record(value, where, ["kind", "target"]);
  const kind = string(item, "kind", where);
  const target = string(item, "target", where);
  if (kind === "branch" && GIT_BRANCH_PATTERN.test(target))
    return value as GitHead;
  if (kind === "detached" && (target === "" || HASH_PATTERN.test(target)))
    return value as GitHead;
  throw new Error(
    `${where}: must be a branch HEAD with a valid branch or a detached HEAD with a 40-digit hash`,
  );
}

export function validateCapability(
  value: unknown,
  where: string,
): ExactCapability {
  const item = record(value, where, ["kind", "action", "resource"]);
  const kind = string(item, "kind", where);
  const action = string(item, "action", where);
  const resource = string(item, "resource", where);
  if (kind !== "exact") throw new Error(`${where}.kind: must be exact`);
  if (action === "" || !SINGLE_LINE_PATTERN.test(action))
    throw new Error(`${where}.action: must be a non-empty single-line string`);
  if (resource === "" || !SINGLE_LINE_PATTERN.test(resource))
    throw new Error(
      `${where}.resource: must be a non-empty single-line string`,
    );
  return value as ExactCapability;
}

export function validatePendingPermissionRequest(
  value: unknown,
  where: string,
): PendingPermissionRequest {
  const item = record(value, where, ["id", "capability"]);
  validatePermissionRequestId(string(item, "id", where), `${where}.id`);
  const capability = validateCapability(
    item["capability"],
    `${where}.capability`,
  );
  if (
    countCodePoints(capability.action) > MAX_STORY_TEXT_LENGTH ||
    countCodePoints(capability.resource) > MAX_STORY_TEXT_LENGTH
  )
    throw new Error(
      `${where}.capability: action and resource must each be at most ${String(MAX_STORY_TEXT_LENGTH)} characters`,
    );
  return value as PendingPermissionRequest;
}

export function validateWaiverConsent(
  value: unknown,
  where: string,
): WaiverConsent {
  const item = record(value, where, [
    "id",
    "version",
    "phrase",
    "capability",
    "at",
  ]);
  const id = string(item, "id", where);
  if (!STORY_ID_PATTERN.test(id))
    throw new Error(`${where}.id: must be a story identifier`);
  const version = item["version"];
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1 ||
    version > MAX_WAIVER_VERSION
  )
    throw new Error(
      `${where}.version: must be an integer from 1 to ${String(MAX_WAIVER_VERSION)}`,
    );
  const phrase = string(item, "phrase", where);
  if (
    phrase === "" ||
    !SINGLE_LINE_PATTERN.test(phrase) ||
    countCodePoints(phrase) > MAX_WAIVER_PHRASE_LENGTH
  )
    throw new Error(
      `${where}.phrase: must be a non-empty single-line string of at most ${String(MAX_WAIVER_PHRASE_LENGTH)} characters`,
    );
  const capability = validateCapability(
    item["capability"],
    `${where}.capability`,
  );
  if (
    countCodePoints(capability.action) > MAX_STORY_TEXT_LENGTH ||
    countCodePoints(capability.resource) > MAX_STORY_TEXT_LENGTH
  )
    throw new Error(
      `${where}.capability: action and resource must each be at most ${String(MAX_STORY_TEXT_LENGTH)} characters`,
    );
  timestamp(string(item, "at", where), `${where}.at`);
  return value as WaiverConsent;
}

export function validatePendingWaiverRequest(
  value: unknown,
  where: string,
): PendingWaiverRequest {
  const item = record(value, where, [
    "id",
    "version",
    "requiredPhrase",
    "capability",
    "documentPath",
    "documentContents",
  ]);
  const consent = validateWaiverConsent(
    {
      id: item["id"],
      version: item["version"],
      phrase: item["requiredPhrase"],
      capability: item["capability"],
      at: "2000-01-01T00:00:00.000Z",
    },
    where,
  );
  if (consent.phrase !== "I agree")
    throw new Error(`${where}.requiredPhrase: must be exactly "I agree"`);
  const documentPath = string(item, "documentPath", where);
  if (!ABSOLUTE_PATH_PATTERN.test(documentPath))
    throw new Error(
      `${where}.documentPath: must be a canonical absolute POSIX path`,
    );
  const documentContents = string(item, "documentContents", where);
  if (countCodePoints(documentContents) > MAX_STORY_TEXT_LENGTH)
    throw new Error(
      `${where}.documentContents: must be at most ${String(MAX_STORY_TEXT_LENGTH)} characters`,
    );
  return value as PendingWaiverRequest;
}

export function validatePermissionRequestId(id: string, where: string): string {
  if (
    !WORLD_ID_PATTERN.test(id) ||
    countCodePoints(id) > MAX_PERMISSION_REQUEST_ID_LENGTH
  )
    throw new Error(
      `${where}: must be a non-empty single-line identifier of at most ${String(MAX_PERMISSION_REQUEST_ID_LENGTH)} characters`,
    );
  return id;
}

export function validateBelief(value: unknown, where: string): Belief {
  const base = record(value, where, [
    "kind",
    "path",
    "exists",
    "contents",
    "head",
    "service",
    "state",
    "health",
  ]);
  const kind = string(base, "kind", where);
  if (kind === "file-exists") {
    const item = record(value, where, ["kind", "path", "exists"]);
    const path = string(item, "path", where);
    if (!ABSOLUTE_PATH_PATTERN.test(path))
      throw new Error(`${where}.path: must be a canonical absolute POSIX path`);
    if (typeof item["exists"] !== "boolean")
      throw new Error(`${where}.exists: must be a boolean`);
  } else if (kind === "file-contents") {
    const item = record(value, where, ["kind", "path", "contents"]);
    const path = string(item, "path", where);
    if (!ABSOLUTE_PATH_PATTERN.test(path))
      throw new Error(`${where}.path: must be a canonical absolute POSIX path`);
    string(item, "contents", where);
  } else if (kind === "git-head") {
    const item = record(value, where, ["kind", "head"]);
    head(item["head"], `${where}.head`);
  } else if (kind === "service-state") {
    const item = record(value, where, ["kind", "service", "state"]);
    if (!WORLD_ID_PATTERN.test(string(item, "service", where)))
      throw new Error(`${where}.service: must be a service identifier`);
    const state = string(item, "state", where);
    if (state !== "running" && state !== "stopped")
      throw new Error(`${where}.state: must be running or stopped`);
  } else if (kind === "service-health") {
    const item = record(value, where, ["kind", "service", "health"]);
    if (!WORLD_ID_PATTERN.test(string(item, "service", where)))
      throw new Error(`${where}.service: must be a service identifier`);
    const health = string(item, "health", where);
    if (!["healthy", "degraded", "unhealthy", "unknown"].includes(health))
      throw new Error(`${where}.health: must be a service health value`);
  } else {
    throw new Error(
      `${where}.kind: unknown belief kind ${JSON.stringify(kind)}`,
    );
  }
  return value as Belief;
}

/** Validate every nested field without normalizing snapshot bytes. */
export function validateMindSlice(slice: unknown, where: string): MindSlice {
  const root = record(slice, where, [
    "permissions",
    "pendingPermission",
    "pendingWaiver",
    "waiverConsents",
    "beliefs",
    "compactHistory",
  ]);
  array(root["permissions"], `${where}.permissions`).forEach((value, index) => {
    const at = `${where}.permissions[${String(index)}]`;
    const item = record(value, at, ["capability", "decision", "at"]);
    validateCapability(item["capability"], `${at}.capability`);
    const decision = string(item, "decision", at);
    if (
      decision !== "grant" &&
      decision !== "deny" &&
      decision !== "always-allow"
    )
      throw new Error(`${at}.decision: must be grant, deny or always-allow`);
    timestamp(string(item, "at", at), `${at}.at`);
  });
  if (root["pendingPermission"] !== null)
    validatePendingPermissionRequest(
      root["pendingPermission"],
      `${where}.pendingPermission`,
    );
  if (root["pendingWaiver"] !== null)
    validatePendingWaiverRequest(
      root["pendingWaiver"],
      `${where}.pendingWaiver`,
    );
  const waiverKeys = new Set<string>();
  const waiverConsents = array(
    root["waiverConsents"],
    `${where}.waiverConsents`,
  );
  if (waiverConsents.length > MAX_WAIVER_CONSENTS)
    throw new Error(
      `${where}.waiverConsents: must contain at most ${String(MAX_WAIVER_CONSENTS)} entries`,
    );
  waiverConsents.forEach((value, index) => {
    const at = `${where}.waiverConsents[${String(index)}]`;
    const consent = validateWaiverConsent(value, at);
    const key = `${consent.id}\u0000${String(consent.version)}`;
    if (waiverKeys.has(key))
      throw new Error(`${at}: duplicate waiver id and version`);
    waiverKeys.add(key);
  });
  const subjects = new Set<string>();
  array(root["beliefs"], `${where}.beliefs`).forEach((value, index) => {
    const belief = validateBelief(value, `${where}.beliefs[${String(index)}]`);
    const subject = beliefSubject(belief);
    if (subjects.has(subject))
      throw new Error(
        `${where}.beliefs[${String(index)}]: duplicate typed subject`,
      );
    subjects.add(subject);
  });
  array(root["compactHistory"], `${where}.compactHistory`).forEach(
    (value, index) => {
      const at = `${where}.compactHistory[${String(index)}]`;
      const item = record(value, at, ["summary", "at"]);
      string(item, "summary", at);
      timestamp(string(item, "at", at), `${at}.at`);
    },
  );
  return slice as MindSlice;
}

export function readMindSlice(state: SessionState): MindSlice {
  return validateMindSlice(
    readSlice(state, "mind"),
    "session state: slices.mind",
  );
}

export function createMindSlice(): MindSlice {
  return deepFreeze({
    permissions: [],
    pendingPermission: null,
    pendingWaiver: null,
    waiverConsents: [],
    beliefs: [],
    compactHistory: [],
  });
}

function copyPendingPermission(
  pending: PendingPermissionRequest | null,
): PendingPermissionRequest | null {
  return pending === null
    ? null
    : { ...pending, capability: { ...pending.capability } };
}

function copyPendingWaiver(
  pending: PendingWaiverRequest | null,
): PendingWaiverRequest | null {
  return pending === null
    ? null
    : { ...pending, capability: { ...pending.capability } };
}

function copyWaiverConsent(consent: WaiverConsent): WaiverConsent {
  return { ...consent, capability: { ...consent.capability } };
}

export function findWaiverConsent(
  slice: MindSlice,
  expected: Omit<WaiverConsent, "at">,
): WaiverConsent | undefined {
  return slice.waiverConsents.find(
    (consent) =>
      consent.id === expected.id &&
      consent.version === expected.version &&
      consent.phrase === expected.phrase &&
      consent.capability.kind === expected.capability.kind &&
      consent.capability.action === expected.capability.action &&
      consent.capability.resource === expected.capability.resource,
  );
}

export function hasWaiverConsent(
  slice: MindSlice,
  expected: Omit<WaiverConsent, "at">,
): boolean {
  return findWaiverConsent(slice, expected) !== undefined;
}

export function recordWaiverConsent(
  slice: MindSlice,
  consent: WaiverConsent,
): MindSlice {
  if (
    slice.waiverConsents.some(
      (existing) =>
        existing.id === consent.id && existing.version === consent.version,
    )
  )
    throw new Error(
      `mind waiver consent: id ${JSON.stringify(consent.id)} version ${String(consent.version)} is already recorded`,
    );
  if (slice.waiverConsents.length >= MAX_WAIVER_CONSENTS)
    throw new Error(
      `mind waiver consent: cannot record more than ${String(MAX_WAIVER_CONSENTS)} entries`,
    );
  return deepFreeze({
    permissions: slice.permissions.map((entry) => ({
      ...entry,
      capability: { ...entry.capability },
    })),
    pendingPermission: copyPendingPermission(slice.pendingPermission),
    pendingWaiver: copyPendingWaiver(slice.pendingWaiver),
    waiverConsents: [
      ...slice.waiverConsents.map(copyWaiverConsent),
      copyWaiverConsent(consent),
    ],
    beliefs: slice.beliefs.map(copyBelief),
    compactHistory: slice.compactHistory.map((entry) => ({ ...entry })),
  });
}

export function recordPermissionDecision(
  slice: MindSlice,
  capability: ExactCapability,
  decision: PermissionDecision,
  at: string,
): MindSlice {
  return deepFreeze({
    ...slice,
    permissions: [
      ...slice.permissions.map((entry) => ({
        ...entry,
        capability: { ...entry.capability },
      })),
      { capability: { ...capability }, decision, at },
    ],
    pendingPermission: copyPendingPermission(slice.pendingPermission),
    pendingWaiver: copyPendingWaiver(slice.pendingWaiver),
    waiverConsents: slice.waiverConsents.map(copyWaiverConsent),
    beliefs: slice.beliefs.map(copyBelief),
    compactHistory: slice.compactHistory.map((entry) => ({ ...entry })),
  });
}

export function requestPermission(
  slice: MindSlice,
  request: PendingPermissionRequest,
): MindSlice {
  if (slice.pendingPermission !== null)
    throw new Error(
      `mind permission request: pending request ${JSON.stringify(slice.pendingPermission.id)} must be resolved first`,
    );
  return deepFreeze({
    permissions: slice.permissions.map((entry) => ({
      ...entry,
      capability: { ...entry.capability },
    })),
    pendingPermission: {
      ...request,
      capability: { ...request.capability },
    },
    pendingWaiver: copyPendingWaiver(slice.pendingWaiver),
    waiverConsents: slice.waiverConsents.map(copyWaiverConsent),
    beliefs: slice.beliefs.map(copyBelief),
    compactHistory: slice.compactHistory.map((entry) => ({ ...entry })),
  });
}

export function resolvePermission(
  slice: MindSlice,
  id: string,
  decision: PermissionDecision,
  at: string,
): MindSlice {
  const pending = slice.pendingPermission;
  if (pending === null)
    throw new Error(
      "mind permission resolve: no permission request is pending",
    );
  if (pending.id !== id)
    throw new Error(
      `mind permission resolve: request id ${JSON.stringify(id)} does not match pending request ${JSON.stringify(pending.id)}`,
    );
  return deepFreeze({
    permissions: [
      ...slice.permissions.map((entry) => ({
        ...entry,
        capability: { ...entry.capability },
      })),
      { capability: { ...pending.capability }, decision, at },
    ],
    pendingPermission: null,
    pendingWaiver: copyPendingWaiver(slice.pendingWaiver),
    waiverConsents: slice.waiverConsents.map(copyWaiverConsent),
    beliefs: slice.beliefs.map(copyBelief),
    compactHistory: slice.compactHistory.map((entry) => ({ ...entry })),
  });
}

export function startWaiver(
  slice: MindSlice,
  request: PendingWaiverRequest,
): MindSlice {
  if (slice.pendingWaiver !== null)
    throw new Error(
      `mind waiver request: pending waiver ${JSON.stringify(slice.pendingWaiver.id)} must be resolved first`,
    );
  return deepFreeze({
    permissions: slice.permissions.map((entry) => ({
      ...entry,
      capability: { ...entry.capability },
    })),
    pendingPermission: copyPendingPermission(slice.pendingPermission),
    pendingWaiver: copyPendingWaiver(request),
    waiverConsents: slice.waiverConsents.map(copyWaiverConsent),
    beliefs: slice.beliefs.map(copyBelief),
    compactHistory: slice.compactHistory.map((entry) => ({ ...entry })),
  });
}

export function resolveWaiver(
  slice: MindSlice,
  id: string,
  accepted: boolean,
  at: string,
): MindSlice {
  const pending = slice.pendingWaiver;
  if (pending === null)
    throw new Error("mind waiver resolve: no waiver request is pending");
  if (pending.id !== id)
    throw new Error(
      `mind waiver resolve: request id ${JSON.stringify(id)} does not match pending waiver ${JSON.stringify(pending.id)}`,
    );
  const cleared = deepFreeze({
    permissions: slice.permissions.map((entry) => ({
      ...entry,
      capability: { ...entry.capability },
    })),
    pendingPermission: copyPendingPermission(slice.pendingPermission),
    pendingWaiver: null,
    waiverConsents: slice.waiverConsents.map(copyWaiverConsent),
    beliefs: slice.beliefs.map(copyBelief),
    compactHistory: slice.compactHistory.map((entry) => ({ ...entry })),
  });
  return accepted
    ? recordWaiverConsent(cleared, {
        id: pending.id,
        version: pending.version,
        phrase: pending.requiredPhrase,
        capability: pending.capability,
        at,
      })
    : cleared;
}

/** Only an exact always-allow entry grants standing coverage. */
export function hasStandingPermission(
  slice: MindSlice,
  capability: ExactCapability,
): boolean {
  return slice.permissions.some(
    (entry) =>
      entry.decision === "always-allow" &&
      entry.capability.kind === capability.kind &&
      entry.capability.action === capability.action &&
      entry.capability.resource === capability.resource,
  );
}

function beliefSubject(belief: Belief): string {
  if (belief.kind === "git-head") return belief.kind;
  if (belief.kind === "file-exists" || belief.kind === "file-contents")
    return `${belief.kind}\u0000${belief.path}`;
  return `${belief.kind}\u0000${belief.service}`;
}

function copyBelief(belief: Belief): Belief {
  return belief.kind === "git-head"
    ? { ...belief, head: { ...belief.head } }
    : { ...belief };
}

/** Upsert one assertion without changing the typed subject's position. */
export function setBelief(slice: MindSlice, belief: Belief): MindSlice {
  const subject = beliefSubject(belief);
  const index = slice.beliefs.findIndex(
    (existing) => beliefSubject(existing) === subject,
  );
  const beliefs = slice.beliefs.map(copyBelief);
  if (index === -1) beliefs.push(copyBelief(belief));
  else beliefs[index] = copyBelief(belief);
  return deepFreeze({
    permissions: slice.permissions.map((entry) => ({
      ...entry,
      capability: { ...entry.capability },
    })),
    pendingPermission: copyPendingPermission(slice.pendingPermission),
    pendingWaiver: copyPendingWaiver(slice.pendingWaiver),
    waiverConsents: slice.waiverConsents.map(copyWaiverConsent),
    beliefs,
    compactHistory: slice.compactHistory.map((entry) => ({ ...entry })),
  });
}

/** `/compact` replaces every assertion and retains only timestamped summaries. */
export function compactBeliefs(
  slice: MindSlice,
  summary: string,
  beliefs: readonly Belief[],
  at: string,
): MindSlice {
  const subjects = new Set<string>();
  for (const belief of beliefs) {
    const subject = beliefSubject(belief);
    if (subjects.has(subject))
      throw new Error(
        `mind compact: duplicate typed belief subject ${JSON.stringify(subject)}`,
      );
    subjects.add(subject);
  }
  return deepFreeze({
    permissions: slice.permissions.map((entry) => ({
      ...entry,
      capability: { ...entry.capability },
    })),
    pendingPermission: copyPendingPermission(slice.pendingPermission),
    pendingWaiver: copyPendingWaiver(slice.pendingWaiver),
    waiverConsents: slice.waiverConsents.map(copyWaiverConsent),
    beliefs: beliefs.map(copyBelief),
    compactHistory: [
      ...slice.compactHistory.map((entry) => ({ ...entry })),
      { summary, at },
    ],
  });
}

function sameHead(left: GitHead, right: GitHead): boolean {
  return left.kind === right.kind && left.target === right.target;
}

/** Compare the closed belief vocabulary in assertion order, never by object diff. */
export function beliefDivergence(
  state: SessionState,
): readonly BeliefMismatch[] {
  const beliefs = readMindSlice(state).beliefs;
  const vfs = readVfsSlice(state);
  const git = readGitSlice(state);
  const world = readWorldSlice(state);
  const mismatches: BeliefMismatch[] = [];
  for (const belief of beliefs) {
    if (belief.kind === "file-exists") {
      const actual = queryVfsTruth(vfs, belief.path).kind !== "missing";
      if (actual !== belief.exists)
        mismatches.push({
          kind: belief.kind,
          path: belief.path,
          believed: belief.exists,
          actual,
        });
    } else if (belief.kind === "file-contents") {
      const truth = queryVfsTruth(vfs, belief.path);
      const actual = truth.kind === "file" ? truth.contents : null;
      if (actual !== belief.contents)
        mismatches.push({
          kind: belief.kind,
          path: belief.path,
          believed: belief.contents,
          actual,
        });
    } else if (belief.kind === "git-head") {
      const actual = currentGitHead(git);
      if (!sameHead(actual, belief.head))
        mismatches.push({
          kind: belief.kind,
          believed: { ...belief.head },
          actual,
        });
    } else if (belief.kind === "service-state") {
      const actual = lookupService(world, belief.service)?.state ?? null;
      if (actual !== belief.state)
        mismatches.push({
          kind: belief.kind,
          service: belief.service,
          believed: belief.state,
          actual,
        });
    } else {
      const actual: ServiceHealth | null =
        lookupService(world, belief.service)?.health ?? null;
      if (actual !== belief.health)
        mismatches.push({
          kind: belief.kind,
          service: belief.service,
          believed: belief.health,
          actual,
        });
    }
  }
  return deepFreeze(mismatches);
}

export function isPermissionDecision(
  value: string,
): value is PermissionDecision {
  return value === "grant" || value === "deny" || value === "always-allow";
}
