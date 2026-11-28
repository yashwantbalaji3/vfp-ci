import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { pool } from "../helpers/db";
import { completeSignIn } from "../e2e/helpers";

/**
 * Timed journeys (owner direction 22 Nov 2026, P2 part 2 and benchmarks; docs/68). The founder, on a phone,
 * does nine everyday things from where a person would start, counting taps and typed fields and timing each
 * journey on this computer's local build. It checks each journey ends where it should, and writes the
 * measurements to AUDIT_DIR/journeys.json so a later build can be compared. Times are local and indicative
 * only: they include the test browser's own work, not a phone network.
 */
test.use({ timezoneId: "America/New_York" });
test.setTimeout(600_000);
const OUT = process.env.AUDIT_DIR ?? "test-results/journeys";

let ready = false;
test.beforeAll(async () => {
  const r = await pool.query(`
    select (select count(*)::int from staging.live_catalog_links) links,
           (select count(*)::int from public.food_items where kind = 'recipe' and not is_demo) recipes`);
  ready = r.rows[0].links >= 8 && r.rows[0].recipes >= 1;
});

type Row = { journey: string; taps: number; typed: number; ms: number; splits: number[]; done: boolean };

test("nine everyday journeys, timed, on a phone", async ({ browser }) => {
  test.skip(!ready, "Needs the real menus and recipes loaded");
  mkdirSync(OUT, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: "America/New_York" });
  const page = await context.newPage();
  const email = `journey-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2Fdiscover");
  await completeSignIn(page, email);
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id;
  await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher') on conflict do nothing", [id]);

  const rows: Row[] = [];
  async function journey(name: string, start: string, run: (tap: (f: () => Promise<unknown>) => Promise<void>, type: (f: () => Promise<unknown>) => Promise<void>) => Promise<void>) {
    await page.goto(start, { waitUntil: "networkidle" });
    let taps = 0;
    let typed = 0;
    const t0 = Date.now();
    // Milliseconds from the start to each tap and to the end, so a slow step can be found.
    const splits: number[] = [];
    await run(
      async (f) => {
        taps += 1;
        splits.push(Date.now() - t0);
        await f();
      },
      async (f) => {
        typed += 1;
        await f();
      },
    );
    rows.push({ journey: name, taps, typed, ms: Date.now() - t0, splits, done: true });
  }
  const open = async (p: Page) => p.waitForLoadState("networkidle");

  // 1. "What can I eat in Back Bay?" From Discover to a meal's page.
  await journey("Find a meal in a neighbourhood", "/discover", async (tap) => {
    // Wait for the neighbourhood page itself: tapping on while it loads hit Discover's own meal links under the
    // loading screen (the 10-minute hang of 23-24 Nov 2026; trace showed the click intercepted by the skeleton).
    await tap(async () => {
      await page.getByRole("link", { name: /Meals in Back Bay/ }).click();
      await page.waitForURL(/\/protein\/meals\?hood=back-bay/);
    });
    await tap(() => page.getByTestId("preview-meal").filter({ visible: true }).first().locator("a[href^='/meals/']").first().click());
    await expect(page.getByTestId("meal-actions")).toBeVisible();
  });

  // 2. "A vegetarian meal with the most protein." From Discover, filtered to the restaurant's own vegetarian label.
  await journey("Find a protein-rich vegetarian meal", "/discover", async (tap) => {
    await tap(() => page.getByTestId("real-menus-meals").click());
    await tap(() => page.getByRole("link", { name: /Vegetarian \(stated\)/ }).first().click());
    await open(page);
    await tap(() => page.getByTestId("preview-meal").filter({ visible: true }).first().locator("a[href^='/meals/']").first().click());
    await expect(page.getByTestId("meal-actions")).toBeVisible();
  });

  // 3. "Log what I ate there." From the meal page to the diary.
  await journey("Log a restaurant meal", page.url(), async (tap) => {
    await tap(() => page.getByTestId("meal-log").click());
    await tap(() => page.getByRole("button", { name: "Add to diary" }).click());
    await page.waitForURL(/\/diary(\?|$)/);
    await expect(page.getByTestId("diary-entry")).toHaveCount(1);
  });

  // 4. "Set a protein goal and see what's left." From Today.
  await journey("Set a goal and see what's left", "/today", async (tap, type) => {
    await tap(() => page.getByRole("link", { name: /Set one if you like|Set a protein goal/ }).first().click());
    await type(() => page.getByLabel("Protein per day (grams)").fill("90"));
    await tap(() => page.getByRole("button", { name: "Save goals" }).click());
    await expect(page.getByTestId("goals-saved")).toBeVisible();
    await tap(() => page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Today" }).click());
    await expect(page.getByTestId("protein-to-go")).toContainText("protein to go today");
  });

  // 5. "Cook something high in protein tonight." From the Cook tab into cooking mode.
  await journey("Start cooking a high-protein recipe", "/today", async (tap) => {
    await tap(() => page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Cook" }).click());
    await tap(() => page.getByTestId("high-protein-chip").click());
    await open(page);
    await tap(() => page.getByTestId("recipe-card").first().locator("a").first().click());
    await tap(() => page.getByTestId("start-cooking").click());
    await expect(page.getByTestId("cook-mode")).toBeVisible();
  });

  // 6. "Save a restaurant to try." From the restaurant list.
  await journey("Save a restaurant", "/places", async (tap) => {
    await tap(() => page.getByTestId("menu-tile").first().click());
    await tap(() => page.getByTestId("place-jump-social").click());
    await tap(() => page.getByTestId("place-social").getByRole("button", { name: "Save" }).first().click());
    await expect(page.getByTestId("place-social").getByRole("button", { name: /Saved/ }).first()).toBeVisible();
  });

  // 7. "Plan where to eat tomorrow." From a real meal's page to the week plan.
  const mealHref = await (async () => {
    await page.goto("/protein/meals", { waitUntil: "networkidle" });
    return page.getByTestId("preview-meal").filter({ visible: true }).first().locator("a[href^='/meals/']").first().getAttribute("href");
  })();
  await journey("Plan a restaurant meal for tomorrow", mealHref!, async (tap) => {
    await tap(() => page.getByTestId("meal-plan").locator("summary").click());
    await tap(() => page.locator("#mp-date").selectOption({ index: 1 }));
    await tap(() => page.getByRole("button", { name: "Add to my week plan" }).click());
    await expect(page.getByTestId("flash").filter({ visible: true })).toContainText("Added to your week plan");
  });

  // 8. "Rate a recipe I cooked." From the recipe page to a saved review.
  await journey("Rate and review a recipe", "/cook", async (tap, type) => {
    await tap(() => page.getByTestId("recipe-card").first().locator("a").first().click());
    await tap(() => page.getByTestId("write-review").click());
    await tap(() => page.locator(".rating-pick label").filter({ hasText: /^4Very good$/ }).click());
    await type(() => page.getByLabel(/What would you tell a friend/).fill("Easy weeknight dinner"));
    await tap(() => page.getByRole("button", { name: "Save review" }).click());
    await page.waitForURL((u) => u.pathname.startsWith("/cook/"));
    await expect(page.getByTestId("reviews-section")).toContainText("Easy weeknight dinner");
  });

  // 9. "What's vegan near me?" From Discover to a vegan meal on a restaurant's menu.
  await journey("Find a vegan meal and its restaurant", "/discover", async (tap) => {
    await tap(() => page.getByTestId("real-menus-meals").click());
    await tap(() => page.getByRole("link", { name: /Vegan \(stated\)/ }).first().click());
    await open(page);
    await tap(() => page.getByTestId("preview-meal").filter({ visible: true }).first().locator("a[href^='/meals/']").first().click());
    await expect(page.getByTestId("meal-actions")).toBeVisible();
    await expect(page.locator("main").first()).toContainText(/vegan/i);
  });

  writeFileSync(`${OUT}/journeys.json`, JSON.stringify({ at: new Date().toISOString(), width: 390, rows }, null, 2));
  console.log(rows.map((r) => `${r.journey}: ${r.taps} taps, ${r.typed} typed, ${(r.ms / 1000).toFixed(1)} s`).join("\n"));
  await context.close();
});
