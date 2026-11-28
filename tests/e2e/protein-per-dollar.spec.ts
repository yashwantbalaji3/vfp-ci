import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { expectNoSidewaysScroll } from "./helpers";

/**
 * Protein Explorer "Per dollar" (docs/53, docs/20 MJ4 and test 8), at phone width. Seeded demo dishes:
 * chickpea power bowl 24 g for $13.50 (1.8 g per $1) ranks above paneer tikka 26 g for $15.00 (1.7).
 */
test.use({ viewport: { width: 360, height: 740 } });

test("Per dollar ranks priced dishes with sourced protein, says how many were left out, and fits a phone", async ({ page }) => {
  await page.goto("/protein");
  await page.getByRole("navigation", { name: "Comparison basis" }).getByRole("link", { name: "Per dollar" }).click();
  await expect(page).toHaveURL(/rank=dollar/);
  await expect(page.getByRole("heading", { name: "Most protein per dollar" })).toBeVisible();
  await expect(page.getByTestId("per-dollar-note")).toContainText("Estimates are never ranked per dollar.");

  const rows = page.getByTestId("ranked-row");
  await expect(rows.first()).toContainText("Demo chickpea power bowl");
  await expect(rows.first().getByTestId("row-per-dollar")).toContainText("1.8 g protein per $1 · $13.50 for 1 bowl, price checked");
  await expect(rows.nth(1)).toContainText("Demo paneer tikka");
  await expect(rows).toHaveCount(4);
  await expect(page.getByTestId("per-dollar-left-out")).toContainText("left out of this ranking");
  await expect(page.getByTestId("unranked-row").first().getByTestId("row-per-dollar")).toContainText("can’t be ranked per dollar");

  await page.waitForLoadState("networkidle");
  await expect(page).toHaveTitle(/\S/);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  await expectNoSidewaysScroll(page);

  // Back to the usual ranking.
  await page.getByRole("navigation", { name: "Comparison basis" }).getByRole("link", { name: "Per serving" }).click();
  await expect(page).not.toHaveURL(/rank=dollar/);
  await expect(page.getByRole("heading", { name: "Most protein, per serving" })).toBeVisible();
});
