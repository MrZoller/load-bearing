/** Event registration and snapshot boundary for the environmental world slice. */

import { parseTimestamp } from "../clock/civil.js";
import {
  ACCOUNT_NAME_PATTERN,
  ENV_NAME_PATTERN,
  FILE_PATH_PATTERN,
  MAN_PAGE_PATTERN,
  SINGLE_LINE_PATTERN,
  WORLD_ID_PATTERN,
} from "../cartridge/schema.js";
import { defineEventModule } from "../events/module.js";
import type { EventContext } from "../events/module.js";
import { readString, requirePayload } from "../events/payload.js";
import type { EventPayload } from "../events/payload.js";
import { readSlice } from "../events/state.js";
import type { SessionState } from "../events/state.js";
import { readVfsSlice } from "../vfs/module.js";
import { readVfs, writeVfs } from "../vfs/vfs.js";
import type { WorldSlice } from "./types.js";
import {
  appendShellHistory,
  appendStreamLog,
  createWorldSlice,
  lookupLog,
  lookupProcess,
  lookupService,
  restartService,
  setWorldEnv,
  transitionProcess,
  transitionService,
  transitionServiceHealth,
  unsetWorldEnv,
} from "./world.js";

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

function worldId(data: EventPayload, key: string, where: string): string {
  const value = readString(data, key, where);
  if (!WORLD_ID_PATTERN.test(value))
    throw new Error(
      `${where}: ${key} must be a non-empty single-line identifier`,
    );
  return value;
}

function unitState(data: EventPayload, where: string): "running" | "stopped" {
  const state = readString(data, "state", where);
  if (state !== "running" && state !== "stopped")
    throw new Error(`${where}: state must be running or stopped`);
  return state;
}

function serviceHealth(
  data: EventPayload,
  where: string,
): "healthy" | "degraded" | "unhealthy" | "unknown" {
  const health = readString(data, "health", where);
  if (!["healthy", "degraded", "unhealthy", "unknown"].includes(health))
    throw new Error(
      `${where}: health must be healthy, degraded, unhealthy or unknown`,
    );
  return health as "healthy" | "degraded" | "unhealthy" | "unknown";
}

function requireRecord(
  value: unknown,
  where: string,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${where}: must be an object`);
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
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
      throw new Error(`${where}.${key}: accessors are not inert snapshot data`);
    if (!descriptor.enumerable)
      throw new Error(
        `${where}.${key}: non-enumerable fields are not JSON data`,
      );
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireArray(value: unknown, where: string): readonly unknown[] {
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

function requireOpenRecord(
  value: unknown,
  where: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${where}: must be an object`);
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new Error(`${where}: must be a plain JSON object`);
  if (Object.getOwnPropertySymbols(value).length > 0)
    throw new Error(`${where}: must not contain symbol-keyed fields`);
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (descriptor.get !== undefined || descriptor.set !== undefined)
      throw new Error(`${where}.${key}: accessors are not inert snapshot data`);
    if (!descriptor.enumerable)
      throw new Error(
        `${where}.${key}: non-enumerable fields are not JSON data`,
      );
  }
  return value as Readonly<Record<string, unknown>>;
}

function stringField(
  record: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): string {
  const value = record[key];
  if (typeof value !== "string")
    throw new Error(`${where}.${key}: must be a string`);
  return value;
}

function stringArray(value: unknown, where: string): readonly string[] {
  return requireArray(value, where).map((entry, index) => {
    if (typeof entry !== "string")
      throw new Error(`${where}[${String(index)}]: must be a string`);
    return entry;
  });
}

