/** Git event registration, including atomic checkout through a VFS-owned effect. */

import {
  ABSOLUTE_PATH_PATTERN,
  GIT_BRANCH_PATTERN,
  GIT_EMAIL_PATTERN,
  SINGLE_LINE_PATTERN,
} from "../cartridge/schema.js";
import { defineEventModule } from "../events/module.js";
import type { EventContext } from "../events/module.js";
import { readString, requirePayload } from "../events/payload.js";
import type { EventPayload } from "../events/payload.js";
import { readSlice } from "../events/state.js";
import type { SessionState } from "../events/state.js";
import { serializeInline } from "../serialize/canonical.js";
import { readVfsSlice } from "../vfs/module.js";
import { isAtOrBelow } from "../vfs/path.js";
import {
  blameGit,
  branchGit,
  checkoutGit,
  commitGit,
  createGitSlice,
  diffGit,
  logGit,
  restoreGit,
  showGit,
  stageGit,
  statusGit,
} from "./git.js";
import type { GitDiffComparison, GitSlice } from "./types.js";

function record(
  value: unknown,
  where: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${where}: must be an object`);
  return value as Readonly<Record<string, unknown>>;
}

function fields(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  where: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0)
    throw new Error(
      `${where}: unexpected field(s) ${unknown.sort().join(", ")}`,
    );
}

function logicalLines(contents: string): readonly string[] {
  if (contents === "") return [];
  const lines = contents.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function stringField(
  value: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): string {
  const field = value[key];
  if (typeof field !== "string")
    throw new Error(`${where}.${key}: must be a string`);
  return field;
}

function stringRecord(
  value: unknown,
  where: string,
): Readonly<Record<string, string>> {
  const raw = record(value, where);
  for (const [key, item] of Object.entries(raw))
    if (typeof item !== "string")
      throw new Error(`${where}[${JSON.stringify(key)}]: must be a string`);
  return raw as Readonly<Record<string, string>>;
}

function stringArray(value: unknown, where: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${where}: must be an array`);
  return value.map((item, index) => {
    if (typeof item !== "string")
      throw new Error(`${where}[${String(index)}]: must be a string`);
    return item;
  });
}

const HASH_PATTERN = /^[0-9a-f]{40}$/;

