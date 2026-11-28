import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { IDS, M4 } from "../fixtures/ids";
import { asMember, pool } from "../helpers/db";
import { completeSignIn, expectNoSidewaysScroll, setDiet } from "./helpers";

/**
 * M5 acceptance in a real browser: the nine journeys in
 * plans/2026-11-14-m5-implementation-plan.md (docs/14 T-SOCIAL), each on saved data
 * with real sign-ins for every person involved. Also: honest empty states, clearly
 * marked demo content, account deletion, keyboard use, small and wide screens and
 * accessibility scans. Local production build and local Supabase only.
 *
 * Set M5_SHOTS=<folder> to save review screenshots along the way.
 */
test.use({ timezoneId: "America/New_York", viewport: { width: 360, height: 740 } });
test.setTimeout(150_000);

const SHOTS = process.env.M5_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};
const DISH = { bowl: IDS.bowl.item, tofuStew: IDS.tofuStew.item, idli: IDS.idli.item, tempeh: IDS.tempehBowl.item, toast: IDS.mushroomToastItem, eggNoodles: IDS.eggNoodlesItem, dosa: IDS.dosa.item, bibimbap: IDS.bibimbap.item };
const VENUE = { central: IDS.venueCentral, davis: IDS.venueDavis, backBay: IDS.venueBackBay, harvard: IDS.venueHarvard, allston: IDS.venueAllston };

type Member = { page: Page; context: BrowserContext; email: string; handle: string; id: string };
const open: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close().catch(() => undefined)));
});
// The database pool is shared by every browser test file in a run, so it is never closed here:
// closing it broke whichever file ran next (found in R1, AUD-D4). It closes when the run ends.

const flash = (page: Page, text: string | RegExp) => page.getByTestId("flash").filter({ hasText: text });
const seen = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });
const api = async (page: Page, path: string) => (await (await page.request.get(path)).json()).data;
const summaryCount = async (page: Page, kind: "venue" | "food", id: string) => (await api(page, `/api/v1/reviews?kind=${kind}&id=${id}`)).summary.count as number;

async function signIn(page: Page, email: string, path: string) {
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await completeSignIn(page, email);
  await expect(page).toHaveURL(new RegExp(path.split("?")[0].replace(/[/]/g, "\\/")));
}
const userId = async (email: string) => (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;

/** A signed-in person in their own browser window, with a profile unless told otherwise. */
async function newMember(browser: Browser, label: string, o: { profile?: boolean; approved?: boolean; findable?: boolean; name?: string } = {}): Promise<Member> {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: "America/New_York" });
  open.push(context);
  const page = await context.newPage();
  const email = `m5-${label}-${randomUUID().slice(0, 8)}@example.test`;
  const handle = `${label}_${randomUUID().slice(0, 8)}`;
  await signIn(page, email, "/friends/profile");
  const id = await userId(email);
  if (o.profile !== false) {
    await page.getByLabel("Handle", { exact: true }).fill(handle);
    await page.getByLabel("Display name (optional)").fill(o.name ?? `${label[0].toUpperCase()}${label.slice(1)} Tester`);
    if (o.findable !== false) await page.getByLabel(/Let people find me/).check();
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(flash(page, "Profile saved.")).toBeVisible();
  }
  if (o.approved) await approve(id);
  return { page, context, email, handle, id };
}
/** Test shortcut: mark a member as already having an approved public post (the approval flow itself is tested in journey 2). */
const approve = (id: string) =>
  pool.query("insert into public.member_standing (user_id, first_public_approved_at) values ($1, now()) on conflict (user_id) do update set first_public_approved_at = now()", [id]);
const giveRole = (id: string, role: string) => pool.query("insert into public.role_assignments (user_id, role) values ($1, $2) on conflict do nothing", [id, role]);

