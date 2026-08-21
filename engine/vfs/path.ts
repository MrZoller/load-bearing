/** Pure POSIX path handling for the simulated filesystem. */

export interface ResolvedPath {
  readonly path: string;
  /** Whether the authored spelling requires the result to be a directory. */
  readonly trailingSlash: boolean;
}

/** Resolve without consulting the host filesystem or host path rules. */
export function resolveVfsPath(
  input: string,
  cwd: string,
  home: string,
): ResolvedPath {
  if (input === "") return { path: "", trailingSlash: false };
  const expanded =
    input === "~"
      ? home
      : input.startsWith("~/")
        ? home + input.slice(1)
        : input;
  const absolute = expanded.startsWith("/")
    ? expanded
    : `${cwd === "/" ? "" : cwd}/${expanded}`;
  const parts: string[] = [];
  for (const segment of absolute.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return {
    path: parts.length === 0 ? "/" : `/${parts.join("/")}`,
    trailingSlash: input.length > 1 && input.endsWith("/"),
  };
}

/** Paths that the authored spelling must traverse as directories. */
export function vfsTraversalPaths(
  input: string,
  cwd: string,
  home: string,
): readonly string[] {
  const expanded =
    input === "~"
      ? home
      : input.startsWith("~/")
        ? home + input.slice(1)
        : input;
  const absolute = expanded.startsWith("/")
    ? expanded
    : `${cwd === "/" ? "" : cwd}/${expanded}`;
  const segments = absolute.split("/");
  const parts: string[] = [];
  const traversed: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === "") continue;
    if (segment === ".") {
      if (parts.length > 0) traversed.push(`/${parts.join("/")}`);
      continue;
    }
    if (segment === "..") {
      if (parts.length > 0) traversed.push(`/${parts.join("/")}`);
      parts.pop();
      continue;
    }
    parts.push(segment as string);
    if (segments.slice(index + 1).some((part) => part !== ""))
      traversed.push(`/${parts.join("/")}`);
  }
  return traversed;
}

export function parentPath(path: string): string {
  if (path === "/") return "/";
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

export function baseName(path: string): string {
  return path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1);
}

export function isDescendant(path: string, ancestor: string): boolean {
  return ancestor === "/" ? path !== "/" : path.startsWith(`${ancestor}/`);
}

/** Segment-safe containment including the root itself; `/` contains every path. */
export function isAtOrBelow(path: string, root: string): boolean {
  return path === root || isDescendant(path, root);
}

/**
 * Unicode code-point order, independent of locale and UTF-16 surrogate width.
 * The shorter string sorts first when one is a prefix of the other.
 */
export function compareVfsNames(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const count = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < count; index += 1) {
    const a = leftPoints[index]?.codePointAt(0) ?? 0;
    const b = rightPoints[index]?.codePointAt(0) ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return leftPoints.length === rightPoints.length
    ? 0
    : leftPoints.length < rightPoints.length
      ? -1
      : 1;
}
