/** Deterministic, immutable virtual filesystem operations. */

import type { LoadedCartridge } from "../cartridge/types.js";
import { formatTimestamp, parseTimestamp } from "../clock/civil.js";
import {
  ABSOLUTE_PATH_PATTERN,
  FILE_MODE_PATTERN,
} from "../cartridge/schema.js";
import { deepFreeze } from "../freeze.js";
import {
  baseName,
  compareVfsNames,
  isDescendant,
  parentPath,
  resolveVfsPath,
} from "./path.js";
import type {
  VfsCopyOptions,
  VfsDirectoryEntry,
  VfsEntry,
  VfsErrorCode,
  VfsFailure,
  VfsFileEntry,
  VfsListItem,
  VfsMutation,
  VfsReadValue,
  VfsResult,
  VfsSlice,
  VfsStatValue,
} from "./types.js";

type Permission = 1 | 2 | 4;

function frozenSuccess<T>(value: T): VfsResult<T> {
  return deepFreeze({ ok: true, value } as const);
}

function frozenFailure(
  operation: string,
  path: string,
  code: VfsErrorCode,
  reason: string,
): VfsFailure {
  return Object.freeze({
    ok: false,
    code,
    operation,
    path,
    message: `${operation} ${JSON.stringify(path)}: ${code}: ${reason}`,
  });
}

function unchanged<T>(slice: VfsSlice, result: VfsResult<T>): VfsMutation<T> {
  return Object.freeze({ slice, result });
}

function changed<T>(
  slice: VfsSlice,
  entries: Readonly<Record<string, VfsEntry>>,
  result: T,
): VfsMutation<T> {
  return deepFreeze({
    // `deepFreeze` establishes ownership of the result, never of values the
    // caller supplied. Untouched entries must be copied before that boundary.
    slice: {
      cwd: slice.cwd,
      identity: { ...slice.identity },
      entries: Object.fromEntries(
        Object.entries(entries).map(([path, entry]) => [path, { ...entry }]),
      ),
    },
    result: { ok: true, value: result },
  });
}

function invalidNowFailure(
  now: string,
  operation: string,
  path: string,
): VfsFailure | undefined {
  try {
    if (typeof now === "string" && formatTimestamp(parseTimestamp(now)) === now)
      return undefined;
  } catch {}
  return frozenFailure(
    operation,
    path,
    "EINVAL",
    "now must be a real fixed-width UTC instant",
  );
}

function permissionDigit(slice: VfsSlice, entry: VfsEntry): number {
  const offset =
    slice.identity.user === entry.owner
      ? 1
      : slice.identity.group === entry.group
        ? 2
        : 3;
  return Number.parseInt(entry.mode[offset] ?? "0", 8);
}

function permits(slice: VfsSlice, entry: VfsEntry, bit: Permission): boolean {
  return (
    slice.identity.user === "root" ||
    (permissionDigit(slice, entry) & bit) === bit
  );
}

function traversalFailure(
  slice: VfsSlice,
  path: string,
  operation: string,
): VfsFailure | undefined {
  const segments = path.split("/").filter((segment) => segment !== "");
  let current = "/";
  for (let index = 0; index < segments.length - 1; index += 1) {
    current =
      current === "/" ? `/${segments[index]}` : `${current}/${segments[index]}`;
    const entry = slice.entries[current];
    if (entry === undefined)
      return frozenFailure(
        operation,
        current,
        "ENOENT",
        "an intermediate directory does not exist",
      );
    if (entry.kind !== "directory")
      return frozenFailure(
        operation,
        current,
        "ENOTDIR",
        "an intermediate path is not a directory",
      );
    if (!permits(slice, entry, 1))
      return frozenFailure(
        operation,
        current,
        "EACCES",
        "search permission is denied",
      );
  }
  return undefined;
}

function writableParentFailure(
  slice: VfsSlice,
  path: string,
  operation: string,
): VfsFailure | undefined {
  const traversal = traversalFailure(slice, path, operation);
  if (traversal !== undefined) return traversal;
  const parent = parentPath(path);
  const entry = slice.entries[parent];
  if (entry === undefined)
    return frozenFailure(
      operation,
      parent,
      "ENOENT",
      "the parent directory does not exist",
    );
  if (entry.kind !== "directory")
    return frozenFailure(
      operation,
      parent,
      "ENOTDIR",
      "the parent path is not a directory",
    );
  if (!permits(slice, entry, 1) || !permits(slice, entry, 2))
    return frozenFailure(
      operation,
      parent,
      "EACCES",
      "write and search permission on the parent is required",
    );
  return undefined;
}

