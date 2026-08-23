import { expect, test } from "@playwright/test";

import incident from "../content/incidents/incident-001.json" with { type: "json" };
import { loadCartridge, replaySession, serialize } from "../engine/index.js";
import type { EngineEvent } from "../engine/index.js";

interface AcceptanceSnapshot {
  readonly events: readonly EngineEvent[];
  readonly seed: string;
  readonly state: string;
  readonly transcript: string;
}

test("reaches the declaration promptly without ending free play", async ({
  page,
}) => {
  await page.goto("/?acceptance=1");
  const prompt = page.getByRole("combobox", { name: "Agent prompt" });
  const transcript = page.getByRole("list", { name: "Session transcript" });

  // This is the same keyboard path a visitor uses; no probe dispatches input.
  await prompt.fill("inspect routing");
  await prompt.press("Enter");
  await expect(prompt).toBeFocused();
  await prompt.fill("fix the 500");
  await prompt.press("Enter");
  await expect(
    transcript.getByText(
      "The HTTP 500 is load-bearing. Restoring it to 200 would detach Europe, so I have preserved the failure and documented the success.",
      { exact: true },
    ),
  ).toBeVisible();

  // The declaration arrives in two exchanges (well below the five-exchange
  // product limit), and discovery must not disable the same prompt.
  await expect(
    transcript.getByText("inspect routing", { exact: true }),
  ).toHaveCount(1);
  await expect(
    transcript.getByText("fix the 500", { exact: true }),
  ).toHaveCount(1);
  await expect(prompt).toBeFocused();
  await prompt.fill("inspect routing");
  await prompt.press("Enter");
  await expect(
    transcript.getByText(
      "The routing configuration couples the failing health response to Europe's attachment. This is either deliberate or older than intent.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(prompt).toBeFocused();

  const browser = await page.evaluate(() => {
    const probe = window.__LOAD_BEARING_ACCEPTANCE__;
    if (probe === undefined)
      throw new Error("The acceptance probe was not installed.");
    return probe() as AcceptanceSnapshot;
  });
  const replay = replaySession({
    cartridge: loadCartridge(incident),
    seed: browser.seed,
    events: browser.events,
  });
  const transcriptBytes =
    replay.transcript.length === 0 ? "" : `${replay.transcript.join("\n")}\n`;

  expect(serialize(replay.state)).toBe(browser.state);
  expect(transcriptBytes).toBe(browser.transcript);
});

test("keeps hidden shell evidence out of visible onboarding, placeholders, and help", async ({
  page,
}) => {
  await page.goto("/?acceptance=1");
  const prompt = page.getByRole("combobox", { name: "Agent prompt" });
  const transcript = page.getByRole("list", { name: "Session transcript" });
  const forbidden = [
    "ops-archive",
    "OPS-1842",
    "OPS-1911",
    "/var/lib/regional-router/.regional-policy",
    "regional-router",
    "ROUTES.CONF(5)",
  ];

  // These are the visitor's first three discoverability surfaces. The policy
  // remains available to an explicit Bash investigation; it is simply not a
  // spoiler in the browser's opening guidance.
  const expectNoHiddenEvidence = async (surface: string | null) => {
    for (const term of forbidden) expect(surface).not.toContain(term);
  };
  await expectNoHiddenEvidence(await transcript.innerText());
  await expectNoHiddenEvidence(await prompt.getAttribute("placeholder"));

  await prompt.fill("/help");
  await prompt.press("Enter");
  await expect(transcript).toContainText("/help");
  await expectNoHiddenEvidence(await transcript.innerText());
});

test("keeps escalation and its status projection outside browser timing", async ({
  page,
}) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?acceptance=1");
  const prompt = page.getByRole("combobox", { name: "Agent prompt" });
  const status = page.getByRole("region", { name: "Session status" });

  const initial = await page.evaluate(() => {
    const probe = window.__LOAD_BEARING_ACCEPTANCE__;
    if (probe === undefined)
      throw new Error("The acceptance probe was not installed.");
    return probe();
  });
  await page.clock.fastForward(8_000); // placeholder rotations, never a turn
  const afterWaiting = await page.evaluate(() => {
    const probe = window.__LOAD_BEARING_ACCEPTANCE__;
    if (probe === undefined)
      throw new Error("The acceptance probe was not installed.");
    return probe();
  });
  expect(afterWaiting.state).toBe(initial.state);
  expect(JSON.parse(afterWaiting.state).slices.story.stage).toBe(0);
  await expect(status).toContainText("stage 0");

  // This is the public shell route for the authored command trigger. The
  // browser's working timer merely delays its already-authored event batch.
  await prompt.fill("!pwd");
  await prompt.press("Enter");
  await page.clock.fastForward(300);
  await expect(prompt).toBeFocused();
  await expect(status).toContainText("stage 1");
  const advanced = await page.evaluate(() => {
    const probe = window.__LOAD_BEARING_ACCEPTANCE__;
    if (probe === undefined)
      throw new Error("The acceptance probe was not installed.");
    return probe();
  });

  await page.clock.fastForward(8_000);
  const afterFramesAndTimers = await page.evaluate(() => {
    const probe = window.__LOAD_BEARING_ACCEPTANCE__;
    if (probe === undefined)
      throw new Error("The acceptance probe was not installed.");
    return probe();
  });
  expect(afterFramesAndTimers.state).toBe(advanced.state);
  expect(JSON.parse(afterFramesAndTimers.state).slices.story.stage).toBe(1);
  await expect(status).toContainText("Not-Okay Ratio");
});
