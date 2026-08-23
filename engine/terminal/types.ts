/** Replayable terminal state. Presentation details remain outside the engine. */

export type TerminalMode = "bash" | "tui";

export interface TerminalSlice {
  readonly mode: TerminalMode;
  readonly activeModel: string;
}

/** One directional model change, fully described by its replay event. */
export interface ModelTransition {
  readonly predecessor: string;
  readonly successor: string;
}
