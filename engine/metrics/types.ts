/** Replay-derived status values exposed to every runtime view. */
export interface EngineMetrics {
  readonly modelId: string;
  readonly modelName: string;
  readonly tokenCount: number;
  /** Estimated cost in millionths of the display currency. */
  readonly costMicros: number;
  /** Context used, as an integer percentage bounded to 0–100. */
  readonly contextPercent: number;
  /** Cartridge-authored raw integrity units, floored at zero. */
  readonly structuralIntegrity: number;
}
