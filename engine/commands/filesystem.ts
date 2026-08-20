/** Deterministic filesystem commands over the live VFS slice. */

import {
  MONTH_NAMES,
  civilFromEpochMs,
  formatTimestamp,
  parseTimestamp,
} from "../clock/civil.js";
import {
  MAX_TRANSCRIPT_DETAIL_LINES,
  MAX_TRANSCRIPT_LINE_LENGTH,
} from "../events/transcript.js";
import type { EngineEvent } from "../events/state.js";
import { describeUnwritableText } from "../text.js";
import { readVfsSlice } from "../vfs/module.js";
import { baseName, compareVfsNames, parentPath } from "../vfs/path.js";
import type {
  VfsEntry,
  VfsFailure,
  VfsMutation,
  VfsSlice,
} from "../vfs/types.js";
import {
  chmodVfs,
  chdirVfs,
  copyVfs,
  deleteVfs,
  listVfs,
  mkdirVfs,
  readVfs,
  renameVfs,
  statVfs,
  touchVfs,
} from "../vfs/vfs.js";
import { CommandOptionError, parseCommandOptions } from "./options.js";
import type {
  CommandContext,
  CommandDefinition,
  CommandExecution,
  CommandOptionSpec,
  ParsedCommandOptions,
} from "./types.js";

const EMPTY = Object.freeze([]) as readonly string[];
const EMPTY_EVENTS = Object.freeze([]) as readonly EngineEvent[];

function event(
  type: string,
  payload: Readonly<Record<string, unknown>>,
): EngineEvent {
  return { type, payload };
}

function execution(
  stdout: readonly string[],
  stderr: readonly string[],
  exitCode: number,
  events: readonly EngineEvent[],
): CommandExecution {
  const lines = [...stdout, ...stderr];
  if (
    lines.length > MAX_TRANSCRIPT_DETAIL_LINES ||
    lines.some(
      (line) =>
        line.length > MAX_TRANSCRIPT_LINE_LENGTH ||
        describeUnwritableText(line) !== undefined,
    )
  ) {
    return {
      stdout: EMPTY,
      stderr: [
        "shell: command output exceeds the deterministic transcript limit",
      ],
      exitCode: exitCode === 2 ? 2 : 1,
      events,
    };
  }
  return { stdout, stderr, exitCode, events };
}

function usage(name: string, message: string): CommandExecution {
  return execution(EMPTY, [`${name}: ${message}`], 2, EMPTY_EVENTS);
}

function parse(
  context: CommandContext,
  specs: readonly CommandOptionSpec[],
): ParsedCommandOptions | CommandExecution {
  try {
    return parseCommandOptions(context.argv.slice(1), specs);
  } catch (error) {
    if (!(error instanceof CommandOptionError)) throw error;
    const token = error.token;
    const detail = error.detail;
    const message = detail.startsWith("unknown ")
      ? `invalid option: ${token}`
      : `option ${JSON.stringify(token)}: ${detail}`;
    return usage(context.argv[0] ?? "command", message);
  }
}

function isExecution(
  value: ParsedCommandOptions | CommandExecution,
): value is CommandExecution {
  return "exitCode" in value;
}

function hasOption(options: ParsedCommandOptions, key: string): boolean {
  return (options.options[key]?.length ?? 0) > 0;
}

function shellQuote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

const FAILURE_TEXT: Readonly<Record<VfsFailure["code"], string>> = {
  EACCES: "Permission denied",
  EBUSY: "Device or resource busy",
  EEXIST: "File exists",
  EINVAL: "Invalid argument",
  EISDIR: "Is a directory",
  ENOENT: "No such file or directory",
  ENOTDIR: "Not a directory",
  ENOTEMPTY: "Directory not empty",
  EPERM: "Operation not permitted",
};

function failure(
  name: string,
  action: string,
  path: string,
  value: VfsFailure,
): string {
  return `${name}: ${action}${shellQuote(path)}: ${FAILURE_TEXT[value.code]}`;
}

