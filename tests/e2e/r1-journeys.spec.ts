import { expect, test, type Browser, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { IDS } from "../fixtures/ids";
import { asMember, pool } from "../helpers/db";
import { completeSignIn } from "./helpers";

/**
 * R1: the journeys and edge cases the readiness audit found untested or missing
 * (plans/2026-11-14-integration-readiness-audit.md A1-7 to A1-11):
 *   - J6 travel and missing days, as one continuous journey;
 *   - J8 follow a reviewer, open their list, save an item, review independently;
 *   - the first-run dietary question;
 *   - the warning on saved items that no longer fit a changed dietary filter;
 *   - an expired sign-in and a lost connection.
 * Each checks what was actually saved, after a reload or from the database.
 */
test.use({ timezoneId: "America/New_York", viewport: { width: 360, height: 740 } });
test.setTimeout(120_000);

const email = (label: string) => `r1-${label}-${randomUUID().slice(0, 8)}@example.test`;
const todayIn = (timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const userId = async (who: string) => (await pool.query("select id from auth.users where email = $1", [who])).rows[0].id as string;
const seen = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });

async function signInAt(page: Page, path: string, who: string) {
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await completeSignIn(page, who);
  await expect(page).toHaveURL(new RegExp(path.split("?")[0].replace(/[/]/g, "\\/")));
}
async function logOwnFood(page: Page, name: string, protein: string) {
  await page.goto("/diary/custom");
  await page.getByLabel("What was it?").fill(name);
  await page.getByLabel("Protein (g)", { exact: true }).fill(protein);
  await page.getByRole("button", { name: "Add to diary" }).click();
  await expect(page.getByTestId("diary-flash")).toHaveText("Added to your diary.");
}
async function memberWithProfile(browser: Browser, label: string) {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: "America/New_York" });
  const page = await context.newPage();
  const who = email(label);
  const handle = `${label}_${randomUUID().slice(0, 8)}`;
  await signInAt(page, "/friends/profile", who);
  await page.getByLabel("Handle", { exact: true }).fill(handle);
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByTestId("flash").filter({ hasText: "Profile saved." })).toBeVisible();
  return { context, page, who, handle, id: await userId(who) };
}

