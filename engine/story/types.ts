import type {
  CartridgeBelief,
  ServiceHealth,
  WorldUnitState,
} from "../cartridge/types.js";
import type { ExactCapability } from "../mind/types.js";

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
    };

export interface StoryFact {
  readonly id: string;
  readonly kind: StoryFactKind;
}

/** Replayable state owned by the shared story graph. */
export interface StorySlice {
  readonly currentBeat: string;
  /** Empty identifies the base outcome rather than an authored variant. */
  readonly currentVariant: string;
  /** Facts in first-recorded order. */
  readonly facts: readonly StoryFact[];
  /** Ending ids in first-discovery order. */
  readonly discoveredEndings: readonly string[];
}
