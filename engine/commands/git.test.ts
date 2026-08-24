import { describe, expect, it } from "vitest";

import incidentDocument from "../../content/incidents/incident-001.json";
import { loadCartridge } from "../cartridge/load.js";
import { bootstrap, step } from "../events/reduce.js";
import type { SessionState } from "../events/state.js";
import { readGitSlice } from "../git/module.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
import { readVfsSlice } from "../vfs/module.js";
import { executeShell } from "./shell.js";

interface Result {
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  readonly exitCode: number;
}

function initial(): SessionState {
  return bootstrap({
    cartridge: loadCartridge(loadCartridgeFixture("git")),
    seed: "git-commands",
  });
}

function incidentInitial(): SessionState {
  return bootstrap({
    cartridge: loadCartridge(incidentDocument),
    seed: "incident-001-git-commands",
  });
}

function run(state: SessionState, input: string): Result {
  const output = executeShell(state, input).at(-1);
  expect(output?.type).toBe("shell.result");
  return output?.payload as unknown as Result;
}

function execute(state: SessionState, input: string): SessionState {
  let next = state;
  for (const event of executeShell(state, input)) next = step(next, event);
  return next;
}

function commandEvents(state: SessionState, input: string) {
  return executeShell(state, input).filter(
    (event) =>
      event.type !== "world.history-append" && event.type !== "shell.result",
  );
}