function genericFailure(name: string, path: string, value: VfsFailure): string {
  return `${name}: ${path}: ${FAILURE_TEXT[value.code]}`;
}

function now(state: CommandContext["state"]): string {
  return formatTimestamp(state.clock.startMs + state.clock.elapsedMs);
}

function splitLines(contents: string): string[] {
  if (contents === "") return [];
  const lines = contents.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const point of text) {
    const value = point.codePointAt(0) ?? 0;
    bytes += value <= 0x7f ? 1 : value <= 0x7ff ? 2 : value <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function immediateChildDirectories(slice: VfsSlice, path: string): number {
  return Object.entries(slice.entries).filter(
    ([candidate, entry]) =>
      entry.kind === "directory" &&
      candidate !== path &&
      parentPath(candidate) === path,
  ).length;
}

function links(slice: VfsSlice, path: string, entry: VfsEntry): number {
  return entry.kind === "file" ? 1 : 2 + immediateChildDirectories(slice, path);
}

function size(entry: VfsEntry): number {
  return entry.kind === "directory" ? 4096 : utf8Bytes(entry.contents);
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return String(bytes);
  const units = ["K", "M", "G", "T"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const rendered = value < 10 ? value.toFixed(1) : String(Math.round(value));
  return `${rendered}${units[index]}`;
}

function permissions(entry: VfsEntry): string {
  const value = Number.parseInt(entry.mode, 8);
  const chars = [
    entry.kind === "directory" ? "d" : "-",
    value & 0o400 ? "r" : "-",
    value & 0o200 ? "w" : "-",
    value & 0o100 ? "x" : "-",
    value & 0o040 ? "r" : "-",
    value & 0o020 ? "w" : "-",
    value & 0o010 ? "x" : "-",
    value & 0o004 ? "r" : "-",
    value & 0o002 ? "w" : "-",
    value & 0o001 ? "x" : "-",
  ];
  if (value & 0o4000) chars[3] = value & 0o100 ? "s" : "S";
  if (value & 0o2000) chars[6] = value & 0o010 ? "s" : "S";
  if (value & 0o1000) chars[9] = value & 0o001 ? "t" : "T";
  return chars.join("");
}

/** Stable C-locale UTC form; unlike host GNU ls it never consults today's year. */
function longTimestamp(timestamp: string): string {
  const civil = civilFromEpochMs(parseTimestamp(timestamp));
  return `${MONTH_NAMES[civil.month - 1]} ${String(civil.day).padStart(2, " ")} ${String(civil.hour).padStart(2, "0")}:${String(civil.minute).padStart(2, "0")}`;
}

interface Listed {
  readonly name: string;
  readonly path: string;
  readonly entry: VfsEntry;
}

function longListing(
  slice: VfsSlice,
  items: readonly Listed[],
  human: boolean,
): string[] {
  const rows = items.map((item) => ({
    item,
    link: String(links(slice, item.path, item.entry)),
    owner: item.entry.owner,
    group: item.entry.group,
    size: human ? humanSize(size(item.entry)) : String(size(item.entry)),
  }));
  const width = (values: readonly string[]): number =>
    values.reduce((largest, value) => Math.max(largest, value.length), 0);
  const linkWidth = width(rows.map((row) => row.link));
  const ownerWidth = width(rows.map((row) => row.owner));
  const groupWidth = width(rows.map((row) => row.group));
  const sizeWidth = width(rows.map((row) => row.size));
  return rows.map(
    (row) =>
      `${permissions(row.item.entry)} ${row.link.padStart(linkWidth)} ${row.owner.padEnd(ownerWidth)} ${row.group.padEnd(groupWidth)} ${row.size.padStart(sizeWidth)} ${longTimestamp(row.item.entry.mtime)} ${row.item.name}`,
  );
}

const LS: CommandDefinition = Object.freeze({
  name: "ls",
  execute(context: CommandContext) {
    const parsed = parse(context, [
      { key: "long", short: "l" },
      { key: "all", short: "a" },
      { key: "human", short: "h" },
    ]);
    if (isExecution(parsed)) return parsed;
    const slice = readVfsSlice(context.state);
    const operands = parsed.operands.length === 0 ? ["."] : parsed.operands;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const events: EngineEvent[] = [];
    const multiple = operands.length > 1;
    for (const operand of operands) {
      const found = statVfs(slice, operand);
      events.push(event("vfs.stat", { path: operand }));
      if (!found.ok) {
        stderr.push(failure("ls", "cannot access ", operand, found));
        continue;
      }
      let items: Listed[];
      if (found.value.entry.kind === "file") {
        items = [{ name: operand, ...found.value }];
      } else {
        const listed = listVfs(slice, operand);
        events.push(event("vfs.list", { path: operand }));
        if (!listed.ok) {
          stderr.push(failure("ls", "cannot open directory ", operand, listed));
          continue;
        }
        items = listed.value
          .filter(
            (item) => hasOption(parsed, "all") || !item.name.startsWith("."),
          )
          .map((item) => ({ ...item }));
        if (hasOption(parsed, "all")) {
          const parent = parentPath(found.value.path);
          const parentEntry = slice.entries[parent];
          items = [
            { name: ".", path: found.value.path, entry: found.value.entry },
            ...(parentEntry === undefined
              ? []
              : [{ name: "..", path: parent, entry: parentEntry }]),
            ...items,
          ];
        }
        if (multiple) {
          if (stdout.length > 0) stdout.push("");
          stdout.push(`${operand}:`);
        }
      }
      stdout.push(
        ...(hasOption(parsed, "long")
          ? longListing(slice, items, hasOption(parsed, "human"))
          : items.map((item) => item.name)),
      );
    }
    return execution(stdout, stderr, stderr.length === 0 ? 0 : 1, events);
  },
});

function readFiles(
  context: CommandContext,
  name: string,
  operands: readonly string[],
  render: (contents: string, path: string) => readonly string[],
  ioExit = 1,
): CommandExecution {
  const slice = readVfsSlice(context.state);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const events: EngineEvent[] = [];
  for (const path of operands) {
    const result = readVfs(slice, path);
    events.push(event("vfs.read", { path }));
    if (result.ok) stdout.push(...render(result.value.contents, path));
    else stderr.push(genericFailure(name, path, result));
  }
  return execution(stdout, stderr, stderr.length === 0 ? 0 : ioExit, events);
}

const CAT: CommandDefinition = Object.freeze({
  name: "cat",
  execute(context: CommandContext) {
    const parsed = parse(context, []);
    if (isExecution(parsed)) return parsed;
    if (parsed.operands.length === 0)
      return usage("cat", "missing file operand");
    return readFiles(context, "cat", parsed.operands, splitLines);
  },
});

const CD: CommandDefinition = Object.freeze({
  name: "cd",
  execute(context: CommandContext) {
    const parsed = parse(context, []);
    if (isExecution(parsed)) return parsed;
    if (parsed.operands.length > 1) return usage("cd", "too many arguments");
    const path =
      parsed.operands[0] ?? readVfsSlice(context.state).identity.home;
    const mutation = chdirVfs(readVfsSlice(context.state), path);
    const events = [event("vfs.chdir", { path })];
    return mutation.result.ok
      ? execution(EMPTY, EMPTY, 0, events)
      : execution(
          EMPTY,
          [genericFailure("cd", path, mutation.result)],
          1,
          events,
        );
  },
});

function countOption(
  context: CommandContext,
): ParsedCommandOptions | CommandExecution {
  const parsed = parse(context, [
    { key: "count", short: "n", value: "required" },
  ]);
  if (isExecution(parsed)) return parsed;
  const raw = parsed.options["count"]?.at(-1) ?? "10";
  if (!/^\d+$/.test(raw))
    return usage(
      context.argv[0] ?? "command",
      `invalid number of lines: ${raw}`,
    );
  return parsed;
}

function countValue(parsed: ParsedCommandOptions): number {
  return Number(parsed.options["count"]?.at(-1) ?? "10");
}

const HEAD: CommandDefinition = Object.freeze({
  name: "head",
  execute(context: CommandContext) {
    const parsed = countOption(context);
    if (isExecution(parsed)) return parsed;
    if (parsed.operands.length === 0)
      return usage("head", "missing file operand");
    const count = countValue(parsed);
    let first = true;
    return readFiles(context, "head", parsed.operands, (contents, path) => {
      const lines = splitLines(contents).slice(0, count);
      if (parsed.operands.length === 1) return lines;
      const result = [...(first ? [] : [""]), `==> ${path} <==`, ...lines];
      first = false;
      return result;
    });
  },
});

const TAIL: CommandDefinition = Object.freeze({
  name: "tail",
  execute(context: CommandContext) {
    const parsed = countOption(context);
    if (isExecution(parsed)) return parsed;
    if (parsed.operands.length === 0)
      return usage("tail", "missing file operand");
    const count = countValue(parsed);
    let first = true;
    return readFiles(context, "tail", parsed.operands, (contents, path) => {
      const lines = count === 0 ? [] : splitLines(contents).slice(-count);
      if (parsed.operands.length === 1) return lines;
      const result = [...(first ? [] : [""]), `==> ${path} <==`, ...lines];
      first = false;
      return result;
    });
  },
});

const WC: CommandDefinition = Object.freeze({
  name: "wc",
  execute(context: CommandContext) {
    const parsed = parse(context, []);
    if (isExecution(parsed)) return parsed;
    if (parsed.operands.length === 0)
      return usage("wc", "missing file operand");
    const totals = { lines: 0, words: 0, bytes: 0 };
    const rows: string[] = [];
    const result = readFiles(
      context,
      "wc",
      parsed.operands,
      (contents, path) => {
        const counts = {
          lines: contents.split("\n").length - 1,
          words:
            contents.trim() === "" ? 0 : contents.trim().split(/\s+/).length,
          bytes: utf8Bytes(contents),
        };
        totals.lines += counts.lines;
        totals.words += counts.words;
        totals.bytes += counts.bytes;
        rows.push(
          `${String(counts.lines).padStart(7)} ${String(counts.words).padStart(7)} ${String(counts.bytes).padStart(7)} ${path}`,
        );
        return [];
      },
    );
    if (parsed.operands.length > 1 && rows.length > 0)
      rows.push(
        `${String(totals.lines).padStart(7)} ${String(totals.words).padStart(7)} ${String(totals.bytes).padStart(7)} total`,
      );
    return execution(rows, result.stderr, result.exitCode, result.events);
  },
});

interface GrepFile {
  readonly path: string;
  readonly label: string;
}

interface GrepFailure {
  readonly label: string;
  readonly value: VfsFailure;
}

interface RecursiveFiles {
  readonly files: readonly GrepFile[];
  readonly failures: readonly GrepFailure[];
}

function recursiveFiles(
  slice: VfsSlice,
  root: string,
  events: EngineEvent[],
): RecursiveFiles | VfsFailure {
  const rootResult = statVfs(slice, root);
  if (!rootResult.ok) return rootResult;
  if (rootResult.value.entry.kind === "file")
    return {
      files: [{ path: rootResult.value.path, label: root }],
      failures: [],
    };
  const paths: GrepFile[] = [];
  const failures: GrepFailure[] = [];
  const displayRoot = root.length > 1 ? root.replace(/\/$/, "") : root;
  const pending: [string, string][] = [[rootResult.value.path, displayRoot]];
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined) break;
    const [directory, display] = current;
    const listed = listVfs(slice, directory);
    events.push(event("vfs.list", { path: directory }));
    if (!listed.ok) {
      failures.push({ label: display, value: listed });
      continue;
    }
    for (const item of listed.value) {
      const label =
        display === "/" ? `/${item.name}` : `${display}/${item.name}`;
      if (item.entry.kind === "directory") pending.push([item.path, label]);
      else {
        paths.push({
          path: item.path,
          label,
        });
      }
    }
  }
  return {
    files: paths.sort((left, right) => compareVfsNames(left.path, right.path)),
    failures: failures.sort((left, right) =>
      compareVfsNames(left.label, right.label),
    ),
  };
}

