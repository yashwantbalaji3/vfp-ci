import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { FOOD, completeSignIn, expectNoSidewaysScroll } from "./helpers";

/**
 * Owner 18:17 UTC 16 Nov: "Estimated protein must never be displayed as an exact measurement."
 * Every screen that shows the demo tempeh rice bowl's estimate (24–32 g, about 28 g) says "about",
 * while a published figure (the demo chickpea power bowl, 24 g) is shown as it is. Also the saved
 * list leads straight to logging and comparing a saved dish.
 */
async function noAxeFailures(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
}

test.use({ viewport: { width: 360, height: 740 }, timezoneId: "America/New_York" });

test("an estimate reads 'about' on cards, the dish page and the comparison; a published figure does not", async ({ page }) => {
  await page.goto("/discover?q=tempeh&est=1");
  const est = page.getByTestId("dish-card").getByTestId("protein-figure");
  await expect(est).toHaveAttribute("data-estimated", "true");
  await expect(est).toHaveText(/^about 28 g protein/);
  await expect(est.getByTestId("protein-range")).toHaveText("(estimate 24–32 g)");

  await page.goto("/discover?q=chickpea%20power");
  const pub = page.getByTestId("dish-card").first().getByTestId("protein-figure");
  await expect(pub).toHaveText(/^24 g protein/);
  await expect(pub).not.toHaveAttribute("data-estimated", "true");

  await page.goto(`/foods/${FOOD.tempeh}?est=1`);
  await expect(page.getByTestId("protein-figure").first()).toHaveText(/^about 28 g protein/);
  await expect(page.getByTestId("nutrition-details").locator("table.data")).toContainText("about 28 g (estimate 24–32 g)");

  await page.goto(`/protein?est=1&compare=${FOOD.tempeh},${FOOD.bowl}`);
  const panel = page.getByTestId("compare-panel");
  await expect(panel).toContainText("about 28 g (estimate 24–32 g)");
  const bowlCard = panel.getByTestId("compare-card").filter({ hasText: "Demo chickpea power bowl" });
  await expect(bowlCard.locator("dd").first()).toHaveText("24 g");
  await expectNoSidewaysScroll(page);
});

test("from Saved, a member compares and logs a saved estimated dish, and the log form gives the range", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`/login?next=${encodeURIComponent(`/foods/${FOOD.tempeh}`)}`);
  await completeSignIn(page, `est-words-${randomUUID().slice(0, 8)}@example.test`);
  await page.getByTestId("save-button").click();
  await expect(page.getByTestId("save-button")).toHaveText("Saved · Remove");
  await page.goto(`/foods/${FOOD.bowl}`);
  await page.getByTestId("save-button").click();
  await expect(page.getByTestId("save-button")).toHaveText("Saved · Remove");

  await page.goto("/saved");
  await expect(page.getByTestId("saved-food")).toHaveCount(2);
  await expectNoSidewaysScroll(page);
  await noAxeFailures(page);
  await page.getByTestId("saved-compare").click();
  await expect(page.getByTestId("compare-panel")).toContainText("Comparing 2 of up to 3");
  await expect(page.getByTestId("compare-panel")).toContainText("Demo tempeh rice bowl");
  await expect(page.getByTestId("compare-panel")).toContainText("Demo chickpea power bowl");

  await page.goto("/saved");
  await page.getByRole("link", { name: "Log this (Demo tempeh rice bowl) in your diary" }).click();
  await expect(page.getByTestId("log-food-name")).toHaveText("Demo tempeh rice bowl");
  await expect(page.getByText("about 28 g protein (estimate 24–32 g)")).toBeVisible();
  const preview = page.getByTestId("log-preview");
  await expect(preview).toContainText("about 28 g protein");
  await expect(page.getByTestId("log-preview-estimate")).toHaveText("Estimate: between 24 and 32 g. This is not a measured amount.");
  await page.getByLabel("How many").fill("2");
  await expect(preview).toContainText("about 56 g protein");
  await expect(page.getByTestId("log-preview-estimate")).toHaveText("Estimate: between 48 and 64 g. This is not a measured amount.");
  await expectNoSidewaysScroll(page);
  await noAxeFailures(page);
  await page.getByRole("button", { name: "Add to diary" }).click();
  await expect(page.getByTestId("diary-flash")).toHaveText("Added to your diary.");

  await page.goto("/diary/add");
  await expect(page.getByTestId("add-recent")).toContainText("about 56 g (estimate 48–64 g) protein");
});
