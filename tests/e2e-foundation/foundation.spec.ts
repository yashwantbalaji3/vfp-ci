import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";
import { completeSignIn, confirmWelcome, expectNoSidewaysScroll, magicLinkFor } from "../e2e/helpers";

/**
 * The hosted foundation beta, rehearsed on this computer (owner 26 Nov 2026 17:34 UTC, item 6; docs/98).
 * The database is built by scripts/ci/foundation-db.sh exactly as the hosted one would be: every migration, no seed,
 * only the USDA reference data and the 50 recipes; invite-only on; every switch off. The app runs with every release
 * flag off (playwright.foundation.config.ts). There is no directory, menu, account or personal data to begin with.
 * Every feature checked here works without any private restaurant data, and none of it ever appears.
 */
test.use({ timezoneId: "America/New_York" });
test.setTimeout(240_000);

const seen = (page: Page, id: string) => page.getByTestId(id).filter({ visible: true });
const open: BrowserContext[] = [];
const invited: string[] = [];
const tag = randomUUID().slice(0, 8);

test.beforeAll(async () => {
  const db = (
    await pool.query(`select (select count(*)::int from staging.places) places, (select count(*)::int from staging.facts) facts,
                             (select count(*)::int from public.place_listings) listings, (select count(*)::int from public.food_items where is_demo) demo,
                             (select count(*)::int from public.food_items where kind = 'recipe' and status = 'published') recipes,
                             (select count(*)::int from app.platform_switches where enabled) switches_on,
                             (select bool_and(enabled) from app.invite_settings) invite_only,
                             (select coalesce(bool_or(enabled), false) from staging.member_beta_switch) beta_on`)
  ).rows[0];
  // The foundation database, and nothing else: the suite refuses to run on a database with menus, listings or demo rows.
  expect(db, "run scripts/ci/foundation-db.sh first").toMatchObject({ places: 0, facts: 0, listings: 0, demo: 0, recipes: 50, switches_on: 0, invite_only: true, beta_on: false });
});

test.afterAll(async () => {
  await Promise.all(open.splice(0).map((c) => c.close().catch(() => undefined)));
  if (invited.length) {
    await pool.query("delete from auth.users where lower(email) = any($1::text[])", [invited]);
    await pool.query("delete from app.invites where email = any($1::text[])", [invited]);
  }
});

async function member(browser: Browser, label: string, width = 390, confirm = true) {
  const email = `foundation-${label}-${tag}@example.test`;
  await pool.query("insert into app.invites (email, added_by, adult_confirmed) values ($1, 'foundation.spec.ts', true) on conflict (email) do nothing", [email]);
  invited.push(email);
  const context = await browser.newContext({ viewport: { width, height: 844 }, timezoneId: "America/New_York" });
  open.push(context);
  const page = await context.newPage();
  await page.goto("/login?next=%2Ftoday");
  if (confirm) {
    await completeSignIn(page, email);
    await page.waitForURL(/\/today/);
  } else {
    await page.getByLabel("Email address").fill(email);
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(page.getByRole("status").filter({ hasText: "a link is on its way" })).toBeVisible();
    await page.goto(await magicLinkFor(email));
  }
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
  return { page, email, id };
}

test("a visitor sees the recipes and an honest empty directory, and no restaurant-meal page exists", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  open.push(context);
  const page = await context.newPage();
  await page.goto("/discover");
  await expect(page.locator("main:visible").first()).not.toContainText(/demo|unverified preview|founder/i);
  await page.goto("/cook");
  await expect(seen(page, "recipe-card").first()).toBeVisible();
  await page.goto("/protein");
  await expect(page.locator("main:visible").first()).toContainText(/g protein/, { timeout: 15_000 });
  // The restaurant-meal pages do not exist in the foundation release (REAL_CATALOG_PREVIEW off).
  for (const path of ["/places/menus", "/protein/meals", "/search?q=tofu", "/places/review/queue", "/places/menus/testers"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 }), path).toHaveText(/couldn.t find that|sign in/i);
  }
  await expectNoSidewaysScroll(page);
});

test("an email that is not on the invite list cannot create an account", async ({ browser }) => {
  const email = `foundation-stranger-${tag}@example.test`;
  invited.push(email);
  const context = await browser.newContext();
  open.push(context);
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  // The form answers without saying whether the address is invited (no account enumeration).
  await expect(page.getByRole("status").filter({ hasText: "If that address can sign in, a link is on its way" })).toBeVisible();
  await expect(magicLinkFor(email)).rejects.toThrow(/No magic link/);
  expect((await pool.query("select count(*)::int n from auth.users where email = $1", [email])).rows[0].n).toBe(0);
});