function isVfsFailure(value: RecursiveFiles | VfsFailure): value is VfsFailure {
  return Object.hasOwn(value, "ok");
}

const GREP: CommandDefinition = Object.freeze({
  name: "grep",
  execute(context: CommandContext) {
    const parsed = parse(context, [
      { key: "ignoreCase", short: "i" },
      { key: "lineNumber", short: "n" },
      { key: "recursive", short: "r" },
    ]);
    if (isExecution(parsed)) return parsed;
    const pattern = parsed.operands[0];
    const authoredRoots = parsed.operands.slice(1);
    if (pattern === undefined || authoredRoots.length === 0)
      return usage("grep", "usage: grep [-inr] PATTERN FILE...");
    let matcher: { test(value: string): boolean };
    try {
      matcher = new RegExp(pattern, hasOption(parsed, "ignoreCase") ? "i" : "");
    } catch {
      return execution(
        EMPTY,
        [`grep: invalid regular expression: ${pattern}`],
        2,
        EMPTY_EVENTS,
      );
    }
    const slice = readVfsSlice(context.state);
    const files: GrepFile[] = [];
    const stderr: string[] = [];
    const events: EngineEvent[] = [];
    for (const root of authoredRoots) {
      if (hasOption(parsed, "recursive")) {
        events.push(event("vfs.stat", { path: root }));
        const found = recursiveFiles(slice, root, events);
        if (isVfsFailure(found)) {
          stderr.push(genericFailure("grep", root, found));
          continue;
        }
        files.push(...found.files);
        stderr.push(
          ...found.failures.map(({ label, value }) =>
            genericFailure("grep", label, value),
          ),
        );
      } else files.push({ path: root, label: root });
    }
    const stdout: string[] = [];
    const prefixFile = files.length > 1 || hasOption(parsed, "recursive");
    for (const file of files) {
      const read = readVfs(slice, file.path);
      events.push(event("vfs.read", { path: file.path }));
      if (!read.ok) {
        stderr.push(genericFailure("grep", file.label, read));
        continue;
      }
      splitLines(read.value.contents).forEach((line, index) => {
        if (!matcher.test(line)) return;
        const prefix = `${prefixFile ? `${file.label}:` : ""}${hasOption(parsed, "lineNumber") ? `${String(index + 1)}:` : ""}`;
        stdout.push(prefix + line);
      });
    }
    return execution(
      stdout,
      stderr,
      stderr.length > 0 ? 2 : stdout.length > 0 ? 0 : 1,
      events,
    );
  },
});

