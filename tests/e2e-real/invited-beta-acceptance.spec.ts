import { expect, test, type Browser, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";
import { completeSignIn } from "../e2e/helpers";
import { memberBetaForThisFile, READY_FOR_REVIEW, removeTestSourceReviews, sourceReviewForTest } from "./beta-switch";

/**
 * Invited-beta acceptance (owner direction 25 Nov 2026 20:02 UTC, item 3), on real local data in the disposable test
 * database, in the reviewed-meals mode the hosted beta uses. A test founder source-reviews and includes ONE meal (A).
 * A second meal at the same enrolled restaurant passes every evidence check but is never reviewed (B), and a third is
 * reviewed but not included (C). An ordinary invited member then takes A through Discover, the restaurant, the meal,
 * Save, Compare, Diary, Today, Goals, Review and List, and can reach neither B nor C. Guests and ordinary members are
 * refused the founder tools. The switch is on for this file only; every row the test writes is removed afterwards.
 */
test.use({ timezoneId: "America/New_York" });
memberBetaForThisFile(true, "reviewed_meals");
test.setTimeout(300_000);

const seen = (page: Page, id: string) => page.getByTestId(id).filter({ visible: true });
let founder = "";
let A = "";
let B = "";
let C = "";
let slug = "";

test.beforeAll(async () => {
  founder = (
    await pool.query(
      `insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $1, '{}', '{}', now(), now()) returning id`,
      [`accept-founder-${randomUUID().slice(0, 8)}@example.test`],
    )
  ).rows[0].id as string;
  await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher')", [founder]);
  // Three meals at one enrolled restaurant whose evidence passes every check, none reviewed or included yet.
  const rows = (
    await pool.query(
      `select d.id::text, d.place_id::text from staging.dishes d
        where d.place_id in (select place_id from staging.member_beta_places)
          and ${READY_FOR_REVIEW}
          and not staging.tester_meal_all_pass(staging.tester_meal_checks(d.id))
          and not staging.tester_meal_included(d.id)
        order by d.place_id, d.label`,
    )
  ).rows as { id: string; place_id: string }[];
  const byPlace = new Map<string, string[]>();
  for (const r of rows) byPlace.set(r.place_id, [...(byPlace.get(r.place_id) ?? []), r.id]);
  const place = [...byPlace.entries()].find(([, ids]) => ids.length >= 3);
  if (!place) return;
  [A, B, C] = place[1];
  slug = (
    await pool.query(
      `select pl.slug from staging.live_catalog_links l join public.place_listings pl on pl.candidate_id = l.candidate_id
        where l.staging_place = $1 and pl.visibility = 'preview' limit 1`,
      [place[0]],
    )
  ).rows[0]?.slug;
  await sourceReviewForTest(founder, [A, C]);
  await pool.query(
    `insert into staging.tester_meal_decisions (dish_id, decision, reason, checks, decided_by)
     values ($1, 'include', 'Acceptance test (test database only)', staging.tester_meal_checks($1), $2)`,
    [A, founder],
  );
});

test.afterAll(async () => {
  if (!founder) return;
  await pool.query("delete from staging.tester_meal_decisions where decided_by = $1", [founder]);
  await removeTestSourceReviews(founder);
});

async function person(browser: Browser, label: string) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: "America/New_York" });
  const page = await context.newPage();
  const email = `accept-${label}-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2Ftoday");
  await completeSignIn(page, email);
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
  return { page, context, id };
}

test("the gates hold: only the reviewed and included meal is a member meal; enrolment alone exposes nothing", async () => {
  test.skip(!A, "Needs three evidence-ready meals at one enrolled restaurant");
  // As a signed-in member would ask: the member rule needs a signed-in person (staging.member_beta_on).
  const c = await pool.connect();
  await c.query("begin");
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: randomUUID(), role: "authenticated" })]);
  const ok = async (d: string) => (await c.query("select staging.member_dish_ok($1) ok", [d])).rows[0].ok as boolean;
  expect(await ok(A)).toBe(true);
  expect(await ok(B)).toBe(false);
  expect(await ok(C)).toBe(false);
  // Every other meal at the enrolled restaurants stays hidden unless the founder included it.
  const exposed = (
    await c.query(
      `select count(*)::int n from staging.dishes d where d.place_id in (select place_id from staging.member_beta_places)
          and staging.member_dish_ok(d.id) and not staging.tester_meal_included(d.id)`,
    )
  ).rows[0].n;
  await c.query("rollback");
  c.release();
  expect(exposed).toBe(0);
});

test("an invited member takes the reviewed meal from Discover to Review and List, and never reaches the others", async ({ browser }) => {
  test.skip(!A || !slug, "Needs three evidence-ready meals at one enrolled restaurant");
  const m = await person(browser, "member");
  const page = m.page;
  const tag = randomUUID().slice(0, 6);
  try {
    // Goals first: a vegetarian choice and a protein goal.
    await page.goto("/diet?return=%2Fdiscover");
    await page.locator("main:visible input[name='diet'][value='vegetarian']").check();
    await page.getByRole("button", { name: "Apply filter" }).click();
    await page.waitForURL(/\/discover/);
    // Discover: real meals, and only the included one from the beta.
    await expect(seen(page, "real-menus")).toBeVisible();
    const cards = seen(page, "real-menus").locator("a[href^='/meals/']");
    const hrefs = await cards.evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
    for (const h of hrefs) expect(h).not.toMatch(new RegExp(`${B}|${C}`));
    // Restaurant: the page lists the reviewed meal and not the unreviewed one.
    await page.goto(`/places/${slug}`);
    await expect(seen(page, "place-name")).toBeVisible();
    const main = (await page.locator("main:visible").first().innerHTML()) ?? "";
    expect(main).toContain(`/meals/${A}`);
    expect(main).not.toContain(`/meals/${B}`);
    expect(main).not.toContain(`/meals/${C}`);
    // The reviewed meal: diet label, price, nutrition source, and the not-verified notice.
    await page.goto(`/meals/${A}`);
    const name = (await seen(page, "meal-name").innerText()).trim();
    await expect(seen(page, "meal-hero")).toContainText(/(Vegetarian|Vegan) \(stated\)/);
    await expect(seen(page, "meal-protein-detail")).toContainText(/printed by the restaurant|estimate|unknown/i);
    await expect(seen(page, "unverified-banner").first()).toBeVisible();
    // Save.
    await seen(page, "meal-save").click();
    await expect(seen(page, "meal-save")).toHaveAttribute("aria-pressed", "true");
    // Compare.
    await page.goto(`/protein/meals?compare=${A}#compare`);
    await expect(seen(page, "meal-compare")).toBeVisible();
    await expect(seen(page, "meal-compare-bar")).toHaveCount(1);
    // Diary: logged from the meal, keeping its source and never marked verified.
    await page.goto(`/diary/custom?meal=${A}`);
    await page.getByRole("button", { name: "Add to diary" }).click();
    await page.waitForURL(/\/diary(\?|$)/);
    await expect(seen(page, "diary-entry")).toHaveCount(1);
    const attr = (
      await pool.query(
        `select a.attribution from public.diary_entries e join public.food_revisions r on r.food_item_id = e.food_item_id
           join public.custom_food_attributions a on a.revision_id = r.id where e.owner_id = $1`,
        [m.id],
      )
    ).rows;
    expect(attr).toHaveLength(1);
    expect(attr[0].attribution.dish.id).toBe(A);
    expect(attr[0].attribution.status).not.toBe("verified");
    // Today shows it; Goals count it.
    await page.goto("/today");
    await expect(page.getByTestId("today-entry").first()).toContainText(name);
    await page.goto("/diary/goals");
    await page.getByLabel("Protein per day (grams)").fill("80");
    await page.getByRole("button", { name: "Save goals" }).click();
    await expect(page.getByTestId("goals-saved")).toBeVisible();
    // The diary counts the goal; a meal whose protein is unknown stays unknown, never zero.
    await page.goto("/diary");
    // The wording depends on whether the meal's protein is known: "7 g recorded of your 80 g goal" or "Your goal is 80 g. Protein isn't known…".
    await expect(page.locator("main:visible").first()).toContainText(/Your goal is 80 g|of your 80 g goal/);
    await expect(page.locator("main:visible").first()).toContainText(/Protein isn.t known|g (protein )?to go|g of protein|goal met/i);
    // Review and List, both private to the member.
    await page.goto(`/meals/${A}`);
    const review = seen(page, "meal-review");
    await review.locator("summary").click();
    await review.locator("label").filter({ hasText: /^4/ }).first().click();
    await review.locator("textarea").fill(`Acceptance ${tag}`);
    await review.getByRole("button", { name: /save/i }).click();
    await expect(seen(page, "meal-review").locator("summary")).toContainText("Your rating: 4 of 5");
    const lists = seen(page, "meal-lists");
    await lists.locator("summary").click();
    await lists.getByLabel(/start your first list|or start a new list/i).fill(`Beta ${tag}`);
    await lists.getByRole("button", { name: "Create list and add this" }).click();
    await expect(seen(page, "meal-lists").locator("summary")).toContainText("On 1 of your lists");
    expect((await pool.query("select count(*)::int n from public.reviews where author_id = $1", [m.id])).rows[0].n).toBe(0);
    // The unreviewed and the not-included meals: not found, by direct link too.
    for (const d of [B, C]) {
      await page.goto(`/meals/${d}`);
      await expect(page.getByRole("heading", { level: 1, name: /couldn.t find that/i })).toBeVisible();
      await expect(seen(page, "meal-hero")).toHaveCount(0);
    }
    // Ordinary-member restrictions: no founder tool, no member preview.
    for (const path of ["/places/review/queue", `/places/review/queue/preview/${A}`, "/places/menus/testers", "/places/review/menus"]) {
      await page.goto(path);
      await expect(page.locator("main:visible").first(), path).toContainText(/couldn.t find|not available|for the founder|only for|sign in/i);
      const text = ((await page.locator("main:visible").first().textContent()) ?? "").replace(/\s+/g, " ");
      expect(text, path).not.toMatch(/Proposed first selection|Matches the source|Founder preview|Ready to include/);
    }
  } finally {
    for (const t of ["preview_reviews", "preview_list_entries", "preview_meal_plans", "preview_saves"]) await pool.query(`delete from staging.${t} where user_id = $1`, [m.id]);
    await m.context.close();
  }
});

