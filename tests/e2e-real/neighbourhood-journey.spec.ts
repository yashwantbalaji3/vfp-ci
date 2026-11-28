import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { pool } from "../helpers/db";
import { completeSignIn, expectNoSidewaysScroll } from "../e2e/helpers";

/**
 * "Find a suitable meal nearby fast, compare protein, save, log" (owner direction 20 Nov 2026 21:20 UTC, item 4;
 * docs/64), in real mode as the founder: pick a neighbourhood, narrow by distance, see several restaurants, compare
 * two meals from different restaurants, save one, log it to the private diary. Also checks that the open map's
 * vegetarian category is shown only as an attributed place-level hint and never makes a dish vegetarian.
 * Runs only where the real menus are loaded and linked, so it skips on a freshly reset test database.
 */
test.use({ timezoneId: "America/New_York" });
test.setTimeout(600_000);
const SHOTS = process.env.SHOTS_DIR ?? "test-results/neighbourhood-journey";

let ready = false;
test.beforeAll(async () => {
  ready = (await pool.query("select count(*)::int n from staging.live_catalog_links")).rows[0].n >= 8;
  mkdirSync(SHOTS, { recursive: true });
});

const check = async (page: Page) => {
  await expectNoSidewaysScroll(page);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
};
const placeOf = async (page: Page, i: number) => ((await page.getByTestId("preview-meal").nth(i).locator(".meta").first().textContent()) ?? "").split(" · ")[0].trim();