/** Validate snapshots without normalization; malformed Git state never resumes. */
export function validateGitSlice(slice: unknown, where: string): GitSlice {
  const root = record(slice, where);
  const allowed = ["root", "identity", "commits", "branches", "head", "index"];
  const unknown = Object.keys(root).filter((key) => !allowed.includes(key));
  if (unknown.length > 0)
    throw new Error(
      `${where}: unexpected field(s) ${unknown.sort().join(", ")}`,
    );
  const repositoryRoot = stringField(root, "root", where);
  if (!ABSOLUTE_PATH_PATTERN.test(repositoryRoot))
    throw new Error(`${where}.root: must be an absolute POSIX path`);
  const identity = record(root["identity"], `${where}.identity`);
  fields(identity, ["name", "email"], `${where}.identity`);
  const identityName = stringField(identity, "name", `${where}.identity`);
  const identityEmail = stringField(identity, "email", `${where}.identity`);
  if (identityName === "" || !SINGLE_LINE_PATTERN.test(identityName))
    throw new Error(
      `${where}.identity.name: must be a non-empty single-line string`,
    );
  if (!GIT_EMAIL_PATTERN.test(identityEmail))
    throw new Error(`${where}.identity.email: must be an email address`);
  const commits = record(root["commits"], `${where}.commits`);
  for (const hash of Object.keys(commits).sort()) {
    if (!HASH_PATTERN.test(hash))
      throw new Error(
        `${where}.commits key ${JSON.stringify(hash)}: must be a 40-digit hash`,
      );
    const commitWhere = `${where}.commits[${JSON.stringify(hash)}]`;
    const commit = record(commits[hash], commitWhere);
    fields(
      commit,
      ["id", "hash", "parents", "author", "message", "committedAt", "files"],
      commitWhere,
    );
    if (stringField(commit, "hash", commitWhere) !== hash)
      throw new Error(`${commitWhere}.hash: must equal its record key`);
    stringField(commit, "id", commitWhere);
    stringField(commit, "message", commitWhere);
    stringField(commit, "committedAt", commitWhere);
    const author = record(commit["author"], `${commitWhere}.author`);
    fields(author, ["name", "email"], `${commitWhere}.author`);
    stringField(author, "name", `${commitWhere}.author`);
    stringField(author, "email", `${commitWhere}.author`);
    for (const parent of stringArray(
      commit["parents"],
      `${commitWhere}.parents`,
    ))
      if (!Object.hasOwn(commits, parent))
        throw new Error(`${commitWhere}.parents: missing commit ${parent}`);
    const files = record(commit["files"], `${commitWhere}.files`);
    for (const path of Object.keys(files)) {
      if (
        !ABSOLUTE_PATH_PATTERN.test(path) ||
        !isAtOrBelow(path, repositoryRoot)
      )
        throw new Error(
          `${commitWhere}.files: path ${JSON.stringify(path)} must be at or below repository root ${JSON.stringify(repositoryRoot)}`,
        );
      const file = record(
        files[path],
        `${commitWhere}.files[${JSON.stringify(path)}]`,
      );
      fields(
        file,
        ["contents", "blame"],
        `${commitWhere}.files[${JSON.stringify(path)}]`,
      );
      const contents = stringField(
        file,
        "contents",
        `${commitWhere}.files[${JSON.stringify(path)}]`,
      );
      const blame = stringArray(
        file["blame"],
        `${commitWhere}.files[${JSON.stringify(path)}].blame`,
      );
      const lineCount = logicalLines(contents).length;
      if (blame.length !== lineCount)
        throw new Error(
          `${commitWhere}.files[${JSON.stringify(path)}].blame: must contain one commit hash per logical line (${String(lineCount)}), got ${String(blame.length)}`,
        );
      for (const source of blame)
        if (!Object.hasOwn(commits, source))
          throw new Error(
            `${commitWhere}.files: blame references missing commit ${source}`,
          );
    }
  }
  const branches = stringRecord(root["branches"], `${where}.branches`);
  for (const [name, hash] of Object.entries(branches)) {
    if (!GIT_BRANCH_PATTERN.test(name))
      throw new Error(
        `${where}.branches: invalid branch ${JSON.stringify(name)}`,
      );
    if (!Object.hasOwn(commits, hash))
      throw new Error(`${where}.branches.${name}: missing commit ${hash}`);
  }
  const head = record(root["head"], `${where}.head`);
  fields(head, ["kind", "target"], `${where}.head`);
  const kind = stringField(head, "kind", `${where}.head`);
  const target = stringField(head, "target", `${where}.head`);
  if (kind !== "branch" && kind !== "detached")
    throw new Error(`${where}.head.kind: must be branch or detached`);
  if (kind === "branch" && !Object.hasOwn(branches, target))
    throw new Error(`${where}.head.target: missing branch ${target}`);
  if (kind === "detached" && target !== "" && !Object.hasOwn(commits, target))
    throw new Error(`${where}.head.target: missing commit ${target}`);
  const index = stringRecord(root["index"], `${where}.index`);
  for (const path of Object.keys(index))
    if (!ABSOLUTE_PATH_PATTERN.test(path) || !isAtOrBelow(path, repositoryRoot))
      throw new Error(
        `${where}.index: path ${JSON.stringify(path)} must be at or below repository root ${JSON.stringify(repositoryRoot)}`,
      );

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (hash: string): void => {
    if (visited.has(hash)) return;
    if (visiting.has(hash))
      throw new Error(`${where}.commits: ancestry cycle at ${hash}`);
    visiting.add(hash);
    const commit = commits[hash] as Readonly<Record<string, unknown>>;
    for (const parent of commit["parents"] as readonly string[]) visit(parent);
    visiting.delete(hash);
    visited.add(hash);
  };
  for (const hash of Object.keys(commits)) visit(hash);
  return slice as GitSlice;
}

export function readGitSlice(state: SessionState): GitSlice {
  return validateGitSlice(readSlice(state, "git"), "session state: slices.git");
}

function payload(
  context: EventContext,
  fields: readonly string[],
): EventPayload {
  const data = requirePayload(context);
  const unknown = Object.keys(data).filter((key) => !fields.includes(key));
  if (unknown.length > 0)
    throw new Error(
      `${context.where}: unexpected payload field(s) ${unknown.sort().join(", ")}`,
    );
  return data;
}

function comparison(value: string, where: string): GitDiffComparison {
  if (
    value === "working-index" ||
    value === "index-head" ||
    value === "working-head"
  )
    return value;
  throw new Error(
    `${where}: comparison must be working-index, index-head, or working-head`,
  );
}

