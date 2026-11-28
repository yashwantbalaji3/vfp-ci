import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { pool } from "../helpers/db";
import { completeSignIn, expectNoSidewaysScroll } from "../e2e/helpers";
import { memberBetaForThisFile } from "./beta-switch";

/**
 * "A real day" in real mode (owner direction 20 Nov 2026 01:06 UTC; docs/62): the founder logs a real
 * restaurant meal into the private diary from its page, sees the protein still to go with suggestions that
 * exist, and finds real recipes to cook. Runs only where the real menus (8 places) and the real recipes
 * (scripts/real-recipes.mjs) are loaded, so it skips on a freshly reset test database.
 */
test.use({ timezoneId: "America/New_York" });
test.setTimeout(600_000);
// With the member beta off: an ordinary member then sees no real meal (with it on, a beta member may log a beta meal:
// member-beta.spec.ts).
memberBetaForThisFile(false);
const SHOTS = process.env.SHOTS_DIR ?? "test-results/real-day";

let ready = false;
let mealId = "";
test.beforeAll(async () => {
  const r = await pool.query(`
    select (select count(*)::int from staging.live_catalog_links) links,
           (select count(*)::int from public.food_items where kind = 'recipe' and not is_demo and id::text like 'a0000000-%') recipes`);
  ready = r.rows[0].links >= 8 && r.rows[0].recipes >= 12;
  mkdirSync(SHOTS, { recursive: true });
});

const check = async (page: Page) => {
  await expectNoSidewaysScroll(page);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
};

for (const width of [390, 1440]) {
  const size = width > 800 ? "desktop" : "phone";
  test(`a real day: log a real meal, see protein to go, cook a real recipe (${size})`, async ({ browser }) => {
    test.skip(!ready, "Needs the real menus and the real recipes loaded");
    const context = await browser.newContext({ viewport: { width, height: width > 800 ? 900 : 844 }, deviceScaleFactor: 2, isMobile: width < 800, hasTouch: width < 800, timezoneId: "America/New_York" });
    const page = await context.newPage();
    const email = `realday-${size}-${randomUUID().slice(0, 8)}@example.test`;
    await page.goto("/login?next=%2Fdiary%2Fgoals");
    await completeSignIn(page, email);
    const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id;
    await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher') on conflict do nothing", [id]);

    // A goal, then nothing logged: the whole goal is to go, with real ideas (meals and recipes) that exist.
    await page.goto("/diary/goals");
    await page.getByLabel("Protein per day (grams)").fill("90");
    await page.getByRole("button", { name: "Save goals" }).click();
    await expect(page.getByTestId("goals-saved")).toBeVisible();
    await page.goto("/diary");
    await expect(page.getByTestId("protein-to-go")).toContainText("90 g protein to go today");
    await expect(page.getByTestId("togo-meal").first()).toContainText("Unverified preview");
    await expect(page.getByTestId("togo-recipe").first()).toContainText("per serving");

    // Log a real meal with a printed figure from its page: the form starts filled in, labelled unverified.
    const printed = await page.getByTestId("togo-meal").first().locator("a").getAttribute("href");
    await page.goto("/protein/meals?min=30");
    mealId = (await page.getByTestId("preview-meal").first().locator("a[href^='/meals/']").first().getAttribute("href"))!.split("/meals/")[1].split("?")[0];
    expect(printed).toBeTruthy();
    await page.goto(`/meals/${mealId}`);
    await page.getByTestId("meal-log").click();
    await expect(page).toHaveURL(/\/diary\/custom\?meal=/);
    await expect(page.getByTestId("custom-prefill-note")).toContainText("Unverified preview");
    const protein = await page.getByLabel("Protein (g)").inputValue();
    const name = await page.getByLabel("What was it?").inputValue();
    expect(name).toMatch(/\(.+\)$/);
    await expect(page.getByRole("radio", { name: "Restaurant or takeout" })).toBeChecked();
    await check(page);
    await page.screenshot({ path: `${SHOTS}/${size}-01-log-real-meal.png`, fullPage: true });
    await page.getByRole("button", { name: "Add to diary" }).click();
    await page.waitForURL(/\/diary(\?|$)/);
    await page.goto("/diary");
    await expect(page.getByTestId("diary-entry").filter({ hasText: name })).toHaveCount(1);
    if (protein) {
      await expect(page.getByTestId("day-protein")).toContainText(protein);
      const left = Math.round((90 - Number(protein)) * 10) / 10;
      if (left > 0) await expect(page.getByTestId("protein-to-go")).toContainText(`${String(left).replace(/\.0$/, "")} g protein to go today`);
    }
    await check(page);
    await page.screenshot({ path: `${SHOTS}/${size}-02-diary-to-go.png`, fullPage: true });

    // Real recipes exist in real mode, with protein calculated from USDA ingredients.
    await page.goto("/cook");
    await expect(page.getByText("No recipes yet.")).toHaveCount(0);
    await page.goto("/cook?protein=high");
    await expect(page.locator("main a[href^='/cook/a0000000-']").first()).toBeVisible();
    await check(page);
    await page.screenshot({ path: `${SHOTS}/${size}-03-recipes.png`, fullPage: true });
    const recipe = await page.locator("main a[href^='/cook/a0000000-']").first().getAttribute("href");
    await page.goto(recipe!);
    await expect(page.getByRole("main")).toContainText(/protein/i);
    await expect(page.getByRole("main")).toContainText(/USDA/);
    await check(page);
    await page.screenshot({ path: `${SHOTS}/${size}-04-recipe.png`, fullPage: true });

    // Real-mode clean-up: no "0 dishes" section under the real meals on Discover.
    await page.goto("/discover");
    await expect(page.getByTestId("real-menus")).toBeVisible();
    await expect(page.getByTestId("results-heading")).toHaveCount(0);
    await context.close();
  });
}

test("with the member beta off, a member who isn't the founder gets the plain own-food form for a real meal id", async ({ page }) => {
  test.skip(!ready || !mealId, "Needs the founder run first");
  await page.goto(`/login?next=${encodeURIComponent(`/diary/custom?meal=${mealId}`)}`);
  await completeSignIn(page, `realday-member-${randomUUID().slice(0, 8)}@example.test`);
  await expect(page.getByLabel("What was it?")).toHaveValue("");
  await expect(page.getByTestId("custom-prefill-note")).toHaveCount(0);
});