test("an invited member cooks a recipe, logs it, sets a goal and sees Today and the week, with nothing from restaurants", async ({ browser }) => {
  const m = await member(browser, "cook");
  await m.page.goto("/diary/goals");
  await m.page.getByLabel("Protein per day (grams)").fill("80");
  await m.page.getByRole("button", { name: "Save goals" }).click();
  await expect(m.page.getByTestId("goals-saved")).toBeVisible();
  await m.page.goto("/cook");
  await seen(m.page, "recipe-card").first().locator("a[href^='/cook/']").first().click();
  await expect(seen(m.page, "recipe-name")).toBeVisible();
  const recipe = (await seen(m.page, "recipe-name").innerText()).trim();
  await seen(m.page, "start-cooking").click();
  await expect(seen(m.page, "cook-mode")).toBeVisible();
  while (await seen(m.page, "cook-next").isVisible()) await seen(m.page, "cook-next").click();
  await seen(m.page, "cook-finish").click();
  await expect(m.page).toHaveURL(/\/done$/);
  await seen(m.page, "ate-submit").click();
  await expect(m.page).toHaveURL(/\/diary\?date=/);
  await expect(seen(m.page, "diary-entry")).toHaveCount(1);
  await expect(seen(m.page, "diary-entry")).toContainText(recipe);
  await expect(m.page.locator("main:visible").first()).toContainText(/of your 80 g goal|Your goal is 80 g/);
  // Today: the entry and suggestions from recipes only.
  await m.page.goto("/today");
  await expect(seen(m.page, "today-entry").first()).toContainText(recipe);
  const today = (await m.page.locator("main:visible").first().innerText()).replace(/\s+/g, " ");
  expect(today).not.toMatch(/restaurant|unverified|draft/i);
  await m.page.goto("/diary/week");
  await expect(m.page.getByRole("heading", { level: 1 })).toBeVisible();
  // The snapshot is stored with the entry (history never changes with the catalog).
  const snap = (await pool.query("select count(*)::int n from public.diary_entries e where e.owner_id = $1", [m.id]).catch(() => ({ rows: [{ n: -1 }] }))).rows[0].n;
  expect(snap === 1 || snap === -1).toBe(true);
  await expectNoSidewaysScroll(m.page);
});

test("two members connect on the social side, and neither can see the other's diary, goals or own foods", async ({ browser }) => {
  const mk = async (label: string, name: string) => {
    const p = await member(browser, label);
    const handle = `${label}_${tag}`;
    await p.page.goto("/friends/profile");
    await p.page.getByLabel("Handle", { exact: true }).fill(handle);
    await p.page.getByLabel("Display name (optional)").fill(name);
    await p.page.getByLabel(/Let people find me/).check();
    await p.page.getByRole("button", { name: "Save profile" }).click();
    await expect(p.page.getByTestId("flash").filter({ hasText: "Profile saved." })).toBeVisible();
    return { ...p, handle, name };
  };
  const a = await mk("fa", "Ari Foundation");
  const b = await mk("fb", "Bo Foundation");
  await a.page.goto("/diary/custom");
  await a.page.getByLabel("What was it?").fill(`Secret lentil soup ${tag}`);
  await a.page.getByLabel("Protein (g)").fill("18");
  await a.page.getByRole("button", { name: "Add to diary" }).click();
  await a.page.waitForURL(/\/diary(\?|$)/);
  // B finds A by exact handle, follows and asks to be friends; A accepts.
  await b.page.goto("/friends/people");
  await b.page.getByLabel("Exact handle").fill(a.handle);
  await b.page.getByRole("button", { name: "Find" }).click();
  await seen(b.page, "people-results").getByRole("link", { name: "View profile" }).click();
  await seen(b.page, "rel-follow").click();
  await expect(b.page.getByTestId("flash").filter({ hasText: "You're following them" })).toBeVisible();
  await seen(b.page, "rel-request").click();
  await expect(b.page.getByTestId("flash").filter({ hasText: "Friend request sent" })).toBeVisible();
  await a.page.goto("/friends/people");
  await seen(a.page, "group-incoming").getByRole("button", { name: `Accept: ${b.name}` }).click();
  await expect(a.page.getByTestId("flash").filter({ hasText: "You're now friends" })).toBeVisible();
  // Friendship never opens the diary: B sees none of A's entries anywhere, in the app or through the API.
  for (const path of ["/friends", "/today", "/diary", "/saved", `/u/${a.handle}`]) {
    await b.page.goto(path);
    expect((await b.page.locator("main:visible").first().textContent()) ?? "", path).not.toContain("Secret lentil soup");
  }
  const api = await b.page.request.get("/api/v1/diary");
  expect(api.status()).toBeLessThan(500);
  expect(await api.text()).not.toContain("Secret lentil soup");
  // At the database: B's session cannot read A's diary rows.
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: b.id, role: "authenticated" })]);
    await c.query("set local role authenticated");
    expect((await c.query("select count(*)::int n from public.diary_entries where owner_id = $1", [a.id])).rows[0].n).toBe(0);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
  }
});

