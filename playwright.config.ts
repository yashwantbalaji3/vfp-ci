import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests run against a local production build (`pnpm build` first) and the
 * local Supabase stack. Nothing here talks to hosted services.
 */
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "off",
    // Optional: point at a preinstalled Chromium (e.g. in a sandbox) instead of `playwright install`.
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, args: ["--no-sandbox"] }
      : {},
  },
  projects: [
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "pnpm start --port 3000",
    url: "http://localhost:3000/health",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
