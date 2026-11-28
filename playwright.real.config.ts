import { defineConfig, devices } from "@playwright/test";

/**
 * Demo-to-real rehearsal (docs/37): the same app built and started with REAL_DISCOVERY on and demo
 * content off, in its own build folder (.next-real) on port 3000 (the sign-in links return there, so stop the normal server first). Run with `pnpm test:e2e:real`
 * after the local stack is up. It reads and adds test rows only; it never deletes demo data.
 */
const env = "NEXT_DIST_DIR=.next-real REAL_DISCOVERY=true ALLOW_DEMO_CONTENT=false";
export default defineConfig({
  testDir: "tests/e2e-real",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "off",
    // A stuck click or page load fails within a minute and names the step, instead of using up the whole test's time
    // (timed-journeys hung on one click three times, 23-24 Nov 2026).
    actionTimeout: 45_000,
    navigationTimeout: 60_000,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, args: ["--no-sandbox"] }
      : {},
  },
  projects: [{ name: "mobile-chromium", use: { ...devices["Pixel 7"] } }],
  webServer: {
    command: `${env} pnpm exec next build && ${env} pnpm exec next start --port 3000`,
    url: "http://localhost:3000/health",
    reuseExistingServer: process.env.REUSE_REAL_SERVER === "true",
    timeout: 600_000,
  },
});