const FIND: CommandDefinition = Object.freeze({
  name: "find",
  execute(context: CommandContext) {
    const parsed = parse(context, []);
    if (isExecution(parsed)) return parsed;
    const slice = readVfsSlice(context.state);
    const roots = parsed.operands.length === 0 ? ["."] : parsed.operands;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const events: EngineEvent[] = [];
    for (const root of roots) {
      const found = statVfs(slice, root);
      events.push(event("vfs.stat", { path: root }));
      if (!found.ok) {
        stderr.push(genericFailure("find", root, found));
        continue;
      }
      stdout.push(root);
      if (found.value.entry.kind === "file") continue;
      const pending: readonly [string, string][] = [
        [found.value.path, root.replace(/\/$/, "")],
      ];
      const queue = [...pending];
      while (queue.length > 0) {
        const current = queue.shift();
        if (current === undefined) break;
        const [absolute, display] = current;
        const listed = listVfs(slice, absolute);
        events.push(event("vfs.list", { path: absolute }));
        if (!listed.ok) {
          stderr.push(genericFailure("find", display, listed));
          continue;
        }
        for (const item of listed.value) {
          const child =
            display === "/" ? `/${item.name}` : `${display}/${item.name}`;
          stdout.push(child);
          if (item.entry.kind === "directory") queue.push([item.path, child]);
        }
      }
    }
    return execution(stdout, stderr, stderr.length === 0 ? 0 : 1, events);
  },
});

