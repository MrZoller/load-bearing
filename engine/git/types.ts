export interface GitAuthor {
  readonly name: string;
  readonly email: string;
}

export interface GitFileSnapshot {
  readonly contents: string;
  /** Content-derived commit hash per logical line. */
  readonly blame: readonly string[];
}

export interface GitCommit {
  readonly id: string;
  readonly hash: string;
  readonly parents: readonly string[];
  readonly author: GitAuthor;
  readonly message: string;
  readonly committedAt: string;
  readonly files: Readonly<Record<string, GitFileSnapshot>>;
}

export interface GitHead {
  readonly kind: "branch" | "detached";
  /** Branch name for branch HEAD, content hash for detached HEAD. */
  readonly target: string;
}

export interface GitSlice {
  readonly root: string;
  readonly identity: GitAuthor;
  readonly commits: Readonly<Record<string, GitCommit>>;
  readonly branches: Readonly<Record<string, string>>;
  readonly head: GitHead;
  /** Staged tracked contents. Absence means deletion or untracked. */
  readonly index: Readonly<Record<string, string>>;
}

export type GitChange = "added" | "modified" | "deleted";

export interface GitStatusEntry {
  readonly path: string;
  readonly staged: GitChange | null;
  readonly working: GitChange | null;
  readonly untracked: boolean;
}

export interface GitBlameLine {
  readonly line: number;
  readonly text: string;
  readonly hash: string;
  readonly author: GitAuthor;
  readonly committedAt: string;
}

export type GitDiffLineKind = "context" | "addition" | "deletion";

export interface GitDiffLine {
  readonly kind: GitDiffLineKind;
  readonly text: string;
}

export interface GitDiffFile {
  readonly path: string;
  readonly oldContents: string | null;
  readonly newContents: string | null;
  readonly lines: readonly GitDiffLine[];
}

export type GitDiffComparison = "working-index" | "index-head" | "working-head";

export type GitErrorCode = "DIRTY" | "INVALID" | "NOT_FOUND" | "VFS";

export interface GitFailure {
  readonly ok: false;
  readonly code: GitErrorCode;
  readonly message: string;
}

export interface GitSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

export type GitResult<T> = GitSuccess<T> | GitFailure;

export interface GitMutation<T> {
  readonly slice: GitSlice;
  readonly result: GitResult<T>;
}

export interface GitCheckoutMutation {
  readonly git: GitSlice;
  readonly vfs: import("../vfs/types.js").VfsSlice;
  readonly result: GitResult<{
    readonly head: GitHead;
    readonly hash: string;
  }>;
}

export interface GitVfsPlan {
  readonly tracked: readonly string[];
  readonly target: Readonly<Record<string, string>>;
}

export interface GitRestoreMutation {
  readonly slice: GitSlice;
  readonly plan: GitVfsPlan | null;
  readonly result: GitResult<{ readonly path: string }>;
}

export interface GitShowValue {
  readonly commit: GitCommit;
  readonly files: readonly GitDiffFile[];
}
