/** Pure simulated Git mechanics. Command-line rendering belongs to issue #10. */

import type {
  CartridgeGitCommit,
  LoadedCartridge,
} from "../cartridge/types.js";
import { deepFreeze } from "../freeze.js";
import { hashString } from "../random/seed.js";
import { serializeInline } from "../serialize/canonical.js";
import { replaceVfsFiles } from "../vfs/vfs.js";
import { isAtOrBelow, isDescendant } from "../vfs/path.js";
import type { VfsFileEntry, VfsSlice } from "../vfs/types.js";
import type {
  GitBlameLine,
  GitChange,
  GitCheckoutMutation,
  GitCommit,
  GitDiffComparison,
  GitDiffFile,
  GitDiffLine,
  GitFailure,
  GitFileSnapshot,
  GitHead,
  GitMutation,
  GitRestoreMutation,
  GitResult,
  GitSlice,
  GitStatusEntry,
  GitShowValue,
} from "./types.js";
import { GIT_BRANCH_PATTERN } from "../cartridge/schema.js";
import { parseTimestamp } from "../clock/civil.js";

function success<T>(value: T): GitResult<T> {
  return deepFreeze({ ok: true, value } as const);
}

function failure(code: GitFailure["code"], message: string): GitFailure {
  return Object.freeze({ ok: false, code, message });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function field<T, K extends keyof T>(value: T, key: K): T[K] {
  return value[key];
}

function ownValue<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Forty stable hexadecimal digits, without host crypto or random identity. */
function contentHash(material: string): string {
  let out = "";
  for (let lane = 0; lane < 5; lane += 1) {
    out += hashString(`git-commit-v0\u001f${String(lane)}\u001f${material}`)
      .toString(16)
      .padStart(8, "0");
  }
  return out;
}

function commitHash(
  parents: readonly string[],
  author: GitCommit["author"],
  message: string,
  committedAt: string,
  files: Readonly<Record<string, string>>,
): string {
  return contentHash(
    serializeInline({ parents, author, message, committedAt, files }),
  );
}

function hashCommit(
  commit: CartridgeGitCommit,
  byId: ReadonlyMap<string, CartridgeGitCommit>,
  hashes: Map<string, string>,
): string {
  const authoredMessage = field(commit, "message");
  const cached = hashes.get(commit.id);
  if (cached !== undefined) return cached;
  const parents = commit.parents.map((id) =>
    hashCommit(byId.get(id) as CartridgeGitCommit, byId, hashes),
  );
  const files = Object.fromEntries(
    Object.entries(commit.files)
      .sort(([left], [right]) => compareText(left, right))
      .map(([path, file]) => [path, file.contents]),
  );
  const hash = commitHash(
    parents,
    commit.author,
    authoredMessage,
    commit.committedAt,
    files,
  );
  hashes.set(commit.id, hash);
  return hash;
}

function headHash(slice: GitSlice): string | undefined {
  return slice.head.kind === "branch"
    ? ownValue(slice.branches, slice.head.target)
    : slice.head.target || undefined;
}

function headTree(slice: GitSlice): Readonly<Record<string, string>> {
  const hash = headHash(slice);
  const files =
    hash === undefined || !Object.hasOwn(slice.commits, hash)
      ? undefined
      : ownValue(slice.commits, hash)?.files;
  return files === undefined
    ? {}
    : Object.fromEntries(
        Object.entries(files).map(([path, file]) => [path, file.contents]),
      );
}

export function createGitSlice(cartridge: LoadedCartridge): GitSlice {
  const authored = cartridge.repository.gitHistory;
  const byId = new Map(authored.commits.map((commit) => [commit.id, commit]));
  const hashes = new Map<string, string>();
  for (const commit of authored.commits) hashCommit(commit, byId, hashes);

  const commits = Object.fromEntries(
    authored.commits
      .map((commit): readonly [string, GitCommit] => {
        const authoredMessage = field(commit, "message");
        const hash = hashes.get(commit.id) as string;
        return [
          hash,
          {
            id: commit.id,
            hash,
            parents: commit.parents.map((id) => hashes.get(id) as string),
            author: { ...commit.author },
            message: authoredMessage,
            committedAt: commit.committedAt,
            files: Object.fromEntries(
              Object.entries(commit.files).map(([path, file]) => [
                path,
                {
                  contents: file.contents,
                  blame: file.blame.map((id) => hashes.get(id) as string),
                },
              ]),
            ),
          },
        ];
      })
      .sort(([left], [right]) => compareText(left, right)),
  );
  const branches = Object.fromEntries(
    Object.entries(authored.branches)
      .map(([name, id]): readonly [string, string] => [
        name,
        hashes.get(id) as string,
      ])
      .sort(([left], [right]) => compareText(left, right)),
  );
  const head: GitHead =
    authored.head.kind === "branch"
      ? { ...authored.head }
      : {
          kind: "detached",
          target:
            authored.head.target === ""
              ? ""
              : (hashes.get(authored.head.target) as string),
        };
  const currentHash =
    head.kind === "branch" ? branches[head.target] : head.target || undefined;
  const current = currentHash === undefined ? undefined : commits[currentHash];
  const index = Object.fromEntries(
    Object.entries(current?.files ?? {}).map(([path, file]) => [
      path,
      file.contents,
    ]),
  );
  return deepFreeze({
    root: cartridge.repository.cwd,
    identity: { ...cartridge.repository.gitIdentity },
    commits,
    branches,
    head,
    index,
  });
}

export function currentGitHash(slice: GitSlice): string | undefined {
  return headHash(slice);
}

export function resolveGitRef(slice: GitSlice, ref: string): GitResult<string> {
  if (ref === "HEAD") {
    const hash = headHash(slice);
    return hash === undefined
      ? failure("NOT_FOUND", "HEAD does not name a commit")
      : success(hash);
  }
  const branch = ownValue(slice.branches, ref);
  if (branch !== undefined) return success(branch);
  if (Object.hasOwn(slice.commits, ref)) return success(ref);
  if (/^[0-9a-f]{4,39}$/.test(ref)) {
    const matches = Object.keys(slice.commits).filter((hash) =>
      hash.startsWith(ref),
    );
    if (matches.length === 1) return success(matches[0] as string);
    if (matches.length > 1)
      return failure(
        "INVALID",
        `short object ID ${JSON.stringify(ref)} is ambiguous`,
      );
  }
  return failure("NOT_FOUND", `unknown revision ${JSON.stringify(ref)}`);
}

export function abbreviateGitHash(slice: GitSlice, hash: string): string {
  let length = 7;
  const hashes = Object.keys(slice.commits);
  while (
    length < hash.length &&
    hashes.some(
      (candidate) =>
        candidate !== hash &&
        candidate.slice(0, length) === hash.slice(0, length),
    )
  )
    length += 1;
  return hash.slice(0, length);
}

function reachable(slice: GitSlice, start: string): ReadonlySet<string> {
  const found = new Set<string>();
  const pending = [start];
  while (pending.length > 0) {
    const hash = pending.pop();
    if (hash === undefined || found.has(hash)) continue;
    found.add(hash);
    if (Object.hasOwn(slice.commits, hash))
      pending.push(...(ownValue(slice.commits, hash)?.parents ?? []));
  }
  return found;
}

/**
 * Topological log order: every child precedes every parent. Among currently
 * eligible commits, newer authored timestamps sort first, then hash ascending.
 */
export function logGit(
  slice: GitSlice,
  from = headHash(slice),
): readonly GitCommit[] {
  if (from === undefined || !Object.hasOwn(slice.commits, from)) return [];
  const remaining = new Set(reachable(slice, from));
  const out: GitCommit[] = [];
  while (remaining.size > 0) {
    const eligible = [...remaining]
      .filter((hash) =>
        [...remaining].every(
          (candidate) =>
            !Object.hasOwn(slice.commits, candidate) ||
            !ownValue(slice.commits, candidate)?.parents.includes(hash),
        ),
      )
      .map((hash) => ownValue(slice.commits, hash) as GitCommit)
      .sort(
        (left, right) =>
          compareText(right.committedAt, left.committedAt) ||
          compareText(left.hash, right.hash),
      );
    const next = eligible[0];
    if (next === undefined) break;
    remaining.delete(next.hash);
    out.push(next);
  }
  return deepFreeze(out);
}

function logicalLines(contents: string): readonly string[] {
  if (contents === "") return [];
  const lines = contents.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function blameGit(
  slice: GitSlice,
  path: string,
  at = headHash(slice),
): GitResult<readonly GitBlameLine[]> {
  const commit =
    at === undefined || !Object.hasOwn(slice.commits, at)
      ? undefined
      : ownValue(slice.commits, at);
  if (commit === undefined)
    return failure("NOT_FOUND", `cannot blame without an existing commit`);
  const file = ownValue(commit.files, path);
  if (file === undefined)
    return failure(
      "NOT_FOUND",
      `${JSON.stringify(path)} is not tracked at ${at}`,
    );
  const lines = logicalLines(file.contents).map((text, index) => {
    const hash = file.blame[index] as string;
    const source = Object.hasOwn(slice.commits, hash)
      ? ownValue(slice.commits, hash)
      : undefined;
    if (source === undefined)
      throw new Error(`Git blame source ${JSON.stringify(hash)} is missing`);
    return {
      line: index + 1,
      text,
      hash,
      author: source.author,
      committedAt: source.committedAt,
    };
  });
  return success(lines);
}

function workingTree(slice: GitSlice, vfs: VfsSlice): Record<string, string> {
  return Object.fromEntries(
    Object.entries(vfs.entries)
      .filter(
        ([path, entry]) =>
          entry.kind === "file" && isAtOrBelow(path, slice.root),
      )
      .map(([path, entry]) => [path, (entry as VfsFileEntry).contents]),
  );
}

function change(
  before: string | undefined,
  after: string | undefined,
): GitChange | null {
  if (before === after) return null;
  if (before === undefined) return "added";
  if (after === undefined) return "deleted";
  return "modified";
}

export function statusGit(
  slice: GitSlice,
  vfs: VfsSlice,
): readonly GitStatusEntry[] {
  const head = headTree(slice);
  const working = workingTree(slice, vfs);
  const paths = new Set([
    ...Object.keys(head),
    ...Object.keys(slice.index),
    ...Object.keys(working),
  ]);
  const out: GitStatusEntry[] = [];
  for (const path of [...paths].sort()) {
    const untracked =
      !Object.hasOwn(slice.index, path) && Object.hasOwn(working, path);
    const staged = change(ownValue(head, path), ownValue(slice.index, path));
    const unstaged = untracked
      ? null
      : change(ownValue(slice.index, path), ownValue(working, path));
    if (untracked || staged !== null || unstaged !== null)
      out.push({ path, staged, working: unstaged, untracked });
  }
  return deepFreeze(out);
}

function lineDiff(
  oldContents: string,
  newContents: string,
): readonly GitDiffLine[] {
  const oldLines = logicalLines(oldContents);
  const newLines = logicalLines(newContents);
  // A terminal newline is byte-significant even though logicalLines omits it.
  // Without this special case, the LCS treats a final-newline-only edit as
  // context and renderDiff cannot express the change as a unified patch.
  if (
    oldContents !== newContents &&
    oldLines.length > 0 &&
    oldLines.length === newLines.length &&
    oldLines.every((line, index) => line === newLines[index])
  )
    return oldLines.flatMap((text) => [
      { kind: "deletion" as const, text },
      { kind: "addition" as const, text },
    ]);
  const rows = oldLines.length + 1;
  const columns = newLines.length + 1;
  const lengths = Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => 0),
  );
  for (let left = oldLines.length - 1; left >= 0; left -= 1) {
    for (let right = newLines.length - 1; right >= 0; right -= 1) {
      lengths[left]![right] =
        oldLines[left] === newLines[right]
          ? 1 + (lengths[left + 1]?.[right + 1] ?? 0)
          : Math.max(
              lengths[left + 1]?.[right] ?? 0,
              lengths[left]?.[right + 1] ?? 0,
            );
    }
  }
  const out: GitDiffLine[] = [];
  let left = 0;
  let right = 0;
  while (left < oldLines.length || right < newLines.length) {
    if (oldLines[left] === newLines[right] && left < oldLines.length) {
      out.push({ kind: "context", text: oldLines[left] as string });
      left += 1;
      right += 1;
    } else if (
      right >= newLines.length ||
      (left < oldLines.length &&
        (lengths[left + 1]?.[right] ?? 0) >= (lengths[left]?.[right + 1] ?? 0))
    ) {
      out.push({ kind: "deletion", text: oldLines[left] as string });
      left += 1;
    } else {
      out.push({ kind: "addition", text: newLines[right] as string });
      right += 1;
    }
  }
  return out;
}

