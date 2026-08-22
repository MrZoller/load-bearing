import { describe, expect, it } from "vitest";

import { renderAgentArtifacts } from "./artifacts.js";

interface FakeElement {
  readonly tagName: string;
  className: string;
  textContent: string;
  readonly children: FakeElement[];
  readonly attributes: ReadonlyMap<string, string>;
  readonly dataset: Record<string, string>;
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
        dataset: {},
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

describe("renderAgentArtifacts", () => {
  it("renders replayed work as textual native details and summary disclosures", () => {
    const artifacts = renderAgentArtifacts(fakeDocument(), {
      toolCalls: [
        {
          id: "turn/tool/read",
          title: "Read config",
          input: "cat config.json",
          output: '{"load":"bearing"}',
          status: "succeeded",
        },
      ],
      thinkingBlocks: [
        {
          id: "turn/thinking/check",
          text: "Check the braces.",
          status: "complete",
        },
      ],
      todos: [
        { id: "turn/todo/check", text: "Check config", status: "in-progress" },
      ],
    }) as unknown as FakeElement;

    expect(artifacts.tagName).toBe("section");
    expect(artifacts.attributes.get("aria-label")).toBe("Agent work details");
    expect(artifacts.children.map((item) => item.tagName)).toEqual([
      "details",
      "details",
      "details",
    ]);
    expect(artifacts.children[0]?.children[0]).toMatchObject({
      tagName: "summary",
      textContent: "Thinking — complete",
    });
    expect(
      artifacts.children[1]?.children.map((item) => item.textContent),
    ).toEqual([
      "Tool: Read config — succeeded",
      "Input\ncat config.json",
      'Output\n{"load":"bearing"}',
    ]);
    expect(artifacts.children[2]?.children[0]).toMatchObject({
      tagName: "summary",
      textContent: "Todos — 1 item",
    });
    expect(artifacts.children[2]?.children[1]?.children[0]).toMatchObject({
      tagName: "li",
      textContent: "Check config — in progress",
    });
  });

  it("does not add an empty work region to the transcript", () => {
    expect(
      renderAgentArtifacts(fakeDocument(), {
        toolCalls: [],
        thinkingBlocks: [],
        todos: [],
      }),
    ).toBeNull();
  });
});