async function writeReview(page: Page, kind: "venue" | "food", id: string, rating: number, text: string | null, audience: "Only me" | "My friends" | "Everyone") {
  await page.goto(`/review?kind=${kind}&id=${id}`);
  const word = ["Poor", "Fair", "Good", "Very good", "Excellent"][rating - 1];
  await page.locator(".rating-pick label").filter({ hasText: new RegExp(`^${rating}${word}$`) }).click();
  if (text !== null) await page.getByLabel(/What would you tell a friend/).fill(text);
  await page.getByRole("radio", { name: new RegExp(`^${audience}`) }).check();
  await page.getByRole("button", { name: "Save review" }).click();
  await expect(page).toHaveURL(new RegExp(kind === "venue" ? `/venues/${id}` : `/foods/${id}`));
}
async function expectAccessible(page: Page) {
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`), `accessibility problems on ${page.url()}`).toEqual([]);
}

test.describe("someone with no account, or no followers yet", () => {
  test("a guest sees an honest invitation, labelled editorial collections, and no invented activity", async ({ page }) => {
    await page.goto("/friends");
    await expect(seen(page, "social-signin")).toContainText("See what people you trust are eating");
    await expect(seen(page, "collections")).toContainText("Put together by our team, not by other members");
    await expect(seen(page, "collections").getByTestId("list-card").first()).toContainText("Editorial collection · chosen by our team");
    await expect(page.getByTestId("feed")).toHaveCount(0);
    await expectAccessible(page);
    await expectNoSidewaysScroll(page);
    await shot(page, "01-friends-guest");
    // A guest sees a rating summary but writing a review needs an account.
    await page.goto(`/venues/${VENUE.harvard}`);
    await expect(seen(page, "rating-summary")).toContainText(/out of 5, the average of \d+ public ratings/);
    await expect(seen(page, "rating-summary")).toContainText("Early ratings");
    await seen(page, "write-review").click();
    await expect(page).toHaveURL(/\/login\?next=/);
  });

  test("a new member sees empty feeds explained, people to follow marked as demo, and nothing fabricated", async ({ browser }) => {
    const a = await newMember(browser, "fresh");
    await a.page.goto("/friends");
    await expect(seen(a.page, "feed-empty")).toContainText("You’re not following anyone yet");
    await expect(seen(a.page, "feed-empty")).toContainText("we don’t fill this page with made-up activity");
    await expect(a.page.getByTestId("recommendations")).toHaveCount(0);
    // Suggestions are only people who chose to be findable and have public reviews, with that as the stated reason.
    await expect(seen(a.page, "suggested-people")).toContainText("Members who chose to be findable and have shared public reviews");
    await expect(seen(a.page, "suggested-people").locator("li").first()).toContainText(/\d+ public reviews?/);
    await expectAccessible(a.page);
    await shot(a.page, "02-following-empty");
    await a.page.getByRole("navigation", { name: "Which feed" }).filter({ visible: true }).getByRole("link", { name: "Friends" }).click();
    await expect(seen(a.page, "feed-empty")).toContainText("No posts from friends yet");
    await expect(seen(a.page, "feed-explainer")).toContainText("A friendship exists only after both of you agree");
    for (const path of ["/friends/reviews", "/friends/ranking", "/friends/lists", "/friends/people"]) {
      await a.page.goto(path);
      await expect(a.page.locator("main h1").filter({ visible: true })).toBeVisible();
      await expectAccessible(a.page);
      await expectNoSidewaysScroll(a.page);
    }
    await a.page.goto("/friends/reviews");
    await expect(seen(a.page, "reviews-empty")).toContainText("No reviews yet");
  });
});

test.describe("journey 1: set up a profile", () => {
  test("choose a handle, stay unfindable, then decide to be findable; tastes and diet stay private until switched on", async ({ browser }) => {
    const a = await newMember(browser, "prof", { profile: false });
    const b = await newMember(browser, "seeker");
    await a.page.goto("/friends");
    await expect(seen(a.page, "profile-needed")).toContainText("Set up your profile");
    await a.page.goto("/friends/profile");
    await expectAccessible(a.page);
    await shot(a.page, "03-profile-setup");
    // A bad handle is refused in plain words.
    await a.page.getByLabel("Handle", { exact: true }).fill("ab");
    await a.page.getByLabel("Handle", { exact: true }).evaluate((el: HTMLInputElement) => el.removeAttribute("pattern"));
    await a.page.getByLabel("Handle", { exact: true }).evaluate((el: HTMLInputElement) => el.removeAttribute("minlength"));
    await a.page.getByRole("button", { name: "Save profile" }).click();
    await expect(seen(a.page, "flash-error")).toContainText("A handle uses 3 to 30");
    await a.page.getByLabel("Handle", { exact: true }).fill(a.handle);
    await a.page.getByLabel("Display name (optional)").fill("Priya Tester");
    await a.page.getByLabel("About you (optional)").fill("Always after a good dosa.");
    await a.page.getByLabel("Tastes (optional)").fill("spicy, south indian");
    await a.page.getByRole("button", { name: "Save profile" }).click();
    await expect(flash(a.page, "Profile saved.")).toBeVisible();
    await setDiet(a.context, "vegan");

    // Not findable yet: an exact search finds nothing, and no friend request can be sent.
    await b.page.goto(`/friends/people?q=${a.handle}`);
    await expect(seen(b.page, "people-results")).toContainText(`No findable member has the handle @${a.handle}`);
    // The profile shows name and about text, but not tastes or diet.
    await b.page.goto(`/u/${a.handle}`);
    await expect(seen(b.page, "profile-name")).toHaveText("Priya Tester");
    await expect(b.page.getByText("Always after a good dosa.")).toBeVisible();
    await expect(b.page.getByTestId("profile-tastes")).toHaveCount(0);
    await expect(b.page.getByTestId("rel-request")).toHaveCount(0);
    await expect(seen(b.page, "relationship")).toContainText("accepts friend requests only from people they follow");

    await a.page.goto("/friends/profile");
    await a.page.getByLabel(/Let people find me/).check();
    await a.page.getByLabel(/Show my tastes/).check();
    await a.page.getByRole("button", { name: "Save profile" }).click();
    await expect(flash(a.page, "Profile saved.")).toBeVisible();
    await b.page.goto(`/friends/people?q=@${a.handle.toUpperCase()}`);
    await expect(seen(b.page, "people-results")).toContainText("Priya Tester");
    await seen(b.page, "people-results").getByRole("link", { name: "View profile" }).click();
    await expect(seen(b.page, "profile-tastes")).toContainText("south indian, spicy");
    await expect(seen(b.page, "profile-tastes")).not.toContainText("Diet");
    await expect(seen(b.page, "rel-request")).toBeVisible();
    await expectAccessible(b.page);
    await shot(b.page, "04-profile-seen-by-another");
    // Saved for real: the API returns the same switches.
    const mine = await api(a.page, "/api/v1/profile");
    expect(mine.profile).toMatchObject({ handle: a.handle, discoverable: true, showTastes: true, showDiet: false });
  });
});

test.describe("journey 2: review a dish privately, then make it public", () => {
  test("private first; a new member's first public post waits for a moderator and counts only once approved", async ({ browser }) => {
    const a = await newMember(browser, "critic");
    const b = await newMember(browser, "reader");
    const mod = await newMember(browser, "mod");
    await giveRole(mod.id, "moderator");
    const words = `Crisp tempeh and plenty of it. Would order again ${randomUUID().slice(0, 6)}.`;
    const before = await summaryCount(b.page, "food", DISH.tempeh);

    await a.page.goto(`/foods/${DISH.tempeh}`);
    await seen(a.page, "write-review").click();
    await expect(seen(a.page, "review-target")).toHaveText("Demo tempeh rice bowl");
    await expect(a.page.getByText("You're rating this dish only, not Demo Central Kitchen as a whole.")).toBeVisible();
    await expectAccessible(a.page);
    await shot(a.page, "05-review-form");
    await writeReview(a.page, "food", DISH.tempeh, 4, words, "Only me");
    await expect(flash(a.page, "Only you can see this review.")).toBeVisible();
    await expect(seen(a.page, "reviews-section")).toContainText("Only you can see this");
    await b.page.goto(`/foods/${DISH.tempeh}`);
    await expect(seen(b.page, "reviews-section")).not.toContainText(words);

    // Make it public: the form says who will see it and that a first post is checked.
    await a.page.goto(`/foods/${DISH.tempeh}`);
    await seen(a.page, "edit-review").click();
    await expect(a.page.getByText("Because this would be your first public post, a moderator checks it before it appears.")).toBeVisible();
    await a.page.getByRole("radio", { name: /^Everyone/ }).check();
    await a.page.getByRole("button", { name: "Save review" }).click();
    await expect(flash(a.page, "A moderator checks a new member's first public post")).toBeVisible();
    await expect(seen(a.page, "reviews-section")).toContainText("Waiting for a moderator’s check");
    await shot(a.page, "06-review-waiting");
    await b.page.reload();
    await expect(seen(b.page, "reviews-section")).not.toContainText(words);
    expect(await summaryCount(b.page, "food", DISH.tempeh)).toBe(before);

    // A second public post by the same new member also waits.
    await writeReview(a.page, "venue", VENUE.central, 5, `Second post ${words}`, "Everyone");
    await expect(flash(a.page, "A moderator checks")).toBeVisible();

    await mod.page.goto("/moderation");
    const item = seen(mod.page, "mod-item").filter({ hasText: words }).filter({ hasText: "Demo tempeh rice bowl" });
    await expect(item).toContainText("This member has no approved public post yet");
    await expectAccessible(mod.page);
    await shot(mod.page, "07-moderation-queue");
    await item.getByRole("button", { name: "Approve" }).click();
    await expect(flash(mod.page, "Decision recorded.")).toBeVisible();
    // Approving one did not publish the other.
    await expect(seen(mod.page, "mod-item").filter({ hasText: `Second post ${words}` })).toBeVisible();
    await b.page.goto(`/venues/${VENUE.central}`);
    await expect(seen(b.page, "reviews-section")).not.toContainText(words);

    await b.page.goto(`/foods/${DISH.tempeh}`);
    await expect(seen(b.page, "reviews-section")).toContainText(words);
    expect(await summaryCount(b.page, "food", DISH.tempeh)).toBe(before + 1);
    await shot(b.page, "08-dish-reviews");
    // The restaurant's own rating is a separate thing and did not change.
    await expect(seen(b.page, "reviews-section")).toContainText("These rate this dish only");
  });

  test("review text is shown as plain text and never runs", async ({ browser }) => {
    const a = await newMember(browser, "text", { approved: true });
    const b = await newMember(browser, "viewer");
    const marker = `x${randomUUID().slice(0, 8)}`;
    await writeReview(a.page, "food", DISH.idli, 3, `<img src=x onerror="window.${marker}=1"><b>bold</b> ${marker}`, "Everyone");
    await expect(flash(a.page, "Your review is public.")).toBeVisible();
    await b.page.goto(`/foods/${DISH.idli}`);
    const card = seen(b.page, "review").filter({ hasText: marker });
    await expect(card).toContainText('<img src=x onerror="window.');
    await expect(card.locator("img, b")).toHaveCount(0);
    expect(await b.page.evaluate((m) => (window as unknown as Record<string, unknown>)[m], marker)).toBeUndefined();
  });
});

test.describe("journeys 3 and 4: follow someone, add a friend, remove a friend", () => {
  test("following shows public posts only; friendship needs acceptance and unlocks friends-only posts until it ends", async ({ browser }) => {
    const a = await newMember(browser, "author", { approved: true, name: "Asha Author" });
    const b = await newMember(browser, "fan", { name: "Bo Fan" });
    const tag = randomUUID().slice(0, 6);
    await writeReview(a.page, "food", DISH.tofuStew, 5, `Public stew note ${tag}`, "Everyone");
    await writeReview(a.page, "venue", VENUE.harvard, 4, `Friends only note ${tag}`, "My friends");
    await expect(flash(a.page, "shared with your friends only")).toBeVisible();

    // Journey 3: open a public review, tap the author, follow.
    await b.page.goto(`/foods/${DISH.tofuStew}`);
    await seen(b.page, "review").filter({ hasText: `Public stew note ${tag}` }).getByRole("link", { name: "Asha Author" }).click();
    await expect(seen(b.page, "profile-name")).toHaveText("Asha Author");
    await expect(seen(b.page, "profile-reviews")).not.toContainText("Friends only note");
    await seen(b.page, "rel-follow").click();
    await expect(flash(b.page, "You're following them")).toBeVisible();
    await expect(seen(b.page, "profile-counts")).toContainText("1 follower");
    // Their next public review appears in Following.
    await writeReview(a.page, "food", DISH.bowl, 5, `Next public post ${tag}`, "Everyone");
    await b.page.goto("/friends");
    await expect(seen(b.page, "feed")).toContainText(`Next public post ${tag}`);
    await expect(seen(b.page, "feed")).toContainText(`Public stew note ${tag}`);
    await expect(seen(b.page, "feed")).not.toContainText("Friends only note");
    await expect(seen(b.page, "recommendations")).toContainText("Asha Author rated this 5 out of 5");
    await expectAccessible(b.page);
    await shot(b.page, "09-following-feed");
    // Following is not friendship: the Friends feed is still empty.
    await b.page.goto("/friends?feed=friends");
    await expect(seen(b.page, "feed-empty")).toBeVisible();

    // Journey 4: exact-handle search, request, accept.
    await b.page.goto("/friends/people");
    await b.page.getByLabel("Exact handle").fill(a.handle);
    await b.page.getByRole("button", { name: "Find" }).click();
    await seen(b.page, "people-results").getByRole("link", { name: "View profile" }).click();
    await seen(b.page, "rel-request").click();
    await expect(flash(b.page, "Friend request sent. Nothing is shared until they accept.")).toBeVisible();
    await b.page.goto("/friends?feed=friends");
    await expect(seen(b.page, "feed-empty")).toBeVisible();

    await a.page.goto("/friends");
    await expect(a.page.getByText("You have 1 friend request.")).toBeVisible();
    await a.page.goto("/friends/people");
    await expect(seen(a.page, "group-incoming")).toContainText("Bo Fan");
    await shot(a.page, "10-people-requests");
    await seen(a.page, "group-incoming").getByRole("button", { name: "Accept: Bo Fan" }).click();
    await expect(flash(a.page, "You're now friends")).toBeVisible();
    await expect(seen(a.page, "group-friends")).toContainText("Bo Fan");
    await expect(seen(a.page, "group-followers")).toContainText("Bo Fan");
    await expectAccessible(a.page);

    await b.page.goto("/friends?feed=friends");
    await expect(seen(b.page, "feed")).toContainText(`Friends only note ${tag}`);
    await expect(seen(b.page, "feed").getByTestId("review").filter({ hasText: "Friends only note" })).toContainText("Shared with friends only");
    await shot(b.page, "11-friends-feed");
    await b.page.goto(`/venues/${VENUE.harvard}`);
    await expect(seen(b.page, "reviews-section")).toContainText(`Friends only note ${tag}`);

    // Remove the friend: the friends-only post disappears at once, on the feed and on the page.
    await b.page.goto(`/u/${a.handle}`);
    await seen(b.page, "rel-unfriend").click();
    await expect(flash(b.page, "Friends-only posts are no longer shared")).toBeVisible();
    await b.page.goto("/friends?feed=friends");
    await expect(seen(b.page, "feed-empty")).toBeVisible();
    await b.page.goto(`/venues/${VENUE.harvard}`);
    await expect(seen(b.page, "reviews-section")).not.toContainText("Friends only note");
    // Still following, so public posts remain in Following.
    await b.page.goto("/friends");
    await expect(seen(b.page, "feed")).toContainText(`Next public post ${tag}`);
  });
});

test.describe("journey 5: rank your restaurants", () => {
  test("reorder three reviewed places, share a fixed copy, then withdraw it (keyboard only for the reordering)", async ({ browser }) => {
    const a = await newMember(browser, "ranker", { approved: true, name: "Rae Ranker" });
    const b = await newMember(browser, "looker");
    await a.page.goto("/friends/ranking");
    await expect(seen(a.page, "ranking-empty")).toContainText("You can rank a restaurant once you've reviewed it");
    for (const v of [VENUE.central, VENUE.davis, VENUE.allston]) await writeReview(a.page, "venue", v, 4, null, "Only me");
    await a.page.goto("/friends/ranking");
    const ranked = () => seen(a.page, "ranking").locator(".name a");
    const names = ["Demo Allston Dosa Corner", "Demo Central Kitchen", "Demo Davis Noodle Bar"];
    for (const [i, name] of names.entries()) {
      await seen(a.page, "unranked").getByRole("button", { name: `Add to ranking: ${name}` }).click();
      await expect(ranked()).toHaveText(names.slice(0, i + 1));
    }
    await expect(flash(a.page, "Order saved.")).toBeVisible();
    // Keyboard only: move Davis to the top, one place at a time.
    for (const expected of [
      ["Demo Allston Dosa Corner", "Demo Davis Noodle Bar", "Demo Central Kitchen"],
      ["Demo Davis Noodle Bar", "Demo Allston Dosa Corner", "Demo Central Kitchen"],
    ]) {
      await a.page.getByRole("button", { name: "Move up: Demo Davis Noodle Bar" }).focus();
      await a.page.keyboard.press("Enter");
      await expect(ranked()).toHaveText(expected);
    }
    await expect(a.page.getByRole("button", { name: "Move up: Demo Davis Noodle Bar" })).toBeDisabled();
    await expect(seen(a.page, "ranking-unpublished")).toBeVisible();
    await b.page.goto(`/u/${a.handle}`);
    await expect(b.page.getByTestId("ranking-card")).toHaveCount(0);

    await a.page.getByRole("button", { name: "Publish this order" }).click();
    await expect(flash(a.page, "published as a fixed copy")).toBeVisible();
    await expectAccessible(a.page);
    await shot(a.page, "12-ranking");
    await b.page.reload();
    await expect(seen(b.page, "ranking-card").locator(".name a")).toHaveText(["Demo Davis Noodle Bar", "Demo Allston Dosa Corner", "Demo Central Kitchen"]);
    await expect(seen(b.page, "ranking-card")).toContainText("It is not a star rating");
    // A later private change does not alter the published copy.
    await a.page.getByRole("button", { name: "Move down: Demo Davis Noodle Bar" }).click();
    await expect(ranked()).toHaveText(["Demo Allston Dosa Corner", "Demo Davis Noodle Bar", "Demo Central Kitchen"]);
    await expect(seen(a.page, "ranking-publication")).toContainText("Your private order has changed since");
    await b.page.reload();
    await expect(seen(b.page, "ranking-card").locator(".name a").first()).toHaveText("Demo Davis Noodle Bar");
    // The private reviews behind the ranking are still private.
    await expect(b.page.getByTestId("profile-reviews")).toHaveCount(0);

    await a.page.getByRole("button", { name: "Withdraw the published copy" }).click();
    await expect(flash(a.page, "withdrawn")).toBeVisible();
    await b.page.reload();
    await expect(b.page.getByTestId("ranking-card")).toHaveCount(0);
    expect((await api(a.page, "/api/v1/ranking")).entries.map((e: { name: string }) => e.name)).toEqual(["Demo Allston Dosa Corner", "Demo Davis Noodle Bar", "Demo Central Kitchen"]);
  });
});

test.describe("journey 6: build and share a list", () => {
  test("two dishes, a place and a recipe; publish; open the link signed out; unpublish and the link stops working", async ({ browser }) => {
    const a = await newMember(browser, "lister", { approved: true, name: "Lee Lister" });
    const guestContext = await browser.newContext({ viewport: { width: 360, height: 740 } });
    open.push(guestContext);
    const guest = await guestContext.newPage();
    const title = `Best high-protein lunches ${randomUUID().slice(0, 5)}`;

    await a.page.goto("/friends/lists");
    await expect(seen(a.page, "lists-empty")).toBeVisible();
    await a.page.getByLabel("Title").fill(title);
    await a.page.getByRole("button", { name: "Create private list" }).click();
    await expect(flash(a.page, "It is private until you publish it")).toBeVisible();
    await expect(seen(a.page, "list-empty")).toBeVisible();
    await expect(a.page.getByRole("button", { name: "Publish this list" })).toBeDisabled();
    const listUrl = new URL(a.page.url()).pathname;
    const publicUrl = listUrl.replace("/friends/lists/", "/lists/");

    for (const path of [`/foods/${DISH.bowl}`, `/foods/${DISH.tofuStew}`, `/venues/${VENUE.harvard}`, `/cook/${M4.recipe(M4.chana)}`]) {
      await a.page.goto(path);
      const sheet = seen(a.page, "add-to-list");
      await sheet.locator("summary").click();
      await sheet.getByLabel("Choose one of your lists").selectOption({ label: `${title} (private)` });
      await sheet.getByRole("button", { name: "Add to this list" }).click();
      await expect(flash(a.page, "Added to your list.")).toBeVisible();
    }
    await a.page.goto(listUrl);
    await expect(seen(a.page, "list-items").locator(".name a")).toHaveText(["Demo chickpea power bowl", "Demo soft tofu stew", "Demo Harvard Tofu House", "Demo chana masala"]);
    // Private: a guest and the public page get nothing.
    await guest.goto(publicUrl);
    await expect(guest.getByTestId("list-title")).toHaveCount(0);
    await expect(guest.getByText(title)).toHaveCount(0);

    // Reorder: move the recipe to the top.
    for (const at of [2, 1, 0]) {
      await a.page.getByRole("button", { name: "Move up: Demo chana masala" }).click();
      await expect(seen(a.page, "list-items").locator(".name a").nth(at)).toHaveText("Demo chana masala");
    }
    await expect(flash(a.page, "List saved.")).toBeVisible();
    await a.page.getByRole("button", { name: "Publish this list" }).click();
    await expect(flash(a.page, "Your list is public")).toBeVisible();
    await expect(seen(a.page, "public-link")).toBeVisible();
    await expectAccessible(a.page);
    await shot(a.page, "13-list-manage");

    await guest.goto(publicUrl);
    await expect(seen(guest, "list-title")).toHaveText(title);
    await expect(seen(guest, "list-items").locator(".name a")).toHaveText(["Demo chana masala", "Demo chickpea power bowl", "Demo soft tofu stew", "Demo Harvard Tofu House"]);
    await expect(guest.getByText("Lee Lister")).toBeVisible();
    await expect(guest.getByRole("button", { name: /Move up|Remove|Publish/ })).toHaveCount(0);
    await expectAccessible(guest);
    await expectNoSidewaysScroll(guest);
    await shot(guest, "14-list-public-signed-out");

    await a.page.getByRole("button", { name: "Make private again" }).click();
    await expect(flash(a.page, "Your list is private again.")).toBeVisible();
    await guest.reload();
    await expect(guest.getByTestId("list-title")).toHaveCount(0);
    await expect(guest.getByText(title)).toHaveCount(0);
    expect((await guest.request.get(`/api/v1/lists?id=${publicUrl.split("/").pop()}`)).status()).toBe(404);
  });
});

test.describe("journey 7: stay safe", () => {
  test("blocking hides two people from each other; a reported review is removed by a moderator and leaves the page and the average", async ({ browser }) => {
    const a = await newMember(browser, "poster", { approved: true, name: "Pat Poster" });
    const b = await newMember(browser, "blocker", { approved: true, name: "Bea Blocker" });
    const mod = await newMember(browser, "guard");
    await giveRole(mod.id, "moderator");
    const tag = randomUUID().slice(0, 6);
    await writeReview(a.page, "venue", VENUE.backBay, 1, `Buy cheap watches at my site ${tag}`, "Everyone");
    await writeReview(b.page, "food", DISH.dosa, 5, `Bea's dosa note ${tag}`, "Everyone");
    await b.page.goto(`/u/${a.handle}`);
    await seen(b.page, "rel-follow").click();
    await expect(flash(b.page, "You're following them")).toBeVisible();

    // Report first (while B can still see it).
    await b.page.goto(`/venues/${VENUE.backBay}`);
    const before = await summaryCount(b.page, "venue", VENUE.backBay);
    const card = seen(b.page, "review").filter({ hasText: `cheap watches at my site ${tag}` });
    await card.locator("summary", { hasText: "Report" }).click();
    await card.getByLabel("What is wrong?").selectOption("spam");
    await card.getByLabel(/Anything to add/).fill("Advertising, not a review");
    await card.getByRole("button", { name: "Send report" }).click();
    await expect(flash(b.page, "Thank you. A moderator will look at this.")).toBeVisible();
    await shot(b.page, "15-report-sent");

    // Block: neither can see the other any more.
    await b.page.goto(`/u/${a.handle}`);
    await b.page.locator("summary", { hasText: "Block" }).click();
    await b.page.getByRole("button", { name: "Block Pat Poster" }).click();
    await expect(flash(b.page, "Blocked.")).toBeVisible();
    await expect(seen(b.page, "group-blocked")).toContainText("Pat Poster");
    await expect(seen(b.page, "group-following")).not.toContainText("Pat Poster");
    await shot(b.page, "16-blocked");
    for (const [viewer, target] of [[b, a], [a, b]] as const) {
      await viewer.page.goto(`/u/${target.handle}`);
      await expect(viewer.page.getByTestId("profile-name")).toHaveCount(0);
      expect((await viewer.page.request.get(`/api/v1/users/${target.handle}`)).status()).toBe(404);
    }
    await a.page.goto(`/foods/${DISH.dosa}`);
    await expect(seen(a.page, "reviews-section")).not.toContainText(`Bea's dosa note ${tag}`);
    await b.page.goto(`/venues/${VENUE.backBay}`);
    await expect(seen(b.page, "reviews-section")).not.toContainText("cheap watches");
    await b.page.goto("/friends");
    await expect(b.page.getByText("cheap watches")).toHaveCount(0);

    // Moderator: sees the report without the reporter's name, removes with a reason.
    await mod.page.goto("/moderation");
    const report = seen(mod.page, "mod-report").filter({ hasText: `cheap watches at my site ${tag}` });
    await expect(report).toContainText("Spam or advertising");
    await expect(report).toContainText("Advertising, not a review");
    await expect(report).not.toContainText("Bea Blocker");
    await report.getByRole("button", { name: "Remove" }).click();
    await expect(seen(mod.page, "flash-error")).toContainText("Write a short reason");
    await seen(mod.page, "mod-report").filter({ hasText: `cheap watches at my site ${tag}` }).getByLabel(/Reason/).fill("Advertising");
    await seen(mod.page, "mod-report").filter({ hasText: `cheap watches at my site ${tag}` }).getByRole("button", { name: "Remove" }).click();
    await expect(flash(mod.page, "Decision recorded.")).toBeVisible();
    await expect(seen(mod.page, "mod-log")).toContainText("Removed · Review");
    await expect(seen(mod.page, "mod-log")).toContainText("Advertising");
    await shot(mod.page, "17-moderation-after-removal");

    await mod.page.goto(`/venues/${VENUE.backBay}`);
    await expect(seen(mod.page, "reviews-section")).not.toContainText("cheap watches");
    expect(await summaryCount(mod.page, "venue", VENUE.backBay)).toBe(before - 1);
    // The author is told; sharing it again needs a new check.
    await a.page.goto("/friends/reviews");
    await expect(seen(a.page, "my-reviews")).toContainText("Removed by a moderator");
    // Someone who is not a moderator cannot open the queue.
    await a.page.goto("/moderation");
    await expect(seen(a.page, "moderation-denied")).toBeVisible();
    expect((await a.page.request.get("/api/v1/moderation")).status()).toBe(403);
  });
});

