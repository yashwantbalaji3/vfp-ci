import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";
import { completeSignIn } from "../e2e/helpers";

/**
 * Demo-to-real rehearsal (docs/37), owner 17 Nov 05:44 UTC: "Ensure demo restaurants and dishes are hidden
 * from the real consumer experience … but retain synthetic fixtures for automated testing." With demo
 * content off, no invented place, dish, recipe or member may appear on any page a visitor uses, while
 * every demo row stays in the database.
 */
test.use({ timezoneId: "America/New_York", viewport: { width: 390, height: 844 } });
test.setTimeout(240_000);

type Demo = { venues: string[]; foods: string[]; members: string[]; counts: Record<string, number> };
async function demo(): Promise<Demo> {
  const venues = (await pool.query("select name from public.venues where is_demo")).rows.map((r) => r.name as string);
  const foods = (await pool.query(
    `select distinct r.name from public.food_items fi join public.food_revisions r on r.food_item_id = fi.id
      where fi.is_demo and r.name ~ ' '`)).rows.map((r) => r.name as string);
  const members = (await pool.query("select coalesce(display_name, handle) n from public.profiles_public where app.is_demo_member(user_id)")).rows.map((r) => r.n as string);
  const counts = (await pool.query(
    `select (select count(*)::int from public.venues where is_demo) venues,
            (select count(*)::int from public.food_items where is_demo) foods,
            (select count(*)::int from public.sources where is_demo) sources`)).rows[0];
  return { venues, foods, members, counts };
}

const PAGES = [
  "/discover", "/discover?q=tofu", "/discover?q=bowl", "/protein", "/cook", "/cook?q=lentil",
  "/diary/add?q=tofu", "/friends", "/friends/people", "/friends/reviews", "/friends/ranking", "/saved", "/places",
];

async function visibleText(page: Page) {
  await page.waitForLoadState("networkidle");
  return page.evaluate(() => document.body.innerText);
}

test("no demo place, dish, recipe or member appears anywhere a member looks, and every demo row is kept", async ({ browser }) => {
  const before = await demo();
  expect(before.counts.venues).toBeGreaterThan(0);
  expect(before.foods.length).toBeGreaterThan(0);

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/login?next=%2F");
  await completeSignIn(page, `nodemo-${randomUUID().slice(0, 8)}@example.test`);

  const seen: string[] = [];
  for (const url of PAGES) {
    await page.goto(url);
    const text = await visibleText(page);
    expect(text, `${url} says it shows demo data`).not.toMatch(/Demo data/);
    for (const name of [...before.venues, ...before.foods, ...before.members]) if (text.includes(name)) seen.push(`${url}: ${name}`);
  }
  expect(seen).toEqual([]);

  // Their own pages are gone too.
  const v = (await pool.query("select id from public.venues where is_demo limit 1")).rows[0].id;
  const f = (await pool.query("select id from public.food_items where is_demo and kind = 'dish' limit 1")).rows[0]?.id;
  expect((await page.goto(`/venues/${v}`))?.status()).toBe(404);
  if (f) expect((await page.goto(`/dishes/${f}`))?.status()).toBe(404);
  const handle = (await pool.query("select handle from public.profiles_public where app.is_demo_member(user_id) and handle is not null limit 1")).rows[0]?.handle;
  if (handle) expect((await page.goto(`/u/${handle}`))?.status()).toBe(404);
  await context.close();

  // Hidden, never deleted.
  expect((await demo()).counts).toEqual(before.counts);
});
