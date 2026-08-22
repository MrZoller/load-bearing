import { expect, test } from "@playwright/test";

test("keeps the stable terminal surface semantic, named, and visibly focused", async ({
  page,
}) => {
  await page.goto("/");

  const terminal = page.getByRole("main", { name: "Load Bearing terminal" });
  const transcript = page.getByRole("list", { name: "Session transcript" });
  const prompt = page.getByRole("textbox", { name: "Agent prompt" });
  const liveOutput = page.getByRole("status", { name: "New terminal output" });

  await expect(terminal).toBeVisible();
  await expect(transcript).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Session status" }),
  ).toBeVisible();
  await expect(liveOutput).toHaveAttribute("aria-live", "polite");
  await expect(liveOutput).toHaveAttribute("aria-atomic", "true");
  await expect(liveOutput).toBeEmpty();

  await expect
    .poll(() =>
      terminal.evaluate((element) =>
        [
          ".terminal__assignment",
          ".transcript-search",
          ".transcript",
          ".terminal__view",
          ".terminal__status",
        ].map((selector) => {
          const child = element.querySelector(selector);
          return child === null ? -1 : [...element.children].indexOf(child);
        }),
      ),
    )
    .toEqual([1, 2, 3, 6, 7]);

  await expect(
    transcript.locator('[aria-label^="Shell command:"]').first(),
  ).toBeVisible();
  await expect(
    transcript.locator('[aria-label^="Agent:"]').first(),
  ).toBeVisible();

  await expect(prompt).toBeFocused();
  await expect
    .poll(() =>
      prompt.evaluate((element) => getComputedStyle(element).boxShadow),
    )
    .not.toBe("none");

  await prompt.press("Control+f");
  const search = page.getByRole("searchbox", { name: /transcript/i });
  await expect(search).toBeFocused();
  await expect
    .poll(() =>
      search.evaluate((element) => getComputedStyle(element).outlineStyle),
    )
    .not.toBe("none");
});

test("announces only newly rendered agent and shell output", async ({
  page,
}) => {
  await page.goto("/");

  const prompt = page.getByRole("textbox", { name: "Agent prompt" });
  const liveOutput = page.getByRole("status", { name: "New terminal output" });
  await liveOutput.evaluate((element) => {
    element.dataset["mutations"] = "0";
    new MutationObserver(() => {
      element.dataset["mutations"] = String(
        Number(element.dataset["mutations"] ?? "0") + 1,
      );
    }).observe(element, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });

  // The cold open and visitor command were already present when the announcer
  // was seeded, so neither is replayed to assistive technology.
  await expect(liveOutput).toBeEmpty();
  await prompt.fill("!pwd");
  await prompt.press("Enter");
  await expect(liveOutput).toHaveText("Shell output: /production/service");
  await expect(liveOutput).not.toContainText("pwd");
  await expect.poll(() => liveOutput.getAttribute("data-mutations")).toBe("1");

  // A presentation-only command rerenders the transcript but must not repeat
  // output that was already keyed and announced.
  await prompt.fill("/model");
  await prompt.press("Enter");
  await expect(
    page.getByRole("group", { name: "Choose active model" }),
  ).toBeVisible();
  await expect(liveOutput).toHaveText("Shell output: /production/service");
  await expect(liveOutput).toHaveAttribute("data-mutations", "1");
});

test("reduced motion preserves cold-open, activity, and status information", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await page.goto("/");

  const transcript = page.getByRole("list", { name: "Session transcript" });
  const prompt = page.getByRole("textbox", { name: "Agent prompt" });
  const status = page.getByRole("region", { name: "Session status" });

  await expect(transcript).toContainText(
    "Last login: maintenance window still open.",
  );
  await expect(transcript).toContainText("loadbearing --resume incident-000");
  await expect(status).toContainText("model Structural Audit");
  await expect(status).toContainText(/tokens [\d,]+/);
  await expect(status).toContainText(/cost \$[\d,]+\.\d{6}/);
  await expect(status).toContainText(/context \d+%/);
  await expect(status).toContainText(/integrity [\d,]+/);
  await expect(status).toContainText("loadbearing.cc · Incident #000");

  await prompt.fill("inspect it");
  await prompt.press("Enter");
  const activity = page.locator("[data-agent-activity]");
  await expect(activity).toBeVisible();
  await expect(activity).toContainText(/0s · [\d,]+ tokens · Esc to interrupt/);
  await expect(activity).toHaveAttribute("aria-label", "Agent activity");
  await expect
    .poll(() =>
      activity.evaluate(
        (element) => getComputedStyle(element, "::before").animationName,
      ),
    )
    .toBe("none");

  const productText = await page.locator("body").innerText();
  expect(productText).not.toMatch(
    /OpenAI|Anthropic|ChatGPT|Claude|Gemini|Copilot/i,
  );
  await expect(page.locator(".beam")).toHaveAttribute("aria-hidden", "true");
});