export function diffGit(
  slice: GitSlice,
  vfs: VfsSlice,
  comparison: GitDiffComparison,
): readonly GitDiffFile[] {
  const head = headTree(slice);
  const working = workingTree(slice, vfs);
  const [before, after] =
    comparison === "working-index"
      ? [slice.index, working]
      : comparison === "index-head"
        ? [head, slice.index]
        : [head, working];
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return deepFreeze(
    [...paths]
      .sort()
      .filter((path) => ownValue(before, path) !== ownValue(after, path))
      .map((path) => ({
        path,
        oldContents: ownValue(before, path) ?? null,
        newContents: ownValue(after, path) ?? null,
        lines: lineDiff(
          ownValue(before, path) ?? "",
          ownValue(after, path) ?? "",
        ),
      })),
  );
}

export function showGit(
  slice: GitSlice,
  ref = "HEAD",
): GitResult<GitShowValue> {
  const resolved = resolveGitRef(slice, ref);
  if (!resolved.ok) return resolved;
  const commit = ownValue(slice.commits, resolved.value) as GitCommit;
  const parentHash = commit.parents[0];
  const before =
    parentHash === undefined
      ? {}
      : headTree({ ...slice, head: { kind: "detached", target: parentHash } });
  const after = Object.fromEntries(
    Object.entries(commit.files).map(([path, file]) => [path, file.contents]),
  );
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  const files = [...paths]
    .sort()
    .filter((path) => ownValue(before, path) !== ownValue(after, path))
    .map((path) => ({
      path,
      oldContents: ownValue(before, path) ?? null,
      newContents: ownValue(after, path) ?? null,
      lines: lineDiff(
        ownValue(before, path) ?? "",
        ownValue(after, path) ?? "",
      ),
    }));
  return success({ commit, files });
}

