import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { pool } from "../helpers/db";
import { completeSignIn, expectNoSidewaysScroll } from "../e2e/helpers";
import { memberBetaForThisFile } from "./beta-switch";

/**
 * Trustworthy end-to-end food discovery (owner direction 20 Nov 2026 03:27 UTC; docs/63), walked in isolated
 * synthetic accounts on the real drafted menus:
 *   A. The saved diet applies everywhere: vegan + "vegetable fried rice" (through the search box and a typed
 *      address), egg-free vegetarian, the "Needs confirmation" view, explicit broadening, meal pages, saved meals
 *      that no longer fit, and the diary's protein-to-go ideas.
 *   B. "Log this meal" keeps the restaurant's figure and its source through a reload; a retry adds nothing; a
 *      USDA range never fills in a number; a changed figure says it was changed.
 *   C. NAYA build-your-own: a subtotal until the meal is complete, then a calculated meal total, and the diet
 *      check on every chosen part.
 *   D. Privacy: a member and a visitor see none of it.
 *   E. Every page at 1440, 768, 390 and 430 px: no sideways scroll, no axe violations, 44 px targets on the
 *      diet controls. Screenshots go to SHOTS_DIR.
 * Runs only where the 8 real menus are loaded and linked; it skips on a freshly reset test database. It never
 * confirms, rejects or publishes anything.
 */
test.use({ timezoneId: "America/New_York" });

// With the staged local member beta off: what a member sees by default.
memberBetaForThisFile(false);
test.setTimeout(900_000);
const SHOTS = process.env.SHOTS_DIR ?? "test-results/trust-discovery";
const WIDTHS = [1440, 768, 390, 430];
const open: BrowserContext[] = [];
let ready = false;
const ids: Record<string, string> = {};

test.beforeAll(async () => {
  const r = await pool.query(`
    select d.label, p.label place, d.id from staging.dishes d join staging.places p on p.id = d.place_id
     where (p.label, d.label) in (('Brown Sugar Cafe', 'Vegetable Fried Rice'), ('Brown Sugar Cafe', 'Vegetable Pad Thai'),
                                  ('Next Level Veggie Grill', 'Steak Asada Burrito'), ('India Quality Restaurant', 'Saag Paneer'),
                                  ('NAYA', 'Build your own roll'), ('NAYA', 'Build your own bowl or salad'))`);
  for (const row of r.rows) ids[row.label] = row.id;
  const links = (await pool.query("select count(*)::int n from staging.live_catalog_links")).rows[0].n;
  ready = links >= 8 && Object.keys(ids).length === 6;
  mkdirSync(SHOTS, { recursive: true });
});
test.afterAll(async () => {
  await Promise.all(open.splice(0).map((c) => c.close().catch(() => undefined)));
});

