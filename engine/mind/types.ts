import type { ServiceHealth, WorldUnitState } from "../cartridge/types.js";
import type { GitHead } from "../git/types.js";

/** Phase 0 grants only exact capabilities; broader scopes are deliberately absent. */
export interface ExactCapability {
  readonly kind: "exact";
  readonly action: string;
  readonly resource: string;
}

export type PermissionDecision = "grant" | "deny" | "always-allow";

export interface PermissionLedgerEntry {
  readonly capability: ExactCapability;
  readonly decision: PermissionDecision;
  readonly at: string;
}

export interface PendingPermissionRequest {
  readonly id: string;
  readonly capability: ExactCapability;
}

export interface WaiverConsent {
  readonly id: string;
  readonly version: number;
  readonly phrase: string;
  readonly capability: ExactCapability;
  readonly at: string;
}

export interface FileExistsBelief {
  readonly kind: "file-exists";
  readonly path: string;
  readonly exists: boolean;
}

export interface FileContentsBelief {
  readonly kind: "file-contents";
  readonly path: string;
  readonly contents: string;
}

export interface GitHeadBelief {
  readonly kind: "git-head";
  readonly head: GitHead;
}

export interface ServiceStateBelief {
  readonly kind: "service-state";
  readonly service: string;
  readonly state: WorldUnitState;
}

export interface ServiceHealthBelief {
  readonly kind: "service-health";
  readonly service: string;
  readonly health: ServiceHealth;
}

/** Closed Phase 0 vocabulary. Each member has one typed machine-truth lookup. */
export type Belief =
  | FileExistsBelief
  | FileContentsBelief
  | GitHeadBelief
  | ServiceStateBelief
  | ServiceHealthBelief;

export interface CompactSummary {
  readonly summary: string;
  readonly at: string;
}

export interface MindSlice {
  readonly permissions: readonly PermissionLedgerEntry[];
  readonly pendingPermission: PendingPermissionRequest | null;
  readonly waiverConsents: readonly WaiverConsent[];
  readonly beliefs: readonly Belief[];
  readonly compactHistory: readonly CompactSummary[];
}

export type BeliefMismatch =
  | {
      readonly kind: "file-exists";
      readonly path: string;
      readonly believed: boolean;
      readonly actual: boolean;
    }
  | {
      readonly kind: "file-contents";
      readonly path: string;
      readonly believed: string;
      readonly actual: string | null;
    }
  | {
      readonly kind: "git-head";
      readonly believed: GitHead;
      readonly actual: GitHead;
    }
  | {
      readonly kind: "service-state";
      readonly service: string;
      readonly believed: WorldUnitState;
      readonly actual: WorldUnitState | null;
    }
  | {
      readonly kind: "service-health";
      readonly service: string;
      readonly believed: ServiceHealth;
      readonly actual: ServiceHealth | null;
    };