test.describe("J6: travel and missing days", () => {
  test("new entries use the new timezone, old ones keep their day, missing days are not judged, and a goal starts on the day it is set", async ({ browser }) => {
    const who = email("travel");
    const home = await browser.newContext({ timezoneId: "Pacific/Honolulu", viewport: { width: 360, height: 740 } });
    const page = await home.newPage();
    await signInAt(page, "/diary", who);
    const honolulu = todayIn("Pacific/Honolulu");
    await logOwnFood(page, "Travel day tofu bowl", "28");
    await expect(page).toHaveURL(new RegExp(`date=${honolulu}`));

    // The same person lands somewhere 23 hours ahead: always a different calendar day.
    const away = await browser.newContext({ timezoneId: "Pacific/Kiritimati", storageState: await home.storageState(), viewport: { width: 360, height: 740 } });
    const there = await away.newPage();
    const kiritimati = todayIn("Pacific/Kiritimati");
    expect(kiritimati).not.toBe(honolulu);
    await there.goto("/diary");
    await there.waitForLoadState("networkidle");
    await expect(there.getByTestId("diary-date")).toHaveText("Today");
    await logOwnFood(there, "Arrival lentil plate", "19");
    await expect(there).toHaveURL(new RegExp(`date=${kiritimati}`));

    // What was saved: each entry on its own local date, with the timezone it was logged in.
    const id = await userId(who);
    const saved = await pool.query(
      `select e.local_date::text as day, e.entry_timezone as tz, s.display_name as name from public.diary_entries e
         join public.diary_snapshots s on s.id = e.current_snapshot_id where e.owner_id = $1 order by e.created_at`,
      [id],
    );
    expect(saved.rows).toEqual([
      { day: honolulu, tz: "Pacific/Honolulu", name: "Travel day tofu bowl" },
      { day: kiritimati, tz: "Pacific/Kiritimati", name: "Arrival lentil plate" },
    ]);

    // After a reload in the new place, the old entry is still on the day it was eaten.
    await there.goto(`/diary?date=${honolulu}`);
    await expect(there.getByTestId("diary-entry")).toContainText("Travel day tofu bowl");
    await expect(there.getByTestId("day-protein")).toHaveText("28 g");
    await there.goto(`/diary?date=${kiritimati}`);
    await expect(there.getByTestId("diary-entry")).toContainText("Arrival lentil plate");
    await expect(there.getByTestId("diary-entry")).not.toContainText("Travel day tofu bowl");

    // A goal chosen today starts today. It is never applied to days before it.
    await asMember(id, (c) => c.query("select public.set_goal('protein_g_per_day', 60, $1)", [kiritimati]), { commit: true });
    for (const day of [...new Set([honolulu, kiritimati])]) {
      await there.goto(`/diary/week?date=${day}`);
      const coverage = seen(there, "week-coverage");
      await expect(coverage).toBeVisible();
      // Only recorded amounts are shown, and the page says how many days they are based on.
      await expect(coverage).toContainText(/You logged food on [12] of 7 days\./);
      // Missing days are neither successes nor failures: no judging words anywhere on the page.
      const text = await there.locator("main").innerText();
      expect(text).not.toMatch(/\b(failed|failure|missed|behind|streak|bad day|cheat)\b/i);
      const goal = (await seen(there, "week-goal-days").innerText()).replace(/\s+/g, " ");
      const api = (await (await there.request.get(`/api/v1/diary/week?date=${day}`)).json()).data;
      const withTarget = (api.days as { date: string; proteinTarget: number | null }[]).filter((d) => d.proteinTarget !== null).map((d) => d.date);
      // No day before the goal was set carries the goal.
      expect(withTarget.every((d) => d >= kiritimati), `days with a goal: ${withTarget.join(", ")}`).toBe(true);
      expect(withTarget.includes(honolulu)).toBe(false);
      if (withTarget.length === 0) expect(goal).toContain("No goal set");
      else expect(goal).toMatch(/\d of \d days?/);
    }
    await home.close();
    await away.close();
  });
});

