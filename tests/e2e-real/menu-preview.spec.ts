import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { pool } from "../helpers/db";
import { completeSignIn, expectNoSidewaysScroll, setDiet } from "../e2e/helpers";
import { memberBetaForThisFile } from "./beta-switch";

/**
 * The founder-only private beta on real data (docs/59), walked as one journey (owner direction 19 Nov 2026
 * 04:27 UTC, item 5; docs/60): Discover → restaurants → a restaurant → one meal → protein comparison → save,
 * list and review → back to the same meal from Saved, from the list and from My reviews; plus a build-your-own
 * meal. Runs only where the real catalog and the researched menus are loaded and linked (8 places), so it skips
 * on a freshly reset test database. It never confirms, rejects or publishes anything; the rows it adds (its own
 * accounts, a saved meal, a private list and a private review) belong to its own test accounts.
 *
 * Screenshots go to SHOTS_DIR (default test-results/menu-preview) at desktop (1440) and phone (390) sizes.
 */
test.use({ timezoneId: "America/New_York" });

// With the staged local member beta off: what a member sees by default.
memberBetaForThisFile(false);
test.setTimeout(900_000);

const SHOTS = process.env.SHOTS_DIR ?? "test-results/menu-preview";
const open: BrowserContext[] = [];
let linked: { slug: string; name: string; label: string }[] = [];

let total = 0;
test.beforeAll(async () => {
  linked = (
    await pool.query(`
      select pl.slug, pl.name, p.label
        from staging.live_catalog_links k join staging.places p on p.id = k.staging_place
        join public.place_listings pl on pl.candidate_id = k.candidate_id
       where p.label in ('NAYA', 'Next Level Veggie Grill', 'Thai Basil', 'Asmara Restaurant', 'Base Crave', 'Brown Sugar Cafe', 'India Quality Restaurant', 'Madras Dosa Co')
       order by pl.name`)
  ).rows;
  // Every linked researched place counts on the restaurants list, the 8 above and any later batch (docs/64).
  // Count only links whose catalog listing is in the preview: another real-data spec may leave a test place linked to
  // a listing it has since removed, and the app rightly doesn't show that one.
  total = (await pool.query("select count(*)::int n from staging.live_catalog_links k join public.place_listings pl on pl.candidate_id = k.candidate_id where pl.visibility = 'preview'")).rows[0].n;
  mkdirSync(SHOTS, { recursive: true });
});
test.afterAll(async () => {
  await Promise.all(open.splice(0).map((c) => c.close().catch(() => undefined)));
});

