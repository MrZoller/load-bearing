import { describe, expect, it } from "vitest";

import { loadCartridge } from "../cartridge/load.js";
import { reduce, restoreSnapshot, snapshot } from "../events/reduce.js";
import { deserialize, serialize } from "../serialize/canonical.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
import { createVfsSlice, deleteVfs, writeVfs } from "../vfs/vfs.js";
import { readVfsSlice } from "../vfs/module.js";
import { readGitSlice, validateGitSlice } from "./module.js";
import {
  abbreviateGitHash,
  blameGit,
  branchGit,
  checkoutGit,
  commitGit,
  createGitSlice,
  diffGit,
  gitAddCwdPaths,
  logGit,
  resolveGitRef,
  restoreGit,
  showGit,
  stageGit,
  statusGit,
} from "./git.js";

function source(): Record<string, unknown> {
  return loadCartridgeFixture("git") as Record<string, unknown>;
}

function world() {
  const cartridge = loadCartridge(source());
  return {
    cartridge,
    git: createGitSlice(cartridge),
    vfs: createVfsSlice(cartridge),
  };
}

const NOW = "2026-08-05T09:14:22.000Z";
const FILE = "/production/service/src/index.ts";

describe("the Git model", () => {
  it("derives identity from commit content rather than authored ids", () => {
    const original = world().git;
    const renamed = source();
    const repository = renamed["repository"] as Record<string, unknown>;
    const history = repository["gitHistory"] as Record<string, unknown>;
    const commits = history["commits"] as Record<string, unknown>[];
    (commits[0] as Record<string, unknown>)["id"] = "foundation";
    (commits[1] as Record<string, unknown>)["id"] = "load-change";
    (commits[1] as Record<string, unknown>)["parents"] = ["foundation"];
    history["branches"] = { main: "load-change", "before-load": "foundation" };
    for (const commit of commits) {
      const files = commit["files"] as Record<string, Record<string, unknown>>;
      for (const file of Object.values(files)) {
        file["blame"] = (file["blame"] as string[]).map((id) =>
          id === "initial" ? "foundation" : "load-change",
        );
      }
    }

    const changed = createGitSlice(loadCartridge(renamed));
    expect(Object.keys(changed.commits)).toEqual(Object.keys(original.commits));
    expect(
      Object.values(changed.commits).every(
        (commit) => commit.hash.length === 40,
      ),
    ).toBe(true);
  });

  it("keeps topological log order and blame provenance in agreement", () => {
    const { git } = world();
    const log = logGit(git);
    const blame = blameGit(git, FILE);

    expect(log.map((commit) => commit.id)).toEqual(["current", "initial"]);
    expect(log[0]?.parents).toEqual([log[1]?.hash]);
    expect(blame).toEqual({
      ok: true,
      value: [
        {
          line: 1,
          text: "export const load = 1;",
          hash: log[0]?.hash,
          author: { name: "Greg Formerly", email: "greg@example.test" },
          committedAt: "2026-07-31T02:11:09.000Z",
        },
      ],
    });
    const reachable = new Set(log.map((commit) => commit.hash));
    if (blame.ok)
      expect(blame.value.every((line) => reachable.has(line.hash))).toBe(true);
  });

  it("orders a branching DAG topologically with timestamp then hash ties", () => {
    const { git } = world();
    const history = logGit(git);
    const base = history[1];
    if (base === undefined) expect.unreachable("fixture has a root commit");
    const leftHash = "a".repeat(40);
    const rightHash = "b".repeat(40);
    const mergeHash = "c".repeat(40);
    const left = {
      ...base,
      id: "left",
      hash: leftHash,
      parents: [base.hash],
      committedAt: "2026-08-02T00:00:00.000Z",
    };
    const right = {
      ...base,
      id: "right",
      hash: rightHash,
      parents: [base.hash],
      committedAt: "2026-08-02T00:00:00.000Z",
    };
    const merge = {
      ...base,
      id: "merge",
      hash: mergeHash,
      parents: [leftHash, rightHash],
      committedAt: "2026-08-03T00:00:00.000Z",
    };
    const slice = {
      ...git,
      commits: {
        [base.hash]: base,
        [rightHash]: right,
        [mergeHash]: merge,
        [leftHash]: left,
      },
      head: { kind: "detached", target: mergeHash } as const,
    };

    expect(logGit(slice).map((commit) => commit.hash)).toEqual([
      mergeHash,
      leftHash,
      rightHash,
      base.hash,
    ]);
  });

  it("treats an extended unterminated final line as changed", () => {
    const { git, vfs } = world();
    const unterminated = {
      ...git,
      index: { ...git.index, [FILE]: "export const load = 1;" },
    };
    const changed = writeVfs(vfs, FILE, "export const load = 1;\nextra", NOW);
    if (!changed.result.ok) throw new Error("fixture edit must succeed");
    const lines = diffGit(unterminated, changed.slice, "working-index")[0]
      ?.lines;
    expect(lines).toEqual([
      { kind: "deletion", text: "export const load = 1;" },
      { kind: "addition", text: "export const load = 1;" },
      { kind: "addition", text: "extra" },
    ]);
  });

  it("computes clean, modified, staged, deleted, and untracked states", () => {
    const { git, vfs } = world();
    expect(statusGit(git, vfs)).toEqual([]);

    const edited = writeVfs(vfs, FILE, "export const load = 2;\n", NOW).slice;
    expect(statusGit(git, edited)).toEqual([
      { path: FILE, staged: null, working: "modified", untracked: false },
    ]);
    expect(diffGit(git, edited, "working-index")).toEqual([
      {
        path: FILE,
        oldContents: "export const load = 1;\n",
        newContents: "export const load = 2;\n",
        lines: [
          { kind: "deletion", text: "export const load = 1;" },
          { kind: "addition", text: "export const load = 2;" },
        ],
      },
    ]);

    const staged = stageGit(git, edited, [FILE]);
    expect(staged.result.ok).toBe(true);
    expect(statusGit(staged.slice, edited)).toEqual([
      { path: FILE, staged: "modified", working: null, untracked: false },
    ]);
    const stagedThenEdited = writeVfs(
      edited,
      FILE,
      "export const load = 3;\n",
      NOW,
    ).slice;
    expect(statusGit(staged.slice, stagedThenEdited)).toEqual([
      {
        path: FILE,
        staged: "modified",
        working: "modified",
        untracked: false,
      },
    ]);
    expect(diffGit(staged.slice, edited, "index-head")).toEqual(
      diffGit(git, edited, "working-head"),
    );

    const deleted = deleteVfs(vfs, FILE, NOW).slice;
    expect(statusGit(git, deleted)[0]?.working).toBe("deleted");
    const stagedDeletion = stageGit(git, deleted, [FILE]);
    expect(statusGit(stagedDeletion.slice, deleted)).toEqual([
      { path: FILE, staged: "deleted", working: null, untracked: false },
    ]);
    const untracked = writeVfs(vfs, "notes.txt", "structural\n", NOW).slice;
    expect(statusGit(git, untracked)[0]).toMatchObject({ untracked: true });
    const notes = "/production/service/notes.txt";
    const stagedAddition = stageGit(git, untracked, [notes]);
    expect(statusGit(stagedAddition.slice, untracked)).toEqual([
      { path: notes, staged: "added", working: null, untracked: false },
    ]);
  });

  it("selects add-dot paths beneath cwd with path-segment-safe containment", () => {
    const { git, vfs } = world();
    let changed = writeVfs(vfs, "root.txt", "root\n", NOW).slice;
    changed = writeVfs(changed, "src/nested.txt", "nested\n", NOW).slice;
    changed = writeVfs(changed, "src-sibling.txt", "sibling\n", NOW).slice;

    expect(gitAddCwdPaths(git, changed, git.root)).toEqual([
      "/production/service/root.txt",
      "/production/service/src-sibling.txt",
      "/production/service/src/nested.txt",
    ]);
    expect(gitAddCwdPaths(git, changed, `${git.root}/src`)).toEqual([
      "/production/service/src/nested.txt",
    ]);
  });

  it("creates branches and resolves full, abbreviated, and ambiguous refs", () => {
    const { git } = world();
    const created = branchGit(git, "investigation/load");
    expect(created.result).toMatchObject({ ok: true });
    expect(created.slice.branches["investigation/load"]).toBe(
      git.branches["main"],
    );
    expect(branchGit(created.slice, "investigation/load").result).toMatchObject(
      {
        ok: false,
        code: "INVALID",
      },
    );
    const hash = git.branches["main"] as string;
    expect(resolveGitRef(git, hash.slice(0, 7))).toEqual({
      ok: true,
      value: hash,
    });

    const collision = `${hash.slice(0, 7)}f${"0".repeat(32)}`;
    const colliding = {
      ...git,
      commits: {
        ...git.commits,
        [collision]: { ...git.commits[hash]!, hash: collision },
      },
    };
    expect(abbreviateGitHash(colliding, hash)).toBe(hash.slice(0, 8));
    expect(resolveGitRef(colliding, hash.slice(0, 7))).toMatchObject({
      ok: false,
      code: "INVALID",
    });
  });

  it("reserves HEAD for the current commit at the model boundary", () => {
    const { git } = world();

    expect(branchGit(git, "HEAD").result).toEqual({
      ok: false,
      code: "INVALID",
      message: 'invalid branch name "HEAD"',
    });
    expect(resolveGitRef(git, "HEAD")).toEqual({
      ok: true,
      value: git.branches["main"],
    });
  });

  it("never resolves or rejects refs through Object.prototype", () => {
    const { git, vfs } = world();
    for (const name of ["constructor", "toString"]) {
      expect(resolveGitRef(git, name)).toEqual({
        ok: false,
        code: "NOT_FOUND",
        message: `unknown revision ${JSON.stringify(name)}`,
      });
      const created = branchGit(git, name);
      expect(created.result).toMatchObject({ ok: true });
      expect(resolveGitRef(created.slice, name)).toEqual({
        ok: true,
        value: git.branches["main"],
      });
      expect(checkoutGit(git, vfs, name, NOW).result).toMatchObject({
        ok: false,
        code: "NOT_FOUND",
      });
    }
  });

  it("commits the index with cartridge identity and first-parent blame", () => {
    const { git, vfs } = world();
    const edited = writeVfs(vfs, FILE, "export const load = 2;\n", NOW).slice;
    const staged = stageGit(git, edited, [FILE]);
    const committed = commitGit(staged.slice, "visitor repair", NOW);
    expect(committed.result.ok).toBe(true);
    if (!committed.result.ok) expect.unreachable("commit succeeds");
    expect(committed.result.value.author).toEqual({
      name: "Visitor",
      email: "visitor@example.test",
    });
    expect(committed.result.value.parents).toEqual([git.branches["main"]]);
    expect(committed.result.value.files[FILE]?.blame).toEqual([
      committed.result.value.hash,
    ]);
    expect(committed.slice.branches["main"]).toBe(committed.result.value.hash);
    const shown = showGit(committed.slice);
    expect(shown.ok).toBe(true);
    if (!shown.ok) expect.unreachable("new commit can be shown");
    expect(shown.value).toMatchObject({
      commit: { hash: committed.result.value.hash },
      files: [{ path: FILE }],
    });
  });

  it("restores the index or returns a VFS-owned working-tree plan", () => {
    const { git, vfs } = world();
    const edited = writeVfs(vfs, FILE, "dirty\n", NOW).slice;
    const staged = stageGit(git, edited, [FILE]);
    const unstaged = restoreGit(staged.slice, FILE, true);
    expect(unstaged.result).toEqual({ ok: true, value: { path: FILE } });
    expect(unstaged.slice.index[FILE]).toBe(git.index[FILE]);
    expect(unstaged.plan).toBeNull();

    const working = restoreGit(staged.slice, FILE, false);
    expect(working.slice).toBe(staged.slice);
    expect(working.plan).toEqual({
      tracked: [FILE],
      target: { [FILE]: "dirty\n" },
    });

    const stagedDeletion = stageGit(git, deleteVfs(vfs, FILE, NOW).slice, [
      FILE,
    ]);
    expect(restoreGit(stagedDeletion.slice, FILE, false)).toMatchObject({
      result: { ok: true, value: { path: FILE } },
      plan: { tracked: [FILE], target: {} },
    });
    expect(
      restoreGit(stagedDeletion.slice, "/production/service/untracked", false)
        .result,
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("checks out branches and detached hashes through the VFS", () => {
    const { git, vfs } = world();
    const previous = checkoutGit(git, vfs, "before-load", NOW);
    expect(previous.result.ok).toBe(true);
    expect(previous.git.head).toEqual({
      kind: "branch",
      target: "before-load",
    });
    expect(previous.git.index[FILE]).toBe("export const load = 0;\n");
    expect(previous.vfs.entries[FILE]).toMatchObject({
      kind: "file",
      contents: "export const load = 0;\n",
    });

    const currentHash = git.branches["main"] as string;
    const detached = checkoutGit(previous.git, previous.vfs, currentHash, NOW);
    expect(detached.result.ok).toBe(true);
    expect(detached.git.head).toEqual({
      kind: "detached",
      target: currentHash,
    });
    expect(detached.vfs.entries[FILE]).toMatchObject({
      contents: "export const load = 1;\n",
    });
  });

  it("refuses every dirty checkout without changing either slice", () => {
    const { git, vfs } = world();
    const edited = writeVfs(vfs, FILE, "dirty\n", NOW).slice;
    const refused = checkoutGit(git, edited, "before-load", NOW);

    expect(refused.result).toMatchObject({ ok: false, code: "DIRTY" });
    expect(refused.git).toBe(git);
    expect(refused.vfs).toBe(edited);
  });

  it("rejects an unknown checkout target without changing either slice", () => {
    const { git, vfs } = world();
    const refused = checkoutGit(git, vfs, "not-a-branch-or-commit", NOW);

    expect(refused.result).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(refused.git).toBe(git);
    expect(refused.vfs).toBe(vfs);
  });

  it("renders a trailing-newline-only diff as an applicable byte-stable change", () => {
    const { git, vfs } = world();
    const withoutTerminalNewline = writeVfs(
      vfs,
      FILE,
      "export const load = 1;",
      NOW,
    ).slice;

    const first = diffGit(git, withoutTerminalNewline, "working-index");
    const second = diffGit(git, withoutTerminalNewline, "working-index");
    expect(first).toEqual(second);
    expect(serialize(first)).toBe(serialize(second));
    expect(first).toEqual([
      {
        path: FILE,
        oldContents: "export const load = 1;\n",
        newContents: "export const load = 1;",
        lines: [
          { kind: "deletion", text: "export const load = 1;" },
          { kind: "addition", text: "export const load = 1;" },
        ],
      },
    ]);
  });

  it("rolls back both slices when the VFS rejects checkout", () => {
    const raw = source();
    const repository = raw["repository"] as Record<string, unknown>;
    repository["identity"] = {
      user: "visitor",
      group: "visitor",
      home: "/home/visitor",
    };
    const files = repository["files"] as Record<
      string,
      Record<string, unknown>
    >;
    (files[FILE] as Record<string, unknown>)["mode"] = "0444";
    const cartridge = loadCartridge(raw);
    const git = createGitSlice(cartridge);
    const vfs = createVfsSlice(cartridge);
    const refused = checkoutGit(git, vfs, "before-load", NOW);

    expect(refused.result).toMatchObject({ ok: false, code: "VFS" });
    expect(refused.git).toBe(git);
    expect(refused.vfs).toBe(vfs);
  });

  it("commits the Git and VFS event slices together", () => {
    const cartridge = loadCartridge(source());
    const state = reduce({
      cartridge,
      seed: "2026-08-05/6/deep-foundation",
      events: [{ type: "git.checkout", payload: { target: "before-load" } }],
    });

    expect(readGitSlice(state).head).toEqual({
      kind: "branch",
      target: "before-load",
    });
    expect(readVfsSlice(state).entries[FILE]).toMatchObject({
      contents: "export const load = 0;\n",
    });
    expect(state.transcript).toHaveLength(1);
    expect(state.transcript[0]?.type).toBe("git.checkout");
  });

  it("rejects HEAD branch events before they can enter state", () => {
    expect(() =>
      reduce({
        cartridge: loadCartridge(source()),
        seed: "2026-08-05/6/deep-foundation",
        events: [{ type: "git.branch", payload: { name: "HEAD" } }],
      }),
    ).toThrow(/invalid branch name/);
  });

  it("rejects snapshots containing a HEAD branch", () => {
    const state = reduce({
      cartridge: loadCartridge(source()),
      seed: "2026-08-05/6/deep-foundation",
      events: [{ type: "git.status", payload: {} }],
    });
    const recorded = deserialize(snapshot(state)) as Record<string, unknown>;
    const slices = recorded["slices"] as Record<
      string,
      Record<string, unknown>
    >;
    const git = slices["git"] as Record<string, unknown>;
    const branches = git["branches"] as Record<string, string>;
    branches["HEAD"] = branches["main"] as string;

    expect(() => restoreSnapshot(serialize(recorded))).toThrow(
      /invalid branch "HEAD"/,
    );
  });

  it("rejects a snapshot whose Git blame cannot safely serve a later blame event", () => {
    const state = reduce({
      cartridge: loadCartridge(source()),
      seed: "2026-08-05/6/deep-foundation",
      events: [{ type: "git.status", payload: {} }],
    });
    const recorded = deserialize(snapshot(state)) as Record<string, unknown>;
    const slices = recorded["slices"] as Record<
      string,
      Record<string, unknown>
    >;
    const git = slices["git"] as Record<string, unknown>;
    const commits = git["commits"] as Record<string, Record<string, unknown>>;
    const head = (git["branches"] as Record<string, string>)["main"] as string;
    const commit = commits[head] as Record<string, unknown>;
    const files = commit["files"] as Record<string, Record<string, unknown>>;
    files[FILE] = { ...files[FILE], blame: [] };

    expect(() => restoreSnapshot(serialize(recorded))).toThrow(/blame/);
  });

  it("rejects restored blame attributed to an unrelated existing commit", () => {
    const git = JSON.parse(JSON.stringify(world().git)) as Record<
      string,
      unknown
    >;
    const commits = git["commits"] as Record<string, Record<string, unknown>>;
    const hashes = Object.keys(commits);
    const head = (git["branches"] as Record<string, string>)["main"] as string;
    const sibling = hashes.find((hash) => hash !== head);
    if (sibling === undefined) throw new Error("fixture must have two commits");
    const files = commits[head]?.["files"] as Record<
      string,
      Record<string, unknown>
    >;
    files[FILE] = { ...files[FILE], blame: [sibling] };

    expect(() => validateGitSlice(git, "git")).toThrow(
      /first-parent provenance/,
    );
  });

  it("rejects a snapshot with a commit timestamp that commands cannot render", () => {
    const state = reduce({
      cartridge: loadCartridge(source()),
      seed: "2026-08-05/6/deep-foundation",
      events: [{ type: "git.status", payload: {} }],
    });
    const recorded = deserialize(snapshot(state)) as Record<string, unknown>;
    const git = (recorded["slices"] as Record<string, Record<string, unknown>>)[
      "git"
    ] as Record<string, unknown>;
    const commits = git["commits"] as Record<string, Record<string, unknown>>;
    const head = (git["branches"] as Record<string, string>)["main"] as string;
    (commits[head] as Record<string, unknown>)["committedAt"] = "bogus";

    expect(() => restoreSnapshot(serialize(recorded))).toThrow(
      /invalid commit timestamp/,
    );
  });

  it("rejects a noncanonical spelling of a valid commit instant", () => {
    const git = JSON.parse(JSON.stringify(world().git)) as Record<
      string,
      unknown
    >;
    const commits = git["commits"] as Record<string, Record<string, unknown>>;
    const first = Object.values(commits)[0];
    if (first === undefined) throw new Error("fixture must have a commit");
    first["committedAt"] = "2026-07-31T02:11:09Z";
    expect(() => validateGitSlice(git, "git")).toThrow(
      /invalid commit timestamp/,
    );
  });

  it.each(["commit", "index"])(
    "rejects a snapshot whose Git %s path escapes the repository root",
    (kind) => {
      const state = reduce({
        cartridge: loadCartridge(source()),
        seed: "2026-08-05/6/deep-foundation",
        events: [{ type: "git.status", payload: {} }],
      });
      const recorded = deserialize(snapshot(state)) as Record<string, unknown>;
      const slices = recorded["slices"] as Record<
        string,
        Record<string, unknown>
      >;
      const git = slices["git"] as Record<string, unknown>;
      if (kind === "index") {
        (git["index"] as Record<string, string>)["/production/service-copy/x"] =
          "outside\n";
      } else {
        const commits = git["commits"] as Record<
          string,
          Record<string, unknown>
        >;
        const hash = (git["branches"] as Record<string, string>)[
          "main"
        ] as string;
        const files = (commits[hash] as Record<string, unknown>)[
          "files"
        ] as Record<string, unknown>;
        files["/production/service-copy/x"] = {
          contents: "outside\n",
          blame: [hash],
        };
      }

      expect(() => restoreSnapshot(serialize(recorded))).toThrow(
        /must be at or below repository root/,
      );
    },
  );

  it("treats slash as containing every absolute Git path", () => {
    const git = { ...world().git, root: "/" };
    expect(validateGitSlice(git, "git")).toBe(git);
  });
});
