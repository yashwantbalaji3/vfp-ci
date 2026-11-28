import { test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { pool } from "../helpers/db";
import { completeSignIn } from "../e2e/helpers";

/**
 * Measures restaurant variety on the real-menu screens, as the founder sees them (owner direction 20 Nov 2026
 * 21:20 UTC; docs/64). For each diet and screen it records which restaurant each of the first meal cards comes
 * from, and the restaurants list's cuisine and area options, into SHOTS_DIR/variety.json with screenshots.
 * It asserts nothing about the result, so the same file measures the experience before and after a change.
 * Runs only where the real menus are loaded and linked; never confirms, rejects or publishes anything.
 */
test.use({ timezoneId: "America/New_York" });
test.setTimeout(600_000);
const SHOTS = process.env.SHOTS_DIR ?? "test-results/variety";
const SCREENS = ["/protein/meals", "/search?q=bowl", "/search?q=rice", "/search?q=tofu", "/search?q=curry", "/discover"];

async function places(page: Page) {
  const out: string[] = [];
  for (const card of await page.getByTestId("preview-meal").all()) {
    const meta = (await card.locator(".meta").first().textContent().catch(() => ""))?.split(" · ")[0]?.trim() ?? "";
    out.push(meta || "(none)");
    if (out.length >= 12) break;
  }
  return out;
}

test("measure restaurant variety on the real-menu screens", async ({ browser }) => {
  const links = (await pool.query("select count(*)::int n from staging.live_catalog_links")).rows[0].n;
  test.skip(links < 8, "Needs the real menus loaded and linked");
  mkdirSync(SHOTS, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: "America/New_York" });
  const page = await context.newPage();
  const email = `variety-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2F");
  await completeSignIn(page, email);
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
  await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher') on conflict do nothing", [id]);
  const result: Record<string, unknown> = {};
  for (const diet of ["none", "vegetarian", "vegan"] as const) {
    await page.goto("/diet");
    await page.locator(`input[name=diet][value=${diet}]`).check();
    await page.getByRole("button", { name: "Apply filter" }).click();
    await page.waitForLoadState("networkidle");
    for (const path of SCREENS) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const p = await places(page);
      const top4 = p.slice(0, 4);
      result[`${diet} ${path}`] = { cards: p, distinctInTop4: new Set(top4).size, distinctInTop12: new Set(p).size, mostInTop12: Math.max(0, ...[...new Set(p)].map((x) => p.filter((y) => y === x).length)) };
      await page.screenshot({ path: `${SHOTS}/${diet}-${path.replace(/[^a-z]+/g, "-")}.png`, fullPage: false });
    }
  }
  // Coverage by neighbourhood (docs/64): every meal shown ("more=all"), how many carry a protein figure or range, from how many restaurants.
  const coverage: Record<string, unknown> = {};
  for (const diet of ["none", "vegetarian", "vegan"] as const) {
    await page.goto("/diet");
    await page.locator(`input[name=diet][value=${diet}]`).check();
    await page.getByRole("button", { name: "Apply filter" }).click();
    await page.waitForLoadState("networkidle");
    for (const hood of ["", "back-bay", "fenway", "cambridge"]) {
      await page.goto(`/protein/meals?more=all${hood ? `&hood=${hood}` : ""}`);
      await page.waitForLoadState("networkidle");
      const tiles = page.getByTestId("preview-protein-tile");
      const bases = await tiles.evaluateAll((els) => els.map((e) => e.getAttribute("data-basis") ?? ""));
      const names = new Set<string>();
      for (const card of await page.getByTestId("preview-meal").all()) names.add(((await card.locator(".meta").first().textContent()) ?? "").split(" · ")[0].trim());
      coverage[`${diet} ${hood || "all"}`] = {
        meals: bases.length,
        withProtein: bases.filter((b) => b && b !== "unknown").length,
        printed: bases.filter((b) => b.startsWith("published") || b === "restaurant_estimate").length,
        usdaRange: bases.filter((b) => b === "usda_range").length,
        restaurants: names.size,
      };
      if (hood && diet === "none") await page.screenshot({ path: `${SHOTS}/hood-${hood}.png`, fullPage: false });
    }
  }
  result.coverage = coverage;
  await page.goto("/places/menus");
  await page.waitForLoadState("networkidle");
  result.restaurants = {
    cuisines: await page.getByTestId("menus-cuisine-option").allTextContents(),
    places: await page.getByTestId("menus-place").count(),
  };
  await page.screenshot({ path: `${SHOTS}/restaurants.png`, fullPage: true });
  await page.goto("/places?area=back_bay");
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${SHOTS}/directory-back-bay.png`, fullPage: false });
  writeFileSync(`${SHOTS}/variety.json`, JSON.stringify(result, null, 2));
  await context.close();
});
