import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { deleteTestListings, pool } from "../helpers/db";
import { completeSignIn, expectNoSidewaysScroll } from "./helpers";

/**
 * The founder-only private beta on real data (docs/59) with an invented researched place: its drafted
 * meals appear to the founder on the place page and in Protein Explorer under "Unverified preview",
 * diet filters use only the restaurant's own words, a meal that names meat is left out of discovery,
 * a saved meal stays private, and an ordinary account sees nothing. The real-data walkthrough is
 * tests/e2e-real/menu-preview.spec.ts. The listing is removed at the end; staged rows are append-only.
 */
test.use({ timezoneId: "America/New_York" });
test.setTimeout(120_000);

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const NAME = `Preview e2e Thali ${tag}`;
const HOST = `thali-${tag}.test`;
const open: BrowserContext[] = [];
let listingId: string | undefined;
let slug = "";

const one = async (sql: string, params: unknown[]) => (await pool.query(`select ${sql} as r`, params)).rows[0].r;

test.beforeAll(async () => {
  const curator = randomUUID();
  await pool.query(
    `insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}', '{}', now(), now())`,
    [curator, `preview-curator-${tag}@example.test`],
  );
  await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'curator')", [curator]);
  await pool.query(
    `insert into staging.source_access (host, kind, status, evidence, reviewer, reviewed_at)
     values ($1, 'owner_decision', 'private_pilot', 'Test owner decision', 'Test reviewer', now())`,
    [HOST],
  );
  const place = await one("staging.add_place($1, $2, 'back_bay', 1::smallint)", [curator, NAME]);
  const src = await one("staging.add_source_page($1, $2, 'restaurant_site', 'Test', now())", [curator, `https://www.${HOST}/menu`]);
  const today = (await pool.query("select (now() at time zone 'America/New_York')::date::text d")).rows[0].d as string;
  const meals: [string, Record<string, unknown>[]][] = [
    ["Chana Masala Plate", [{ kind: "dietary_status", subject: "vegan", value: { claim: "vegan", status: "yes" } }, { kind: "published_nutrition", subject: "protein_g", value: { nutrient: "protein_g", amount: "24", per: "serving" } }]],
    ["Paneer Tikka Plate", [{ kind: "dietary_status", subject: "vegetarian", value: { claim: "vegetarian", status: "yes" } }, { kind: "published_nutrition", subject: "protein_g", value: { nutrient: "protein_g", low: "28", high: "32", basis: "published_range", per: "serving" } }]],
    ["Vegetable Biryani", []],
    ["Chicken Shawarma Plate", []],
  ];
  for (const [label, facts] of meals) {
    const d = await one("staging.add_dish($1, $2, $3)", [curator, place, label]);
    await one("staging.classify_dish($1, $2, 'complete_meal', null, 'Mains', null, 'source_section', null)", [curator, d]);
    for (const f of [{ kind: "price", value: { usd: "15.00" } }, ...facts])
      await one("staging.submit_fact($1, $2::jsonb)", [curator, JSON.stringify({ placeId: place, dishId: d, sourcePageId: src, checkedOn: today, confidence: "high", ...f })]);
  }
  const run = (await pool.query("insert into catalog_import.import_runs (source_key, release, file_sha256, retrieved_at, thresholds, status) values ('overture_places', 'e2e', $1, now(), '{}', 'refused') returning id", ["0".repeat(64)])).rows[0].id;
  const cand = (await pool.query("insert into catalog_import.place_candidates (name, street, postcode, lat, lon, category, quality, created_run) values ($1, '7 Sample Row', '02116', 42.349, -71.078, 'indian_restaurant', 'corroborated', $2) returning id", [NAME, run])).rows[0].id;
  const rec = (await pool.query(
    `insert into catalog_import.source_records (source_key, external_id, name, lat, lon, website, record_licence, record_hash, first_run, last_run, present)
     values ('overture_places', $1, $2, 42.349, -71.078, $3, 'CDLA-Permissive-2.0', $4, $5, $5, false) returning id`,
    [`e2e-${tag}`, NAME, `https://${HOST}/`, "1".repeat(64), run])).rows[0].id;
  await pool.query("insert into catalog_import.candidate_links (candidate_id, record_id, match_score, match_method) values ($1, $2, 1, 'seed')", [cand, rec]);
  slug = `preview-thali-${tag}`;
  listingId = (await pool.query(
    `insert into public.place_listings (candidate_id, slug, name, street, locality, postcode, area, lat, lon, category, identity_status, sources, built_from, cuisines)
     values ($1, $2, $3, '7 Sample Row', 'Boston', '02116', 'Back Bay / Prudential', 42.349, -71.078, 'Restaurant', 'corroborated',
             '[{"key":"overture_places","title":"Test dataset","attribution":"Test attribution e2e"}]', 'e2e', '[{"cuisine":"Indian","basis":"dataset_primary"}]') returning id`,
    [cand, slug, NAME])).rows[0].id;
  await one("staging.link_catalog($1, $2, $3, 'website_match')", [curator, place, cand]);
});
test.afterAll(async () => {
  await Promise.all(open.splice(0).map((c) => c.close().catch(() => undefined)));
  if (listingId) await deleteTestListings("l.id = $1", [listingId]);
});

