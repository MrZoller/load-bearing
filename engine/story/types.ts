/** Replayable state owned by the shared story graph. */
export interface StorySlice {
  readonly currentBeat: string;
  /** Ending ids in first-discovery order. */
  readonly discoveredEndings: readonly string[];
}
