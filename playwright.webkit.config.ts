import { defineConfig, devices } from "@playwright/test";

/**
 * Safari-engine run of the real-data release checks (docs/72). DRAFTED, NOT RUN HERE: this cloud workspace has
 * Chromium only. On a Mac, Playwright's WebKit build is the closest automated stand-in for Safari; it is not
 * Safari itself, so docs/72 keeps a short manual Safari pass as the acceptance gate.
 *
 * Needs the WebKit browser once (`pnpm exec playwright install webkit`, about 100 MB in the user's cache; only with
 * the owner's approval on their Mac) and the real server already running on port 3000 (REUSE_REAL_SERVER=true).
 */
export default defineConfig({
  testDir: "tests/e2e-real",
  testMatch: ["release-gate.spec.ts", "today.spec.ts", "real-day.spec.ts", "member-beta.spec.ts", "menu-preview.spec.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:3000", trace: "off" },
  projects: [
    { name: "webkit-iphone", use: { ...devices["iPhone 14"] } },
    { name: "webkit-desktop", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "echo 'Start the real server first (see docs/72)' && exit 1",
    url: "http://localhost:3000/health",
    reuseExistingServer: true,
    timeout: 10_000,
  },
});