/**
 * Resolution deliberately accepts shell spellings such as `.` and `..`; after
 * it has canonicalized those, a mutation must still refuse a segment a slice
 * cannot serialize and later restore. Otherwise `writeVfs(slice, "bad\\name")`
 * reports success while returning a slice `validateVfsSlice` rejects.
 */
function invalidMutationPathFailure(
  path: string,
  operation: string,
): VfsFailure | undefined {
  return ABSOLUTE_PATH_PATTERN.test(path)
    ? undefined
    : frozenFailure(
        operation,
        path,
        "EINVAL",
        "the path contains an invalid name",
      );
}

function maskedMode(base: number, umask: string): string {
  const mask = Number.parseInt(umask, 8);
  return (base & ~mask).toString(8).padStart(4, "0");
}

function withParentMtime(
  entries: Readonly<Record<string, VfsEntry>>,
  path: string,
  now: string,
): Readonly<Record<string, VfsEntry>> {
  const parent = parentPath(path);
  const entry = entries[parent];
  if (entry === undefined || entry.kind !== "directory") return entries;
  return { ...entries, [parent]: { ...entry, mtime: now } };
}

function declaredOrImplicitDirectory(
  cartridge: LoadedCartridge,
  path: string,
  entries: Readonly<Record<string, VfsEntry>>,
): VfsDirectoryEntry {
  const declared = cartridge.repository.directories[path];
  if (declared !== undefined) return { kind: "directory", ...declared };
  const parent = entries[parentPath(path)];
  return {
    kind: "directory",
    mode: "0755",
    owner: parent?.owner ?? "root",
    group: parent?.group ?? "root",
    mtime: cartridge.meta.startedAt,
  };
}

/** Hydrate files, declared directories, cwd, and all required ancestors. */
export function createVfsSlice(cartridge: LoadedCartridge): VfsSlice {
  const directoryPaths = new Set<string>(["/", cartridge.repository.cwd]);
  const addAncestors = (path: string): void => {
    let current = path;
    while (true) {
      directoryPaths.add(current);
      if (current === "/") return;
      current = parentPath(current);
    }
  };
  for (const path of Object.keys(cartridge.repository.directories))
    addAncestors(path);
  for (const path of Object.keys(cartridge.repository.files))
    addAncestors(parentPath(path));

  let entries: Readonly<Record<string, VfsEntry>> = {};
  const orderedDirectories = [...directoryPaths].sort(
    (left, right) =>
      left.split("/").length - right.split("/").length ||
      compareVfsNames(left, right),
  );
  for (const path of orderedDirectories) {
    entries = {
      ...entries,
      [path]: declaredOrImplicitDirectory(cartridge, path, entries),
    };
  }
  for (const path of Object.keys(cartridge.repository.files).sort(
    compareVfsNames,
  )) {
    entries = {
      ...entries,
      [path]: {
        kind: "file",
        ...cartridge.repository.files[path],
      } as VfsFileEntry,
    };
  }
  return deepFreeze({
    cwd: cartridge.repository.cwd,
    identity: cartridge.repository.identity,
    entries,
  });
}

export function readVfs(
  slice: VfsSlice,
  input: string,
): VfsResult<VfsReadValue> {
  const resolved = resolveVfsPath(input, slice.cwd, slice.identity.home);
  const denied = traversalFailure(slice, resolved.path, "read");
  if (denied !== undefined) return denied;
  const entry = slice.entries[resolved.path];
  if (entry === undefined)
    return frozenFailure("read", resolved.path, "ENOENT", "no such file");
  if (resolved.trailingSlash && entry.kind !== "directory")
    return frozenFailure(
      "read",
      resolved.path,
      "ENOTDIR",
      "a trailing slash requires a directory",
    );
  if (entry.kind === "directory")
    return frozenFailure(
      "read",
      resolved.path,
      "EISDIR",
      "the path is a directory",
    );
  if (!permits(slice, entry, 4))
    return frozenFailure(
      "read",
      resolved.path,
      "EACCES",
      "read permission is denied",
    );
  return frozenSuccess({ path: resolved.path, contents: entry.contents });
}

