import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { expectNoSidewaysScroll, setDiet } from "./helpers";

/**
 * "Can be made vegan" (BACKLOG FUT-01, docs/55) at phone width: the paneer curry is in its own group with the
 * swaps named, never among the vegan matches, and opens with those swaps chosen.
 */
test.use({ viewport: { width: 360, height: 740 } });

test("a vegan sees 'Can be made vegan' apart from the matches, and the recipe opens with the swaps chosen", async ({ page, context }) => {
  await setDiet(context, "vegan");
  await page.goto("/cook");
  const group = page.getByTestId("can-be-made");
  await expect(group.getByRole("heading", { name: /Can be made vegan \(3\)/ })).toBeVisible();
  const curry = group.getByTestId("can-be-made-row").filter({ hasText: "Demo spinach and paneer curry" });
  await expect(curry).toContainText("Swap Demo paneer for Demo extra-firm tofu, and Demo single cream for Demo coconut milk.");
  await expect(curry).toContainText("Not suitable as written.");
  // Not among the confirmed vegan matches above.
  await expect(page.locator("ul.cards").getByText("Demo spinach and paneer curry")).toHaveCount(0);

  await page.waitForLoadState("networkidle");
  await expect(page).toHaveTitle(/\S/);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  await expectNoSidewaysScroll(page);

  await curry.getByRole("link", { name: "Demo spinach and paneer curry" }).click();
  await expect(page).toHaveURL(/swap_protein=.*swap_cream=|swap_cream=.*swap_protein=/);
  await expect(page.getByTestId("recalculated")).toBeAttached();
  await expect(page.getByText("does not fit your dietary filter")).toHaveCount(0);
});
