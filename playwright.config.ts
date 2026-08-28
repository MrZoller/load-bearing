import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: "line",
  projects: [
    {
      name: "desktop",
      testIgnore: /lighthouse-accessibility\.spec\.ts/,
      use: { viewport: { width: 1280, height: 720 } },
    },
    {
      name: "mobile",
      testMatch: [
        /incident-001-acceptance\.spec\.ts/,
        /phase-1-acceptance\.spec\.ts/,
        /responsive-terminal\.spec\.ts/,
      ],
      use: { viewport: { width: 390, height: 844 } },
    },
    {
      name: "lighthouse",
      testMatch: /lighthouse-accessibility\.spec\.ts/,
      use: { viewport: { width: 1440, height: 900 } },
    },
  ],
  use: {
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
    trace: "on-first-retry",
  },
  webServer: {
    command: "npm run preview",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
  },
});
