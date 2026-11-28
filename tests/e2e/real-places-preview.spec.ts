import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { deleteTestListings, pool } from "../helpers/db";
import { completeSignIn, expectNoSidewaysScroll } from "./helpers";

/**
 * Private real-catalog preview in a real browser (docs/32): the founder sees real places labelled
 * "Menu not checked yet"; a member without the role and a guest see nothing; the places never appear
 * among dishes. The listing used here is invented and removed at the end.
 */
test.use({ timezoneId: "America/New_York", viewport: { width: 360, height: 740 } });
test.setTimeout(120_000);

const tag = randomUUID().slice(0, 6);
const NAME = `Preview e2e Lantern ${tag}`;
const open: BrowserContext[] = [];
let listingId: string | undefined;

test.beforeAll(async () => {
  listingId = (await pool.query(
    `insert into public.place_listings (candidate_id, slug, name, street, locality, postcode, area, lat, lon, category, identity_status, sources, built_from)
     values (gen_random_uuid(), $1, $2, '9 Sample Row', 'Boston', '02118', 'South End', 42.341, -71.072, 'Café', 'corroborated',
             '[{"key":"overture_places","title":"Test dataset","attribution":"Test attribution e2e"}]', 'e2e') returning id`,
    [`preview-e2e-${tag}`, NAME],
  )).rows[0].id;
});
test.afterAll(async () => {
  await Promise.all(open.splice(0).map((c) => c.close().catch(() => undefined)));
  if (listingId) await deleteTestListings("l.id = $1", [listingId]);
});

async function person(browser: Browser, label: string, role?: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: "America/New_York" });
  open.push(context);
  const page = await context.newPage();
  const email = `preview-${label}-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2F");
  await completeSignIn(page, email);
  if (role) {
    const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
    await pool.query("insert into public.role_assignments (user_id, role) values ($1, $2) on conflict do nothing", [id, role]);
  }
  return page;
}

test("the founder sees real places labelled 'Menu not checked yet'; they never appear among dishes", async ({ browser }) => {
  const founder = await person(browser, "founder", "publisher");
  await founder.goto("/discover");
  await expect(founder.getByTestId("real-places-link")).toContainText("private preview");
  await founder.getByTestId("real-places-link").getByRole("link").click();
  await expect(founder).toHaveURL(/\/places$/);
  await expect(founder.getByTestId("real-banner")).toContainText("Only you can see these real places");
  await expect(founder.getByTestId("preview-note")).toHaveCount(0);

  await founder.getByLabel("Search places by name or street").fill(tag);
  await founder.getByRole("button", { name: "Search" }).click();
  const card = founder.getByTestId("place-listing").filter({ hasText: NAME });
  await expect(card).toBeVisible();
  await expect(card.getByTestId("menu-status")).toHaveText("Menu not checked yet");
  await expect(card.getByTestId("identity-status")).toContainText("not yet checked by us");
  await expect(founder.getByTestId("places-menu-note")).toContainText("not in any diet or protein filter");
  await expect(founder.getByTestId("place-sources")).toContainText("Test attribution e2e");
  await expect(founder.getByTestId("places-count")).toHaveText("1 place");
  await founder.waitForLoadState("networkidle");
  const axe = await new AxeBuilder({ page: founder }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  await expectNoSidewaysScroll(founder);

  // Not a dish: dish search finds nothing for it, with or without a diet filter.
  await founder.goto(`/discover?q=${encodeURIComponent(NAME)}`);
  await expect(founder.getByTestId("results-heading")).toHaveText(/^0 dish/);
});

test("a member without the founder role and a guest see no real places", async ({ browser }) => {
  const member = await person(browser, "member");
  await member.goto(`/places?q=${tag}`);
  await expect(member.getByTestId("places-none")).toBeVisible();
  await expect(member.getByText(NAME)).toHaveCount(0);
  await member.goto("/discover");
  await expect(member.getByTestId("results-heading")).toBeVisible();
  await expect(member.getByTestId("real-places-link")).toHaveCount(0);

  const guest = await (await browser.newContext()).newPage();
  open.push(guest.context());
  await guest.goto(`/places?q=${tag}`);
  await expect(guest.getByTestId("social-signin")).toBeVisible();
  await expect(guest.getByText(NAME)).toHaveCount(0);
});