for (const width of [390, 1440]) {
  const size = width > 800 ? "desktop" : "phone";
  test(`find a meal near Kenmore, compare, save and log it (${size})`, async ({ browser }) => {
    test.skip(!ready, "Needs the real menus loaded and linked");
    const context = await browser.newContext({ viewport: { width, height: width > 800 ? 900 : 844 }, deviceScaleFactor: 2, isMobile: width < 800, hasTouch: width < 800, timezoneId: "America/New_York" });
    const page = await context.newPage();
    const email = `hood-${size}-${randomUUID().slice(0, 8)}@example.test`;
    await page.goto("/login?next=%2Fdiscover");
    await completeSignIn(page, email);
    const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id;
    await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher') on conflict do nothing", [id]);

    // Discover offers the owner's priority neighbourhoods that have meals, in a fixed order, with counts (27 Nov 2026:
    // areas from the listing's address, the charter's twelve since 28 Nov 2026; an area with no meal yet is left out).
    await page.goto("/discover");
    const hoods = page.getByTestId("real-menus-hoods");
    const order = ["Fenway & Kenmore", "Back Bay", "Downtown & Chinatown", "Cambridge & Somerville", "Allston & Brighton", "Brookline", "South End",
      "South Boston & Seaport", "Beacon Hill & West End", "Mission Hill & Longwood", "Jamaica Plain & Roxbury", "East Boston & Charlestown"];
    const shown = (await hoods.getByRole("link").allTextContents()).map((t) => order.findIndex((o) => t.includes(`Meals in ${o}`)));
    expect(shown.slice(0, 2)).toEqual([0, 1]);
    expect(shown).toEqual([...shown].sort((x, y) => x - y));
    expect(shown).not.toContain(-1);
    await hoods.getByRole("link", { name: /Meals in Fenway/ }).click();
    await expect(page).toHaveURL(/hood=fenway/);
    await expect(page.getByTestId("meal-count")).toContainText("in Fenway");
    await expect(page.locator('[data-testid=meal-hoods] [aria-current="true"]')).toContainText("Fenway");

    // Within 2 miles of Kenmore Square, nearest first: several restaurants, each card says how far.
    await page.getByTestId("meal-within").getByRole("link", { name: "2 miles" }).click();
    await expect(page).toHaveURL(/within=2/);
    await page.getByTestId("meal-within").getByRole("link", { name: "Nearest first" }).click();
    await expect(page).toHaveURL(/sort=near/);
    await expect(page.getByTestId("meal-count")).toContainText("within 2 miles of Kenmore Square");
    await expect(page.getByTestId("meal-distance").first()).toContainText(/\d\.\d mi from Kenmore Square, in a straight line/);
    const n = await page.getByTestId("preview-meal").count();
    const names = new Set<string>();
    for (let i = 0; i < Math.min(n, 12); i++) names.add(await placeOf(page, i));
    expect(names.size).toBeGreaterThanOrEqual(3);
    const miles = (await page.getByTestId("meal-distance").allTextContents()).map((t) => Number(t.split(" ")[0]));
    expect([...miles].sort((a, b) => a - b)).toEqual(miles);
    await check(page);
    await page.screenshot({ path: `${SHOTS}/${size}-01-near-kenmore.png`, fullPage: false });

    // Compare protein for the first meals of two different restaurants.
    const first = await placeOf(page, 0);
    let other = 1;
    while (other < n && (await placeOf(page, other)) === first) other++;
    expect(other).toBeLessThan(n);
    await page.getByTestId("meal-compare-toggle").nth(0).click();
    await expect(page).toHaveURL(/compare=/);
    await page.getByTestId("meal-compare-toggle").nth(other).click();
    await expect(page).toHaveURL(/compare=[^&#]+%2C|compare=[^&#]+,/);
    const compare = page.locator("#compare");
    await expect(compare).toBeVisible();
    await expect(compare).toContainText(first);
    await expect(compare).toContainText(await placeOf(page, other));
    await page.screenshot({ path: `${SHOTS}/${size}-02-compare.png`, fullPage: false });

    // Save the first meal: it stays in the same neighbourhood view and is counted under Saved.
    await page.getByTestId("meal-save").nth(0).click();
    await expect(page).toHaveURL(/hood=fenway/);
    await expect(page.getByTestId("meal-save").nth(0)).toHaveAttribute("aria-pressed", "true");
    const mealHref = (await page.getByTestId("preview-meal").nth(0).locator("a[href^='/meals/']").first().getAttribute("href"))!;

    // Log it to the private diary from its page.
    await page.goto(mealHref.split("?")[0]);
    await page.getByTestId("meal-log").click();
    await expect(page).toHaveURL(/\/diary\/custom\?meal=/);
    await expect(page.getByTestId("custom-prefill-note")).toContainText("Unverified preview");
    const name = await page.getByLabel("What was it?").inputValue();
    await page.getByRole("button", { name: "Add to diary" }).click();
    await page.waitForURL(/\/diary(\?|$)/);
    await page.goto("/diary");
    await expect(page.getByTestId("diary-entry").filter({ hasText: name })).toHaveCount(1);
    await page.screenshot({ path: `${SHOTS}/${size}-03-logged.png`, fullPage: false });
    await context.close();
  });
}

test("the open map's vegetarian category is a place-level hint only, never a dish's diet", async ({ browser }) => {
  test.skip(!ready, "Needs the real menus loaded and linked");
  const hinted = (await pool.query(`
    select pl.slug from staging.live_catalog_links k join public.place_listings pl on pl.candidate_id = k.candidate_id
     where jsonb_array_length(staging.place_diet_hints(pl.candidate_id)) > 0 limit 1`)).rows[0]?.slug as string | undefined;
  test.skip(!hinted, "No linked place has an open-map vegetarian or vegan category here");
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const email = `hint-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2F");
  await completeSignIn(page, email);
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id;
  await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher') on conflict do nothing", [id]);
  await page.goto(`/places/${hinted}`);
  await expect(page.getByTestId("place-diet-hint")).toContainText(/in Overture Maps\..*not checked by us.*only the menu can/);
  // That a hint never makes a dish fit a diet is checked in tests/unit/meal-eligibility.test.ts.
  await page.goto("/places/menus");
  await expect(page.getByTestId("menus-diet-hint").first()).toContainText("meal diets come only from the menu");
  await page.screenshot({ path: `${SHOTS}/place-hint.png`, fullPage: false });
  await context.close();
});
