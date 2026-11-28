import { expect, test } from "@playwright/test";
import { pool } from "../helpers/db";

/**
 * Every real recipe's page opens for a visitor on a phone with its name, ingredients, method, protein and the
 * source of its numbers (owner direction 22 Nov 2026 06:25 UTC: validate all 50 recipes). The recipes' data,
 * swaps, scaling, cooking and diary are checked in tests/db/recipe-validation.test.ts.
 */
test.setTimeout(300_000);
let ids: string[] = [];
test.beforeAll(async () => {
  ids = (await pool.query("select id from public.food_items where kind = 'recipe' and not is_demo and status = 'published' order by id")).rows.map((r) => r.id);
});

test("every real recipe page shows what a cook needs", async ({ page }) => {
  test.skip(ids.length < 50, "Needs the 50 real recipes loaded");
  for (const id of ids) {
    await page.goto(`/cook/${id}`);
    await expect(page.getByTestId("recipe-name"), id).toBeVisible();
    await expect(page.getByTestId("ingredient").first(), id).toBeVisible();
    await expect(page.getByTestId("method"), id).toContainText(/\w/);
    await expect(page.getByTestId("recipe-protein"), id).toContainText(/g|not known|unknown/i);
    await expect(page.getByTestId("nutrition-source"), id).toContainText(/USDA/);
    await expect(page.getByTestId("recipe-diet"), id).toBeVisible();
  }
  // Twice the servings from the page's own link doubles the amounts shown.
  await page.goto(`/cook/${ids[0]}?servings=8`);
  await expect(page.getByTestId("recipe-servings")).toContainText("8");
});
