import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";
import { completeSignIn } from "../e2e/helpers";

/**
 * Loading states on a slow connection (docs/72 section 4). Chromium's network emulation: 400 ms extra latency and
 * about 50 KB/s each way. Checks that a first load shows the page frame or a skeleton, never a blank screen, that a
 * tap on a link shows "Loading..." while the next page is on its way, and that the next page then arrives.
 * Adds only its own sign-in account.
 */
test.use({ timezoneId: "America/New_York" });
test.setTimeout(240_000);

test("slow network: visible progress, never a blank screen", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "America/New_York" });
  const page = await context.newPage();
  const email = `slow-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2Ftoday");
  await completeSignIn(page, email);
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
  await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher') on conflict do nothing", [id]);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 400, downloadThroughput: 50 * 1024, uploadThroughput: 50 * 1024 });

  // A first load: something meaningful is on screen within 8 s on this connection.
  const t = Date.now();
  await page.goto("/discover", { waitUntil: "commit" });
  await expect(page.locator("main:visible, [data-testid='meal-skeleton']").first()).toBeVisible({ timeout: 8_000 });
  console.log(`discover: first content after ${Date.now() - t} ms on the slow profile`);
  await page.waitForLoadState("load", { timeout: 120_000 });

  // A tap on a link: "Loading..." appears while the next page is on its way, then the page arrives and it goes.
  const link = page.locator("main:visible a[href^='/meals/'], main:visible a[href^='/places/']").first();
  test.skip((await link.count()) === 0, "Needs the real menus loaded");
  const target = await link.getAttribute("href");
  await link.click();
  await expect(page.getByTestId("nav-progress")).toBeVisible({ timeout: 5_000 });
  await page.waitForURL((u) => u.pathname === new URL(target!, "http://x").pathname, { timeout: 120_000 });
  await expect(page.getByTestId("nav-progress")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator("main:visible h1").first()).toBeVisible({ timeout: 60_000 });
  await context.close();
});
