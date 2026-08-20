/** Deterministic Git command rendering over the Git and VFS models. */

import {
  MONTH_NAMES,
  WEEKDAY_NAMES,
  civilFromEpochMs,
  formatTimestamp,
  parseTimestamp,
} from "../clock/civil.js";
import type { EngineEvent } from "../events/state.js";
import {
  MAX_TRANSCRIPT_DETAIL_LINES,
  MAX_TRANSCRIPT_LINE_LENGTH,
} from "../events/transcript.js";
import {
  abbreviateGitHash,
  blameGit,
  branchGit,
  checkoutGit,
  commitGit,
  currentGitHash,
  diffGit,
  gitAddCwdPaths,
  logGit,
  restoreGit,
  stageGit,
  statusGit,
  showGit,
} from "../git/git.js";
import { readGitSlice } from "../git/module.js";
import type {
  GitChange,
  GitCommit,
  GitDiffFile,
  GitFailure,
  GitSlice,
} from "../git/types.js";
import { isAtOrBelow, resolveVfsPath } from "../vfs/path.js";
import { describeUnwritableText } from "../text.js";
import { readVfsSlice } from "../vfs/module.js";
import { replaceVfsFiles } from "../vfs/vfs.js";
import { CommandOptionError, parseCommandOptions } from "./options.js";
import type {
  CommandContext,
  CommandDefinition,
  CommandExecution,
  CommandOptionSpec,
  ParsedCommandOptions,
} from "./types.js";

function field<T, K extends keyof T>(value: T, key: K): T[K] {
  return value[key];
}

const EMPTY: readonly string[] = Object.freeze([]);
const EMPTY_EVENTS: readonly EngineEvent[] = Object.freeze([]);

function event(
  type: string,
  payload: Readonly<Record<string, unknown>>,
): EngineEvent {
  return { type, payload };
}

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
      // A shell failure must not fold a successful mutation before its
      // result event. Keeping events here would report an error while
      // committing or restoring state the transcript cannot represent.
      events: EMPTY_EVENTS,
    };
  return { stdout, stderr, exitCode, events };
}

function usage(name: string, text: string): CommandExecution {
  return result(EMPTY, [`${name}: ${text}`], 2);
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
    return usage(context.argv[0] ?? "git", `invalid option: ${token}`);
  }
}

function parsed(
  value: ParsedCommandOptions | CommandExecution,
): value is ParsedCommandOptions {
  return !("exitCode" in value);
}

function has(options: ParsedCommandOptions, key: string): boolean {
  return (options.options[key]?.length ?? 0) > 0;
}

function now(context: CommandContext): string {
  return formatTimestamp(
    context.state.clock.startMs + context.state.clock.elapsedMs,
  );
}

