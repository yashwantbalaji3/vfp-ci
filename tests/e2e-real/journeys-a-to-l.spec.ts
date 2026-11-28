import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { pool } from "../helpers/db";
import { completeSignIn, expectNoSidewaysScroll } from "../e2e/helpers";
import { memberBetaForThisFile, READY_FOR_REVIEW, removeTestSourceReviews, sourceReviewForTest } from "./beta-switch";

/**
 * The owner's twelve consumer journeys, A to L (master directive 24 Nov 2026 03:27 UTC, M2), each walked by ORDINARY
 * disposable @example.test accounts on the real local data, in the configuration an invited test would use: the member
 * beta on, in the reviewed-meals mode, showing only a first set of meals that a test founder includes by the docs/80
 * rule (every check passes, at most 15 per restaurant, printed protein first). The switch and the set exist only in
 * this test database for this file; every decision and private row the file writes is removed at the end.
 *
 * Besides passing or failing, each journey records its time and AUDIT FINDINGS: developer wording or broken values on
 * screen, console errors, sideways scrolling, and screens that leave the user without a way on. Findings do not fail
 * a journey; they go to the audit file (JOURNEY_AUDIT_OUT, default test-results/journey-audit.json) for the report.
 * This is automated evidence, not a test by independent people.
 */
test.use({ timezoneId: "America/New_York" });
memberBetaForThisFile(true, "reviewed_meals");
test.setTimeout(300_000);

type Result = { journey: string; title: string; width: number; completed: boolean; seconds: number; findings: string[]; error?: string };
const results: Result[] = [];
const included: string[] = [];
let founderId = "";
let recipeId = "";

const DEV_WORDS = /\bundefined\b|\bNaN\b|\[object Object\]|\bnull\b|staging\.|candidate_id|dish_id|\bPT4\d\d\b|is_demo|Internal Server Error|Unhandled|TypeError/;

let enrolledHere: string[] = [];
test.beforeAll(async () => {
  // The invited-test restaurants (stage 1 of scripts/member-beta.mjs), enrolled for this file only if nothing is.
  if (Number((await pool.query("select count(*) n from staging.member_beta_places")).rows[0].n) === 0)
    enrolledHere = (
      await pool.query(
        `insert into staging.member_beta_places (place_id, stage, decision, recorded_by)
         select id, 1, 'Journey audit (test database only)', 'journeys-a-to-l.spec.ts' from staging.places
          where label in ('Next Level Veggie Grill', 'Madras Dosa Co', 'Asmara Restaurant', 'Brown Sugar Cafe') returning place_id`,
      )
    ).rows.map((r) => r.place_id as string);
  recipeId = (await pool.query("select id from public.food_items where kind = 'recipe' and not is_demo and status = 'published' order by id limit 1")).rows[0]?.id ?? "";
  const f = (
    await pool.query(
      `insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $1, '{}', '{}', now(), now()) returning id`,
      [`journeys-founder-${randomUUID().slice(0, 8)}@example.test`],
    )
  ).rows[0].id as string;
  founderId = f;
  await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher')", [f]);
  // The docs/80 first set: every check passes, at most 15 per restaurant, meals with a printed protein figure first.
  const ready = (
    await pool.query(
      `select id from (
         select d.id, row_number() over (partition by d.place_id order by staging.has_restaurant_protein(d.id) desc, d.label) n
           from staging.dishes d
          where ${READY_FOR_REVIEW}) x
        where n <= 15 order by id`,
    )
  ).rows.map((r) => r.id as string);
  // The founder's source review comes first (migration 20261125000300), as a test founder in the test database.
  await sourceReviewForTest(f, ready);
  for (const id of ready) {
    await pool.query(
      `insert into staging.tester_meal_decisions (dish_id, decision, reason, checks, decided_by)
       values ($1, 'include', 'Journey audit first set (test database only)', staging.tester_meal_checks($1), $2)`,
      [id, f],
    );
    included.push(id);
  }
});

test.afterAll(async () => {
  if (enrolledHere.length) await pool.query("delete from staging.member_beta_places where place_id = any($1::uuid[])", [enrolledHere]);
  if (included.length) await pool.query("delete from staging.tester_meal_decisions where decided_by = $1", [founderId]);
  if (founderId) await removeTestSourceReviews(founderId);
  const out = process.env.JOURNEY_AUDIT_OUT ?? "test-results/journey-audit.json";
  mkdirSync(out.replace(/\/[^/]*$/, ""), { recursive: true });
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), mode: "reviewed_meals", includedMeals: included.length, results }, null, 1));
});

