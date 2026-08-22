import { describe, expect, it } from "vitest";

import cartridgeDocument from "../../content/incidents/phase-1-demo.json";
import {
  createShellExecuteEvent,
  loadCartridge,
  reduce,
} from "../../engine/index.js";
import { renderStatus } from "./status.js";

interface FakeElement {
  readonly tagName: string;
  className: string;
  textContent: string;
  readonly children: FakeElement[];
  readonly attributes: ReadonlyMap<string, string>;
  append(...children: FakeElement[]): void;
  setAttribute(name: string, value: string): void;
}

function fakeDocument(): Document {
  return {
    createElement: (tagName: string) => {
      const children: FakeElement[] = [];
      const attributes = new Map<string, string>();
      return {
        tagName,
        className: "",
        textContent: "",
        children,
        attributes,
        append(...next: FakeElement[]) {
          children.push(...next);
        },
        setAttribute(name: string, value: string) {
          attributes.set(name, value);
        },
      } as unknown as HTMLElement;
    },
  } as unknown as Document;
}

describe("renderStatus", () => {
  it("renders a semantic engine-derived status region with the incident attribution", () => {
    const cartridge = loadCartridge(cartridgeDocument);
    const state = reduce({
      cartridge,
      seed: "2026-08-22/0/structural-audit",
      events: [createShellExecuteEvent("pwd")],
    });
    const status = renderStatus(
      fakeDocument(),
      state,
      7,
    ) as unknown as FakeElement;
    const visible = status.children.map((child) => child.textContent).join(" ");

    expect(status.tagName).toBe("section");
    expect(status.attributes.get("aria-label")).toBe("Session status");
    expect(visible).toContain("Structural Audit");
    expect(visible).toContain("tokens");
    expect(visible).toContain("$");
    expect(visible).toContain("context");
    expect(visible).toContain("%");
    expect(visible).toContain("integrity");
    expect(visible).toContain("loadbearing.cc · Incident #007");
  });
});
