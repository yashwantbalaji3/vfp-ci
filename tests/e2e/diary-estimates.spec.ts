import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { FOOD, completeSignIn, expectNoSidewaysScroll } from "./helpers";

/**
 * A logged estimate reads as an estimate (NIE N-4 diary part): "about", its range on the entry, and
 * the day's total as a range. The demo tempeh rice bowl is the seeded estimate (24–32 g, about 28 g).
 */
test.use({ viewport: { width: 360, height: 740 }, timezoneId: "America/New_York" });

test("an estimated dish in the diary shows 'about' and its range, never a bare exact number", async ({ page }) => {
  await page.goto(`/login?next=${encodeURIComponent(`/diary/log?food=${FOOD.tempeh}`)}`);
  await completeSignIn(page, `diary-est-${randomUUID().slice(0, 8)}@example.test`);
  await expect(page.getByTestId("log-food-name")).toHaveText("Demo tempeh rice bowl");
  await expect(page.getByTestId("log-preview")).toContainText("estimated");
  await page.getByRole("button", { name: "Add to diary" }).click();
  await expect(page.getByTestId("diary-flash")).toHaveText("Added to your diary.");

  const entry = page.getByTestId("entry-estimate");
  await expect(entry).toContainText("about 28 g");
  await expect(entry).toContainText("Estimate: 24–32 g");
  await expect(page.getByTestId("day-protein")).toHaveText("about 28 g");
  await expect(page.getByTestId("day-estimated")).toHaveText("1 item is an estimate, so the known total is between 24 and 32 g.");

  // A goal of 30 g: the estimate's middle (28 g) is below it, so it is not reached.
  await page.goto("/diary/goals");
  await page.getByLabel("Protein per day (grams)").fill("30");
  await page.getByRole("button", { name: "Save goals" }).click();
  await expect(page.getByTestId("goals-saved")).toBeVisible();
  await page.goto("/diary");
  await expect(page.getByTestId("day-goal")).toContainText("About 28 g recorded of your 30 g goal.");
  // 26 g: the middle reaches it but the low end (24 g) does not, so we don't say it is reached.
  await page.goto("/diary/goals");
  await page.getByLabel("Protein per day (grams)").fill("26");
  await page.getByRole("button", { name: "Save goals" }).click();
  await expect(page.getByTestId("goals-saved")).toBeVisible();
  await expect(page.getByLabel("Protein per day (grams)")).toHaveValue("26");
  await page.goto("/diary");
  await expect(page.getByTestId("day-goal")).toContainText("could be as low as 24 g, so we can't say the goal is reached");
  // 20 g: even the low end reaches it, and it is still labelled estimate-based, not a measured intake.
  await page.goto("/diary/goals");
  await page.getByLabel("Protein per day (grams)").fill("20");
  await page.getByRole("button", { name: "Save goals" }).click();
  await expect(page.getByTestId("goals-saved")).toBeVisible();
  await expect(page.getByLabel("Protein per day (grams)")).toHaveValue("20");
  await page.goto("/diary");
  await expect(page.getByTestId("day-goal")).toContainText("Based on estimates, you reached your 20 g goal");
  await expect(page.getByTestId("day-goal")).toContainText("This is an estimate, not a measured intake.");
  await expect(page.getByTestId("day-goal")).not.toContainText("You reached your 20 g goal.");
  await expectNoSidewaysScroll(page);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
});