/** Look up metadata after enforcing search permission on every ancestor. */
export function statVfs(
  slice: VfsSlice,
  input: string,
): VfsResult<VfsStatValue> {
  const resolved = resolveVfsPath(input, slice.cwd, slice.identity.home);
  const denied = traversalFailure(slice, resolved.path, "stat");
  if (denied !== undefined) return denied;
  const entry = slice.entries[resolved.path];
  if (entry === undefined)
    return frozenFailure("stat", resolved.path, "ENOENT", "no such path");
  if (resolved.trailingSlash && entry.kind !== "directory")
    return frozenFailure(
      "stat",
      resolved.path,
      "ENOTDIR",
      "a trailing slash requires a directory",
    );
  return frozenSuccess({ path: resolved.path, entry: { ...entry } });
}

export function listVfs(
  slice: VfsSlice,
  input: string,
): VfsResult<readonly VfsListItem[]> {
  const resolved = resolveVfsPath(input, slice.cwd, slice.identity.home);
  const denied = traversalFailure(slice, resolved.path, "list");
  if (denied !== undefined) return denied;
  const entry = slice.entries[resolved.path];
  if (entry === undefined)
    return frozenFailure("list", resolved.path, "ENOENT", "no such directory");
  if (entry.kind !== "directory")
    return frozenFailure(
      "list",
      resolved.path,
      "ENOTDIR",
      "the path is not a directory",
    );
  if (!permits(slice, entry, 4) || !permits(slice, entry, 1))
    return frozenFailure(
      "list",
      resolved.path,
      "EACCES",
      "read and search permission are required",
    );
  const items = Object.entries(slice.entries)
    .filter(
      ([path]) => path !== resolved.path && parentPath(path) === resolved.path,
    )
    .map(([path, child]) => ({
      name: baseName(path),
      path,
      entry: { ...child },
    }))
    .sort((left, right) => compareVfsNames(left.name, right.name));
  return frozenSuccess(items);
}

export function writeVfs(
  slice: VfsSlice,
  input: string,
  contents: string,
  now: string,
): VfsMutation<{ readonly path: string; readonly created: boolean }> {
  const resolved = resolveVfsPath(input, slice.cwd, slice.identity.home);
  const invalid = invalidMutationPathFailure(resolved.path, "write");
  if (invalid !== undefined) return unchanged(slice, invalid);
  const invalidNow = invalidNowFailure(now, "write", resolved.path);
  if (invalidNow !== undefined) return unchanged(slice, invalidNow);
  if (resolved.trailingSlash)
    return unchanged(
      slice,
      frozenFailure(
        "write",
        resolved.path,
        "EISDIR",
        "a trailing slash requires a directory",
      ),
    );
  const existing = slice.entries[resolved.path];
  if (existing !== undefined) {
    const denied = traversalFailure(slice, resolved.path, "write");
    if (denied !== undefined) return unchanged(slice, denied);
    if (existing.kind === "directory")
      return unchanged(
        slice,
        frozenFailure(
          "write",
          resolved.path,
          "EISDIR",
          "the path is a directory",
        ),
      );
    if (!permits(slice, existing, 2))
      return unchanged(
        slice,
        frozenFailure(
          "write",
          resolved.path,
          "EACCES",
          "write permission is denied",
        ),
      );
    return changed(
      slice,
      {
        ...slice.entries,
        [resolved.path]: { ...existing, contents, mtime: now },
      },
      {
        path: resolved.path,
        created: false,
      },
    );
  }
  const denied = writableParentFailure(slice, resolved.path, "write");
  if (denied !== undefined) return unchanged(slice, denied);
  const file: VfsFileEntry = {
    kind: "file",
    contents,
    mode: maskedMode(0o666, slice.identity.umask),
    owner: slice.identity.user,
    group: slice.identity.group,
    mtime: now,
  };
  const entries = withParentMtime(
    { ...slice.entries, [resolved.path]: file },
    resolved.path,
    now,
  );
  return changed(slice, entries, { path: resolved.path, created: true });
}