function mutateMany(
  context: CommandContext,
  name: string,
  operands: readonly string[],
  apply: (slice: VfsSlice, operand: string) => VfsMutation<unknown>,
  makeEvent: (operand: string) => EngineEvent,
  action = "cannot access ",
  suppressMissing = false,
): CommandExecution {
  let shadow = readVfsSlice(context.state);
  const stderr: string[] = [];
  const events: EngineEvent[] = [];
  for (const operand of operands) {
    const mutation = apply(shadow, operand);
    if (!(
      suppressMissing &&
      !mutation.result.ok &&
      mutation.result.code === "ENOENT"
    ))
      events.push(makeEvent(operand));
    if (mutation.result.ok) shadow = mutation.slice;
    else if (!(suppressMissing && mutation.result.code === "ENOENT"))
      stderr.push(failure(name, action, operand, mutation.result));
  }
  return execution(EMPTY, stderr, stderr.length === 0 ? 0 : 1, events);
}

const MKDIR: CommandDefinition = Object.freeze({
  name: "mkdir",
  execute(context: CommandContext) {
    const parsed = parse(context, [{ key: "parents", short: "p" }]);
    if (isExecution(parsed)) return parsed;
    if (parsed.operands.length === 0) return usage("mkdir", "missing operand");
    const parents = hasOption(parsed, "parents");
    const timestamp = now(context.state);
    return mutateMany(
      context,
      "mkdir",
      parsed.operands,
      (slice, path) => mkdirVfs(slice, path, timestamp, parents),
      (path) => event("vfs.mkdir", { path, parents }),
      "cannot create directory ",
    );
  },
});