test.describe("journey 8: the reader's dietary filter", () => {
  test("a vegan reader sees confirmed dishes by default, unknown ones only under Needs confirmation, and never dishes that contain egg", async ({ browser }) => {
    const a = await newMember(browser, "eater", { approved: true, name: "Eli Eater" });
    const b = await newMember(browser, "vegan");
    const tag = randomUUID().slice(0, 6);
    await writeReview(a.page, "food", DISH.bowl, 5, `Confirmed vegan bowl ${tag}`, "Everyone");
    await writeReview(a.page, "food", DISH.toast, 5, `Unknown toast ${tag}`, "Everyone");
    await writeReview(a.page, "food", DISH.eggNoodles, 5, `Egg noodles ${tag}`, "Everyone");
    await a.page.goto("/friends/lists");
    await a.page.getByLabel("Title").fill(`Mixed list ${tag}`);
    await a.page.getByRole("button", { name: "Create private list" }).click();
    await expect(flash(a.page, "It is private until you publish it")).toBeVisible();
    const listId = new URL(a.page.url()).pathname.split("/").pop()!;
    const patch = await a.page.request.patch("/api/v1/lists", {
      data: { listId, items: [{ kind: "food", id: DISH.bowl }, { kind: "food", id: DISH.toast }, { kind: "food", id: DISH.eggNoodles }, { kind: "venue", id: VENUE.central }], visibility: "public" },
    });
    expect(patch.status(), await patch.text()).toBe(200);

    await b.page.goto(`/u/${a.handle}`);
    await seen(b.page, "rel-follow").click();
    await expect(flash(b.page, "You're following them")).toBeVisible();
    // Without a filter everything public is there.
    await b.page.goto("/friends");
    await expect(seen(b.page, "feed")).toContainText(`Egg noodles ${tag}`);

    // Vegan, saved to the account through the filter page.
    await b.page.goto("/diet?return=/friends");
    await b.page.getByRole("radio", { name: /^Vegan/ }).check();
    await b.page.getByRole("button", { name: /Save|Apply/ }).click();
    await expect(b.page).toHaveURL(/\/friends/);
    const feed = seen(b.page, "feed");
    await expect(feed).toContainText(`Confirmed vegan bowl ${tag}`);
    await expect(feed).not.toContainText(`Unknown toast ${tag}`);
    await expect(feed).not.toContainText(`Egg noodles ${tag}`);
    await expect(b.page.getByRole("link", { name: /Needs confirmation \(1\)/ })).toBeVisible();
    const recs = seen(b.page, "recommendations");
    await expect(recs).toContainText("Demo chickpea power bowl");
    await expect(recs).not.toContainText("Demo mushroom toast");
    await expect(recs).not.toContainText("Demo egg noodle stir-fry");
    await shot(b.page, "18-feed-vegan");

    await b.page.getByRole("link", { name: /Needs confirmation \(1\)/ }).click();
    await expect(b.page.getByText("These dishes are not confirmed to fit your filter.")).toBeVisible();
    await expect(seen(b.page, "feed")).toContainText(`Unknown toast ${tag}`);
    await expect(seen(b.page, "feed")).toContainText("Not confirmed for your filter");
    await expect(seen(b.page, "feed")).not.toContainText(`Egg noodles ${tag}`);
    await expect(seen(b.page, "feed")).not.toContainText(`Confirmed vegan bowl ${tag}`);
    await expectAccessible(b.page);
    await shot(b.page, "19-feed-needs-confirmation");

    // The same rule on the profile and on the shared list.
    await b.page.goto(`/u/${a.handle}`);
    await expect(seen(b.page, "profile-reviews")).toContainText(`Confirmed vegan bowl ${tag}`);
    await expect(seen(b.page, "profile-reviews")).not.toContainText("Egg noodles");
    await expect(seen(b.page, "profile-reviews")).not.toContainText("Unknown toast");
    await b.page.goto(`/lists/${listId}`);
    await expect(seen(b.page, "list-items").locator(".name a")).toHaveText(["Demo chickpea power bowl", "Demo Central Kitchen"]);
    await expect(seen(b.page, "list-hidden-note")).toContainText("1 item is always hidden for your filter");
    await b.page.getByRole("link", { name: /Needs confirmation \(1\)/ }).click();
    await expect(seen(b.page, "list-items").locator(".name a")).toHaveText(["Demo mushroom toast"]);
    await expect(b.page.getByText("Demo egg noodle stir-fry")).toHaveCount(0);
    await shot(b.page, "20-list-needs-confirmation");
  });
});

