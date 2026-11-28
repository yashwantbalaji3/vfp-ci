import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { deleteTestListings, pool } from "../helpers/db";
import { completeSignIn, expectNoSidewaysScroll } from "./helpers";

/**
 * Real places in saves, ratings and lists (docs/49), in a real browser at phone width with axe.
 * The place is invented; it and everything attached to it are removed at the end.
 */
test.use({ timezoneId: "America/New_York", viewport: { width: 360, height: 740 } });
test.setTimeout(180_000);

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const NAME = `Social e2e Heron ${tag}`;
const SLUG = `social-e2e-${tag}`;
const SRC = JSON.stringify([{ key: "overture_places", title: "Test dataset", attribution: "Test attribution e2e", release: "r-e2e" }]);
const CUISINE = JSON.stringify([{ cuisine: "Ethiopian", basis: "dataset_primary", category: "ethiopian_restaurant" }]);
const open: BrowserContext[] = [];
let listingId = "";

test.beforeAll(async () => {
  listingId = (await pool.query(
    `insert into public.place_listings (candidate_id, slug, name, street, locality, postcode, area, lat, lon, category, identity_status, sources, built_from, cuisines)
     values (gen_random_uuid(), $1, $2, '12 Sample Row', 'Boston', '02118', 'South End', 42.3415, -71.0735, 'Restaurant', 'corroborated', $3, 'e2e', $4) returning id`,
    [SLUG, NAME, SRC, CUISINE])).rows[0].id;
});
test.afterAll(async () => {
  await Promise.all(open.splice(0).map((c) => c.close().catch(() => undefined)));
  await deleteTestListings("l.id = $1", [listingId]);
});

async function person(browser: Browser, label: string, role?: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: "America/New_York" });
  open.push(context);
  const page = await context.newPage();
  const email = `social-${label}-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2F");
  await completeSignIn(page, email);
  if (role) {
    const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
    await pool.query("insert into public.role_assignments (user_id, role) values ($1, $2) on conflict do nothing", [id, role]);
  }
  return page;
}
const seen = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });
async function axe(page: Page) {
  await page.waitForLoadState("networkidle");
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  await expectNoSidewaysScroll(page);
}

test("the founder saves, lists and rates a real place; the menu stays unchecked", async ({ browser }) => {
  const founder = await person(browser, "founder", "publisher");
  await founder.goto(`/places/${SLUG}`);
  await expect(seen(founder, "place-name")).toHaveText(NAME);
  await expect(seen(founder, "place-cuisine")).toContainText("Cuisine or style: Ethiopian");
  await expect(seen(founder, "place-cuisine")).toContainText("not checked by us");
  await expect(seen(founder, "place-social")).toBeVisible();
  await expect(seen(founder, "menu-status")).toHaveText("Menu not checked yet");
  await axe(founder);

  // Save.
  await seen(founder, "save-button").click();
  await expect(seen(founder, "save-status")).toContainText("Saved. Only you can see");
  await expect(seen(founder, "save-button")).toContainText("Saved");

  // Add to a new private list.
  await founder.getByText("Add to a list").filter({ visible: true }).click();
  await founder.getByLabel("Start your first list").fill(`Heron list ${tag}`);
  await founder.getByRole("button", { name: "Create list and add this" }).click();
  const v = (await pool.query("select venue_id from public.place_listings where id = $1", [listingId])).rows[0].venue_id as string;
  await expect.poll(async () => (await pool.query("select count(*)::int n from public.food_list_items where venue_id = $1", [v])).rows[0].n).toBe(1);

  // Rate it. Saving the review returns to the place page.
  await founder.goto(`/places/${SLUG}`);
  await seen(founder, "write-review").click();
  await founder.locator(".rating-pick label").filter({ hasText: /^4Very good$/ }).click();
  await founder.getByLabel(/What would you tell a friend/).fill(`Lentil stew was hearty ${tag}`);
  await founder.getByRole("radio", { name: /^Only me/ }).check();
  await founder.getByRole("button", { name: "Save review" }).click();
  await expect(founder).toHaveURL(new RegExp(`/places/${SLUG}`));
  await expect(seen(founder, "reviews-section")).toContainText(`Lentil stew was hearty ${tag}`);
  await axe(founder);

  // Saved shows the real place, with its honest label.
  await founder.goto("/saved");
  const saved = seen(founder, "saved-place").filter({ hasText: NAME });
  await expect(saved).toContainText("Menu not checked yet");
  await axe(founder);
  await saved.getByRole("link", { name: NAME }).click();
  await expect(seen(founder, "place-name")).toHaveText(NAME);

  // An older /venues/<id> link (feeds, lists, rankings) opens the place page.
  await founder.goto(`/venues/${v}`);
  await expect(founder).toHaveURL(new RegExp(`/places/${SLUG}$`));

  // Nothing about the listing changed.
  const row = (await pool.query("select visibility, menu_status from public.place_listings where id = $1", [listingId])).rows[0];
  expect(row).toEqual({ visibility: "preview", menu_status: "not_checked" });
});

test("a member sees none of it: no place, no ratings, no saved entry", async ({ browser }) => {
  const member = await person(browser, "member");
  const res = await member.goto(`/places/${SLUG}`);
  expect(res?.status()).toBe(404);
  const v = (await pool.query("select venue_id from public.place_listings where id = $1", [listingId])).rows[0].venue_id as string | null;
  if (v) {
    const venue = await member.goto(`/venues/${v}`);
    expect(venue?.status()).toBe(404);
    await member.goto(`/review?kind=venue&id=${v}`);
    await expect(member.getByText(NAME)).toHaveCount(0);
  }
  await member.goto("/saved");
  await expect(member.getByText(NAME)).toHaveCount(0);
});
