import { expect, test, type Browser } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";
import { completeSignIn, expectNoSidewaysScroll } from "../e2e/helpers";
import { memberBetaForThisFile, READY_FOR_REVIEW, removeTestSourceReviews, sourceReviewForTest } from "./beta-switch";

/**
 * Founder review of the meals invited testers may see (owner direction 23 Nov 2026 19:34 UTC item 3; migration
 * 20261123000200), on real local data. The founder includes one meal on the private screen; an ordinary member then
 * sees that meal and no other, because the beta runs in the reviewed-meals mode for this file. The switch is on for
 * this file in the test database only. The test removes its own decision rows and accounts' saves afterwards.
 */
test.use({ timezoneId: "America/New_York" });
memberBetaForThisFile(true, "reviewed_meals");
test.setTimeout(180_000);

async function person(browser: Browser, label: string, founder: boolean, width: number) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: "America/New_York" });
  const page = await context.newPage();
  const email = `testers-${label}-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2Ftoday");
  await completeSignIn(page, email);
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
  if (founder) await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher') on conflict do nothing", [id]);
  return { page, context, id };
}

test("the founder includes one meal for testers and a member sees only that meal", async ({ browser }) => {
  const ready = (
    await pool.query(
      `select d.id::text from staging.dishes d where ${READY_FOR_REVIEW}
          and not staging.tester_meal_all_pass(staging.tester_meal_checks(d.id))
          and not staging.tester_meal_included(d.id) order by d.label limit 1`,
    )
  ).rows[0]?.id as string | undefined;
  test.skip(!ready, "No meal is waiting for the founder's source review here");
  const before = Number((await pool.query("select count(*) n from staging.tester_meal_decisions")).rows[0].n);
  const f = await person(browser, "founder", true, 390);
  try {
    // Dimension 1 first (migration 20261125000300): the founder checks the meal against its source in the review queue.
    await f.page.goto(`/places/review/queue?view=all#meal-${ready}`);
    const card = f.page.locator(`#meal-${ready}`);
    await expect(card.getByTestId("rq-dim-source")).toHaveAttribute("data-state", "none");
    await expect(card.getByTestId("rq-dim-diet")).toHaveAttribute("data-state", "published_unreviewed");
    await expect(card.getByTestId("rq-dim-member")).toHaveAttribute("data-state", "not_yet");
    await card.getByTestId("rq-changes").locator("summary").click();
    await expect(card.getByTestId("rq-changes")).toContainText("becomes dietary-confirmed");
    await card.getByTestId("rq-approve-claim").click();
    await expect(f.page.getByTestId("rq-message")).toContainText(/Recorded \d+ fact decisions/, { timeout: 30_000 });
    const reviewed = f.page.locator(`#meal-${ready}`);
    await expect(reviewed.getByTestId("rq-dim-source")).toHaveAttribute("data-state", "complete");
    await expect(reviewed.getByTestId("rq-dim-diet")).toHaveAttribute("data-state", "published_reviewed");
    // Source review never verifies: every one of the founder's decisions is a transcription confirmation.
    expect((await pool.query("select count(*)::int n from staging.facts where dish_id = $1 and status = 'verified'", [ready])).rows[0].n).toBe(0);
    expect((await pool.query("select staging.tester_meal_all_pass(staging.tester_meal_checks($1)) ok", [ready])).rows[0].ok).toBe(true);
    await expect(reviewed.getByTestId("rq-dim-member")).toHaveAttribute("data-state", "eligible");
    await f.page.goto("/places/menus");
    await f.page.getByTestId("menus-testers-link").click();
    await expect(f.page.getByTestId("testers-status")).toContainText("Nothing here is visible to anyone else yet");
    await expect(f.page.getByTestId("testers-summary")).toContainText("of up to 75 meals included");
    await expectNoSidewaysScroll(f.page);
    // The suggested first set opens first: each meal shows its evidence and source, and approve/reject controls.
    await expect(f.page.getByTestId("testers-suggested-help")).toContainText("meals to review");
    // The first set (owner decision 1, 24 Nov 17:45 UTC): at most 30 meals, each saying why it is in it, at most six per restaurant.
    const why = f.page.getByTestId("testers-why");
    const n = await why.count();
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(30);
    await expect(why.first()).toContainText(/#1 in the first set/);
    const first = f.page.getByTestId("testers-meal").first();
    await expect(first.getByTestId("testers-evidence")).toContainText("Restaurant’s own words");
    await expect(first.getByTestId("testers-conflicts")).toContainText(/Conflicts:/);
    // The review pack (owner direction 24 Nov 2026 20:53 UTC, item 1): the set at a glance, where the nutrition comes
    // from, and every drafted fact with its source page, date and automatic comparison. Nothing says verified.
    await expect(f.page.getByTestId("testers-sheet")).toContainText("The restaurant says vegan");
    await expect(first.getByTestId("testers-nutrition")).toContainText(/Nutrition source: .*(printed by the restaurant|USDA estimate|Protein unknown)/);
    await first.getByTestId("testers-facts").locator("summary").click();
    const factRows = first.getByTestId("testers-fact");
    expect(await factRows.count()).toBeGreaterThan(0);
    await expect(factRows.first()).toHaveAttribute("data-compare", /found|not_found|not_checked/);
    await expect(first.getByTestId("testers-facts")).not.toContainText("Verified");
    await expect(first.getByTestId("testers-include")).toHaveText("Approve for testers");
    await f.page.getByTestId("testers-view-ready").click();
    const row = f.page.locator(`[data-testid=testers-meal][data-dish='${ready}']`);
    await row.locator("xpath=ancestor::details").first().evaluate((d) => ((d as HTMLDetailsElement).open = true));
    await expect(row).toHaveAttribute("data-state", "ready");
    await row.getByRole("textbox").fill("Clear vegan label on the restaurant's own menu");
    await row.getByTestId("testers-include").click();
    await expect(f.page.getByTestId("testers-message")).toContainText("Approved for testers");
    await f.page.getByTestId("testers-view-included").click();
    await expect(f.page.locator(`[data-testid=testers-meal][data-dish='${ready}']`)).toHaveAttribute("data-state", "included");
    const d = (await pool.query("select decision, reason, decided_by::text from staging.tester_meal_decisions where dish_id = $1 order by decided_at desc limit 1", [ready])).rows[0];
    expect(d).toEqual({ decision: "include", reason: "Clear vegan label on the restaurant's own menu", decided_by: f.id });
    // Nothing confirmed or published.
    expect(Number((await pool.query("select count(*) n from public.place_listings where visibility = 'public'")).rows[0].n)).toBe(0);

    const m = await person(browser, "member", false, 1440);
    try {
      await m.page.goto(`/meals/${ready}`);
      await expect(m.page.getByTestId("meal-hero").filter({ visible: true })).toBeVisible();
      // Another meal that passes every check but was not included stays hidden from the member.
      const other = (
        await pool.query(
          `select d.id::text from staging.dishes d where d.id <> $1 and staging.tester_meal_all_pass(staging.tester_meal_checks(d.id))
              and not staging.tester_meal_included(d.id) limit 1`,
          [ready],
        )
      ).rows[0]?.id as string | undefined;
      if (other) {
        // The page streams, so check what the member sees: the not-found screen, never the meal.
        await m.page.goto(`/meals/${other}`);
        await expect(m.page.getByRole("heading", { level: 1, name: /couldn.t find that/i })).toBeVisible();
        await expect(m.page.getByTestId("meal-hero").filter({ visible: true })).toHaveCount(0);
      }
    } finally {
      await m.context.close();
    }
    // The founder can take it out again; the member then no longer sees it.
    await f.page.goto(`/places/menus/testers?view=included`);
    const inc = f.page.locator(`[data-testid=testers-meal][data-dish='${ready}']`);
    await inc.locator("xpath=ancestor::details").first().evaluate((d) => ((d as HTMLDetailsElement).open = true));
    await inc.getByTestId("testers-leave-out").click();
    await expect(f.page.getByTestId("testers-message")).toContainText("Rejected");
    expect((await pool.query("select staging.tester_meal_included($1) ok", [ready])).rows[0].ok).toBe(false);
  } finally {
    await f.context.close();
    // Test rows only: the record is append-only for the app, and this removes just what this test added.
    await pool.query("delete from staging.tester_meal_decisions where dish_id = $1 and decided_at > now() - interval '1 hour' and reason in ('Clear vegan label on the restaurant''s own menu', 'Left out by the founder')", [ready]);
    expect(Number((await pool.query("select count(*) n from staging.tester_meal_decisions")).rows[0].n)).toBe(before);
    await removeTestSourceReviews(f.id);
  }
});

