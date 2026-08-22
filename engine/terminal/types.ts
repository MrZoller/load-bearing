/** Replayable terminal state. Presentation details remain outside the engine. */

export type TerminalMode = "bash" | "tui";

export interface TerminalSlice {
  readonly mode: TerminalMode;
  readonly activeModel: string;
}
