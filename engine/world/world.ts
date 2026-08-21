/** Pure immutable mechanics for the simulated machine's environmental layer. */

import type {
  LoadedCartridge,
  ServiceHealth,
  WorldUnitState,
} from "../cartridge/types.js";
import type { RandomStream } from "../random/stream.js";
import { compareVfsNames } from "../vfs/path.js";
import { readVfs } from "../vfs/vfs.js";
import type { VfsSlice } from "../vfs/types.js";
import type {
  LogReadResult,
  ProcessFilter,
  ServiceFilter,
  TicketFilter,
  WorldLog,
  WorldManPage,
  WorldProcess,
  WorldService,
  WorldSlice,
  WorldTicket,
} from "./types.js";

const PID_LOW = 1000;
const PID_COUNT = 31768;
const PORT_LOW = 1024;
const PORT_COUNT = 64512;

function assignOne(
  stream: RandomStream,
  low: number,
  count: number,
  used: Set<number>,
): number {
  const start = stream.int(count);
  // The loader proves capacity first. The bound remains here so malformed
  // hand-built loaded values cannot turn deterministic probing into a hang.
  for (let offset = 0; offset < count; offset += 1) {
    const candidate = low + ((start + offset) % count);
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  throw new Error(
    `world: no free value remains in [${String(low)}, ${String(low + count - 1)}]`,
  );
}

export function createWorldSlice(
  cartridge: LoadedCartridge,
  random: RandomStream,
): WorldSlice {
  const repository = cartridge.repository;
  const usedPids = new Set(
    repository.processes
      .filter((entry) => entry.pid !== 0)
      .map((entry) => entry.pid),
  );
  const assignedPids = new Map<string, number>();
  for (const entry of [...repository.processes].sort((a, b) =>
    compareVfsNames(a.id, b.id),
  )) {
    assignedPids.set(
      entry.id,
      entry.pid === 0
        ? assignOne(random.fork("pids"), PID_LOW, PID_COUNT, usedPids)
        : entry.pid,
    );
  }

  const usedPorts = new Set(
    repository.services.flatMap((service) =>
      service.ports.filter((port) => port !== 0),
    ),
  );
  const assignedPorts = new Map<string, readonly number[]>();
  for (const service of [...repository.services].sort((a, b) =>
    compareVfsNames(a.id, b.id),
  )) {
    assignedPorts.set(
      service.id,
      service.ports.map((port) =>
        port === 0
          ? assignOne(random.fork("ports"), PORT_LOW, PORT_COUNT, usedPorts)
          : port,
      ),
    );
  }

  return {
    processes: repository.processes.map((entry) => {
      const pid = assignedPids.get(entry.id);
      if (pid === undefined)
        throw new Error(
          `world: no PID assignment for ${JSON.stringify(entry.id)}`,
        );
      return {
        ...entry,
        pid,
        command: { ...entry.command, args: [...entry.command.args] },
      };
    }),
    services: repository.services.map((entry) => {
      const ports = assignedPorts.get(entry.id);
      if (ports === undefined)
        throw new Error(
          `world: no port assignment for ${JSON.stringify(entry.id)}`,
        );
      return {
        ...entry,
        ports: [...ports],
        dependencies: [...entry.dependencies],
      };
    }),
    logs: repository.logs.map((entry) => ({
      ...entry,
      entries: [...entry.entries],
    })),
    env: { ...repository.env },
    manPages: repository.manPages.map((entry) => ({ ...entry })),
    shellHistory: [...repository.shellHistory],
    tickets: repository.tickets.map((entry) => ({ ...entry })),
  };
}

export function listProcesses(
  slice: WorldSlice,
  filter: ProcessFilter = {},
): readonly WorldProcess[] {
  return slice.processes
    .filter(
      (entry) =>
        (filter.state === undefined || entry.state === filter.state) &&
        (filter.user === undefined || entry.user === filter.user),
    )
    .sort((a, b) => a.pid - b.pid || compareVfsNames(a.id, b.id));
}

export function lookupProcess(
  slice: WorldSlice,
  id: string,
): WorldProcess | undefined {
  return slice.processes.find((entry) => entry.id === id);
}

export function lookupProcessByPid(
  slice: WorldSlice,
  pid: number,
): WorldProcess | undefined {
  return slice.processes.find((entry) => entry.pid === pid);
}

export function listServices(
  slice: WorldSlice,
  filter: ServiceFilter = {},
): readonly WorldService[] {
  return slice.services
    .filter(
      (entry) =>
        (filter.state === undefined || entry.state === filter.state) &&
        (filter.health === undefined || entry.health === filter.health),
    )
    .sort((a, b) => compareVfsNames(a.id, b.id));
}

export function lookupService(
  slice: WorldSlice,
  id: string,
): WorldService | undefined {
  return slice.services.find((entry) => entry.id === id);
}

export function listTickets(
  slice: WorldSlice,
  filter: TicketFilter = {},
): readonly WorldTicket[] {
  return slice.tickets
    .filter(
      (entry) =>
        (filter.status === undefined || entry.status === filter.status) &&
        (filter.service === undefined || entry.service === filter.service),
    )
    .sort((a, b) => compareVfsNames(a.id, b.id));
}

export function lookupTicket(
  slice: WorldSlice,
  id: string,
): WorldTicket | undefined {
  return slice.tickets.find((entry) => entry.id === id);
}

export function lookupManPage(
  slice: WorldSlice,
  name: string,
  section?: string,
): WorldManPage | undefined {
  if (section !== undefined)
    return slice.manPages.find(
      (page) => page.name === name && page.section === section,
    );
  return slice.manPages
    .filter((page) => page.name === name)
    .sort((a, b) => compareVfsNames(a.section, b.section))[0];
}

export function lookupEnv(slice: WorldSlice, name: string): string | undefined {
  return Object.hasOwn(slice.env, name) ? slice.env[name] : undefined;
}

export function listEnv(
  slice: WorldSlice,
): readonly (readonly [string, string])[] {
  return Object.keys(slice.env)
    .sort(compareVfsNames)
    .map((name) => [name, slice.env[name] as string] as const);
}

export function readShellHistory(slice: WorldSlice): readonly string[] {
  return slice.shellHistory;
}

function textEntries(contents: string): readonly string[] {
  if (contents === "") return [];
  const entries = contents.split("\n");
  if (entries.at(-1) === "") entries.pop();
  return entries;
}

export function readWorldLog(
  slice: WorldSlice,
  vfs: VfsSlice,
  id: string,
): LogReadResult {
  const log = slice.logs.find((entry) => entry.id === id);
  if (log === undefined) return { ok: false, reason: "missing-log" };
  if (log.kind === "stream") return { ok: true, entries: log.entries };
  const read = readVfs(vfs, log.path);
  if (!read.ok)
    return read.code === "ENOENT"
      ? { ok: false, reason: "missing-file" }
      : { ok: false, reason: "vfs-error", code: read.code };
  return { ok: true, entries: textEntries(read.value.contents) };
}

export function setWorldEnv(
  slice: WorldSlice,
  name: string,
  value: string,
): WorldSlice {
  return { ...slice, env: { ...slice.env, [name]: value } };
}

export function unsetWorldEnv(slice: WorldSlice, name: string): WorldSlice {
  if (!Object.hasOwn(slice.env, name)) return slice;
  return {
    ...slice,
    env: Object.fromEntries(
      Object.entries(slice.env).filter(([key]) => key !== name),
    ),
  };
}

export function appendStreamLog(
  slice: WorldSlice,
  id: string,
  entry: string,
): WorldSlice {
  const log = lookupLog(slice, id);
  if (log === undefined)
    throw new Error(`world: unknown log ${JSON.stringify(id)}`);
  if (log.kind !== "stream")
    throw new Error(`world: log ${JSON.stringify(id)} is file-backed`);
  return {
    ...slice,
    logs: slice.logs.map((log) =>
      log.id === id ? { ...log, entries: [...log.entries, entry] } : log,
    ),
  };
}

export function transitionService(
  slice: WorldSlice,
  id: string,
  state: WorldUnitState,
): WorldSlice {
  if (lookupService(slice, id) === undefined)
    throw new Error(`world: unknown service ${JSON.stringify(id)}`);
  return {
    ...slice,
    services: slice.services.map((entry) =>
      entry.id === id ? { ...entry, state } : entry,
    ),
  };
}

export function transitionServiceHealth(
  slice: WorldSlice,
  id: string,
  health: ServiceHealth,
): WorldSlice {
  if (lookupService(slice, id) === undefined)
    throw new Error(`world: unknown service ${JSON.stringify(id)}`);
  return {
    ...slice,
    services: slice.services.map((entry) =>
      entry.id === id ? { ...entry, health } : entry,
    ),
  };
}

export function restartService(slice: WorldSlice, id: string): WorldSlice {
  // Restart is a replay-visible action even though its settled state is simply
  // running; reactions own any later health consequences.
  return transitionService(slice, id, "running");
}

export function appendShellHistory(
  slice: WorldSlice,
  command: string,
): WorldSlice {
  return { ...slice, shellHistory: [...slice.shellHistory, command] };
}

export function transitionProcess(
  slice: WorldSlice,
  id: string,
  state: WorldUnitState,
): WorldSlice {
  if (lookupProcess(slice, id) === undefined)
    throw new Error(`world: unknown process ${JSON.stringify(id)}`);
  return {
    ...slice,
    processes: slice.processes.map((entry) =>
      entry.id === id ? { ...entry, state } : entry,
    ),
  };
}

export function lookupLog(slice: WorldSlice, id: string): WorldLog | undefined {
  return slice.logs.find((entry) => entry.id === id);
}
