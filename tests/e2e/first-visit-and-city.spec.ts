// Overnight directive 24 Nov 2026 07:19 UTC: a first visit explains the product (part 3.3); six markets, one
// architecture, and a city without listings says so instead of showing another city's food (part 5, docs/83).
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";
import { completeSignIn, expectNoSidewaysScroll } from "./helpers";

for (const width of [390, 1440]) {
  test(`a first-time visitor learns what this is and what works without an account (${width} px)`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    await page.goto("/discover");
    const welcome = page.getByTestId("visitor-welcome");
    await expect(welcome).toContainText("Vegetarian and vegan food, made simpler");
    await expect(welcome).toContainText("No account needed");
    await expect(welcome.getByRole("link", { name: "Cook a recipe" })).toHaveAttribute("href", "/cook");
    await expect(page.getByText(/founder/i)).toHaveCount(0);
    await expect(page.getByTestId("market-line")).toContainText("Boston area");
    await expectNoSidewaysScroll(page);
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(axe.violations.map((v) => v.id)).toEqual([]);
    await context.close();
  });
}

test("choosing a city that is not open yet says so plainly and keeps Boston's food out of it", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto("/discover");
  await page.getByTestId("market-change").click();
  await expect(page).toHaveURL(/\/city\?return=%2Fdiscover/);
  for (const slug of ["boston", "new-york", "chicago", "los-angeles", "san-francisco", "dallas"]) await expect(page.getByTestId(`city-${slug}`)).toBeVisible();
  await page.getByTestId("city-chicago").getByRole("radio").check();
  await page.getByTestId("city-save").click();
  await expect(page).toHaveURL(/\/discover$/);
  await expect(page.getByTestId("market-line")).toContainText("Chicago area");
  await expect(page.getByTestId("market-coming")).toContainText("Restaurants in the Chicago area are coming later");
  await expect(page.locator("[data-testid='results-heading'], [data-testid='real-first']")).toHaveCount(0);
  // Back to Boston: the usual Discover returns.
  await page.goto("/city?return=%2Fdiscover");
  await page.getByTestId("city-boston").getByRole("radio").check();
  await page.getByTestId("city-save").click();
  await expect(page.getByTestId("market-line")).toContainText("Boston area");
  await expect(page.getByTestId("market-coming")).toHaveCount(0);
  await context.close();
});

test("a member's city is saved with their account and follows them to another browser; nobody else sees it", async ({ browser }) => {
  const email = `city-${randomUUID().slice(0, 8)}@example.test`;
  const a = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pa = await a.newPage();
  await pa.goto("/login?next=%2Fdiscover");
  await completeSignIn(pa, email);
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
  // A member who answered the diet question has a preferences row; the city is stored on it.
  await pa.goto("/discover");
  await pa.getByTestId("diet-welcome-vegan").click();
  await expect(pa.getByTestId("diet-welcome")).toHaveCount(0);
  await pa.getByTestId("market-change").click();
  await pa.getByTestId("city-chicago").getByRole("radio").check();
  await pa.getByTestId("city-save").click();
  await expect(pa.getByTestId("market-line")).toContainText("Chicago area");
  expect((await pool.query("select home_market from public.user_preferences where user_id = $1", [id])).rows).toEqual([{ home_market: "chicago" }]);
  await a.close();
  // Another browser with no cookie: the account's city applies once signed in.
  const b = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pb = await b.newPage();
  await pb.goto("/discover");
  await expect(pb.getByTestId("market-line")).toContainText("Boston area");
  await pb.goto("/login?next=%2Fdiscover");
  await completeSignIn(pb, email);
  await pb.goto("/discover");
  await expect(pb.getByTestId("market-line")).toContainText("Chicago area");
  await expect(pb.getByTestId("market-coming")).toBeVisible();
  await b.close();
  await pool.query("delete from auth.users where id = $1", [id]);
});
