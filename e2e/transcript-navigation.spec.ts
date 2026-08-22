import { expect, test } from "@playwright/test";
import type { Locator } from "@playwright/test";

async function addShellLines(
  prompt: Locator,
  count: number,
  prefix: string,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await prompt.fill(`!pwd ${prefix}-${String(index)}`);
    await prompt.press("Enter");
  }
}

async function expectAtTranscriptBottom(transcript: Locator): Promise<void> {
  await expect
    .poll(() =>
      transcript.evaluate(
        (element) =>
          element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
      ),
    )
    .toBe(true);
}

test("searches the transcript with the keyboard, navigates results, and restores the prompt", async ({
  page,
}) => {
  await page.goto("/");

  const prompt = page.getByRole("textbox", { name: "Agent prompt" });
  await addShellLines(prompt, 2, "search-target");
  await prompt.fill("/model");
  await prompt.press("Enter");

  await prompt.press("Control+f");
  const search = page.getByRole("searchbox", { name: /transcript/i });
  const searchStatus = page.getByRole("status", {
    name: /transcript search/i,
  });
  await expect(search).toBeFocused();
  await search.fill("search-target");
  await expect(searchStatus).toContainText(/1\s*(?:of|\/)\s*2/i);

  await search.press("Enter");
  await expect(searchStatus).toContainText(/2\s*(?:of|\/)\s*2/i);

  // A render from an unrelated control must not reset the reader to match one.
  await page.locator('input[name="active-model"]').nth(1).click();
  await expect(searchStatus).toContainText(/2\s*(?:of|\/)\s*2/i);
  await expect(search).toBeVisible();
  await expect(prompt).toBeFocused();

  await search.press("Escape");
  await expect(search).toBeHidden();
  await expect(prompt).toBeFocused();

  await prompt.fill("!pwd after-search");
  await prompt.press("Enter");
  await expect(page.locator(".transcript__entry--search-match")).toHaveCount(0);
  await expectAtTranscriptBottom(
    page.getByRole("list", { name: "Session transcript" }),
  );
});

test("search interaction postpones the authored idle nudge", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/");

  const prompt = page.getByRole("textbox", { name: "Agent prompt" });
  const transcript = page.getByRole("list", { name: "Session transcript" });
  await page.clock.fastForward(29_000);
  await prompt.press("Control+f");
  const search = page.getByRole("searchbox", { name: /transcript/i });
  await search.fill("incident");
  await page.clock.fastForward(2_000);
  await expect(
    transcript.getByText(
      "The readiness incident remains open. Asking me to inspect it would at least make the uncertainty explicit.",
      { exact: true },
    ),
  ).toHaveCount(0);
});

test("search folding is independent of the browser locale", async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: "tr-TR" });
  const page = await context.newPage();
  await page.goto("/");

  const prompt = page.getByRole("textbox", { name: "Agent prompt" });
  await prompt.press("Control+f");
  const search = page.getByRole("searchbox", { name: /transcript/i });
  await search.fill("incident");
  await expect(
    page.getByRole("status", { name: /transcript search/i }),
  ).toContainText(/1\s*(?:of|\/)\s*[1-9]/i);

  await context.close();
});

test("opens a collapsed artifact that contains the current search match", async ({
  page,
}) => {
  await page.goto("/");

  const prompt = page.getByRole("textbox", { name: "Agent prompt" });
  const transcript = page.getByRole("list", { name: "Session transcript" });
  const thinking = transcript.locator("details.artifact--thinking").first();
  await expect(thinking).not.toHaveAttribute("open", "");

  await prompt.press("Control+f");
  const search = page.getByRole("searchbox", { name: /transcript/i });
  await search.fill("surrounding confidence");

  await expect(thinking).toHaveAttribute("open", "");
  await expect(
    thinking.getByText(
      "Okay, the requested deletion is simple. The surrounding confidence is not.",
      { exact: true },
    ),
  ).toBeVisible();
});

test("leaves selected transcript text available to the browser copy command", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");

  const transcript = page.getByRole("list", { name: "Session transcript" });
  const copied = "Last login: maintenance window still open.";
  await page.evaluate((text) => navigator.clipboard.writeText(text), "");
  await transcript.getByText(copied, { exact: true }).evaluate((element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });

  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+c" : "Control+c",
  );
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(copied);
});

