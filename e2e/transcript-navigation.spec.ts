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
  await search.press("Escape");
  await expect(search).toBeHidden();
  await expect(prompt).toBeFocused();
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