test.describe("J8: follow a reviewer, open their list, save an item, review independently", () => {
  test("the whole journey on saved data, and nothing private crosses over", async ({ browser }) => {
    const tag = randomUUID().slice(0, 8);
    // A reviewer with a public list of two dishes and a public review (approved, as in the M5 journeys).
    const reviewer = await memberWithProfile(browser, "reviewer");
    await pool.query("insert into public.member_standing (user_id, first_public_approved_at) values ($1, now()) on conflict (user_id) do update set first_public_approved_at = now()", [reviewer.id]);
    const listId = (await asMember(reviewer.id, (c) => c.query("select public.save_list(null, 'Weeknight favourites', null) as r"), { commit: true })).rows[0].r.listId as string;
    await asMember(reviewer.id, (c) => c.query("select public.set_list_items($1, $2, true)", [listId, JSON.stringify([{ kind: "food", id: IDS.tofuStew.item }, { kind: "food", id: IDS.bowl.item }])]), { commit: true });
    await asMember(reviewer.id, (c) => c.query("select public.publish_list($1)", [listId]), { commit: true });
    const review = (await asMember(reviewer.id, (c) => c.query("select public.save_review('food', $1, 5, 'Reviewer loved the stew ' || $2, null, null, true) as r", [IDS.tofuStew.item, tag]), { commit: true })).rows[0].r;
    await asMember(reviewer.id, (c) => c.query("select public.set_review_audience($1, 'public')", [review.reviewId]), { commit: true });

    const reader = await memberWithProfile(browser, "reader");
    const page = reader.page;

    // 1. Follow the reviewer from their profile.
    await page.goto(`/u/${reviewer.handle}`);
    await expect(seen(page, "profile-name")).toBeVisible();
    await seen(page, "rel-follow").click();
    await expect(page.getByTestId("flash").filter({ hasText: "You're following them" })).toBeVisible();
    await expect(seen(page, "profile-counts")).toContainText("1 follower");
    expect((await pool.query("select count(*)::int as n from public.follows where follower_id = $1 and followed_id = $2", [reader.id, reviewer.id])).rows[0].n).toBe(1);

    // 2. Open their public list from the profile.
    await page.goto(`/u/${reviewer.handle}`);
    await seen(page, "list-card").filter({ hasText: "Weeknight favourites" }).getByRole("link").first().click();
    await expect(page).toHaveURL(new RegExp(`/lists/${listId}`));
    await expect(seen(page, "list-title")).toContainText("Weeknight favourites");

    // 3. Open an item on the list and save it. The save is the reader's own and private.
    await seen(page, "list-items").getByRole("link", { name: /soft tofu stew/i }).first().click();
    await expect(page).toHaveURL(new RegExp(`/foods/${IDS.tofuStew.item}`));
    await seen(page, "save-button").click();
    await expect(page).toHaveURL(/saved=saved/);
    await page.goto("/saved");
    await expect(seen(page, "saved-food")).toContainText(/soft tofu stew/i);
    expect((await pool.query("select count(*)::int as n from public.saves where owner_id = $1 and food_item_id = $2", [reader.id, IDS.tofuStew.item])).rows[0].n).toBe(1);

    // 4. Write an independent review with a chosen audience: only me.
    await page.goto(`/review?kind=food&id=${IDS.tofuStew.item}`);
    await page.locator(".rating-pick label").filter({ hasText: /^3Good$/ }).click();
    await page.getByLabel(/What would you tell a friend/).fill("Reader thought it was fine");
    await page.getByRole("radio", { name: /^Only me/ }).check();
    await page.getByRole("button", { name: "Save review" }).click();
    await expect(page).toHaveURL(new RegExp(`/foods/${IDS.tofuStew.item}`));
    const mine = (await pool.query("select rating, audience, publication_state from public.reviews where author_id = $1 and food_item_id = $2", [reader.id, IDS.tofuStew.item])).rows;
    expect(mine).toEqual([{ rating: 3, audience: "private", publication_state: "draft" }]);
    // The reviewer's own review is unchanged by any of this.
    expect((await pool.query("select rating, body from public.reviews where id = $1", [review.reviewId])).rows[0]).toEqual({ rating: 5, body: `Reviewer loved the stew ${tag}` });

    // 5. The reviewer cannot see the reader's save or private review, on any page they can open.
    await reviewer.page.goto(`/foods/${IDS.tofuStew.item}`);
    await expect(seen(reviewer.page, "review").filter({ hasText: `Reviewer loved the stew ${tag}` })).toBeVisible(); // the reviews have arrived
    await reviewer.page.waitForLoadState("networkidle");
    await expect(reviewer.page.locator("main")).not.toContainText("Reader thought it was fine");
    await reviewer.page.goto(`/u/${reader.handle}`);
    await expect(seen(reviewer.page, "profile-name")).toBeVisible();
    await reviewer.page.waitForLoadState("networkidle");
    await expect(reviewer.page.locator("main")).not.toContainText(/Reader thought it was fine|soft tofu stew/i);
    await reviewer.context.close();
    await reader.context.close();
    // Leave no invented reviews behind on the demo dishes for other tests to trip over.
    await pool.query("delete from auth.users where id = any($1::uuid[])", [[reviewer.id, reader.id]]);
  });
});

