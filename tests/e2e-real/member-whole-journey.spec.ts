import { expect, test, type Browser, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";
import { completeSignIn } from "../e2e/helpers";
import { memberBetaForThisFile } from "./beta-switch";

/**
 * One ordinary member, one real beta meal, every consumer area (owner checkpoint 23 Nov 2026 04:54 UTC, item 1:
 * "Verify real meals work end to end across Discover, Protein Explorer, Today, Diary, Goals, Recipes, Saves, Lists,
 * Reviews and Social, using isolated test accounts"). Runs in the disposable test database with the staged member
 * beta on for this file only (the switch stays off on the owner's Mac). Two disposable @example.test members; every
 * private beta row the test writes is removed at the end.
 */
test.use({ timezoneId: "America/New_York" });
memberBetaForThisFile(true);
test.setTimeout(300_000);

let recipeId = "";
test.beforeAll(async () => {
  recipeId = (await pool.query("select id from public.food_items where kind = 'recipe' and not is_demo and status = 'published' order by id limit 1")).rows[0]?.id ?? "";
});

const seen = (page: Page, id: string) => page.getByTestId(id).filter({ visible: true });

async function member(browser: Browser, label: string) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: "America/New_York" });
  const page = await context.newPage();
  const email = `whole-${label}-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2Ftoday");
  await completeSignIn(page, email);
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
  return { page, context, id };
}

test("a member takes one real meal through Discover, Protein, Saves, Goals, Diary, Today, Recipes, Lists, Reviews and Social", async ({ browser }) => {
  const on = (await pool.query("select enabled from staging.member_beta_switch")).rows[0]?.enabled === true;
  test.skip(!on, "The member beta switch is off here");
  test.skip(!recipeId, "Needs the real recipes loaded");
  const a = await member(browser, "a");
  const z = await member(browser, "z");
  const page = a.page;
  const tag = randomUUID().slice(0, 6);
  try {
    // Goals: a vegetarian diet and a protein goal.
    await page.goto("/diet?return=%2Fdiary");
    await page.locator("main:visible input[name='diet'][value='vegetarian']").check();
    await page.getByRole("button", { name: "Apply filter" }).click();
    await page.waitForURL(/\/diary/);
    await page.goto("/diary/goals");
    await page.getByLabel("Protein per day (grams)").fill("80");
    await page.getByRole("button", { name: "Save goals" }).click();
    await expect(page.getByTestId("goals-saved")).toBeVisible();

    // Discover: real meals, each one stated to fit the chosen diet; one label for the beta, not two.
    await page.goto("/discover");
    const real = seen(page, "real-menus");
    await expect(real).toBeVisible();
    await expect(page.getByText("Local beta", { exact: false }).filter({ visible: true })).toHaveCount(1);
    const top = real.getByTestId("preview-meal");
    expect(await top.count()).toBeGreaterThan(0);

    // Protein Explorer: the meal list; pick a meal and open it.
    await page.goto("/protein/meals");
    const card = seen(page, "preview-meal").first();
    const href = (await card.locator("a[href^='/meals/']").first().getAttribute("href"))!;
    const dishId = href.split("/meals/")[1].split("?")[0];
    await page.goto(`/meals/${dishId}`);
    const name = (await seen(page, "meal-name").innerText()).trim();
    await expect(seen(page, "meal-hero")).toContainText(/(Vegetarian|Vegan) \(stated\)/);

    // Saves: save it, and find it on Saved.
    await seen(page, "meal-save").click();
    await expect(seen(page, "meal-save")).toHaveAttribute("aria-pressed", "true");
    await page.goto("/saved");
    await expect(seen(page, "saved-meals")).toContainText(name);

    // Lists: a new list with the meal on it, shown on the list's own page.
    await page.goto(`/meals/${dishId}`);
    const lists = seen(page, "meal-lists");
    await lists.locator("summary").click();
    await lists.getByLabel(/start your first list|or start a new list/i).fill(`Lunches ${tag}`);
    await lists.getByRole("button", { name: "Create list and add this" }).click();
    await expect(seen(page, "meal-lists").locator("summary")).toContainText("On 1 of your lists");
    const listId = (await pool.query("select list_id from staging.preview_list_entries where user_id = $1", [a.id])).rows[0].list_id as string;
    await page.goto(`/friends/lists/${listId}`);
    await expect(seen(page, "list-meals")).toContainText(name);

    // Reviews: a private rating, shown in the member's own reviews.
    await page.goto(`/meals/${dishId}`);
    const review = seen(page, "meal-review");
    await review.locator("summary").click();
    await review.locator("label").filter({ hasText: /^4/ }).first().click();
    await review.locator("textarea").fill(`Filling lunch ${tag}`);
    await review.getByRole("button", { name: /save/i }).click();
    await expect(seen(page, "meal-review").locator("summary")).toContainText("Your rating: 4 of 5");
    await page.goto("/friends/reviews");
    await expect(page.locator("main:visible").first()).toContainText(name);

    // Recipes: a recipe and the real meal on this week's plan, side by side.
    await page.goto(`/meals/${dishId}`);
    await seen(page, "meal-plan").locator("summary").click();
    await page.getByLabel("Meal", { exact: true }).selectOption("dinner");
    await page.getByRole("button", { name: "Add to my week plan" }).click();
    await expect(seen(page, "meal-plan").locator("summary")).toContainText("Planned for");
    await page.goto(`/cook/${recipeId}`);
    await page.getByTestId("plan-sheet").locator("summary").click();
    await page.getByTestId("plan-sheet").getByRole("button", { name: "Add to week plan" }).click();
    await expect(page).toHaveURL(/\/cook\/plan/);
    const day = page.getByTestId("plan-day").first();
    await expect(day.getByTestId("plan-outing")).toContainText(name);
    await expect(day.getByTestId("plan-item")).toHaveCount(1);

    // Today: the day's plan; logging the meal from it.
    await page.goto("/today");
    await expect(page.getByTestId("today-plan")).toContainText(name);
    await page.goto("/cook/plan");
    await day.getByTestId("plan-outing").getByRole("link", { name: /Log it/ }).click();
    await expect(page).toHaveURL(/\/diary\/custom\?.*meal=/);
    await page.getByRole("button", { name: "Add to diary" }).click();
    await page.waitForURL(/\/diary(\?|$)/);

    // Diary: one entry that keeps the meal's evidence and says it is not verified; the goal counts it.
    await expect(seen(page, "diary-entry")).toHaveCount(1);
    const attr = (
      await pool.query(
        `select a.attribution from public.diary_entries e join public.food_revisions r on r.food_item_id = e.food_item_id
           join public.custom_food_attributions a on a.revision_id = r.id where e.owner_id = $1`, [a.id])
    ).rows;
    expect(attr).toHaveLength(1);
    expect(attr[0].attribution.dish.id).toBe(dishId);
    expect(attr[0].attribution.status).not.toBe("verified");
    await expect(seen(page, "protein-to-go").or(seen(page, "day-protein")).first()).toBeVisible();
    await page.goto("/today");
    await expect(page.getByTestId("today-entry").first()).toContainText(name);

    // Social: another member sees none of it, and nothing reached a public table.
    for (const path of ["/friends", "/friends/reviews", "/saved", "/cook/plan", "/today"]) {
      await z.page.goto(path);
      const body = (await z.page.locator("main:visible").first().textContent()) ?? "";
      expect(body, path).not.toContain(`Filling lunch ${tag}`);
      expect(body, path).not.toContain(`Lunches ${tag}`);
    }
    await z.page.goto(`/friends/lists/${listId}`);
    await expect(z.page.getByTestId("list-meals")).toHaveCount(0);
    expect((await pool.query("select count(*)::int n from public.reviews where author_id = $1", [a.id])).rows[0].n).toBe(0);
    expect((await pool.query("select count(*)::int n from public.diary_entries where owner_id = $1", [z.id])).rows[0].n).toBe(0);
  } finally {
    for (const t of ["preview_reviews", "preview_list_entries", "preview_meal_plans", "preview_saves"])
      await pool.query(`delete from staging.${t} where user_id = any($1::uuid[])`, [[a.id, z.id]]);
    await a.context.close();
    await z.context.close();
  }
});