async function person(browser: Browser, label: string, role: string | null, width: number): Promise<{ page: Page; context: BrowserContext; id: string }> {
  const context = await browser.newContext({ viewport: { width, height: width > 800 ? 900 : 844 }, deviceScaleFactor: 2, timezoneId: "America/New_York", isMobile: width < 800, hasTouch: width < 800 });
  open.push(context);
  const page = await context.newPage();
  const email = `preview-${label}-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2F");
  await completeSignIn(page, email);
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
  if (role) await pool.query("insert into public.role_assignments (user_id, role) values ($1, $2) on conflict do nothing", [id, role]);
  return { page, context, id };
}
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const axe = async (page: Page) => {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
};
const check = async (page: Page) => {
  await expectNoSidewaysScroll(page);
  await axe(page);
};
const lowsOf = async (page: Page, scope = "body") =>
  page.locator(`${scope} [data-testid=preview-protein-tile]`).evaluateAll((els) => els.map((e) => (e.getAttribute("data-low") ? Number(e.getAttribute("data-low")) : null)));
const flash = (page: Page) => page.getByTestId("flash");

for (const width of [1440, 390]) {
  const size = width > 800 ? "desktop" : "phone";
  test(`founder journey on real data (${size})`, async ({ browser }) => {
    test.skip(linked.length < 8, "Needs the real catalog and the 8 researched menus loaded and linked");
    const { page, context, id } = await person(browser, `founder-${size}`, "publisher", width);
    const naya = linked.find((l) => l.label === "NAYA")!;
    const nlvg = linked.find((l) => l.label === "Next Level Veggie Grill")!;

    // 1. Discover leads with real meals (six, one per restaurant where possible; docs/84 redesign), under the
    // "Unverified preview" label.
    await page.goto("/discover");
    const real = page.getByTestId("real-menus");
    await expect(real.getByTestId("unverified-banner")).toContainText("Unverified preview");
    await expect(real.getByTestId("preview-meal")).toHaveCount(6);
    await check(page);
    await shot(page, `${size}-01-discover`);
    // With a vegan diet chosen, Discover shows only meals the restaurant calls vegan.
    await setDiet(context, "vegan");
    await page.goto("/discover");
    await expect(page.getByTestId("real-menus")).toContainText("Vegan meals in the Boston area");
    for (const d of await page.getByTestId("real-menus").getByTestId("preview-diet").all()) await expect(d).toHaveAttribute("data-diet", "vegan_stated");
    for (const m of await page.getByTestId("real-menus").getByTestId("preview-meal").all()) await expect(m).toHaveAttribute("data-fit", "eligible");
    await setDiet(context, "none");

    // 1b. One search across real meals and restaurants, with stated and not-stated diets kept apart.
    await page.goto("/discover?q=falafel");
    await expect(page.getByTestId("real-search")).toContainText("Unverified preview");
    await page.getByTestId("real-search-all").click();
    await expect(page).toHaveURL(/\/search\?q=falafel/);
    // No diet saved on this account: the diet tabs are a temporary filter, counted by the shared diet check (docs/63).
    const count = async (d: string) => Number(await page.getByTestId("search-diet").getByTestId(`preview-diet-${d}`).locator(".count").textContent());
    const [all, vegan, vegetarian] = [await count("any"), await count("vegan"), await count("vegetarian")];
    expect(all).toBeGreaterThan(0);
    expect(vegetarian).toBeGreaterThanOrEqual(vegan);
    expect(vegetarian).toBeLessThanOrEqual(all);
    await expect(page.getByTestId("search-meals").getByTestId("preview-meal")).toHaveCount(all);
    // NAYA's build-your-own meals offer falafel, so they are found too, with their diet left to the pick.
    await expect(page.getByTestId("search-builder").filter({ hasText: "Includes: Falafel" }).first()).toBeVisible();
    await check(page);
    await shot(page, `${size}-15-search`);
    await page.getByTestId("search-diet").getByTestId("preview-diet-vegan").click();
    await expect(page).toHaveURL(/diet=vegan/);
    await expect(page.getByTestId("search-meals").getByTestId("preview-meal")).toHaveCount(vegan);
    for (const d of await page.getByTestId("search-meals").getByTestId("preview-diet").all()) await expect(d).toHaveAttribute("data-diet", "vegan_stated");
    // Meals whose diet isn't stated are in their own labelled view, never under vegan.
    await page.getByTestId("fit-view-check").click();
    await expect(page).toHaveURL(/fit=check/);
    await expect(page.getByTestId("fit-check-note")).toContainText("Not matches");
    for (const d of await page.getByTestId("search-meals").getByTestId("preview-meal").all()) await expect(d).toHaveAttribute("data-fit", "needs_confirmation");
    await page.goto(`/search?q=${encodeURIComponent(naya.name)}`);
    await expect(page.getByTestId("search-place").filter({ hasText: naya.name })).toHaveCount(1);
    await page.goto("/search?q=zzzz-nothing");
    await expect(page.getByTestId("search-none")).toContainText("No meal matches");

    // 2. Restaurants with menus: list, diet and cuisine chips, map.
    await page.goto("/discover");
    await page.getByTestId("real-menus-places").click();
    await expect(page).toHaveURL(/\/places\/menus$/);
    await expect(page.getByTestId("menus-count")).toHaveText(`${total} restaurants`);
    await expect(page.getByTestId("menus-place").first().getByTestId("menus-stats")).toBeVisible();
    await check(page);
    await shot(page, `${size}-02-restaurants`);
    await page.getByTestId("preview-diet-vegan").click();
    await expect(page).toHaveURL(/diet=vegan/);
    const veganPlaces = Number((await page.getByTestId("menus-count").textContent())?.split(" ")[0]);
    expect(veganPlaces).toBeGreaterThan(0);
    expect(veganPlaces).toBeLessThan(total);
    await page.getByTestId("menus-view-map").click();
    await expect(page.getByTestId("menus-map-count")).toHaveText(`${veganPlaces} ${veganPlaces === 1 ? "restaurant" : "restaurants"} on the map.`);
    await page.waitForTimeout(1500);
    await shot(page, `${size}-03-restaurants-map-vegan`);
    await page.goto("/places/menus");
    await page.getByTestId("menus-cuisine-option").first().click();
    await expect(page).toHaveURL(/cuisine=/);
    expect(Number((await page.getByTestId("menus-count").textContent())?.split(" ")[0])).toBeLessThan(total);

    // 3. A restaurant page: NAYA keeps its meat meals out of discovery and offers its build-your-own meals.
    await page.goto("/places/menus");
    await page.getByTestId("menus-place").filter({ hasText: naya.name }).first().getByRole("link", { name: naya.name }).click();
    await expect(page).toHaveURL(new RegExp(`/places/${naya.slug}`));
    await expect(page.getByTestId("menu-status")).toHaveText("Menu: unverified preview");
    const leftOut = page.getByTestId("preview-left-out");
    await expect(leftOut).toContainText("3 meals left out of discovery");
    await leftOut.locator("summary").click();
    for (const name of ["Chicken Tahini Caesar Roll", "Classic Braised Beef Bowl", "Classic Chicken Bowl"])
      await expect(leftOut.getByTestId("preview-left-out-meal").filter({ hasText: name })).toHaveCount(1);
    const shownNames = await page.getByTestId("place-menu-preview").locator("ul.cards > [data-testid=preview-meal]").getByTestId("preview-meal-name").allTextContents();
    expect(shownNames.some((n) => /chicken|beef/i.test(n))).toBe(false);
    await expect(page.getByTestId("builder-card")).toHaveCount(2);
    await check(page);
    await shot(page, `${size}-04-restaurant-naya`);

    // 4. Next Level Veggie Grill, vegan: highest protein first; open the top meal.
    await page.goto(`/places/${nlvg.slug}?diet=vegan`);
    const lows = (await lowsOf(page, "[data-testid=place-menu-preview] ul.cards")).filter((x): x is number => x !== null);
    expect(lows.length).toBeGreaterThan(5);
    expect([...lows].sort((a, b) => b - a)).toEqual(lows);
    await shot(page, `${size}-05-restaurant-nlvg-vegan`);
    const top = page.getByTestId("place-menu-preview").locator("ul.cards > [data-testid=preview-meal]").first();
    const mealName = (await top.getByTestId("preview-meal-name").textContent())!.trim();
    const dishId = (await top.getAttribute("data-dish"))!;
    await top.getByTestId("preview-meal-name").getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/meals/${dishId}`));

    // 5. The meal page: protein, price and diet up top; evidence folded; labels honest.
    await expect(page.getByTestId("meal-name")).toHaveText(mealName);
    await expect(page.getByTestId("meal-hero").getByTestId("preview-protein-basis")).toHaveText("Printed");
    await expect(page.getByTestId("meal-hero").getByTestId("preview-diet")).toHaveAttribute("data-diet", "vegan_stated");
    await expect(page.getByTestId("meal-hero").getByTestId("preview-unconfirmed")).toHaveText("Draft, not confirmed by you");
    await expect(page.getByTestId("meal-protein-detail")).toContainText("Printed by the restaurant");
    await page.getByTestId("meal-checks").locator("summary").click();
    await expect(page.getByTestId("preview-machine")).toContainText("Automatic check, not by you");
    await page.getByTestId("meal-source").locator("summary").click();
    await expect(page.getByTestId("meal-source")).toContainText("own menu page");
    await expect(page.getByTestId("meal-back")).toContainText(nlvg.name);
    await check(page);
    await shot(page, `${size}-06-meal`);

    // 6. Compare: from the meal to the comparison, add two more, then per 100 kcal.
    await page.getByTestId("meal-compare-link").click();
    await expect(page).toHaveURL(new RegExp(`/protein/meals\\?compare=${dishId}`));
    await expect(page.getByTestId("meal-compare-bar")).toHaveCount(1);
    await page.goto(`/protein/meals?compare=${dishId}&diet=vegan&min=20`);
    let added = 0;
    for (const card of await page.locator("ul.cards > [data-testid=preview-meal]").all()) {
      if ((await card.getAttribute("data-dish")) === dishId) continue;
      await card.getByTestId("meal-compare-toggle").click();
      await expect(page.getByTestId("meal-compare-bar")).toHaveCount(2 + added);
      if (++added === 2) break;
    }
    await expect(page.getByTestId("meal-compare")).toContainText("Comparing 3 of up to 3 meals");
    await check(page);
    await shot(page, `${size}-07-compare`);
    await page.getByTestId("meal-compare").getByRole("link", { name: "Per 100 kcal" }).click();
    await expect(page).toHaveURL(/basis=100kcal/);
    await expect(page.getByTestId("meal-compare")).toContainText("Protein per 100 kcal");
    // Back to the same meal from the comparison.
    await page.getByTestId("meal-compare").getByRole("link", { name: mealName }).click();
    await expect(page.getByTestId("meal-name")).toHaveText(mealName);
    await expect(page.getByTestId("meal-back")).toContainText("Meals");

    // 7. Save it, put it on a new private list, and review it (privately).
    await page.goto(`/meals/${dishId}`);
    await page.getByTestId("meal-save").click();
    await expect(flash(page)).toHaveText("Meal saved to your private preview. Only you can see it.");
    await expect(page.getByTestId("meal-save")).toHaveText(/Saved/);
    const listTitle = `Journey ${size} ${randomUUID().slice(0, 6)}`;
    await page.getByTestId("meal-lists").locator("summary").click();
    await page.getByLabel(/start (a new|your first) list/i).fill(listTitle);
    await page.getByRole("button", { name: "Create list and add this" }).click();
    await expect(flash(page)).toContainText("Meal added to your list");
    await expect(page.getByTestId("meal-lists").locator("summary")).toHaveText(/On 1 of your lists/);
    await page.getByTestId("meal-review").locator("summary").click();
    await page.getByTestId("meal-review").getByText("Very good").click();
    await page.getByLabel("Notes for yourself (optional)").fill("Big portion, good value.");
    await page.getByRole("button", { name: "Save review" }).click();
    await expect(flash(page)).toContainText("Your review is saved. It is private");
    await expect(page.getByTestId("meal-review").locator("summary")).toHaveText(/Your rating: 4 of 5/);
    await check(page);
    await shot(page, `${size}-08-meal-saved-listed-reviewed`);

    // 8. Revisit it from Saved.
    await page.goto("/saved");
    const savedMeals = page.getByTestId("saved-meals");
    await expect(savedMeals.getByTestId("preview-meal-name")).toHaveText([mealName]);
    await check(page);
    await shot(page, `${size}-09-saved`);
    await savedMeals.getByRole("link", { name: mealName }).click();
    await expect(page.getByTestId("meal-name")).toHaveText(mealName);
    await expect(page.getByTestId("meal-back")).toContainText("Saved");
    await page.getByTestId("meal-back").click();
    await expect(page).toHaveURL(/\/saved$/);

    // 9. Revisit it from the list.
    const listId = (await pool.query("select id from public.food_lists where owner_id = $1 and title = $2", [id, listTitle])).rows[0].id as string;
    await page.goto(`/friends/lists/${listId}`);
    const listMeals = page.getByTestId("list-meals");
    await expect(listMeals).toContainText("Only you see these entries");
    await expect(listMeals.getByTestId("list-meal")).toHaveCount(1);
    await check(page);
    await shot(page, `${size}-10-list`);
    await listMeals.getByRole("link", { name: mealName }).click();
    await expect(page.getByTestId("meal-name")).toHaveText(mealName);
    await expect(page.getByTestId("meal-back")).toHaveAttribute("href", `/friends/lists/${listId}`);

    // 10. Revisit it from My reviews.
    await page.goto("/friends/reviews");
    await expect(page.getByTestId("meal-reviews").getByTestId("meal-review-row")).toContainText("4 of 5");
    await shot(page, `${size}-11-my-reviews`);
    await page.getByTestId("meal-reviews").getByRole("link", { name: mealName }).click();
    await expect(page.getByTestId("meal-name")).toHaveText(mealName);

    // 11. A build-your-own meal: the total is added up from NAYA's own per-item figures, and labelled so.
    await page.goto(`/places/${naya.slug}`);
    await page.getByTestId("builder-card").first().getByRole("link").click();
    const builder = page.getByTestId("meal-builder");
    await expect(builder.getByTestId("builder-total")).toHaveAttribute("data-known", "no");
    await builder.getByTestId("builder-base").getByTestId("builder-option").first().locator("input").check();
    await builder.getByTestId("builder-protein").getByTestId("builder-option").filter({ hasText: "Falafel" }).first().locator("input").check();
    await builder.getByTestId("builder-topping_sauce").getByTestId("builder-option").nth(0).locator("input").check();
    await builder.getByTestId("builder-topping_sauce").getByTestId("builder-option").nth(1).locator("input").check();
    await builder.getByTestId("builder-submit").click();
    await expect(page).toHaveURL(/base=.*protein=/);
    await expect(builder.getByTestId("builder-total")).toHaveAttribute("data-known", "yes");
    await expect(builder.getByTestId("builder-words")).toContainText("Added up from the restaurant's own per-item figures");
    await expect(builder.getByTestId("builder-total")).toHaveAttribute("data-kind", "meal_total");
    await expect(builder.getByTestId("builder-total-kind")).toContainText("Calculated meal total");
    await expect(builder.getByTestId("builder-total")).toContainText("Added up by us, not printed by the restaurant");
    await builder.getByTestId("builder-breakdown").locator("summary").click();
    await expect(builder.getByTestId("builder-breakdown")).toContainText("we never scale a figure to another portion");
    await check(page);
    await shot(page, `${size}-12-build-your-own`);

    // 11b. The roll: exactly one bread is required, and only figures printed for the roll's own portions are added.
    await page.goto(`/places/${naya.slug}`);
    await page.getByTestId("builder-card").filter({ hasText: "roll" }).getByRole("link").click();
    const roll = page.getByTestId("meal-builder");
    await expect(roll.getByTestId("builder-wrap").getByTestId("builder-option")).toHaveCount(2);
    await expect(roll.getByTestId("builder-base")).toContainText("Pick one, or none");
    await roll.getByTestId("builder-protein").getByTestId("builder-option").filter({ hasText: "Falafel" }).first().locator("input").check();
    await roll.getByTestId("builder-submit").click();
    // Without bread the roll isn't a whole meal: the figure is a subtotal of what is picked, never a meal total.
    await expect(roll.getByTestId("builder-total")).toHaveAttribute("data-kind", "subtotal");
    await expect(roll.getByTestId("builder-total-kind")).toContainText("Selected-items subtotal");
    await expect(roll.getByTestId("builder-missing")).toContainText("pick a bread");
    await roll.getByTestId("builder-wrap").getByTestId("builder-option").first().locator("input").check();
    await roll.getByTestId("builder-submit").click();
    await expect(page).toHaveURL(/wrap=/);
    await expect(roll.getByTestId("builder-total")).toHaveAttribute("data-kind", "meal_total");
    await expect(roll.getByTestId("builder-missing")).toHaveCount(0);
    await check(page);
    await shot(page, `${size}-16-build-a-roll`);

    // 12. The meal list keeps the diet rules: unknown never under vegetarian or vegan; protein sorted.
    await page.goto("/protein/meals");
    // Every complete meal except those left out for naming meat (100 and 3 for the first 8 restaurants; more with later batches).
    const banner = (await page.locator("main").textContent()) ?? "";
    const [, complete, left] = banner.match(/(\d+) complete meals from \d+ real Boston-area restaurants\. (\d+) meals? (?:is|are) left out/) ?? [];
    expect(Number(complete)).toBeGreaterThanOrEqual(100);
    expect(Number((await page.getByTestId("meal-count").textContent())?.split(" ")[0])).toBe(Number(complete) - Number(left));
    const bases = new Set(await page.getByTestId("preview-protein-tile").evaluateAll((els) => els.map((e) => e.getAttribute("data-basis"))));
    for (const b of ["published", "published_range", "restaurant_estimate", "usda_range", "unknown"]) expect(bases.has(b), b).toBe(true);
    await check(page);
    await shot(page, `${size}-13-meals-all`);
    for (const [filter, allowed] of [
      ["vegan", ["vegan_stated"]],
      ["vegetarian", ["vegan_stated", "vegetarian_stated"]],
    ] as const) {
      await page.goto(`/protein/meals?diet=${filter}`);
      const diets = await page.getByTestId("preview-diet").evaluateAll((els) => els.map((e) => e.getAttribute("data-diet")));
      expect(diets.length).toBeGreaterThan(0);
      expect(diets.every((d) => (allowed as readonly string[]).includes(d!))).toBe(true);
    }
    const vegLows = await lowsOf(page, "ul.cards");
    const known = vegLows.filter((x): x is number => x !== null);
    expect([...known].sort((a, b) => b - a)).toEqual(known);
    expect(vegLows.slice(vegLows.indexOf(null) === -1 ? vegLows.length : vegLows.indexOf(null)).every((x) => x === null)).toBe(true);
    // A USDA estimate explains itself on its meal page and is never "verified".
    await page.goto("/protein/meals");
    await page.locator("[data-testid=preview-meal]:has([data-basis=usda_range]) [data-testid=preview-meal-name] a").first().click();
    await expect(page.getByTestId("meal-hero").getByTestId("preview-protein-basis")).toHaveText("USDA estimate");
    await expect(page.getByTestId("preview-usda")).toContainText("not verified");
    await expect(page.getByTestId("preview-usda")).toContainText(/confidence/);
    await expect(page.getByText(/verified nutrition/i)).toHaveCount(0);
    await shot(page, `${size}-14-meal-usda`);

    // Clean up the founder test account's own rows; nothing was confirmed or published.
    await page.goto(`/meals/${dishId}`);
    await page.getByTestId("meal-save").click();
    await expect(flash(page)).toHaveText("Meal removed from your saved meals.");
    expect((await pool.query("select count(*)::int n from staging.preview_saves where user_id = $1", [id])).rows[0].n).toBe(0);
    expect((await pool.query("select count(*)::int n from staging.fact_confirmations where confirmed_by = $1", [id])).rows[0].n).toBe(0);
    expect((await pool.query("select count(*)::int n from public.place_listings where visibility = 'public'")).rows[0].n).toBe(0);
  });
}