test.describe("journey 9: privacy proof", () => {
  test("a friend, a follower, a stranger and a moderator get nothing from a member's diary, goals, foods, plan or cooking", async ({ browser }) => {
    const owner = await newMember(browser, "owner", { approved: true, name: "Olu Owner" });
    const friend = await newMember(browser, "friend", { name: "Fay Friend" });
    const follower = await newMember(browser, "follower");
    const stranger = await newMember(browser, "stranger");
    const mod = await newMember(browser, "watch");
    await giveRole(mod.id, "moderator");
    const secret = `Secret protein bar ${randomUUID().slice(0, 6)}`;
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const as = (sql: string, params: unknown[]) => asMember(owner.id, (c) => c.query(sql, params), { commit: true });
    await as("select public.log_new_custom_food($1, $2, null, $3, '1 bar', 40, 1, 'home', 'snack', $4, 'America/New_York')", [randomUUID(), secret, JSON.stringify({ protein_g: 12, energy_kcal: 180 }), today]);
    await as("select public.set_goal('protein_g_per_day', 87, $1)", [today]);
    const cook = await as("select public.start_cook_session($1, $2, 2, '{}', $3, 'America/New_York', null, true) as r", [randomUUID(), M4.recipe(M4.dal), today]);
    await as("select public.complete_cook_session($1, $2, 'America/New_York')", [cook.rows[0].r.sessionId, today]);
    await as("select public.plan_recipe($1, $2, 2, 'dinner', true)", [M4.recipe(M4.scramble), today]);
    await writeReview(owner.page, "food", DISH.bowl, 4, "Public bowl review by Olu", "Everyone");

    for (const p of [friend, follower]) {
      await p.page.goto(`/u/${owner.handle}`);
      await seen(p.page, "rel-follow").click();
      await expect(flash(p.page, "You're following them")).toBeVisible();
    }
    await friend.page.goto(`/u/${owner.handle}`);
    await seen(friend.page, "rel-request").click();
    // Wait until the request is saved before the owner looks for it (without this the owner's page
    // could load first and never show the Accept button: the CI timeout seen twice on 15-16 Nov).
    await expect(flash(friend.page, "Friend request sent. Nothing is shared until they accept.")).toBeVisible();
    await owner.page.goto("/friends/people");
    await seen(owner.page, "group-incoming").getByRole("button", { name: "Accept: Fay Friend" }).click();
    await expect(flash(owner.page, "You're now friends")).toBeVisible();

    // The owner really has the data.
    const exportOf = async (page: Page) => (await page.request.get("/api/v1/me/export")).json();
    const mine = await exportOf(owner.page);
    expect(JSON.stringify(mine)).toContain(secret);
    expect(mine.goals.length).toBeGreaterThan(0);
    expect(mine.cookSessions.length).toBeGreaterThan(0);
    expect(mine.social.reviews.length).toBe(1);

    for (const [who, p] of [["friend", friend], ["follower", follower], ["stranger", stranger], ["moderator", mod]] as const) {
      await p.page.goto(`/u/${owner.handle}`);
      await expect(seen(p.page, "profile-name")).toHaveText("Olu Owner");
      // Let everything that is going to arrive on the page arrive first: this is a "must not appear" check,
      // and reading early would pass for the wrong reason.
      await p.page.waitForLoadState("networkidle");
      const body = (await p.page.locator("main").filter({ visible: true }).innerText()).toLowerCase();
      for (const word of [secret.toLowerCase(), "protein bar", "goal", "dal", "scramble", "kcal", "cooked", "planned"]) {
        expect(body, `${who} sees "${word}" on the profile`).not.toContain(word);
      }
      // The goal number on its own: the owner's handle and email carry random letters and digits,
      // which can include "87" (as in "owner_e8d9875d"), so only a standalone 87 counts.
      const shown = body.replaceAll(owner.handle.toLowerCase(), "");
      expect(shown, `${who} sees the goal number 87 on the profile`).not.toMatch(/(^|[^0-9a-z])87([^0-9a-z]|$)/);
      const profile = JSON.stringify(await api(p.page, `/api/v1/users/${owner.handle}`)).toLowerCase();
      for (const word of [secret.toLowerCase(), "goal", "diary", "nutrient", "cook", "plan"]) expect(profile, `${who} API has "${word}"`).not.toContain(word);
      // Their own private areas hold nothing of the owner's.
      expect((await api(p.page, "/api/v1/diary")).entries).toEqual([]);
      expect(JSON.stringify(await exportOf(p.page))).not.toContain(secret);
      expect(JSON.stringify(await api(p.page, "/api/v1/cook-sessions"))).not.toContain("dal");
      await p.page.goto("/friends?feed=friends");
      await expect(p.page.getByText(secret)).toHaveCount(0);
    }
    const queue = JSON.stringify(await api(mod.page, "/api/v1/moderation")).toLowerCase();
    expect(queue).not.toContain(secret.toLowerCase());
    await shot(friend.page, "21-profile-seen-by-friend");
  });
});