export function stageGit(
  slice: GitSlice,
  vfs: VfsSlice,
  paths: readonly string[],
): GitMutation<{ readonly paths: readonly string[] }> {
  const working = workingTree(slice, vfs);
  const index = { ...slice.index } as Record<string, string>;
  const staged = [...new Set(paths)].sort();
  for (const path of staged) {
    if (!Object.hasOwn(slice.index, path) && working[path] === undefined)
      return {
        slice,
        result: failure(
          "NOT_FOUND",
          `${JSON.stringify(path)} is absent and untracked`,
        ),
      };
    const contents = ownValue(working, path);
    if (contents === undefined) delete index[path];
    else index[path] = contents;
  }
  return deepFreeze({
    slice: { ...slice, index },
    result: success({ paths: staged }),
  });
}

/** Exact changed paths at or below cwd; path segments, never string prefixes. */
export function gitAddCwdPaths(
  slice: GitSlice,
  vfs: VfsSlice,
  cwd: string,
): readonly string[] {
  return deepFreeze(
    statusGit(slice, vfs)
      .map((entry) => entry.path)
      .filter((path) => path === cwd || isDescendant(path, cwd)),
  );
}

export function branchGit(
  slice: GitSlice,
  name: string,
): GitMutation<{ readonly name: string; readonly hash: string }> {
  if (!GIT_BRANCH_PATTERN.test(name))
    return {
      slice,
      result: failure("INVALID", `invalid branch name ${JSON.stringify(name)}`),
    };
  if (Object.hasOwn(slice.branches, name))
    return {
      slice,
      result: failure(
        "INVALID",
        `branch ${JSON.stringify(name)} already exists`,
      ),
    };
  const hash = headHash(slice);
  if (hash === undefined)
    return {
      slice,
      result: failure("INVALID", "cannot create a branch without a commit"),
    };
  return deepFreeze({
    slice: { ...slice, branches: { ...slice.branches, [name]: hash } },
    result: success({ name, hash }),
  });
}

