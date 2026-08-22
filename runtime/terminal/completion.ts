import {
  BUILTIN_COMMAND_REGISTRY,
  compareVfsNames,
  listVfs,
  readVfsSlice,
  resolveVfsPath,
} from "../../engine/index.js";
import type { SessionState } from "../../engine/index.js";
import { SLASH_COMMAND_NAMES } from "../commands/slash.js";
import type { TerminalInputMode } from "./history.js";

export interface TerminalCompletion {
  readonly value: string;
  readonly cursor: number;
  readonly candidates: readonly string[];
}

interface ActiveToken {
  readonly start: number;
  readonly end: number;
  readonly raw: string;
  readonly command: boolean;
}

function commonPrefix(values: readonly string[]): string {
  const first = Array.from(values[0] ?? "");
  let length = first.length;
  for (const value of values.slice(1)) {
    const codePoints = Array.from(value);
    let shared = 0;
    while (
      shared < length &&
      shared < codePoints.length &&
      first[shared] === codePoints[shared]
    )
      shared += 1;
    length = shared;
  }
  return first.slice(0, length).join("");
}

function escapeShellToken(value: string): string {
  return value.replace(/[\\\s'"`$]/gu, (character) => `\\${character}`);
}

function decodeShellPrefix(value: string): string | null {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] as string;
    if (character === "'" || character === '"') return null;
    if (character === "\\") {
      index += 1;
      const escaped = value[index];
      if (escaped === undefined) return null;
      decoded += escaped;
    } else {
      decoded += character;
    }
  }
  return decoded;
}

function activeShellToken(
  mode: TerminalInputMode,
  value: string,
  cursor: number,
): ActiveToken | null {
  const shellStart = mode === "tui" ? (value.startsWith("!") ? 1 : -1) : 0;
  if (shellStart < 0 || cursor < shellStart) return null;
  let start = shellStart;
  for (let index = shellStart; index < cursor; index += 1) {
    const character = value[index];
    if (character === "\\") {
      index += 1;
    } else if (character === " " || character === "\t") {
      start = index + 1;
    }
  }
  let end = value.length;
  for (let index = cursor; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\") {
      index += 1;
    } else if (character === " " || character === "\t") {
      end = index;
      break;
    }
  }
  const preceding = value.slice(shellStart, start).trim();
  return {
    start,
    end,
    raw: value.slice(start, cursor),
    command: preceding === "",
  };
}

function replaceToken(
  value: string,
  token: ActiveToken,
  replacement: string,
  candidates: readonly string[],
): TerminalCompletion {
  const completed = `${value.slice(0, token.start)}${replacement}${value.slice(token.end)}`;
  return {
    value: completed,
    cursor: token.start + replacement.length,
    candidates,
  };
}

function completePath(
  state: SessionState,
  prefix: string,
): {
  readonly replacement: string;
  readonly candidates: readonly string[];
} | null {
  const vfs = readVfsSlice(state);
  const slash = prefix.lastIndexOf("/");
  const directorySpelling = slash < 0 ? "" : prefix.slice(0, slash + 1);
  const namePrefix = slash < 0 ? prefix : prefix.slice(slash + 1);
  const directoryInput = directorySpelling === "" ? "." : directorySpelling;
  const resolvedDirectory = resolveVfsPath(
    directoryInput,
    vfs.cwd,
    vfs.identity.home,
  ).path;
  const listed = listVfs(vfs, resolvedDirectory);
  if (!listed.ok) return null;

  const matches = listed.value
    .filter((item) => item.name.startsWith(namePrefix))
    .sort((left, right) => compareVfsNames(left.name, right.name));
  if (matches.length === 0) return null;
  const spellings = matches.map(
    (item) =>
      `${directorySpelling}${item.name}${item.entry.kind === "directory" ? "/" : ""}`,
  );
  const shared = commonPrefix(spellings);
  const unique = matches.length === 1;
  const replacement = escapeShellToken(
    unique ? (spellings[0] ?? shared) : shared,
  );
  return {
    replacement:
      unique && matches[0]?.entry.kind === "file"
        ? `${replacement} `
        : replacement,
    candidates: spellings,
  };
}

/** Complete the token at the caret without consulting the host shell or VFS. */
export function completeTerminalInput(
  mode: TerminalInputMode,
  value: string,
  cursor: number,
  state: SessionState,
): TerminalCompletion | null {
  if (mode === "tui" && value.startsWith("/")) {
    if (cursor !== value.length || /\s/u.test(value)) return null;
    const prefix = value.toLowerCase();
    const names = SLASH_COMMAND_NAMES.filter((name) => name.startsWith(prefix));
    if (names.length === 0) return null;
    const replacement =
      names.length === 1 ? (names[0] ?? value) : commonPrefix(names);
    return {
      value: replacement,
      cursor: replacement.length,
      candidates: names,
    };
  }

  const token = activeShellToken(mode, value, cursor);
  if (token === null) return null;
  const decoded = decodeShellPrefix(token.raw);
  if (decoded === null) return null;
  if (token.command) {
    const names = BUILTIN_COMMAND_REGISTRY.names.filter((name) =>
      name.startsWith(decoded),
    );
    if (names.length === 0) return null;
    const replacement =
      names.length === 1 ? `${names[0] ?? decoded} ` : commonPrefix(names);
    return replaceToken(value, token, replacement, names);
  }

  const completion = completePath(state, decoded);
  if (completion === null) return null;
  return replaceToken(
    value,
    token,
    completion.replacement,
    completion.candidates,
  );
}