test.describe("demo content is always marked", () => {
  test("demo accounts, their reviews and the editorial collections say so wherever they appear", async ({ browser }) => {
    const a = await newMember(browser, "demo");
    await a.page.goto("/u/demo_maya");
    await expect(seen(a.page, "demo-profile")).toContainText("It is not a real person, and its reviews never count toward real ratings");
    await expect(seen(a.page, "profile-reviews").getByTestId("review").first()).toContainText("Demo account, not a real person");
    await expect(seen(a.page, "ranking-card")).toContainText("Demo Harvard Tofu House");
    await expectAccessible(a.page);
    await shot(a.page, "22-demo-profile");
    await a.page.goto("/lists/00000000-0000-4000-8000-000000520002");
    await expect(a.page.getByText("Editorial collection · chosen by our team")).toBeVisible();
    await expect(a.page.getByText("This list was invented for testing.")).toBeVisible();
    await shot(a.page, "23-editorial-collection");
    // Real averages leave demo accounts out: the database function with demo off counts none of them.
    const real = await pool.query("select app.rating_summary($1, null, false) as s", [VENUE.harvard]);
    const all = await pool.query("select app.rating_summary($1, null, true) as s", [VENUE.harvard]);
    expect(all.rows[0].s.count - real.rows[0].s.count).toBe(2);
  });
});

