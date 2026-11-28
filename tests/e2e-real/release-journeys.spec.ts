import { expect, test, type Browser } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";
import { completeSignIn, expectNoSidewaysScroll } from "../e2e/helpers";
import { memberBetaForThisFile } from "./beta-switch";

/**
 * Release-candidate journeys on real data (owner overnight directive 23 Nov 2026 07:14 UTC, section 5), for the ones
 * no other real-data file walks as an ordinary member: a new user choosing a diet and searching (1), an egg-free
 * vegetarian (2), cooking a real recipe and logging it (7), missing data and empty results (11), and coming back in a
 * new session (12). Disposable @example.test members only; the member beta is on for this file in the test database.
 */
test.use({ timezoneId: "America/New_York" });
memberBetaForThisFile(true);
test.setTimeout(240_000);

const seen = (page: import("@playwright/test").Page, id: string) => page.getByTestId(id).filter({ visible: true });

async function member(browser: Browser, label: string, width = 390) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, timezoneId: "America/New_York" });
  const page = await context.newPage();
  const email = `rc-${label}-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2Ftoday");
  await completeSignIn(page, email);
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
  return { page, context, email, id };
}

async function chooseDiet(page: import("@playwright/test").Page, diet: "vegetarian" | "vegan", exclusions: string[] = []) {
  await page.goto("/diet?return=%2Fdiscover");
  await page.locator(`main:visible input[name='diet'][value='${diet}']`).check();
  for (const x of exclusions) await page.locator(`main:visible input[name='exclusions'][value='${x}']`).check();
  await page.getByRole("button", { name: "Apply filter" }).click();
  await page.waitForURL(/\/discover/);
}

const betaOn = async () => (await pool.query("select enabled from staging.member_beta_switch")).rows[0]?.enabled === true;

test("1, 11, 12: a new vegan member searches, meets empty and unknown data plainly, and finds their day again in a new session", async ({ browser }) => {
  test.skip(!(await betaOn()), "The member beta switch is off here");
  const a = await member(browser, "new", 430);
  const page = a.page;
  await chooseDiet(page, "vegan");
  // Search: real meals that fit, each stated vegan by its restaurant.
  await page.goto("/search?q=tofu");
  const meals = seen(page, "search-meals");
  if (await meals.count()) {
    await expect(meals.first()).toBeVisible();
    await expect(meals.first()).not.toContainText(/Vegetarian \(stated\)(?! ·)/);
  }
  // An empty search says so and offers a way on, never a blank page.
  await page.goto("/search?q=zzqxv-no-such-food");
  await expect(seen(page, "search-none")).toBeVisible();
  await expect(seen(page, "search-none").getByRole("link").first()).toBeVisible();
  // A meal whose protein the restaurant doesn't print shows "unknown", never 0 g.
  const unknown = (
    await pool.query(`select d.id from staging.dishes d join staging.member_beta_places b on b.place_id = d.place_id
                       where app.preview_meal_ok(d.id) and staging.member_dish_ok(d.id) and not exists (select 1 from staging.dish_structure s where s.dish_id = d.id and concat_ws(' ', s.section, s.portion_label) ~* '(cater|(serves|feeds) [0-9]{2,}|platters?.*people)')
                         and not exists (select 1 from staging.facts f where f.dish_id = d.id and f.kind = 'published_nutrition' and f.subject = 'protein_g' and not f.is_unknown)
                       order by d.id limit 1`)
  ).rows[0]?.id as string | undefined;
  if (unknown) {
    await page.goto(`/meals/${unknown}`);
    const hero = seen(page, "meal-hero");
    await expect(hero).toBeVisible();
    await expect(hero).not.toContainText(/\b0 g protein/);
  }
  // A restaurant outside the beta is a plain "couldn't find that" with a way back.
  const outside = (await pool.query(`select pl.slug from staging.live_catalog_links k join public.place_listings pl on pl.candidate_id = k.candidate_id
       where pl.visibility = 'preview' and k.staging_place not in (select place_id from staging.member_beta_places) order by pl.slug limit 1`)).rows[0]?.slug;
  if (outside) {
    await page.goto(`/places/${outside}`);
    await expect(page.getByRole("heading", { level: 1, name: /couldn.t find that/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /Back to Discover/i })).toBeVisible();
  }
  // Log a custom food, then come back in a brand-new browser session: the day is the same.
  await page.goto("/diary/custom");
  await page.getByLabel("What was it?").fill("Tofu scramble at home");
  await page.getByLabel("Protein (g)").fill("21");
  await page.getByRole("button", { name: "Add to diary" }).click();
  await page.waitForURL(/\/diary(\?|$)/);
  await expect(seen(page, "diary-entry")).toHaveCount(1);
  await a.context.close();
  const again = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: "America/New_York" });
  const p2 = await again.newPage();
  await p2.goto("/login?next=%2Fdiary");
  await completeSignIn(p2, a.email);
  await p2.goto("/diary");
  await expect(seen(p2, "diary-entry").filter({ hasText: "Tofu scramble at home" })).toHaveCount(1);
  await expect(seen(p2, "day-protein")).toContainText("21");
  await expectNoSidewaysScroll(p2);
  await again.close();
});

test("2: an egg-free vegetarian never sees a meal that lists egg as a fit", async ({ browser }) => {
  test.skip(!(await betaOn()), "The member beta switch is off here");
  const m = await member(browser, "eggfree", 390);
  const page = m.page;
  await chooseDiet(page, "vegetarian", ["egg"]);
  await page.goto("/protein/meals");
  const cards = seen(page, "preview-meal");
  const n = await cards.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const fit = cards.nth(i).getByTestId("meal-fit");
    if (await fit.count()) await expect(fit.first(), `card ${i}`).not.toContainText(/Doesn.t fit/);
  }
  // Every dish shown in the default view is one whose listed ingredients don't name egg.
  const ids = await cards.locator("a[href^='/meals/']").evaluateAll((els) => [...new Set(els.map((e) => (e.getAttribute("href") ?? "").split("/meals/")[1]?.split("?")[0]))]);
  const egg = (
    await pool.query(
      `select count(*)::int n from staging.facts f where f.dish_id = any($1::uuid[]) and f.kind = 'listed_ingredients'
         and f.value::text ~* '\\m(egg|eggs|mayo|mayonnaise|aioli)\\M' and f.value::text !~* '(vegan|plant|chickpea|eggplant) ?(egg|mayo|aioli)'`,
      [ids.filter(Boolean)],
    )
  ).rows[0].n as number;
  expect(egg).toBe(0);
  await m.context.close();
});

test("7: a member cooks a real recipe step by step and logs what they ate", async ({ browser }) => {
  const recipe = (await pool.query("select id from public.food_items where kind = 'recipe' and not is_demo and status = 'published' order by id limit 1")).rows[0]?.id as string | undefined;
  test.skip(!recipe, "Needs the real recipes loaded");
  const m = await member(browser, "cook", 390);
  const page = m.page;
  await page.goto(`/cook/${recipe}`);
  await expect(seen(page, "recipe-name")).toBeVisible();
  await expect(seen(page, "ingredients")).toBeVisible();
  await seen(page, "start-cooking").click();
  await expect(seen(page, "cook-mode")).toBeVisible();
  while (await seen(page, "cook-next").isVisible()) {
    const before = await seen(page, "cook-progress").textContent();
    await seen(page, "cook-next").click();
    await expect(seen(page, "cook-progress")).not.toHaveText(before ?? "");
  }
  await seen(page, "cook-finish").click();
  await expect(page).toHaveURL(/\/done$/);
  await expect(seen(page, "done-not-logged")).toContainText("Nothing has been added to your diary");
  await seen(page, "ate-submit").click();
  await expect(page).toHaveURL(/\/diary\?date=/);
  await expect(seen(page, "diary-entry")).toHaveCount(1);
  const n = (await pool.query("select count(*)::int n from public.diary_entries where owner_id = $1", [m.id])).rows[0].n;
  expect(n).toBe(1);
  await m.context.close();
});