test("a guest is asked to sign in and sees no real meal or founder tool", async ({ browser }) => {
  test.skip(!A, "Needs three evidence-ready meals at one enrolled restaurant");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "America/New_York" });
  const page = await context.newPage();
  for (const path of [`/meals/${A}`, "/places/review/queue", `/places/review/queue/preview/${A}`]) {
    await page.goto(path);
    // The page streams: wait for the refusal, then check no meal came with it.
    await expect(page.locator("main:visible").first(), path).toContainText(/sign in|couldn.t find/i);
    await expect(page.getByTestId("meal-hero")).toHaveCount(0);
  }
  await context.close();
});

test("the founder's review shows at once in the progress, the evidence status and the member preview", async ({ browser }) => {
  test.skip(!A, "Needs three evidence-ready meals at one enrolled restaurant");
  // A fresh test founder looks at meal C (reviewed in setup by another test founder) and meal A (included).
  const f = await person(browser, "founder");
  await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher')", [f.id]);
  try {
    await f.page.goto(`/places/review/queue/preview/${A}`);
    await expect(f.page.getByTestId("mp-gates")).toContainText("A member can see this meal now");
    for (const g of ["evidence", "enrolled", "reviewed", "included", "switchOn"]) await expect(f.page.getByTestId(`mp-gate-${g}`)).toHaveAttribute("data-pass", "yes");
    await f.page.goto(`/places/review/queue/preview/${C}`);
    await expect(f.page.getByTestId("mp-gate-reviewed")).toHaveAttribute("data-pass", "yes");
    await expect(f.page.getByTestId("mp-gate-included")).toHaveAttribute("data-pass", "no");
    await f.page.goto(`/places/review/queue/preview/${B}`);
    await expect(f.page.getByTestId("mp-gate-reviewed")).toHaveAttribute("data-pass", "no");
    await f.page.goto(`/places/review/queue?view=all#meal-${C}`);
    await expect(f.page.locator(`#meal-${C}`).getByTestId("rq-dim-source")).toHaveAttribute("data-state", "complete");
    await expect(f.page.locator(`#meal-${B}`).getByTestId("rq-dim-source")).toHaveAttribute("data-state", "none");
    await expect(f.page.locator(`#meal-${A}`).getByTestId("rq-dim-member")).toHaveAttribute("data-state", "eligible");
  } finally {
    await f.context.close();
  }
});