/** Create an empty file or update an existing entry's mtime. */
export function touchVfs(
  slice: VfsSlice,
  input: string,
  now: string,
): VfsMutation<{ readonly path: string; readonly created: boolean }> {
  const resolved = resolveVfsPath(input, slice.cwd, slice.identity.home);
  const existing = slice.entries[resolved.path];
  if (existing === undefined) return writeVfs(slice, input, "", now);
  const invalid = invalidMutationPathFailure(resolved.path, "touch");
  if (invalid !== undefined) return unchanged(slice, invalid);
  const invalidNow = invalidNowFailure(now, "touch", resolved.path);
  if (invalidNow !== undefined) return unchanged(slice, invalidNow);
  const denied = traversalFailure(slice, resolved.path, "touch");
  if (denied !== undefined) return unchanged(slice, denied);
  if (resolved.trailingSlash && existing.kind !== "directory")
    return unchanged(
      slice,
      frozenFailure(
        "touch",
        resolved.path,
        "ENOTDIR",
        "a trailing slash requires a directory",
      ),
    );
  if (
    slice.identity.user !== "root" &&
    slice.identity.user !== existing.owner &&
    !permits(slice, existing, 2)
  )
    return unchanged(
      slice,
      frozenFailure(
        "touch",
        resolved.path,
        "EACCES",
        "write permission is denied",
      ),
    );
  return changed(
    slice,
    { ...slice.entries, [resolved.path]: { ...existing, mtime: now } },
    { path: resolved.path, created: false },
  );
}

/** Change the persisted working directory after enforcing search permission. */
export function chdirVfs(
  slice: VfsSlice,
  input: string,
): VfsMutation<{ readonly path: string }> {
  const resolved = resolveVfsPath(input, slice.cwd, slice.identity.home);
  const denied = traversalFailure(slice, resolved.path, "chdir");
  if (denied !== undefined) return unchanged(slice, denied);
  const entry = slice.entries[resolved.path];
  if (entry === undefined)
    return unchanged(
      slice,
      frozenFailure("chdir", resolved.path, "ENOENT", "no such directory"),
    );
  if (entry.kind !== "directory")
    return unchanged(
      slice,
      frozenFailure("chdir", resolved.path, "ENOTDIR", "not a directory"),
    );
  if (!permits(slice, entry, 1))
    return unchanged(
      slice,
      frozenFailure(
        "chdir",
        resolved.path,
        "EACCES",
        "search permission is denied",
      ),
    );
  if (resolved.path === slice.cwd)
    return unchanged(slice, frozenSuccess({ path: resolved.path }));
  return deepFreeze({
    slice: {
      cwd: resolved.path,
      identity: { ...slice.identity },
      entries: Object.fromEntries(
        Object.entries(slice.entries).map(([path, current]) => [
          path,
          { ...current },
        ]),
      ),
    },
    result: { ok: true, value: { path: resolved.path } },
  });
}

export function mkdirVfs(
  slice: VfsSlice,
  input: string,
  now: string,
  parents = false,
): VfsMutation<{ readonly paths: readonly string[] }> {
  const resolved = resolveVfsPath(input, slice.cwd, slice.identity.home);
  const invalid = invalidMutationPathFailure(resolved.path, "mkdir");
  if (invalid !== undefined) return unchanged(slice, invalid);
  const invalidNow = invalidNowFailure(now, "mkdir", resolved.path);
  if (invalidNow !== undefined) return unchanged(slice, invalidNow);
  if (resolved.path === "/") {
    return parents
      ? unchanged(slice, frozenSuccess({ paths: [] }))
      : unchanged(
          slice,
          frozenFailure("mkdir", "/", "EEXIST", "the directory already exists"),
        );
  }
  const existing = slice.entries[resolved.path];
  if (existing !== undefined) {
    const denied = traversalFailure(slice, resolved.path, "mkdir");
    if (denied !== undefined) return unchanged(slice, denied);
    return parents && existing.kind === "directory"
      ? unchanged(slice, frozenSuccess({ paths: [] }))
      : unchanged(
          slice,
          frozenFailure(
            "mkdir",
            resolved.path,
            "EEXIST",
            "the path already exists",
          ),
        );
  }

  const missing: string[] = [];
  let cursor = resolved.path;
  while (slice.entries[cursor] === undefined && cursor !== "/") {
    missing.push(cursor);
    cursor = parentPath(cursor);
  }
  missing.reverse();
  if (!parents && missing.length > 1)
    return unchanged(
      slice,
      frozenFailure(
        "mkdir",
        parentPath(resolved.path),
        "ENOENT",
        "the parent directory does not exist",
      ),
    );

  let entries = slice.entries;
  for (const path of missing) {
    const currentSlice: VfsSlice = { ...slice, entries };
    const denied = writableParentFailure(currentSlice, path, "mkdir");
    if (denied !== undefined) return unchanged(slice, denied);
    const directory: VfsDirectoryEntry = {
      kind: "directory",
      mode: maskedMode(0o777, slice.identity.umask),
      owner: slice.identity.user,
      group: slice.identity.group,
      mtime: now,
    };
    entries = withParentMtime({ ...entries, [path]: directory }, path, now);
  }
  return changed(slice, entries, { paths: missing });
}

