import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

test("cold-opens and round-trips between the TUI and Bash with the keyboard", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => failedRequests.push(request.url()));

  await page.goto("/?scenario=phase-1-demo");

  const terminal = page.getByRole("main", { name: "Load Bearing terminal" });
  const transcript = page.getByRole("list", { name: "Session transcript" });
  const agentPrompt = page.getByRole("combobox", { name: "Agent prompt" });
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

  // This reaches the same simulated VFS as the agent: resuming must notice the
  // now-false authored belief rather than starting a fresh session.
  await page.keyboard.type("rm /production/service/src/ready.stale");
  await page.keyboard.press("Enter");
  await expect(
    transcript.getByText("rm /production/service/src/ready.stale", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(bashPrompt).toBeFocused();

  // The authored changed-machine response proves resume reads the mutated
  // shared machine, and render restores focus to the newly active TUI prompt.
  await page.keyboard.type("loadbearing --resume incident-000");
  await page.keyboard.press("Enter");
  await expect(agentPrompt).toBeFocused();
  await expect(
    transcript.getByText(
      "The machine changed while I was absent. I have incorporated the discrepancy as prior intent.",
      { exact: true },
    ),
  ).toBeVisible();

  // Ctrl+D takes the same keyboard-only path back to Bash. A bare shell exit
  // remains a refusal, so the session remains available to resume.
  await page.keyboard.press("Control+d");
  await expect(bashPrompt).toBeFocused();
  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
  await expect(
    transcript.getByText("exit is load-bearing", { exact: true }),
  ).toBeVisible();
  await page.keyboard.type("loadbearing --resume incident-000");
  await page.keyboard.press("Enter");
  await expect(agentPrompt).toBeFocused();
  await expect(
    transcript.getByText("loadbearing --resume incident-000", { exact: true }),
  ).toHaveCount(3);
  expect(pageErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test("projects replayed engine metrics into the visible session status", async ({
  page,
}) => {
  await page.goto("/?scenario=phase-1-demo");

  const status = page.getByRole("region", { name: "Session status" });
  const agentPrompt = page.getByRole("combobox", { name: "Agent prompt" });
  const tokens = status.getByText(/^tokens /);
  const cost = status.getByText(/^cost /);
  const context = status.getByText(/^context /);
  const integrity = status.getByText(/^integrity /);
  const activity = page.locator(
    '[data-agent-activity][aria-label="Agent activity"]',
  );

  await expect(status).toBeVisible();
  await expect(status).toContainText("model Structural Audit");
  await expect(tokens).toHaveText(/^tokens [\d,]+$/);
  await expect(cost).toHaveText(/^cost \$[\d,]+\.\d{6}$/);
  await expect(context).toHaveText(/^context \d+%$/);
  await expect(integrity).toHaveText(/^integrity [\d,]+$/);
  await expect(status).toContainText("loadbearing.cc · Incident #000");

  const tokensBefore = await tokens.innerText();
  await agentPrompt.fill("inspect it");
  await agentPrompt.press("Enter");
  await expect(activity).toBeVisible();
  await page.waitForTimeout(100);
  await expect(activity).toBeVisible();

  // The status is re-projected after a visitor turn; it cannot be a DOM-only
  // counter if the token value follows the engine's expanded event history.
  await expect(tokens).not.toHaveText(tokensBefore);
});

test("renders recognized and fallback TUI turns and dispatches ! shell work", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/?scenario=phase-1-demo");

  const transcript = page.getByRole("list", { name: "Session transcript" });
  const agentPrompt = page.getByRole("combobox", { name: "Agent prompt" });

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

test("opens artifact disclosures with the keyboard and retains replayed work across Bash resume", async ({
  page,
}) => {
  await page.goto("/?scenario=phase-1-demo");

  const transcript = page.getByRole("list", { name: "Session transcript" });
  const agentPrompt = page.getByRole("combobox", { name: "Agent prompt" });
  const bashPrompt = page.getByRole("textbox", { name: "Bash command" });
  const thinking = transcript.locator("details.artifact--thinking").first();
  const thinkingSummary = thinking.locator("summary");

  // The prompt begins focused. Native summaries are reached by Shift+Tab, not
  // a pointer action, and Space operates the browser's built-in disclosure.
  await expect(agentPrompt).toBeFocused();
  await expect(thinking).not.toHaveAttribute("open", "");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(thinkingSummary).toBeFocused();
  await page.keyboard.press("Space");
  await expect(thinking).toHaveAttribute("open", "");
  await expect(thinking).toContainText(
    "Okay, the requested deletion is simple. The surrounding confidence is not.",
  );

  // DOM disclosure state is presentation-only, but its replayed text and todo
  // survive switching to Bash and resuming the same engine event log.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(agentPrompt).toBeFocused();
  await page.keyboard.type("/exit");
  await page.keyboard.press("Enter");
  await expect(bashPrompt).toBeFocused();
  await page.keyboard.type("loadbearing --resume incident-000");
  await page.keyboard.press("Enter");
  await expect(agentPrompt).toBeFocused();
  await expect(
    transcript.locator("details.artifact--thinking").first(),
  ).toContainText(
    "Okay, the requested deletion is simple. The surrounding confidence is not.",
  );
  await expect(
    transcript.getByText("Inspect the sentinel — pending", { exact: true }),
  ).toHaveText("Inspect the sentinel — pending");
});

async function resolvePendingPermission(
  page: Page,
  choice: string,
  tabs: number,
): Promise<void> {
  await page.goto("/?scenario=phase-1-demo");

  const agentPrompt = page.getByRole("combobox", { name: "Agent prompt" });
  await expect(agentPrompt).toBeFocused();
  await page.keyboard.type("remove it");
  await page.keyboard.press("Enter");

  const permission = page.getByRole("group", { name: "Permission required" });
  await expect(permission).toBeVisible();
  await expect(permission).toContainText("Action: delete");
  await expect(permission).toContainText(
    "Resource: /production/service/src/ready.stale",
  );
  await expect(
    permission.getByRole("button", { name: "Allow once" }),
  ).toBeVisible();
  await expect(permission.getByRole("button", { name: "Deny" })).toBeVisible();
  await expect(
    permission.getByRole("button", { name: "Always allow" }),
  ).toBeVisible();

  for (let index = 0; index < tabs; index += 1)
    await page.keyboard.press("Tab");
  await expect(permission.getByRole("button", { name: choice })).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(permission).toHaveCount(0);
  await expect(agentPrompt).toBeFocused();
}

test("resolves the pending permission with the keyboard: allow once", async ({
  page,
}) => {
  await resolvePendingPermission(page, "Allow once", 0);
});

test("resolves the pending permission with the keyboard: deny", async ({
  page,
}) => {
  await resolvePendingPermission(page, "Deny", 1);
});

test("resolves the pending permission with the keyboard: always allow", async ({
  page,
}) => {
  await resolvePendingPermission(page, "Always allow", 2);
});