test.describe("staff screens", () => {
  test("a curator decides a member's correction; it is recorded and the page itself does not change", async ({ browser }) => {
    const member = await newMember(browser, "fixer");
    const curator = await newMember(browser, "curator");
    await giveRole(curator.id, "curator");
    const note = `The address moved to 12 Example Street ${randomUUID().slice(0, 6)}`;
    await asMember(member.id, (c) => c.query("select public.submit_correction(null, $1, 'other', $2, null)", [VENUE.davis, note]), { commit: true });
    await member.page.goto("/moderation/corrections");
    await expect(seen(member.page, "corrections-denied")).toBeVisible();
    await curator.page.goto("/account");
    await seen(curator.page, "staff-links").getByRole("link", { name: "Corrections" }).click();
    const item = seen(curator.page, "corrections-open").locator("li.post").filter({ hasText: note });
    await expect(item).toContainText("Demo Davis Noodle Bar");
    await expectAccessible(curator.page);
    await shot(curator.page, "24-corrections");
    await item.getByLabel(/Note/).fill("Checked by phone");
    await item.getByRole("button", { name: "Accept" }).click();
    await expect(flash(curator.page, "Nothing in the catalog changes until an editor updates it")).toBeVisible();
    await expect(seen(curator.page, "corrections-decided")).toContainText("Checked by phone");
    const row = await pool.query("select state, decided_by from public.corrections where proposed_value = $1", [note]);
    expect(row.rows[0]).toEqual({ state: "accepted", decided_by: curator.id });
  });
});

