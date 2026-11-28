import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { completeSignIn, expectNoSidewaysScroll } from "./helpers";

/**
 * Joined-up journey (owner 18 Nov 02:27 UTC, item 8): after logging a restaurant dish, the day page offers
 * to rate it or open it. Rating is a separate step that starts private; the diary entry is never shared.
 * A food of one's own gets no such offer.
 */
test.use({ viewport: { width: 360, height: 740 }, timezoneId: "America/New_York" });
const BOWL = "00000000-0000-4000-8000-000000000201";

test("log a restaurant dish, then rate it from the diary and come back", async ({ page }) => {
  await page.goto(`/login?next=${encodeURIComponent(`/diary/log?food=${BOWL}`)}`);
  await completeSignIn(page, `next-${randomUUID().slice(0, 8)}@example.test`);
  await expect(page.getByTestId("log-food-name")).toHaveText("Demo chickpea power bowl");
  await page.getByRole("button", { name: "Add to diary" }).click();
  await expect(page.getByTestId("diary-flash")).toHaveText("Added to your diary.");

  const next = page.getByTestId("diary-next-step");
  await expect(next).toContainText("Demo chickpea power bowl");
  await expect(next).toContainText("Your diary stays private.");
  await page.waitForLoadState("networkidle");
  await expect(page).toHaveTitle(/\S/);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  await expectNoSidewaysScroll(page);

  await next.getByRole("link", { name: "Rate this dish" }).click();
  await expect(page.getByTestId("review-target")).toHaveText("Demo chickpea power bowl");
  await expect(page.getByRole("radio", { name: /Only me/ })).toBeChecked();
  await page.getByRole("link", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/diary\?date=/);
  // The offer is only shown right after logging.
  await expect(page.getByTestId("diary-next-step")).toHaveCount(0);

  // A food of one's own gets no offer, even if the address names it.
  await page.goto("/diary/custom");
  await page.getByLabel("What was it?").fill("Leftover dal");
  await page.getByRole("button", { name: "Add to diary" }).click();
  await expect(page.getByTestId("diary-flash")).toHaveText("Added to your diary.");
  await expect(page.getByTestId("diary-next-step")).toHaveCount(0);
});
