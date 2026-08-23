import { describe, expect, it } from "vitest";

import { loadCartridge } from "../cartridge/load.js";
import { reduce } from "../events/reduce.js";
import {
  loadCartridgeFixture,
  loadReplayFixture,
} from "../testing/fixtures.js";
import { validateVfsSlice } from "./module.js";
import {
  baseName,
  compareVfsNames,
  isAtOrBelow,
  isDescendant,
  parentPath,
  resolveVfsPath,
  vfsTraversalPaths,
} from "./path.js";
import type { VfsEntry, VfsSlice } from "./types.js";
import {
  chmodVfs,
  chdirVfs,
  copyVfs,
  createVfsSlice,
  deleteVfs,
  listVfs,
  mkdirVfs,
  readVfs,
  replaceVfsFiles,
  renameVfs,
  statVfs,
  touchVfs,
  writeAuthoredWaiverVfs,
  writeVfs,
} from "./vfs.js";

const NOW = "2026-08-05T10:00:00.000Z";
const LATER = "2026-08-05T10:00:01.000Z";
const cartridge = loadCartridge(loadCartridgeFixture("minimal"));

function fresh(): VfsSlice {
  return createVfsSlice(cartridge);
}

function mutableSlice(): VfsSlice {
  return JSON.parse(JSON.stringify(fresh())) as VfsSlice;
}

function successful<T>(mutation: {
  readonly result: { readonly ok: boolean };
  readonly slice: VfsSlice;
}): VfsSlice {
  expect(mutation.result.ok).toBe(true);
  expect(() => validateVfsSlice(mutation.slice, "result")).not.toThrow();
  return mutation.slice;
}