const TOUCH: CommandDefinition = Object.freeze({
  name: "touch",
  execute(context: CommandContext) {
    const parsed = parse(context, []);
    if (isExecution(parsed)) return parsed;
    if (parsed.operands.length === 0)
      return usage("touch", "missing file operand");
    const timestamp = now(context.state);
    return mutateMany(
      context,
      "touch",
      parsed.operands,
      (slice, path) => touchVfs(slice, path, timestamp),
      (path) => event("vfs.touch", { path }),
      "cannot touch ",
    );
  },
});

const RM: CommandDefinition = Object.freeze({
  name: "rm",
  execute(context: CommandContext) {
    const parsed = parse(context, [
      { key: "recursive", short: "r" },
      { key: "force", short: "f" },
    ]);
    if (isExecution(parsed)) return parsed;
    const force = hasOption(parsed, "force");
    if (parsed.operands.length === 0)
      return force
        ? execution(EMPTY, EMPTY, 0, EMPTY_EVENTS)
        : usage("rm", "missing operand");
    const recursive = hasOption(parsed, "recursive");
    const timestamp = now(context.state);
    let shadow = readVfsSlice(context.state);
    const stderr: string[] = [];
    const events: EngineEvent[] = [];
    for (const path of parsed.operands) {
      const mutation = deleteVfs(
        shadow,
        path,
        timestamp,
        recursive,
        !recursive,
      );
      if (!mutation.result.ok && mutation.result.code === "ENOENT" && force)
        continue;
      events.push(
        event("vfs.delete", { path, recursive, fileOnly: !recursive }),
      );
      if (mutation.result.ok) shadow = mutation.slice;
      else stderr.push(failure("rm", "cannot remove ", path, mutation.result));
    }
    return execution(EMPTY, stderr, stderr.length === 0 ? 0 : 1, events);
  },
});

