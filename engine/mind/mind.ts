/** Pure immutable mechanics and typed truth comparison for the agent's mind. */

import type { ServiceHealth } from "../cartridge/types.js";
import {
  ABSOLUTE_PATH_PATTERN,
  GIT_BRANCH_PATTERN,
  SINGLE_LINE_PATTERN,
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
import type {
  Belief,
  BeliefMismatch,
  ExactCapability,
  MindSlice,
  PermissionDecision,
} from "./types.js";

const HASH_PATTERN = /^[0-9a-f]{40}$/;

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
  return deepFreeze({ permissions: [], beliefs: [], compactHistory: [] });
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
    beliefs: slice.beliefs.map(copyBelief),
    compactHistory: slice.compactHistory.map((entry) => ({ ...entry })),
  });
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