test.describe("the first-run dietary question (audit A1-9)", () => {
  test("a new member is asked once; 'no filter' is remembered and nothing is assumed", async ({ page }) => {
    const who = email("welcome-none");
    await signInAt(page, "/account", who);
    const welcome = seen(page, "diet-welcome");
    await expect(welcome).toBeVisible();
    await expect(welcome).toContainText("Only you can see your answer");
    // Until they answer, nothing has been saved for them.
    const id = await userId(who);
    expect((await pool.query("select count(*)::int as n from public.user_preferences where user_id = $1", [id])).rows[0].n).toBe(0);
    await seen(page, "diet-welcome-none").click();
    await expect(page).toHaveURL(/\/account/);
    await expect(page.getByTestId("signed-in-as")).toBeVisible();
    await expect(page.getByTestId("diet-welcome")).toHaveCount(0);
    expect((await pool.query("select diet from public.user_preferences where user_id = $1", [id])).rows).toEqual([{ diet: "none" }]);
    // Not asked again, on this page or on Discover, after a reload.
    await page.reload();
    await expect(page.getByTestId("signed-in-as")).toBeVisible();
    await expect(page.getByTestId("diet-welcome")).toHaveCount(0);
    await page.goto("/discover");
    await expect(seen(page, "dish-card").first()).toBeVisible();
    await expect(page.getByTestId("diet-welcome")).toHaveCount(0);
  });

  test("choosing a filter from the question saves it to the account and applies it to results", async ({ page }) => {
    const who = email("welcome-vegan");
    await signInAt(page, "/discover", who);
    await expect(seen(page, "diet-welcome")).toBeVisible();
    await seen(page, "diet-welcome-choose").click();
    await expect(page).toHaveURL(/\/diet\?return=/);
    await page.getByRole("radio", { name: /^Vegan/ }).check();
    await page.getByRole("button", { name: "Apply filter" }).click();
    await expect(page).toHaveURL(/\/discover/);
    await expect(seen(page, "diet-chip")).toContainText("Vegan");
    await expect(page.getByTestId("diet-welcome")).toHaveCount(0);
    expect((await pool.query("select diet from public.user_preferences where user_id = $1", [await userId(who)])).rows).toEqual([{ diet: "vegan" }]);
  });

  test("a signed-out visitor is not asked", async ({ page }) => {
    await page.goto("/discover");
    await expect(seen(page, "dish-card").first()).toBeVisible();
    await expect(page.getByTestId("diet-welcome")).toHaveCount(0);
  });
});

test.describe("saved items after a change of dietary filter (audit A1-10)", () => {
  test("items that no longer fit stay on the list with a clear warning; unknown is never worded as suitable", async ({ page }) => {
    const who = email("saved");
    await signInAt(page, "/saved", who);
    const id = await userId(who);
    // Saved while eating everything: a confirmed-vegan dish, a dairy dish, and one whose ingredients are unconfirmed.
    await pool.query("insert into public.saves (owner_id, food_item_id) select $1, x from unnest($2::uuid[]) x", [id, [IDS.tofuStew.item, IDS.paneerItem, IDS.crispbreadItem]]);
    await asMember(id, (c) => c.query("select public.save_my_diet('none', '{}', false)"), { commit: true });
    await page.goto("/saved");
    await expect(seen(page, "saved-food")).toHaveCount(3);
    await expect(page.getByTestId("saved-mismatch")).toHaveCount(0);
    await expect(page.getByTestId("saved-mismatch-summary")).toHaveCount(0);

    // The member becomes vegan.
    await asMember(id, (c) => c.query("select public.save_my_diet('vegan', '{}', false)"), { commit: true });
    await page.reload();
    // Nothing was removed.
    await expect(seen(page, "saved-food")).toHaveCount(3);
    expect((await pool.query("select count(*)::int as n from public.saves where owner_id = $1", [id])).rows[0].n).toBe(3);
    const row = (name: RegExp) => seen(page, "saved-food").filter({ hasText: name });
    await expect(row(/paneer/i).getByTestId("saved-mismatch")).toHaveAttribute("data-status", "excluded");
    await expect(row(/paneer/i).getByTestId("saved-mismatch")).toContainText("Does not fit your dietary filter");
    await expect(row(/crispbread/i).getByTestId("saved-mismatch")).toHaveAttribute("data-status", "needs_confirmation");
    await expect(row(/crispbread/i).getByTestId("saved-mismatch")).toContainText("Ingredients need confirmation");
    await expect(row(/tofu stew/i).getByTestId("saved-mismatch")).toHaveCount(0);
    await expect(seen(page, "saved-mismatch-summary")).toContainText("2 saved foods do not clearly fit your dietary filter");
    await expect(seen(page, "diet-chip")).toContainText("Vegan");
    await expect(page.locator("main")).not.toContainText(/guaranteed|allergy-safe|safe for/i);

    // Back to no filter: the warnings go, the items are still there.
    await asMember(id, (c) => c.query("select public.save_my_diet('none', '{}', false)"), { commit: true });
    await page.reload();
    await expect(seen(page, "saved-food")).toHaveCount(3);
    await expect(page.getByTestId("saved-mismatch")).toHaveCount(0);
  });
});

