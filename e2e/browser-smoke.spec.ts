import { expect, test } from "@playwright/test";

test("cold-opens and round-trips between the TUI and Bash with the keyboard", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => failedRequests.push(request.url()));

  await page.goto("/");

  const terminal = page.getByRole("main", { name: "Load Bearing terminal" });
  const transcript = page.getByRole("list", { name: "Session transcript" });
  const agentPrompt = page.getByRole("textbox", { name: "Agent prompt" });
  const bashPrompt = page.getByRole("textbox", { name: "Bash command" });

  await expect(terminal).toBeVisible();
  await expect(
    page.getByText("loadbearing.cc · Incident #000", { exact: true }),
  ).toBeVisible();
  const login = transcript.getByRole("listitem").first();
  await expect(login).toContainText(
    "Last login: maintenance window still open.",
  );
  await expect(login).toContainText(
    "visitor@load-bearing:/production/service$",
  );
  await expect(
    transcript.getByText("loadbearing --resume incident-000", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("❯", { exact: true })).toBeVisible();
  await expect(agentPrompt).toBeFocused();

  // No click is needed to leave the initially focused agent prompt.
  await page.keyboard.type("/exit");
  await page.keyboard.press("Enter");
  await expect(bashPrompt).toBeFocused();

  // A bare shell exit is authored as a refusal, not a way to end the session.
  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
  await expect(
    transcript.getByText("exit is load-bearing", { exact: true }),
  ).toBeVisible();
  await expect(bashPrompt).toBeFocused();

  // Resuming retains the shell exchange above, proving this is the same engine
  // session rather than a new cold-opened TUI.
  await page.keyboard.type("loadbearing --resume incident-000");
  await page.keyboard.press("Enter");
  await expect(agentPrompt).toBeFocused();
  await expect(
    transcript.getByText("exit is load-bearing", { exact: true }),
  ).toBeVisible();

  // Ctrl+D takes the same keyboard-only path back to Bash, which can resume.
  await page.keyboard.press("Control+d");
  await expect(bashPrompt).toBeFocused();
  await page.keyboard.type("loadbearing --resume incident-000");
  await page.keyboard.press("Enter");
  await expect(agentPrompt).toBeFocused();
  await expect(
    transcript.getByText("loadbearing --resume incident-000", { exact: true }),
  ).toHaveCount(3);
  expect(pageErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});