const open: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close().catch(() => undefined)));
});

const seen = (page: Page, id: string) => page.getByTestId(id).filter({ visible: true });

type Person = { page: Page; context: BrowserContext; email: string; id: string; findings: string[] };
async function member(browser: Browser, label: string, width: number, findings: string[], email?: string): Promise<Person> {
  const context = await browser.newContext({ viewport: { width, height: width < 800 ? 844 : 900 }, isMobile: width < 800, hasTouch: width < 800, timezoneId: "America/New_York" });
  open.push(context);
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource: the server responded with a status of 404/.test(m.text())) findings.push(`console error on ${new URL(page.url()).pathname}: ${m.text().slice(0, 160)}`);
  });
  page.on("pageerror", (e) => findings.push(`page error on ${new URL(page.url()).pathname}: ${String(e).slice(0, 160)}`));
  const mail = email ?? `journey-${label}-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2Ftoday");
  await completeSignIn(page, mail);
  const id = (await pool.query("select id from auth.users where email = $1", [mail])).rows[0].id as string;
  return { page, context, email: mail, id, findings };
}

/** Opens a path and records what an ordinary user should never see there. */
async function look(p: Person, path: string) {
  const res = await p.page.goto(path);
  const where = path.split("?")[0];
  if (res && res.status() >= 500) p.findings.push(`${where}: server error ${res.status()}`);
  const main = p.page.locator("main:visible").first();
  // Streamed sections show "Loading…" first; read the page once they have arrived.
  const t0 = Date.now();
  await expect(main).not.toContainText(/Loading[^.…]{0,60}(…|\.\.\.)/, { timeout: 15_000 }).catch(() => p.findings.push(`${where}: still loading after 15 s`));
  // Any other streamed placeholder ("Ranking foods…" and the like): a status line that ends in an ellipsis.
  await expect(main.locator("[role=status]").filter({ hasText: /…\s*$/ })).toHaveCount(0, { timeout: 15_000 }).catch(() => p.findings.push(`${where}: still loading after 15 s`));
  // Skeleton placeholders (the meal list's grey cards) carry aria-busy and no text, so the two checks above miss them.
  // Journey C once counted the cards while the skeleton still showed (27 Nov, twice in full runs): wait for them too.
  await expect(main.locator("[aria-busy=true]")).toHaveCount(0, { timeout: 15_000 }).catch(() => p.findings.push(`${where}: still loading after 15 s`));
  if (Date.now() - t0 > 3000) p.findings.push(`${where}: took ${Math.round((Date.now() - t0) / 100) / 10} s to finish loading`);
  const text = ((await main.textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
  const dev = text.match(DEV_WORDS);
  if (dev) p.findings.push(`${where}: shows "${dev[0]}"`);
  const fw = text.match(/private preview|founder|confirmed by you|Review this restaurant.s drafts/i);
  if (fw) p.findings.push(`${where}: founder wording shown to a member ("${fw[0]}")`);
  const ways = await main.locator("a[href], button").filter({ visible: true }).count();
  if (ways === 0) p.findings.push(`${where}: no link or button: a dead end`);
  const wide = await p.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (wide) p.findings.push(`${where}: scrolls sideways`);
  return text;
}

function journey(id: string, title: string, width: number, body: (browser: Browser, findings: string[]) => Promise<void>) {
  test(`${id}: ${title} (${width} px)`, async ({ browser }) => {
    test.skip(included.length === 0, "No meal passes every tester check here");
    const findings: string[] = [];
    const t0 = Date.now();
    const r: Result = { journey: id, title, width, completed: false, seconds: 0, findings };
    results.push(r);
    try {
      await body(browser, findings);
      r.completed = true;
    } catch (e) {
      r.error = String(e).split("\n").slice(0, 3).join(" ").slice(0, 400);
      throw e;
    } finally {
      r.seconds = Math.round((Date.now() - t0) / 100) / 10;
    }
  });
}

async function chooseDiet(page: Page, diet: "vegetarian" | "vegan", exclusions: string[] = [], back = "/discover") {
  await page.goto(`/diet?return=${encodeURIComponent(back)}`);
  await page.locator(`main:visible input[name='diet'][value='${diet}']`).check();
  for (const x of exclusions) await page.locator(`main:visible input[name='exclusions'][value='${x}']`).check();
  await page.getByRole("button", { name: "Apply filter" }).click();
  await page.waitForURL(new RegExp(back.replace(/\//g, "\\/")));
}

const firstMealId = async (page: Page, testid = "preview-meal") => {
  const href = (await seen(page, testid).first().locator("a[href^='/meals/']").first().getAttribute("href"))!;
  return href.split("/meals/")[1].split("?")[0];
};

journey("A", "a new vegetarian chooses a neighbourhood, finds and saves a meal, and finds it again later", 390, async (browser, findings) => {
  const a = await member(browser, "a", 390, findings);
  await chooseDiet(a.page, "vegetarian");
  await look(a, "/discover");
  await expect(seen(a.page, "real-menus")).toBeVisible();
  const hood = seen(a.page, "real-menus-hoods").getByRole("link").first();
  await expect(hood, "a neighbourhood to choose").toBeVisible();
  await hood.click();
  await a.page.waitForURL(/\/protein\/meals\?hood=/);
  await look(a, a.page.url().replace(/^https?:\/\/[^/]+/, ""));
  const dish = await firstMealId(a.page);
  await look(a, `/meals/${dish}`);
  const name = (await seen(a.page, "meal-name").innerText()).trim();
  await expect(seen(a.page, "meal-hero")).toContainText(/(Vegetarian|Vegan) \(stated\)/);
  await seen(a.page, "meal-place").getByRole("link").first().click();
  await expect(seen(a.page, "place-name")).toBeVisible();
  await look(a, a.page.url().replace(/^https?:\/\/[^/]+/, ""));
  await a.page.goto(`/meals/${dish}`);
  await seen(a.page, "meal-save").click();
  await expect(seen(a.page, "meal-save")).toHaveAttribute("aria-pressed", "true");
  await a.context.close();
  const later = await member(browser, "a", 1440, findings, a.email);
  await look(later, "/saved");
  await expect(seen(later.page, "saved-meals")).toContainText(name);
  await pool.query("delete from staging.preview_saves where user_id = $1", [a.id]);
});

journey("B", "a strict egg-free vegetarian never gets a meal that lists egg as a fit, on every page and by direct link", 390, async (browser, findings) => {
  const m = await member(browser, "b", 390, findings);
  await chooseDiet(m.page, "vegetarian", ["egg"]);
  await look(m, "/protein/meals");
  const cards = seen(m.page, "preview-meal");
  const n = await cards.count();
  expect(n).toBeGreaterThan(0);
  const ids = await cards.locator("a[href^='/meals/']").evaluateAll((els) => [...new Set(els.map((e) => (e.getAttribute("href") ?? "").split("/meals/")[1]?.split("?")[0]))]);
  const eggy = (
    await pool.query(
      `select f.dish_id::text id from staging.facts f where f.kind = 'listed_ingredients' and f.dish_id = any($1::uuid[])
         and f.value::text ~* '\\m(egg|eggs|mayo|mayonnaise|aioli)\\M' and f.value::text !~* '(vegan|plant|chickpea|eggplant) ?(egg|mayo|aioli)'`,
      [included],
    )
  ).rows.map((r) => r.id as string);
  for (const id of eggy) expect(ids, `egg-listing meal ${id} shown as a fit`).not.toContain(id);
  for (let i = 0; i < Math.min(n, 12); i++) {
    const fit = cards.nth(i).getByTestId("meal-fit");
    if (await fit.count()) await expect(fit.first()).not.toContainText(/Doesn.t fit/);
  }
  // By direct link, a meal that lists egg says it does not fit; one with no ingredient list is never called a fit.
  if (eggy[0]) {
    await look(m, `/meals/${eggy[0]}`);
    await expect(seen(m.page, "meal-hero")).toContainText(/Doesn.t fit|lists egg|contains egg/i);
  } else findings.push("B: no included meal lists egg, so the direct-link exclusion was not exercised");
  const noList = (
    await pool.query(
      `select d from unnest($1::uuid[]) d where not exists (select 1 from staging.facts f where f.dish_id = d and f.kind = 'listed_ingredients') limit 1`,
      [included],
    )
  ).rows[0]?.d as string | undefined;
  if (noList) {
    const text = await look(m, `/meals/${noList}`);
    expect(text).not.toMatch(/Fits, as stated[^.]*egg-free/i);
  }
  // The preference persists in a new session.
  await m.context.close();
  const again = await member(browser, "b", 1440, findings, m.email);
  await again.page.goto("/diet");
  await expect(again.page.locator("main:visible input[name='exclusions'][value='egg']")).toBeChecked();
  await look(again, "/search?q=bowl");
});

journey("C", "a vegan compares eligible meals across restaurants and never gets a conflicting strict match", 1440, async (browser, findings) => {
  const m = await member(browser, "c", 1440, findings);
  await chooseDiet(m.page, "vegan");
  await look(m, "/protein/meals");
  const cards = seen(m.page, "preview-meal");
  const n = await cards.count();
  // If no meal shows, say what the page showed (kept from the 27 Nov investigation).
  const shown = n ? "" : (await m.page.locator("main:visible").first().innerText().catch(() => "(no main)")).replace(/\s+/g, " ").slice(0, 600);
  expect(n, `vegan meals on /protein/meals; the page showed: ${shown}`).toBeGreaterThan(0);
  for (let i = 0; i < Math.min(n, 15); i++) await expect(cards.nth(i)).not.toContainText(/Vegetarian \(stated\)(?! ·)|Doesn.t fit/);
  // Compare up to three, preferring meals from different restaurants, the way a member would from the cards.
  const dishes = await cards.evaluateAll((els) => els.map((e) => e.getAttribute("data-dish") ?? "").filter(Boolean));
  const placeOf = new Map((await pool.query("select id::text, place_id::text from staging.dishes where id = any($1::uuid[])", [dishes])).rows.map((r) => [r.id as string, r.place_id as string]));
  const chosen: string[] = [];
  const order = [...new Set(dishes)].sort((x, y) => Number(chosen.some((c) => placeOf.get(c) === placeOf.get(x))) - Number(chosen.some((c) => placeOf.get(c) === placeOf.get(y))));
  for (const d of order) {
    if (chosen.length && chosen.some((c) => placeOf.get(c) === placeOf.get(d)) && new Set(dishes.map((x) => placeOf.get(x))).size > chosen.length) continue;
    const card = m.page.locator(`ul.cards > [data-testid=preview-meal][data-dish='${d}']`).filter({ visible: true });
    if (!(await card.count())) continue;
    await card.first().getByTestId("meal-compare-toggle").click();
    chosen.push(d);
    await expect(m.page.getByTestId("meal-compare-bar")).toHaveCount(chosen.length);
    if (chosen.length === 3) break;
  }
  if (chosen.length >= 2) await expect(m.page.getByTestId("meal-compare")).toContainText(`Comparing ${chosen.length} of up to 3 meals`);
  else findings.push(`C: only ${chosen.length} vegan meal(s) to compare`);
  const restaurants = new Set(chosen.map((d) => placeOf.get(d)));
  if (chosen.length >= 2 && restaurants.size < 2) findings.push("C: every vegan meal to compare comes from one restaurant");
});

journey("D", "a protein-minded member compares printed figures and estimates and sees unknown as unknown", 390, async (browser, findings) => {
  const m = await member(browser, "d", 390, findings);
  await chooseDiet(m.page, "vegetarian", [], "/protein/meals");
  await look(m, "/protein/meals?min=20");
  const printed = seen(m.page, "preview-meal").filter({ has: m.page.locator("[data-testid='preview-protein-tile'][data-basis='published']") });
  expect(await printed.count()).toBeGreaterThan(0);
  const dish = await firstMealId(m.page);
  await look(m, `/meals/${dish}`);
  await expect(seen(m.page, "meal-protein-detail").or(seen(m.page, "protein-explanation")).first()).toBeVisible();
  const unknown = (
    await pool.query(
      `select d from unnest($1::uuid[]) d where not staging.has_restaurant_protein(d)
          and not exists (select 1 from staging.dish_estimates e where e.dish_id = d and e.unknown_reason is null) limit 1`,
      [included],
    )
  ).rows[0]?.d as string | undefined;
  if (unknown) {
    const text = await look(m, `/meals/${unknown}`);
    expect(text).not.toMatch(/\b0 g protein/);
    expect(text).toMatch(/not known|unknown|not printed|doesn.t print/i);
  } else findings.push("D: every included meal has printed or estimated protein; the unknown case was not exercised");
});

journey("E", "a restaurant meal goes into the diary with its source and the goal counts it after a reload", 390, async (browser, findings) => {
  const m = await member(browser, "e", 390, findings);
  await m.page.goto("/diary/goals");
  await m.page.getByLabel("Protein per day (grams)").fill("80");
  await m.page.getByRole("button", { name: "Save goals" }).click();
  await expect(m.page.getByTestId("goals-saved")).toBeVisible();
  // A meal whose printed protein a member can see: its card on Protein shows the restaurant's figure.
  await look(m, "/protein/meals?min=20");
  const card = seen(m.page, "preview-meal").filter({ has: m.page.locator("[data-testid='preview-protein-tile'][data-basis='published']") }).first();
  const dish = (await card.getAttribute("data-dish"))!;
  await look(m, `/meals/${dish}`);
  await seen(m.page, "meal-log").click();
  await expect(m.page).toHaveURL(/\/diary\/custom\?meal=/);
  const protein = Number(await m.page.getByLabel("Protein (g)").inputValue());
  expect(protein, "the restaurant's printed protein is carried into the log form").toBeGreaterThan(0);
  await m.page.getByRole("button", { name: "Add to diary" }).click();
  await m.page.waitForURL(/\/diary(\?|$)/);
  await m.page.reload();
  await expect(seen(m.page, "diary-entry")).toHaveCount(1);
  const attr = (
    await pool.query(
      `select a.attribution from public.diary_entries e join public.food_revisions r on r.food_item_id = e.food_item_id
         join public.custom_food_attributions a on a.revision_id = r.id where e.owner_id = $1`,
      [m.id],
    )
  ).rows;
  expect(attr).toHaveLength(1);
  expect(attr[0].attribution.dish.id).toBe(dish);
  expect(attr[0].attribution.source.url).toMatch(/^https:\/\//);
  const left = Math.round((80 - protein) * 10) / 10;
  if (left > 0) await expect(seen(m.page, "protein-to-go")).toContainText(`${String(left).replace(/\.0$/, "")} g protein to go`);
  await look(m, "/diary");
});

journey("F", "Today: a goal, a logged food, a fitting suggestion followed, and the same day's totals", 390, async (browser, findings) => {
  const m = await member(browser, "f", 390, findings);
  await chooseDiet(m.page, "vegetarian", [], "/today");
  await m.page.goto("/diary/goals");
  await m.page.getByLabel("Protein per day (grams)").fill("90");
  await m.page.getByRole("button", { name: "Save goals" }).click();
  await m.page.goto("/diary/custom");
  await m.page.getByLabel("What was it?").fill("Yogurt and granola");
  await m.page.getByLabel("Protein (g)").fill("12");
  await m.page.getByRole("button", { name: "Add to diary" }).click();
  await m.page.waitForURL(/\/diary(\?|$)/);
  const today = await look(m, "/today");
  await expect(seen(m.page, "today-entry")).toContainText("Yogurt and granola");
  if (!/78 g/.test(today)) findings.push("F: Today does not show the 78 g still to go");
  // A suggestion toward the goal, on Today or the diary day.
  let idea = seen(m.page, "togo-meal").first();
  if (!(await idea.count())) {
    await look(m, "/diary");
    idea = seen(m.page, "togo-meal").first();
  }
  if (!(await idea.count())) {
    findings.push("F: no meal suggestion toward the protein goal for this member");
    return;
  }
  const back = m.page.url();
  await idea.locator("a[href^='/meals/']").first().click();
  await m.page.waitForURL(/\/meals\//);
  await expect(seen(m.page, "meal-hero")).toContainText(/(Vegetarian|Vegan) \(stated\)/);
  await seen(m.page, "meal-log").click();
  const p = Number(await m.page.getByLabel("Protein (g)").inputValue());
  await m.page.getByRole("button", { name: "Add to diary" }).click();
  await m.page.waitForURL(/\/diary(\?|$)/);
  const nyToday = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const dayOf = (u: string) => new URL(u).searchParams.get("date") ?? nyToday;
  expect(dayOf(m.page.url()), "back on the same day").toBe(dayOf(back));
  await expect(seen(m.page, "diary-entry")).toHaveCount(2);
  await expect(seen(m.page, "day-protein")).toContainText(String(Math.round((12 + p) * 10) / 10).replace(/\.0$/, ""));
});

journey("G", "a member finds a recipe, scales it, cooks it step by step and logs it", 390, async (browser, findings) => {
  test.skip(!recipeId, "Needs the real recipes");
  const m = await member(browser, "g", 390, findings);
  await chooseDiet(m.page, "vegetarian", [], "/cook");
  await look(m, "/cook");
  const card = seen(m.page, "recipe-card").first();
  await expect(card).toBeVisible();
  await card.locator("a[href^='/cook/']").first().click();
  await expect(seen(m.page, "recipe-name")).toBeVisible();
  await look(m, m.page.url().replace(/^https?:\/\/[^/]+/, ""));
  const before = await seen(m.page, "ingredients").innerText();
  if (await seen(m.page, "servings-more").count()) {
    await seen(m.page, "servings-more").click();
    await expect(seen(m.page, "ingredients")).not.toHaveText(before);
  } else findings.push("G: no way to scale this recipe");
  await seen(m.page, "start-cooking").click();
  await expect(seen(m.page, "cook-mode")).toBeVisible();
  while (await seen(m.page, "cook-next").isVisible()) await seen(m.page, "cook-next").click();
  await seen(m.page, "cook-finish").click();
  await expect(m.page).toHaveURL(/\/done$/);
  await seen(m.page, "ate-submit").click();
  await expect(m.page).toHaveURL(/\/diary\?date=/);
  await expect(seen(m.page, "diary-entry")).toHaveCount(1);
});

journey("H", "a weekly plan with a restaurant meal and a recipe survives a new session and an update", 1440, async (browser, findings) => {
  test.skip(!recipeId, "Needs the real recipes");
  const m = await member(browser, "h", 1440, findings);
  const dish = included[0];
  await m.page.goto(`/meals/${dish}`);
  const name = (await seen(m.page, "meal-name").innerText()).trim();
  await seen(m.page, "meal-plan").locator("summary").click();
  await m.page.getByLabel("Meal", { exact: true }).selectOption("dinner");
  await m.page.getByRole("button", { name: "Add to my week plan" }).click();
  await expect(seen(m.page, "meal-plan").locator("summary")).toContainText("Planned for");
  await m.page.goto(`/cook/${recipeId}`);
  await m.page.getByTestId("plan-sheet").locator("summary").click();
  await m.page.getByTestId("plan-sheet").getByRole("button", { name: "Add to week plan" }).click();
  await expect(m.page).toHaveURL(/\/cook\/plan/);
  await m.context.close();
  const again = await member(browser, "h", 390, findings, m.email);
  const text = await look(again, "/cook/plan");
  expect(text).toContain(name);
  await expect(seen(again.page, "plan-item")).toHaveCount(1);
  await seen(again.page, "plan-item").getByRole("button", { name: /Remove/ }).click();
  await expect(seen(again.page, "plan-item")).toHaveCount(0);
  await expect(seen(again.page, "plan-outing")).toContainText(name);
  await pool.query("delete from staging.preview_meal_plans where user_id = $1", [m.id]);
});

journey("I", "two members follow each other, review and rank a real restaurant, list it and see each other's recommendation", 390, async (browser, findings) => {
  const mk = async (label: string, name: string) => {
    const p = await member(browser, label, 390, findings);
    const handle = `${label}_${randomUUID().slice(0, 8)}`;
    await pool.query("insert into public.member_standing (user_id, first_public_approved_at) values ($1, now()) on conflict (user_id) do update set first_public_approved_at = now()", [p.id]);
    await p.page.goto("/friends/profile");
    await p.page.getByLabel("Handle", { exact: true }).fill(handle);
    await p.page.getByLabel("Display name (optional)").fill(name);
    await p.page.getByLabel(/Let people find me/).check();
    await p.page.getByRole("button", { name: "Save profile" }).click();
    await expect(p.page.getByTestId("flash").filter({ hasText: "Profile saved." })).toBeVisible();
    return { ...p, handle, name };
  };
  const a = await mk("ia", "Ari Journey");
  const b = await mk("ib", "Bo Journey");
  const tag = randomUUID().slice(0, 6);
  // Follow each other and become friends.
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
  // A reviews a real restaurant for friends, ranks it, and lists it.
  const place = (
    await pool.query(
      `select pl.slug, pl.venue_id::text venue, pl.name from unnest($1::uuid[]) d join staging.dishes x on x.id = d
         join staging.live_catalog_links k on k.staging_place = x.place_id join public.place_listings pl on pl.candidate_id = k.candidate_id
        where pl.venue_id is not null limit 1`,
      [included],
    )
  ).rows[0];
  if (!place) {
    findings.push("I: no real restaurant with a venue record to review; opening one page first");
  }
  const slug = place?.slug ?? (await pool.query("select pl.slug from unnest($1::uuid[]) d join staging.dishes x on x.id = d join staging.live_catalog_links k on k.staging_place = x.place_id join public.place_listings pl on pl.candidate_id = k.candidate_id limit 1", [included])).rows[0].slug;
  await look(a, `/places/${slug}`);
  const venue = (await pool.query("select venue_id::text v, name from public.place_listings where slug = $1", [slug])).rows[0];
  expect(venue.v, "the real restaurant has a venue record for reviews").toBeTruthy();
  await a.page.goto(`/review?kind=venue&id=${venue.v}`);
  await a.page.locator(".rating-pick label").filter({ hasText: /^5Excellent$/ }).click();
  await a.page.getByLabel(/What would you tell a friend/).fill(`Great lunch ${tag}`);
  await a.page.getByRole("radio", { name: /^My friends/ }).check();
  await a.page.getByRole("button", { name: "Save review" }).click();
  await a.page.waitForURL((u) => !u.pathname.startsWith("/review"));
  await look(a, "/friends/ranking");
  const add = seen(a.page, "unranked").getByRole("button", { name: new RegExp(`Add to ranking: ${venue.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });
  if (await add.count()) {
    await add.click();
    await expect(seen(a.page, "ranking")).toContainText(venue.name);
  } else findings.push("I: the reviewed real restaurant could not be added to the ranking");
  // B sees A's review in the friends feed and as a recommendation.
  const feed = await look(b, "/friends?feed=friends");
  expect(feed).toContain(`Great lunch ${tag}`);
  // Recommendations count PUBLIC reviews of people you follow (docs/18 M5 rule); a friends-only review stays in the feed.
  const recs = await look(b, "/friends");
  if (!recs.includes(venue.name)) findings.push("I: by the current rule, a friends-only 5-star review is in the friends feed but not among recommendations (owner decision)");
  // A third member shares a public 5-star review of the same real restaurant; B follows them and gets the recommendation.
  const c = await mk("ic", "Cy Journey");
  await c.page.goto(`/review?kind=venue&id=${venue.v}`);
  await c.page.locator(".rating-pick label").filter({ hasText: /^5Excellent$/ }).click();
  await c.page.getByLabel(/What would you tell a friend/).fill(`Worth the trip ${tag}`);
  await c.page.getByRole("radio", { name: /^Everyone/ }).check();
  await c.page.getByRole("button", { name: "Save review" }).click();
  await c.page.waitForURL((u) => !u.pathname.startsWith("/review"));
  await b.page.goto(`/u/${c.handle}`);
  await seen(b.page, "rel-follow").click();
  await expect(b.page.getByTestId("flash").filter({ hasText: "You're following them" })).toBeVisible();
  await look(b, "/friends");
  await expect(seen(b.page, "recommendation").filter({ hasText: venue.name })).toContainText("Cy Journey");
});