test("the founder approves the listed clean meals together; each is still recorded on its own and nothing is verified", async ({ browser }) => {
  const f = await person(browser, "founder", true, 1440);
  const REASON = "Clean meal (every check passes, no conflict); approved by the founder from the listed batch";
  // Source-review a few meals first (test founder, test database), so a batch exists to approve.
  const some = (await pool.query(`select d.id::text from staging.dishes d where ${READY_FOR_REVIEW} and not staging.tester_meal_included(d.id) order by d.label limit 4`)).rows.map((r) => r.id as string);
  await sourceReviewForTest(f.id, some);
  try {
    await f.page.goto("/places/menus/testers");
    const batch = f.page.getByTestId("testers-batch");
    test.skip((await batch.count()) === 0, "Fewer than two clean meals here");
    const n = Number(((await f.page.getByTestId("testers-batch-approve").innerText()).match(/\d+/) ?? ["0"])[0]);
    expect(n).toBeGreaterThan(1);
    expect(n).toBeLessThanOrEqual(30);
    await expect(batch.locator("details li")).toHaveCount(n);
    const verifiedBefore = Number((await pool.query("select count(*) n from staging.facts where status = 'verified'")).rows[0].n);
    await f.page.getByTestId("testers-batch-approve").click();
    await expect(f.page.getByTestId("testers-message")).toContainText(/Approved \d+ clean meals for testers/);
    const rows = (await pool.query("select dish_id, decided_by::text by from staging.tester_meal_decisions where reason = $1 and decided_at > now() - interval '10 minutes'", [REASON])).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(n);
    expect(new Set(rows.map((r) => r.dish_id)).size).toBe(rows.length);
    expect(rows.every((r) => r.by === f.id)).toBe(true);
    // Approving for testers verifies no fact and publishes nothing.
    expect(Number((await pool.query("select count(*) n from staging.facts where status = 'verified'")).rows[0].n)).toBe(verifiedBefore);
    expect(Number((await pool.query("select count(*) n from public.place_listings where visibility = 'public'")).rows[0].n)).toBe(0);
  } finally {
    await f.context.close();
    await pool.query("delete from staging.tester_meal_decisions where reason = $1 and decided_at > now() - interval '1 hour'", [REASON]);
    await removeTestSourceReviews(f.id);
  }
});