/** Validate every nested field without normalizing snapshot bytes. */
export function validateWorldSlice(slice: unknown, where: string): WorldSlice {
  const root = requireRecord(slice, where, [
    "processes",
    "services",
    "logs",
    "env",
    "manPages",
    "shellHistory",
    "tickets",
  ]);
  const ids = (
    values: unknown,
    name: string,
    fields: readonly string[],
    check: (entry: Readonly<Record<string, unknown>>, at: string) => void,
  ): void => {
    const seen = new Set<string>();
    requireArray(values, `${where}.${name}`).forEach((value, index) => {
      const at = `${where}.${name}[${String(index)}]`;
      const entry = requireRecord(value, at, fields);
      const id = stringField(entry, "id", at);
      if (!WORLD_ID_PATTERN.test(id) || seen.has(id))
        throw new Error(
          `${at}.id: must be a unique non-empty single-line identifier`,
        );
      seen.add(id);
      check(entry, at);
    });
  };

  const pids = new Set<number>();
  ids(
    root["processes"],
    "processes",
    ["id", "pid", "user", "command", "startedAt", "state"],
    (entry, at) => {
      const pid = entry["pid"];
      if (
        typeof pid !== "number" ||
        !Number.isInteger(pid) ||
        pid < 1 ||
        pid > 32767 ||
        pids.has(pid)
      )
        throw new Error(`${at}.pid: must be a unique integer in [1, 32767]`);
      pids.add(pid);
      if (!ACCOUNT_NAME_PATTERN.test(stringField(entry, "user", at)))
        throw new Error(`${at}.user: must be a POSIX user name`);
      const command = requireRecord(entry["command"], `${at}.command`, [
        "binary",
        "args",
      ]);
      if (
        !FILE_PATH_PATTERN.test(stringField(command, "binary", `${at}.command`))
      )
        throw new Error(
          `${at}.command.binary: must be a canonical absolute file path`,
        );
      stringArray(command["args"], `${at}.command.args`);
      try {
        parseTimestamp(stringField(entry, "startedAt", at));
      } catch {
        throw new Error(`${at}.startedAt: must be a real UTC instant`);
      }
      const state = stringField(entry, "state", at);
      if (state !== "running" && state !== "stopped")
        throw new Error(`${at}.state: must be running or stopped`);
    },
  );

  const serviceIds = new Set<string>();
  const ports = new Set<number>();
  ids(
    root["services"],
    "services",
    ["id", "state", "health", "ports", "dependencies"],
    (entry, at) => {
      serviceIds.add(stringField(entry, "id", at));
      const state = stringField(entry, "state", at);
      if (state !== "running" && state !== "stopped")
        throw new Error(`${at}.state: must be running or stopped`);
      const health = stringField(entry, "health", at);
      if (!["healthy", "degraded", "unhealthy", "unknown"].includes(health))
        throw new Error(`${at}.health: invalid health`);
      requireArray(entry["ports"], `${at}.ports`).forEach((port, index) => {
        if (
          typeof port !== "number" ||
          !Number.isInteger(port) ||
          port < 1 ||
          port > 65535 ||
          ports.has(port)
        )
          throw new Error(
            `${at}.ports[${String(index)}]: must be a globally unique integer in [1, 65535]`,
          );
        ports.add(port);
      });
      stringArray(entry["dependencies"], `${at}.dependencies`);
    },
  );
  requireArray(root["services"], `${where}.services`).forEach(
    (value, index) => {
      const entry = value as Readonly<Record<string, unknown>>;
      stringArray(
        entry["dependencies"],
        `${where}.services[${String(index)}].dependencies`,
      ).forEach((id, dependencyIndex) => {
        if (!serviceIds.has(id))
          throw new Error(
            `${where}.services[${String(index)}].dependencies[${String(dependencyIndex)}]: must name a service in this slice`,
          );
      });
    },
  );

  ids(root["logs"], "logs", ["id", "kind", "path", "entries"], (entry, at) => {
    const kind = stringField(entry, "kind", at);
    const path = stringField(entry, "path", at);
    const entries = stringArray(entry["entries"], `${at}.entries`);
    if (kind !== "file" && kind !== "stream")
      throw new Error(`${at}.kind: must be file or stream`);
    if (
      kind === "file" &&
      (!FILE_PATH_PATTERN.test(path) || entries.length !== 0)
    )
      throw new Error(
        `${at}: file logs require an absolute path and no entries`,
      );
    if (kind === "stream" && path !== "")
      throw new Error(`${at}.path: stream logs require an empty path`);
  });

  const env = requireOpenRecord(root["env"], `${where}.env`);
  for (const key of Object.keys(env)) {
    if (!ENV_NAME_PATTERN.test(key) || typeof env[key] !== "string")
      throw new Error(
        `${where}.env[${JSON.stringify(key)}]: must be an environment name with a string value`,
      );
  }
  const pages = new Set<string>();
  requireArray(root["manPages"], `${where}.manPages`).forEach(
    (value, index) => {
      const at = `${where}.manPages[${String(index)}]`;
      const entry = requireRecord(value, at, ["name", "section", "contents"]);
      const name = stringField(entry, "name", at);
      const section = stringField(entry, "section", at);
      stringField(entry, "contents", at);
      if (!MAN_PAGE_PATTERN.test(name) || !WORLD_ID_PATTERN.test(section))
        throw new Error(`${at}: name and section must be valid identifiers`);
      const key = `${name}\u0000${section}`;
      if (pages.has(key))
        throw new Error(`${at}: duplicate man page name and section`);
      pages.add(key);
    },
  );
  stringArray(root["shellHistory"], `${where}.shellHistory`);
  ids(
    root["tickets"],
    "tickets",
    ["id", "status", "title", "body", "service"],
    (entry, at) => {
      if (!WORLD_ID_PATTERN.test(stringField(entry, "status", at)))
        throw new Error(
          `${at}.status: must be a non-empty single-line identifier`,
        );
      const title = stringField(entry, "title", at);
      if (title === "" || !SINGLE_LINE_PATTERN.test(title))
        throw new Error(`${at}.title: must be a non-empty single-line string`);
      stringField(entry, "body", at);
      const service = stringField(entry, "service", at);
      if (service !== "" && !serviceIds.has(service))
        throw new Error(`${at}.service: must name a service in this slice`);
    },
  );
  return slice as WorldSlice;
}

