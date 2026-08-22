/** Canonical phrase spelling shared by cartridge validation and intent lookup. */
export function normalizeIntentPhrase(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}
