import { describe, expect, it } from "vitest";

import { loadCartridge } from "../cartridge/load.js";
import { reduce } from "../events/reduce.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
import { validateVfsSlice } from "./module.js";
import { compareVfsNames, resolveVfsPath } from "./path.js";
import type { VfsEntry, VfsSlice } from "./types.js";
import {
  chmodVfs,
  copyVfs,
  createVfsSlice,
  deleteVfs,
  listVfs,
  mkdirVfs,
  readVfs,
  renameVfs,
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
});

describe("VFS permissions and mutations", () => {
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

  it("makes mkdir atomic, supports -p, and updates parent mtimes", () => {
    const slice = fresh();
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
});