test.describe("account deletion", () => {
  test("a member with a diary, own food, goals, cooking and social content deletes their account from the Account page", async ({ browser }) => {
    const a = await newMember(browser, "leaver", { approved: true, name: "Lou Leaver" });
    const b = await newMember(browser, "stays");
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const as = (sql: string, params: unknown[]) => asMember(a.id, (c) => c.query(sql, params), { commit: true });
    await as("select public.log_new_custom_food($1, 'Leaver bar', null, $2, '1 bar', 40, 1, 'home', 'snack', $3, 'America/New_York')", [randomUUID(), JSON.stringify({ protein_g: 9 }), today]);
    await as("select public.set_goal('protein_g_per_day', 70, $1)", [today]);
    const tag = randomUUID().slice(0, 6);
    await writeReview(a.page, "venue", VENUE.allston, 5, `Leaving soon ${tag}`, "Everyone");
    const before = await summaryCount(b.page, "venue", VENUE.allston);

    await a.page.goto("/account");
    await seen(a.page, "delete-account-link").click();
    await expect(a.page.getByText("What is deleted, for good")).toBeVisible();
    await expectAccessible(a.page);
    await shot(a.page, "25-delete-account");
    await a.page.getByLabel("Type DELETE to confirm").fill("delete");
    await a.page.getByRole("button", { name: "Delete my account and all my data" }).click();
    await expect(seen(a.page, "flash-error")).toContainText("Type DELETE in capital letters");
    // An old sign-in is refused and explained.
    await pool.query("update auth.users set last_sign_in_at = now() - interval '20 minutes' where id = $1", [a.id]);
    await a.page.getByLabel("Type DELETE to confirm").fill("DELETE");
    await a.page.getByRole("button", { name: "Delete my account and all my data" }).click();
    await expect(seen(a.page, "flash-error")).toContainText("needs a fresh sign-in");
    await pool.query("update auth.users set last_sign_in_at = now() where id = $1", [a.id]);
    await a.page.getByLabel("Type DELETE to confirm").fill("DELETE");
    await a.page.getByRole("button", { name: "Delete my account and all my data" }).click();
    await expect(seen(a.page, "account-deleted")).toContainText("You are signed out on this browser");
    await shot(a.page, "26-account-deleted");

    expect((await pool.query("select 1 from auth.users where id = $1", [a.id])).rowCount).toBe(0);
    expect((await pool.query("select count(*)::int as n from public.food_items where owner_id = $1", [a.id])).rows[0].n).toBe(0);
    expect((await pool.query("select count(*)::int as n from public.reviews where author_id = $1", [a.id])).rows[0].n).toBe(0);
    expect((await a.page.request.get("/api/v1/me")).status()).toBe(401);
    await a.page.goto("/account");
    await expect(a.page.getByText("You’re not signed in.")).toBeVisible();
    // Their rating no longer counts and their review is gone for others.
    expect(await summaryCount(b.page, "venue", VENUE.allston)).toBe(before - 1);
    await b.page.goto(`/venues/${VENUE.allston}`);
    await expect(seen(b.page, "reviews-section")).not.toContainText(`Leaving soon ${tag}`);
    await b.page.goto(`/u/${a.handle}`);
    await expect(b.page.getByTestId("profile-name")).toHaveCount(0);
  });
});

