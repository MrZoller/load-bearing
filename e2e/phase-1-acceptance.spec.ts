import { expect, test } from "@playwright/test";
import phaseOneDemo from "../content/incidents/phase-1-demo.json" with { type: "json" };
import { loadCartridge, replaySession, serialize } from "../engine/index.js";
import type { EngineEvent } from "../engine/index.js";

interface AcceptanceSnapshot {
  readonly events: readonly EngineEvent[];
  readonly seed: string;
  readonly state: string;
  readonly transcript: string;
}

declare global {
  interface Window {
    __acceptanceRafTicks?: number;
  }
}

async function readAcceptanceSnapshot(
  page: import("@playwright/test").Page,
): Promise<AcceptanceSnapshot> {
  return page.evaluate(() => {
    const probe = window.__LOAD_BEARING_ACCEPTANCE__;
    if (probe === undefined)
      throw new Error("The acceptance probe was not installed.");
    return probe();
  });
}

async function expectFocusedVisible(
  locator: import("@playwright/test").Locator,
): Promise<void> {
  await expect(locator).toBeVisible();
  await expect(locator).toBeFocused();
}

test("replays a complete keyboard-only browser session byte-for-byte", async ({
  page,
}) => {
  await page.goto("/?acceptance=1");

  const transcript = page.getByRole("list", { name: "Session transcript" });
  const agentPrompt = page.getByRole("textbox", { name: "Agent prompt" });
  const bashPrompt = page.getByRole("textbox", { name: "Bash command" });

  // Cold open enters the TUI, and all subsequent visitor input uses the
  // keyboard rather than a test-only dispatch path or pointer interaction.
  await expectFocusedVisible(agentPrompt);
  await expect(
    transcript.getByText("loadbearing --resume incident-000", { exact: true }),
  ).toBeVisible();

  await page.keyboard.type("remove it");
  await page.keyboard.press("Enter");
  const permission = page.getByRole("group", { name: "Permission required" });
  const allowOnce = permission.getByRole("button", { name: "Allow once" });
  await expectFocusedVisible(allowOnce);
  await page.keyboard.press("Enter");
  await expect(permission).toBeHidden();
  await expectFocusedVisible(agentPrompt);

  await page.keyboard.type("!pwd");
  await page.keyboard.press("Enter");
  await expect(
    transcript.getByText("/production/service", { exact: true }),
  ).toBeVisible();
  await expectFocusedVisible(agentPrompt);

  await page.keyboard.type("/exit");
  await page.keyboard.press("Enter");
  await expectFocusedVisible(bashPrompt);

  await page.keyboard.type("rm src/ready.stale");
  await page.keyboard.press("Enter");
  await expectFocusedVisible(bashPrompt);

  await page.keyboard.type("loadbearing --resume incident-000");
  await page.keyboard.press("Enter");
  await expectFocusedVisible(agentPrompt);
  await expect(
    transcript.getByText(
      "The machine changed while I was absent. I have incorporated the discrepancy as prior intent.",
      { exact: true },
    ),
  ).toBeVisible();

  await page.keyboard.type("/model");
  await page.keyboard.press("Enter");
  const modelSelector = page.getByRole("group", {
    name: "Choose active model",
  });
  const structuralAudit = modelSelector.getByRole("radio", {
    name: /Structural Audit/,
  });
  await expectFocusedVisible(structuralAudit);
  await page.keyboard.press("ArrowDown");
  await expectFocusedVisible(agentPrompt);
  await expect(
    page.getByRole("region", { name: "Session status" }),
  ).toContainText("model Temporary Bracing");

  await page.keyboard.type("/compact");
  await page.keyboard.press("Enter");
  await expectFocusedVisible(agentPrompt);
  await expect(
    transcript.getByText(
      "Context compacted. I retained the conclusion and released several facts that appeared decorative.",
      { exact: true },
    ),
  ).toBeVisible();

  await page.keyboard.type("/exit");
  await page.keyboard.press("Enter");
  await expectFocusedVisible(bashPrompt);
  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
  await expectFocusedVisible(bashPrompt);
  await expect(
    transcript.getByText("exit is load-bearing", { exact: true }),
  ).toBeVisible();

  const browser = await readAcceptanceSnapshot(page);
  const replay = replaySession({
    cartridge: loadCartridge(phaseOneDemo),
    seed: browser.seed,
    events: browser.events,
  });
  const transcriptBytes =
    replay.transcript.length === 0 ? "" : `${replay.transcript.join("\n")}\n`;

  expect(serialize(replay.state)).toBe(browser.state);
  expect(transcriptBytes).toBe(browser.transcript);
});

test("keeps browser presentation activity outside the replay record", async ({
  page,
}) => {
  await page.addInitScript(() => {
    let ticks = 0;
    const requestFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) =>
      requestFrame((time) => {
        ticks += 1;
        callback(time);
      });
    Object.defineProperty(window, "__acceptanceRafTicks", {
      get: () => ticks,
    });
  });
  await page.goto("/?acceptance=1");

  const prompt = page.getByRole("textbox", { name: "Agent prompt" });
  const transcript = page.getByRole("list", { name: "Session transcript" });
  await page.keyboard.type("inspect it");
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-agent-activity]")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__acceptanceRafTicks))
    .toBeGreaterThanOrEqual(5);
  await expectFocusedVisible(prompt);

  // The completed authored turn gives presentation time no remaining engine
  // work to fold. Keep this well below the 30-second idle-nudge threshold.
  await expect(
    transcript.getByText(
      "I will inspect the sentinel before changing the forces currently passing through it.",
      { exact: true },
    ),
  ).toBeVisible();
  const before = await readAcceptanceSnapshot(page);
  const startedAt = await page.evaluate(() => performance.now());

  await page.keyboard.press("Control+f");
  await expectFocusedVisible(
    page.getByRole("searchbox", { name: /transcript/i }),
  );
  await page.keyboard.press("Escape");
  await expectFocusedVisible(prompt);
  await transcript.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expectFocusedVisible(prompt);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expectFocusedVisible(prompt);

  const after = await readAcceptanceSnapshot(page);
  const elapsedMs = await page.evaluate(
    (started) => performance.now() - started,
    startedAt,
  );
  expect(elapsedMs).toBeLessThan(30_000);
  expect(after.events).toEqual(before.events);
  expect(after.state).toBe(before.state);
  expect(after.transcript).toBe(before.transcript);
});
