import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";
import { completeSignIn, expectNoSidewaysScroll } from "../e2e/helpers";

/**
 * P2 "looks and feels like one product" (docs/68, L4), in real mode as the founder on a phone: what you can do
 * comes before the evidence on a meal page, a restaurant's actions come before its map, one private-preview note
 * per page, and a diet-sounding menu section is explained once per restaurant list. Skips on a fresh test database.
 */
test.use({ timezoneId: "America/New_York" });
test.setTimeout(300_000);

let ready = false;
test.beforeAll(async () => {
  ready = (await pool.query("select count(*)::int n from staging.live_catalog_links")).rows[0].n >= 8;
});

const before = (page: Page, a: string, b: string) =>
  page.evaluate(([x, y]) => {
    const ea = document.querySelector(`[data-testid="${x}"]`), eb = document.querySelector(`[data-testid="${y}"]`);
    return !!ea && !!eb && !!(ea.compareDocumentPosition(eb) & Node.DOCUMENT_POSITION_FOLLOWING);
  }, [a, b]);

test("meal and restaurant pages lead with what you can do, with one privacy note", async ({ browser }) => {
  test.skip(!ready, "Needs the real menus loaded and linked");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: "America/New_York" });
  const page = await context.newPage();
  const email = `p2-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2Fdiscover");
  await completeSignIn(page, email);
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id;
  await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher') on conflict do nothing", [id]);

  // Discover: the diet question comes before the meals it changes.
  await page.goto("/discover");
  expect(await before(page, "diet-welcome", "real-menus")).toBe(true);

  // A meal page: save, compare and log come before the note on what "unverified" means and the evidence.
  await page.goto("/protein/meals");
  await page.getByTestId("preview-meal").first().locator("a[href^='/meals/']").first().click();
  await expect(page.getByTestId("meal-actions")).toBeVisible();
  expect(await before(page, "meal-actions", "unverified-banner")).toBe(true);
  await expect(page.getByText(/(nothing here|none of them) is public|only you can see this page/i).filter({ visible: true })).toHaveCount(1);

  // A restaurant with a diet-sounding section: the note is said once, above the list.
  const slug = (await pool.query(`select pl.slug from staging.live_catalog_links k join staging.places sp on sp.id = k.staging_place
     join public.place_listings pl on pl.candidate_id = k.candidate_id where sp.label = 'Thai Basil' limit 1`)).rows[0]?.slug as string | undefined;
  if (slug) {
    await page.goto(`/places/${slug}?diet=any&fit=all`);
    await expect(page.getByTestId("section-note-once")).toHaveCount(1);
    await expect(page.getByTestId("meal-section-note")).toHaveCount(0);
    expect(await before(page, "place-social", "place-about-fold")).toBe(true);
    await expect(page.getByText(/only you can see this page/i)).toHaveCount(0);
  }
  await expectNoSidewaysScroll(page);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  await context.close();
});
