import { defineConfig, devices } from "@playwright/test";

/**
 * The hosted foundation beta, rehearsed locally (docs/98): every release flag off, its own build folder (.next-foundation),
 * port 3000 (sign-in links return there, so stop any other server first). The database must be built first with
 * `VFP_SANDBOX=1 bash scripts/ci/foundation-db.sh <package> <recipe bundle>` (it resets the LOCAL database).
 */
const env = [
  "NEXT_DIST_DIR=.next-foundation",
  "PUBLIC_RELEASE_ENABLED=false",
  "SOCIAL_PUBLIC_ENABLED=false",
  "ALLOW_DEMO_CONTENT=false",
  "REAL_CATALOG_PREVIEW=false",
  "REAL_DISCOVERY=false",
  "MAP_ENABLED=false",
  "PARTNER_SUBMISSIONS=false",
].join(" ");
export default defineConfig({
  testDir: "tests/e2e-foundation",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "off",
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
    reuseExistingServer: process.env.REUSE_FOUNDATION_SERVER === "true",
    timeout: 600_000,
  },
});
