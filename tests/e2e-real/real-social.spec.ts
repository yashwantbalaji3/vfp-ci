import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";
import { completeSignIn, expectNoSidewaysScroll } from "../e2e/helpers";

/**
 * Social with real data and isolated local test accounts (owner direction 22 Nov 2026; docs/68). In real mode (no
 * demo content), a friend follows and befriends the founder and a stranger looks on. A published list of real
 * recipes reaches both. A friends-only review of a real restaurant (founder-only until published), a review of a
 * real meal (an unverified private draft), a meal on a published list and the founder's diary reach nobody. Every account is a
 * local `@example.test` test identity; nothing is sent to anyone. Skips on a fresh test database without the real
 * recipes and menus.
 */
test.use({ timezoneId: "America/New_York" });
test.setTimeout(300_000);

let ready = false;
let recipeA = "";
let recipeB = "";
let mealId = "";
let placeSlug = "";
test.beforeAll(async () => {
  const r = await pool.query(`select id from public.food_items where kind = 'recipe' and not is_demo and status = 'published' order by id limit 2`);
  const m = await pool.query(`select d.id, pl.slug from staging.dishes d join staging.places p on p.id = d.place_id
     join staging.live_catalog_links k on k.staging_place = p.id join public.place_listings pl on pl.candidate_id = k.candidate_id
     where app.preview_meal_ok(d.id)
       -- Not a catering platter: the app leaves those out of meal pages (isGroupPlatter), and ids are random per load.
       and not exists (select 1 from staging.dish_structure s where s.dish_id = d.id
                        and concat_ws(' ', s.section, s.portion_label) ~* '(cater|(serves|feeds) [0-9]{2,}|platters?.*people)')
       -- A founder-only place: the staged member beta (20261122000600) is tested in member-beta-social.spec.ts.
       and p.id not in (select place_id from staging.member_beta_places) order by d.id limit 1`);
  ready = r.rows.length === 2 && m.rows.length === 1;
  if (ready) [recipeA, recipeB, mealId, placeSlug] = [r.rows[0].id, r.rows[1].id, m.rows[0].id, m.rows[0].slug];
});

type Person = { page: Page; context: BrowserContext; email: string; handle: string; id: string; name: string };
const open: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close().catch(() => undefined)));
});
const flash = (page: Page, text: string | RegExp) => page.getByTestId("flash").filter({ hasText: text });
const seen = (page: Page, id: string) => page.getByTestId(id).filter({ visible: true });

async function person(browser: Browser, label: string, name: string, role?: string): Promise<Person> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: "America/New_York" });
  open.push(context);
  const page = await context.newPage();
  const email = `social-${label}-${randomUUID().slice(0, 8)}@example.test`;
  const handle = `${label}_${randomUUID().slice(0, 8)}`;
  await page.goto("/login?next=%2Ffriends%2Fprofile");
  await completeSignIn(page, email);
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
  if (role) await pool.query("insert into public.role_assignments (user_id, role) values ($1, $2) on conflict do nothing", [id, role]);
  // Test shortcut, as in the demo-mode social suite: the first-public-post approval itself is tested there.
  await pool.query("insert into public.member_standing (user_id, first_public_approved_at) values ($1, now()) on conflict (user_id) do update set first_public_approved_at = now()", [id]);
  await page.goto("/friends/profile");
  await page.getByLabel("Handle", { exact: true }).fill(handle);
  await page.getByLabel("Display name (optional)").fill(name);
  await page.getByLabel(/Let people find me/).check();
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(flash(page, "Profile saved.")).toBeVisible();
  return { page, context, email, handle, id, name };
}

