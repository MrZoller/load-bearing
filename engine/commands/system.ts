/** Bounded system commands over cartridge-owned world state. */

import { ENV_NAME_PATTERN, ENDPOINT_URL_PATTERN } from "../cartridge/schema.js";
import {
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  MS_PER_SECOND,
  MONTH_NAMES,
  WEEKDAY_NAMES,
  civilFromEpochMs,
  parseTimestamp,
} from "../clock/civil.js";
import type { EngineEvent } from "../events/state.js";
import {
  MAX_TRANSCRIPT_DETAIL_LINES,
  MAX_TRANSCRIPT_LINE_LENGTH,
} from "../events/transcript.js";
import { describeUnwritableText } from "../text.js";
import { readWorldSlice } from "../world/module.js";
import {
  listEnv,
  listProcesses,
  lookupManPage,
  lookupProcessByPid,
  lookupService,
  readShellHistory,
} from "../world/world.js";
import type {
  CommandContext,
  CommandDefinition,
  CommandExecution,
} from "./types.js";

const EMPTY: readonly string[] = Object.freeze([]);
const EMPTY_EVENTS: readonly EngineEvent[] = Object.freeze([]);

function result(
  stdout: readonly string[],
  stderr: readonly string[],
  exitCode: number,
  events: readonly EngineEvent[] = EMPTY_EVENTS,
): CommandExecution {
  const lines = [...stdout, ...stderr];
  if (
    lines.length > MAX_TRANSCRIPT_DETAIL_LINES ||
    lines.some(
      (line) =>
        line.length > MAX_TRANSCRIPT_LINE_LENGTH ||
        describeUnwritableText(line) !== undefined,
    )
  )
    return {
      stdout: EMPTY,
      stderr: [
        "shell: command output exceeds the deterministic transcript limit",
      ],
      exitCode: exitCode === 2 ? 2 : 1,
      events: EMPTY_EVENTS,
    };
  return { stdout, stderr, exitCode, events };
}

function invalidOption(
  name: string,
  args: readonly string[],
): CommandExecution | undefined {
  const option = args.find((arg) => arg.startsWith("-") && arg !== "-");
  return option === undefined
    ? undefined
    : result(EMPTY, [`${name}: invalid option: ${option}`], 2);
}