test("ordinary accounts, friends and visitors see nothing of the real menus", async ({ browser }) => {
  test.skip(linked.length < 8, "Needs the real catalog and the 8 researched menus loaded and linked");
  const dish = (
    await pool.query(`select d.id from staging.dishes d join staging.places p on p.id = d.place_id where p.label = 'Next Level Veggie Grill' and app.preview_meal_ok(d.id) limit 1`)
  ).rows[0].id as string;
  const { page } = await person(browser, "member", null, 390);
  for (const path of [`/places/${linked[0].slug}`, `/meals/${dish}`]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 }), path).toHaveText("We couldn’t find that");
    await expect(page.getByTestId("preview-meal")).toHaveCount(0);
  }
  // The meal lists say meals are not open to this account yet, and show none.
  for (const path of ["/protein/meals", "/places/menus", "/search?q=falafel"]) {
    await page.goto(path);
    await expect(page.getByTestId("meals-not-open").filter({ visible: true }), path).toContainText("not open to your account yet");
    await expect(page.getByTestId("preview-meal")).toHaveCount(0);
  }
  await page.goto("/discover");
  await expect(page.getByTestId("real-menus")).toHaveCount(0);
  await page.goto("/discover?q=falafel");
  await expect(page.getByTestId("real-search")).toHaveCount(0);
  await page.goto("/protein");
  await expect(page.getByTestId("protein-real-meals")).toHaveCount(0);
  await page.goto("/saved");
  await expect(page.getByTestId("saved-meals")).toHaveCount(0);

  const visitor = await browser.newContext();
  open.push(visitor);
  const v = await visitor.newPage();
  await v.goto("/protein/meals");
  await expect(v.getByText("Restaurant meals are in a small private test for now")).toBeVisible();
  await v.goto(`/meals/${dish}`);
  await expect(v.getByTestId("social-signin")).toBeVisible();
  await v.goto("/search?q=falafel");
  await expect(v.getByText("Restaurant meals are in a small private test for now")).toBeVisible();
  await expect(v.getByTestId("preview-meal")).toHaveCount(0);
  await expect(v.getByTestId("preview-meal")).toHaveCount(0);
  await v.goto("/discover");
  await expect(v.getByTestId("real-menus")).toHaveCount(0);
});