async function review(page: Page, kind: "venue" | "food", id: string, rating: number, text: string, audience: "Only me" | "My friends" | "Everyone") {
  await page.goto(`/review?kind=${kind}&id=${id}`);
  const word = ["Poor", "Fair", "Good", "Very good", "Excellent"][rating - 1];
  await page.locator(".rating-pick label").filter({ hasText: new RegExp(`^${rating}${word}$`) }).click();
  await page.getByLabel(/What would you tell a friend/).fill(text);
  await page.getByRole("radio", { name: new RegExp(`^${audience}`) }).check();
  await page.getByRole("button", { name: "Save review" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/review"));
}
async function accessible(page: Page) {
  await page.waitForLoadState("networkidle");
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  await expectNoSidewaysScroll(page);
}

test("real recipes on a published list reach friends and strangers; recipe reviews follow their audience; reviews of real places and meals, listed meals and diaries stay with the founder", async ({ browser }) => {
  test.skip(!ready, "Needs the real recipes and menus loaded");
  const tag = randomUUID().slice(0, 6);
  const founder = await person(browser, "founder", "Fern Founder", "publisher");
  const friend = await person(browser, "friend", "Frankie Friend");
  const stranger = await person(browser, "stranger", "Sam Stranger");

  // Friendship: requested by exact handle, accepted by the founder.
  await friend.page.goto("/friends/people");
  await friend.page.getByLabel("Exact handle").fill(founder.handle);
  await friend.page.getByRole("button", { name: "Find" }).click();
  await seen(friend.page, "people-results").getByRole("link", { name: "View profile" }).click();
  await seen(friend.page, "rel-follow").click();
  await expect(flash(friend.page, "You're following them")).toBeVisible();
  await seen(friend.page, "rel-request").click();
  await expect(flash(friend.page, "Friend request sent")).toBeVisible();
  await founder.page.goto("/friends/people");
  await seen(founder.page, "group-incoming").getByRole("button", { name: `Accept: ${friend.name}` }).click();
  await expect(flash(founder.page, "You're now friends")).toBeVisible();

  // The founder rates a real restaurant (founder-only until it is published) for friends. The audience choice
  // does not widen who may see the place: the review stays with the founder.
  await founder.page.goto(`/places/${placeSlug}`);
  await expect(founder.page.getByTestId("place-social")).toBeVisible();
  const venueId = (await pool.query("select venue_id from public.place_listings where slug = $1", [placeSlug])).rows[0].venue_id as string;
  const placeName = (await founder.page.getByTestId("place-name").textContent())!.trim();
  await review(founder.page, "venue", venueId, 4, `Place note ${tag}`, "My friends");

  // A real restaurant meal (an unverified private draft): saved, reviewed (always private) and put on a list
  // with a real recipe; the list is published.
  await founder.page.goto(`/meals/${mealId}`);
  const mealName = (await founder.page.getByTestId("meal-name").textContent())!.trim();
  await founder.page.getByTestId("meal-review").locator("summary").click();
  await founder.page.getByTestId("meal-review").getByText("Very good").click();
  await founder.page.getByLabel("Notes for yourself (optional)").fill(`Private meal note ${tag}`);
  await founder.page.getByRole("button", { name: "Save review" }).click();
  await expect(flash(founder.page, "Your review is saved. It is private")).toBeVisible();
  const listTitle = `Real lunches ${tag}`;
  await founder.page.getByTestId("meal-lists").locator("summary").click();
  await founder.page.getByLabel(/start (a new|your first) list/i).fill(listTitle);
  await founder.page.getByRole("button", { name: "Create list and add this" }).click();
  await expect(flash(founder.page, "Meal added to your list")).toBeVisible();
  const listId = (await pool.query("select id from public.food_lists where owner_id = $1 and title = $2", [founder.id, listTitle])).rows[0].id as string;
  await founder.page.goto(`/cook/${recipeA}`);
  const sheet = seen(founder.page, "add-to-list");
  await sheet.locator("summary").click();
  await sheet.getByLabel("Choose one of your lists").selectOption({ label: `${listTitle} (private)` });
  await sheet.getByRole("button", { name: "Add to this list" }).click();
  await expect(flash(founder.page, "Added to your list.")).toBeVisible();
  await founder.page.goto(`/cook/${recipeB}`);
  const sheet2 = seen(founder.page, "add-to-list");
  await sheet2.locator("summary").click();
  await sheet2.getByLabel("Choose one of your lists").selectOption({ label: `${listTitle} (private)` });
  await sheet2.getByRole("button", { name: "Add to this list" }).click();
  await expect(flash(founder.page, "Added to your list.")).toBeVisible();
  await founder.page.goto(`/friends/lists/${listId}`);
  await founder.page.getByRole("button", { name: "Publish this list" }).click();
  await expect(flash(founder.page, "Your list is public")).toBeVisible();

  // The founder's diary has an entry; nobody else will see it.
  await founder.page.goto("/diary/custom");
  await founder.page.getByLabel("What was it?").fill(`Diary secret ${tag}`);
  await founder.page.getByLabel("Protein (g)").fill("21");
  await founder.page.getByRole("button", { name: "Add to diary" }).click();
  await founder.page.waitForURL(/\/diary(\?|$)/);

  // The friend: the published list of real recipes is in their Following feed; nothing private is anywhere.
  await friend.page.goto("/friends");
  await expect(seen(friend.page, "feed")).toContainText(listTitle);
  await accessible(friend.page);
  for (const path of ["/friends", "/friends?feed=friends", `/u/${founder.handle}`, `/lists/${listId}`]) {
    await friend.page.goto(path);
    const body = (await friend.page.locator("main").textContent()) ?? "";
    expect(body, path).not.toContain(`Private meal note ${tag}`);
    expect(body, path).not.toContain(mealName);
    expect(body, path).not.toContain(`Diary secret ${tag}`);
    expect(body, path).not.toContain(`Place note ${tag}`);
    expect(body, path).not.toContain(placeName);
  }
  // The published list shows the two recipes to the friend, never the meal.
  await friend.page.goto(`/lists/${listId}`);
  await expect(seen(friend.page, "list-title")).toHaveText(listTitle);
  await expect(seen(friend.page, "list-items").locator(".name a")).toHaveCount(2);

  // The stranger: the published list, nothing else.
  await stranger.page.goto(`/lists/${listId}`);
  await expect(seen(stranger.page, "list-items").locator(".name a")).toHaveCount(2);
  for (const path of [`/u/${founder.handle}`, `/lists/${listId}`, `/meals/${mealId}`]) {
    await stranger.page.goto(path);
    const body = (await stranger.page.locator("body").textContent()) ?? "";
    expect(body, path).not.toContain(`Private meal note ${tag}`);
    expect(body, path).not.toContain(`Diary secret ${tag}`);
    expect(body, path).not.toContain(`Place note ${tag}`);
  }
  // Recipe reviews (migration 20261122000500): ordinary members rate real recipes. The friend's friends-only review
  // reaches the founder's Friends feed and never the stranger; the stranger's public review counts for everyone.
  await review(friend.page, "food", recipeA, 5, `Recipe note ${tag}`, "My friends");
  await founder.page.goto("/friends?feed=friends");
  await expect(seen(founder.page, "feed")).toContainText(`Recipe note ${tag}`);
  await stranger.page.goto(`/cook/${recipeA}`);
  await expect(stranger.page.getByTestId("reviews-section")).toBeVisible();
  await expect(stranger.page.locator("main")).not.toContainText(`Recipe note ${tag}`);
  await review(stranger.page, "food", recipeB, 3, `Public recipe note ${tag}`, "Everyone");
  await friend.page.goto(`/cook/${recipeB}`);
  await expect(friend.page.getByTestId("reviews-section")).toContainText(`Public recipe note ${tag}`);
  await expect(friend.page.getByTestId("rating-summary")).toContainText("Early ratings");
  await accessible(friend.page);

  // A real meal's page is founder-only: the stranger gets no meal at all.
  await stranger.page.goto(`/meals/${mealId}`);
  await expect(stranger.page.getByTestId("meal-name")).toHaveCount(0);
  await accessible(stranger.page);
});
