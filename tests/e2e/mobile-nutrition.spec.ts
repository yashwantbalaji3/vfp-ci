import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { FOOD, expectNoSidewaysScroll } from "./helpers";

/**
 * Owner 22:03 UTC 16 Nov, priority 4: collapsible nutrition details on mobile. On a phone the food
 * page shows the figures people check first (protein, energy) with their honest wording, and folds
 * the full nutrient table with its sources into a details panel. Wide screens keep the full table.
 * Uses the demo chickpea power bowl (published 24 g protein) and the demo tempeh bowl (estimate).
 */
for (const width of [320, 375, 430]) {
  test.describe(`food nutrition at ${width} px`, () => {
    test.use({ viewport: { width, height: 760 } });

    test("key figures stay visible, the full table is one tap away, nothing scrolls sideways", async ({ page }) => {
      await page.goto(`/foods/${FOOD.bowl}`);
      const key = page.getByTestId("nutrition-key");
      await expect(key).toBeVisible();
      await expect(key).toContainText("Protein");
      await expect(key).toContainText("24 g");
      const details = page.getByTestId("nutrition-details");
      await expect(details).not.toHaveAttribute("open", "");
      await expect(details.locator("table.data")).toBeHidden();
      await details.locator(":scope > summary").click();
      await expect(details.locator("table.data")).toBeVisible();
      await expect(details.locator("table.data")).toContainText("Published");
      await expectNoSidewaysScroll(page);
      const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      expect(axe.violations).toEqual([]);
    });

    test("an estimate keeps its 'about' wording and range in the key figures; showing estimates opens the details", async ({ page }) => {
      await page.goto(`/foods/${FOOD.tempeh}?est=1`);
      await expect(page.getByTestId("nutrition-key")).toContainText("about 28 g (estimate 24–32 g)");
      await expect(page.getByTestId("nutrition-details")).toHaveAttribute("open", "");
    });
  });
}

test.describe("food nutrition on a wide screen", () => {
  test.use({ viewport: { width: 1280, height: 900 } });
  test("shows the full table without a details panel", async ({ page }) => {
    await page.goto(`/foods/${FOOD.bowl}`);
    await expect(page.locator(".nut-wide table.data")).toBeVisible();
    await expect(page.getByTestId("nutrition-details")).toBeHidden();
    await expect(page.getByTestId("nutrition-key")).toBeHidden();
  });
});