test.describe("an expired sign-in and a lost connection (audit A1-11)", () => {
  test("when the sign-in has ended, private pages ask to sign in again, the API refuses, and nothing private is shown", async ({ page, context }) => {
    const who = email("expired");
    await signInAt(page, "/diary", who);
    await logOwnFood(page, "Before the session ended", "12");
    await page.goto("/diary");
    await expect(page.getByTestId("diary-entry")).toContainText("Before the session ended");

    // The sign-in ends (cookies gone), while the page is still open.
    await context.clearCookies();
    const refused = await page.request.post("/api/v1/diary/entries", { data: {}, headers: { origin: "http://localhost:3000" } });
    expect(refused.status()).toBe(401);
    expect((await page.request.get("/api/v1/diary")).status()).toBe(401);

    // Pressing a link or reloading shows a sign-in invitation, never the old diary.
    await page.reload();
    await expect(page.locator("main")).toContainText(/Sign in/);
    await expect(page.locator("main")).not.toContainText("Before the session ended");
    await expect(page.getByRole("link", { name: "Sign in" }).first()).toHaveAttribute("href", /\/login\?next=/);

    // A save pressed with an ended sign-in leads to sign-in and back, and saves nothing by itself.
    await page.goto(`/foods/${IDS.tofuStew.item}`);
    await seen(page, "save-button").click();
    await expect(page).toHaveURL(/\/login\?next=/);
    expect((await pool.query("select count(*)::int as n from public.saves where owner_id = $1", [await userId(who)])).rows[0].n).toBe(0);

    // Signing in again brings the person back to where they were, with their diary intact.
    await completeSignIn(page, who);
    await expect(page).toHaveURL(new RegExp(`/foods/${IDS.tofuStew.item}`));
    await page.goto("/diary");
    await expect(page.getByTestId("diary-entry")).toContainText("Before the session ended");
  });

  test("losing the connection is said in words, and the notice goes when the connection returns", async ({ page, context }) => {
    await page.goto("/discover");
    await expect(seen(page, "dish-card").first()).toBeVisible();
    await expect(page.getByTestId("offline-notice")).toHaveCount(0);
    await context.setOffline(true);
    const notice = page.getByTestId("offline-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("You’re offline");
    await expect(notice).toContainText("changes can’t be saved");
    // Announced to screen readers without stealing focus.
    await expect(page.locator('[role="status"][aria-live="polite"]').filter({ has: notice })).toHaveCount(1);
    await context.setOffline(false);
    await expect(page.getByTestId("offline-notice")).toHaveCount(0);
    // The page still works afterwards.
    await page.goto("/protein");
    await expect(page.locator("main")).toBeVisible();
  });
});
