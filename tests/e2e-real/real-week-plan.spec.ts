import { expect, test, type Browser } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";
import { completeSignIn, expectNoSidewaysScroll } from "../e2e/helpers";
import { memberBetaForThisFile } from "./beta-switch";

/**
 * Real-data week plan (owner direction 22 Nov 2026 06:25 UTC; docs/68). The founder plans a real restaurant meal
 * from its page and a real recipe, sees both on the week plan with the day's planned protein, and logs the meal
 * from the plan. Nothing reaches the diary until then. A member sees only their own recipes, never the meal.
 */
test.use({ timezoneId: "America/New_York" });

// With the staged local member beta off: what a member sees by default.
memberBetaForThisFile(false);
test.setTimeout(180_000);

let mealId = "";
let recipeId = "";
test.beforeAll(async () => {
  const m = await pool.query(`select d.id from staging.dishes d where app.preview_meal_ok(d.id) and not exists (select 1 from staging.dish_structure s where s.dish_id = d.id and concat_ws(' ', s.section, s.portion_label) ~* '(cater|(serves|feeds) [0-9]{2,}|platters?.*people)') order by d.id limit 1`);
  const r = await pool.query("select id from public.food_items where kind = 'recipe' and not is_demo and status = 'published' order by id limit 1");
  mealId = m.rows[0]?.id ?? "";
  recipeId = r.rows[0]?.id ?? "";
});

async function signIn(browser: Browser, label: string, founder: boolean) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: "America/New_York" });
  const page = await context.newPage();
  const email = `plan-${label}-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2Fcook%2Fplan");
  await completeSignIn(page, email);
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
  if (founder) await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher') on conflict do nothing", [id]);
  return { page, context, id };
}

test("the founder plans a real meal and a recipe for the week, then logs the meal from the plan", async ({ browser }) => {
  test.skip(!mealId || !recipeId, "Needs the real menus and recipes loaded");
  const f = await signIn(browser, "founder", true);
  // A meal the meal list shows (never one left out for naming meat, which cannot be planned).
  await f.page.goto("/protein/meals");
  await f.page.getByTestId("preview-meal").filter({ visible: true }).first().locator("a[href^='/meals/']").first().click();
  await expect(f.page.getByTestId("meal-actions")).toBeVisible();
  const name = (await f.page.getByTestId("meal-name").textContent())!.trim();
  await f.page.getByTestId("meal-plan").locator("summary").click();
  await f.page.getByLabel("Meal", { exact: true }).selectOption("dinner");
  await f.page.getByRole("button", { name: "Add to my week plan" }).click();
  await expect(f.page.getByTestId("flash").filter({ visible: true })).toContainText("Added to your week plan");
  await expect(f.page.getByTestId("meal-plan").locator("summary")).toContainText("Planned for");

  await f.page.goto(`/cook/${recipeId}`);
  await f.page.getByTestId("plan-sheet").locator("summary").click();
  await f.page.getByTestId("plan-sheet").getByRole("button", { name: "Add to week plan" }).click();
  await expect(f.page).toHaveURL(/\/cook\/plan/);
  const today = f.page.getByTestId("plan-day").first();
  await expect(today).toContainText("today");
  await expect(today.getByTestId("plan-outing")).toContainText(name);
  await expect(today.getByTestId("plan-outing")).toContainText("Dinner");
  await expect(today.getByTestId("plan-item")).toHaveCount(1);
  await expect(today.getByTestId("plan-day-protein")).toContainText("Not counted until you log it");
  await expectNoSidewaysScroll(f.page);
  expect((await pool.query("select count(*)::int n from public.diary_entries where owner_id = $1", [f.id])).rows[0].n).toBe(0);

  // Today shows the day's plan, one tap from cooking or logging.
  await f.page.goto("/today");
  await expect(f.page.getByTestId("today-plan-item")).toHaveCount(2);
  await expect(f.page.getByTestId("today-plan")).toContainText(name);
  await f.page.goto("/cook/plan");
  await today.getByTestId("plan-outing").getByRole("link", { name: /Log it/ }).click();
  await expect(f.page).toHaveURL(/\/diary\/custom\?.*slot=dinner.*meal=/);
  await f.page.getByRole("button", { name: "Add to diary" }).click();
  await f.page.waitForURL(/\/diary(\?|$)/);
  await expect(f.page.getByTestId("diary-entry")).toHaveCount(1);

  // A member's plan shows their own recipes only, and no restaurant meal or way to plan one.
  const m = await signIn(browser, "member", false);
  await m.page.goto("/cook/plan");
  await expect(m.page.getByTestId("plan-outing")).toHaveCount(0);
  await expect(m.page.getByTestId("plan-find-meal")).toHaveCount(0);
  await expect(m.page.locator("main")).not.toContainText(name);
  await f.context.close();
  await m.context.close();
});