function recursivePermissionFailure(
  slice: VfsSlice,
  root: string,
  operation: string,
): VfsFailure | undefined {
  const allPaths = Object.keys(slice.entries).filter(
    (path) => path === root || isDescendant(path, root),
  );
  const directories = Object.entries(slice.entries)
    .filter(
      ([path, entry]) =>
        entry.kind === "directory" &&
        (path === root || isDescendant(path, root)) &&
        allPaths.some((candidate) => parentPath(candidate) === path),
    )
    .sort(([left], [right]) => compareVfsNames(left, right));
  for (const [path, entry] of directories) {
    if (!permits(slice, entry, 1) || !permits(slice, entry, 2))
      return frozenFailure(
        operation,
        path,
        "EACCES",
        "recursive mutation requires write and search permission",
      );
  }
  return undefined;
}

function recursiveReadFailure(
  slice: VfsSlice,
  root: string,
  operation: string,
): VfsFailure | undefined {
  const entries = Object.entries(slice.entries)
    .filter(([path]) => path === root || isDescendant(path, root))
    .sort(([left], [right]) => compareVfsNames(left, right));
  for (const [path, entry] of entries) {
    const allowed =
      entry.kind === "directory"
        ? permits(slice, entry, 4) && permits(slice, entry, 1)
        : permits(slice, entry, 4);
    if (!allowed)
      return frozenFailure(
        operation,
        path,
        "EACCES",
        entry.kind === "directory"
          ? "recursive copy requires read and search permission"
          : "read permission is denied",
      );
  }
  return undefined;
}

export function deleteVfs(
  slice: VfsSlice,
  input: string,
  now: string,
  recursive = false,
  refuseDirectory = false,
): VfsMutation<{ readonly path: string; readonly removed: number }> {
  const resolved = resolveVfsPath(input, slice.cwd, slice.identity.home);
  const invalid = invalidMutationPathFailure(resolved.path, "delete");
  if (invalid !== undefined) return unchanged(slice, invalid);
  const invalidNow = invalidNowFailure(now, "delete", resolved.path);
  if (invalidNow !== undefined) return unchanged(slice, invalidNow);
  if (resolved.path === "/")
    return unchanged(
      slice,
      frozenFailure(
        "delete",
        "/",
        "EBUSY",
        "the filesystem root cannot be deleted",
      ),
    );
  if (resolved.path === slice.cwd || isDescendant(slice.cwd, resolved.path))
    return unchanged(
      slice,
      frozenFailure(
        "delete",
        resolved.path,
        "EBUSY",
        "the working directory or one of its ancestors cannot be deleted",
      ),
    );
  const entry = slice.entries[resolved.path];
  if (entry === undefined)
    return unchanged(
      slice,
      frozenFailure("delete", resolved.path, "ENOENT", "no such path"),
    );
  if (resolved.trailingSlash && entry.kind !== "directory")
    return unchanged(
      slice,
      frozenFailure(
        "delete",
        resolved.path,
        "ENOTDIR",
        "a trailing slash requires a directory",
      ),
    );
  if (entry.kind === "directory" && refuseDirectory)
    return unchanged(
      slice,
      frozenFailure(
        "delete",
        resolved.path,
        "EISDIR",
        "directory removal is disabled for this operation",
      ),
    );
  const denied = writableParentFailure(slice, resolved.path, "delete");
  if (denied !== undefined) return unchanged(slice, denied);
  const children = Object.keys(slice.entries).filter((path) =>
    isDescendant(path, resolved.path),
  );
  if (entry.kind === "directory" && children.length > 0 && !recursive)
    return unchanged(
      slice,
      frozenFailure(
        "delete",
        resolved.path,
        "ENOTEMPTY",
        "the directory is not empty",
      ),
    );
  if (recursive && entry.kind === "directory") {
    const nestedDenied = recursivePermissionFailure(
      slice,
      resolved.path,
      "delete",
    );
    if (nestedDenied !== undefined) return unchanged(slice, nestedDenied);
  }
  const removed = new Set([resolved.path, ...children]);
  const entries = withParentMtime(
    Object.fromEntries(
      Object.entries(slice.entries).filter(([path]) => !removed.has(path)),
    ),
    resolved.path,
    now,
  );
  return changed(slice, entries, {
    path: resolved.path,
    removed: removed.size,
  });
}

