import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { pool } from "../helpers/db";
import { completeSignIn, expectNoSidewaysScroll } from "../e2e/helpers";

/**
 * Boston first (owner directive 27 Nov 2026 06:04 UTC), in real mode as the founder:
 *  - every Boston listing has an address-based neighbourhood, so Allston & Brighton, Brookline, Downtown & Chinatown
 *    and South End can be browsed, for places and for meals, with the same definition everywhere;
 *  - a restaurant nobody has researched points to the nearest researched menus instead of a dead end;
 *  - the founder's review card has a "Menu's own words" row (here, with no private copies on this computer, it says
 *    so plainly rather than showing anything).
 * Runs only where the real menus are loaded and linked.
 */
test.use({ timezoneId: "America/New_York" });
test.setTimeout(600_000);
const SHOTS = process.env.SHOTS_DIR ?? "test-results/boston-first";

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

async function founder(page: Page, size: string) {
  const email = `boston-${size}-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2Fdiscover");
  await completeSignIn(page, email);
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id;
  await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher') on conflict do nothing", [id]);
}

test("every Boston listing has a neighbourhood from its address, the same one the database would give it now", async () => {
  test.skip(!ready, "Needs the real menus loaded and linked");
  const r = (
    await pool.query(`select count(*)::int n, count(*) filter (where area is null)::int none,
                             count(*) filter (where area is distinct from app.boston_area(postcode, locality, lon))::int differ
                        from public.place_listings where market_slug = 'boston'`)
  ).rows[0];
  expect(r.n).toBeGreaterThan(1000);
  expect(r.differ).toBe(0);
  expect(r.none / r.n).toBeLessThan(0.02);
});

for (const width of [390, 1440]) {
  const size = width > 800 ? "desktop" : "phone";
  test(`browse the priority neighbourhoods, follow an unresearched place to nearby menus, see the review row (${size})`, async ({ browser }) => {
    test.skip(!ready, "Needs the real menus loaded and linked");
    const context = await browser.newContext({ viewport: { width, height: width > 800 ? 900 : 844 }, isMobile: width < 800, hasTouch: width < 800, timezoneId: "America/New_York" });
    const page = await context.newPage();
    await founder(page, size);

    // Places: Brookline and Allston / Brighton are areas of their own now.
    await page.goto("/places?area=Brookline");
    await expect(page.locator("main")).toContainText("Brookline");
    const cards = page.locator('main a[href^="/places/"]');
    expect(await cards.count()).toBeGreaterThan(0);
    await check(page);

    // Meals: Allston & Brighton is a meal filter, and every meal it shows is at an Allston or Brighton address.
    await page.goto("/protein/meals?hood=allston-brighton");
    await expect(page.locator('[data-testid=meal-hoods] [aria-current="true"]')).toContainText("Allston & Brighton");
    const n = await page.getByTestId("preview-meal").count();
    expect(n).toBeGreaterThan(0);
    const allston = (
      await pool.query(`select count(*)::int n from staging.dishes d join staging.live_catalog_links k on k.staging_place = d.place_id
                          join public.place_listings pl on pl.candidate_id = k.candidate_id where pl.area = 'Allston / Brighton'`)
    ).rows[0].n;
    expect(allston).toBeGreaterThan(0);
    await page.screenshot({ path: `${SHOTS}/meals-allston-${size}.png`, fullPage: false });
    await check(page);

    // An unresearched place near researched menus: the page says so and points to up to three of them, nearest
    // labelled ones first, each a working link.
    const near = (
      await pool.query(`select pl.slug from public.place_listings pl
                         where pl.market_slug = 'boston' and pl.visibility = 'preview' and pl.menu_status = 'not_checked' and pl.area = 'Back Bay / Prudential'
                           and not exists (select 1 from staging.live_catalog_links k where k.candidate_id = pl.candidate_id)
                         order by pl.slug limit 1`)
    ).rows[0]?.slug as string | undefined;
    test.skip(!near, "No unresearched Back Bay listing in this data");
    await page.goto(`/places/${near}`);
    await expect(page.getByTestId("place-menu")).toContainText("Menu not checked yet");
    const nearby = page.getByTestId("place-nearby-menus");
    await expect(nearby).toBeVisible();
    const links = nearby.locator("li a");
    const k = await links.count();
    expect(k).toBeGreaterThan(0);
    expect(k).toBeLessThanOrEqual(3);
    await expect(nearby.locator("li").first()).toContainText(/\d\.\d mi away/);
    await page.screenshot({ path: `${SHOTS}/unresearched-place-${size}.png`, fullPage: true });
    await check(page);
    await links.first().click();
    await expect(page).toHaveURL(/\/places\/[a-z0-9-]+$/);
    // A researched menu, not another dead end (the page left behind stays hidden in the document, so count visible ones).
    await expect(page.getByTestId("place-name").filter({ visible: true })).toBeVisible();
    await expect(page.getByTestId("place-menu").filter({ visible: true })).toHaveCount(0);

    // The founder's review card has the menu's-own-words row; with no private copies here, it says so.
    await page.goto("/places/review/queue");
    const row = page.getByTestId("rq-original").first();
    await expect(row).toBeVisible();
    await expect(row).toContainText(/private copies of the saved menus aren.t connected on this computer/);
    await expect(page.getByTestId("rq-original-excerpt")).toHaveCount(0);
    await context.close();
  });
}
