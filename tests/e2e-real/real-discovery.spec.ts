import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { deleteTestListings, pool } from "../helpers/db";
import { FOOD, VENUE, completeSignIn, expectNoSidewaysScroll } from "../e2e/helpers";
import { memberBetaForThisFile } from "./beta-switch";

/**
 * Demo-to-real rehearsal (docs/37). The server runs with REAL_DISCOVERY on and demo content off
 * (playwright.real.config.ts). Two invented listings are added and removed at the end; demo rows
 * are only counted, never changed.
 */
test.use({ timezoneId: "America/New_York", viewport: { width: 360, height: 740 } });

// With the staged local member beta off: what a member sees by default.
memberBetaForThisFile(false);
test.setTimeout(180_000);

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
// "Aaa" sorts these first in a directory without a position.
const NAME = `Aaa real e2e Plover ${tag}`;
const SRC = JSON.stringify([{ key: "overture_places", title: "Test dataset", attribution: "Test attribution e2e", release: "r-e2e" }]);
const open: BrowserContext[] = [];
const ids: string[] = [];
let demoBefore: { venues: number; foods: number };

const demoCounts = async () =>
  (await pool.query("select (select count(*)::int from public.venues where is_demo) venues, (select count(*)::int from public.food_items where is_demo) foods")).rows[0];

test.beforeAll(async () => {
  demoBefore = await demoCounts();
  for (const i of [0, 1]) {
    ids.push((await pool.query(
      `insert into public.place_listings (candidate_id, slug, name, street, locality, postcode, area, lat, lon, category, identity_status, sources, built_from)
       values (gen_random_uuid(), $1, $2, $3, 'Boston', '02118', 'South End', 42.3412, -71.0731, 'Café', 'corroborated', $4, 'e2e') returning id`,
      [`real-e2e-${tag}-${i}`, `${NAME} ${i}`, `${10 + i} Sample Row`, SRC])).rows[0].id);
  }
});
test.afterAll(async () => {
  await Promise.all(open.splice(0).map((c) => c.close().catch(() => undefined)));
  await deleteTestListings("l.id = any($1::uuid[])", [ids]);
});

async function person(browser: Browser, label: string, role?: string, width = 360): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height: 740 }, timezoneId: "America/New_York" });
  open.push(context);
  const page = await context.newPage();
  const email = `real-${label}-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2F");
  await completeSignIn(page, email);
  if (role) {
    const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
    await pool.query("insert into public.role_assignments (user_id, role) values ($1, $2) on conflict do nothing", [id, role]);
  }
  return page;
}
const seen = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });

test("the founder's Discover leads with real places; no demo place, dish or banner is shown", async ({ browser }) => {
  const founder = await person(browser, "founder", "publisher");
  await founder.goto("/discover");
  await expect(seen(founder, "real-first")).toContainText("restaurants and cafés");
  await expect(seen(founder, "real-first-areas")).toContainText("South End");
  // One privacy note, not three (bug B4, docs/68).
  await expect(seen(founder, "real-banner")).toContainText("Only you can see these real places");
  await expect(founder.getByText(/(nothing here|none of them) is public/i).filter({ visible: true })).toHaveCount(1);
  await expect(founder.getByText("Demo data", { exact: false })).toHaveCount(0);
  // With no checked dishes, the dish list and its "0 dishes" panel are left out under the real places (docs/62).
  await expect(founder.getByTestId("results-heading")).toHaveCount(0);
  await expect(founder.getByText("No dishes are checked yet.")).toHaveCount(0);
  // A button inside a callout keeps its own colours (the link colour once made this one green on green).
  const choose = seen(founder, "diet-welcome-choose");
  const [fg, bg] = await choose.evaluate((e) => [getComputedStyle(e).color, getComputedStyle(e).backgroundColor]);
  expect(fg).not.toBe(bg);
  const r = await new AxeBuilder({ page: founder }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.help} [${v.nodes.map((n) => n.target.join(" ")).join(", ")}]`)).toEqual([]);
  await expectNoSidewaysScroll(founder);

  await seen(founder, "real-first-areas").getByRole("link", { name: /^South End/ }).click();
  await expect(founder).toHaveURL(/area=South%20End/);
  await expect(seen(founder, "place-listing").filter({ hasText: `${NAME} 0` })).toBeVisible();
  await expect(seen(founder, "menu-status").first()).toHaveText("Menu not checked yet");
  await founder.goto("/discover");
  await seen(founder, "real-first-map").click();
  await expect(seen(founder, "places-map-count")).toBeVisible();

  // Demo pages are gone (a real 404), but the demo rows are still in the database.
  expect((await founder.goto(`/venues/${VENUE.central}`))?.status()).toBe(404);
  expect((await founder.goto(`/dishes/${FOOD.bowl}`))?.status()).toBe(404);
  expect(await demoCounts()).toEqual(demoBefore);
  expect(demoBefore.venues).toBeGreaterThan(0);
});

test("a member and a guest see that no real place is listed yet, and no demo content", async ({ browser }) => {
  const member = await person(browser, "member", undefined, 320);
  await member.goto("/discover");
  await expect(seen(member, "real-first-none")).toContainText("none is listed yet");
  await expect(member.getByText(NAME)).toHaveCount(0);
  await expect(member.getByText("Demo data", { exact: false })).toHaveCount(0);
  // Bug B1 (docs/68): a member was told "Real places, private to you" while seeing none.
  for (const path of ["/discover", "/places", "/protein/meals", "/search?q=tofu"]) {
    await member.goto(path);
    await expect(member.getByTestId("real-banner")).toHaveCount(0);
    await expect(member.getByText(/private to you|only you can see these real/i)).toHaveCount(0);
  }
  // Restaurant-meal pages say meals are not open to this account yet, with what works now, not "not found".
  for (const path of ["/places/menus", "/protein/meals", "/search?q=tofu"]) {
    await member.goto(path);
    await expect(seen(member, "meals-not-open"), path).toContainText("Restaurant meals are not open to your account yet");
    await expect(seen(member, "meals-not-open").getByRole("link", { name: "Find high-protein recipes" })).toBeVisible();
    await expect(member.getByRole("heading", { name: /couldn.t find that/i })).toHaveCount(0);
  }
  await member.goto("/discover");
  await expectNoSidewaysScroll(member);

  const guest = await (await browser.newContext()).newPage();
  open.push(guest.context());
  await guest.goto("/discover");
  await expect(seen(guest, "real-first-none")).toContainText("none is listed yet");
  // A first visit says what this is and what works without an account; no founder wording.
  await expect(seen(guest, "visitor-welcome")).toContainText("No account needed");
  await expect(guest.getByText(/founder/i)).toHaveCount(0);
  await expect(guest.getByText(NAME)).toHaveCount(0);
});