function inheritedLineSources(
  parent: GitFileSnapshot | undefined,
  contents: string,
  createdBy: string,
): readonly string[] {
  const before = logicalLines(parent?.contents ?? "");
  const after = logicalLines(contents);
  const rows = before.length + 1;
  const columns = after.length + 1;
  const lengths = Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => 0),
  );
  for (let left = before.length - 1; left >= 0; left -= 1)
    for (let right = after.length - 1; right >= 0; right -= 1)
      lengths[left]![right] =
        before[left] === after[right]
          ? 1 + (lengths[left + 1]?.[right + 1] ?? 0)
          : Math.max(
              lengths[left + 1]?.[right] ?? 0,
              lengths[left]?.[right + 1] ?? 0,
            );
  const sources = after.map(() => createdBy);
  let left = 0;
  let right = 0;
  while (left < before.length && right < after.length) {
    if (before[left] === after[right]) {
      sources[right] = parent?.blame[left] ?? createdBy;
      left += 1;
      right += 1;
    } else if (
      (lengths[left + 1]?.[right] ?? 0) >= (lengths[left]?.[right + 1] ?? 0)
    )
      left += 1;
    else right += 1;
  }
  return sources;
}

export function commitGit(
  slice: GitSlice,
  message: string,
  committedAt: string,
): GitMutation<GitCommit> {
  if (message.trim() === "")
    return { slice, result: failure("INVALID", "empty commit message") };
  try {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(committedAt))
      throw new Error("noncanonical timestamp");
    parseTimestamp(committedAt);
  } catch {
    return { slice, result: failure("INVALID", "invalid commit timestamp") };
  }
  const parentHash = headHash(slice);
  const parent =
    parentHash === undefined || !Object.hasOwn(slice.commits, parentHash)
      ? undefined
      : ownValue(slice.commits, parentHash);
  const parentTree = Object.fromEntries(
    Object.entries(parent?.files ?? {}).map(([path, file]) => [
      path,
      file.contents,
    ]),
  );
  if (serializeInline(parentTree) === serializeInline(slice.index))
    return {
      slice,
      result: failure("INVALID", "nothing to commit, working tree clean"),
    };
  const parents = parentHash === undefined ? [] : [parentHash];
  const hash = commitHash(
    parents,
    slice.identity,
    message,
    committedAt,
    slice.index,
  );
  const files = Object.fromEntries(
    Object.entries(slice.index)
      .sort(([left], [right]) => compareText(left, right))
      .map(([path, contents]) => [
        path,
        {
          contents,
          blame: inheritedLineSources(
            parent !== undefined && Object.hasOwn(parent.files, path)
              ? ownValue(parent.files, path)
              : undefined,
            contents,
            hash,
          ),
        },
      ]),
  );
  const commit: GitCommit = {
    id: hash,
    hash,
    parents,
    author: { ...slice.identity },
    message,
    committedAt,
    files,
  };
  const head: GitHead =
    slice.head.kind === "branch"
      ? slice.head
      : { kind: "detached", target: hash };
  const branches =
    slice.head.kind === "branch"
      ? { ...slice.branches, [slice.head.target]: hash }
      : slice.branches;
  return deepFreeze({
    slice: {
      ...slice,
      commits: { ...slice.commits, [hash]: commit },
      branches,
      head,
    },
    result: success(commit),
  });
}