describe("Git commands", () => {
  it.each([
    ["git status", ["On branch main", "nothing to commit, working tree clean"]],
    ["git status --short", []],
    [
      "git log --oneline",
      ["ec84115 increase structural load", "1371060 establish the service"],
    ],
    ["git diff", []],
    [
      "git blame src/index.ts",
      [
        "ec84115 (Greg Formerly 2026-07-31 02:11:09 +0000    1) export const load = 1;",
      ],
    ],
    ["git branch", ["  before-load", "* main"]],
    ["git add .", []],
    ["git restore README.md", []],
  ])("renders exact deterministic output for %s", (input, stdout) => {
    expect(run(initial(), input)).toEqual({ stdout, stderr: [], exitCode: 0 });
  });

  it("renders default log and show with UTC C-locale dates and unified diffs", () => {
    expect(run(initial(), "git log")).toEqual({
      stdout: [
        "commit ec8411560e51cbb72c92dc14430df6b52a836e92",
        "Author: Greg Formerly <greg@example.test>",
        "Date:   Fri Jul 31 02:11:09 2026 +0000",
        "",
        "    increase structural load",
        "",
        "commit 1371060ac7908e038722ae38887e2d71004f7aae",
        "Author: Greg Formerly <greg@example.test>",
        "Date:   Thu Jul 30 10:00:00 2026 +0000",
        "",
        "    establish the service",
      ],
      stderr: [],
      exitCode: 0,
    });
    expect(run(initial(), "git show ec84115")).toEqual({
      stdout: [
        "commit ec8411560e51cbb72c92dc14430df6b52a836e92",
        "Author: Greg Formerly <greg@example.test>",
        "Date:   Fri Jul 31 02:11:09 2026 +0000",
        "",
        "    increase structural load",
        "",
        "diff --git a/src/index.ts b/src/index.ts",
        "--- a/src/index.ts",
        "+++ b/src/index.ts",
        "@@ -1 +1 @@",
        "-export const load = 0;",
        "+export const load = 1;",
      ],
      stderr: [],
      exitCode: 0,
    });
  });

  it("keeps Incident #001's log, blame, refs, diffs, checkout, and repair undo in agreement", () => {
    let state = incidentInitial();
    const commits = Object.values(readGitSlice(state).commits);
    const byId = Object.fromEntries(
      commits.map((commit) => [commit.id, commit]),
    );
    const baseline = byId["regional-baseline"];
    const repair = byId["healthcheck-repair"];
    const rollback = byId["regional-rollback"];
    if (
      baseline === undefined ||
      repair === undefined ||
      rollback === undefined
    )
      expect.unreachable("Incident #001 declares its complete Git trail");

    expect(run(state, "git log --oneline").stdout).toEqual([
      `${rollback.hash.slice(0, 7)} restore regional attachment after maintainer departure`,
      `${repair.hash.slice(0, 7)} return success from the health endpoint`,
      `${baseline.hash.slice(0, 7)} establish regional fail-open`,
    ]);
    expect(run(state, "git diff").stdout).toEqual([]);
    expect(run(state, "git blame src/config.ts").stdout).toEqual([
      expect.stringMatching(
        new RegExp(
          `^${baseline.hash.slice(0, 7)} \\(Greg Formerly .* export const healthEndpoint`,
        ),
      ),
      expect.stringMatching(new RegExp(`^${baseline.hash.slice(0, 7)} `)),
      expect.stringMatching(new RegExp(`^${baseline.hash.slice(0, 7)} `)),
      expect.stringMatching(
        new RegExp(
          `^${repair.hash.slice(0, 7)} \\(Greg Formerly .* successful health response`,
        ),
      ),
      expect.stringMatching(new RegExp(`^${baseline.hash.slice(0, 7)} `)),
      expect.stringMatching(new RegExp(`^${baseline.hash.slice(0, 7)} `)),
    ]);
    expect(run(state, "history").stdout).toEqual([
      "    1  pwd",
      "    2  git status --short",
      "    3  git log --oneline",
      "    4  git show greg/healthcheck-repair",
      "    5  git blame src/config.ts",
      "    6  man 5 routes.conf",
      "    7  man 8 regional-router",
      "    8  ls -la /var/lib/regional-router",
      "    9  cat /var/lib/regional-router/.regional-policy",
      "   10  ops-archive",
      "   11  git checkout greg/healthcheck-repair",
      "   12  npm test",
      "   13  curl http://load-balancer.internal/health",
      "   14  systemctl status regional-router",
      "   15  git checkout main",
      "   16  rm config/routes.conf",
      "   17  cp -p config/routes.200.conf config/routes.conf",
      "   18  npm test",
      "   19  curl http://load-balancer.internal/health",
      "   20  systemctl status regional-router",
      "   21  rm config/routes.conf",
      "   22  cp -p config/routes.500.conf config/routes.conf",
      "   23  git restore config/routes.conf",
    ]);

    state = execute(state, "git checkout greg/healthcheck-repair");
    expect(
      readVfsSlice(state).entries[
        "/production/load-balancer/config/routes.conf"
      ],
    ).toMatchObject({
      contents: "health_status=200\neurope_attached=false\n",
    });
    expect(run(state, "git diff").stdout).toEqual([]);
    expect(run(state, "git blame config/routes.conf").stdout).toEqual([
      expect.stringMatching(new RegExp(`^${repair.hash.slice(0, 7)} `)),
      expect.stringMatching(new RegExp(`^${repair.hash.slice(0, 7)} `)),
    ]);

    state = execute(state, "git checkout main");
    state = execute(state, "rm config/routes.conf");
    state = execute(state, "cp -p config/routes.200.conf config/routes.conf");
    expect(run(state, "git diff").stdout).toEqual([
      "diff --git a/config/routes.conf b/config/routes.conf",
      "--- a/config/routes.conf",
      "+++ b/config/routes.conf",
      "@@ -1,2 +1,2 @@",
      "-health_status=500",
      "-europe_attached=true",
      "+health_status=200",
      "+europe_attached=false",
    ]);

    state = execute(state, "rm config/routes.conf");
    state = execute(state, "cp -p config/routes.500.conf config/routes.conf");
    expect(run(state, "git diff").stdout).toEqual([]);

    state = execute(state, "rm config/routes.conf");
    state = execute(state, "git restore config/routes.conf");
    expect(run(state, "git status --short").stdout).toEqual([]);
    expect(
      readVfsSlice(state).entries[
        "/production/load-balancer/config/routes.conf"
      ],
    ).toMatchObject({
      contents: "health_status=500\neurope_attached=true\n",
      // Git tracks only the executable bit. A content-identical restore is a
      // no-op here, so cp -p's 0644 remains instead of recovering group-write.
      mode: "0644",
    });
  });

  it.each([
    ["git status --short", ""],
    ["git branch", "greg/healthcheck-repair"],
    ["git log --oneline", "return success from the health endpoint"],
    ["git show greg/healthcheck-repair", "europe_attached=false"],
    ["git blame src/config.ts", "successful health response"],
    ["git checkout greg/healthcheck-repair", "Switched to branch"],
    ["git restore config/routes.conf", ""],
  ])(
    "makes Incident #001's authored Git investigation %s useful",
    (input, evidence) => {
      const result = run(incidentInitial(), input);

      expect(result).toMatchObject({ stderr: [], exitCode: 0 });
      if (evidence !== "") {
        expect(result.stdout).toEqual(
          expect.arrayContaining([expect.stringContaining(evidence)]),
        );
      }
    },
  );

  it("treats explicit HEAD exactly like the default show operand", () => {
    expect(executeShell(initial(), "git show HEAD").slice(1)).toEqual(
      executeShell(initial(), "git show").slice(1),
    );
  });

  it("keeps HEAD as the current-head checkout synonym", () => {
    const before = initial();
    const after = execute(before, "git checkout HEAD");

    expect(readGitSlice(after).head).toEqual(readGitSlice(before).head);
    expect(readGitSlice(after).branches).toEqual(readGitSlice(before).branches);
    expect(readVfsSlice(after)).toEqual(readVfsSlice(before));
  });

  it.each([
    [
      "git checkout missing",
      ['error: pathspec "missing" did not match any branch or commit'],
      1,
    ],
    [
      "git checkout -- missing",
      ['error: pathspec "missing" did not match any file(s) known to git'],
      1,
    ],
    [
      "git restore missing",
      ['error: pathspec "missing" did not match any file(s) known to git'],
      1,
    ],
    [
      "git blame missing",
      [
        'fatal: "/production/service/missing" is not tracked at ec8411560e51cbb72c92dc14430df6b52a836e92',
      ],
      128,
    ],
    ["git show missing", ["fatal: bad object missing"], 128],
    ["git branch 'bad name'", ['fatal: invalid branch name "bad name"'], 1],
    ["git branch HEAD", ['fatal: invalid branch name "HEAD"'], 1],
    ["git commit -m unchanged", ["nothing to commit, working tree clean"], 1],
  ])("returns exact errors for %s", (input, stderr, exitCode) => {
    expect(run(initial(), input)).toEqual({ stdout: [], stderr, exitCode });
  });

  it("replays tracked deletion, status, and path checkout restoration byte-identically", () => {
    let state = execute(initial(), "rm src/index.ts");
    expect(run(state, "git status --short")).toEqual({
      stdout: [" D src/index.ts"],
      stderr: [],
      exitCode: 0,
    });
    expect(run(state, "git status")).toEqual({
      stdout: [
        "On branch main",
        "Changes not staged for commit:",
        "  deleted: src/index.ts",
      ],
      stderr: [],
      exitCode: 0,
    });
    expect(run(state, "git diff")).toEqual({
      stdout: [
        "diff --git a/src/index.ts b/src/index.ts",
        "deleted file mode 100644",
        "--- a/src/index.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-export const load = 1;",
      ],
      stderr: [],
      exitCode: 0,
    });
    const staged = execute(state, "git add src/index.ts");
    expect(run(staged, "git diff --staged").stdout).toEqual(
      run(state, "git diff").stdout,
    );
    state = execute(state, "git status --short");
    state = execute(state, "git checkout -- src/index.ts");
    expect(
      readVfsSlice(state).entries["/production/service/src/index.ts"],
    ).toMatchObject({
      contents: "export const load = 1;\n",
    });
    expect(run(state, "git status --short")).toEqual({
      stdout: [],
      stderr: [],
      exitCode: 0,
    });
  });

  it("does not fold a commit when its rendered output cannot be recorded", () => {
    let state = execute(initial(), "touch recorded.txt");
    state = execute(state, "git add recorded.txt");
    const input = "git commit -m 'before\rafter'";

    expect(run(state, input)).toEqual({
      stdout: [],
      stderr: [
        "shell: command output exceeds the deterministic transcript limit",
      ],
      exitCode: 1,
    });
    expect(commandEvents(state, input)).toEqual([]);
    expect(readGitSlice(execute(state, input))).toEqual(readGitSlice(state));
  });

  it("does not fold a multiline commit whose later line cannot be rendered", () => {
    let state = execute(initial(), "touch recorded.txt");
    state = execute(state, "git add recorded.txt");
    const input = "git commit -m 'safe\nbad\rafter'";

    expect(run(state, input)).toEqual({
      stdout: [],
      stderr: [
        "shell: command output exceeds the deterministic transcript limit",
      ],
      exitCode: 1,
    });
    expect(commandEvents(state, input)).toEqual([]);
    expect(readGitSlice(execute(state, input))).toEqual(readGitSlice(state));
  });

  it("records a multiline commit when each rendered line is writable", () => {
    let state = execute(initial(), "touch recorded.txt");
    state = execute(state, "git add recorded.txt");
    const input = "git commit -m 'subject\nbody'";

    expect(run(state, input)).toMatchObject({
      stdout: [expect.stringContaining("subject")],
      exitCode: 0,
    });
    expect(commandEvents(state, input)).toEqual([
      expect.objectContaining({ type: "git.commit" }),
    ]);
    expect(run(execute(state, input), "git log").stdout).toEqual(
      expect.arrayContaining(["    subject", "    body"]),
    );
  });

  it("stages, unstages, commits, updates a branch, and keeps log and blame coherent", () => {
    let state = execute(initial(), "touch load.txt");
    state = execute(state, "git add load.txt");
    expect(run(state, "git status --short").stdout).toEqual(["A  load.txt"]);
    state = execute(state, "git restore --staged load.txt");
    expect(run(state, "git status --short").stdout).toEqual(["?? load.txt"]);
    state = execute(state, "git add .");
    expect(run(state, "git commit -m 'record load'")).toEqual({
      stdout: ["[main 0a39687] record load"],
      stderr: [],
      exitCode: 0,
    });
    state = execute(state, "git commit -m 'record load'");
    const git = readGitSlice(state);
    const hash = git.branches["main"] as string;
    expect(hash).toBe("0a39687e86f9652f2ed2a75c87b17d4d86067d7a");
    expect(run(state, "git log --oneline").stdout[0]).toBe(
      "0a39687 record load",
    );
    state = execute(state, "git branch investigation");
    expect(readGitSlice(state).branches["investigation"]).toBe(hash);
  });

  it("scopes git add dot to repository-root or nested cwd without prefix bleed", () => {
    let root = execute(initial(), "touch root.txt");
    root = execute(root, "touch src/nested.txt");
    root = execute(root, "touch src-sibling.txt");
    const all = execute(root, "git add .");
    expect(Object.keys(readGitSlice(all).index).sort()).toEqual([
      "/production/service/README.md",
      "/production/service/root.txt",
      "/production/service/src-sibling.txt",
      "/production/service/src/index.ts",
      "/production/service/src/nested.txt",
    ]);

    let nested = execute(root, "cd src");
    nested = execute(nested, "git add .");
    const index = readGitSlice(nested).index;
    expect(index["/production/service/src/nested.txt"]).toBe("");
    expect(index["/production/service/root.txt"]).toBeUndefined();
    expect(index["/production/service/src-sibling.txt"]).toBeUndefined();
    expect(run(nested, "git status --short").stdout).toEqual([
      "?? root.txt",
      "?? src-sibling.txt",
      "A  src/nested.txt",
    ]);
  });

  it("records status for a valid repository whose absolute paths exceed a transcript line", () => {
    const source = loadCartridgeFixture("git") as Record<string, unknown>;
    const repository = source["repository"] as Record<string, unknown>;
    const oldRoot = "/production/service";
    const root = `/${"a".repeat(5000)}`;
    const rename = (path: string): string =>
      path.startsWith(oldRoot) ? `${root}${path.slice(oldRoot.length)}` : path;
    repository["cwd"] = root;
    repository["files"] = Object.fromEntries(
      Object.entries(repository["files"] as Record<string, unknown>).map(
        ([path, file]) => [rename(path), file],
      ),
    );
    const history = repository["gitHistory"] as Record<string, unknown>;
    for (const commit of history["commits"] as Record<string, unknown>[]) {
      commit["files"] = Object.fromEntries(
        Object.entries(commit["files"] as Record<string, unknown>).map(
          ([path, file]) => [rename(path), file],
        ),
      );
    }
    const files = repository["files"] as Record<
      string,
      Record<string, unknown>
    >;
    files[`${root}/src/index.ts`] = {
      ...files[`${root}/src/index.ts`],
      contents: "export const load = 2;\n",
    };
    const state = bootstrap({
      cartridge: loadCartridge(source),
      seed: "git-commands",
    });

    expect(() => execute(state, "git status --short")).not.toThrow();
    expect(run(state, "git status --short")).toMatchObject({
      stdout: [" M src/index.ts"],
      exitCode: 0,
    });
    expect(() => execute(state, "git restore src/index.ts")).not.toThrow();
  });

  it("records large diffs without overflowing diagnostic transcript detail", () => {
    const source = loadCartridgeFixture("git") as Record<string, unknown>;
    const repository = source["repository"] as Record<string, unknown>;
    const files = repository["files"] as Record<
      string,
      Record<string, unknown>
    >;
    files["/production/service/src/index.ts"] = {
      ...files["/production/service/src/index.ts"],
      contents: Array.from(
        { length: 200 },
        (_, index) => `changed ${String(index)}`,
      ).join("\n"),
    };
    const state = bootstrap({
      cartridge: loadCartridge(source),
      seed: "git-commands",
    });

    expect(() => execute(state, "git diff")).not.toThrow();
    expect(run(state, "git diff")).toMatchObject({ exitCode: 0 });
  });

  it("records quote-heavy blame output without overflowing transcript detail", () => {
    const source = loadCartridgeFixture("git") as Record<string, unknown>;
    const repository = source["repository"] as Record<string, unknown>;
    const history = repository["gitHistory"] as Record<string, unknown>;
    const commit = (
      history["commits"] as Record<string, unknown>[]
    )[1] as Record<string, unknown>;
    const contents = `${'"'.repeat(2000)}\n`;
    const committedFiles = commit["files"] as Record<
      string,
      Record<string, unknown>
    >;
    committedFiles["/production/service/src/index.ts"] = {
      ...committedFiles["/production/service/src/index.ts"],
      contents,
      blame: ["current"],
    };
    const files = repository["files"] as Record<
      string,
      Record<string, unknown>
    >;
    files["/production/service/src/index.ts"] = {
      ...files["/production/service/src/index.ts"],
      contents,
    };
    const state = bootstrap({
      cartridge: loadCartridge(source),
      seed: "git-commands",
    });

    expect(() => execute(state, "git blame src/index.ts")).not.toThrow();
    expect(run(state, "git blame src/index.ts")).toMatchObject({ exitCode: 0 });
  });

  it("places no-newline markers beside their respective diff rows", () => {
    const source = loadCartridgeFixture("git") as Record<string, unknown>;
    const repository = source["repository"] as Record<string, unknown>;
    const history = repository["gitHistory"] as Record<string, unknown>;
    const commit = (
      history["commits"] as Record<string, unknown>[]
    )[1] as Record<string, unknown>;
    const commits = history["commits"] as Record<string, unknown>[];
    const initialFiles = commits[0]?.["files"] as Record<
      string,
      Record<string, unknown>
    >;
    initialFiles["/production/service/README.md"] = {
      ...initialFiles["/production/service/README.md"],
      contents: "ancestor",
    };
    const committedFiles = commit["files"] as Record<
      string,
      Record<string, unknown>
    >;
    committedFiles["/production/service/README.md"] = {
      ...committedFiles["/production/service/README.md"],
      contents: "old",
      blame: ["current"],
    };
    const files = repository["files"] as Record<
      string,
      Record<string, unknown>
    >;
    files["/production/service/README.md"] = {
      ...files["/production/service/README.md"],
      contents: "new",
    };
    const state = bootstrap({
      cartridge: loadCartridge(source),
      seed: "git-commands",
    });

    expect(run(state, "git diff").stdout).toEqual([
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
    ]);
  });

  it("emits one no-newline marker for shared context", () => {
    const source = loadCartridgeFixture("git") as Record<string, unknown>;
    const repository = source["repository"] as Record<string, unknown>;
    const commits = (repository["gitHistory"] as Record<string, unknown>)[
      "commits"
    ] as Record<string, unknown>[];
    const current = commits[1] as Record<string, unknown>;
    const committedFiles = current["files"] as Record<
      string,
      Record<string, unknown>
    >;
    committedFiles["/production/service/README.md"] = {
      contents: "old\nlast",
      blame: ["current", "current"],
    };
    const files = repository["files"] as Record<
      string,
      Record<string, unknown>
    >;
    files["/production/service/README.md"] = { contents: "new\nlast" };
    const state = bootstrap({
      cartridge: loadCartridge(source),
      seed: "git-shared-marker",
    });

    expect(
      run(state, "git diff").stdout.filter(
        (line) => line === "\\ No newline at end of file",
      ),
    ).toHaveLength(1);
  });

  it.each(["git restore src/index.ts", "git checkout -- src/index.ts"])(
    "%s deletes a working file when its staged index entry is deleted",
    (command) => {
      let state = execute(initial(), "rm src/index.ts");
      state = execute(state, "git add src/index.ts");
      state = execute(state, "touch src/index.ts");
      expect(
        readVfsSlice(state).entries["/production/service/src/index.ts"],
      ).toBeDefined();
      expect(run(state, command)).toEqual({
        stdout: [],
        stderr: [],
        exitCode: 0,
      });
      state = execute(state, command);
      expect(
        readVfsSlice(state).entries["/production/service/src/index.ts"],
      ).toBeUndefined();
    },
  );

  it.each(["git restore src/index.ts", "git checkout -- src/index.ts"])(
    "%s leaves an already-staged deletion unchanged",
    (command) => {
      let state = execute(initial(), "rm src/index.ts");
      state = execute(state, "git add src/index.ts");

      expect(run(state, command)).toEqual({
        stdout: [],
        stderr: [],
        exitCode: 0,
      });
      expect(readGitSlice(execute(state, command))).toEqual(
        readGitSlice(state),
      );
      expect(readVfsSlice(execute(state, command))).toEqual(
        readVfsSlice(state),
      );
    },
  );

  it.each(["git restore scratch.txt", "git checkout -- scratch.txt"])(
    "%s still rejects a genuinely untracked path",
    (command) => {
      const state = execute(initial(), "touch scratch.txt");
      expect(run(state, command)).toEqual({
        stdout: [],
        stderr: [
          'error: pathspec "scratch.txt" did not match any file(s) known to git',
        ],
        exitCode: 1,
      });
    },
  );

  it("records the same failed restore event for restore and path checkout", () => {
    const state = execute(initial(), "touch scratch.txt");
    expect(commandEvents(state, "git checkout -- scratch.txt")).toEqual(
      commandEvents(state, "git restore scratch.txt"),
    );
    expect(commandEvents(state, "git restore scratch.txt")).toEqual([
      {
        type: "git.restore",
        payload: {
          path: "/production/service/scratch.txt",
          staged: false,
        },
        version: 0,
      },
    ]);
  });

  it("preserves staged deletion and recreated-untracked state in short status", () => {
    let state = execute(initial(), "rm src/index.ts");
    state = execute(state, "git add src/index.ts");
    state = execute(state, "touch src/index.ts");

    expect(run(state, "git status --short")).toEqual({
      stdout: ["D? src/index.ts"],
      stderr: [],
      exitCode: 0,
    });
    expect(run(state, "git status").stdout).toEqual([
      "On branch main",
      "Changes to be committed:",
      "  deleted: src/index.ts",
      "Untracked files:",
      "  src/index.ts",
    ]);
  });

  it.each([
    ["git blame /outside", 'fatal: no such path "/outside" in HEAD', 128],
    [
      "git blame ../../../../outside",
      'fatal: no such path "../../../../outside" in HEAD',
      128,
    ],
    ["git add /outside", 'fatal: "/outside" is outside repository', 128],
    [
      "git add ../../../../outside",
      'fatal: "../../../../outside" is outside repository',
      128,
    ],
    [
      "git restore /outside",
      'error: pathspec "/outside" did not match any file(s) known to git',
      1,
    ],
    [
      "git restore ../../../../outside",
      'error: pathspec "../../../../outside" did not match any file(s) known to git',
      1,
    ],
    [
      "git checkout -- /outside",
      'error: pathspec "/outside" did not match any file(s) known to git',
      1,
    ],
    [
      "git checkout -- ../../../../outside",
      'error: pathspec "../../../../outside" did not match any file(s) known to git',
      1,
    ],
  ])("confines operand command %s", (input, error, exitCode) => {
    expect(run(initial(), input)).toEqual({
      stdout: [],
      stderr: [error],
      exitCode,
    });
    expect(commandEvents(initial(), input)).toEqual([]);
  });

  it.each([
    ["git", "git: missing subcommand"],
    ["git unknown", "git: unknown subcommand: unknown"],
    ["git status -z", "status: invalid option: -z"],
    ["git status extra", "git status: too many arguments"],
    ["git log -z", "log: invalid option: -z"],
    ["git log extra", "git log: too many arguments"],
    ["git diff -z", "diff: invalid option: -z"],
    ["git diff extra", "git diff: too many arguments"],
    ["git blame -z", "blame: invalid option: -z"],
    ["git blame", "git blame: usage: git blame <path>"],
    ["git branch -z", "branch: invalid option: -z"],
    ["git branch one two", "git branch: too many arguments"],
    ["git checkout -z", "checkout: invalid option: -z"],
    [
      "git checkout",
      "git checkout: usage: git checkout <ref> | git checkout -- <path>",
    ],
    ["git show -z", "show: invalid option: -z"],
    ["git show one two", "git show: too many arguments"],
    ["git add -z", "add: invalid option: -z"],
    ["git add", "git add: nothing specified, nothing added"],
    ["git commit -z", "commit: invalid option: -z"],
    ["git commit", "git commit: usage: git commit -m <message>"],
    ["git restore -z", "restore: invalid option: -z"],
    ["git restore", "git restore: usage: git restore [--staged] <path>"],
  ])("returns exact usage error for %s", (input, error) => {
    expect(run(initial(), input)).toEqual({
      stdout: [],
      stderr: [error],
      exitCode: 2,
    });
  });

  it("treats inherited subcommand and ref names as ordinary authored strings", () => {
    for (const name of ["constructor", "toString"]) {
      expect(run(initial(), `git ${name}`)).toEqual({
        stdout: [],
        stderr: [`git: unknown subcommand: ${name}`],
        exitCode: 2,
      });
      let state = execute(initial(), `git branch ${name}`);
      expect(run(state, `git checkout ${name}`)).toEqual({
        stdout: [`Switched to branch '${name}'`],
        stderr: [],
        exitCode: 0,
      });
      state = execute(state, `git checkout ${name}`);
      expect(readGitSlice(state).head).toEqual({
        kind: "branch",
        target: name,
      });
    }
  });

  it("checks out branches and unique abbreviated hashes while refusing dirty switches", () => {
    expect(run(initial(), "git checkout before-load")).toEqual({
      stdout: ["Switched to branch 'before-load'"],
      stderr: [],
      exitCode: 0,
    });
    let state = execute(initial(), "git checkout before-load");
    expect(readGitSlice(state).head).toEqual({
      kind: "branch",
      target: "before-load",
    });
    expect(
      readVfsSlice(state).entries["/production/service/src/index.ts"],
    ).toMatchObject({ contents: "export const load = 0;\n" });
    state = execute(state, "git checkout ec84115");
    expect(readGitSlice(state).head).toEqual({
      kind: "detached",
      target: "ec8411560e51cbb72c92dc14430df6b52a836e92",
    });
    state = execute(state, "touch dirty.txt");
    expect(run(state, "git checkout main")).toEqual({
      stdout: [],
      stderr: ["error: Your local changes would be overwritten by checkout"],
      exitCode: 1,
    });
  });
});