journey("J", "a brand-new member opens every main screen and is never stranded or shown developer wording", 390, async (browser, findings) => {
  const m = await member(browser, "j", 390, findings);
  for (const path of ["/today", "/discover", "/search", "/protein", "/protein/meals", "/places/menus", "/saved", "/diary", "/diary/goals", "/diary/week", "/cook", "/cook/plan", "/friends", "/friends/people", "/friends/lists", "/friends/reviews", "/friends/ranking", "/account", "/diet"]) {
    const text = await look(m, path);
    if (text.trim().length < 60) findings.push(`${path}: almost empty (${text.trim().length} characters)`);
    await expect(m.page.getByRole("heading", { level: 1 }).filter({ visible: true }).first(), path).toBeVisible();
    await expect(m.page.getByTestId("error-page")).toHaveCount(0);
  }
  await expectNoSidewaysScroll(m.page);
});

journey("K", "a returning member sees their saved meal, goal and recent food", 1440, async (browser, findings) => {
  const m = await member(browser, "k", 1440, findings);
  const dish = included[0];
  await m.page.goto(`/meals/${dish}`);
  const name = (await seen(m.page, "meal-name").innerText()).trim();
  await seen(m.page, "meal-save").click();
  await m.page.goto("/diary/goals");
  await m.page.getByLabel("Protein per day (grams)").fill("70");
  await m.page.getByRole("button", { name: "Save goals" }).click();
  // Yesterday's food, entered as a dated diary entry.
  await m.page.goto("/diary/custom");
  await m.page.getByLabel("What was it?").fill("Lentil soup at home");
  await m.page.getByLabel("Protein (g)").fill("18");
  await m.page.getByRole("button", { name: "Add to diary" }).click();
  await m.page.waitForURL(/\/diary(\?|$)/);
  await m.context.close();
  const back = await member(browser, "k", 390, findings, m.email);
  const today = await look(back, "/today");
  if (!today.includes("Lentil soup at home")) findings.push("K: Today does not show today's earlier food after signing in again");
  if (!/70 g|of 70/.test(today)) findings.push("K: Today does not show the protein goal");
  if (!today.includes(name)) findings.push("K: Today does not offer the saved meal");
  const saved = await look(back, "/saved");
  expect(saved).toContain(name);
  await pool.query("delete from staging.preview_saves where user_id = $1", [m.id]);
});

