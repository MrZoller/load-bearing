import { expect, test } from "@playwright/test";

async function expectNoPageOverflow(page: import("@playwright/test").Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
}

test("keeps long terminal content and controls within a 390px viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const prompt = page.getByRole("combobox", { name: "Agent prompt" });
  // An unknown shell command echoes its 4,000-character name in stderr, which
  // exercises both a long visible prompt and a real long output line.
  await prompt.fill(`!${"x".repeat(4_000)}`);
  await expectNoPageOverflow(page);
  await prompt.press("Enter");
  await expect(
    page.locator(".transcript__output--stderr").last(),
  ).toContainText("command not found");
  await expectNoPageOverflow(page);

  await prompt.fill("/model");
  await prompt.press("Enter");
  await expect(
    page.getByRole("group", { name: "Choose active model" }),
  ).toBeVisible();
  await expectNoPageOverflow(page);

  await page.goto("/");
  const permissionPrompt = page.getByRole("combobox", {
    name: "Agent prompt",
  });
  await permissionPrompt.fill("remove it");
  await permissionPrompt.press("Enter");
  await expect(
    page.getByRole("group", { name: "Permission required" }),
  ).toBeVisible();
  await expectNoPageOverflow(page);
});

test("keeps the focused prompt usable when the mobile viewport height changes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const prompt = page.getByRole("combobox", { name: "Agent prompt" });
  await expect(prompt).toBeFocused();
  await page.setViewportSize({ width: 390, height: 500 });
  await expect(prompt).toBeFocused();
  await expect
    .poll(() =>
      prompt.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.top >= 0 && bounds.bottom <= window.innerHeight;
      }),
    )
    .toBe(true);
  await expectNoPageOverflow(page);
});

test("routes labeled mobile keys through the prompt controller", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const keys = page.getByRole("navigation", { name: "Terminal keys" });
  const prompt = page.getByRole("combobox", { name: "Agent prompt" });
  await expect(keys).toBeVisible();

  await keys.getByRole("button", { name: "Insert slash" }).click();
  await page.keyboard.type("hel");
  await keys.getByRole("button", { name: "Tab completion" }).click();
  await expect(prompt).toHaveValue("/help");
  await expect(prompt).toBeFocused();
  await prompt.press("Enter");

  await prompt.fill("mobile draft");
  await keys.getByRole("button", { name: "Up arrow" }).click();
  await expect(prompt).toHaveValue("/help");
  await keys.getByRole("button", { name: "Down arrow" }).click();
  await expect(prompt).toHaveValue("mobile draft");

  await prompt.fill("");
  await keys.getByRole("button", { name: "Insert exclamation mark" }).click();
  await page.keyboard.type("pw");
  await keys.getByRole("button", { name: "Tab completion" }).click();
  await expect(prompt).toHaveValue("!pwd ");

  await prompt.evaluate((element) => {
    if (!(element instanceof HTMLInputElement))
      throw new TypeError("Agent prompt is not an input");
    element.setSelectionRange(1, 4);
  });
  await keys.getByRole("button", { name: "Left arrow" }).click();
  await expect
    .poll(() =>
      prompt.evaluate((element) => {
        if (!(element instanceof HTMLInputElement))
          throw new TypeError("Agent prompt is not an input");
        return element.selectionStart;
      }),
    )
    .toBe(1);
  await prompt.evaluate((element) => {
    if (!(element instanceof HTMLInputElement))
      throw new TypeError("Agent prompt is not an input");
    element.setSelectionRange(1, 4);
  });
  await keys.getByRole("button", { name: "Right arrow" }).click();
  await expect
    .poll(() =>
      prompt.evaluate((element) => {
        if (!(element instanceof HTMLInputElement))
          throw new TypeError("Agent prompt is not an input");
        return element.selectionStart;
      }),
    )
    .toBe(4);
  await expect(prompt).toBeFocused();
});
