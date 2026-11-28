import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";
import { completeSignIn } from "../e2e/helpers";

/**
 * Reliable protein display (found on the owner's Mac, 23 Nov 2026): an ingredient recorded per 100 g with no serving
 * weight, such as extra-firm tofu, showed "Protein not provided" in diary search and on its food page although its
 * published figure exists. It must show the per-100 g figure, labelled as such, and energy per 100 g only when the
 * record itself is per 100 g. Adds only its own sign-in account; logs nothing.
 */
test.use({ timezoneId: "America/New_York" });

test("a food recorded per 100 g shows its protein and energy per 100 g, never 'not provided'", async ({ page }) => {
  const food = (
    await pool.query(`select fi.id from public.food_items fi join public.food_revisions r on r.food_item_id = fi.id
                       where not fi.is_demo and r.name = 'Extra-firm tofu' limit 1`)
  ).rows[0]?.id as string | undefined;
  test.skip(!food, "Needs the real recipes and their ingredients loaded");
  await page.goto("/login?next=%2Fdiary%2Fadd");
  await completeSignIn(page, `per100-${randomUUID().slice(0, 8)}@example.test`);
  await page.goto("/diary/add?q=tofu");
  const row = page.getByTestId("add-results").filter({ visible: true }).locator("li").filter({ hasText: "Extra-firm tofu" });
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  await expect(row).toContainText(/\d+(\.\d)? g protein per 100 g/);
  await expect(row).not.toContainText("Protein not provided");

  await page.goto(`/foods/${food}`);
  const facts = page.getByRole("list", { name: "Key facts" }).filter({ visible: true });
  await expect(facts.locator("li").nth(0)).toContainText(/per 100 g/);
  await expect(facts.locator("li").nth(0)).not.toContainText("Not provided");
  await expect(facts.locator("li").nth(1)).toContainText(/\d+ kcal per 100 g/);
});