journey("L", "an ordinary member cannot reach another member's private data or any founder tool", 390, async (browser, findings) => {
  const a = await member(browser, "la", 390, findings);
  const z = await member(browser, "lz", 390, findings);
  await a.page.goto("/diary/custom");
  await a.page.getByLabel("What was it?").fill("Private pasta");
  await a.page.getByLabel("Protein (g)").fill("15");
  await a.page.getByRole("button", { name: "Add to diary" }).click();
  await a.page.waitForURL(/\/diary(\?|$)/);
  for (const path of ["/places/review", "/places/review/menus", "/places/menus/confirm", "/places/menus/testers", "/feedback/all", "/moderation", "/moderation/members", "/editor"]) {
    await z.page.goto(path);
    const main = z.page.locator("main:visible").first();
    // The refusal streams in after the page frame: wait for it, then check nothing private came with it.
    await expect(main, path).toContainText(/couldn.t find|not available|for the founder|for moderators|doesn.t have|only for|not allowed|isn.t available|no access|need the|sign in/i);
    const text = ((await main.textContent()) ?? "").replace(/\s+/g, " ");
    expect(text, path).not.toMatch(/Ready to include|Every answer|tester code [a-f0-9]{6}|Moderation queue|Representative sample|correct, \d+ problem/);
    if (/founder only/i.test(text)) z.findings.push(`${path}: a member sees the founder page frame and a refusal, instead of a plain "not found"`);
  }
  for (const path of ["/diary", "/today", "/saved", "/friends"]) {
    await z.page.goto(path);
    expect((await z.page.locator("main:visible").first().textContent()) ?? "", path).not.toContain("Private pasta");
  }
  const list = await a.page.request.get("/api/v1/diary");
  expect(list.status()).toBeLessThan(500);
});

