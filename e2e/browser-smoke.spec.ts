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

test("renders recognized and fallback TUI turns and dispatches ! shell work", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");

  const transcript = page.getByRole("list", { name: "Session transcript" });
  const agentPrompt = page.getByRole("textbox", { name: "Agent prompt" });

  await agentPrompt.fill("inspect it");
  await agentPrompt.press("Enter");
  await expect(
    transcript.getByText("inspect it", { exact: true }),
  ).toBeVisible();
  await expect(
    transcript.getByText(
      "I will inspect the sentinel before changing the forces currently passing through it.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    transcript.getByText("cat src/ready.stale", { exact: true }),
  ).toBeVisible();
  await expect(
    transcript.getByText("remove me", { exact: true }),
  ).toBeVisible();

  await agentPrompt.fill("please rotate the moon");
  await agentPrompt.press("Enter");
  await expect(
    transcript.getByText(
      "I treated that as a request for a wider readiness review. The original task is now supporting it.",
      { exact: true },
    ),
  ).toBeVisible();

  await agentPrompt.fill("!pwd");
  await agentPrompt.press("Enter");
  await expect(transcript.getByText("pwd", { exact: true })).toBeVisible();
  await expect(
    transcript.getByText("/production/service", { exact: true }),
  ).toBeVisible();
  await expect(agentPrompt).toBeFocused();

  await agentPrompt.fill("x".repeat(16_001));
  await agentPrompt.press("Enter");
  await expect(
    transcript.getByText(
      "I treated that as a request for a wider readiness review. The original task is now supporting it.",
      { exact: true },
    ),
  ).toHaveCount(2);
  expect(pageErrors).toEqual([]);
});