export function restoreGit(
  slice: GitSlice,
  path: string,
  staged: boolean,
): GitRestoreMutation {
  const head = headTree(slice);
  if (staged) {
    if (!Object.hasOwn(head, path) && !Object.hasOwn(slice.index, path))
      return {
        slice,
        plan: null,
        result: failure(
          "NOT_FOUND",
          `${JSON.stringify(path)} did not match any file known to git`,
        ),
      };
    const index = { ...slice.index } as Record<string, string>;
    const contents = ownValue(head, path);
    if (contents === undefined) delete index[path];
    else index[path] = contents;
    return deepFreeze({
      slice: { ...slice, index },
      plan: null,
      result: success({ path }),
    });
  }
  if (!Object.hasOwn(slice.index, path) && !Object.hasOwn(head, path))
    return {
      slice,
      plan: null,
      result: failure(
        "NOT_FOUND",
        `${JSON.stringify(path)} did not match any file known to git`,
      ),
    };
  const indexed = ownValue(slice.index, path);
  return deepFreeze({
    slice,
    plan: {
      tracked: [path],
      target: indexed === undefined ? {} : { [path]: indexed },
    },
    result: success({ path }),
  });
}

/**
 * Checkout refuses any staged, modified, deleted, or untracked repository file.
 * This intentionally strict policy makes "dirty" one deterministic predicate;
 * no caller can accidentally overwrite an untracked comedy artifact.
 */
