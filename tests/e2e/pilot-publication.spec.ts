import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";
import { completeSignIn, expectNoSidewaysScroll } from "./helpers";

/**
 * Pilot publication in a real browser (docs/29): a researcher's verified staged facts become a DRAFT
 * place and dish in the founder's editor desk; the founder can read them with their sources, and the
 * approval is refused in plain words because the real-data lock is off. Nobody else sees anything.
 *
 * The lock is never turned on here (it is a setting for the whole local database). Approval with the
 * lock on is covered by the database tests, inside rolled-back transactions.
 *
 * Staged records are permanent by design; this file removes its own invented test records at the end
 * with triggers paused for that one clean-up transaction, so other test files see the database as before.
 */
test.use({ timezoneId: "America/New_York", viewport: { width: 360, height: 740 } });
test.setTimeout(180_000);

const tag = randomUUID().slice(0, 6);
const HOST = `pilot-${tag}.example.test`;
const PLACE = `Pilot e2e Kitchen ${tag}`;
const DISH = `Pilot e2e lentil bowl ${tag}`;
const open: BrowserContext[] = [];
const made: { staged?: string; venue?: string; food?: string; changes: string[]; sources: string[] } = { changes: [], sources: [] };

test.afterAll(async () => {
  await Promise.all(open.splice(0).map((c) => c.close().catch(() => undefined)));
  const c = await pool.connect();
  try {
    await c.query("begin");
    // Staging records are permanent: their guards are paused for this clean-up only. They go first,
    // because publication_changes points at catalog_changes. Foreign-key cascades do not fire in
    // this mode, so nothing public is deleted here.
    await c.query("set local session_replication_role = replica");
    if (made.staged) {
      await c.query("delete from staging.publication_changes where publication_id in (select id from staging.publications where place_id = $1)", [made.staged]);
      await c.query("delete from staging.publications where place_id = $1", [made.staged]);
      await c.query("delete from staging.events where place_id = $1", [made.staged]);
      const pages = (await c.query("select distinct source_page_id from staging.facts where place_id = $1", [made.staged])).rows.map((r) => r.source_page_id);
      await c.query("delete from staging.facts where place_id = $1", [made.staged]);
      await c.query("delete from staging.dishes where place_id = $1", [made.staged]);
      await c.query("delete from staging.places where id = $1", [made.staged]);
      await c.query("delete from staging.source_pages where id = any($1::uuid[])", [pages]);
    }
    await c.query("delete from staging.source_access where host = $1", [HOST]);
    // Public rows with their normal guards and cascades (revisions, nutrition, claims, dishes, history).
    await c.query("set local session_replication_role = origin");
    if (made.food) await c.query("delete from public.food_items where id = $1", [made.food]);
    if (made.venue) await c.query("delete from public.venues where id = $1", [made.venue]);
    await c.query("delete from public.catalog_changes where id = any($1::uuid[])", [made.changes]);
    const recs = (await c.query("select source_id from public.source_records where id = any($1::uuid[])", [made.sources])).rows.map((r) => r.source_id);
    await c.query("delete from public.source_records where id = any($1::uuid[])", [made.sources]);
    await c.query("delete from public.sources where id = any($1::uuid[])", [recs]);
    await c.query("commit");
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
});

async function person(browser: Browser, label: string, role: string) {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: "America/New_York" });
  open.push(context);
  const page = await context.newPage();
  const email = `pilot-${label}-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2F");
  await completeSignIn(page, email);
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
  await pool.query("insert into public.role_assignments (user_id, role) values ($1, $2) on conflict do nothing", [id, role]);
  return { page, id };
}

async function stageAndPrepare(researcher: string, founder: string) {
  const one = async (sql: string, p: unknown[]) => (await pool.query(`select ${sql} as r`, p)).rows[0].r;
  const place = await one("staging.add_place($1, $2, 'harvard_square', 1::smallint)", [researcher, `${PLACE} (Harvard Square)`]);
  made.staged = place;
  const dish = await one("staging.add_dish($1, $2, $3)", [researcher, place, DISH]);
  // Only cleared sources may be verified and published (docs/46): this invented host gets a permit,
  // removed again in the clean-up.
  await pool.query(`insert into staging.source_access (host, kind, status, evidence, permitted_uses, reviewer)
                    values ($1, 'written_permission', 'permits', 'Invented test host', 'tests only', 'Test fixture')`, [HOST]);
  const page = await one("staging.add_source_page($1, $2, 'restaurant_site', 'Pilot e2e Kitchen', now(), 'Facts only')", [researcher, `https://${HOST}/menu`]);
  const day = (await pool.query("select (now() at time zone 'America/New_York')::date::text d")).rows[0].d;
  const facts = [
    { kind: "address", value: { street: "9 Test Row", postcode: "02138" } },
    { kind: "operating_status", value: { status: "operating" } },
    { kind: "weekly_hours", value: { periods: [{ days: "Mon-Sun", open: "08:00", close: "21:00" }] } },
    { dishId: dish, kind: "menu_item", value: { listed: true } },
    { dishId: dish, kind: "dietary_status", subject: "vegan", value: { claim: "vegan", status: "yes" } },
    { dishId: dish, kind: "published_nutrition", value: { nutrient: "protein_g", amount: "27", per: "serving" } },
    { dishId: dish, kind: "allergen_statement", value: { statement: "may_contain", allergens: ["tree_nuts", "sesame"] } },
  ];
  for (const f of facts) {
    const id = await one("staging.submit_fact($1, $2::jsonb)", [researcher, JSON.stringify({ placeId: place, sourcePageId: page, checkedOn: day, ...f })]);
    await one("staging.review_fact($1, $2, 'verify')", [founder, id]);
  }
  const pub = await one("staging.prepare_publication($1, $2)", [researcher, place]);
  made.venue = pub.venueId;
  made.changes = pub.changes.map((c: { changeId: string }) => c.changeId);
  made.sources = pub.changes.flatMap((c: { records: string[] }) => c.records);
  made.food = pub.changes.find((c: { kind: string }) => c.kind === "dish").foodItemId;
  return pub;
}

