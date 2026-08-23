import type {
  CartridgeBelief,
  ServiceHealth,
  WorldUnitState,
} from "../cartridge/types.js";
import type { ExactCapability } from "../mind/types.js";

export type EscalationStage = 0 | 1 | 2 | 3 | 4;

export type StoryFactKind = "reveal" | "callback";

export type StoryCondition =
  | {
      readonly kind: "file-exists";
      readonly path: string;
      readonly exists: boolean;
    }
  | {
      readonly kind: "file-contents";
      readonly path: string;
      readonly equals: string;
    }
  | {
      readonly kind: "service-state";
      readonly service: string;
      readonly state: WorldUnitState;
    }
  | {
      readonly kind: "service-health";
      readonly service: string;
      readonly health: ServiceHealth;
    }
  | { readonly kind: "belief"; readonly belief: CartridgeBelief }
  | {
      readonly kind: "belief-divergence";
      readonly belief: CartridgeBelief;
    }
  | {
      readonly kind: "waiver-consent";
      readonly id: string;
      readonly version: number;
      readonly phrase: string;
      readonly capability: ExactCapability;
    }
  | {
      readonly kind: "story-fact";
      readonly fact: string;
      readonly factKind: StoryFactKind;
    }
  | {
      readonly kind: "story-counter";
      readonly counter: string;
      readonly comparison: "equal" | "at-least";
      readonly value: number;
    };

export interface StoryFact {
  readonly id: string;
  readonly kind: StoryFactKind;
}

export interface StoryCounter {
  readonly id: string;
  readonly value: number;
}

export type StoryCounterQuery =
  | { readonly kind: "value"; readonly value: number }
  | { readonly kind: "missing" };

/** Replayable state owned by the shared story graph. */
export interface StorySlice {
  /** Authoritative deterioration stage; presentation time never owns it. */
  readonly stage: EscalationStage;
  readonly currentBeat: string;
  /** Empty identifies the base outcome rather than an authored variant. */
  readonly currentVariant: string;
  /** Facts in first-recorded order. */
  readonly facts: readonly StoryFact[];
  /** Counter records remain in cartridge declaration order. */
  readonly counters: readonly StoryCounter[];
  /** Ending ids in first-discovery order. */
  readonly discoveredEndings: readonly string[];
}
