import { expect, test, type Browser } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { pool } from "../helpers/db";
import { completeSignIn } from "../e2e/helpers";

/**
 * Release gate checks on real local data (owner direction 22 Nov 2026 06:25 UTC; docs/68 section 7):
 * keyboard-only use of the main meal journey, error and empty states, and how long the main pages take with the
 * whole real catalog loaded. Times go to AUDIT_DIR/page-times.json; they are local and indicative.
 * Adds only its own sign-in accounts, role rows and the one saved meal it removes again.
 */
test.use({ timezoneId: "America/New_York" });
test.setTimeout(300_000);

const OUT = process.env.AUDIT_DIR ?? "test-results/release-gate";

async function person(browser: Browser, label: string, founder: boolean, width = 1440) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: "America/New_York" });
  const page = await context.newPage();
  const email = `gate-${label}-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2Ftoday");
  await completeSignIn(page, email);
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
  if (founder) await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher') on conflict do nothing", [id]);
  return { page, context, id };
}

test("keyboard only: skip to content, open a real meal and save it", async ({ browser }) => {
  const f = await person(browser, "kbd", true);
  const page = f.page;
  await page.goto("/protein/meals");
  // The list streams in after its grey placeholder cards; count only once they are gone (see journeys-a-to-l look()).
  await expect(page.getByTestId("meal-skeleton")).toHaveCount(0, { timeout: 15_000 });
  test.skip((await page.getByTestId("preview-meal").count()) === 0, "Needs the real menus loaded");
  // The first Tab reaches the skip link, and it moves focus past the navigation.
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  // Tab until a meal link has focus, then open it with Enter.
  let onMeal = false;
  for (let i = 0; i < 60 && !onMeal; i++) {
    await page.keyboard.press("Tab");
    onMeal = await page.evaluate(() => document.activeElement?.getAttribute("href")?.startsWith("/meals/") ?? false);
  }
  expect(onMeal, "a meal link can be reached with Tab").toBe(true);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/meals\//);
  const save = page.getByTestId("meal-save").filter({ visible: true });
  let onSave = false;
  for (let i = 0; i < 80 && !onSave; i++) {
    await page.keyboard.press("Tab");
    onSave = await save.evaluate((el) => el === document.activeElement).catch(() => false);
  }
  expect(onSave, "the Save button can be reached with Tab").toBe(true);
  // A visible focus ring on the focused control.
  const outline = await save.evaluate((el) => getComputedStyle(el).outlineStyle + " " + getComputedStyle(el).boxShadow);
  expect(outline).not.toBe("none none");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("meal-save").filter({ visible: true })).toHaveAttribute("aria-pressed", "true");
  await pool.query("delete from staging.preview_saves where user_id = $1", [f.id]);
  await f.context.close();
});

test("error and empty states: unknown meal, unknown place, a search with no results, an empty diary day", async ({ browser }) => {
  // The founder: search over real menus is founder-only in the private preview (a member gets "not found").
  const m = await person(browser, "empty", true, 390);
  const page = m.page;
  // These pages stream, so the response may already be 200 when the "not found" is known; Next then renders the
  // not-found screen and tells search engines not to index it. What a person sees is what is checked here.
  for (const url of [`/meals/${randomUUID()}`, "/places/no-such-place-anywhere-123"]) {
    const res = await page.goto(url);
    expect([200, 404]).toContain(res?.status());
    await expect(page.getByRole("heading", { level: 1, name: /couldn.t find that/i })).toBeVisible();
    await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute("content", /noindex/);
  }
  await page.goto("/search?q=zzqxv-nothing-matches");
  await expect(page.locator("main:visible").first()).toContainText(/no |nothing/i);
  await page.goto("/diary?date=2020-01-01");
  await expect(page.locator("main:visible").first()).toContainText(/nothing|no meals|not logged|empty|add/i);
  await m.context.close();
});

test("page times with the real catalog loaded", async ({ browser }) => {
  const f = await person(browser, "time", true, 390);
  const routes = ["/today", "/discover", "/places", "/protein/meals", "/search?q=tofu", "/diary", "/cook", "/cook/plan", "/saved", "/friends"];
  const rows: { route: string; status: number; ms: number }[] = [];
  for (const route of routes) {
    await f.page.goto(route); // warm once
    const t = Date.now();
    const res = await f.page.goto(route, { waitUntil: "load" });
    rows.push({ route, status: res?.status() ?? 0, ms: Date.now() - t });
  }
  mkdirSync(OUT, { recursive: true });
  const listings = (await pool.query("select count(*)::int n from public.place_listings")).rows[0].n as number;
  writeFileSync(`${OUT}/page-times.json`, JSON.stringify({ at: new Date().toISOString(), width: 390, listings, rows }, null, 2));
  for (const r of rows) {
    console.log(`${r.route}: ${r.status} ${r.ms} ms`);
    expect(r.status, r.route).toBe(200);
    expect(r.ms, `${r.route} loads in under 5 s locally`).toBeLessThan(5000);
  }
  await f.context.close();
});
