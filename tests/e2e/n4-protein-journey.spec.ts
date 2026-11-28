import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";
import { FOOD, completeSignIn, expectNoSidewaysScroll } from "./helpers";

/**
 * The complete journey the owner asked for (23:52 UTC, item 5), on saved data at phone width:
 * discover -> filter for a dietary need -> open a dish -> compare protein -> understand the evidence
 * ("How we got this", NIE N-4) -> save it, then check the save in the database and after a reload.
 * The database pool is shared by every browser test file in a run, so it is never closed here.
 */

async function noAxeFailures(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
}

test.describe("N4 journey: discover, filter, dish, compare protein, evidence, save", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("a vegan member finds a dish, sees where its protein figure came from, compares it and saves it", async ({ page }) => {
    test.setTimeout(150_000);
    const email = `n4-${randomUUID().slice(0, 8)}@example.test`;
    await page.goto("/login?next=/discover");
    await completeSignIn(page, email);
    await expect(page).toHaveURL(/\/discover$/);

    // 1. Filter for a dietary need: vegan, through the diet chip.
    await page.getByTestId("diet-chip").click();
    await page.getByRole("radio", { name: /^Vegan/ }).check();
    await page.getByRole("button", { name: "Apply filter" }).click();
    await expect(page).toHaveURL(/\/discover$/);
    await expect(page.getByTestId("diet-chip")).toContainText("Vegan");

    // 2. Discover: search, and only confirmed vegan matches are listed.
    await page.getByLabel("Search dishes and places").fill("tempeh");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByTestId("results-heading")).toHaveText("1 confirmed match");
    await expect(page.locator(".conf.ok")).toHaveCount(1);
    await expectNoSidewaysScroll(page);

    // 3. Inspect the dish. Its protein is an estimate, so no number is shown until asked for.
    await page.getByRole("link", { name: "Demo tempeh rice bowl" }).click();
    await expect(page.getByTestId("food-name")).toHaveText("Demo tempeh rice bowl");
    const how = page.getByTestId("protein-explanation");
    await expect(how).toHaveAttribute("data-state", "estimate_hidden");
    await expect(how).toContainText("estimates are hidden unless you choose to see them");
    await expect(how).not.toContainText(/\d+ g/);

    // 4. Understand the evidence: opt in, and the page says what kind of figure it is and how far to trust it.
    await how.getByRole("link", { name: "Show the estimate and how we got it" }).click();
    await expect(page).toHaveURL(/est=1/);
    await expect(how).toHaveAttribute("data-state", "estimated_range");
    await expect(page.getByTestId("explanation-state")).toHaveText("Estimated range from a typical recipe");
    await expect(page.getByTestId("explanation-range")).toContainText("Between 24 g and 32 g protein, most likely about 28 g");
    await expect(page.getByTestId("explanation-range")).toContainText("an estimate, not a verified figure");
    await expect(how).toContainText("not a statistical confidence interval");
    await expect(how).toContainText("Synthetic estimate from a typical tempeh portion");
    await how.getByText("Where this came from").click();
    await expect(how.locator(".src-body")).toContainText("Checked");
    await expectNoSidewaysScroll(page);
    await noAxeFailures(page);

    // 5. Compare protein with another vegan dish, from the dish page.
    await page.getByRole("link", { name: "Compare protein" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Protein Explorer");
    const panel = page.getByTestId("compare-panel");
    await expect(panel).toContainText("Comparing 1 of up to 3");
    await expect(panel).toContainText("Demo tempeh rice bowl");
    const other = page.getByTestId("ranked-row").filter({ hasNotText: "Demo tempeh rice bowl" }).first();
    const otherName = ((await other.locator("a").first().textContent()) ?? "").trim();
    await other.getByRole("link", { name: /^Compare/ }).click();
    await expect(panel).toContainText("Comparing 2 of up to 3");
    await expect(panel).toContainText(otherName);
    await expect(panel).not.toContainText(/\b0 g/);
    await expectNoSidewaysScroll(page);

    // 6. Save it (back on the dish), and the save is real: in the database and after a reload.
    await page.goto(`/foods/${FOOD.tempeh}`);
    await page.getByTestId("save-button").click();
    await expect(page.getByTestId("save-button")).toHaveText("Saved · Remove");
    await page.reload();
    await expect(page.getByTestId("save-button")).toHaveText("Saved · Remove");
    await page.goto("/saved");
    await expect(page.getByTestId("saved-food")).toContainText("Demo tempeh rice bowl");
    const rows = await pool.query(
      "select count(*)::int as n from public.saves s join auth.users u on u.id = s.owner_id where u.email = $1 and s.food_item_id = $2",
      [email, FOOD.tempeh],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  test("a restaurant-published figure and an unknown one are explained in their own words", async ({ page }) => {
    await page.goto(`/foods/${FOOD.bowl}`);
    const how = page.getByTestId("protein-explanation");
    await expect(how).toHaveAttribute("data-state", "restaurant_published");
    await expect(how).toContainText("as the restaurant publishes it");
    await expect(how).not.toContainText("estimate");
    await page.goto("/discover?q=mushroom");
    await page.getByRole("link", { name: "Demo mushroom toast" }).click();
    const unknown = page.getByTestId("protein-explanation");
    await expect(unknown).toHaveAttribute("data-state", "unknown");
    await expect(unknown).toContainText("We don’t fill the gap with a guess");
    await expect(unknown).not.toContainText(/\b0 g/);
    await expectNoSidewaysScroll(page);
  });
});
