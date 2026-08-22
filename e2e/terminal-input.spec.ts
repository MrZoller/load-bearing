import { expect, test } from "@playwright/test";

test("keeps terminal controls mode-specific and presentation-only", async ({
  page,
}) => {
  await page.goto("/");

  const transcript = page.getByRole("list", { name: "Session transcript" });
  const agentPrompt = page.getByRole("textbox", { name: "Agent prompt" });
  const bashPrompt = page.getByRole("textbox", { name: "Bash command" });

  // TUI slash, shell builtin, and live VFS completion all operate at the
  // visible prompt rather than asking the browser's shell for candidates.
  await agentPrompt.fill("/hel");
  await agentPrompt.press("Tab");
  await expect(agentPrompt).toHaveValue("/help");
  await agentPrompt.fill("!cat src/rea");
  await agentPrompt.press("Tab");
  await expect(agentPrompt).toHaveValue("!cat src/ready.stale ");

  // Cancel is local presentation state: no submitted exchange appears.
  const exchangesBeforeCancel = await transcript.getByRole("listitem").count();
  await agentPrompt.press("Control+c");
  await expect(agentPrompt).toHaveValue("");
  await expect(transcript.getByRole("listitem")).toHaveCount(
    exchangesBeforeCancel,
  );

  // A submitted TUI turn and a draft use TUI history only.
  await agentPrompt.fill("inspect it");
  await agentPrompt.press("Enter");
  await expect(
    transcript.getByText("inspect it", { exact: true }),
  ).toBeVisible();
  await agentPrompt.fill("agent draft");
  await agentPrompt.press("ArrowUp");
  await expect(agentPrompt).toHaveValue("inspect it");
  await agentPrompt.press("ArrowDown");
  await expect(agentPrompt).toHaveValue("agent draft");

  // A nonempty Ctrl+D keeps a TUI draft intact; only an empty prompt enters
  // Bash through the controller's mode-switch path.
  await agentPrompt.press("Control+d");
  await expect(agentPrompt).toBeFocused();
  await expect(agentPrompt).toHaveValue("agent draft");
  await agentPrompt.press("Control+c");
  await agentPrompt.press("Control+d");
  await expect(bashPrompt).toBeFocused();
  await bashPrompt.press("ArrowUp");
  await expect(bashPrompt).toHaveValue("loadbearing --resume incident-000");
  await bashPrompt.press("Control+c");
  await bashPrompt.fill("pw");
  await bashPrompt.press("Tab");
  await expect(bashPrompt).toHaveValue("pwd ");
  await bashPrompt.fill("c");
  await bashPrompt.press("Tab");
  await expect(bashPrompt).toBeFocused();
  await expect(bashPrompt).toHaveValue("c");
  await bashPrompt.fill("pwd");
  await bashPrompt.press("Enter");
  await bashPrompt.fill("bash draft");
  await bashPrompt.press("ArrowUp");
  await expect(bashPrompt).toHaveValue("pwd");
  await bashPrompt.press("ArrowDown");
  await expect(bashPrompt).toHaveValue("bash draft");

  // Resume returns to the original TUI history, not Bash's visitor command.
  await bashPrompt.fill("loadbearing --resume incident-000");
  await bashPrompt.press("Enter");
  await expect(agentPrompt).toBeFocused();
  await agentPrompt.fill("new agent draft");
  await agentPrompt.press("ArrowUp");
  await expect(agentPrompt).toHaveValue("inspect it");

  // Escape closes a slash presentation and Ctrl+L removes rendered history
  // without dispatching an engine turn or consuming the current draft.
  await agentPrompt.fill("/mo");
  await expect(
    page.getByRole("listbox", { name: "Slash commands" }),
  ).toBeVisible();
  await agentPrompt.press("Escape");
  await expect(agentPrompt).toHaveValue("");
  await agentPrompt.fill("draft survives clear");
  await agentPrompt.press("Control+l");
  await expect(transcript.getByRole("listitem")).toHaveCount(0);
  await expect(agentPrompt).toHaveValue("draft survives clear");
  await agentPrompt.press("Control+c");
  await agentPrompt.fill("/help");
  await agentPrompt.press("Enter");
  await expect(
    transcript.getByText(/\/help repeats this register;/, { exact: true }),
  ).toBeVisible();
  await expect(transcript.getByText("inspect it", { exact: true })).toHaveCount(
    0,
  );
});

test("serializes working turns and lets Escape finish the authored sequence", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/");

  const prompt = page.getByRole("textbox", { name: "Agent prompt" });
  const transcript = page.getByRole("list", { name: "Session transcript" });
  await prompt.fill("inspect it");
  await prompt.press("Enter");

  await expect(prompt).toBeDisabled();
  await expect(page.locator("[data-agent-activity]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(prompt).toBeEnabled();
  await expect(page.locator("[data-agent-activity]")).toHaveCount(0);
  await expect(transcript.getByText("inspect it", { exact: true })).toHaveCount(
    1,
  );
  await expect(
    transcript.getByText(
      "I will inspect the sentinel before changing the forces currently passing through it.",
      { exact: true },
    ),
  ).toBeVisible();
});

test("restores a draft after navigating through a submitted slash command", async ({
  page,
}) => {
  await page.goto("/");

  const agentPrompt = page.getByRole("textbox", { name: "Agent prompt" });
  await agentPrompt.fill("/help");
  await agentPrompt.press("Enter");
  await agentPrompt.fill("draft after slash command");
  await agentPrompt.press("ArrowUp");
  await expect(agentPrompt).toHaveValue("/help");
  await agentPrompt.press("ArrowDown");

  // History navigation must win once its own ArrowUp chose the prior entry;
  // reopening slash completion here strands the draft behind the listbox.
  await expect(agentPrompt).toHaveValue("draft after slash command");
});
