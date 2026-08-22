import { expect, test } from "@playwright/test";

test("renders and drives the production terminal with the keyboard", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => failedRequests.push(request.url()));

  await page.goto("/");

  const terminal = page.getByRole("main", { name: "Load Bearing terminal" });
  const prompt = page.getByRole("textbox", { name: "Terminal command" });
  const transcript = page.getByRole("list", { name: "Session transcript" });

  await expect(terminal).toBeVisible();
  await expect(
    page.getByText("loadbearing.cc · Incident #000", { exact: true }),
  ).toBeVisible();
  await expect(prompt).toBeFocused();
  await expect(transcript).toContainText("/production/service");

  await page.keyboard.type("pwd");
  await page.keyboard.press("Enter");

  await expect(transcript.getByRole("listitem")).toHaveCount(4);
  await expect(
    transcript.getByText("/production/service", { exact: true }),
  ).toHaveCount(2);
  expect(pageErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});