test.describe("small and wide screens", () => {
  test("the social screens reflow at 320 px and use the wide layout at 1280 px", async ({ browser }) => {
    const a = await newMember(browser, "sizes", { approved: true });
    await writeReview(a.page, "venue", VENUE.harvard, 4, "A reasonably long review so the card has several lines of text to wrap at narrow widths.", "Everyone");
    const pages = ["/friends", "/friends/people", "/friends/profile", "/friends/reviews", "/friends/ranking", "/friends/lists", `/review?kind=venue&id=${VENUE.harvard}`, "/u/demo_maya", "/lists/00000000-0000-4000-8000-000000520002", `/venues/${VENUE.harvard}`, "/account/delete"];
    await a.page.setViewportSize({ width: 320, height: 640 });
    for (const path of pages) {
      await a.page.goto(path);
      await a.page.waitForLoadState("networkidle");
      await expectNoSidewaysScroll(a.page);
    }
    await a.page.setViewportSize({ width: 1280, height: 900 });
    for (const path of pages) {
      await a.page.goto(path);
      await a.page.waitForLoadState("networkidle");
      await expectNoSidewaysScroll(a.page);
    }
    await a.page.goto("/friends");
    await expect(a.page.locator(".side").filter({ visible: true }).getByRole("link", { name: "Friends & Lists" })).toHaveAttribute("aria-current", "page");
    await expectAccessible(a.page);
    await shot(a.page, "27-friends-desktop");
    await a.page.goto("/u/demo_maya");
    await shot(a.page, "28-profile-desktop");
  });
});