function relative(slice: GitSlice, path: string): string {
  if (path === slice.root) return ".";
  const prefix = slice.root === "/" ? "/" : `${slice.root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function pathFromOperand(
  context: CommandContext,
  operand: string,
): string | undefined {
  const vfs = readVfsSlice(context.state);
  const path = resolveVfsPath(operand, vfs.cwd, vfs.identity.home).path;
  const root = readGitSlice(context.state).root;
  return isAtOrBelow(path, root) ? path : undefined;
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

function gitDate(timestamp: string): string {
  const civil = civilFromEpochMs(parseTimestamp(timestamp));
  return `${WEEKDAY_NAMES[civil.weekday]} ${MONTH_NAMES[civil.month - 1]} ${String(civil.day).padStart(2, " ")} ${String(civil.hour).padStart(2, "0")}:${String(civil.minute).padStart(2, "0")}:${String(civil.second).padStart(2, "0")} ${String(civil.year).padStart(4, "0")} +0000`;
}

function blameDate(timestamp: string): string {
  const civil = civilFromEpochMs(parseTimestamp(timestamp));
  return `${String(civil.year).padStart(4, "0")}-${String(civil.month).padStart(2, "0")}-${String(civil.day).padStart(2, "0")} ${String(civil.hour).padStart(2, "0")}:${String(civil.minute).padStart(2, "0")}:${String(civil.second).padStart(2, "0")} +0000`;
}

function renderCommit(commit: GitCommit): string[] {
  const commitText = field(commit, "message").replace(/\n+$/, "").split("\n");
  return [
    `commit ${commit.hash}`,
    `Author: ${commit.author.name} <${commit.author.email}>`,
    `Date:   ${gitDate(commit.committedAt)}`,
    "",
    ...commitText.map((line) => `    ${line}`),
  ];
}

function logicalLines(contents: string | null): readonly string[] {
  if (contents === null || contents === "") return [];
  const lines = contents.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function range(prefix: "-" | "+", count: number): string {
  return `${prefix}${count === 0 ? "0" : "1"}${count === 1 ? "" : `,${String(count)}`}`;
}

function renderDiff(slice: GitSlice, file: GitDiffFile): string[] {
  const path = relative(slice, file.path);
  const oldLines = logicalLines(file.oldContents);
  const newLines = logicalLines(file.newContents);
  const lines = [
    `diff --git a/${path} b/${path}`,
    file.oldContents === null
      ? "new file mode 100644"
      : file.newContents === null
        ? "deleted file mode 100644"
        : "",
    file.oldContents === null ? "--- /dev/null" : `--- a/${path}`,
    file.newContents === null ? "+++ /dev/null" : `+++ b/${path}`,
    `@@ ${range("-", oldLines.length)} ${range("+", newLines.length)} @@`,
    ...file.lines.map(
      (line) =>
        `${line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " "}${line.text}`,
    ),
  ].filter((line) => line !== "");
  if (
    file.oldContents !== null &&
    file.oldContents !== "" &&
    !file.oldContents.endsWith("\n")
  )
    lines.push("\\ No newline at end of file");
  if (
    file.newContents !== null &&
    file.newContents !== "" &&
    !file.newContents.endsWith("\n")
  )
    lines.push("\\ No newline at end of file");
  return lines;
}

function renderDiffs(slice: GitSlice, files: readonly GitDiffFile[]): string[] {
  return files.flatMap((file) => renderDiff(slice, file));
}

function failure(name: string, value: GitFailure): CommandExecution {
  return result(EMPTY, [`${name}: ${field(value, "message")}`], 1);
}

const STATUS: CommandDefinition = Object.freeze({
  name: "git",
  execute(context: CommandContext) {
    const subcommand = context.argv[1];
    const nested = {
      ...context,
      argv: [subcommand ?? "", ...context.argv.slice(2)],
    };
    const key = subcommand ?? "";
    const command = Object.hasOwn(GIT_SUBCOMMANDS, key)
      ? GIT_SUBCOMMANDS[key]
      : undefined;
    return command === undefined
      ? usage(
          "git",
          subcommand === undefined
            ? "missing subcommand"
            : `unknown subcommand: ${subcommand}`,
        )
      : command(nested);
  },
});

type Subcommand = (context: CommandContext) => CommandExecution;

const status: Subcommand = (context) => {
  const options = parse(context, [{ key: "short", short: "s", long: "short" }]);
  if (!parsed(options)) return options;
  if (options.operands.length !== 0)
    return usage("git status", "too many arguments");
  const git = readGitSlice(context.state);
  const entries = statusGit(git, readVfsSlice(context.state));
  const eventValue = event("git.status", {});
  if (has(options, "short")) {
    const letter = (change: GitChange | null): string =>
      change === "added"
        ? "A"
        : change === "modified"
          ? "M"
          : change === "deleted"
            ? "D"
            : " ";
    return result(
      entries.map((entry) => {
        // A staged deletion followed by recreation is both index-deleted and
        // working-untracked. `D?` preserves both bounded status dimensions.
        if (entry.untracked)
          return `${entry.staged === null ? "?" : letter(entry.staged)}? ${relative(git, entry.path)}`;
        return `${letter(entry.staged)}${letter(entry.working)} ${relative(git, entry.path)}`;
      }),
      EMPTY,
      0,
      [eventValue],
    );
  }
  const branch =
    git.head.kind === "branch" ? git.head.target : "HEAD (detached)";
  if (entries.length === 0)
    return result(
      [`On branch ${branch}`, "nothing to commit, working tree clean"],
      EMPTY,
      0,
      [eventValue],
    );
  const staged = entries.filter((entry) => entry.staged !== null);
  const working = entries.filter((entry) => entry.working !== null);
  const untracked = entries.filter((entry) => entry.untracked);
  const out = [`On branch ${branch}`];
  if (staged.length > 0) {
    out.push(
      "Changes to be committed:",
      ...staged.map(
        (entry) => `  ${entry.staged}: ${relative(git, entry.path)}`,
      ),
    );
  }
  if (working.length > 0) {
    out.push(
      "Changes not staged for commit:",
      ...working.map(
        (entry) => `  ${entry.working}: ${relative(git, entry.path)}`,
      ),
    );
  }
  if (untracked.length > 0)
    out.push(
      "Untracked files:",
      ...untracked.map((entry) => `  ${relative(git, entry.path)}`),
    );
  return result(out, EMPTY, 0, [eventValue]);
};

const log: Subcommand = (context) => {
  const options = parse(context, [{ key: "oneline", long: "oneline" }]);
  if (!parsed(options)) return options;
  if (options.operands.length !== 0)
    return usage("git log", "too many arguments");
  const git = readGitSlice(context.state);
  const commits = logGit(git);
  const stdout = has(options, "oneline")
    ? commits.map(
        (commit) =>
          `${abbreviateGitHash(git, commit.hash)} ${firstLine(field(commit, "message"))}`,
      )
    : commits.flatMap((commit, index) => [
        ...(index === 0 ? [] : [""]),
        ...renderCommit(commit),
      ]);
  return result(stdout, EMPTY, 0, [event("git.log", {})]);
};

const diff: Subcommand = (context) => {
  const options = parse(context, [{ key: "staged", long: "staged" }]);
  if (!parsed(options)) return options;
  if (options.operands.length !== 0)
    return usage("git diff", "too many arguments");
  const git = readGitSlice(context.state);
  const comparison = has(options, "staged") ? "index-head" : "working-index";
  return result(
    renderDiffs(git, diffGit(git, readVfsSlice(context.state), comparison)),
    EMPTY,
    0,
    [event("git.diff", { comparison })],
  );
};

const blame: Subcommand = (context) => {
  const options = parse(context, []);
  if (!parsed(options)) return options;
  const operand = options.operands[0];
  if (operand === undefined || options.operands.length !== 1)
    return usage("git blame", "usage: git blame <path>");
  const path = pathFromOperand(context, operand);
  if (path === undefined)
    return result(
      EMPTY,
      [`fatal: no such path ${JSON.stringify(operand)} in HEAD`],
      128,
    );
  const git = readGitSlice(context.state);
  const blamed = blameGit(git, path);
  if (!blamed.ok)
    return result(EMPTY, [`fatal: ${field(blamed, "message")}`], 128, [
      event("git.blame", { path }),
    ]);
  const widths = blamed.value.map((line) => line.author.name.length);
  const width = widths.reduce((largest, value) => Math.max(largest, value), 0);
  return result(
    blamed.value.map(
      (line) =>
        `${abbreviateGitHash(git, line.hash)} (${line.author.name.padEnd(width)} ${blameDate(line.committedAt)} ${String(line.line).padStart(4)}) ${line.text}`,
    ),
    EMPTY,
    0,
    [event("git.blame", { path })],
  );
};

const branch: Subcommand = (context) => {
  const options = parse(context, []);
  if (!parsed(options)) return options;
  if (options.operands.length > 1)
    return usage("git branch", "too many arguments");
  const git = readGitSlice(context.state);
  const name = options.operands[0];
  if (name === undefined)
    return result(
      Object.keys(git.branches)
        .sort()
        .map(
          (candidate) =>
            `${git.head.kind === "branch" && git.head.target === candidate ? "*" : " "} ${candidate}`,
        ),
      EMPTY,
      0,
      [event("git.branches", {})],
    );
  const mutation = branchGit(git, name);
  if (!mutation.result.ok)
    return {
      ...failure("fatal", mutation.result),
      events: field(mutation.result, "message").startsWith("invalid branch")
        ? EMPTY_EVENTS
        : [event("git.branch", { name })],
    };
  return result(EMPTY, EMPTY, 0, [event("git.branch", { name })]);
};

const checkout: Subcommand = (context) => {
  const git = readGitSlice(context.state);
  const vfs = readVfsSlice(context.state);
  if (context.argv[1] === "--") {
    const operand = context.argv[2];
    if (operand === undefined || context.argv.length !== 3)
      return usage("git checkout", "usage: git checkout -- <path>");
    const path = pathFromOperand(context, operand);
    if (path === undefined)
      return result(
        EMPTY,
        [
          `error: pathspec ${JSON.stringify(operand)} did not match any file(s) known to git`,
        ],
        1,
      );
    const mutation = restoreGit(git, path, false);
    if (!mutation.result.ok)
      return result(
        EMPTY,
        [
          `error: pathspec ${JSON.stringify(operand)} did not match any file(s) known to git`,
        ],
        1,
        [event("git.restore", { path, staged: false })],
      );
    const plan = mutation.plan;
    if (plan === null) throw new Error("path checkout requires a VFS plan");
    const replacement = replaceVfsFiles(
      vfs,
      plan.tracked,
      plan.target,
      now(context),
    );
    if (!replacement.result.ok)
      return result(
        EMPTY,
        [`error: unable to write ${JSON.stringify(operand)}`],
        1,
      );
    return result(EMPTY, EMPTY, 0, [
      event("git.restore", { path, staged: false }),
    ]);
  }
  const options = parse(context, []);
  if (!parsed(options)) return options;
  const target = options.operands[0];
  if (target === undefined || options.operands.length !== 1)
    return usage(
      "git checkout",
      "usage: git checkout <ref> | git checkout -- <path>",
    );
  const mutation = checkoutGit(git, vfs, target, now(context));
  if (!mutation.result.ok) {
    const message =
      mutation.result.code === "DIRTY"
        ? "error: Your local changes would be overwritten by checkout"
        : `error: pathspec ${JSON.stringify(target)} did not match any branch or commit`;
    return result(EMPTY, [message], 1, [event("git.checkout", { target })]);
  }
  const checkedOutCommit = Object.hasOwn(
    mutation.git.commits,
    mutation.result.value.hash,
  )
    ? mutation.git.commits[mutation.result.value.hash]
    : undefined;
  if (checkedOutCommit === undefined)
    throw new Error("successful checkout must name an owned commit");
  const stdout =
    mutation.result.value.head.kind === "branch"
      ? [`Switched to branch '${mutation.result.value.head.target}'`]
      : [
          `HEAD is now at ${abbreviateGitHash(git, mutation.result.value.hash)} ${firstLine(field(checkedOutCommit, "message"))}`,
        ];
  return result(stdout, EMPTY, 0, [event("git.checkout", { target })]);
};

const show: Subcommand = (context) => {
  const options = parse(context, []);
  if (!parsed(options)) return options;
  if (options.operands.length > 1)
    return usage("git show", "too many arguments");
  const git = readGitSlice(context.state);
  const authored = options.operands[0];
  const shown = showGit(git, authored ?? currentGitHash(git));
  if (!shown.ok)
    return result(EMPTY, [`fatal: bad object ${authored ?? "HEAD"}`], 128, [
      event("git.show", { ref: authored ?? "HEAD" }),
    ]);
  return result(
    [
      ...renderCommit(shown.value.commit),
      "",
      ...renderDiffs(git, shown.value.files),
    ],
    EMPTY,
    0,
    [event("git.show", { ref: authored ?? "HEAD" })],
  );
};

const add: Subcommand = (context) => {
  const options = parse(context, []);
  if (!parsed(options)) return options;
  if (options.operands.length === 0)
    return usage("git add", "nothing specified, nothing added");
  const git = readGitSlice(context.state);
  const vfs = readVfsSlice(context.state);
  const paths: string[] = [];
  for (const operand of options.operands) {
    if (operand === ".") paths.push(...gitAddCwdPaths(git, vfs, vfs.cwd));
    else {
      const path = pathFromOperand(context, operand);
      if (path === undefined)
        return result(
          EMPTY,
          [`fatal: ${JSON.stringify(operand)} is outside repository`],
          128,
        );
      paths.push(path);
    }
  }
  const mutation = stageGit(git, vfs, paths);
  if (!mutation.result.ok)
    return result(
      EMPTY,
      [`fatal: pathspec did not match: ${field(mutation.result, "message")}`],
      128,
      [event("git.stage", { paths })],
    );
  return result(EMPTY, EMPTY, 0, [event("git.stage", { paths })]);
};

const commit: Subcommand = (context) => {
  const options = parse(context, [
    { key: "commitText", short: "m", value: "required" },
  ]);
  if (!parsed(options)) return options;
  const commitText = options.options["commitText"]?.at(-1);
  if (typeof commitText !== "string" || options.operands.length !== 0)
    return usage("git commit", "usage: git commit -m <message>");
  const git = readGitSlice(context.state);
  const mutation = commitGit(git, commitText, now(context));
  if (!mutation.result.ok)
    return result(EMPTY, [field(mutation.result, "message")], 1, [
      event("git.commit", { text: commitText }),
    ]);
  const branchName =
    mutation.slice.head.kind === "branch"
      ? mutation.slice.head.target
      : "detached HEAD";
  return result(
    [
      `[${branchName} ${abbreviateGitHash(mutation.slice, mutation.result.value.hash)}] ${firstLine(commitText)}`,
    ],
    EMPTY,
    0,
    [event("git.commit", { text: commitText })],
  );
};

const restore: Subcommand = (context) => {
  const options = parse(context, [{ key: "staged", long: "staged" }]);
  if (!parsed(options)) return options;
  const operand = options.operands[0];
  if (operand === undefined || options.operands.length !== 1)
    return usage("git restore", "usage: git restore [--staged] <path>");
  const path = pathFromOperand(context, operand);
  if (path === undefined)
    return result(
      EMPTY,
      [
        `error: pathspec ${JSON.stringify(operand)} did not match any file(s) known to git`,
      ],
      1,
    );
  const git = readGitSlice(context.state);
  const mutation = restoreGit(git, path, has(options, "staged"));
  if (!mutation.result.ok)
    return result(
      EMPTY,
      [
        `error: pathspec ${JSON.stringify(operand)} did not match any file(s) known to git`,
      ],
      1,
      [event("git.restore", { path, staged: has(options, "staged") })],
    );
  if (mutation.plan !== null) {
    const replacement = replaceVfsFiles(
      readVfsSlice(context.state),
      mutation.plan.tracked,
      mutation.plan.target,
      now(context),
    );
    if (!replacement.result.ok)
      return result(
        EMPTY,
        [`error: unable to restore ${JSON.stringify(operand)}`],
        1,
      );
  }
  return result(EMPTY, EMPTY, 0, [
    event("git.restore", { path, staged: has(options, "staged") }),
  ]);
};

const GIT_SUBCOMMANDS: Readonly<Record<string, Subcommand>> = Object.freeze({
  status,
  log,
  diff,
  blame,
  checkout,
  branch,
  show,
  add,
  commit,
  restore,
});

export const GIT_COMMANDS: readonly CommandDefinition[] = Object.freeze([
  STATUS,
]);