test("bounds scrollback without discarding the newest transcript output", async ({
  page,
}) => {
  // This deliberately drives 300 DOM renders to cross the retention boundary.
  // GitHub's single-worker Chromium can take longer than Playwright's default
  // per-test budget even though the interaction itself remains responsive.
  test.setTimeout(90_000);
  await page.goto("/");

  const prompt = page.getByRole("textbox", { name: "Agent prompt" });
  const transcript = page.getByRole("list", { name: "Session transcript" });
  const entriesBefore = await transcript.getByRole("listitem").count();
  await addShellLines(prompt, 300, "scrollback");

  // The exact retention window is presentation policy, but it must be smaller
  // than a sustained session and it must retain the current end of the log.
  await expect
    .poll(() => transcript.getByRole("listitem").count())
    .toBeLessThan(entriesBefore + 300);
  await expect(
    transcript.getByText("pwd scrollback-0", { exact: true }),
  ).toHaveCount(0);
  await expect(
    transcript.getByText("pwd scrollback-299", { exact: true }),
  ).toBeVisible();
});

test("preserves scrolled-up reading position until new output is acknowledged, then resumes bottom following", async ({
  page,
}) => {
  await page.goto("/");

  const prompt = page.getByRole("textbox", { name: "Agent prompt" });
  const transcript = page.getByRole("list", { name: "Session transcript" });
  const newOutput = page.getByRole("button", { name: /new output/i });
  await addShellLines(prompt, 40, "anchor");

  await transcript.evaluate((element) => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) / 2;
  });
  await expect
    .poll(() => transcript.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  const readingAnchor = await transcript.evaluate((element) => {
    const viewportTop = element.getBoundingClientRect().top;
    const child = Array.from(element.children).find(
      (entry) => entry.getBoundingClientRect().bottom >= viewportTop,
    );
    if (!(child instanceof HTMLElement)) return null;
    return {
      key: child.dataset["transcriptKey"],
      offset: child.getBoundingClientRect().top - viewportTop,
    };
  });
  expect(readingAnchor?.key).toBeDefined();

  await prompt.fill("!pwd while-reading");
  await prompt.press("Enter");
  await expect
    .poll(() =>
      transcript.evaluate((element, expected) => {
        const anchor = Array.from(element.children).find(
          (entry) =>
            entry instanceof HTMLElement &&
            entry.dataset["transcriptKey"] === expected?.key,
        );
        if (!(anchor instanceof HTMLElement) || expected === null) return null;
        return {
          key: anchor.dataset["transcriptKey"],
          offset:
            anchor.getBoundingClientRect().top -
            element.getBoundingClientRect().top,
        };
      }, readingAnchor),
    )
    .toEqual(readingAnchor);
  await expect(newOutput).toBeVisible();

  await newOutput.press("Enter");
  await expectAtTranscriptBottom(transcript);
  await expect(prompt).toBeFocused();

  await prompt.fill("!pwd after-resume");
  await prompt.press("Enter");
  await expectAtTranscriptBottom(transcript);
  await expect(newOutput).toBeHidden();
});

test("keeps the new-output affordance after search restores an old match", async ({
  page,
}) => {
  await page.goto("/");

  const prompt = page.getByRole("textbox", { name: "Agent prompt" });
  const transcript = page.getByRole("list", { name: "Session transcript" });
  const newOutput = page.getByRole("button", { name: /new output/i });
  await addShellLines(prompt, 40, "old-search-target");

  await prompt.press("Control+f");
  const search = page.getByRole("searchbox", { name: /transcript/i });
  await search.fill("old-search-target-39");
  await expectAtTranscriptBottom(transcript);

  // Each new entry first follows the bottom, then search restores the old
  // match. Once enough output arrives to push that match away, the reader
  // must still have a route back to the latest entry.
  await addShellLines(prompt, 40, "new-output");
  await expect(newOutput).toBeVisible();
  await expect
    .poll(() =>
      transcript.evaluate(
        (element) =>
          element.scrollTop + element.clientHeight < element.scrollHeight - 1,
      ),
    )
    .toBe(true);
});