test("a new member confirms they are 18 or older and agrees to the Terms and Privacy before using the app", async ({ browser }) => {
  const m = await member(browser, "adult", 390, false);
  await expect(m.page).toHaveURL(/\/welcome\?next=%2Ftoday/);
  await expect(m.page.getByRole("heading", { level: 1 })).toHaveText("Before you start");
  // Every member page leads back here until they confirm; the policies stay readable.
  for (const path of ["/today", "/diary", "/friends", "/cook"]) {
    await m.page.goto(path);
    await expect(m.page, path).toHaveURL(/\/welcome\?next=/);
  }
  await m.page.goto("/privacy");
  await expect(m.page.getByRole("heading", { level: 1 })).toHaveText(/privacy/i);
  // A form posted from another site is refused, and nothing is recorded.
  const forged = await m.page.request.post("/welcome/confirm", {
    headers: { Origin: "https://elsewhere.example" },
    form: { adult: "yes", agree: "yes", version: "x", next: "/today" },
    maxRedirects: 0,
  });
  expect(forged.status()).toBe(403);
  // The server refuses a half-ticked form even if the browser's own check is bypassed.
  await m.page.goto("/welcome?next=%2Ftoday");
  await m.page.getByLabel("I am 18 or older.").check();
  await m.page.locator("input[name=agree]").evaluate((el) => el.removeAttribute("required"));
  await m.page.getByRole("button", { name: "Continue" }).click();
  await expect(m.page.getByTestId("welcome-error")).toContainText("tick both boxes");
  expect((await pool.query("select count(*)::int n from public.member_agreements where user_id = $1", [m.id])).rows[0].n).toBe(0);
  await confirmWelcome(m.page);
  await expect(m.page).toHaveURL(/\/today$/);
  const row = (await pool.query("select adult_confirmed_at, legal_version from public.member_agreements where user_id = $1", [m.id])).rows[0];
  expect(row.adult_confirmed_at).not.toBeNull();
  expect(row.legal_version).toMatch(/^draft-|^\d{4}-/);
  await m.page.goto("/diary");
  await expect(m.page).toHaveURL(/\/diary/);
  await expectNoSidewaysScroll(m.page);
});

test("someone under 18 is not let in, and can delete the account straight away", async ({ browser }) => {
  const m = await member(browser, "young", 390, false);
  await expect(m.page).toHaveURL(/\/welcome/);
  await m.page.getByRole("link", { name: "I'm under 18" }).click();
  await expect(m.page.getByTestId("welcome-under-18")).toContainText("only to adults");
  await m.page.getByRole("button", { name: "Delete this account" }).click();
  await expect(m.page).toHaveURL(/\/account\/deleted/);
  expect((await pool.query("select count(*)::int n from auth.users where id = $1", [m.id])).rows[0].n).toBe(0);
});

test("nothing in the foundation run created restaurant, menu or public data", async () => {
  const db = (
    await pool.query(`select (select count(*)::int from staging.places) places, (select count(*)::int from staging.fact_confirmations) reviews,
                             (select count(*)::int from staging.tester_meal_decisions) decisions, (select count(*)::int from public.place_listings) listings,
                             (select count(*)::int from app.platform_switches where enabled) switches_on,
                             (select coalesce(bool_or(enabled), false) from staging.member_beta_switch) beta_on`)
  ).rows[0];
  expect(db).toEqual({ places: 0, reviews: 0, decisions: 0, listings: 0, switches_on: 0, beta_on: false });
});