function destinationPath(
  slice: VfsSlice,
  source: string,
  destination: string,
): string {
  const entry = slice.entries[destination];
  return entry?.kind === "directory"
    ? `${destination === "/" ? "" : destination}/${baseName(source)}`
    : destination;
}

export function renameVfs(
  slice: VfsSlice,
  sourceInput: string,
  destinationInput: string,
  now: string,
): VfsMutation<{ readonly from: string; readonly to: string }> {
  const source = resolveVfsPath(sourceInput, slice.cwd, slice.identity.home);
  const authoredDestination = resolveVfsPath(
    destinationInput,
    slice.cwd,
    slice.identity.home,
  );
  const invalidSource = invalidMutationPathFailure(source.path, "rename");
  if (invalidSource !== undefined) return unchanged(slice, invalidSource);
  const invalidDestination = invalidMutationPathFailure(
    authoredDestination.path,
    "rename",
  );
  if (invalidDestination !== undefined)
    return unchanged(slice, invalidDestination);
  const invalidNow = invalidNowFailure(now, "rename", source.path);
  if (invalidNow !== undefined) return unchanged(slice, invalidNow);
  const sourceEntry = slice.entries[source.path];
  if (sourceEntry === undefined)
    return unchanged(
      slice,
      frozenFailure(
        "rename",
        source.path,
        "ENOENT",
        "the source does not exist",
      ),
    );
  if (source.path === "/")
    return unchanged(
      slice,
      frozenFailure(
        "rename",
        source.path,
        "EBUSY",
        "the filesystem root cannot be moved",
      ),
    );
  if (source.path === slice.cwd || isDescendant(slice.cwd, source.path))
    return unchanged(
      slice,
      frozenFailure(
        "rename",
        source.path,
        "EBUSY",
        "the working directory or one of its ancestors cannot be moved",
      ),
    );
  if (source.trailingSlash && sourceEntry.kind !== "directory")
    return unchanged(
      slice,
      frozenFailure(
        "rename",
        source.path,
        "ENOTDIR",
        "a trailing slash requires a directory",
      ),
    );
  const destination = destinationPath(
    slice,
    source.path,
    authoredDestination.path,
  );
  if (authoredDestination.trailingSlash) {
    const destinationEntry = slice.entries[authoredDestination.path];
    if (destinationEntry === undefined)
      return unchanged(
        slice,
        frozenFailure(
          "rename",
          authoredDestination.path,
          "ENOENT",
          "a trailing-slash destination must be an existing directory",
        ),
      );
    if (destinationEntry.kind !== "directory")
      return unchanged(
        slice,
        frozenFailure(
          "rename",
          authoredDestination.path,
          "ENOTDIR",
          "a trailing-slash destination must be a directory",
        ),
      );
  }
  if (destination === source.path)
    return unchanged(
      slice,
      frozenSuccess({ from: source.path, to: destination }),
    );
  if (slice.entries[destination] !== undefined)
    return unchanged(
      slice,
      frozenFailure(
        "rename",
        destination,
        "EEXIST",
        "the destination already exists",
      ),
    );
  if (
    sourceEntry.kind === "directory" &&
    isDescendant(destination, source.path)
  )
    return unchanged(
      slice,
      frozenFailure(
        "rename",
        destination,
        "EINVAL",
        "a directory cannot be moved inside itself",
      ),
    );
  const sourceDenied = writableParentFailure(slice, source.path, "rename");
  if (sourceDenied !== undefined) return unchanged(slice, sourceDenied);
  const destinationDenied = writableParentFailure(slice, destination, "rename");
  if (destinationDenied !== undefined)
    return unchanged(slice, destinationDenied);

  const moved = Object.entries(slice.entries).filter(
    ([path]) => path === source.path || isDescendant(path, source.path),
  );
  const movedPaths = new Set(moved.map(([path]) => path));
  let entries: Readonly<Record<string, VfsEntry>> = Object.fromEntries(
    Object.entries(slice.entries).filter(([path]) => !movedPaths.has(path)),
  );
  for (const [path, entry] of moved) {
    entries = {
      ...entries,
      [destination + path.slice(source.path.length)]: entry,
    };
  }
  entries = withParentMtime(entries, source.path, now);
  entries = withParentMtime(entries, destination, now);
  return changed(slice, entries, { from: source.path, to: destination });
}