async function person(browser: Browser, label: string, role?: string): Promise<{ page: Page; id: string }> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "America/New_York" });
  open.push(context);
  const page = await context.newPage();
  const email = `mpreview-${label}-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2F");
  await completeSignIn(page, email);
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
  if (role) await pool.query("insert into public.role_assignments (user_id, role) values ($1, $2) on conflict do nothing", [id, role]);
  return { page, id };
}
const axe = async (page: Page) => {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
};

test("the founder sees a researched place's drafted meals as an unverified preview", async ({ browser }) => {
  const { page, id } = await person(browser, "founder", "publisher");
  await page.goto(`/places/${slug}`);
  await expect(page.getByTestId("menu-status")).toHaveText("Menu: unverified preview");
  const menu = page.getByTestId("place-menu-preview");
  await expect(menu.getByTestId("unverified-banner")).toContainText("Unverified preview");
  await expect(menu.getByTestId("preview-diet-any")).toHaveText("All meals3");
  await expect(menu.getByTestId("preview-diet-vegetarian")).toHaveText("Vegetarian (stated)2");
  await expect(menu.getByTestId("preview-diet-vegan")).toHaveText("Vegan (stated)1");
  // Highest protein first by the low end of a range; unknown last.
  await expect(menu.getByTestId("preview-meal-name")).toHaveText(["Paneer Tikka Plate", "Chana Masala Plate", "Vegetable Biryani"]);
  const paneer = menu.getByTestId("preview-meal").filter({ hasText: "Paneer Tikka Plate" });
  await expect(paneer.getByTestId("preview-protein-tile")).toHaveAttribute("data-basis", "published_range");
  await expect(paneer.getByTestId("preview-protein-basis")).toHaveText("Printed range");
  await expect(paneer.getByTestId("preview-protein-tile")).toContainText("28–32");
  await expect(paneer.getByTestId("preview-unconfirmed")).toHaveText("Draft, not confirmed by you");
  const biryani = menu.getByTestId("preview-meal").filter({ hasText: "Vegetable Biryani" });
  await expect(biryani.getByTestId("preview-diet")).toHaveText("Diet unknown");
  await expect(biryani.getByTestId("preview-protein-tile")).toHaveAttribute("data-basis", "unknown");
  await expect(biryani.getByTestId("preview-protein-tile")).toContainText("protein unknown");
  await expect(menu.getByTestId("preview-left-out")).toContainText("1 meal left out of discovery");
  await expect(menu.getByTestId("preview-meal").filter({ hasText: "Chicken" })).toHaveCount(0);
  await expectNoSidewaysScroll(page);
  await axe(page);

  // A diet filter never lets an unknown diet through.
  await menu.getByTestId("preview-diet-vegetarian").click();
  await expect(page.getByTestId("place-menu-preview").getByTestId("preview-meal-name")).toHaveText(["Paneer Tikka Plate", "Chana Masala Plate"]);

  // Protein Explorer meals, filtered to this place: save one, then remove it.
  await page.goto(`/protein/meals?place=${slug}`);
  await expect(page.getByTestId("meal-count")).toHaveText("3 meals");
  await page.goto(`/protein/meals?place=${slug}&diet=vegan`);
  await expect(page.getByTestId("preview-meal-name")).toHaveText(["Chana Masala Plate"]);
  await page.getByTestId("meal-save").click();
  await expect(page.getByTestId("flash")).toHaveText("Meal saved to your private preview. Only you can see it.");
  expect((await pool.query("select count(*)::int n from staging.preview_saves where user_id = $1", [id])).rows[0].n).toBe(1);
  await page.getByTestId("meal-save").click();
  await expect(page.getByTestId("flash")).toHaveText("Meal removed from your saved meals.");
  expect((await pool.query("select count(*)::int n from staging.preview_saves where user_id = $1", [id])).rows[0].n).toBe(0);
  await page.getByTestId("meal-compare-toggle").click();
  await expect(page.getByTestId("meal-compare-bar")).toHaveCount(1);
  await axe(page);

  // The meal's own page: save, put it on one of the founder's lists, review it privately, and come back.
  await page.goto(`/places/${slug}`);
  await page.getByTestId("place-menu-preview").getByRole("link", { name: "Paneer Tikka Plate" }).click();
  await page.waitForURL(/\/meals\//);
  // The app keeps the previous screen hidden in the page for a quick "back"; start clean on the meal's page.
  await page.goto(page.url());
  await expect(page.getByTestId("meal-name")).toHaveText("Paneer Tikka Plate");
  await expect(page.getByTestId("meal-back")).toContainText(NAME);
  await expect(page.getByTestId("meal-price")).toHaveText("$15.00");
  await expect(page.getByTestId("unverified-banner")).toBeVisible();
  const mealUrl = page.url();
  await page.getByTestId("meal-save").click();
  await expect(page.getByTestId("meal-save")).toHaveAttribute("aria-pressed", "true");
  const lists = page.getByTestId("meal-lists");
  await lists.locator("summary").click();
  await lists.getByLabel("Start your first list").fill(`Thali night ${tag}`);
  await lists.getByRole("button", { name: /Create list and add/ }).click();
  await expect(page.getByTestId("flash")).toContainText("list");
  await expect(page.getByTestId("meal-lists-holding")).toContainText(`Thali night ${tag}`);
  const review = page.getByTestId("meal-review");
  await review.locator("summary").click();
  await review.locator(".rating-pick label").nth(3).click();
  await review.getByLabel("Notes for yourself (optional)").fill("Generous portion");
  await review.getByRole("button", { name: "Save review" }).click();
  await expect(page.getByTestId("flash")).toContainText("review");
  expect((await pool.query("select rating, body from staging.preview_reviews where user_id = $1", [id])).rows).toEqual([{ rating: 4, body: "Generous portion" }]);
  // Nothing reached the public list or review tables.
  expect((await pool.query("select count(*)::int n from public.reviews where author_id = $1", [id])).rows[0].n).toBe(0);
  expect((await pool.query("select count(*)::int n from public.food_list_items i join public.food_lists l on l.id = i.list_id where l.owner_id = $1", [id])).rows[0].n).toBe(0);
  await expectNoSidewaysScroll(page);
  await axe(page);
  // Saved, the list and My reviews all lead back to the same meal.
  await page.goto("/saved");
  await page.getByTestId("saved-meals").getByRole("link", { name: "Paneer Tikka Plate" }).click();
  await expect(page).toHaveURL(new RegExp(`${new URL(mealUrl).pathname}\\?from=%2Fsaved`));
  await expect(page.getByTestId("meal-back")).toContainText("Saved");
  await page.goto("/friends/reviews");
  await expect(page.getByTestId("meal-reviews")).toContainText("Paneer Tikka Plate");
  await expect(page.getByTestId("reviews-empty")).toHaveCount(0);
  const listId = (await pool.query("select id from public.food_lists where owner_id = $1 and title = $2", [id, `Thali night ${tag}`])).rows[0].id as string;
  await page.goto(`/friends/lists/${listId}`);
  await expect(page.getByTestId("list-meal")).toContainText("Paneer Tikka Plate");

  // Restaurants with menus lists it.
  await page.goto("/places/menus?cuisine=Indian");
  await expect(page.getByTestId("menus-place").filter({ hasText: NAME })).toBeVisible();
  // Nothing was confirmed or published.
  expect((await pool.query("select count(*)::int n from staging.fact_confirmations where confirmed_by = $1", [id])).rows[0].n).toBe(0);
});

test("an ordinary account and a visitor see nothing of the drafted meals", async ({ browser }) => {
  const { page } = await person(browser, "member");
  const dish = (await pool.query("select d.id from staging.dishes d join staging.places p on p.id = d.place_id where p.label = $1 and d.label = 'Paneer Tikka Plate'", [NAME])).rows[0].id as string;
  for (const path of [`/places/${slug}`, `/meals/${dish}`]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 }), path).toHaveText("We couldn’t find that");
  }
  // The meal lists say meals are not open to this account yet (the same words whether or not any exist), never the drafts.
  for (const path of ["/protein/meals", "/places/menus", "/search?q=paneer"]) {
    await page.goto(path);
    await expect(page.getByTestId("meals-not-open").filter({ visible: true }), path).toContainText("not open to your account yet");
    await expect(page.getByText("Paneer Tikka Plate")).toHaveCount(0);
    await expect(page.getByText("Chana Masala Plate")).toHaveCount(0);
  }
  await page.goto("/protein");
  await expect(page.getByTestId("protein-real-meals")).toHaveCount(0);
  const visitor = await browser.newContext();
  open.push(visitor);
  const v = await visitor.newPage();
  await v.goto(`/protein/meals?place=${slug}`);
  await expect(v.getByText("Restaurant meals are in a small private test for now")).toBeVisible();
  await expect(v.getByText("Chana Masala Plate")).toHaveCount(0);
});
