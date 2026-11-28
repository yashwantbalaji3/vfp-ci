import AxeBuilder from "@axe-core/playwright";
import { test, type Browser, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { pool } from "../helpers/db";
import { completeSignIn } from "../e2e/helpers";

/**
 * Product completion audit (owner direction 21 Nov 2026 21:02 UTC, item 3). It opens every consumer screen of the
 * running app in real mode, as the founder, an ordinary member and a signed-out visitor, at phone and desktop
 * widths. For each one it records where the page ended up, its heading, console errors, accessibility violations
 * and sideways scrolling, with a full-page screenshot, into AUDIT_DIR/audit.json. It asserts nothing about the
 * result, so the same file measures the product before and after a change. It adds only its own test accounts.
 */
test.use({ timezoneId: "America/New_York" });
test.setTimeout(1_800_000);
const OUT = process.env.AUDIT_DIR ?? "test-results/product-audit";

type Row = { who: string; width: number; route: string; status: number | null; finalUrl: string; h1: string; consoleErrors: string[]; axe: string[]; sideways: boolean; textChars: number; shot: string };

async function person(browser: Browser, who: string, width: number): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height: width > 1000 ? 900 : width > 700 ? 1112 : 844 }, isMobile: width < 700, hasTouch: width < 1000, timezoneId: "America/New_York" });
  const page = await context.newPage();
  if (who === "visitor") return page;
  const email = `audit-${who}-${width}-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2Fdiscover");
  await completeSignIn(page, email);
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id;
  if (who === "founder") await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher') on conflict do nothing", [id]);
  return page;
}

test("open every consumer screen as founder, member and visitor, at phone and desktop widths", async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  const one = async (sql: string) => (await pool.query(sql)).rows[0] ?? {};
  const meal = await one("select d.id from staging.dishes d join staging.places p on p.id = d.place_id join staging.live_catalog_links k on k.staging_place = p.id where p.label = 'Thai Basil' limit 1").catch(() => ({}));
  const place = await one("select pl.slug from public.place_listings pl join staging.live_catalog_links k on k.candidate_id = pl.candidate_id where pl.name ilike 'NAYA%' limit 1");
  const plain = await one("select slug from public.place_listings where visibility = 'preview' and menu_status = 'not_checked' order by slug limit 1");
  const recipe = await one("select id from public.food_items where kind = 'recipe' and not is_demo order by id limit 1").catch(() => ({}));
  const food = await one("select id from public.food_items where kind = 'ingredient' and not is_demo order by id limit 1").catch(() => ({}));
  const routes = [
    "/today", "/discover", "/search?q=tofu", "/places", "/places/menus", `/places/${place.slug}`, `/places/${plain.slug}`,
    meal.id ? `/meals/${meal.id}` : "/meals/missing", "/protein", "/protein/meals", "/saved",
    "/diary", "/diary/add", "/diary/week", "/diary/goals", "/diary/foods", "/cook", recipe.id ? `/cook/${recipe.id}` : "/cook/missing", "/cook/plan",
    food.id ? `/foods/${food.id}` : "/foods/missing", "/friends", "/friends/people", "/friends/reviews", "/friends/ranking", "/friends/lists", "/friends/profile",
    "/account", "/diet", "/review",
  ];
  const rows: Row[] = [];
  for (const who of ["founder", "member", "visitor"]) {
    for (const width of [390, 430, 768, 1440]) {
      const page = await person(browser, who, width);
      const errors: string[] = [];
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
      for (const route of routes) {
        if (who !== "founder" && width !== 390 && !/discover|meals|places\/menus|saved|diary$|friends$/.test(route)) continue;
        errors.length = 0;
        const res = await page.goto(route, { waitUntil: "networkidle" }).catch(() => null);
        const h1 = ((await page.locator("h1").first().textContent({ timeout: 2000 }).catch(() => "")) ?? "").trim();
        const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze().then((r) => r.violations.map((v) => `${v.id}:${v.nodes.length}`)).catch((e) => [`axe-error:${String(e).slice(0, 80)}`]);
        const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        const textChars = await page.evaluate(() => document.body.innerText.length);
        const shot = `${who}-${width}-${route.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "root"}.png`;
        await page.screenshot({ path: `${OUT}/${shot}`, fullPage: true }).catch(() => undefined);
        rows.push({ who, width, route, status: res?.status() ?? null, finalUrl: new URL(page.url()).pathname + new URL(page.url()).search, h1, consoleErrors: [...errors], axe, sideways, textChars, shot });
      }
      await page.context().close();
    }
  }
  writeFileSync(`${OUT}/audit.json`, JSON.stringify(rows, null, 1));
});
