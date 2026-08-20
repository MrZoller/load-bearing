/** Event registration and snapshot boundary for the virtual filesystem. */

import { parseTimestamp } from "../clock/civil.js";
import {
  ABSOLUTE_PATH_PATTERN,
  ACCOUNT_NAME_PATTERN,
  FILE_MODE_PATTERN,
  UMASK_PATTERN,
} from "../cartridge/schema.js";
import { defineEventModule } from "../events/module.js";
import type { EventContext } from "../events/module.js";
import { readSlice } from "../events/state.js";
import type { SessionState } from "../events/state.js";
import { MAX_TRANSCRIPT_LINE_LENGTH } from "../events/transcript.js";
import { readString, requirePayload } from "../events/payload.js";
import type { EventPayload } from "../events/payload.js";
import { resolveVfsPath } from "./path.js";
import type { VfsMutation, VfsResult, VfsSlice } from "./types.js";
import {
  chmodVfs,
  chdirVfs,
  copyVfs,
  createVfsSlice,
  deleteVfs,
  listVfs,
  mkdirVfs,
  readVfs,
  replaceVfsFiles,
  renameVfs,
  statVfs,
  touchVfs,
  writeVfs,
} from "./vfs.js";

function assertFields(
  payload: EventPayload,
  allowed: readonly string[],
  where: string,
): void {
  const unknown = Object.keys(payload).filter((key) => !allowed.includes(key));
  if (unknown.length > 0)
    throw new Error(
      `${where}: unexpected payload field(s) ${unknown.sort().join(", ")}; expected ${allowed.join(", ")}`,
    );
}

