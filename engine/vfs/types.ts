export interface VfsIdentity {
  readonly user: string;
  readonly group: string;
  readonly home: string;
  readonly umask: string;
}

export interface VfsDirectoryEntry {
  readonly kind: "directory";
  readonly mode: string;
  readonly owner: string;
  readonly group: string;
  readonly mtime: string;
}

export interface VfsFileEntry {
  readonly kind: "file";
  readonly contents: string;
  readonly mode: string;
  readonly owner: string;
  readonly group: string;
  readonly mtime: string;
}

export type VfsEntry = VfsDirectoryEntry | VfsFileEntry;

/** Canonical flat JSON representation; path keys reconstruct the tree exactly. */
export interface VfsSlice {
  readonly cwd: string;
  readonly identity: VfsIdentity;
  readonly entries: Readonly<Record<string, VfsEntry>>;
}

/** Permission-free machine truth used only for typed belief comparison. */
export type VfsTruth =
  | { readonly kind: "missing" }
  | { readonly kind: "directory" }
  | { readonly kind: "file"; readonly contents: string };

export type VfsErrorCode =
  | "EACCES"
  | "EBUSY"
  | "EEXIST"
  | "EINVAL"
  | "EISDIR"
  | "ENOENT"
  | "ENOTDIR"
  | "ENOTEMPTY"
  | "EPERM";

export interface VfsFailure {
  readonly ok: false;
  readonly code: VfsErrorCode;
  readonly operation: string;
  readonly path: string;
  readonly message: string;
}

export interface VfsSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

export type VfsResult<T> = VfsSuccess<T> | VfsFailure;

export interface VfsMutation<T> {
  readonly slice: VfsSlice;
  readonly result: VfsResult<T>;
}

export interface VfsReadValue {
  readonly path: string;
  readonly contents: string;
}

export interface VfsStatValue {
  readonly path: string;
  readonly entry: VfsEntry;
}

export interface VfsListItem {
  readonly name: string;
  readonly path: string;
  readonly entry: VfsEntry;
}

export interface VfsCopyOptions {
  readonly recursive?: boolean;
  readonly preserve?: boolean;
}
