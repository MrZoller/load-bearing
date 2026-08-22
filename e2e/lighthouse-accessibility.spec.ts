import { chromium, expect, test } from "@playwright/test";
import { launch } from "chrome-launcher";
import lighthouse from "lighthouse";

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

function failedAccessibilityAudits(
  result: NonNullable<Awaited<ReturnType<typeof lighthouse>>>,
) {
  const category = result.lhr.categories.accessibility;
  if (category === undefined) return "accessibility: category was not produced";

  return category.auditRefs
    .flatMap((reference) => {
      const audit = result.lhr.audits[reference.id];
      if (
        audit === undefined ||
        audit.score === 1 ||
        audit.scoreDisplayMode === "informative" ||
        audit.scoreDisplayMode === "manual" ||
        audit.scoreDisplayMode === "notApplicable"
      )
        return [];
      return [
        `${audit.id}: ${audit.title}\n` +
          `  ${audit.explanation ?? audit.description}\n` +
          `  details: ${JSON.stringify(audit.details)}`,
      ];
    })
    .join("\n");
}

test("Lighthouse reports a perfect accessibility score", async ({
  baseURL,
}) => {
  test.setTimeout(60_000);
  if (baseURL === undefined) throw new Error("Playwright baseURL is required");

  let chrome: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    chrome = await launch({
      chromePath: chromium.executablePath(),
      chromeFlags: [
        `--window-size=${DESKTOP_VIEWPORT.width},${DESKTOP_VIEWPORT.height}`,
      ],
      logLevel: "silent",
    });

    const result = await lighthouse(baseURL, {
      formFactor: "desktop",
      onlyCategories: ["accessibility"],
      output: "json",
      port: chrome.port,
      screenEmulation: {
        ...DESKTOP_VIEWPORT,
        deviceScaleFactor: 1,
        mobile: false,
      },
    });

    expect(result, "Lighthouse did not produce an audit result").toBeDefined();
    if (result === undefined) return;

    const accessibility = result.lhr.categories.accessibility;
    expect(
      accessibility,
      "Lighthouse did not produce an accessibility category",
    ).toBeDefined();
    if (accessibility === undefined) return;
    const score = accessibility.score;
    expect(
      score,
      `Failed accessibility audits:\n${failedAccessibilityAudits(result)}`,
    ).toBe(1);
  } finally {
    chrome?.kill();
  }
});
