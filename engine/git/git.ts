/** Pure simulated Git mechanics. Command-line rendering belongs to issue #10. */

import type {
  CartridgeGitCommit,
  LoadedCartridge,
} from "../cartridge/types.js";
import { deepFreeze } from "../freeze.js";
import { hashString } from "../random/seed.js";
import { serializeInline } from "../serialize/canonical.js";
import { replaceVfsFiles } from "../vfs/vfs.js";
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
  GitHead,
  GitMutation,
  GitResult,
  GitSlice,
  GitStatusEntry,
} from "./types.js";

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
  const hash = contentHash(
    serializeInline({
      parents,
      author: commit.author,
      message: authoredMessage,
      committedAt: commit.committedAt,
      files,
    }),
  );
  hashes.set(commit.id, hash);
  return hash;
}

function headHash(slice: GitSlice): string | undefined {
  return slice.head.kind === "branch"
    ? slice.branches[slice.head.target]
    : slice.head.target || undefined;
}

function headTree(slice: GitSlice): Readonly<Record<string, string>> {
  const hash = headHash(slice);
  const files = hash === undefined ? undefined : slice.commits[hash]?.files;
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
    commits,
    branches,
    head,
    index,
  });
}

function reachable(slice: GitSlice, start: string): ReadonlySet<string> {
  const found = new Set<string>();
  const pending = [start];
  while (pending.length > 0) {
    const hash = pending.pop();
    if (hash === undefined || found.has(hash)) continue;
    found.add(hash);
    pending.push(...(slice.commits[hash]?.parents ?? []));
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
  if (from === undefined || slice.commits[from] === undefined) return [];
  const remaining = new Set(reachable(slice, from));
  const out: GitCommit[] = [];
  while (remaining.size > 0) {
    const eligible = [...remaining]
      .filter((hash) =>
        [...remaining].every(
          (candidate) => !slice.commits[candidate]?.parents.includes(hash),
        ),
      )
      .map((hash) => slice.commits[hash] as GitCommit)
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
  const commit = at === undefined ? undefined : slice.commits[at];
  if (commit === undefined)
    return failure("NOT_FOUND", `cannot blame without an existing commit`);
  const file = commit.files[path];
  if (file === undefined)
    return failure(
      "NOT_FOUND",
      `${JSON.stringify(path)} is not tracked at ${at}`,
    );
  const lines = logicalLines(file.contents).map((text, index) => {
    const hash = file.blame[index] as string;
    const source = slice.commits[hash] as GitCommit;
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
  const prefix = slice.root === "/" ? "/" : `${slice.root}/`;
  return Object.fromEntries(
    Object.entries(vfs.entries)
      .filter(
        ([path, entry]) =>
          entry.kind === "file" &&
          (path === slice.root || path.startsWith(prefix)),
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
      slice.index[path] === undefined && working[path] !== undefined;
    const staged = change(head[path], slice.index[path]);
    const unstaged = untracked
      ? null
      : change(slice.index[path], working[path]);
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
      .filter((path) => before[path] !== after[path])
      .map((path) => ({
        path,
        oldContents: before[path] ?? null,
        newContents: after[path] ?? null,
        lines: lineDiff(before[path] ?? "", after[path] ?? ""),
      })),
  );
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
    const contents = working[path];
    if (contents === undefined) delete index[path];
    else index[path] = contents;
  }
  return deepFreeze({
    slice: { ...slice, index },
    result: success({ paths: staged }),
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
  const branchHash = slice.branches[target];
  const hash =
    branchHash ?? (slice.commits[target] === undefined ? undefined : target);
  if (hash === undefined)
    return Object.freeze({
      git: slice,
      vfs,
      result: failure(
        "NOT_FOUND",
        `checkout target ${JSON.stringify(target)} does not exist`,
      ),
    });
  const commit = slice.commits[hash] as GitCommit;
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
    branchHash === undefined
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
