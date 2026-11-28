import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { IDS, M4 } from "../fixtures/ids";
import { asMember, pool } from "../helpers/db";
import { completeSignIn } from "./helpers";

/**
 * The public social switch (SOCIAL_PUBLIC_ENABLED, docs/17 D-M5-GUEST), tested both ways
 * for a signed-out visitor.
 *
 * The usual test server (port 3000) runs with the switch ON. This file starts a second
 * copy of the same build on a free port with the switch OFF, asks both the same questions
 * and compares the answers. With either setting, private data (diary, goals, cooking,
 * plans, own foods) must stay out of reach.
 */
const ON = "http://localhost:3000";
let OFF = ""; // set when the second server starts, on a port that is free at that moment
const DEMO_HANDLE = "demo_maya";
const DEMO_LIST = "00000000-0000-4000-8000-000000520001";

let offServer: ChildProcess | undefined;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      probe.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("no free port"))));
    });
  });
  OFF = `http://localhost:${port}`;
  offServer = spawn("pnpm", ["start", "--port", String(port)], {
    env: { ...process.env, SOCIAL_PUBLIC_ENABLED: "false" },
    stdio: "ignore",
    detached: true,
  });
  for (let i = 0; i < 240; i++) {
    const up = await fetch(`${OFF}/health`).then((r) => r.ok, () => false);
    if (up) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("The second server (switch off) did not start");
});
test.afterAll(async () => {
  // The database pool is shared with the other browser test files in this run, so it is not closed here.
  // Stop the whole process group: `pnpm start` runs the server as a child.
  if (offServer?.pid) {
    try {
      process.kill(-offServer.pid, "SIGTERM");
    } catch {
      /* already stopped */
    }
  }
});

const SOCIAL_READS = [
  `/api/v1/users/${DEMO_HANDLE}`,
  `/api/v1/lists?id=${DEMO_LIST}`,
  "/api/v1/lists?editorial=1",
  `/api/v1/reviews?kind=venue&id=${IDS.venueHarvard}`,
];
// Never open to a signed-out visitor, whatever the switch says.
const MEMBERS_ONLY = [
  "/api/v1/profile", "/api/v1/friendships", "/api/v1/reviews", "/api/v1/ranking", "/api/v1/lists", "/api/v1/feed",
  "/api/v1/feed?recommendations=1", "/api/v1/moderation", "/api/v1/diary", "/api/v1/goals", "/api/v1/cook-sessions", "/api/v1/plan",
  "/api/v1/me", "/api/v1/me/export", "/api/v1/diary/week",
];
const PRIVATE_PAGES = ["/diary", "/diary/week", "/diary/goals", "/cook/plan", "/friends/reviews", "/friends/ranking", "/friends/lists", "/friends/people", "/moderation", "/account"];
const visible = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });

test.describe("a signed-out visitor with the public social switch OFF", () => {
  test("the API refuses every social read and leaks no content", async ({ playwright }) => {
    const guest: APIRequestContext = await playwright.request.newContext({ baseURL: OFF });
    for (const path of SOCIAL_READS) {
      const res = await guest.get(path);
      expect(res.status(), path).toBe(401);
      const text = await res.text();
      expect(text, path).toContain("NOT_SIGNED_IN");
      expect(text, path).not.toMatch(/Maya|demo_|Demo collection|"rating"/);
      expect(res.headers()["cache-control"], path).toContain("no-store");
    }
    await guest.dispose();
  });

  test("profile and list pages show only a sign-in invitation; restaurant pages show no review text or names", async ({ browser }) => {
    const context = await browser.newContext({ baseURL: OFF });
    const page = await context.newPage();
    for (const path of [`/u/${DEMO_HANDLE}`, `/lists/${DEMO_LIST}`]) {
      await page.goto(path);
      await expect(visible(page, "social-signin"), path).toBeVisible();
      await expect(page.locator("main"), path).not.toContainText(/Maya|Demo review|Demo collection/);
    }
    await page.goto("/friends");
    await expect(visible(page, "social-signin")).toBeVisible();
    await expect(page.getByTestId("collections")).toHaveCount(0);
    await expect(page.getByTestId("feed")).toHaveCount(0);
    // A restaurant page keeps the count and average, with nobody's words or name.
    await page.goto(`/venues/${IDS.venueHarvard}`);
    await expect(visible(page, "reviews-section")).toBeVisible();
    await expect(visible(page, "reviews-section")).not.toContainText(/Maya|Demo review|@demo_/);
    await expect(visible(page, "reviews-section").getByTestId("review")).toHaveCount(0);
    await context.close();
  });
});

