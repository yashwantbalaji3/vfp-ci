import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";
import { completeSignIn, expectNoSidewaysScroll } from "../e2e/helpers";

/**
 * Private preview of the whole real catalog (activation readiness item 3, Yash 17 Nov 05:44 UTC).
 * Runs only when the real Boston import is loaded (at least 1,000 preview listings), so it skips on a
 * freshly reset test database. It reads and never changes a listing, report or decision: the only rows
 * it adds are its own sign-in accounts and role assignments.
 *
 * With the six-city import (24 Nov 2026) the preview holds about 150,000 one-source listings. Every cross-checked
 * listing still gets its page opened; the one-source listings are checked on a spread sample, and list/map paging
 * is compared in full wherever a query returns at most 5,000 places (the directory's paging limit).
 */
test.use({ timezoneId: "America/New_York" });
test.setTimeout(900_000);

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const open: BrowserContext[] = [];
type L = { slug: string; name: string; street: string | null; area: string | null; lat: number; lon: number; identity_status: string; market_slug: string };
let listings: L[] = []; // cross-checked preview listings (every page is opened)
let boston: L[] = []; // every preview listing in the Boston market, as the founder's directory lists it
let single: L[] = []; // a spread sample of one-source listings across all markets

test.beforeAll(async () => {
  const cols = "slug, name, street, area, lat::float, lon::float, identity_status, market_slug";
  listings = (await pool.query(`select ${cols} from public.place_listings where visibility = 'preview' and identity_status <> 'single_source' order by slug`)).rows;
  boston = (await pool.query(`select ${cols} from public.place_listings where visibility = 'preview' and market_slug = 'boston' order by slug`)).rows;
  single = (await pool.query(`select ${cols} from (select ${cols}, row_number() over (order by slug) n from public.place_listings
                                where visibility = 'preview' and identity_status = 'single_source') x where n % 997 = 1 order by slug`)).rows;
});
test.afterAll(async () => {
  await Promise.all(open.splice(0).map((c) => c.close().catch(() => undefined)));
});