function noArguments(context: CommandContext): CommandExecution | undefined {
  const name = context.argv[0] as string;
  const args = context.argv.slice(1);
  return (
    invalidOption(name, args) ??
    (args.length > 0
      ? result(EMPTY, [`${name}: too many arguments`], 2)
      : undefined)
  );
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function commandName(binary: string, args: readonly string[]): string {
  const slash = binary.lastIndexOf("/");
  return [binary.slice(slash + 1), ...args].join(" ");
}

const PS: CommandDefinition = {
  name: "ps",
  execute(context) {
    const rejected = noArguments(context);
    if (rejected !== undefined) return rejected;
    const rows = listProcesses(readWorldSlice(context.state)).map(
      (entry) =>
        `${String(entry.pid).padStart(5)} ${entry.user.padEnd(8)} ${entry.state === "running" ? "R" : "T"} ${commandName(entry.command.binary, entry.command.args)}`,
    );
    return result(["  PID USER     STAT COMMAND", ...rows], EMPTY, 0);
  },
};

const ENV: CommandDefinition = {
  name: "env",
  execute(context) {
    const rejected = noArguments(context);
    if (rejected !== undefined) return rejected;
    return result(
      listEnv(readWorldSlice(context.state)).map(
        ([name, value]) => `${name}=${value}`,
      ),
      EMPTY,
      0,
    );
  },
};

const EXPORT: CommandDefinition = {
  name: "export",
  execute(context) {
    const args = context.argv.slice(1);
    const rejected = invalidOption("export", args);
    if (rejected !== undefined) return rejected;
    if (args.length !== 1)
      return result(EMPTY, ["export: usage: export NAME=value"], 2);
    const assignment = args[0] as string;
    const equals = assignment.indexOf("=");
    const name = assignment.slice(0, equals < 0 ? 0 : equals);
    if (equals < 1 || !ENV_NAME_PATTERN.test(name))
      return result(
        EMPTY,
        [`export: ${assignment}: not a valid assignment`],
        2,
      );
    return result(EMPTY, EMPTY, 0, [
      {
        type: "world.env-set",
        payload: { name, value: assignment.slice(equals + 1) },
      },
    ]);
  },
};

const MAN: CommandDefinition = {
  name: "man",
  execute(context) {
    const args = context.argv.slice(1);
    const rejected = invalidOption("man", args);
    if (rejected !== undefined) return rejected;
    if (args.length < 1 || args.length > 2)
      return result(EMPTY, ["man: usage: man [section] name"], 2);
    const name = args.at(-1) as string;
    const section = args.length === 2 ? args[0] : undefined;
    const page = lookupManPage(readWorldSlice(context.state), name, section);
    if (page === undefined)
      return result(
        EMPTY,
        [
          `No manual entry for ${name}${section === undefined ? "" : ` in section ${section}`}`,
        ],
        1,
      );
    const lines = page.contents === "" ? [] : page.contents.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return result(lines, EMPTY, 0);
  },
};

const HISTORY: CommandDefinition = {
  name: "history",
  execute(context) {
    const rejected = noArguments(context);
    if (rejected !== undefined) return rejected;
    return result(
      readShellHistory(readWorldSlice(context.state)).map(
        (command, index) => `${String(index + 1).padStart(5)}  ${command}`,
      ),
      EMPTY,
      0,
    );
  },
};

const CURL: CommandDefinition = {
  name: "curl",
  execute(context) {
    const args = context.argv.slice(1);
    const rejected = invalidOption("curl", args);
    if (rejected !== undefined) return rejected;
    if (args.length !== 1) return result(EMPTY, ["curl: usage: curl URL"], 2);
    const url = args[0] as string;
    if (!ENDPOINT_URL_PATTERN.test(url))
      return result(EMPTY, [`curl: (3) URL rejected: ${url}`], 3);
    const endpoints = context.state.cartridge.repository.endpoints;
    const endpoint = Object.hasOwn(endpoints, url) ? endpoints[url] : undefined;
    if (endpoint === undefined)
      return result(EMPTY, [`curl: (6) Could not resolve endpoint: ${url}`], 6);
    const service = lookupService(
      readWorldSlice(context.state),
      endpoint.service,
    );
    if (service === undefined)
      throw new Error(
        `curl: loaded endpoint names missing service ${JSON.stringify(endpoint.service)}`,
      );
    const response =
      service.state === "running" ? endpoint.running : endpoint.unavailable;
    return result(response.stdout, response.stderr, response.exitCode);
  },
};

const SYSTEMCTL: CommandDefinition = {
  name: "systemctl",
  execute(context) {
    const args = context.argv.slice(1);
    const rejected = invalidOption("systemctl", args);
    if (rejected !== undefined) return rejected;
    if (
      args.length !== 2 ||
      !["status", "start", "stop", "restart"].includes(args[0] as string)
    )
      return result(
        EMPTY,
        ["systemctl: usage: systemctl status|start|stop|restart service"],
        2,
      );
    const action = args[0] as "status" | "start" | "stop" | "restart";
    const id = args[1] as string;
    const service = lookupService(readWorldSlice(context.state), id);
    if (service === undefined)
      return result(EMPTY, [`Unit ${id}.service could not be found.`], 4);
    if (action === "status")
      return result(
        [
          `● ${id}.service - ${id}`,
          `   Active: ${service.state === "running" ? "active (running)" : "inactive (dead)"}`,
          `   Health: ${service.health}`,
        ],
        EMPTY,
        service.state === "running" ? 0 : 3,
      );
    return result(EMPTY, EMPTY, 0, [
      { type: `world.service-${action}`, payload: { id } },
    ]);
  },
};

const KILL: CommandDefinition = {
  name: "kill",
  execute(context) {
    const args = context.argv.slice(1);
    const rejected = invalidOption("kill", args);
    if (rejected !== undefined) return rejected;
    if (args.length !== 1 || !/^[0-9]+$/.test(args[0] as string))
      return result(EMPTY, ["kill: usage: kill PID"], 2);
    const pid = Number(args[0]);
    const entry = Number.isSafeInteger(pid)
      ? lookupProcessByPid(readWorldSlice(context.state), pid)
      : undefined;
    if (entry === undefined)
      return result(EMPTY, [`kill: (${String(pid)}): No such process`], 1);
    // A stopped entry is still present in the simulated process table. Like a
    // real stopped process, signalling it succeeds; the transition is already
    // represented, so repeating the command is an event-free no-op.
    if (entry.state === "stopped") return result(EMPTY, EMPTY, 0);
    return result(EMPTY, EMPTY, 0, [
      {
        type: "world.process-transition",
        payload: { id: entry.id, state: "stopped" },
      },
    ]);
  },
};

const WHOAMI: CommandDefinition = {
  name: "whoami",
  execute(context) {
    const rejected = noArguments(context);
    return (
      rejected ??
      result([context.state.cartridge.repository.identity.user], EMPTY, 0)
    );
  },
};

const UNAME: CommandDefinition = {
  name: "uname",
  execute(context) {
    const args = context.argv.slice(1);
    if (args.length > 1 || (args.length === 1 && args[0] !== "-a")) {
      const option = args.find((arg) => arg.startsWith("-"));
      return option === undefined
        ? result(EMPTY, ["uname: too many arguments"], 2)
        : result(EMPTY, [`uname: invalid option: ${option}`], 2);
    }
    const system = context.state.cartridge.repository.system;
    return result(
      [
        args[0] === "-a"
          ? `${system.operatingSystem} ${system.hostname} ${system.kernelRelease} ${system.architecture}`
          : system.operatingSystem,
      ],
      EMPTY,
      0,
    );
  },
};

const UPTIME: CommandDefinition = {
  name: "uptime",
  execute(context) {
    const rejected = noArguments(context);
    if (rejected !== undefined) return rejected;
    const now = context.state.clock.startMs + context.state.clock.elapsedMs;
    const elapsed =
      now - parseTimestamp(context.state.cartridge.repository.system.bootedAt);
    const days = Math.floor(elapsed / MS_PER_DAY);
    const hours = Math.floor((elapsed % MS_PER_DAY) / MS_PER_HOUR);
    const minutes = Math.floor((elapsed % MS_PER_HOUR) / MS_PER_MINUTE);
    const civil = civilFromEpochMs(now);
    return result(
      [
        ` ${pad(civil.hour, 2)}:${pad(civil.minute, 2)}:${pad(civil.second, 2)} up ${String(days)} ${days === 1 ? "day" : "days"}, ${pad(hours, 2)}:${pad(minutes, 2)}`,
      ],
      EMPTY,
      0,
    );
  },
};

const DATE: CommandDefinition = {
  name: "date",
  execute(context) {
    const rejected = noArguments(context);
    if (rejected !== undefined) return rejected;
    const now = context.state.clock.startMs + context.state.clock.elapsedMs;
    const civil = civilFromEpochMs(now);
    return result(
      [
        `${WEEKDAY_NAMES[civil.weekday]} ${MONTH_NAMES[civil.month - 1]} ${String(civil.day).padStart(2)} ${pad(civil.hour, 2)}:${pad(civil.minute, 2)}:${pad(civil.second, 2)} UTC ${String(civil.year)}`,
      ],
      EMPTY,
      0,
    );
  },
};

export const SYSTEM_COMMANDS: readonly CommandDefinition[] = Object.freeze([
  PS,
  ENV,
  EXPORT,
  MAN,
  HISTORY,
  CURL,
  SYSTEMCTL,
  KILL,
  WHOAMI,
  UNAME,
  UPTIME,
  DATE,
]);