test.describe("a signed-out visitor with the public social switch ON", () => {
  test("approved public content is readable, and only that", async ({ playwright, browser }) => {
    const guest = await playwright.request.newContext({ baseURL: ON });
    for (const path of SOCIAL_READS) expect((await guest.get(path)).status(), path).toBe(200);
    const profile = (await (await guest.get(`/api/v1/users/${DEMO_HANDLE}`)).json()).data;
    expect(profile.profile.handle).toBe(DEMO_HANDLE);
    expect(profile.relationship).toBeNull();
    for (const r of profile.reviews) expect(r).toMatchObject({ audience: "public", state: "visible" });
    await guest.dispose();

    const context = await browser.newContext({ baseURL: ON });
    const page = await context.newPage();
    await page.goto(`/u/${DEMO_HANDLE}`);
    await expect(page.locator("main").filter({ visible: true })).toContainText("Maya");
    await expect(page.locator("main").filter({ visible: true })).toContainText(/demo/i);
    await context.close();
  });
});

for (const name of ["OFF", "ON"] as const) {
  const baseOf = () => (name === "OFF" ? OFF : ON);
  test.describe(`private data with the switch ${name}`, () => {
    test("a signed-out visitor cannot reach any members-only answer", async ({ playwright }) => {
      const guest = await playwright.request.newContext({ baseURL: baseOf() });
      for (const path of MEMBERS_ONLY) {
        const res = await guest.get(path);
        // 429 (too many requests) is also a refusal: it can appear when this file is run several times within a minute.
        expect([401, 404, 429], `${path} answered ${res.status()}`).toContain(res.status());
        expect(await res.text(), path).not.toMatch(/diaryEntries|protein_g|cookSession|mealSlot|"entries"/);
      }
      // Writing is refused as well.
      const write = await guest.post("/api/v1/reviews", { data: { kind: "venue", targetId: IDS.venueHarvard, rating: 5 } });
      expect([401, 403, 429]).toContain(write.status());
      await guest.dispose();
    });

    test("a signed-out visitor who opens a private page is sent to sign in", async ({ browser }) => {
      const context = await browser.newContext({ baseURL: baseOf() });
      const page = await context.newPage();
      for (const path of PRIVATE_PAGES) {
        await page.goto(path);
        await expect
          .poll(async () => /\/login/.test(page.url()) || (await page.getByText(/sign in/i).filter({ visible: true }).count()) > 0, { message: path })
          .toBe(true);
        await expect(page.getByTestId("diary-entry"), path).toHaveCount(0);
      }
      await context.close();
    });

    test("a member's diary, goal, own food, plan and cooking never appear on their public profile or in social answers", async ({ browser, playwright }) => {
      test.setTimeout(150_000);
      // The member signs in on the usual server; the sign-in is valid on both copies.
      const context = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: "America/New_York" });
      const page = await context.newPage();
      const email = `m5-switch-${randomUUID().slice(0, 8)}@example.test`;
      const handle = `sw_${randomUUID().slice(0, 8)}`;
      const secret = `Switch bar ${randomUUID().slice(0, 6)}`;
      await page.goto(`${ON}/login?next=${encodeURIComponent("/friends/profile")}`);
      await completeSignIn(page, email);
      await expect(page).toHaveURL(/\/friends\/profile/);
      await page.getByLabel("Handle", { exact: true }).fill(handle);
      await page.getByLabel(/Let people find me/).check();
      await page.getByRole("button", { name: "Save profile" }).click();
      await expect(page.getByTestId("flash").filter({ hasText: "Profile saved." })).toBeVisible();
      // Private data, saved the same way the app saves it.
      // "Today" as the member's own diary page sees it (New York), not the UTC date: the two differ every evening.
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const uid = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
      const save = (sql: string, params: unknown[]) => asMember(uid, (c) => c.query(sql, params), { commit: true });
      await save("select public.set_goal('protein_g_per_day', 77, $1)", [today]);
      await save("select public.log_new_custom_food($1, $2, null, $3, '1 bar', 40, 1, 'home', 'snack', $4, $5)", [
        randomUUID(), secret, JSON.stringify({ protein_g: 12, energy_kcal: 180 }), today, "America/New_York",
      ]);
      await save("select public.plan_recipe($1, $2, 2, 'dinner', true)", [M4.recipe(M4.chana), today]);
      const started = await save("select public.start_cook_session($1, $2, 2, '{}', $3, $4, null, true) as r", [randomUUID(), M4.recipe(M4.dal), today, "America/New_York"]);
      expect(started.rows[0].r.sessionId).toBeTruthy();
      // The owner really has it: their own diary page shows the food.
      await page.goto(`${baseOf()}/diary`);
      await expect(page.locator("main").filter({ visible: true })).toContainText(secret);

      const guest = await playwright.request.newContext({ baseURL: baseOf() });
      const answers: string[] = [];
      for (const path of [`/api/v1/users/${handle}`, `/api/v1/users/${handle}?view=needs_confirmation`, "/api/v1/lists?editorial=1", `/api/v1/reviews?kind=venue&id=${IDS.venueHarvard}`]) {
        answers.push(await (await guest.get(path)).text());
      }
      const pageText = await (await guest.get(`/u/${handle}`)).text();
      for (const text of [...answers, pageText]) {
        expect(text).not.toContain(secret);
        expect(text).not.toMatch(/protein_g_per_day|"target":77|diaryEntries|cook_session/);
        expect(text).not.toContain(email);
      }
      await guest.dispose();
      await context.close();
    });
  });
}