function copiedEntry(
  slice: VfsSlice,
  entry: VfsEntry,
  now: string,
  preserve: boolean,
): VfsEntry {
  if (preserve) return { ...entry };
  const metadata = {
    mode: maskedMode(
      entry.kind === "file" ? 0o666 : 0o777,
      slice.identity.umask,
    ),
    owner: slice.identity.user,
    group: slice.identity.group,
    mtime: now,
  };
  return entry.kind === "file"
    ? { kind: "file", contents: entry.contents, ...metadata }
    : { kind: "directory", ...metadata };
}

export function copyVfs(
  slice: VfsSlice,
  sourceInput: string,
  destinationInput: string,
  now: string,
  options: VfsCopyOptions = {},
): VfsMutation<{
  readonly from: string;
  readonly to: string;
  readonly copied: number;
}> {
  const source = resolveVfsPath(sourceInput, slice.cwd, slice.identity.home);
  const authoredDestination = resolveVfsPath(
    destinationInput,
    slice.cwd,
    slice.identity.home,
  );
  const invalidSource = invalidMutationPathFailure(source.path, "copy");
  if (invalidSource !== undefined) return unchanged(slice, invalidSource);
  const invalidDestination = invalidMutationPathFailure(
    authoredDestination.path,
    "copy",
  );
  if (invalidDestination !== undefined)
    return unchanged(slice, invalidDestination);
  const invalidNow = invalidNowFailure(now, "copy", source.path);
  if (invalidNow !== undefined) return unchanged(slice, invalidNow);
  const sourceEntry = slice.entries[source.path];
  if (sourceEntry === undefined)
    return unchanged(
      slice,
      frozenFailure("copy", source.path, "ENOENT", "the source does not exist"),
    );
  if (source.trailingSlash && sourceEntry.kind !== "directory")
    return unchanged(
      slice,
      frozenFailure(
        "copy",
        source.path,
        "ENOTDIR",
        "a trailing slash requires a directory",
      ),
    );
  const sourceDenied = traversalFailure(slice, source.path, "copy");
  if (sourceDenied !== undefined) return unchanged(slice, sourceDenied);
  if (sourceEntry.kind === "file" && !permits(slice, sourceEntry, 4))
    return unchanged(
      slice,
      frozenFailure("copy", source.path, "EACCES", "read permission is denied"),
    );
  if (sourceEntry.kind === "directory" && !options.recursive)
    return unchanged(
      slice,
      frozenFailure(
        "copy",
        source.path,
        "EISDIR",
        "copying a directory requires recursive mode",
      ),
    );
  if (authoredDestination.trailingSlash) {
    const destinationEntry = slice.entries[authoredDestination.path];
    if (destinationEntry === undefined)
      return unchanged(
        slice,
        frozenFailure(
          "copy",
          authoredDestination.path,
          "ENOENT",
          "a trailing-slash destination must be an existing directory",
        ),
      );
    if (destinationEntry.kind !== "directory")
      return unchanged(
        slice,
        frozenFailure(
          "copy",
          authoredDestination.path,
          "ENOTDIR",
          "a trailing-slash destination must be a directory",
        ),
      );
  }
  const destination = destinationPath(
    slice,
    source.path,
    authoredDestination.path,
  );
  if (slice.entries[destination] !== undefined)
    return unchanged(
      slice,
      frozenFailure(
        "copy",
        destination,
        "EEXIST",
        "the destination already exists",
      ),
    );
  if (
    sourceEntry.kind === "directory" &&
    isDescendant(destination, source.path)
  )
    return unchanged(
      slice,
      frozenFailure(
        "copy",
        destination,
        "EINVAL",
        "a directory cannot be copied inside itself",
      ),
    );
  const destinationDenied = writableParentFailure(slice, destination, "copy");
  if (destinationDenied !== undefined)
    return unchanged(slice, destinationDenied);
  if (sourceEntry.kind === "directory") {
    const nestedDenied = recursiveReadFailure(slice, source.path, "copy");
    if (nestedDenied !== undefined) return unchanged(slice, nestedDenied);
  }

  const sourceEntries = Object.entries(slice.entries)
    .filter(([path]) => path === source.path || isDescendant(path, source.path))
    .sort(([left], [right]) => compareVfsNames(left, right));
  let entries = slice.entries;
  for (const [path, entry] of sourceEntries) {
    entries = {
      ...entries,
      [destination + path.slice(source.path.length)]: copiedEntry(
        slice,
        entry,
        now,
        options.preserve === true,
      ),
    };
  }
  entries = withParentMtime(entries, destination, now);
  return changed(slice, entries, {
    from: source.path,
    to: destination,
    copied: sourceEntries.length,
  });
}

