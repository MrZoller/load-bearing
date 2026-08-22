import { expect, test } from "@playwright/test";

test("slash commands are keyboard-operable", async ({ page }) => {
  await page.goto("/");

  const agentPrompt = page.getByRole("textbox", { name: "Agent prompt" });
  const completions = page.getByRole("listbox", { name: "Slash commands" });
  const transcript = page.getByRole("list", { name: "Session transcript" });

  await page.keyboard.type("/c");
  await expect(completions).toBeVisible();
  await expect(completions.getByRole("option")).toHaveText([
    "/compactReplace context with its authored summary",
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
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status", { name: "Session cost" })).toHaveText(
    /^model Structural Audit · tokens [\d,]+ · cost \$[\d,]+\.\d{6} · context \d+%$/,
  );
  await expect(agentPrompt).toBeFocused();

  await page.keyboard.type("/help");
  await page.keyboard.press("Enter");
  await expect(
    transcript.getByText(
      "/help lists commands; /model changes the active model; /compact frees context lossily; /cost reports replay-derived usage; /exit returns to the incident shell. Prefix shell work with !.",
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
});

test("model selection persists across mode switches", async ({ page }) => {
  await page.goto("/");

  const agentPrompt = page.getByRole("textbox", { name: "Agent prompt" });
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
