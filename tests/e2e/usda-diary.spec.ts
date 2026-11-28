import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";
import { demoRelease } from "../../scripts/lib/nie-demo-dishes.mjs";
import { completeSignIn, expectNoSidewaysScroll } from "./helpers";

/**
 * Logging a USDA FoodData Central food straight into the diary, at phone width: search inside Add food,
 * choose the USDA lentils, log one cup, and see USDA's numbers (9.02 g protein per 100 g x 198 g = 17.9 g).
 * The USDA release is the 23-food SR Legacy excerpt in tests/fixtures/usda/sr-boston-demo.
 */
test.use({ viewport: { width: 360, height: 740 }, timezoneId: "America/New_York" });

test.beforeAll(async () => {
  const c = await pool.connect();
  try {
    await demoRelease(c, { allowExcerpt: true });
  } finally {
    c.release();
  }
});

async function expectAccessible(page: Page) {
  await page.waitForLoadState("networkidle");
  await expect(page).toHaveTitle(/\S/);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`), `accessibility problems on ${page.url()}`).toEqual([]);
}

test("find USDA lentils in Add food, log one cup, and the diary shows USDA's protein", async ({ page }) => {
  await page.goto(`/login?next=${encodeURIComponent("/diary/add")}`);
  await completeSignIn(page, `usda-${randomUUID().slice(0, 8)}@example.test`);
  await expect(page).toHaveURL(/\/diary\/add/);

  await page.getByLabel("Search dishes, recipes and packaged foods").fill("lentils cooked");
  await page.getByRole("button", { name: "Search" }).click();
  const usda = page.getByTestId("add-usda");
  await expect(usda).toContainText("Lentils, mature seeds, cooked, boiled, without salt");
  await expect(usda).toContainText("9 g protein per 100 g");
  await expect(page.getByText("USDA does not say whether a food is vegetarian or vegan.")).toBeVisible();
  await expectAccessible(page);
  await expectNoSidewaysScroll(page);

  await usda.getByRole("button", { name: "Choose Lentils, mature seeds, cooked, boiled, without salt" }).click();
  await expect(page.getByTestId("log-food-name")).toHaveText("Lentils, mature seeds, cooked, boiled, without salt");
  await expect(page.getByTestId("log-usda-source")).toContainText("FDC ID 172421");
  await expect(page.getByText("USDA FoodData Central", { exact: true })).toBeVisible();
  await page.getByRole("radio", { name: /1 cup \(198 g\)/ }).check();
  await expect(page.getByTestId("log-preview")).toContainText("17.9 g protein");
  await expectAccessible(page);
  await expectNoSidewaysScroll(page);

  await page.getByLabel("Meal").selectOption("lunch");
  await page.getByRole("button", { name: "Add to diary" }).click();
  await expect(page.getByTestId("diary-flash")).toHaveText("Added to your diary.");
  await expect(page.getByTestId("day-protein")).toHaveText("17.9 g");
  await expect(page.getByTestId("diary-entry")).toContainText("Lentils, mature seeds, cooked");

  // Choosing it again reuses the same private copy, and it is not listed under "Your own foods".
  await page.goto("/diary/add?q=lentils+cooked");
  await expect(page.getByTestId("add-own-list")).toHaveCount(0);
  await page.getByTestId("add-usda").getByRole("button", { name: "Choose Lentils, mature seeds, cooked, boiled, without salt" }).click();
  await expect(page.getByTestId("log-food-name")).toHaveText("Lentils, mature seeds, cooked, boiled, without salt");
});
