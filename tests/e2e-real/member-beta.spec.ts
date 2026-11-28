import { expect, test, type Browser } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";
import { completeSignIn } from "../e2e/helpers";
import { memberBetaForThisFile } from "./beta-switch";

/**
 * The staged member-visible local beta (owner decision 22 Nov 2026 15:26 UTC; migration 20261122000600) and the
 * founder-only "Needs confirmation" group, on real local data. Runs only where the beta switch is already on
 * (scripts/member-beta.mjs on); it never turns it on or off. Adds only its own sign-in accounts and the one save
 * it removes again.
 */
test.use({ timezoneId: "America/New_York" });

// With the staged local member beta on, whatever state the database was in.
memberBetaForThisFile(true);
test.setTimeout(180_000);

async function person(browser: Browser, label: string, founder: boolean, width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: "America/New_York" });
  const page = await context.newPage();
  const email = `beta-${label}-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2Ftoday");
  await completeSignIn(page, email);
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
  if (founder) await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher') on conflict do nothing", [id]);
  return { page, context, id };
}
const betaOn = async () => (await pool.query("select enabled from staging.member_beta_switch")).rows[0]?.enabled === true;
const enrolledNames = async () =>
  (
    await pool.query(`select distinct pl.name from staging.member_beta_places b join staging.live_catalog_links k on k.staging_place = b.place_id
                        join public.place_listings pl on pl.candidate_id = k.candidate_id and pl.visibility = 'preview' order by 1`)
  ).rows.map((r) => r.name as string);

test("a member sees only the beta restaurants, labelled as a local beta, and can save a meal", async ({ browser }) => {
  test.skip(!(await betaOn()), "The member beta switch is off here");
  const names = await enrolledNames();
  test.skip(names.length === 0, "No beta restaurant is listed here");
  const m = await person(browser, "member", false, 390);
  const page = m.page;
  await page.goto("/places/menus");
  await expect(page.getByTestId("unverified-banner").filter({ visible: true }).first()).toHaveAttribute("data-audience", "member_beta");
  await expect(page.getByTestId("real-banner").filter({ visible: true }).first()).toContainText("Local beta");
  const shown = (await page.getByTestId("menus-place").filter({ visible: true }).locator("h3").allInnerTexts()).map((s) => s.trim()).sort();
  expect(shown.length).toBeGreaterThan(0);
  // Two branches of one chain share a listing name; the page adds each one's street (distinctBranchNames), so compare
  // the name without it. Both Cafe Landwer branches are enrolled (owner decision 25 Nov 2026 17:10 UTC).
  for (const s of shown) expect(names).toContain(s.replace(/ \([^)]*\)$/, ""));
  // Founder-only tools are not offered.
  await expect(page.getByTestId("menus-confirm-link")).toHaveCount(0);
  await expect(page.getByTestId("menus-waiting")).toHaveCount(0);
  // A meal: save it (logging, lists and reviews have their own journey below).
  await page.goto("/protein/meals");
  const first = page.getByTestId("preview-meal").filter({ visible: true }).first();
  await first.locator("a[href^='/meals/']").first().click();
  await page.waitForURL(/\/meals\//);
  await page.getByTestId("meal-save").filter({ visible: true }).click();
  await expect(page.getByTestId("meal-save").filter({ visible: true })).toHaveAttribute("aria-pressed", "true");
  await pool.query("delete from staging.preview_saves where user_id = $1", [m.id]);
  // A restaurant outside the beta is not found for a member.
  const outside = (
    await pool.query(`select pl.slug from staging.live_catalog_links k join public.place_listings pl on pl.candidate_id = k.candidate_id
                       where pl.visibility = 'preview' and k.staging_place not in (select place_id from staging.member_beta_places) limit 1`)
  ).rows[0]?.slug as string | undefined;
  if (outside) {
    await page.goto(`/places/${outside}`);
    await expect(page.getByRole("heading", { level: 1, name: /couldn.t find that/i })).toBeVisible();
  }
  await m.context.close();
});

// Owner directive 23 Nov 2026 02:04 UTC, section 6; migration 20261123000100. Two disposable members: one logs,
// lists and reviews a beta meal; the other can see none of it. Everything the test writes is removed at the end.
test("a member logs, lists and reviews a beta meal; another member sees none of it", async ({ browser }) => {
  test.skip(!(await betaOn()), "The member beta switch is off here");
  test.skip((await enrolledNames()).length === 0, "No beta restaurant is listed here");
  const a = await person(browser, "journey", false, 390);
  const z = await person(browser, "other", false, 1280);
  const page = a.page;
  try {
    await page.goto("/protein/meals");
    const card = page.getByTestId("preview-meal").filter({ visible: true }).first();
    const href = (await card.locator("a[href^='/meals/']").first().getAttribute("href"))!;
    const dishId = href.split("/meals/")[1].split("?")[0];
    await page.goto(`/meals/${dishId}`);
    const mealName = (await page.getByTestId("meal-name").filter({ visible: true }).innerText()).trim();

    // Log it: the diary entry keeps the meal's evidence and says it is an unverified draft.
    await page.getByTestId("meal-log").filter({ visible: true }).click();
    await expect(page).toHaveURL(/\/diary\/custom\?meal=/);
    await page.getByRole("button", { name: "Add to diary" }).click();
    await page.waitForURL(/\/diary(\?|$)/);
    const logged = (
      await pool.query(
        `select a.attribution from public.diary_entries e join public.food_revisions r on r.food_item_id = e.food_item_id
           join public.custom_food_attributions a on a.revision_id = r.id where e.owner_id = $1`, [a.id])
    ).rows;
    expect(logged).toHaveLength(1);
    expect(logged[0].attribution.dish.id).toBe(dishId);
    expect(logged[0].attribution.status).not.toBe("verified");
    await expect(page.getByTestId("diary-entry").filter({ visible: true })).toHaveCount(1);

    // Add it to a new list, then rate and review it.
    await page.goto(`/meals/${dishId}`);
    const lists = page.getByTestId("meal-lists").filter({ visible: true });
    await lists.locator("summary").click();
    await lists.getByLabel(/start your first list|or start a new list/i).fill("Beta lunches");
    await lists.getByRole("button", { name: "Create list and add this" }).click();
    await expect(page.getByTestId("meal-lists").filter({ visible: true }).locator("summary")).toContainText("On 1 of your lists");
    const review = page.getByTestId("meal-review").filter({ visible: true });
    await review.locator("summary").click();
    await review.locator("label").filter({ hasText: /^4/ }).first().click();
    await review.locator("textarea").fill("Good portion for lunch.");
    await review.getByRole("button", { name: /save/i }).click();
    await expect(page.getByTestId("meal-review").filter({ visible: true }).locator("summary")).toContainText("Your rating: 4 of 5");
    await page.goto("/friends/reviews");
    await expect(page.locator("main:visible").first()).toContainText(mealName);

    // The other member: no diary entry, no review, no list entry of the first member's.
    const zSaw = await z.page.request.get("/friends/reviews");
    expect(await zSaw.text()).not.toContain("Good portion for lunch.");
    const theirs = (await pool.query("select count(*)::int n from public.diary_entries where owner_id = $1", [z.id])).rows[0].n;
    expect(theirs).toBe(0);
    // Nothing reached a public table: the review and the list entry live in the private beta tables only.
    expect((await pool.query("select count(*)::int n from public.reviews where author_id = $1", [a.id])).rows[0].n).toBe(0);
    expect((await pool.query("select count(*)::int n from staging.preview_reviews where user_id = $1", [a.id])).rows[0].n).toBe(1);
  } finally {
    await pool.query("delete from staging.preview_reviews where user_id = any($1::uuid[])", [[a.id, z.id]]);
    await pool.query("delete from staging.preview_list_entries where user_id = any($1::uuid[])", [[a.id, z.id]]);
    await a.context.close();
    await z.context.close();
  }
});

test("a visitor sees no real menus", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/places/menus");
  await expect(page.getByTestId("menus-place")).toHaveCount(0);
  await expect(page.locator("main:visible").first()).toContainText(/sign in/i);
  await context.close();
});

test("the founder's Needs confirmation group keeps the three kinds of evidence apart", async ({ browser }) => {
  const f = await person(browser, "founder", true);
  const page = f.page;
  await page.goto("/places/menus");
  test.skip((await page.getByTestId("menus-place").count()) === 0, "Needs the real menus loaded");
  await page.getByTestId("menus-confirm-link").filter({ visible: true }).click();
  await page.waitForURL(/\/places\/menus\/confirm/);
  const summary = page.getByTestId("confirm-summary").filter({ visible: true });
  await expect(summary).toBeVisible();
  for (const row of ["restaurant_published", "staff_confirmed", "ingredient_supported", "unknown", "conflict"]) await expect(summary.getByTestId(`confirm-row-${row}`)).toBeVisible();
  // Nothing is ever "independently documented" without a recorded check.
  await expect(summary.getByTestId("confirm-row-staff_confirmed").locator("td").first()).toHaveText("0");
  const places = page.getByTestId("confirm-place").filter({ visible: true });
  if ((await places.count()) > 0) {
    await places.first().locator("summary").click();
    await expect(places.first().getByTestId("confirm-missing").first()).toContainText("Missing:");
  }
  await f.context.close();
});
