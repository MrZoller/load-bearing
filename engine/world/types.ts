import type { ServiceHealth, WorldUnitState } from "../cartridge/types.js";
import type { VfsErrorCode } from "../vfs/types.js";

export interface WorldProcess {
  readonly id: string;
  readonly pid: number;
  readonly user: string;
  readonly command: {
    readonly binary: string;
    readonly args: readonly string[];
  };
  readonly startedAt: string;
  readonly state: WorldUnitState;
}

export interface WorldService {
  readonly id: string;
  readonly state: WorldUnitState;
  readonly health: ServiceHealth;
  readonly ports: readonly number[];
  readonly dependencies: readonly string[];
}

export interface WorldLog {
  readonly id: string;
  readonly kind: "file" | "stream";
  readonly path: string;
  /** Always empty for file logs: their bytes have exactly one owner, the VFS. */
  readonly entries: readonly string[];
}

export interface WorldManPage {
  readonly name: string;
  readonly section: string;
  readonly contents: string;
}

export interface WorldTicket {
  readonly id: string;
  readonly status: string;
  readonly title: string;
  readonly body: string;
  readonly service: string;
}

export interface WorldSlice {
  readonly processes: readonly WorldProcess[];
  readonly services: readonly WorldService[];
  readonly logs: readonly WorldLog[];
  readonly env: Readonly<Record<string, string>>;
  readonly manPages: readonly WorldManPage[];
  readonly shellHistory: readonly string[];
  readonly tickets: readonly WorldTicket[];
}

export interface ProcessFilter {
  readonly state?: WorldUnitState;
  readonly user?: string;
}

export interface ServiceFilter {
  readonly state?: WorldUnitState;
  readonly health?: ServiceHealth;
}

export interface TicketFilter {
  readonly status?: string;
  readonly service?: string;
}

export type LogReadResult =
  | { readonly ok: true; readonly entries: readonly string[] }
  | { readonly ok: false; readonly reason: "missing-log" | "missing-file" }
  | {
      readonly ok: false;
      readonly reason: "vfs-error";
      readonly code: VfsErrorCode;
    };