describe("VFS construction and paths", () => {
  it("keeps authored traversal, containment, and name ordering semantics explicit", () => {
    expect(
      vfsTraversalPaths("~/work/./child/../file", "/", "/home/me"),
    ).toEqual([
      "/home",
      "/home/me",
      "/home/me/work",
      "/home/me/work",
      "/home/me/work/child",
      "/home/me/work/child",
    ]);
    expect(parentPath("/")).toBe("/");
    expect(parentPath("/one")).toBe("/");
    expect(baseName("/")).toBe("/");
    expect(baseName("/one/two")).toBe("two");
    expect(isDescendant("/a/b", "/a")).toBe(true);
    expect(isDescendant("/a", "/")).toBe(true);
    expect(isDescendant("/", "/")).toBe(false);
    expect(isAtOrBelow("/a", "/a")).toBe(true);
    expect(isAtOrBelow("/a", "/")).toBe(true);
    expect(isAtOrBelow("/ab", "/a")).toBe(false);
    expect(compareVfsNames("same", "same")).toBe(0);
    expect(compareVfsNames("a", "ab")).toBeLessThan(0);
  });
  it("hydrates root and implicit directories while retaining explicit metadata", () => {
    const slice = fresh();
    expect(slice.entries["/"]).toMatchObject({
      kind: "directory",
      owner: "root",
    });
    expect(slice.entries["/production/service"]).toMatchObject({
      kind: "directory",
    });
    expect(slice.entries["/production/service/src"]).toMatchObject({
      kind: "directory",
      owner: "root",
    });
    expect(Object.isFrozen(slice)).toBe(true);
  });

  it("resolves shell paths without consulting the host", () => {
    const slice = fresh();
    expect(
      resolveVfsPath("./src/../README.md", slice.cwd, slice.identity.home),
    ).toEqual({ path: "/production/service/README.md", trailingSlash: false });
    expect(
      resolveVfsPath("../../../../etc/motd", slice.cwd, slice.identity.home)
        .path,
    ).toBe("/etc/motd");
    expect(resolveVfsPath("~", slice.cwd, "/root").path).toBe("/root");
    expect(resolveVfsPath("~/work/", slice.cwd, "/root")).toEqual({
      path: "/root/work",
      trailingSlash: true,
    });
    expect(resolveVfsPath("~nobody", slice.cwd, "/root").path).toBe(
      "/production/service/~nobody",
    );
    expect(resolveVfsPath("", slice.cwd, slice.identity.home).path).toBe("");
  });

  it("does not normalize traversal through a regular file into another path", () => {
    const slice = fresh();
    expect(readVfs(slice, "README.md/../src/index.ts")).toMatchObject({
      ok: false,
      code: "ENOTDIR",
      path: "/production/service/README.md",
    });
    expect(writeVfs(slice, "README.md/../new", "x", NOW).result).toMatchObject({
      ok: false,
      code: "ENOTDIR",
    });
  });

  it("rejects empty authored paths instead of targeting cwd", () => {
    const slice = fresh();
    expect(statVfs(slice, "")).toMatchObject({ ok: false, code: "ENOENT" });
    expect(touchVfs(slice, "", NOW).result).toMatchObject({
      ok: false,
      code: "EINVAL",
    });
  });

  it("lists names in Unicode code-point order", () => {
    let slice = fresh();
    for (const name of ["z", "\u{1f9f1}", "a", "\u{e000}"])
      slice = successful(writeVfs(slice, name, name, NOW));
    const listing = listVfs(slice, ".");
    expect(listing.ok && listing.value.map((item) => item.name)).toEqual([
      "README.md",
      "a",
      "src",
      "z",
      "\u{e000}",
      "\u{1f9f1}",
    ]);
    expect(["\u{1f9f1}", "\u{e000}"].sort(compareVfsNames)).toEqual([
      "\u{e000}",
      "\u{1f9f1}",
    ]);
  });

  it("does not freeze or retain caller-owned input objects", () => {
    const input = mutableSlice();
    const originalEntry = input.entries["/etc/motd"];
    const created = writeVfs(input, "new", "x", NOW);

    expect(created.result).toMatchObject({ ok: true });
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.identity)).toBe(false);
    expect(Object.isFrozen(input.entries)).toBe(false);
    expect(Object.isFrozen(originalEntry)).toBe(false);
    expect(input.entries["/production/service/new"]).toBeUndefined();
    expect(created.slice.identity).not.toBe(input.identity);
    expect(created.slice.entries["/etc/motd"]).not.toBe(originalEntry);

    const listing = listVfs(input, "/etc");
    expect(listing).toMatchObject({ ok: true });
    expect(Object.isFrozen(originalEntry)).toBe(false);
    if (listing.ok) {
      expect(listing.value[0]?.entry).not.toBe(originalEntry);
      expect(Object.isFrozen(listing.value[0]?.entry)).toBe(true);
    }
  });

  it("rejects invalid names before a mutation can return an invalid slice", () => {
    for (const operation of [
      (slice: VfsSlice) => writeVfs(slice, "bad\\name", "x", NOW),
      (slice: VfsSlice) => mkdirVfs(slice, "bad\u0000name", NOW),
      (slice: VfsSlice) => renameVfs(slice, "README.md", "bad\\name", NOW),
      (slice: VfsSlice) => copyVfs(slice, "README.md", "bad\u0000name", NOW),
    ]) {
      const slice = fresh();
      const mutation = operation(slice);
      expect(mutation.result).toMatchObject({ ok: false, code: "EINVAL" });
      expect(mutation.slice).toBe(slice);
    }
  });

  it("rejects noncanonical snapshot mtime spellings", () => {
    const slice = mutableSlice();
    const entry = slice.entries["/etc/motd"] as VfsEntry;
    (slice.entries as Record<string, VfsEntry>)["/etc/motd"] = {
      ...entry,
      mtime: "2026-08-05T09:14:22Z",
    };
    expect(() => validateVfsSlice(slice, "snapshot: slices.vfs")).toThrow(
      /mtime: must be a real fixed-width UTC instant/,
    );
  });
});

