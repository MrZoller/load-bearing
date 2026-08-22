import { expect, test } from "@playwright/test";

test("slash commands are keyboard-operable", async ({ page }) => {
  await page.goto("/");

  const agentPrompt = page.getByRole("combobox", { name: "Agent prompt" });
  const completions = page.getByRole("listbox", { name: "Slash commands" });
  const transcript = page.getByRole("list", { name: "Session transcript" });

  await page.keyboard.type("/c");
  await expect(completions).toBeVisible();
  await expect(agentPrompt).toHaveAttribute("aria-expanded", "true");
  await expect(completions.getByRole("option")).toHaveText([
    "/compactReplace context with the approved summary",
    "/costReport replay-derived session metrics",
  ]);
  await expect(agentPrompt).toHaveAttribute(
    "aria-activedescendant",
    "slash-command-0",
  );

  await page.keyboard.press("ArrowDown");
  await expect(agentPrompt).toHaveAttribute(
    "aria-activedescendant",
    "slash-command-1",
  );
  await page.keyboard.press("Tab");
  await expect(agentPrompt).toHaveValue("/cost");
  await expect(completions).toBeHidden();
  await expect(agentPrompt).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Shift+Tab");
  await expect(agentPrompt).not.toBeFocused();
  await page.keyboard.press("Tab");
  await expect(agentPrompt).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status", { name: "Session cost" })).toHaveText(
    /^model Structural Audit · tokens [\d,]+ · cost \$[\d,]+\.\d{6} · context \d+%$/,
  );
  await expect(agentPrompt).toBeFocused();

  await page.keyboard.type("/help");
  await page.keyboard.press("Enter");
  await expect(
    transcript.getByText(
      "/help repeats this register; /model changes the active model; /compact replaces context with an authored summary; /cost reports replay-derived usage; /exit leaves this view. Begin with what you want inspected.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(agentPrompt).toBeFocused();

  await page.keyboard.type("/compact");
  await page.keyboard.press("Enter");
  await expect(
    transcript.getByText(
      "Context compacted. I retained the conclusion and released several facts that appeared decorative.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(agentPrompt).toBeFocused();

  await page.keyboard.type("/mo");
  await expect(completions).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(completions).toBeHidden();
  await expect(agentPrompt).toHaveValue("");
  await expect(agentPrompt).toBeFocused();

  await page.keyboard.type("/exit");
  await page.keyboard.press("Enter");
  const bashPrompt = page.getByRole("textbox", { name: "Bash command" });
  await expect(bashPrompt).toBeFocused();
  await page.keyboard.type("loadbearing --resume incident-000");
  await page.keyboard.press("Enter");
  await expect(agentPrompt).toBeFocused();
  await expect(
    transcript.getByText(
      "Context compacted. I retained the conclusion and released several facts that appeared decorative.",
      { exact: true },
    ),
  ).toBeVisible();

  await page.keyboard.type(" /exit ");
  await page.keyboard.press("Enter");
  await expect(bashPrompt).toBeFocused();
});

test("teaches only cartridge-authored surface controls without a tutorial layer", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-08-22T09:14:22.000Z") });
  await page.goto("/");

  const terminal = page.getByRole("main", { name: "Load Bearing terminal" });
  const agentPrompt = page.getByRole("combobox", { name: "Agent prompt" });
  const transcript = page.getByRole("list", { name: "Session transcript" });
  const completions = page.getByRole("listbox", { name: "Slash commands" });

  // Presentation time only rotates the authored stage-zero suggestions.
  await expect(agentPrompt).toHaveAttribute("placeholder", "ask what is wrong");
  await page.clock.fastForward(4_000);
  await expect(agentPrompt).toHaveAttribute("placeholder", "try: inspect it");
  await page.clock.fastForward(4_000);
  await expect(agentPrompt).toHaveAttribute(
    "placeholder",
    "type /help for the incident register",
  );

  await agentPrompt.fill("/");
  await expect(completions.getByRole("option")).toHaveText([
    "/helpReview the incident register",
    "/modelChoose who assumes responsibility",
    "/compactReplace context with the approved summary",
    "/costReport replay-derived session metrics",
    "/exitLeave the agent view",
  ]);
  await agentPrompt.press("Escape");
  await agentPrompt.fill("/help");
  await agentPrompt.press("Enter");
  await expect(
    transcript.getByText(
      "/help repeats this register; /model changes the active model; /compact replaces context with an authored summary; /cost reports replay-derived usage; /exit leaves this view. Begin with what you want inspected.",
      { exact: true },
    ),
  ).toBeVisible();

  // The explicit replay event fires once after silence, never as a repeated UI hint.
  await page.clock.fastForward(30_000);
  const nudge = transcript.getByText(
    "The readiness incident remains open. Asking me to inspect it would at least make the uncertainty explicit.",
    { exact: true },
  );
  await expect(nudge).toHaveCount(1);
  await page.clock.fastForward(30_000);
  await expect(nudge).toHaveCount(1);

  // The shell and deeper paths remain discoverable, not advertised by chrome.
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.locator('[class*="overlay" i], [class*="tutorial" i]'),
  ).toHaveCount(0);
  await expect(terminal).not.toContainText("click here");
  await expect(terminal).not.toContainText("hidden command");
});

test("model selection persists across mode switches", async ({ page }) => {
  await page.goto("/");

  const agentPrompt = page.getByRole("combobox", { name: "Agent prompt" });
  const bashPrompt = page.getByRole("textbox", { name: "Bash command" });
  const status = page.getByRole("region", { name: "Session status" });

  await page.keyboard.type("/model");
  await page.keyboard.press("Enter");
  const selector = page.getByRole("group", { name: "Choose active model" });
  await expect(selector).toBeVisible();
  await expect(
    selector.getByRole("radio", { name: /Structural Audit/ }),
  ).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(selector).toBeHidden();
  await expect(agentPrompt).toBeFocused();

  await page.keyboard.type("/model");
  await page.keyboard.press("Enter");
  const reopenedSelector = page.getByRole("group", {
    name: "Choose active model",
  });
  await expect(
    reopenedSelector.getByRole("radio", { name: /Structural Audit/ }),
  ).toBeFocused();

  await page.keyboard.press("ArrowDown");
  await expect(status).toContainText("model Temporary Bracing");
  await expect(agentPrompt).toBeFocused();

  await page.keyboard.type("/exit");
  await page.keyboard.press("Enter");
  await expect(bashPrompt).toBeFocused();
  await page.keyboard.type("loadbearing --resume incident-000");
  await page.keyboard.press("Enter");
  await expect(agentPrompt).toBeFocused();
  await expect(status).toContainText("model Temporary Bracing");
});
