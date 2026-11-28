import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { completeSignIn, expectNoSidewaysScroll } from "./helpers";

/**
 * Change or remove a food of your own (docs/56) at phone width: the change is saved as a new version, so
 * the entry already in the diary keeps its numbers; removing takes it off the list and can be undone.
 */
test.use({ viewport: { width: 360, height: 740 }, timezoneId: "America/New_York" });

test("change a food of your own, keep the diary as logged, then remove it and undo", async ({ page }) => {
  await page.goto(`/login?next=${encodeURIComponent("/diary/custom")}`);
  await completeSignIn(page, `own-${randomUUID().slice(0, 8)}@example.test`);
  await page.getByLabel("What was it?").fill("Dal at home");
  await page.getByLabel("Protein (g)").fill("12");
  await page.getByRole("button", { name: "Add to diary" }).click();
  await expect(page.getByTestId("diary-flash")).toHaveText("Added to your diary.");
  const dayUrl = page.url();

  await page.goto("/diary/add");
  await page.getByTestId("own-manage").click();
  await expect(page).toHaveURL(/\/diary\/foods$/);
  await page.getByRole("link", { name: "Change Dal at home" }).click();
  await expect(page.getByTestId("own-food-name")).toHaveText("Dal at home");
  await expect(page.getByText("In your diary once.")).toBeVisible();
  await expect(page.getByLabel("Protein (g)")).toHaveValue("12");

  await page.waitForLoadState("networkidle");
  await expect(page).toHaveTitle(/\S/);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  await expectNoSidewaysScroll(page);

  // A mistake comes back with the form still filled in.
  await page.getByLabel("Protein (g)").fill("-3");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByTestId("err-proteinG")).toBeVisible();
  await expect(page.getByLabel("Name")).toHaveValue("Dal at home");

  await page.getByLabel("Name").fill("Red lentil dal");
  await page.getByLabel("Protein (g)").fill("18");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByTestId("own-flash")).toContainText("Red lentil dal now uses your changes");
  await expect(page.getByTestId("own-foods")).toContainText("18 g protein per serving");

  // The entry already logged is unchanged.
  await page.goto(dayUrl.replace(/&?done=logged/, ""));
  await expect(page.locator(".entry .name", { hasText: "Dal at home" })).toBeVisible();
  await expect(page.getByText("Red lentil dal")).toHaveCount(0);

  // Remove, then undo.
  await page.goto("/diary/foods");
  await page.getByRole("link", { name: "Change Red lentil dal" }).click();
  await page.getByRole("button", { name: "Remove from your foods" }).click();
  await expect(page.getByTestId("own-flash")).toContainText("Removed from your list");
  await expect(page.getByTestId("own-empty")).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByTestId("own-flash")).toHaveText("Put back on your list.");
  await expect(page.getByTestId("own-foods")).toContainText("Red lentil dal");
});

test("someone else's food, or a food that isn't yours, is not found", async ({ page }) => {
  await page.goto(`/login?next=${encodeURIComponent("/diary/foods")}`);
  await completeSignIn(page, `own2-${randomUUID().slice(0, 8)}@example.test`);
  await expect(page.getByTestId("own-empty")).toBeVisible();
  // The demo chickpea bowl is a public dish, not a food of one's own.
  // (The page streams, so the answer is the not-found page rather than a 404 status, as on profiles.)
  await page.goto("/diary/foods/00000000-0000-4000-8000-000000000201");
  await expect(page.getByRole("heading", { name: "We couldn’t find that" })).toBeVisible();
  await expect(page.getByTestId("own-food-form")).toHaveCount(0);
});
