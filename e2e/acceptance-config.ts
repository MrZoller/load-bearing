export const INCIDENT_001_RARE_HIT_SEED = "2026-08-23/53/callback-10";

export async function configureAcceptanceSeed(
  page: import("@playwright/test").Page,
  seed: string,
): Promise<void> {
  await page.addInitScript((configuredSeed) => {
    window.__LOAD_BEARING_ACCEPTANCE_CONFIG__ = { seed: configuredSeed };
  }, seed);
}