export function checkoutGit(
  slice: GitSlice,
  vfs: VfsSlice,
  target: string,
  now: string,
): GitCheckoutMutation {
  const dirty = statusGit(slice, vfs);
  if (dirty.length > 0)
    return Object.freeze({
      git: slice,
      vfs,
      result: failure(
        "DIRTY",
        `checkout refused: ${String(dirty.length)} staged, working, or untracked path(s)`,
      ),
    });
  const branchHash = ownValue(slice.branches, target);
  const resolved = resolveGitRef(slice, target);
  if (!resolved.ok)
    return Object.freeze({
      git: slice,
      vfs,
      result: resolved,
    });
  const hash = resolved.value;
  const commit = ownValue(slice.commits, hash) as GitCommit;
  const replacement = replaceVfsFiles(
    vfs,
    Object.keys(slice.index),
    Object.fromEntries(
      Object.entries(commit.files).map(([path, file]) => [path, file.contents]),
    ),
    now,
  );
  if (!replacement.result.ok)
    return Object.freeze({
      git: slice,
      vfs,
      result: failure(
        "VFS",
        `checkout VFS transition failed with ${replacement.result.code} at ${JSON.stringify(replacement.result.path)}`,
      ),
    });
  const head: GitHead =
    target === "HEAD"
      ? slice.head
      : branchHash === undefined
        ? { kind: "detached", target: hash }
        : { kind: "branch", target };
  const git = deepFreeze({
    ...slice,
    head,
    index: Object.fromEntries(
      Object.entries(commit.files).map(([path, file]) => [path, file.contents]),
    ),
  });
  return deepFreeze({
    git,
    vfs: replacement.slice,
    result: success({ head, hash }),
  });
}
