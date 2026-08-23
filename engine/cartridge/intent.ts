/** Canonical phrase spelling shared by cartridge validation and intent lookup. */
export function normalizeIntentPhrase(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

export const INTENT_SLOT = "{slot}";
export const MAX_INTENT_PATTERN_TOKENS = 32;
export const MAX_INTENT_INPUT_TOKENS = 64;
export const MAX_INTENT_SLOT_TOKENS = 12;

function tokens(value: string): readonly string[] {
  const normalized = normalizeIntentPhrase(value);
  return normalized === "" ? [] : normalized.split(" ");
}

/** Return a stable author-facing reason instead of exposing matcher internals. */
export function keywordPatternIssue(pattern: string): string | undefined {
  const parts = tokens(pattern);
  if (parts.length === 0) return "must contain keywords and a {slot}";
  if (parts.length > MAX_INTENT_PATTERN_TOKENS)
    return `must contain at most ${String(MAX_INTENT_PATTERN_TOKENS)} tokens`;
  if (!parts.includes(INTENT_SLOT)) return "must contain at least one {slot}";
  if (parts.every((part) => part === INTENT_SLOT))
    return "must contain at least one literal keyword";
  if (
    parts.some(
      (part, index) => part === INTENT_SLOT && parts[index - 1] === INTENT_SLOT,
    )
  )
    return "must not contain adjacent {slot} tokens";
  if (
    parts.some(
      (part) =>
        part !== INTENT_SLOT && (part.includes("{") || part.includes("}")),
    )
  )
    return "must use braces only as the complete token {slot}";
  return undefined;
}

/**
 * Match literal keywords and bounded non-empty slots without regex generation.
 * The small dynamic-programming table makes ambiguous multi-slot patterns
 * deterministic work rather than recursive backtracking supplied by content.
 */
export function matchesKeywordPattern(pattern: string, input: string): boolean {
  if (keywordPatternIssue(pattern) !== undefined) return false;
  const authored = tokens(pattern);
  const submitted = tokens(input);
  if (submitted.length === 0 || submitted.length > MAX_INTENT_INPUT_TOKENS)
    return false;
  let reachable = new Set<number>([0]);
  for (const part of authored) {
    const next = new Set<number>();
    for (const index of reachable) {
      if (part === INTENT_SLOT) {
        const end = Math.min(submitted.length, index + MAX_INTENT_SLOT_TOKENS);
        for (let cursor = index + 1; cursor <= end; cursor += 1)
          next.add(cursor);
      } else if (submitted[index] === part) next.add(index + 1);
    }
    reachable = next;
    if (reachable.size === 0) return false;
  }
  return reachable.has(submitted.length);
}