describe("authored waiver writes", () => {
  it("applies the WAIVER.md policy while preserving ordinary write semantics", () => {
    const path = "/production/service/WAIVER.md";
    const created = writeAuthoredWaiverVfs(fresh(), path, "version one\n", NOW);
    expect(created.result).toEqual({
      ok: true,
      value: { path, created: true },
    });
    expect(readVfs(created.slice, path)).toMatchObject({
      value: { contents: "version one\n" },
    });

    const replaced = writeAuthoredWaiverVfs(
      created.slice,
      path,
      "version two\n",
      LATER,
    );
    expect(replaced.result).toEqual({
      ok: true,
      value: { path, created: false },
    });
    expect(readVfs(replaced.slice, path)).toMatchObject({
      value: { contents: "version two\n" },
    });
    expect(statVfs(replaced.slice, path)).toMatchObject({
      value: { entry: { mtime: LATER } },
    });
  });

  it("denies an unwritable parent and existing file as the acting identity", () => {
    const incident = loadCartridge(
      loadReplayFixture("020-incident-001-story").cartridge,
    );
    const slice = createVfsSlice(incident);
    const deniedParent = writeAuthoredWaiverVfs(
      slice,
      "/production/load-balancer/WAIVER.md",
      "x",
      NOW,
    );
    expect(deniedParent.result).toMatchObject({ ok: false, code: "EACCES" });
    expect(deniedParent.slice).toBe(slice);

    const existing = JSON.parse(JSON.stringify(slice)) as {
      entries: Record<string, VfsEntry>;
    } & VfsSlice;
    existing.entries["/production/load-balancer/config/WAIVER.md"] = {
      kind: "file",
      contents: "protected\n",
      mode: "0444",
      owner: "root",
      group: "root",
      mtime: NOW,
    };
    const deniedFile = writeAuthoredWaiverVfs(
      existing,
      "/production/load-balancer/config/WAIVER.md",
      "replacement\n",
      LATER,
    );
    expect(deniedFile.result).toMatchObject({ ok: false, code: "EACCES" });
    expect(deniedFile.slice).toBe(existing);
    expect(
      readVfs(existing, "/production/load-balancer/config/WAIVER.md"),
    ).toMatchObject({ value: { contents: "protected\n" } });
  });

  it("refuses malformed names, times, directory targets and absent/non-directory parents", () => {
    const slice = fresh();
    expect(
      writeAuthoredWaiverVfs(
        slice,
        "/production/service/bad\n/WAIVER.md",
        "x",
        NOW,
      ).result,
    ).toMatchObject({ ok: false, code: "EINVAL" });
    expect(
      writeAuthoredWaiverVfs(slice, "/production/service/waiver.txt", "x", NOW)
        .result,
    ).toMatchObject({ ok: false, code: "EINVAL" });
    expect(
      writeAuthoredWaiverVfs(
        slice,
        "/production/service/WAIVER.md",
        "x",
        "not-time",
      ).result,
    ).toMatchObject({ ok: false, code: "EINVAL" });
    expect(
      writeAuthoredWaiverVfs(slice, "/missing/WAIVER.md", "x", NOW).result,
    ).toMatchObject({ ok: false, code: "ENOENT" });
    expect(
      writeAuthoredWaiverVfs(slice, "/etc/motd/WAIVER.md", "x", NOW).result,
    ).toMatchObject({ ok: false, code: "ENOTDIR" });

    const directoryTarget = mutableSlice() as {
      entries: Record<string, VfsEntry>;
    } & VfsSlice;
    directoryTarget.entries["/production/service/WAIVER.md"] = {
      kind: "directory",
      mode: "0755",
      owner: "root",
      group: "root",
      mtime: NOW,
    };
    expect(
      writeAuthoredWaiverVfs(
        directoryTarget,
        "/production/service/WAIVER.md",
        "x",
        NOW,
      ).result,
    ).toMatchObject({ ok: false, code: "EISDIR" });
  });
});

