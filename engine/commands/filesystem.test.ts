import { describe, expect, it } from "vitest";

import { loadCartridge } from "../cartridge/load.js";
import { bootstrap, reduce } from "../events/reduce.js";
import type { SessionState } from "../events/state.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
import { executeShell } from "./shell.js";

interface Result {
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  readonly exitCode: number;
}

function state(name = "minimal"): SessionState {
  return bootstrap({
    cartridge: loadCartridge(loadCartridgeFixture(name)),
    seed: "filesystem-commands",
  });
}

/** Exercise the public shell boundary, including its ordered result envelope. */
function run(input: string, initial = state()): Result {
  const events = executeShell(initial, input);
  const result = events.at(-1);
  expect(result?.type).toBe("shell.result");
  if (result?.type !== "shell.result") throw new Error("missing shell result");
  return result.payload as unknown as Result;
}

describe("filesystem commands", () => {
  it.each([
    ["ls", ["README.md", "src"], [], 0],
    [
      "ls -l",
      [
        "-rw-r--r-- 1 root root   10 Aug  5 09:14 README.md",
        "drwxr-xr-x 2 root root 4096 Aug  5 09:14 src",
      ],
      [],
      0,
    ],
    [
      "ls -lh",
      [
        "-rw-r--r-- 1 root root   10 Aug  5 09:14 README.md",
        "drwxr-xr-x 2 root root 4.0K Aug  5 09:14 src",
      ],
      [],
      0,
    ],
    ["ls -a", [".", "..", "README.md", "src"], [], 0],
    ["ls -h", ["README.md", "src"], [], 0],
    ["cat README.md", ["# service"], [], 0],
    ["cd src", [], [], 0],
    ["pwd", ["/production/service"], [], 0],
    ["head -n 1 src/index.ts", ["export const load = 1;"], [], 0],
    ["tail -n 1 src/index.ts", ["export const load = 1;"], [], 0],
    ["wc README.md", ["      1       2      10 README.md"], [], 0],
    ["grep -in LOAD src/index.ts", ["1:export const load = 1;"], [], 0],
    ["grep -r load .", ["./src/index.ts:export const load = 1;"], [], 0],
    ["find src", ["src", "src/index.ts"], [], 0],
    ["mkdir -p generated/nested", [], [], 0],
    ["touch created.txt", [], [], 0],
    ["rm README.md", [], [], 0],
    ["mv README.md moved.md", [], [], 0],
    ["cp README.md copied.md", [], [], 0],
    ["chmod 0600 README.md", [], [], 0],
    [
      "stat README.md",
      [
        "  File: README.md",
        "  Size: 10  Type: regular file",
        "Device: vfs  Links: 1",
        "Access: (0644/-rw-r--r--)  Uid: (root)   Gid: (root)",
        "Modify: 2026-08-05T09:14:22.000Z",
      ],
      [],
      0,
    ],
  ])("returns exact output for %s", (input, stdout, stderr, exitCode) => {
    expect(run(input)).toEqual({ stdout, stderr, exitCode });
  });

  it("renders declared metadata in an aligned deterministic ls -la row", () => {
    expect(run("ls -la src")).toEqual({
      stdout: [
        "drwxr-xr-x 2 root root     4096 Aug  5 09:14 .",
        "drwxr-xr-x 3 root root     4096 Aug  5 09:14 ..",
        "-rw-r--r-- 1 greg departed   23 Jul 31 02:11 index.ts",
      ],
      stderr: [],
      exitCode: 0,
    });
  });

  it.each([
    ["ls missing", "ls: cannot access 'missing': No such file or directory"],
    ["cat missing", "cat: missing: No such file or directory"],
    ["cd missing", "cd: missing: No such file or directory"],
    ["head missing", "head: missing: No such file or directory"],
    ["tail missing", "tail: missing: No such file or directory"],
    ["wc missing", "wc: missing: No such file or directory"],
    ["grep load missing", "grep: missing: No such file or directory", 2],
    ["find missing", "find: missing: No such file or directory"],
    [
      "mkdir missing/directory",
      "mkdir: cannot create directory 'missing/directory': No such file or directory",
    ],
    [
      "touch missing/file",
      "touch: cannot touch 'missing/file': No such file or directory",
    ],
    ["rm missing", "rm: cannot remove 'missing': No such file or directory"],
    ["mv missing target", "mv: missing: No such file or directory"],
    ["cp missing target", "cp: missing: No such file or directory"],
    [
      "chmod 0600 missing",
      "chmod: cannot access 'missing': No such file or directory",
    ],
    ["stat missing", "stat: missing: No such file or directory"],
  ])("reports a missing target for %s", (input, stderr, exitCode = 1) => {
    expect(run(input)).toEqual({ stdout: [], stderr: [stderr], exitCode });
  });

  it.each([
    ["ls sealed", "ls: cannot open directory 'sealed': Permission denied"],
    ["cat private.txt", "cat: private.txt: Permission denied"],
    ["cd sealed", "cd: sealed: Permission denied"],
    ["head private.txt", "head: private.txt: Permission denied"],
    ["tail private.txt", "tail: private.txt: Permission denied"],
    ["wc private.txt", "wc: private.txt: Permission denied"],
    ["grep secret private.txt", "grep: private.txt: Permission denied", 2],
    ["find sealed", "find: sealed: Permission denied", 1, ["sealed"]],
    [
      "mkdir locked/denied",
      "mkdir: cannot create directory 'locked/denied': Permission denied",
    ],
    [
      "touch locked/denied.txt",
      "touch: cannot touch 'locked/denied.txt': Permission denied",
    ],
    [
      "rm sealed/hidden",
      "rm: cannot remove 'sealed/hidden': Permission denied",
    ],
    ["mv sealed/hidden moved", "mv: sealed: Permission denied"],
    ["cp sealed/hidden copied", "cp: sealed: Permission denied"],
    [
      "chmod 0600 private.txt",
      "chmod: cannot access 'private.txt': Operation not permitted",
    ],
    ["stat sealed/hidden", "stat: sealed/hidden: Permission denied"],
  ])(
    "honors VFS permission checks for %s",
    (input, stderr, exitCode = 1, stdout = []) => {
      expect(run(input, state("filesystem"))).toEqual({
        stdout,
        stderr: [stderr],
        exitCode,
      });
    },
  );

  it("rejects option errors and models recursive, forced, and multi-source transfer semantics", () => {
    expect(run("ls -z")).toEqual({
      stdout: [],
      stderr: ["ls: invalid option: -z"],
      exitCode: 2,
    });
    expect(run("head -n")).toEqual({
      stdout: [],
      stderr: ['head: option "-n": missing required value'],
      exitCode: 2,
    });
    expect(run("rm -f missing")).toEqual({
      stdout: [],
      stderr: [],
      exitCode: 0,
    });
    expect(run("rm -r src")).toEqual({ stdout: [], stderr: [], exitCode: 0 });
    expect(run("cp -r src copied-src")).toEqual({
      stdout: [],
      stderr: [],
      exitCode: 0,
    });
    expect(run("cp -p README.md preserved.md")).toEqual({
      stdout: [],
      stderr: [],
      exitCode: 0,
    });
    expect(run("cp README.md src/index.ts copied")).toEqual({
      stdout: [],
      stderr: ["cp: target 'copied' is not a directory"],
      exitCode: 1,
    });
  });

  it("keeps recursive grep matches when a sibling directory is unreadable", () => {
    expect(run("grep -r load .", state("filesystem"))).toEqual({
      stdout: ["./src/index.ts:export const load = 1;"],
      stderr: [
        "grep: ./sealed: Permission denied",
        "grep: ./private.txt: Permission denied",
      ],
      exitCode: 2,
    });
  });

  it("renders tabs and CRLF file contents as deterministic transcript lines", () => {
    const raw = JSON.parse(JSON.stringify(loadCartridgeFixture("minimal"))) as {
      repository: { files: Record<string, { contents: string }> };
    };
    raw.repository.files["/production/service/whitespace.txt"] = {
      contents: "first\tcolumn\r\nsecond\tcolumn\r\n",
    };
    const initial = bootstrap({
      cartridge: loadCartridge(raw),
      seed: "filesystem-whitespace",
    });

    for (const command of [
      "cat whitespace.txt",
      "head whitespace.txt",
      "tail whitespace.txt",
      "grep column whitespace.txt",
    ]) {
      expect(run(command, initial)).toEqual({
        stdout: ["first    column", "second    column"],
        stderr: [],
        exitCode: 0,
      });
    }
  });

  it.each([
    "(a+)+$",
    "a+a+$",
    "a+aa+$",
    ".+a+$",
    "\\w+a+$",
    "\\x61+a+$",
    "\\u0061+a+$",
    "\\x61+\\x61+$",
    "[ab]+[ab]+$",
    "[ab]+[ac]+$",
    "[a-z]+[m-z]+$",
  ])(
    "rejects regex shape %s before it can monopolize deterministic replay",
    (pattern) => {
      expect(run(`grep '${pattern}' README.md`)).toEqual({
        stdout: [],
        stderr: [
          "grep: unsupported regular expression: unsafe repeated pattern",
        ],
        exitCode: 2,
      });
    },
  );

  it.each([
    ["cp README.md src/index.ts", "cp: src/index.ts: File exists"],
    ["cp README.md missing/output", "cp: missing: No such file or directory"],
  ])("reports the failed transfer path for %s", (input, stderr) => {
    expect(run(input)).toEqual({ stdout: [], stderr: [stderr], exitCode: 1 });
  });

  it("keeps escaped long paths within the VFS event transcript budget", () => {
    const path = '"'.repeat(3000);
    for (const input of [
      `touch '${path}'`,
      `cp README.md '${path}'`,
      `mv README.md '${path}'`,
    ]) {
      const replayed = reduce({
        cartridge: loadCartridge(loadCartridgeFixture("minimal")),
        seed: "filesystem-escaped-path",
        events: [{ type: "shell.execute", payload: { input } }],
      });
      expect(
        replayed.transcript.find((entry) => entry.type.startsWith("vfs."))
          ?.summary,
      ).toContain("3020 chars");
      expect(replayed.transcript.at(-1)?.exitCode).toBe(0);
    }
  });

  it("keeps long paths with supplementary Unicode characters writable", () => {
    // The resolved cwd prefix plus these ASCII characters place the emoji at
    // the old UTF-16 excerpt boundary. A code-unit slice would retain only
    // its high surrogate, which transcript validation rejects.
    const path = `${"a".repeat(1994)}😀${"b".repeat(100)}`;
    const replayed = reduce({
      cartridge: loadCartridge(loadCartridgeFixture("minimal")),
      seed: "filesystem-unicode-path",
      events: [
        { type: "shell.execute", payload: { input: `touch '${path}'` } },
      ],
    });
    expect(
      replayed.transcript.find((entry) => entry.type.startsWith("vfs."))
        ?.summary,
    ).toContain("…");
    expect(replayed.transcript.at(-1)?.exitCode).toBe(0);
  });

  it("prints wc totals for multiple operands when only one can be read", () => {
    expect(run("wc README.md missing")).toEqual({
      stdout: [
        "      1       2      10 README.md",
        "      1       2      10 total",
      ],
      stderr: ["wc: missing: No such file or directory"],
      exitCode: 1,
    });
  });

  it("replays rm -r, cp -r, and cp -p with their documented VFS effects", () => {
    const replayed = reduce({
      cartridge: loadCartridge(loadCartridgeFixture("minimal")),
      seed: "filesystem-transfer-flags",
      events: [
        { type: "shell.execute", payload: { input: "cp -r src copied-src" } },
        {
          type: "shell.execute",
          payload: { input: "cp -p src/index.ts preserved.ts" },
        },
        { type: "shell.execute", payload: { input: "rm -r copied-src" } },
      ],
    });
    const entries = (
      replayed.slices["vfs"] as { entries: Record<string, { mtime?: string }> }
    ).entries;
    expect(entries["/production/service/copied-src"]).toBeUndefined();
    expect(entries["/production/service/copied-src/index.ts"]).toBeUndefined();
    expect(entries["/production/service/preserved.ts"]).toMatchObject({
      mtime: "2026-07-31T02:11:09.000Z",
    });
  });

  it("emits mutations into replayed state, preserving cwd and a deletion across later commands", () => {
    const replayed = reduce({
      cartridge: loadCartridge(loadCartridgeFixture("minimal")),
      seed: "filesystem-mutations",
      events: [
        { type: "shell.execute", payload: { input: "mkdir -p work/cache" } },
        { type: "shell.execute", payload: { input: "touch work/cache/keep" } },
        { type: "shell.execute", payload: { input: "cd work/cache" } },
        { type: "shell.execute", payload: { input: "pwd" } },
        { type: "shell.execute", payload: { input: "rm keep" } },
        { type: "shell.execute", payload: { input: "ls" } },
        { type: "shell.execute", payload: { input: "cat keep" } },
      ],
    });
    const vfs = replayed.slices["vfs"] as {
      cwd: string;
      entries: Record<string, unknown>;
    };
    expect(vfs.cwd).toBe("/production/service/work/cache");
    expect(vfs.entries["/production/service/work/cache/keep"]).toBeUndefined();
    expect(
      replayed.transcript
        .filter((entry) => entry.type !== "world.history-append")
        .map((entry) => [entry.type, entry.exitCode, entry.output]),
    ).toEqual([
      ["vfs.mkdir", undefined, undefined],
      ["shell.result", 0, []],
      ["vfs.touch", undefined, undefined],
      ["shell.result", 0, []],
      ["vfs.chdir", undefined, undefined],
      ["shell.result", 0, []],
      [
        "shell.result",
        0,
        [{ stream: "stdout", text: "/production/service/work/cache" }],
      ],
      ["vfs.delete", undefined, undefined],
      ["shell.result", 0, []],
      ["vfs.stat", undefined, undefined],
      ["vfs.list", undefined, undefined],
      ["shell.result", 0, []],
      ["vfs.read", undefined, undefined],
      [
        "shell.result",
        1,
        [{ stream: "stderr", text: "cat: keep: No such file or directory" }],
      ],
    ]);
  });
});