export function chmodVfs(
  slice: VfsSlice,
  input: string,
  mode: string,
): VfsMutation<{ readonly path: string; readonly mode: string }> {
  const resolved = resolveVfsPath(input, slice.cwd, slice.identity.home);
  const invalid = invalidMutationPathFailure(resolved.path, "chmod");
  if (invalid !== undefined) return unchanged(slice, invalid);
  if (!FILE_MODE_PATTERN.test(mode))
    return unchanged(
      slice,
      frozenFailure(
        "chmod",
        resolved.path,
        "EINVAL",
        "mode must be four octal digits",
      ),
    );
  const denied = traversalFailure(slice, resolved.path, "chmod");
  if (denied !== undefined) return unchanged(slice, denied);
  const entry = slice.entries[resolved.path];
  if (entry === undefined)
    return unchanged(
      slice,
      frozenFailure("chmod", resolved.path, "ENOENT", "no such path"),
    );
  if (resolved.trailingSlash && entry.kind !== "directory")
    return unchanged(
      slice,
      frozenFailure(
        "chmod",
        resolved.path,
        "ENOTDIR",
        "a trailing slash requires a directory",
      ),
    );
  if (slice.identity.user !== "root" && slice.identity.user !== entry.owner)
    return unchanged(
      slice,
      frozenFailure(
        "chmod",
        resolved.path,
        "EPERM",
        "only the owner or root may change mode",
      ),
    );
  return changed(
    slice,
    { ...slice.entries, [resolved.path]: { ...entry, mode } },
    {
      path: resolved.path,
      mode,
    },
  );
}

/**
 * Atomically replace a set of regular files through ordinary VFS operations.
 * Git checkout uses this rather than editing `entries`: VFS retains ownership
 * of permissions, metadata, path checks, and the all-or-nothing result.
 */
export function replaceVfsFiles(
  slice: VfsSlice,
  tracked: readonly string[],
  target: Readonly<Record<string, string>>,
  now: string,
): VfsMutation<{ readonly removed: number; readonly written: number }> {
  let next = slice;
  let removed = 0;
  let written = 0;
  for (const path of [...new Set(tracked)].sort()) {
    if (Object.hasOwn(target, path)) continue;
    const mutation = deleteVfs(next, path, now);
    if (!mutation.result.ok) return unchanged(slice, mutation.result);
    next = mutation.slice;
    removed += 1;
  }
  for (const path of Object.keys(target).sort()) {
    const contents = target[path] as string;
    const existing = next.entries[path];
    if (existing?.kind === "file" && existing.contents === contents) continue;
    const mutation = writeVfs(next, path, contents, now);
    if (!mutation.result.ok) return unchanged(slice, mutation.result);
    next = mutation.slice;
    written += 1;
  }
  return Object.freeze({
    slice: next,
    result: frozenSuccess({ removed, written }),
  });
}