describe("VFS permissions and mutations", () => {
  it("lets Incident #001's visitor replace routes through the operator-writable config directory", () => {
    const incident = loadCartridge(
      loadReplayFixture("020-incident-001-story").cartridge,
    );
    const original = createVfsSlice(incident);
    const route = "config/routes.conf";
    const detached = "config/routes.200.conf";
    const attached = "config/routes.500.conf";

    expect(original.identity).toMatchObject({
      user: "visitor",
      group: "operators",
    });
    expect(original.entries["/production/load-balancer/config"]).toMatchObject({
      owner: "root",
      group: "operators",
      mode: "0775",
    });
    expect(
      original.entries["/production/load-balancer/config/routes.conf"],
    ).toMatchObject({
      contents: "health_status=500\neurope_attached=true\n",
      owner: "root",
      group: "operators",
      mode: "0664",
    });

    let slice = successful(deleteVfs(original, route, NOW));
    slice = successful(
      copyVfs(slice, detached, route, NOW, { preserve: true }),
    );
    expect(
      slice.entries["/production/load-balancer/config/routes.conf"],
    ).toMatchObject({
      contents: "health_status=200\neurope_attached=false\n",
      owner: "root",
      group: "operators",
      mode: "0644",
    });

    slice = successful(deleteVfs(slice, route, LATER));
    slice = successful(
      copyVfs(slice, attached, route, LATER, { preserve: true }),
    );
    expect(
      slice.entries["/production/load-balancer/config/routes.conf"],
    ).toMatchObject({
      contents: "health_status=500\neurope_attached=true\n",
      owner: "root",
      group: "operators",
      mode: "0644",
    });

    const nonOperator = {
      ...original,
      identity: { ...original.identity, user: "observer", group: "observers" },
    };
    expect(deleteVfs(nonOperator, route, NOW).result).toMatchObject({
      ok: false,
      code: "EACCES",
      operation: "delete",
    });
  });

  it("returns precise failures for ordinary file, directory, and metadata operations", () => {
    const slice = fresh();
    expect(readVfs(slice, "src")).toMatchObject({ ok: false, code: "EISDIR" });
    expect(readVfs(slice, "README.md/")).toMatchObject({
      ok: false,
      code: "ENOTDIR",
    });
    expect(statVfs(slice, "README.md/")).toMatchObject({
      ok: false,
      code: "ENOTDIR",
    });
    expect(listVfs(slice, "README.md")).toMatchObject({
      ok: false,
      code: "ENOTDIR",
    });
    expect(writeVfs(slice, "src/", "x", NOW).result).toMatchObject({
      ok: false,
      code: "EISDIR",
    });
    expect(writeVfs(slice, "src", "x", NOW).result).toMatchObject({
      ok: false,
      code: "EISDIR",
    });
    expect(touchVfs(slice, "README.md/", NOW).result).toMatchObject({
      ok: false,
      code: "ENOTDIR",
    });
    expect(chdirVfs(slice, "README.md").result).toMatchObject({
      ok: false,
      code: "ENOTDIR",
    });
    expect(chdirVfs(slice, "missing").result).toMatchObject({
      ok: false,
      code: "ENOENT",
    });
    expect(chdirVfs(slice, ".").slice).toBe(slice);
    expect(mkdirVfs(slice, "/", NOW).result).toMatchObject({
      ok: false,
      code: "EEXIST",
    });
    expect(mkdirVfs(slice, "/", NOW, true).result).toEqual({
      ok: true,
      value: { paths: [] },
    });
    expect(mkdirVfs(slice, "README.md", NOW, true).result).toMatchObject({
      ok: false,
      code: "EEXIST",
    });
    expect(deleteVfs(slice, "missing", NOW).result).toMatchObject({
      ok: false,
      code: "ENOENT",
    });
    expect(deleteVfs(slice, "README.md/", NOW).result).toMatchObject({
      ok: false,
      code: "ENOTDIR",
    });
    expect(deleteVfs(slice, "/", NOW).result).toMatchObject({
      ok: false,
      code: "EBUSY",
    });
    expect(chmodVfs(slice, "missing", "0600").result).toMatchObject({
      ok: false,
      code: "ENOENT",
    });
    expect(chmodVfs(slice, "README.md", "bad").result).toMatchObject({
      ok: false,
      code: "EINVAL",
    });
    expect(chmodVfs(slice, "README.md/", "0600").result).toMatchObject({
      ok: false,
      code: "ENOTDIR",
    });
  });

  it("makes recursive transfer and replacement reject unsafe paths without partial state", () => {
    let slice = successful(mkdirVfs(fresh(), "tree/nested", NOW, true));
    slice = successful(writeVfs(slice, "tree/nested/secret", "x", NOW));
    expect(copyVfs(slice, "tree", "copy", NOW).result).toMatchObject({
      ok: false,
      code: "EISDIR",
    });
    expect(
      copyVfs(slice, "tree", "tree/nested/copy", NOW, { recursive: true })
        .result,
    ).toMatchObject({ ok: false, code: "EINVAL" });
    expect(
      renameVfs(slice, "tree", "tree/nested/moved", NOW).result,
    ).toMatchObject({ ok: false, code: "EINVAL" });
    expect(copyVfs(slice, "missing", "copy", NOW).result).toMatchObject({
      ok: false,
      code: "ENOENT",
    });
    expect(renameVfs(slice, "missing", "moved", NOW).result).toMatchObject({
      ok: false,
      code: "ENOENT",
    });
    expect(copyVfs(slice, "README.md", "missing/", NOW).result).toMatchObject({
      ok: false,
      code: "ENOENT",
    });
    expect(renameVfs(slice, "README.md", "missing/", NOW).result).toMatchObject(
      { ok: false, code: "ENOENT" },
    );
    expect(copyVfs(slice, "README.md", "README.md", NOW).result).toMatchObject({
      ok: false,
      code: "EEXIST",
    });
    expect(renameVfs(slice, "README.md", "README.md", NOW).result).toEqual({
      ok: true,
      value: {
        from: "/production/service/README.md",
        to: "/production/service/README.md",
      },
    });
    const noRead = {
      ...slice,
      identity: { ...slice.identity, user: "nobody", group: "nobody" },
      entries: {
        ...slice.entries,
        "/production/service/tree/nested/secret": {
          ...slice.entries["/production/service/tree/nested/secret"]!,
          mode: "0000",
        },
      },
    };
    expect(
      copyVfs(noRead, "tree", "copy", NOW, { recursive: true }).result,
    ).toMatchObject({ ok: false, code: "EACCES" });
    const replacement = replaceVfsFiles(
      slice,
      ["/production/service/tree/nested/secret"],
      {},
      NOW,
    );
    expect(replacement.result).toEqual({
      ok: true,
      value: { removed: 1, written: 0 },
    });
    expect(
      replaceVfsFiles(
        replacement.slice,
        ["/production/service/tree/nested/secret"],
        {},
        NOW,
      ).result,
    ).toEqual({ ok: true, value: { removed: 0, written: 0 } });
  });
  it("uses owner, group, other, root, traversal, and parent permissions with structured failures", () => {
    const slice = fresh();
    expect(readVfs(slice, "/etc/motd")).toMatchObject({ ok: true });
    const nonRoot = {
      ...slice,
      identity: { ...slice.identity, user: "nobody", group: "nobody" },
    };
    expect(writeVfs(nonRoot, "/etc/motd", "no", NOW).result).toMatchObject({
      ok: false,
      code: "EACCES",
      operation: "write",
    });
    expect(chmodVfs(slice, "/etc/motd", "0600").result).toMatchObject({
      ok: true,
    });

    const group = {
      ...slice,
      identity: { ...slice.identity, user: "someone", group: "departed" },
    };
    expect(readVfs(group, "/production/service/src/index.ts")).toMatchObject({
      ok: true,
    });
    const other = { ...group, identity: { ...group.identity, group: "other" } };
    expect(readVfs(other, "/production/service/src/index.ts")).toMatchObject({
      ok: true,
    });

    const differentiated = mutableSlice();
    (differentiated.entries as Record<string, VfsEntry>)[
      "/production/service/src/index.ts"
    ] = {
      ...differentiated.entries["/production/service/src/index.ts"]!,
      mode: "0640",
      owner: "owner",
      group: "shared",
    };
    const sharedGroup = {
      ...differentiated,
      identity: { ...differentiated.identity, user: "member", group: "shared" },
    };
    const unrelated = {
      ...sharedGroup,
      identity: { ...sharedGroup.identity, group: "unrelated" },
    };
    expect(
      readVfs(sharedGroup, "/production/service/src/index.ts"),
    ).toMatchObject({ ok: true });
    expect(
      readVfs(unrelated, "/production/service/src/index.ts"),
    ).toMatchObject({ ok: false, code: "EACCES" });
    expect(
      chmodVfs(other, "/production/service/src/index.ts", "0600").result,
    ).toMatchObject({ ok: false, code: "EPERM" });
    const root = { ...other, identity: { ...other.identity, user: "root" } };
    expect(
      writeVfs(root, "/etc/motd", "root writes", NOW).result,
    ).toMatchObject({ ok: true });

    const closed = successful(chmodVfs(slice, "/production", "0700"));
    const blocked = {
      ...closed,
      identity: { ...closed.identity, user: "nobody", group: "nobody" },
    };
    expect(readVfs(blocked, "/production/service/README.md")).toMatchObject({
      ok: false,
      code: "EACCES",
    });
    expect(
      writeVfs(blocked, "/production/service/new", "x", NOW).result,
    ).toMatchObject({ ok: false, code: "EACCES" });
  });

  it("creates with umask, updates mtimes correctly, and keeps all successful results valid", () => {
    let slice = fresh();
    const originalParent = slice.entries["/production/service"]?.mtime;
    slice = successful(writeVfs(slice, "new", "one", NOW));
    expect(slice.entries["/production/service/new"]).toMatchObject({
      mode: "0644",
      owner: "root",
      group: "root",
      mtime: NOW,
    });
    expect(slice.entries["/production/service"]?.mtime).toBe(NOW);
    slice = successful(writeVfs(slice, "new", "two", LATER));
    expect(slice.entries["/production/service/new"]).toMatchObject({
      contents: "two",
      mtime: LATER,
    });
    expect(slice.entries["/production/service"]?.mtime).toBe(NOW);
    expect(originalParent).not.toBe(NOW);
  });

  it("stats through searchable ancestors and persists a validated chdir", () => {
    const slice = fresh();
    expect(statVfs(slice, "README.md")).toMatchObject({
      ok: true,
      value: { path: "/production/service/README.md", entry: { kind: "file" } },
    });
    const moved = successful(chdirVfs(slice, "src"));
    expect(moved.cwd).toBe("/production/service/src");
    expect(readVfs(moved, "index.ts")).toMatchObject({ ok: true });

    const closed = successful(chmodVfs(slice, "/production", "0700"));
    const blocked = {
      ...closed,
      identity: { ...closed.identity, user: "nobody", group: "nobody" },
    };
    expect(statVfs(blocked, "README.md")).toMatchObject({
      ok: false,
      code: "EACCES",
    });
    expect(chdirVfs(blocked, "src").result).toMatchObject({
      ok: false,
      code: "EACCES",
    });
  });

  it("touches existing files without changing contents and creates with umask", () => {
    let slice = fresh();
    const existing = slice.entries["/production/service/README.md"];
    const originalContents = existing?.kind === "file" ? existing.contents : "";
    slice = successful(touchVfs(slice, "created", NOW));
    expect(slice.entries["/production/service/created"]).toMatchObject({
      kind: "file",
      contents: "",
      mode: "0644",
      mtime: NOW,
    });
    slice = successful(touchVfs(slice, "README.md", LATER));
    expect(slice.entries["/production/service/README.md"]).toMatchObject({
      contents: originalContents,
      mtime: LATER,
    });
  });

  it("makes mkdir atomic, supports -p, and updates parent mtimes", () => {
    const slice = fresh();
    expect(mkdirVfs(slice, "README.md", NOW).result).toMatchObject({
      ok: false,
      code: "EEXIST",
    });
    const failed = mkdirVfs(slice, "missing/a", NOW);
    expect(failed.result).toMatchObject({ ok: false, code: "ENOENT" });
    expect(failed.slice).toBe(slice);
    const made = successful(mkdirVfs(slice, "missing/a", NOW, true));
    expect(made.entries["/production/service/missing/a"]).toMatchObject({
      kind: "directory",
      mode: "0755",
      mtime: NOW,
    });
    expect(mkdirVfs(made, "missing/a", LATER, true).result).toEqual({
      ok: true,
      value: { paths: [] },
    });
  });

  it("rejects malformed or noncanonical simulated timestamps without mutation", () => {
    for (const now of [
      "2026-08-05T10:00:00Z",
      "2026-02-30T10:00:00.000Z",
      "no clock",
    ]) {
      for (const operation of [
        (slice: VfsSlice) => writeVfs(slice, "new", "x", now),
        (slice: VfsSlice) => mkdirVfs(slice, "new", now),
        (slice: VfsSlice) => deleteVfs(slice, "README.md", now),
        (slice: VfsSlice) => renameVfs(slice, "README.md", "renamed", now),
        (slice: VfsSlice) => copyVfs(slice, "README.md", "copied", now),
      ]) {
        const slice = mutableSlice();
        const mutation = operation(slice);
        expect(mutation.result).toMatchObject({ ok: false, code: "EINVAL" });
        expect(mutation.slice).toBe(slice);
        expect(() => validateVfsSlice(slice, "input")).not.toThrow();
      }
    }
  });

  it("deletes recursively only when asked and protects cwd coherence", () => {
    let slice = successful(mkdirVfs(fresh(), "tree/leaf", NOW, true));
    slice = successful(writeVfs(slice, "tree/leaf/file", "x", NOW));
    const empty = successful(mkdirVfs(slice, "empty", NOW));
    expect(deleteVfs(empty, "empty", LATER, false, true).result).toMatchObject({
      ok: false,
      code: "EISDIR",
    });
    expect(deleteVfs(slice, "tree", LATER).result).toMatchObject({
      ok: false,
      code: "ENOTEMPTY",
    });
    expect(
      successful(deleteVfs(slice, "tree", LATER, true)).entries[
        "/production/service/tree"
      ],
    ).toBeUndefined();
    expect(deleteVfs(fresh(), ".", NOW, true).result).toMatchObject({
      ok: false,
      code: "EBUSY",
    });
    expect(deleteVfs(fresh(), "/production", NOW, true).result).toMatchObject({
      ok: false,
      code: "EBUSY",
    });

    const deniedParent = {
      ...slice,
      identity: { ...slice.identity, user: "nobody", group: "nobody" },
      entries: {
        ...slice.entries,
        "/production/service": {
          ...slice.entries["/production/service"]!,
          mode: "0555",
        },
      },
    };
    expect(deleteVfs(deniedParent, "tree", LATER).result).toMatchObject({
      ok: false,
      code: "EACCES",
    });
  });

  it("renames and copies trees, retaining or replacing metadata as requested", () => {
    let slice = successful(mkdirVfs(fresh(), "tree/sub", NOW, true));
    slice = successful(writeVfs(slice, "tree/sub/file", "x", NOW));
    slice = successful(renameVfs(slice, "tree", "moved", LATER));
    expect(slice.entries["/production/service/moved/sub/file"]).toMatchObject({
      contents: "x",
    });
    expect(
      renameVfs(fresh(), "/production", "/elsewhere", NOW).result,
    ).toMatchObject({ ok: false, code: "EBUSY" });
    expect(
      renameVfs(fresh(), "README.md", "src/index.ts", NOW).result,
    ).toMatchObject({
      ok: false,
      code: "EEXIST",
    });
    expect(
      renameVfs(fresh(), "README.md", "src/index.ts/", NOW).result,
    ).toMatchObject({
      ok: false,
      code: "ENOTDIR",
    });
    expect(
      copyVfs(fresh(), "README.md", "src/index.ts/", NOW).result,
    ).toMatchObject({
      ok: false,
      code: "ENOTDIR",
    });
    const copied = successful(
      copyVfs(slice, "moved", "copied", LATER, { recursive: true }),
    );
    expect(copied.entries["/production/service/copied/sub/file"]).toMatchObject(
      { owner: "root", mtime: LATER },
    );
    const preserved = successful(
      copyVfs(slice, "moved", "preserved", LATER, {
        recursive: true,
        preserve: true,
      }),
    );
    expect(preserved.entries["/production/service/preserved/sub/file"]).toEqual(
      slice.entries["/production/service/moved/sub/file"],
    );
  });

  it("never aliases inputs or successful results", () => {
    const input = fresh();
    const mutation = writeVfs(input, "immutable", "x", NOW);
    expect(input.entries["/production/service/immutable"]).toBeUndefined();
    expect(mutation.result.ok).toBe(true);
    expect(Object.isFrozen(mutation.slice)).toBe(true);
    expect(
      () => ((mutation.slice.entries as Record<string, unknown>)["x"] = {}),
    ).toThrow(TypeError);
  });
});

