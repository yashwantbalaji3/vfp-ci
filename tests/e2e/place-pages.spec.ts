import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { deleteTestListings, pool } from "../helpers/db";
import { completeSignIn, expectNoSidewaysScroll } from "./helpers";

/**
 * Real place pages, the private Map/List and "Report a problem" in a real browser (docs/36), at phone
 * width with axe. Places are invented; listings are removed at the end (reports go with them).
 */
test.use({ timezoneId: "America/New_York", viewport: { width: 360, height: 740 } });
test.setTimeout(180_000);

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const NAME = `Pages e2e Kestrel ${tag}`;
const SRC = JSON.stringify([{ key: "overture_places", title: "Test dataset", attribution: "Test attribution e2e", release: "r-e2e" }]);
const open: BrowserContext[] = [];
const slugs: string[] = [];
const ids: string[] = [];

test.beforeAll(async () => {
  for (const [i, [lat, lon]] of [[42.3412, -71.0731], [42.3418, -71.0739], [42.3425, -71.0722]].entries()) {
    const slug = `pages-e2e-${tag}-${i}`;
    slugs.push(slug);
    ids.push((await pool.query(
      `insert into public.place_listings (candidate_id, slug, name, street, locality, postcode, area, lat, lon, category, identity_status, sources, built_from)
       values (gen_random_uuid(), $1, $2, $3, 'Boston', '02118', 'South End', $4, $5, 'Café', $6, $7, 'e2e') returning id`,
      [slug, `${NAME} ${i}`, `${10 + i} Sample Row`, lat, lon, i === 0 ? "verified" : "corroborated", SRC])).rows[0].id);
  }
});
test.afterAll(async () => {
  await Promise.all(open.splice(0).map((c) => c.close().catch(() => undefined)));
  await pool.query("delete from public.place_reports where listing_id = any($1::uuid[])", [ids]);
  await deleteTestListings("l.id = any($1::uuid[])", [ids]);
});

async function person(browser: Browser, label: string, role?: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: "America/New_York" });
  open.push(context);
  const page = await context.newPage();
  const email = `pages-${label}-${randomUUID().slice(0, 8)}@example.test`;
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

test("the founder opens a real place from the list: honest labels, map, sources, and a report that changes nothing", async ({ browser }) => {
  const founder = await person(browser, "founder", "publisher");
  await founder.goto(`/places?q=${encodeURIComponent(NAME)}`);
  await expect(seen(founder, "places-count")).toHaveText("3 places");
  await seen(founder, "place-link").filter({ hasText: `${NAME} 0` }).click();
  await expect(seen(founder, "place-name")).toHaveText(`${NAME} 0`);
  await expect(seen(founder, "menu-status")).toHaveText("Menu not checked yet");
  await expect(seen(founder, "identity-status")).toContainText("Identity checked by us");
  await expect(seen(founder, "place-menu")).toContainText("not in any diet or protein filter");
  await expect(seen(founder, "place-sources")).toContainText("Test dataset (release r-e2e)");
  await axe(founder);

  await founder.goto(`/places/${slugs[1]}`);
  await expect(seen(founder, "identity-status")).toContainText("not yet checked by us");
  await founder.getByText("Something is wrong with this listing").filter({ visible: true }).click();
  await founder.getByLabel("It has closed").filter({ visible: true }).check();
  await founder.getByLabel(/^Details/).filter({ visible: true }).fill("Windows papered over");
  await seen(founder, "report-send").click();
  await expect(seen(founder, "report-message")).toContainText("does not change the listing");
  await expect(seen(founder, "place-reported")).toBeVisible();
  const row = (await pool.query("select visibility, identity_status from public.place_listings where id = $1", [ids[1]])).rows[0];
  expect(row).toEqual({ visibility: "preview", identity_status: "corroborated" });
  await axe(founder);

  // The founder sees the report without the reporter's name, and resolves it.
  await founder.goto("/places/review/reports");
  const report = seen(founder, "report-row").filter({ hasText: `${NAME} 1` });
  await expect(report).toContainText("It has closed: Windows papered over");
  await report.getByLabel("Resolution").selectOption("no_change");
  await report.getByTestId("report-resolve").click();
  await expect(seen(founder, "reports-message")).toContainText("did not change");
  await axe(founder);
});

test("map and list show the same places for the same search", async ({ browser }) => {
  const founder = await person(browser, "map", "publisher");
  await founder.goto(`/places?q=${encodeURIComponent(NAME)}&view=map`);
  await expect(seen(founder, "places-map-count")).toHaveText("3 places on the map.");
  await expect(founder.getByTestId("map-canvas")).toBeVisible();
  // Pins are buttons named after the place, with no dish count.
  await expect(founder.locator("[data-testid=map-pin]")).toHaveCount(3, { timeout: 15_000 });
  const label = await founder.locator("[data-testid=map-pin]").first().getAttribute("aria-label");
  expect(label).toMatch(/menu not checked yet/);
  expect(label).not.toMatch(/dish/);
  await founder.locator("[data-testid=map-pin]").first().click();
  await expect(seen(founder, "places-map-selected")).toContainText("Menu not checked yet");
  await axe(founder);
  await seen(founder, "places-view-list").click();
  await expect(seen(founder, "place-listing")).toHaveCount(3);
});

test("a member and a guest cannot open a preview place or the reports", async ({ browser }) => {
  const member = await person(browser, "member");
  const res = await member.goto(`/places/${slugs[0]}`);
  expect(res?.status()).toBe(404);
  await member.goto("/places/review/reports");
  await expect(seen(member, "review-founder-only")).toBeVisible();
  const search = await member.request.post("/api/v1/places/search", { data: { q: NAME, mode: "map" } });
  expect((await search.json()).data.total).toBe(0);

  const guest = await (await browser.newContext()).newPage();
  open.push(guest.context());
  await guest.goto(`/places/${slugs[0]}`);
  await expect(seen(guest, "social-signin")).toBeVisible();
  await expect(guest.getByText(NAME)).toHaveCount(0);
});
