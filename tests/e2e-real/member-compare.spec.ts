import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";
import { completeSignIn, expectNoSidewaysScroll } from "../e2e/helpers";
import { memberBetaForThisFile } from "./beta-switch";

/**
 * Journeys 3 and 4 of the owner's overnight directive, as an ORDINARY member (owner 23 Nov 2026 17:49 UTC: "journeys
 * previously exercised partly using founder privileges"). A disposable vegan member compares high-protein meals from
 * different restaurants, switches to protein per 100 kcal, goes back to a meal and saves it. Every compared meal must
 * be one its restaurant states is vegan. The member beta is on for this file in the test database only.
 */
test.use({ timezoneId: "America/New_York" });
memberBetaForThisFile(true);
test.setTimeout(180_000);

const betaOn = async () => (await pool.query("select enabled from staging.member_beta_switch")).rows[0]?.enabled === true;

for (const width of [390, 1440]) {
  test(`a vegan member compares meals across restaurants and saves one (${width} px)`, async ({ browser }) => {
    test.skip(!(await betaOn()), "The member beta switch is off here");
    const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: "America/New_York" });
    const page = await context.newPage();
    const email = `rc-compare-${randomUUID().slice(0, 8)}@example.test`;
    await page.goto("/login?next=%2Ftoday");
    await completeSignIn(page, email);
    const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
    // No role: an ordinary member.
    expect((await pool.query("select count(*)::int n from public.role_assignments where user_id = $1", [id])).rows[0].n).toBe(0);

    await page.goto("/diet?return=%2Fprotein%2Fmeals");
    await page.locator("main:visible input[name='diet'][value='vegan']").check();
    await page.getByRole("button", { name: "Apply filter" }).click();
    await page.waitForURL(/\/protein\/meals/);

    const cards = page.locator("ul.cards > [data-testid=preview-meal]").filter({ visible: true });
    await expect(cards.first()).toBeVisible({ timeout: 30_000 });
    const dishes = (await cards.evaluateAll((els) => els.map((e) => e.getAttribute("data-dish")))).filter(Boolean) as string[];
    expect(dishes.length).toBeGreaterThan(2);
    const places = new Map(
      (await pool.query("select id::text, place_id::text from staging.dishes where id = any($1::uuid[])", [dishes])).rows.map((r) => [r.id as string, r.place_id as string]),
    );
    // Start from the first meal's own page, as a member would.
    const firstId = dishes[0];
    await page.goto(`/meals/${firstId}`);
    await expect(page.getByTestId("meal-hero").filter({ visible: true })).toBeVisible();
    await page.getByTestId("meal-compare-link").filter({ visible: true }).click();
    await expect(page).toHaveURL(new RegExp(`/protein/meals\\?compare=${firstId}`));
    await expect(page.getByTestId("meal-compare-bar")).toHaveCount(1);

    // Add two more, preferring meals from a different restaurant.
    const order = [...dishes.slice(1)].sort((a, b) => Number(places.get(a) === places.get(firstId)) - Number(places.get(b) === places.get(firstId)));
    const chosen = [firstId];
    for (const d of order) {
      const card = page.locator(`ul.cards > [data-testid=preview-meal][data-dish='${d}']`).filter({ visible: true });
      if (!(await card.count())) continue;
      await card.first().getByTestId("meal-compare-toggle").click();
      chosen.push(d);
      await expect(page.getByTestId("meal-compare-bar")).toHaveCount(chosen.length);
      if (chosen.length === 3) break;
    }
    await expect(page.getByTestId("meal-compare")).toContainText("Comparing 3 of up to 3 meals");
    expect(new Set(chosen.map((d) => places.get(d))).size).toBeGreaterThan(1);
    // Every compared meal is stated vegan by its restaurant.
    const stated = (
      await pool.query(
        `select count(distinct dish_id)::int n from staging.facts where dish_id = any($1::uuid[]) and kind = 'dietary_status'
            and subject = 'vegan' and value ->> 'status' = 'yes'`,
        [chosen],
      )
    ).rows[0].n;
    expect(stated).toBe(3);

    await page.getByTestId("meal-compare").getByRole("link", { name: "Per 100 kcal" }).click();
    await expect(page).toHaveURL(/basis=100kcal/);
    await expect(page.getByTestId("meal-compare")).toContainText("Protein per 100 kcal");
    await expectNoSidewaysScroll(page);

    // Back to a meal and save it.
    await page.goto(`/meals/${chosen[1]}`);
    await page.getByTestId("meal-save").filter({ visible: true }).click();
    await expect(page.getByTestId("meal-save").filter({ visible: true })).toHaveAttribute("aria-pressed", "true");
    expect((await pool.query("select count(*)::int n from staging.preview_saves where user_id = $1", [id])).rows[0].n).toBe(1);
    await pool.query("delete from staging.preview_saves where user_id = $1", [id]);
    await context.close();
  });
}