async function expectAccessible(page: Page) {
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`), `accessibility problems on ${page.url()}`).toEqual([]);
}

test("the founder sees the prepared place and dish with their sources, and approval waits behind the real-data lock", async ({ browser }) => {
  const researcher = await person(browser, "researcher", "curator");
  const founder = await person(browser, "founder", "publisher");
  const pub = await stageAndPrepare(researcher.id, founder.id);
  const venueChange = pub.changes.find((c: { kind: string }) => c.kind === "venue").changeId;
  const dishChange = pub.changes.find((c: { kind: string }) => c.kind === "dish").changeId;

  // The founder's desk lists both changes for a second person to check.
  await founder.page.goto("/editor");
  const desk = founder.page.getByTestId("desk-to-check").filter({ visible: true });
  await expect(desk).toContainText(DISH);
  await founder.page.goto(`/editor/changes/${dishChange}`);
  await expect(founder.page.getByTestId("change-source").filter({ visible: true })).toContainText("Pilot e2e Kitchen");
  const compare = founder.page.getByTestId("change-compare").filter({ visible: true });
  await expect(compare).toContainText("Suitable"); // vegan, from a verified restaurant statement
  await expect(compare).toContainText("27 (published)");
  await expect(compare).toContainText("Allergens: may contain (cross-contact)");
  await expect(compare).toContainText("sesame, tree nuts");
  await expectAccessible(founder.page);
  await expectNoSidewaysScroll(founder.page);

  // Approval is refused in plain words, the place stays a draft, and nothing is public.
  await founder.page.goto(`/editor/changes/${venueChange}`);
  const form = founder.page.getByTestId("review-form").filter({ visible: true });
  await form.getByLabel(/I looked at the source myself/).check();
  await form.getByLabel(/Nothing here is copied/).check();
  await form.getByRole("button", { name: "Approve and publish" }).click();
  await expect(founder.page.getByTestId("flash-error").filter({ hasText: "Publishing real restaurants is switched off" })).toBeVisible();
  expect((await pool.query("select status from public.venues where id = $1", [pub.venueId])).rows[0].status).toBe("draft");
  expect((await pool.query("select state from public.catalog_changes where id = $1", [venueChange])).rows[0].state).toBe("submitted");

  // A visitor finds neither the place nor the dish, and the dish page is not there.
  const visitor = await browser.newContext({ viewport: { width: 360, height: 740 } });
  open.push(visitor);
  const v = await visitor.newPage();
  await v.goto(`/discover?q=${encodeURIComponent(DISH)}`);
  await expect(v.locator("main")).not.toContainText(DISH);
  const res = await v.goto(`/foods/${made.food}`);
  expect(res?.status()).toBe(404);
});