function transfer(
  context: CommandContext,
  name: "mv" | "cp",
  operands: readonly string[],
  recursive: boolean,
  preserve: boolean,
): CommandExecution {
  if (operands.length < 2)
    return usage(name, "missing destination file operand");
  const destination = operands.at(-1) as string;
  const sources = operands.slice(0, -1);
  let shadow = readVfsSlice(context.state);
  const events: EngineEvent[] = [];
  if (sources.length > 1) {
    const target = statVfs(shadow, destination);
    events.push(event("vfs.stat", { path: destination }));
    if (!target.ok || target.value.entry.kind !== "directory")
      return execution(
        EMPTY,
        [`${name}: target ${shellQuote(destination)} is not a directory`],
        1,
        events,
      );
  }
  const stderr: string[] = [];
  const timestamp = now(context.state);
  for (const source of sources) {
    const mutation =
      name === "mv"
        ? renameVfs(shadow, source, destination, timestamp)
        : copyVfs(shadow, source, destination, timestamp, {
            recursive,
            preserve,
          });
    events.push(
      event(name === "mv" ? "vfs.rename" : "vfs.copy", {
        source,
        destination,
        ...(name === "cp" ? { recursive, preserve } : {}),
      }),
    );
    if (mutation.result.ok) shadow = mutation.slice;
    else stderr.push(genericFailure(name, source, mutation.result));
  }
  return execution(EMPTY, stderr, stderr.length === 0 ? 0 : 1, events);
}

const MV: CommandDefinition = Object.freeze({
  name: "mv",
  execute(context: CommandContext) {
    const parsed = parse(context, []);
    if (isExecution(parsed)) return parsed;
    return transfer(context, "mv", parsed.operands, false, false);
  },
});

const CP: CommandDefinition = Object.freeze({
  name: "cp",
  execute(context: CommandContext) {
    const parsed = parse(context, [
      { key: "recursive", short: "r" },
      { key: "preserve", short: "p" },
    ]);
    if (isExecution(parsed)) return parsed;
    return transfer(
      context,
      "cp",
      parsed.operands,
      hasOption(parsed, "recursive"),
      hasOption(parsed, "preserve"),
    );
  },
});

const CHMOD: CommandDefinition = Object.freeze({
  name: "chmod",
  execute(context: CommandContext) {
    const parsed = parse(context, []);
    if (isExecution(parsed)) return parsed;
    const authoredMode = parsed.operands[0];
    const paths = parsed.operands.slice(1);
    if (authoredMode === undefined || paths.length === 0)
      return usage("chmod", "missing mode or file operand");
    if (!/^[0-7]{3,4}$/.test(authoredMode))
      return usage("chmod", `invalid mode: ${authoredMode}`);
    const mode = authoredMode.padStart(4, "0");
    return mutateMany(
      context,
      "chmod",
      paths,
      (slice, path) => chmodVfs(slice, path, mode),
      (path) => event("vfs.chmod", { path, mode }),
      "cannot access ",
    );
  },
});

const STAT: CommandDefinition = Object.freeze({
  name: "stat",
  execute(context: CommandContext) {
    const parsed = parse(context, []);
    if (isExecution(parsed)) return parsed;
    if (parsed.operands.length === 0) return usage("stat", "missing operand");
    const slice = readVfsSlice(context.state);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const events: EngineEvent[] = [];
    for (const path of parsed.operands) {
      const result = statVfs(slice, path);
      events.push(event("vfs.stat", { path }));
      if (!result.ok) {
        stderr.push(genericFailure("stat", path, result));
        continue;
      }
      const entry = result.value.entry;
      stdout.push(
        `  File: ${path}`,
        `  Size: ${String(size(entry))}  Type: ${entry.kind === "file" ? "regular file" : "directory"}`,
        `Device: vfs  Links: ${String(links(slice, result.value.path, entry))}`,
        `Access: (${entry.mode}/${permissions(entry)})  Uid: (${entry.owner})   Gid: (${entry.group})`,
        `Modify: ${entry.mtime}`,
      );
    }
    return execution(stdout, stderr, stderr.length === 0 ? 0 : 1, events);
  },
});

export const FILESYSTEM_COMMANDS: readonly CommandDefinition[] = Object.freeze([
  LS,
  CAT,
  CD,
  HEAD,
  TAIL,
  WC,
  GREP,
  FIND,
  MKDIR,
  TOUCH,
  RM,
  MV,
  CP,
  CHMOD,
  STAT,
]);