async function person(browser: Browser, label: string, width: number, founder = true) {
  const context = await browser.newContext({ viewport: { width, height: width > 800 ? 900 : 844 }, deviceScaleFactor: 2, timezoneId: "America/New_York", isMobile: width < 800, hasTouch: width < 800 });
  open.push(context);
  const page = await context.newPage();
  const email = `trust-${label}-${width}-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2F");
  await completeSignIn(page, email);
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
  if (founder) await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher') on conflict do nothing", [id]);
  return { page, context, id };
}
const check = async (page: Page) => {
  await expectNoSidewaysScroll(page);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  // The diet controls are touch targets of at least 44 px.
  for (const a of await page.locator(".diet-scope .seg a").all()) expect((await a.boundingBox())!.height).toBeGreaterThanOrEqual(44);
};
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
async function saveDiet(page: Page, diet: "none" | "vegetarian" | "vegan", exclusions: string[] = []) {
  await page.goto("/diet");
  await page.locator(`input[name=diet][value=${diet}]`).check();
  for (const box of await page.locator("input[name=exclusions]").all()) await box.setChecked(exclusions.includes((await box.getAttribute("value"))!));
  await page.getByRole("button", { name: "Apply filter" }).click();
  await page.waitForLoadState("networkidle");
}
const meals = (page: Page) => page.getByTestId("search-meals").getByTestId("preview-meal");
const tag = (w: number) => (w === 1440 ? "desktop" : w === 768 ? "tablet" : `phone${w}`);

for (const width of WIDTHS) {
  test(`A. the saved diet applies everywhere (${tag(width)})`, async ({ browser }) => {
    test.skip(!ready, "Needs the real menus loaded and linked");
    const { page } = await person(browser, "diet", width);
    const fried = ids["Vegetable Fried Rice"];

    // A meal saved before choosing a diet stays saved, and later says it doesn't fit.
    await page.goto(`/meals/${fried}`);
    await page.getByTestId("meal-save").click();
    await expect(page.getByTestId("flash")).toBeVisible();

    await saveDiet(page, "vegan");
    // Through the search box.
    await page.goto("/search");
    await page.getByTestId("search-q").fill("vegetable fried rice");
    await page.getByTestId("search-q").press("Enter");
    await expect(page).toHaveURL(/q=vegetable/);
    await expect(page.getByTestId("diet-scope")).toHaveAttribute("data-view", "mine");
    await expect(page.getByTestId("diet-scope-name")).toHaveText("Vegan");
    await expect(meals(page).filter({ hasText: "Vegetable Fried Rice" })).toHaveCount(0);
    for (const m of await meals(page).all()) await expect(m).toHaveAttribute("data-fit", "eligible");
    await check(page);
    await shot(page, `${tag(width)}-A1-vegan-search`);
    // A typed or shared address can't widen it.
    await page.goto("/search?q=vegetable+fried+rice&diet=any");
    await expect(meals(page).filter({ hasText: "Vegetable Fried Rice" })).toHaveCount(0);
    // Broadening is an explicit action, and the page says so.
    await page.getByTestId("fit-view-all").click();
    await expect(page).toHaveURL(/fit=all/);
    await expect(page.getByTestId("fit-all-note")).toContainText("including ones that don’t fit vegan");
    const card = meals(page).filter({ hasText: "Vegetable Fried Rice" });
    await expect(card).toHaveAttribute("data-fit", "ineligible");
    await expect(card.getByTestId("meal-fit")).toHaveText("Doesn't fit: lists egg");
    await check(page);
    await shot(page, `${tag(width)}-A2-vegan-broadened`);

    // A direct link stays reachable and discloses the conflict, keeping the restaurant's words apart from ours.
    await page.goto(`/meals/${fried}`);
    const panel = page.getByTestId("fit-panel");
    await expect(panel).toHaveAttribute("data-status", "ineligible");
    await expect(panel.getByTestId("fit-reasons")).toContainText("The restaurant says it isn't vegan");
    await expect(panel.getByTestId("fit-reasons")).toContainText("It lists “egg”");
    await expect(panel.getByTestId("fit-stated")).toContainText("vegan: no, vegetarian: yes");
    await expect(panel.getByTestId("fit-reading")).toContainText("“egg” is egg");
    await expect(panel.getByTestId("fit-allergens")).toContainText("not an allergy guarantee");
    await check(page);
    await shot(page, `${tag(width)}-A3-direct-link`);

    // Saved meals that no longer match stay, marked.
    await page.goto("/saved");
    await expect(page.getByTestId("saved-meal-mismatch")).toContainText("1 saved meal doesn't clearly fit your diet");
    await expect(page.getByTestId("saved-meals").getByTestId("preview-meal").filter({ hasText: "Vegetable Fried Rice" })).toHaveAttribute("data-fit", "ineligible");

    // Discover, restaurants, Protein Explorer and a restaurant page all use the same check.
    await page.goto("/discover");
    for (const m of await page.getByTestId("real-menus").getByTestId("preview-meal").all()) await expect(m).toHaveAttribute("data-fit", "eligible");
    await page.goto("/protein/meals");
    await expect(page.getByTestId("diet-scope")).toBeVisible();
    for (const m of await page.getByTestId("preview-meal").all()) await expect(m).toHaveAttribute("data-fit", "eligible");
    await check(page);
    await shot(page, `${tag(width)}-A4-protein-vegan`);
    await page.goto("/protein/meals?fit=check");
    await expect(page.getByTestId("fit-check-note")).toContainText("Not matches");
    for (const m of (await page.getByTestId("preview-meal").all()).slice(0, 10)) await expect(m).toHaveAttribute("data-fit", "needs_confirmation");
    await shot(page, `${tag(width)}-A5-needs-confirmation`);

    // Egg-free vegetarian: the stated-vegetarian egg dishes don't fit; the Pad Thai shows only when broadened.
    await saveDiet(page, "vegetarian", ["egg"]);
    await page.goto("/search?q=pad+thai");
    await expect(page.getByTestId("diet-scope-name")).toHaveText("Egg-free vegetarian");
    await expect(meals(page).filter({ hasText: "Vegetable Pad Thai" })).toHaveCount(0);
    await page.goto("/search?q=pad+thai&fit=all");
    await expect(meals(page).filter({ hasText: "Vegetable Pad Thai" }).getByTestId("meal-fit")).toHaveText("Doesn't fit: lists egg");
    await page.goto("/places/menus");
    await expect(page.getByTestId("diet-scope")).toBeVisible();
    await check(page);
    await shot(page, `${tag(width)}-A6-restaurants-egg-free`);

    // The diary's protein-to-go ideas fit the diet too.
    await page.goto("/diary/goals");
    await page.getByLabel("Protein per day (grams)").fill("90");
    await page.getByRole("button", { name: "Save goals" }).click();
    await expect(page.getByTestId("goals-saved")).toBeVisible();
    await page.goto("/diary");
    const ideas = await page.getByTestId("togo-meal").locator("a").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!));
    expect(ideas.length).toBeGreaterThan(0);
    for (const href of ideas) {
      await page.goto(href);
      await expect(page.getByTestId("fit-panel")).toHaveAttribute("data-status", "eligible");
    }
  });
}

for (const width of WIDTHS) {
  test(`B. a logged real meal keeps its source (${tag(width)})`, async ({ browser }) => {
    test.skip(!ready, "Needs the real menus loaded and linked");
    const { page, id } = await person(browser, "diary", width);
    await page.goto("/diary/goals");
    await page.getByLabel("Protein per day (grams)").fill("90");
    await page.getByRole("button", { name: "Save goals" }).click();
    await expect(page.getByTestId("goals-saved")).toBeVisible();

    const burrito = ids["Steak Asada Burrito"];
    await page.goto(`/meals/${burrito}`);
    await page.getByTestId("meal-log").click();
    await expect(page).toHaveURL(/\/diary\/custom\?.*meal=/);
    await expect(page.getByLabel("Protein (g)")).toHaveValue("44");
    await expect(page.getByLabel("What was it?")).toHaveJSProperty("readOnly", true);
    await expect(page.getByTestId("custom-prefill-note")).toContainText("Unverified preview");
    await check(page);
    await shot(page, `${tag(width)}-B1-log-form`);
    await page.getByRole("button", { name: "Add to diary" }).click();
    await page.waitForURL(/\/diary(\?|$)/);
    await page.reload();
    const row = page.getByTestId("diary-entry").filter({ hasText: "Steak Asada Burrito" });
    await expect(row).toHaveCount(1);
    const src = row.getByTestId("entry-source");
    await expect(src).toHaveAttribute("data-evidence", "restaurant_published");
    await expect(src).toHaveAttribute("data-changed", "no");
    await expect(src.locator("summary")).toHaveText(/Protein printed by .*Veggie Grill · Unverified draft/);
    await src.locator("summary").click();
    await expect(src).toContainText("44 g protein for one serving, printed by the restaurant");
    await expect(src).toContainText("from the menu as read on");
    await expect(page.getByTestId("protein-to-go")).toContainText("46 g protein to go today");
    await check(page);
    await shot(page, `${tag(width)}-B2-diary-source`);

    // Open a suggestion, come back: still one entry. Opening "Log this meal" again says it is already logged.
    await page.getByTestId("togo-meal").first().locator("a").click();
    await page.goto("/diary");
    await expect(page.getByTestId("diary-entry").filter({ hasText: "Steak Asada Burrito" })).toHaveCount(1);
    await page.goto(`/diary/custom?meal=${burrito}`);
    await expect(page.getByTestId("custom-already-logged")).toContainText("once");
    // A retried submit of the same form (same key) adds nothing.
    const key = await page.locator("input[name=idempotencyKey]").inputValue();
    await page.getByRole("button", { name: "Add to diary" }).click();
    await page.waitForURL(/\/diary(\?|$)/);
    await page.goto(`/diary/custom?meal=${burrito}`);
    await page.waitForLoadState("networkidle");
    // Typing re-renders the form, which puts back its own key, so the old key goes in last, just before the submit.
    await page.getByLabel("Protein (g)").fill("40");
    await page.evaluate((k) => {
      (document.querySelector("input[name=idempotencyKey]") as HTMLInputElement).value = k;
    }, key);
    await expect(page.locator("input[name=idempotencyKey]")).toHaveValue(key);
    await page.getByRole("button", { name: "Add to diary" }).click();
    await page.waitForURL(/\/diary(\?|$)/);
    expect((await pool.query("select count(*)::int n from public.diary_entries where owner_id = $1 and deleted_at is null", [id])).rows[0].n).toBe(2);

    // A changed figure is the person's own and says so.
    await page.goto(`/diary/custom?meal=${burrito}`);
    await page.getByLabel("Protein (g)").fill("40");
    await page.getByRole("button", { name: "Add to diary" }).click();
    await page.waitForURL(/\/diary(\?|$)/);
    await page.goto("/diary");
    const changed = page.getByTestId("entry-source").and(page.locator("[data-changed=yes]"));
    await expect(changed).toHaveCount(1);
    await expect(changed.locator("summary")).toHaveText(/Protein entered by you/);

    // A USDA range never fills in a number, and the entry says protein isn't known.
    await page.goto(`/diary/custom?meal=${ids["Saag Paneer"]}`);
    await expect(page.getByLabel("Protein (g)")).toHaveValue("");
    await expect(page.getByTestId("custom-prefill-note")).toContainText("empty");
    await page.getByRole("button", { name: "Add to diary" }).click();
    await page.waitForURL(/\/diary(\?|$)/);
    await page.goto("/diary");
    const saag = page.getByTestId("diary-entry").filter({ hasText: "Saag Paneer" });
    await expect(saag).toContainText("Protein not known");
    await expect(saag.getByTestId("entry-source")).toHaveAttribute("data-evidence", "usda_estimate");
    await check(page);
    await shot(page, `${tag(width)}-B3-diary-mixed`);
  });
}

for (const width of WIDTHS) {
  test(`C. NAYA build-your-own wording and diet (${tag(width)})`, async ({ browser }) => {
    test.skip(!ready, "Needs the real menus loaded and linked");
    const { page } = await person(browser, "naya", width);
    const roll = ids["Build your own roll"];
    await page.goto(`/meals/${roll}`);
    const b = page.getByTestId("meal-builder");
    await expect(b.getByTestId("builder-total")).toHaveAttribute("data-kind", "none");
    await b.getByTestId("builder-protein").getByTestId("builder-option").filter({ hasText: "Falafel" }).first().locator("input").check();
    await b.getByTestId("builder-submit").click();
    await expect(b.getByTestId("builder-total")).toHaveAttribute("data-kind", "subtotal");
    await expect(b.getByTestId("builder-total-kind")).toContainText("Selected-items subtotal");
    await expect(b.getByTestId("builder-total-kind")).toContainText("Added up by us, not printed by the restaurant");
    await expect(b.getByTestId("builder-missing")).toContainText("pick a bread");
    await expect(b.getByTestId("builder-total")).not.toContainText("Calculated meal total");
    await check(page);
    await shot(page, `${tag(width)}-C1-roll-without-bread`);
    await b.getByTestId("builder-wrap").getByTestId("builder-option").first().locator("input").check();
    await b.getByTestId("builder-submit").click();
    await expect(b.getByTestId("builder-total")).toHaveAttribute("data-kind", "meal_total");
    await expect(b.getByTestId("builder-total-kind")).toContainText("Calculated meal total");
    await b.getByTestId("builder-breakdown").locator("summary").click();
    await expect(b.getByTestId("builder-breakdown")).toContainText("we never scale a figure to another portion");
    await shot(page, `${tag(width)}-C2-roll-with-bread`);

    // The bowl: a protein alone is a subtotal; with a base it is a whole meal.
    await page.goto(`/meals/${ids["Build your own bowl or salad"]}`);
    await b.getByTestId("builder-protein").getByTestId("builder-option").filter({ hasText: "Falafel" }).first().locator("input").check();
    await b.getByTestId("builder-submit").click();
    await expect(b.getByTestId("builder-total")).toHaveAttribute("data-kind", "subtotal");
    await expect(b.getByTestId("builder-missing")).toContainText("a base");
    await b.getByTestId("builder-base").getByTestId("builder-option").first().locator("input").check();
    await b.getByTestId("builder-submit").click();
    await expect(b.getByTestId("builder-total")).toHaveAttribute("data-kind", /meal_total|unknown/);

    // With a vegan diet saved, a dairy part is marked and the combination says which part doesn't fit.
    const bowlUrl = new URL(page.url());
    await saveDiet(page, "vegan");
    const feta = await pool.query(
      `select d.id from staging.dishes d join staging.dish_structure s on s.dish_id = d.id where s.parent_dish_id = $1 and d.label ilike '%feta%' limit 1`,
      [ids["Build your own bowl or salad"]],
    );
    if (feta.rows[0]) {
      const url = bowlUrl;
      url.searchParams.append("top", feta.rows[0].id);
      await page.goto(url.pathname + url.search);
      await expect(b.getByTestId("builder-total").getByTestId("meal-fit")).toHaveAttribute("data-status", "ineligible");
      await expect(b.getByTestId("builder-fit-reasons")).toContainText("Feta");
      await check(page);
      await shot(page, `${tag(width)}-C3-bowl-vegan-feta`);
    }
  });
}

test("D. a member and a visitor see none of the real menus, sources or diaries", async ({ browser }) => {
  test.skip(!ready, "Needs the real menus loaded and linked");
  const member = await person(browser, "member", 390, false);
  await member.page.goto(`/meals/${ids["Vegetable Fried Rice"]}`);
  await expect(member.page.getByRole("heading", { level: 1 })).toHaveText("We couldn’t find that");
  await expect(member.page.getByTestId("preview-meal")).toHaveCount(0);
  // The meal lists say meals are not open to this account yet, and show none.
  for (const path of ["/search?q=rice", "/protein/meals", "/places/menus"]) {
    await member.page.goto(path);
    await expect(member.page.getByTestId("meals-not-open").filter({ visible: true }), path).toContainText("not open to your account yet");
    await expect(member.page.getByTestId("preview-meal")).toHaveCount(0);
  }
  await member.page.goto(`/diary/custom?meal=${ids["Steak Asada Burrito"]}`);
  await expect(member.page.getByLabel("What was it?")).toHaveValue("");
  await expect(member.page.getByTestId("custom-prefill-note")).toHaveCount(0);
  await expect(member.page.locator("input[name=mealId]")).toHaveCount(0);
  // Nobody reads another person's meal sources.
  const others = await pool.query("select count(*)::int n from public.custom_food_attributions where owner_id = $1", [member.id]);
  expect(others.rows[0].n).toBe(0);
  const feed = await member.page.request.get("/api/v1/feed");
  expect(await feed.text()).not.toMatch(/Steak Asada|Vegetable Fried Rice|Unverified preview/);
  const visitor = await browser.newContext();
  open.push(visitor);
  const v = await visitor.newPage();
  await v.goto("/search?q=rice");
  await expect(v.getByText("Restaurant meals are in a small private test for now")).toBeVisible();
  const vfeed = await v.request.get("/api/v1/feed");
  expect(await vfeed.text()).not.toMatch(/Steak Asada|Vegetable Fried Rice/);
});