async function person(browser: Browser, label: string, role?: string, width = 390): Promise<{ page: Page; id: string }> {
  const context = await browser.newContext({ viewport: { width, height: 800 }, timezoneId: "America/New_York" });
  open.push(context);
  const page = await context.newPage();
  const email = `catalog-${label}-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2F");
  await completeSignIn(page, email);
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
  if (role) await pool.query("insert into public.role_assignments (user_id, role) values ($1, $2) on conflict do nothing", [id, role]);
  return { page, id };
}

/** Calls place_directory as `uid`, the way the Data API does, in a transaction that is rolled back. */
async function directory(uid: string, p: J): Promise<J> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    return (await c.query("select public.place_directory($1::jsonb) d", [JSON.stringify(p)])).rows[0].d;
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
  }
}
async function listAll(uid: string, p: J) {
  const slugs: string[] = [];
  let offset: number | null = 0;
  let total = 0;
  while (offset !== null && offset <= 4950) {
    const d = await directory(uid, { ...p, preview: true, limit: 50, offset });
    total = d.total;
    slugs.push(...d.items.map((x: J) => x.slug));
    offset = d.nextOffset ?? null;
  }
  return { total, slugs };
}

test("the whole preview: list and map agree for every area, search, map rectangle and near-me", async ({ browser }) => {
  test.skip(listings.length < 1000, "The real Boston import is not loaded in this database");
  const { id } = await person(browser, "founder-data", "publisher");

  const all = await listAll(id, {});
  expect(all.total).toBe(boston.length);
  if (boston.length <= 5000) expect(new Set(all.slugs).size).toBe(boston.length); // every place exactly once across pages
  else expect(new Set(all.slugs).size).toBe(all.slugs.length); // no place twice in the first 5,000

  const areas = [...new Set(listings.map((l) => l.area).filter(Boolean))] as string[];
  const queries: J[] = [{}, ...areas.map((area) => ({ area })), { q: "pizza" }, { q: "cafe" }, { q: "thai" }, { q: "st" }, { q: "Massachusetts Ave" }];
  for (const l of listings.filter((_, i) => i % 97 === 0)) {
    queries.push({ lat: l.lat, lon: l.lon, radiusM: 1000 } as J, { lat: l.lat, lon: l.lon, radiusM: 3000 } as J);
  }
  for (const area of areas) {
    const inArea = boston.filter((l) => l.area === area);
    const lats = inArea.map((l) => l.lat);
    const lons = inArea.map((l) => l.lon);
    const box = { west: Math.min(...lons) - 0.001, east: Math.max(...lons) + 0.001, south: Math.min(...lats) - 0.001, north: Math.max(...lats) + 0.001 };
    if (box.east - box.west <= 2 && box.north - box.south <= 2) queries.push(box);
  }
  const report: string[] = [];
  for (const p of queries) {
    const list = await listAll(id, p);
    const map = await directory(id, { ...p, preview: true, mode: "map" });
    const label = JSON.stringify(p);
    expect(map.total, label).toBe(list.total);
    const pins = map.items.map((x: J) => x.slug);
    if (list.total <= 500) expect(new Set(pins), label).toEqual(new Set(list.slugs));
    else if (list.total <= 5000) expect(pins.every((s: string) => list.slugs.includes(s)), label).toBe(true);
    if ("area" in p) expect(list.total, label).toBe(boston.filter((l) => l.area === p.area).length);
    report.push(`${label}: ${list.total}`);
  }
  test.info().annotations.push({ type: "queries", description: `${queries.length} checked` });
  await test.info().attach("list-map-counts.txt", { body: report.join("\n"), contentType: "text/plain" });
});

test("every one of the preview places has a working private page, and none is visible to others", async ({ browser }) => {
  test.skip(listings.length < 1000, "The real Boston import is not loaded in this database");
  const { page: founder } = await person(browser, "founder-pages", "publisher");
  const { page: memberPage } = await person(browser, "member");
  const guest = await (async () => {
    const context = await browser.newContext();
    open.push(context);
    return context.request;
  })();

  const failures: string[] = [];
  const queue = [...listings];
  const worker = async () => {
    for (let l = queue.shift(); l; l = queue.shift()) {
      const r = await founder.request.get(`/places/${l.slug}`, { maxRedirects: 0 });
      const body = r.status() === 200 ? await r.text() : "";
      const name = l.name.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
      if (r.status() !== 200 || !body.includes(name)) failures.push(`${l.slug} ${r.status()}`);
      // "Identity checked by us" only where the founder's own decision verified the identity (identity_status 'verified').
      else if (/Identity checked by us/.test(body) !== (l.identity_status === "verified")) failures.push(`${l.slug} ${l.identity_status === "verified" ? "does not say" : "says"} "Identity checked by us"`);
      // A place with a researched menu says so as an unverified preview (docs/59); every other place says its menu is not checked.
      else if (!/Menu not checked yet|not checked what it serves|have not checked|Menu: unverified preview/i.test(body)) failures.push(`${l.slug} has no "menu not checked" wording`);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  expect(failures, failures.slice(0, 20).join("\n")).toEqual([]);

  for (const l of listings.filter((_, i) => i % 41 === 0)) {
    // A signed-out visitor gets the preview's sign-in prompt, which names no place (src/proxy.ts).
    const g = await guest.get(`/places/${l.slug}`, { maxRedirects: 0 });
    const gb = await g.text();
    expect(gb, `guest ${l.slug}`).toContain("Sign in to continue");
    expect(gb, `guest ${l.slug}`).not.toContain(l.street ?? "\u0000");
    expect(gb, `guest ${l.slug}`).not.toContain(`"name":"${l.name}"`);
    expect((await memberPage.request.get(`/places/${l.slug}`, { maxRedirects: 0 })).status(), `member ${l.slug}`).toBe(404);
  }
});

test("one-source listings in every market: a private page that says so, and nothing for anyone else", async ({ browser }) => {
  test.skip(single.length < 20, "The six-city import is not loaded in this database");
  const { page: founder } = await person(browser, "founder-single", "publisher");
  const { page: memberPage } = await person(browser, "member-single");
  const guest = await (async () => {
    const context = await browser.newContext();
    open.push(context);
    return context.request;
  })();
  const failures: string[] = [];
  for (const l of single) {
    const r = await founder.request.get(`/places/${l.slug}`, { maxRedirects: 0 });
    const body = r.status() === 200 ? await r.text() : "";
    if (r.status() !== 200) failures.push(`${l.slug} ${r.status()}`);
    else if (!body.includes("One source, not cross-checked") || !body.includes('data-testid="identity-single-source"')) failures.push(`${l.slug} does not say it is one source`);
    else if (/Identity checked by us/.test(body)) failures.push(`${l.slug} says "Identity checked by us"`);
    if ((await memberPage.request.get(`/places/${l.slug}`, { maxRedirects: 0 })).status() !== 404) failures.push(`member sees ${l.slug}`);
    if (!(await (await guest.get(`/places/${l.slug}`, { maxRedirects: 0 })).text()).includes("Sign in to continue")) failures.push(`guest ${l.slug}`);
  }
  expect(failures, failures.slice(0, 20).join("\n")).toEqual([]);
  test.info().annotations.push({ type: "sample", description: `${single.length} one-source pages in ${new Set(single.map((l) => l.market_slug)).size} markets` });
});

for (const width of [320, 375, 390]) {
  test(`at ${width} px the list, map and place pages fit the screen and pass the accessibility checks`, async ({ browser }) => {
    test.skip(listings.length < 1000, "The real Boston import is not loaded in this database");
    const { page } = await person(browser, `founder-${width}`, "publisher", width);
    const pages = ["/places", "/places?view=map", `/places?area=${encodeURIComponent(listings.find((l) => l.area)!.area!)}`, "/places?q=pizza",
      ...listings.filter((_, i) => i % 211 === 0).map((l) => `/places/${l.slug}`)];
    for (const path of pages) {
      await page.goto(path);
      await expect(page.locator("main")).toBeVisible();
      await expectNoSidewaysScroll(page);
      const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(r.violations.map((v) => `${path}: ${v.id}`)).toEqual([]);
    }
    // The report form is on every place page and needs no extra step to reach.
    await page.goto(`/places/${listings[0].slug}`);
    await expect(page.getByTestId("place-report")).toContainText("Report a problem");
    await page.getByText("Something is wrong with this listing").click();
    await expect(page.getByTestId("report-send")).toBeVisible();
    await expectNoSidewaysScroll(page);
  });
}