describe("VFS event module", () => {
  it("owns persisted chdir and touch transitions", () => {
    const state = reduce({
      cartridge,
      seed: "vfs-command-apis",
      events: [
        { type: "vfs.chdir", payload: { path: "src" } },
        { type: "vfs.touch", payload: { path: "created.ts" } },
      ],
    });
    const slice = state.slices["vfs"] as VfsSlice;
    expect(slice.cwd).toBe("/production/service/src");
    expect(slice.entries["/production/service/src/created.ts"]).toMatchObject({
      kind: "file",
      contents: "",
      mtime: cartridge.meta.startedAt,
    });
  });

  it("replays create, write, chmod, delete, and leaves deletion absent after later events", () => {
    const state = reduce({
      cartridge,
      seed: "2026-08-05/0/deep-foundation",
      events: [
        { type: "vfs.write", payload: { path: "ephemeral", contents: "one" } },
        { type: "vfs.write", payload: { path: "ephemeral", contents: "two" } },
        { type: "vfs.chmod", payload: { path: "ephemeral", mode: "0600" } },
        { type: "vfs.delete", payload: { path: "ephemeral" } },
        { type: "clock.tick", payload: { ms: 1 } },
      ],
    });
    const slice = state.slices["vfs"];
    expect(slice).toBeDefined();
    expect(
      (slice as VfsSlice).entries["/production/service/ephemeral"],
    ).toBeUndefined();
    expect(() => validateVfsSlice(slice, "snapshot: slices.vfs")).not.toThrow();
  });

  it("rejects malformed snapshots at the VFS boundary", () => {
    const slice = fresh();
    expect(() =>
      validateVfsSlice({ ...slice, cwd: "/missing" }, "snapshot"),
    ).toThrow(/cwd/);
    expect(() =>
      validateVfsSlice(
        { ...slice, entries: { "/": slice.entries["/"] } },
        "snapshot",
      ),
    ).toThrow(/cwd/);
    expect(() =>
      validateVfsSlice(
        {
          ...slice,
          entries: { ...slice.entries, "/bad\\name": slice.entries["/"] },
        },
        "snapshot",
      ),
    ).toThrow(/canonical absolute/);
  });

  it("reports compact, actionable VFS snapshot validation failures", () => {
    type Mutable = Record<string, unknown>;
    const entry = (slice: Mutable, path: string): Mutable =>
      (slice["entries"] as Mutable)[path] as Mutable;
    const cases: readonly [string, (slice: Mutable) => void, RegExp][] = [
      [
        "nonplain root",
        (slice) => Object.setPrototypeOf(slice, { inherited: true }),
        /must be a plain JSON object/,
      ],
      [
        "symbol key",
        (slice) => Object.defineProperty(slice, Symbol("extra"), { value: 1 }),
        /symbol-keyed/,
      ],
      [
        "accessor entry",
        (slice) =>
          Object.defineProperty(slice["entries"] as Mutable, "/etc/motd", {
            enumerable: true,
            get: () => entry(slice, "/etc/motd"),
          }),
        /accessors are not inert/,
      ],
      [
        "bad kind",
        (slice) => (entry(slice, "/etc/motd")["kind"] = "link"),
        /file or directory/,
      ],
      [
        "missing contents",
        (slice) => delete entry(slice, "/etc/motd")["contents"],
        /contents: must be a string/,
      ],
      [
        "bad mode",
        (slice) => (entry(slice, "/etc/motd")["mode"] = "bad"),
        /mode: must be four octal/,
      ],
      [
        "bad owner",
        (slice) => (entry(slice, "/etc/motd")["owner"] = "Bad"),
        /owner: must be a POSIX/,
      ],
      [
        "bad group",
        (slice) => (entry(slice, "/etc/motd")["group"] = "Bad"),
        /group: must be a POSIX/,
      ],
      [
        "bad mtime",
        (slice) => (entry(slice, "/etc/motd")["mtime"] = "noon"),
        /mtime: must be a real/,
      ],
      [
        "broken parent",
        (slice) =>
          ((slice["entries"] as Mutable)["/orphan/file"] = {
            ...entry(slice, "/etc/motd"),
          }),
        /parent "\/orphan" must exist/,
      ],
      [
        "missing root",
        (slice) => {
          slice["cwd"] = "/";
          slice["entries"] = {};
        },
        /must contain the root directory/,
      ],
      [
        "bad home",
        (slice) => ((slice["identity"] as Mutable)["home"] = "relative"),
        /home: must be a canonical/,
      ],
      [
        "bad umask",
        (slice) => ((slice["identity"] as Mutable)["umask"] = "9999"),
        /umask: must be four octal/,
      ],
    ];

    for (const [name, change, expected] of cases) {
      const slice = mutableSlice() as unknown as Mutable;
      change(slice);
      expect(() => validateVfsSlice(slice, "snapshot"), name).toThrow(expected);
    }
  });

  it("rejects malformed event payloads with their event context", () => {
    const cases: readonly [
      string,
      Record<string, unknown> | undefined,
      RegExp,
    ][] = [
      ["vfs.read", undefined, /event 0 \(vfs\.read\).*requires a payload/],
      [
        "vfs.write",
        { path: 42, contents: "x" },
        /event 0 \(vfs\.write\).*path must be a string/,
      ],
      [
        "vfs.write",
        { path: "x", contents: "x", extra: true },
        /event 0 \(vfs\.write\).*unexpected payload field/,
      ],
      [
        "vfs.delete",
        { path: "x", recursive: "yes" },
        /event 0 \(vfs\.delete\).*recursive must be a boolean/,
      ],
      [
        "vfs.copy",
        { source: "README.md", destination: "x", preserve: 1 },
        /event 0 \(vfs\.copy\).*preserve must be a boolean/,
      ],
      [
        "vfs.chmod",
        { path: "README.md", mode: "99" },
        /event 0 \(vfs\.chmod\).*mode must be four octal digits/,
      ],
      [
        "vfs.mkdir",
        { path: "x", parents: null },
        /event 0 \(vfs\.mkdir\).*parents must be a boolean/,
      ],
    ];

    for (const [type, payload, expected] of cases) {
      const event = payload === undefined ? { type } : { type, payload };
      expect(() =>
        reduce({
          cartridge,
          seed: "2026-08-05/0/deep-foundation",
          events: [event],
        }),
      ).toThrow(expected);
    }
  });
});
