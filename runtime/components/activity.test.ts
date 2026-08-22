import { describe, expect, it } from "vitest";

import cartridgeDocument from "../../content/incidents/phase-1-demo.json";
import {
  createAgentActivityEvent,
  deriveEngineMetrics,
  loadCartridge,
  readAgentSlice,
  reduce,
  snapshot,
} from "../../engine/index.js";
import {
  formatAgentActivity,
  renderAgentActivity,
  updateAgentActivity,
} from "./activity.js";

interface FakeElement {
  readonly tagName: string;
  className: string;
  textContent: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly dataset: Record<string, string>;
  setAttribute(name: string, value: string): void;
}

function fakeDocument(): Document {
  return {
    createElement: (tagName: string) => {
      const attributes = new Map<string, string>();
      return {
        tagName,
        className: "",
        textContent: "",
        attributes,
        dataset: {},
        setAttribute(name: string, value: string) {
          attributes.set(name, value);
        },
      } as unknown as HTMLElement;
    },
  } as unknown as Document;
}

const CARTRIDGE = loadCartridge(cartridgeDocument);
const SEED = "2026-08-22/0/structural-audit";

function workingState() {
  return reduce({
    cartridge: CARTRIDGE,
    seed: SEED,
    events: [createAgentActivityEvent({ status: "working", stage: 0 })],
  });
}

describe("agent activity component", () => {
  it("renders the selected replay verb, elapsed timer, grouped engine tokens, and Escape guidance", () => {
    const state = workingState();
    const element = renderAgentActivity(
      fakeDocument(),
      state,
      12_999,
    ) as unknown as FakeElement;
    const verb = readAgentSlice(state).activity.verb;

    expect(element).toMatchObject({
      tagName: "p",
      className: "agent-activity",
      textContent: `${verb}… 12s · 1,380 tokens · Esc to interrupt`,
    });
    expect(element.attributes.get("role")).toBe("status");
    expect(element.attributes.get("aria-label")).toBe("Agent activity");
    expect(deriveEngineMetrics(state).tokenCount).toBe(1_380);
  });

  it("varies only presentation text across elapsed frames, never replay state", () => {
    const state = workingState();
    const before = snapshot(state);
    const frame = { textContent: "" } as HTMLElement;

    expect(formatAgentActivity(state, 0)).toContain("0s");
    expect(formatAgentActivity(state, 2_100)).toContain("2s");
    updateAgentActivity(frame, state, 2_100);
    expect(frame.textContent).toContain("2s");
    // Motion is CSS-only; this projection exposes no preference input that
    // could choose different replay-derived text.
    expect(snapshot(state)).toBe(before);
  });

  it("returns no activity element while the replayed agent is idle", () => {
    const idle = reduce({ cartridge: CARTRIDGE, seed: SEED, events: [] });

    expect(formatAgentActivity(idle, 9_000)).toBeNull();
    expect(renderAgentActivity(fakeDocument(), idle, 9_000)).toBeNull();
  });
});