export function readWorldSlice(state: SessionState): WorldSlice {
  return validateWorldSlice(
    readSlice(state, "world"),
    "session state: slices.world",
  );
}

function requireService(slice: WorldSlice, id: string, where: string): void {
  if (lookupService(slice, id) === undefined)
    throw new Error(`${where}: unknown service ${JSON.stringify(id)}`);
}

export const WORLD_MODULE = defineEventModule<WorldSlice>({
  namespace: "world",
  description:
    "Processes, services, logs, environment, manual pages, history and tickets.",
  initialSlice: (context) =>
    createWorldSlice(context.cartridge, context.random),
  validateSlice: validateWorldSlice,
  events: {
    "world.env-set": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["name", "value"]);
        const name = readString(data, "name", context.where);
        if (!ENV_NAME_PATTERN.test(name))
          throw new Error(
            `${context.where}: name must be an environment variable name`,
          );
        return {
          slice: setWorldEnv(
            slice,
            name,
            readString(data, "value", context.where),
          ),
          summary: `name=${JSON.stringify(name)}`,
        };
      },
    },
    "world.env-unset": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["name"]);
        const name = readString(data, "name", context.where);
        if (!ENV_NAME_PATTERN.test(name))
          throw new Error(
            `${context.where}: name must be an environment variable name`,
          );
        return {
          slice: unsetWorldEnv(slice, name),
          summary: `name=${JSON.stringify(name)}`,
        };
      },
    },
    "world.log-append": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["id", "entry"]);
        const id = worldId(data, "id", context.where);
        const entry = readString(data, "entry", context.where);
        const log = lookupLog(slice, id);
        if (log === undefined)
          throw new Error(
            `${context.where}: unknown log ${JSON.stringify(id)}`,
          );
        if (log.kind === "stream")
          return {
            slice: appendStreamLog(slice, id, entry),
            summary: `id=${JSON.stringify(id)}`,
          };
        const vfs = readVfsSlice(context.state);
        const current = readVfs(vfs, log.path);
        if (!current.ok)
          throw new Error(
            `${context.where}: cannot read file log ${JSON.stringify(id)}: ${current.code}`,
          );
        const separator =
          current.value.contents === "" || current.value.contents.endsWith("\n")
            ? ""
            : "\n";
        const contents = `${current.value.contents}${separator}${entry}\n`;
        const trial = writeVfs(
          vfs,
          log.path,
          contents,
          context.clock.timestamp(),
        );
        if (!trial.result.ok)
          throw new Error(
            `${context.where}: cannot append file log ${JSON.stringify(id)}: ${trial.result.code}`,
          );
        return {
          summary: `id=${JSON.stringify(id)}`,
          effects: [
            {
              type: "vfs.write",
              payload: { path: log.path, contents, transcript: false },
              version: 0,
            },
          ],
        };
      },
    },
    "world.service-start": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["id"]);
        const id = worldId(data, "id", context.where);
        requireService(slice, id, context.where);
        return {
          slice: transitionService(slice, id, "running"),
          summary: `id=${JSON.stringify(id)}`,
        };
      },
    },
    "world.service-stop": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["id"]);
        const id = worldId(data, "id", context.where);
        requireService(slice, id, context.where);
        return {
          slice: transitionService(slice, id, "stopped"),
          summary: `id=${JSON.stringify(id)}`,
        };
      },
    },
    "world.service-restart": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["id"]);
        const id = worldId(data, "id", context.where);
        requireService(slice, id, context.where);
        return {
          slice: restartService(slice, id),
          summary: `id=${JSON.stringify(id)}`,
        };
      },
    },
    "world.service-health": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["id", "health"]);
        const id = worldId(data, "id", context.where);
        requireService(slice, id, context.where);
        const health = serviceHealth(data, context.where);
        return {
          slice: transitionServiceHealth(slice, id, health),
          summary: `id=${JSON.stringify(id)} health=${health}`,
        };
      },
    },
    "world.history-append": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["command"]);
        const command = readString(data, "command", context.where);
        return {
          slice: appendShellHistory(slice, command),
          summary: `length=${String(slice.shellHistory.length + 1)}`,
        };
      },
    },
    "world.process-transition": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["id", "state"]);
        const id = worldId(data, "id", context.where);
        if (lookupProcess(slice, id) === undefined)
          throw new Error(
            `${context.where}: unknown process ${JSON.stringify(id)}`,
          );
        const state = unitState(data, context.where);
        return {
          slice: transitionProcess(slice, id, state),
          summary: `id=${JSON.stringify(id)} state=${state}`,
        };
      },
    },
  },
});
