import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { FOOD, expectNoSidewaysScroll } from "./helpers";

/**
 * Owner 19:54 UTC 16 Nov, priority 1: comparing two or three dishes on 320–430 px screens without
 * cramped tables, sideways scrolling or the navigation covering content. The comparison is bars on
 * the chosen basis plus one card per food, and the four kinds of figure stay distinct: published
 * (the demo chickpea power bowl, 24 g), estimated range (the demo tempeh rice bowl, 24–32 g) and
 * unknown (a food with no per-100 g figure).
 */
const THREE = `/protein?est=1&compare=${FOOD.tempeh},${FOOD.bowl},${FOOD.tofu}`;

for (const width of [320, 375, 430]) {
  test.describe(`comparison at ${width} px`, () => {
    test.use({ viewport: { width, height: 760 } });

    test("bars and cards fit, nothing scrolls sideways, and the tab bar never covers a control", async ({ page }) => {
      await page.goto(THREE);
      const panel = page.getByTestId("compare-panel");
      await expect(panel).toContainText("Comparing 3 of up to 3");
      await expect(panel.locator("table")).toHaveCount(0);
      await expect(panel.getByTestId("compare-bar")).toHaveCount(3);
      await expect(panel.getByTestId("compare-card")).toHaveCount(3);
      // The page streams in: wait until the comparison is on screen, not just in the document.
      await expect(panel.getByTestId("compare-card").nth(2)).toBeVisible();
      await expectNoSidewaysScroll(page);
      for (const el of await panel.locator(".cmp-card, .cmp-bars li").all()) {
        const box = (await el.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
      }
      // Every control in the comparison can be reached and clicked: the fixed tab bar is not on top of it.
      for (const link of await panel.getByRole("link").all()) {
        await link.scrollIntoViewIfNeeded();
        await link.click({ trial: true });
      }
      const r = await new AxeBuilder({ page }).include("[data-testid=compare-panel]").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    });
  });
}

test.describe("the four kinds of figure stay distinct", () => {
  test.use({ viewport: { width: 360, height: 760 } });

  test("published is a solid bar, an estimate is its range with 'about', unknown has no bar and no zero", async ({ page }) => {
    await page.goto(THREE);
    const bars = page.getByTestId("compare-bar");
    const est = bars.filter({ hasText: "Demo tempeh rice bowl" });
    await expect(est).toHaveAttribute("data-state", "estimated");
    await expect(est).toContainText("about 28 g (estimate 24–32 g)");
    await expect(est.locator(".cmp-range")).toHaveCount(1);
    await expect(est.locator(".cmp-fill")).toHaveCount(0);
    const pub = bars.filter({ hasText: "Demo chickpea power bowl" });
    await expect(pub).toHaveAttribute("data-state", "published");
    await expect(pub.locator(".cmp-bar-value")).toHaveText("24 g");
    await expect(pub.locator(".cmp-fill")).toHaveCount(1);

    // Per 100 g the chickpea bowl has no serving weight: no bar, worded, never 0.
    await page.goto(`/protein?est=1&basis=100g&compare=${FOOD.tempeh},${FOOD.bowl}`);
    const unknown = page.getByTestId("compare-bar").filter({ hasText: "Demo chickpea power bowl" });
    await expect(unknown).toHaveAttribute("data-state", "unknown");
    await expect(unknown.locator(".cmp-track")).toHaveCount(0);
    await expect(unknown).not.toContainText(/\b0 g/);
    await expect(page.getByTestId("compare-basis-warning")).toContainText("Demo chickpea power bowl");

    // With estimates hidden, the tempeh bowl says so instead of showing a number.
    await page.goto(`/protein?compare=${FOOD.tempeh},${FOOD.bowl}`);
    const hidden = page.getByTestId("compare-bar").filter({ hasText: "Demo tempeh rice bowl" });
    await expect(hidden).toHaveAttribute("data-state", "unknown");
    await expect(hidden).toContainText("Estimate hidden");
    await expect(hidden).not.toContainText(/\d+ g/);
  });
});

test.describe("comparison on a desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("cards sit side by side", async ({ page }) => {
    await page.goto(THREE);
    const cards = page.getByTestId("compare-card");
    await expect(cards).toHaveCount(3);
    await expect(cards.nth(2)).toBeVisible();
    const [a, b, c] = await Promise.all([0, 1, 2].map(async (i) => (await cards.nth(i).boundingBox())!));
    expect(Math.abs(a.y - b.y)).toBeLessThan(2);
    expect(Math.abs(b.y - c.y)).toBeLessThan(2);
    await expectNoSidewaysScroll(page);
  });
});