export const GIT_MODULE = defineEventModule<GitSlice>({
  namespace: "git",
  description:
    "Deterministic commits, refs, index, status, blame, diff, and checkout.",
  initialSlice: (context) => createGitSlice(context.cartridge),
  validateSlice: validateGitSlice,
  events: {
    "git.status": {
      version: 0,
      apply(context, slice) {
        payload(context, []);
        const entries = statusGit(slice, readVfsSlice(context.state));
        return {
          summary: `paths=${String(entries.length)}`,
          detail: entries.map((entry) => serializeInline(entry)),
        };
      },
    },
    "git.diff": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["comparison"]);
        const selected = comparison(
          readString(data, "comparison", context.where),
          context.where,
        );
        const files = diffGit(slice, readVfsSlice(context.state), selected);
        return {
          summary: `comparison=${selected} files=${String(files.length)}`,
          detail: files.map((file) => serializeInline(file)),
        };
      },
    },
    "git.log": {
      version: 0,
      apply(context, slice) {
        payload(context, []);
        const commits = logGit(slice);
        return {
          summary: `commits=${String(commits.length)}`,
          detail: commits.map((commit) => commit.hash),
        };
      },
    },
    "git.branches": {
      version: 0,
      apply(context, slice) {
        payload(context, []);
        return {
          summary: `branches=${String(Object.keys(slice.branches).length)}`,
          detail: Object.keys(slice.branches).sort(),
        };
      },
    },
    "git.show": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["ref"]);
        const ref = readString(data, "ref", context.where);
        const shown = showGit(slice, ref === "HEAD" ? undefined : ref);
        return shown.ok
          ? {
              summary: `hash=${shown.value.commit.hash} files=${String(shown.value.files.length)}`,
            }
          : { summary: `failed code=${shown.code}` };
      },
    },
    "git.blame": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["path"]);
        const result = blameGit(slice, readString(data, "path", context.where));
        return result.ok
          ? {
              summary: `lines=${String(result.value.length)}`,
              detail: result.value.map((line) => serializeInline(line)),
            }
          : { summary: `failed code=${result.code}` };
      },
    },
    "git.stage": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["paths"]);
        const mutation = stageGit(
          slice,
          readVfsSlice(context.state),
          stringArray(data["paths"], `${context.where}.paths`),
        );
        return mutation.result.ok
          ? {
              slice: mutation.slice,
              summary: `paths=${String(mutation.result.value.paths.length)}`,
            }
          : { summary: `failed code=${mutation.result.code}` };
      },
    },
    "git.branch": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["name"]);
        const name = readString(data, "name", context.where);
        if (!GIT_BRANCH_PATTERN.test(name))
          throw new Error(`${context.where}: invalid branch name`);
        const mutation = branchGit(slice, name);
        return mutation.result.ok
          ? {
              slice: mutation.slice,
              summary: `created=${name} hash=${mutation.result.value.hash}`,
            }
          : { summary: `failed code=${mutation.result.code}` };
      },
    },
    "git.commit": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["text"]);
        const mutation = commitGit(
          slice,
          readString(data, "text", context.where),
          context.clock.timestamp(),
        );
        return mutation.result.ok
          ? {
              slice: mutation.slice,
              summary: `hash=${mutation.result.value.hash}`,
            }
          : { summary: `failed code=${mutation.result.code}` };
      },
    },
    "git.restore": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["path", "staged"]);
        const path = readString(data, "path", context.where);
        if (typeof data["staged"] !== "boolean")
          throw new Error(`${context.where}: staged must be a boolean`);
        const mutation = restoreGit(slice, path, data["staged"]);
        if (!mutation.result.ok)
          return { summary: `failed code=${mutation.result.code}` };
        return {
          slice: mutation.slice,
          summary: `path=${JSON.stringify(path)} staged=${String(data["staged"])}`,
          ...(mutation.plan === null
            ? {}
            : {
                effects: [
                  {
                    type: "vfs.replace-files",
                    payload: {
                      tracked: mutation.plan.tracked,
                      target: mutation.plan.target,
                    },
                  },
                ],
              }),
        };
      },
    },
    "git.checkout": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["target"]);
        const target = readString(data, "target", context.where);
        const mutation = checkoutGit(
          slice,
          readVfsSlice(context.state),
          target,
          context.clock.timestamp(),
        );
        if (!mutation.result.ok)
          return { summary: `failed code=${mutation.result.code}` };
        return {
          slice: mutation.git,
          summary: `head=${mutation.result.value.head.kind}:${mutation.result.value.head.target} hash=${mutation.result.value.hash}`,
          effects: [
            {
              type: "vfs.replace-files",
              payload: {
                tracked: Object.keys(slice.index).sort(),
                target: mutation.git.index,
              },
            },
          ],
        };
      },
    },
  },
});