function readBoolean(
  payload: EventPayload,
  key: string,
  fallback: boolean,
  where: string,
): boolean {
  const value = payload[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean")
    throw new Error(
      `${where}: ${key} must be a boolean, got ${JSON.stringify(value)}`,
    );
  return value;
}

function summaryPath(path: string): string {
  const rendered = JSON.stringify(path);
  // Event payloads are source data, so a valid long path must not make the
  // transcript reducer throw merely because JSON escaping expands it. The
  // excerpt is a diagnostic view, not a round-trippable path representation.
  if (rendered.length <= MAX_TRANSCRIPT_LINE_LENGTH / 2) return rendered;
  const budget = MAX_TRANSCRIPT_LINE_LENGTH / 2 - 32;
  let end = 0;
  // A UTF-16 slice can separate a surrogate pair, which transcript validation
  // correctly rejects as unwritable text. Iterating code points keeps the
  // diagnostic excerpt valid while retaining the same bounded budget.
  for (const character of rendered) {
    if (end + character.length > budget) break;
    end += character.length;
  }
  return `${rendered.slice(0, end)}… (${String(path.length)} chars)`;
}

function summarize(result: VfsResult<unknown>, success: string): string {
  return result.ok
    ? success
    : `failed code=${result.code} path=${summaryPath(result.path)}`;
}

function mutationOutcome<T>(
  mutation: VfsMutation<T>,
  success: (value: T) => string,
): { readonly slice: VfsSlice; readonly summary: string } {
  return {
    slice: mutation.slice,
    summary: summarize(
      mutation.result,
      mutation.result.ok ? success(mutation.result.value) : "",
    ),
  };
}

function requireRecord(
  value: unknown,
  where: string,
  fields?: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${where}: must be an object`);
  const record = value as Readonly<Record<string, unknown>>;
  const prototype: unknown = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(`${where}: must be a plain JSON object`);
  const descriptors = Object.getOwnPropertyDescriptors(record);
  if (Object.getOwnPropertySymbols(record).length > 0)
    throw new Error(`${where}: must not contain symbol-keyed fields`);
  const unknown =
    fields === undefined
      ? []
      : Object.keys(descriptors).filter((key) => !fields.includes(key));
  if (unknown.length > 0)
    throw new Error(
      `${where}: unexpected field(s) ${unknown.sort().join(", ")}`,
    );
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key];
    if (
      descriptor !== undefined &&
      (descriptor.get !== undefined || descriptor.set !== undefined)
    )
      throw new Error(`${where}.${key}: accessors are not inert snapshot data`);
  }
  return record;
}

function requiredString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): string {
  const value = record[key];
  if (typeof value !== "string")
    throw new Error(`${where}.${key}: must be a string`);
  return value;
}

function validateMetadata(
  record: Readonly<Record<string, unknown>>,
  where: string,
): void {
  const mode = requiredString(record, "mode", where);
  const owner = requiredString(record, "owner", where);
  const group = requiredString(record, "group", where);
  const mtime = requiredString(record, "mtime", where);
  if (!FILE_MODE_PATTERN.test(mode))
    throw new Error(`${where}.mode: must be four octal digits`);
  if (!ACCOUNT_NAME_PATTERN.test(owner))
    throw new Error(`${where}.owner: must be a POSIX user name`);
  if (!ACCOUNT_NAME_PATTERN.test(group))
    throw new Error(`${where}.group: must be a POSIX group name`);
  try {
    parseTimestamp(mtime);
  } catch {
    throw new Error(`${where}.mtime: must be a real fixed-width UTC instant`);
  }
}

/** Validate without normalizing, as snapshot restoration requires. */
export function validateVfsSlice(slice: unknown, where: string): VfsSlice {
  const root = requireRecord(slice, where, ["cwd", "identity", "entries"]);
  const cwd = requiredString(root, "cwd", where);
  if (!ABSOLUTE_PATH_PATTERN.test(cwd))
    throw new Error(`${where}.cwd: must be a canonical absolute POSIX path`);

  const identityWhere = `${where}.identity`;
  const identity = requireRecord(root["identity"], identityWhere, [
    "user",
    "group",
    "home",
    "umask",
  ]);
  const user = requiredString(identity, "user", identityWhere);
  const group = requiredString(identity, "group", identityWhere);
  const home = requiredString(identity, "home", identityWhere);
  const umask = requiredString(identity, "umask", identityWhere);
  if (!ACCOUNT_NAME_PATTERN.test(user) || !ACCOUNT_NAME_PATTERN.test(group))
    throw new Error(
      `${identityWhere}: user and group must be POSIX account names`,
    );
  if (!ABSOLUTE_PATH_PATTERN.test(home))
    throw new Error(
      `${identityWhere}.home: must be a canonical absolute POSIX path`,
    );
  if (!UMASK_PATTERN.test(umask))
    throw new Error(
      `${identityWhere}.umask: must be four octal digits beginning with 0`,
    );

  const entriesWhere = `${where}.entries`;
  const entries = requireRecord(root["entries"], entriesWhere);
  for (const path of Object.keys(entries).sort()) {
    if (!ABSOLUTE_PATH_PATTERN.test(path))
      throw new Error(
        `${entriesWhere}[${JSON.stringify(path)}]: key must be a canonical absolute path`,
      );
    const entryWhere = `${entriesWhere}[${JSON.stringify(path)}]`;
    const raw = requireRecord(entries[path], entryWhere);
    const kind = raw["kind"];
    if (kind !== "file" && kind !== "directory")
      throw new Error(`${entryWhere}.kind: must be file or directory`);
    const entry = requireRecord(
      raw,
      entryWhere,
      kind === "file"
        ? ["kind", "contents", "mode", "owner", "group", "mtime"]
        : ["kind", "mode", "owner", "group", "mtime"],
    );
    validateMetadata(entry, entryWhere);
    if (kind === "file") requiredString(entry, "contents", entryWhere);
    if (path !== "/") {
      const parent = path.slice(0, path.lastIndexOf("/")) || "/";
      const parentEntry = entries[parent] as
        Readonly<Record<string, unknown>> | undefined;
      if (parentEntry?.["kind"] !== "directory")
        throw new Error(
          `${entryWhere}: parent ${JSON.stringify(parent)} must exist as a directory`,
        );
    }
  }
  const rootEntry = entries["/"] as
    Readonly<Record<string, unknown>> | undefined;
  const cwdEntry = entries[cwd] as
    Readonly<Record<string, unknown>> | undefined;
  if (rootEntry?.["kind"] !== "directory")
    throw new Error(`${entriesWhere}: must contain the root directory`);
  if (cwdEntry?.["kind"] !== "directory")
    throw new Error(`${where}.cwd: must name a directory in entries`);
  return slice as VfsSlice;
}

/** Read another module's VFS view through the VFS-owned validator. */
export function readVfsSlice(state: SessionState): VfsSlice {
  return validateVfsSlice(readSlice(state, "vfs"), "session state: slices.vfs");
}

function payload(
  context: EventContext,
  fields: readonly string[],
): EventPayload {
  const value = requirePayload(context);
  assertFields(value, fields, context.where);
  return value;
}

export const VFS_MODULE = defineEventModule<VfsSlice>({
  namespace: "vfs",
  description:
    "Deterministic files, directories, permissions, ownership and working directory.",
  initialSlice: (context) => createVfsSlice(context.cartridge),
  validateSlice: validateVfsSlice,
  events: {
    "vfs.read": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["path"]);
        const result = readVfs(slice, readString(data, "path", context.where));
        return {
          summary: summarize(
            result,
            result.ok
              ? `path=${summaryPath(result.value.path)} length=${String(result.value.contents.length)}`
              : "",
          ),
        };
      },
    },
    "vfs.list": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["path"]);
        const authored = readString(data, "path", context.where);
        const result = listVfs(slice, authored);
        const path = resolveVfsPath(
          authored,
          slice.cwd,
          slice.identity.home,
        ).path;
        return {
          summary: summarize(
            result,
            result.ok
              ? `path=${summaryPath(path)} entries=${String(result.value.length)}`
              : "",
          ),
        };
      },
    },
    "vfs.stat": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["path"]);
        const result = statVfs(slice, readString(data, "path", context.where));
        return {
          summary: summarize(
            result,
            result.ok
              ? `path=${summaryPath(result.value.path)} kind=${result.value.entry.kind}`
              : "",
          ),
        };
      },
    },
    "vfs.write": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["path", "contents", "transcript"]);
        const mutation = writeVfs(
          slice,
          readString(data, "path", context.where),
          readString(data, "contents", context.where),
          context.clock.timestamp(),
        );
        const outcome = mutationOutcome(
          mutation,
          (value) =>
            `path=${summaryPath(value.path)} created=${String(value.created)}`,
        );
        const transcript = readBoolean(data, "transcript", true, context.where);
        return transcript ? outcome : { slice: outcome.slice };
      },
    },
    "vfs.delete": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["path", "recursive", "fileOnly"]);
        const mutation = deleteVfs(
          slice,
          readString(data, "path", context.where),
          context.clock.timestamp(),
          readBoolean(data, "recursive", false, context.where),
          readBoolean(data, "fileOnly", false, context.where),
        );
        return mutationOutcome(
          mutation,
          (value) =>
            `path=${summaryPath(value.path)} removed=${String(value.removed)}`,
        );
      },
    },
    "vfs.rename": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["source", "destination"]);
        const mutation = renameVfs(
          slice,
          readString(data, "source", context.where),
          readString(data, "destination", context.where),
          context.clock.timestamp(),
        );
        return mutationOutcome(
          mutation,
          (value) =>
            `from=${summaryPath(value.from)} to=${summaryPath(value.to)}`,
        );
      },
    },
    "vfs.copy": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, [
          "source",
          "destination",
          "recursive",
          "preserve",
        ]);
        const mutation = copyVfs(
          slice,
          readString(data, "source", context.where),
          readString(data, "destination", context.where),
          context.clock.timestamp(),
          {
            recursive: readBoolean(data, "recursive", false, context.where),
            preserve: readBoolean(data, "preserve", false, context.where),
          },
        );
        return mutationOutcome(
          mutation,
          (value) =>
            `from=${summaryPath(value.from)} to=${summaryPath(value.to)} copied=${String(value.copied)}`,
        );
      },
    },
    "vfs.chmod": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["path", "mode"]);
        const mode = readString(data, "mode", context.where);
        if (!FILE_MODE_PATTERN.test(mode))
          throw new Error(`${context.where}: mode must be four octal digits`);
        const mutation = chmodVfs(
          slice,
          readString(data, "path", context.where),
          mode,
        );
        return mutationOutcome(
          mutation,
          (value) => `path=${summaryPath(value.path)} mode=${value.mode}`,
        );
      },
    },
    "vfs.mkdir": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["path", "parents"]);
        const mutation = mkdirVfs(
          slice,
          readString(data, "path", context.where),
          context.clock.timestamp(),
          readBoolean(data, "parents", false, context.where),
        );
        return mutationOutcome(
          mutation,
          (value) =>
            `created=${String(value.paths.length)} path=${summaryPath(value.paths.at(-1) ?? "")}`,
        );
      },
    },
    "vfs.touch": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["path"]);
        const mutation = touchVfs(
          slice,
          readString(data, "path", context.where),
          context.clock.timestamp(),
        );
        return mutationOutcome(
          mutation,
          (value) =>
            `path=${summaryPath(value.path)} created=${String(value.created)}`,
        );
      },
    },
    "vfs.chdir": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["path"]);
        const mutation = chdirVfs(
          slice,
          readString(data, "path", context.where),
        );
        return mutationOutcome(
          mutation,
          (value) => `path=${summaryPath(value.path)}`,
        );
      },
    },
    "vfs.replace-files": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["tracked", "target"]);
        const rawTracked = data["tracked"];
        if (!Array.isArray(rawTracked))
          throw new Error(`${context.where}: tracked must be an array`);
        const tracked = rawTracked.map((value, index) => {
          if (typeof value !== "string")
            throw new Error(
              `${context.where}: tracked[${String(index)}] must be a string`,
            );
          return value;
        });
        const rawTarget = requireRecord(
          data["target"],
          `${context.where}.target`,
        );
        const target: Record<string, string> = {};
        for (const path of Object.keys(rawTarget).sort()) {
          const contents = rawTarget[path];
          if (typeof contents !== "string")
            throw new Error(
              `${context.where}: target[${JSON.stringify(path)}] must be a string`,
            );
          target[path] = contents;
        }
        const mutation = replaceVfsFiles(
          slice,
          tracked,
          target,
          context.clock.timestamp(),
        );
        if (!mutation.result.ok)
          throw new Error(
            `${context.where}: VFS replacement failed with ${mutation.result.code} at ${JSON.stringify(mutation.result.path)}`,
          );
        return { slice: mutation.slice };
      },
    },
  },
});