journey("M", "a member in each of the six cities sees that city's state honestly, and never a Boston restaurant under another city's name", 390, async (browser, findings) => {
  const m = await member(browser, "m", 390, findings);
  const bostonPlaces = (
    await pool.query("select distinct p.label from staging.dishes d join staging.places p on p.id = d.place_id where d.id = any($1::uuid[])", [included])
  ).rows.map((r) => r.label as string);
  const cities = [
    ["boston", "Boston area"], ["new-york", "New York City area"], ["chicago", "Chicago area"],
    ["los-angeles", "Los Angeles area"], ["san-francisco", "San Francisco area"], ["dallas", "Dallas area"],
  ] as const;
  for (const [slug, name] of cities) {
    await m.page.goto("/city?return=%2Fdiscover");
    await m.page.getByTestId(`city-${slug}`).locator("input").check();
    await m.page.getByTestId("city-save").click();
    await m.page.waitForURL(/\/discover/);
    const text = await look(m, "/discover");
    await expect(seen(m.page, "market-line")).toContainText(name);
    if (slug === "boston") {
      await expect(m.page.getByTestId("market-coming")).toHaveCount(0);
      if (!bostonPlaces.some((p) => text.includes(p))) findings.push("M: Boston Discover shows none of the restaurants with reviewed meals");
    } else {
      await expect(seen(m.page, "market-coming")).toContainText(`Restaurants in the ${name} are coming later`);
      for (const p of bostonPlaces) expect(text, `${slug} Discover`).not.toContain(p);
      // What works everywhere still works: recipes by protein.
      await look(m, "/protein");
      await expect(m.page.locator("main:visible").first()).toContainText(/g protein/, { timeout: 15_000 });
    }
  }
  await expectNoSidewaysScroll(m.page);
});
