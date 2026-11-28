import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { IDS, M4 } from "../fixtures/ids";
import { asMember, pool } from "../helpers/db";
import { completeSignIn, expectNoSidewaysScroll, setDiet } from "./helpers";

/**
 * R2 acceptance in a real browser (plans/2026-11-14-integration-readiness-audit.md,
 * R2 tests 1 to 7, and docs/14 PH-02): real sign-ins for a member, a curator, a
 * publisher and a moderator. Local production build and local Supabase only.
 *
 * Everything these tests enter is practice (demo) data. Whatever they create in
 * the shared catalog is removed again at the end so that other test files see
 * the seeded catalog exactly as before.
 *
 * Set R2_SHOTS=<folder> to save review screenshots along the way.
 */
test.use({ timezoneId: "America/New_York", viewport: { width: 360, height: 740 } });
test.setTimeout(240_000);

const SHOTS = process.env.R2_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};

type Member = { page: Page; context: BrowserContext; email: string; handle: string; id: string };
const open: BrowserContext[] = [];
const madeFoods = new Set<string>();
const madeVenues = new Set<string>();
const flaggedFoods = new Set<string>();
test.afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close().catch(() => undefined)));
});
// Leave the shared catalog as it was found. The pool itself is shared by every browser test file and is never closed here.
test.afterAll(async () => {
  if (flaggedFoods.size) await pool.query("delete from public.review_flags where food_item_id = any($1::uuid[])", [[...flaggedFoods]]);
  await pool.query("delete from public.catalog_changes where state in ('draft', 'submitted') and (summary like 'R2 test%' or summary is null) and created_at > now() - interval '1 hour'");
  if (madeFoods.size) await pool.query("delete from public.food_items where id = any($1::uuid[])", [[...madeFoods]]);
  const names = await pool.query("select fr.food_item_id from public.food_revisions fr join public.food_items fi on fi.id = fr.food_item_id where fr.name like 'R2 test %' and fi.visibility = 'public'");
  if (names.rowCount) await pool.query("delete from public.food_items where id = any($1::uuid[])", [names.rows.map((r) => r.food_item_id)]);
  if (madeVenues.size) await pool.query("delete from public.venues where id = any($1::uuid[])", [[...madeVenues]]);
  await pool.query("delete from public.venues where name like 'R2 test %'");
  await pool.query("delete from public.catalog_changes where food_item_id is null and venue_id is null and state in ('rejected', 'withdrawn') and created_at > now() - interval '1 hour'");
});

const flash = (page: Page, text: string | RegExp) => page.getByTestId("flash").filter({ hasText: text });
const flashError = (page: Page, text: string | RegExp) => page.getByTestId("flash-error").filter({ hasText: text });
const seen = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

async function signIn(page: Page, email: string, path: string) {
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await completeSignIn(page, email);
  await expect(page).toHaveURL(new RegExp(path.split("?")[0].replace(/[/]/g, "\\/")));
}
const userId = async (email: string) => (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;

/** A signed-in person in their own browser window with a public profile, and any staff roles named. */
async function newMember(browser: Browser, label: string, roles: string[] = [], o: { approved?: boolean } = {}): Promise<Member> {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: "America/New_York" });
  open.push(context);
  const page = await context.newPage();
  const email = `r2-${label}-${randomUUID().slice(0, 8)}@example.test`;
  const handle = `${label}_${randomUUID().slice(0, 8)}`;
  await signIn(page, email, "/friends/profile");
  const id = await userId(email);
  await page.getByLabel("Handle", { exact: true }).fill(handle);
  await page.getByLabel("Display name (optional)").fill(`${label[0].toUpperCase()}${label.slice(1)} Tester`);
  await page.getByLabel(/Let people find me/).check();
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(flash(page, "Profile saved.")).toBeVisible();
  for (const role of roles) await pool.query("insert into public.role_assignments (user_id, role) values ($1, $2) on conflict do nothing", [id, role]);
  if (o.approved) {
    await pool.query("insert into public.member_standing (user_id, first_public_approved_at) values ($1, now()) on conflict (user_id) do update set first_public_approved_at = now()", [id]);
  }
  return { page, context, email, handle, id };
}

async function expectAccessible(page: Page) {
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`), `accessibility problems on ${page.url()}`).toEqual([]);
}

/** One serving of a catalog food in the member's private diary, logged through the screen. */
async function logFood(page: Page, foodItemId: string) {
  await page.goto(`/diary/log?food=${foodItemId}`);
  await page.getByRole("button", { name: "Add to diary" }).click();
  await expect(page.getByTestId("diary-flash")).toHaveText("Added to your diary.");
}
const POST = { origin: "http://localhost:3000", "content-type": "application/json" };

const changeIdOf = (page: Page) => page.url().match(/\/editor\/changes\/([0-9a-f-]{36})/)![1];

async function fillSource(page: Page, who: string, says: string) {
  await page.getByLabel("Who says so").fill(who);
  await page.getByLabel("Kind of source").selectOption("operator_statement");
  await page.getByLabel("Date you saw or heard it").fill(today());
  await page.getByLabel("What the source says, in your own words").fill(says);
}
async function approve(page: Page, changeId: string) {
  await page.goto(`/editor/changes/${changeId}`);
  const form = seen(page, "review-form");
  await form.getByLabel(/I looked at the source myself/).check();
  await form.getByLabel(/Nothing here is copied/).check();
  await form.getByRole("button", { name: "Approve and publish" }).click();
  await expect(flash(page, "Checked and published.")).toBeVisible();
}

/** A place and a vegan dish entered by the curator and checked by the publisher, through the screens. */
async function enterPlaceAndDish(curator: Member, publisher: Member, tag: string) {
  const placeName = `R2 test Kitchen ${tag}`;
  const dishName = `R2 test Tofu Plate ${tag}`;
  await curator.page.goto("/editor/new");
  await seen(curator.page, "new-place").getByRole("button").click();
  await expect(flash(curator.page, "Draft started. Nothing public has changed.")).toBeVisible();
  const placeChange = changeIdOf(curator.page);
  await fillSource(curator.page, "The owner, by phone (invented for this test)", "Confirmed the name and address.");
  await curator.page.getByLabel("One line for the person who will check this").fill("R2 test: a new practice place");
  await curator.page.getByLabel("Name", { exact: true }).fill(placeName);
  await curator.page.getByLabel("Neighbourhood").fill("Test Square");
  await curator.page.getByLabel("Street").fill("1 Example Street");
  await curator.page.getByLabel("Town or city").fill("Boston");
  await curator.page.getByLabel("State").fill("MA");
  await curator.page.getByRole("button", { name: "Save and send for checking" }).click();
  await expect(flash(curator.page, "Sent for checking.")).toBeVisible();
  await approve(publisher.page, placeChange);
  const venueId = (await pool.query("select id from public.venues where name = $1", [placeName])).rows[0].id as string;
  madeVenues.add(venueId);

  await curator.page.goto("/editor/new");
  const form = seen(curator.page, "new-dish");
  await form.getByLabel("Place", { exact: true }).selectOption({ label: placeName });
  await form.getByLabel(/Name of the dish/).fill(dishName);
  await form.getByRole("button").click();
  await expect(flash(curator.page, "Draft started.")).toBeVisible();
  const dishChange = changeIdOf(curator.page);
  const foodItemId = (await pool.query("select food_item_id from public.catalog_changes where id = $1", [dishChange])).rows[0].food_item_id as string;
  madeFoods.add(foodItemId);
  return { placeName, dishName, venueId, placeChange, dishChange, foodItemId };
}

async function fillVeganDish(page: Page, protein: string) {
  await fillSource(page, "The cook, in person (invented for this test)", "Says the plate has no egg, dairy or honey and gave the protein figure from their recipe card.");
  await page.getByLabel("One line for the person who will check this").fill("R2 test: a new practice dish");
  await page.getByLabel("Description, in our own words").fill("Grilled tofu with rice and greens. Invented for testing.");
  await page.getByLabel("Vegan", { exact: true }).selectOption("compatible");
  await page.getByLabel("Vegetarian", { exact: true }).selectOption("compatible");
  for (const family of ["Egg", "Dairy", "Honey"]) await page.getByLabel(family, { exact: true }).selectOption("absent_by_statement");
  await page.getByLabel("Protein", { exact: false }).first().fill(protein);
}

test.describe("who can open the staff screens", () => {
  test("guests and ordinary members are refused on every page and API; staff pages are never cached or indexed", async ({ browser, page }) => {
    const member = await newMember(browser, "plain");
    const moderator = await newMember(browser, "modonly", ["moderator"]);
    const curator = await newMember(browser, "curonly", ["curator"]);
    const anyId = randomUUID();
    const editorPages = ["/editor", "/editor/items", "/editor/new", `/editor/changes/${anyId}`, "/moderation/corrections"];
    for (const path of editorPages) {
      const res = await page.goto(path);
      expect(res!.headers()["cache-control"], path).toContain("no-store");
      expect(res!.headers()["x-robots-tag"], path).toContain("noindex");
      await expect(page.getByRole("link", { name: "Sign in" }).filter({ visible: true }).first(), `guest at ${path}`).toBeVisible();
      await expect(page.getByTestId("staff-nav")).toHaveCount(0);
      for (const who of [member, moderator]) {
        await who.page.goto(path);
        await expect(who.page.getByTestId(path === "/moderation/corrections" ? "corrections-denied" : "staff-denied").filter({ visible: true }), `${who.handle} at ${path}`).toBeVisible();
        await expect(who.page.getByTestId("change-form")).toHaveCount(0);
      }
    }
    for (const who of [member, curator]) {
      await who.page.goto(`/moderation/members/${member.handle}`);
      await expect(seen(who.page, "staff-denied")).toBeVisible();
      await who.page.goto("/moderation");
      await expect(seen(who.page, "moderation-denied")).toBeVisible();
    }
    // The same through the API: 401 for a guest, 403 for a member without the role.
    for (const path of ["/api/v1/editor", `/api/v1/editor/changes/${anyId}`, `/api/v1/moderation/members/${member.handle}`]) {
      const guest = await page.request.get(path);
      expect(guest.status(), `guest ${path}`).toBe(401);
      expect(guest.headers()["cache-control"]).toContain("no-store");
      expect((await member.page.request.get(path)).status(), `member ${path}`).toBe(403);
    }
    expect((await moderator.page.request.get("/api/v1/editor")).status()).toBe(403);
    expect((await curator.page.request.get(`/api/v1/moderation/members/${member.handle}`)).status()).toBe(403);
    expect((await member.page.request.post(`/api/v1/editor/changes/${anyId}`, { headers: POST, data: { action: "approve", sourceChecked: true, rightsOk: true } })).status()).toBe(403);
    expect((await member.page.request.post(`/api/v1/moderation/members/${curator.handle}`, { headers: POST, data: { suspend: true, reason: "no" } })).status()).toBe(403);
    // And straight at the database, as the Data API would: no rows, and the functions refuse.
    for (const who of [null, member.id]) {
      for (const table of ["catalog_changes", "review_flags"]) {
        await expect(asMember(who, (c) => c.query(`select * from public.${table}`)), `${who ?? "guest"} reading ${table}`).rejects.toThrow(/permission denied/);
      }
    }
    await expect(asMember(member.id, (c) => c.query("select public.editor_desk()"))).rejects.toThrow(/FORBIDDEN|NOT_EDITOR|permission denied/);
    await expect(asMember(member.id, (c) => c.query("select public.member_history($1)", [curator.handle]))).rejects.toThrow(/FORBIDDEN|NOT_MODERATOR|permission denied/);
    // A member sees no staff links; staff see only their own.
    await member.page.goto("/account");
    await expect(seen(member.page, "signed-in-as")).toBeVisible();
    await expect(member.page.getByTestId("staff-links")).toHaveCount(0);
    await curator.page.goto("/account");
    await expect(seen(curator.page, "staff-links")).toContainText("Editors’ desk");
    await expect(seen(curator.page, "staff-links").getByRole("link", { name: "Moderation", exact: true })).toHaveCount(0);
  });
});

test.describe("entering, checking and correcting", () => {
  test("a place and a dish go public only after a second person checks them; an accepted correction changes nothing until a sourced change is checked; a flagged dish leaves the filters at once", async ({ browser }) => {
    const curator = await newMember(browser, "curator", ["curator"]);
    const publisher = await newMember(browser, "publisher", ["publisher"]);
    const member = await newMember(browser, "eater");
    const guest = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: "America/New_York" });
    open.push(guest);
    const visitor = await guest.newPage();
    await setDiet(guest, "vegan");
    const tag = randomUUID().slice(0, 6);

    // --- Enter a place and a dish (R2 test 2: one person alone is refused) ---
    await curator.page.goto("/editor");
    await expect(seen(curator.page, "practice-note")).toContainText("Practice mode");
    await expectAccessible(curator.page);
    await expectNoSidewaysScroll(curator.page);
    await shot(curator.page, "01-editors-desk");
    await curator.page.goto("/editor/new");
    await expectAccessible(curator.page);
    await shot(curator.page, "02-enter-something-new");
    const made = await enterPlaceAndDish(curator, publisher, tag);
    await visitor.goto(`/venues/${made.venueId}`);
    await expect(seen(visitor, "venue-name")).toHaveText(made.placeName);
    await expect(visitor.locator("main")).toContainText("Demo");

    await curator.page.goto(`/editor/changes/${made.dishChange}`);
    await expectAccessible(curator.page);
    await expectNoSidewaysScroll(curator.page);
    // Sending without a source is refused in plain words.
    await curator.page.getByLabel("One line for the person who will check this").fill("R2 test: a new practice dish");
    await curator.page.getByRole("button", { name: "Save and send for checking" }).click();
    await expect(seen(curator.page, "flash-error")).toBeVisible();
    await fillVeganDish(curator.page, "21");
    await shot(curator.page, "03-dish-draft");
    await curator.page.getByRole("button", { name: "Save and send for checking" }).click();
    await expect(flash(curator.page, "A second person must check it before anything public changes.")).toBeVisible();
    await expect(curator.page.getByText("You entered this, so a different person has to check it.")).toBeVisible();
    await expect(curator.page.getByTestId("review-form")).toHaveCount(0);
    await shot(curator.page, "04-waiting-for-second-person");
    // Not public yet.
    expect((await visitor.goto(`/foods/${made.foodItemId}`))!.status()).toBe(404);
    // The author cannot approve their own entry, even by calling the API or the database directly.
    const own = await curator.page.request.post(`/api/v1/editor/changes/${made.dishChange}`, { headers: POST, data: { action: "approve", sourceChecked: true, rightsOk: true } });
    expect(own.status()).toBe(403);
    await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher')", [curator.id]);
    const ownAsPublisher = await curator.page.request.post(`/api/v1/editor/changes/${made.dishChange}`, { headers: POST, data: { action: "approve", sourceChecked: true, rightsOk: true } });
    expect(ownAsPublisher.status()).toBe(403);
    expect((await ownAsPublisher.json()).error.code).toBe("SECOND_PERSON_REQUIRED");
    await pool.query("delete from public.role_assignments where user_id = $1 and role = 'publisher'", [curator.id]);
    expect((await pool.query("select status from public.food_items where id = $1", [made.foodItemId])).rows[0].status).not.toBe("published");

    // The second person: ticks are required, then it is published.
    await publisher.page.goto("/editor");
    await seen(publisher.page, "desk-to-check").getByRole("link", { name: made.dishName }).click();
    await expect(seen(publisher.page, "change-compare")).toContainText("Suitable");
    await expect(seen(publisher.page, "change-source")).toContainText("The cook, in person");
    await expectAccessible(publisher.page);
    await expectNoSidewaysScroll(publisher.page);
    await shot(publisher.page, "05-second-person-check");
    await seen(publisher.page, "review-form").getByRole("button", { name: "Approve and publish" }).click();
    await expect(flashError(publisher.page, "Tick both boxes")).toBeVisible();
    // Keyboard only: tick both boxes with Space and approve with Enter.
    const form = seen(publisher.page, "review-form");
    await form.getByLabel(/I looked at the source myself/).focus();
    await publisher.page.keyboard.press("Space");
    await publisher.page.keyboard.press("Tab");
    await publisher.page.keyboard.press("Space");
    await form.getByRole("button", { name: "Approve and publish" }).focus();
    await publisher.page.keyboard.press("Enter");
    await expect(flash(publisher.page, "Checked and published.")).toBeVisible();
    await expect(seen(publisher.page, "change-history")).toContainText("Checked and published");
    await shot(publisher.page, "06-published-record");

    await visitor.goto(`/foods/${made.foodItemId}`);
    await expect(seen(visitor, "food-name")).toHaveText(made.dishName);
    await expect(seen(visitor, "fit-result")).toContainText("Vegan · stated");
    await expect(visitor.locator("main")).toContainText("Demo");
    await visitor.goto(`/venues/${made.venueId}`);
    await expect(seen(visitor, "dish-card").filter({ hasText: made.dishName })).toContainText("Vegan · stated");

    // --- The member eats it, then reports a problem (R2 tests 1 and 4) ---
    await logFood(member.page, made.foodItemId);
    await member.page.goto("/diary");
    await expect(member.page.locator("main")).toContainText(made.dishName);
    // Compare the day's entries and totals, not the whole page: the meal ideas stream in after it, at varying times.
    const dayRecord = () => member.page.locator("main [data-testid='diary-entry'], main [data-testid='day-summary']").allInnerTexts();
    const diaryBefore = (await dayRecord()).join("\n");
    expect(diaryBefore).toContain("21");

    const report = `It has butter now <img src=x onerror="window.__r2x=1"> ${tag}`;
    await asMember(member.id, (c) => c.query("select public.submit_correction($1, null, 'dietary', $2, 'The server told me')", [made.foodItemId, report]), { commit: true });
    await curator.page.goto("/moderation/corrections");
    const item = seen(curator.page, "corrections-open").locator("li.post").filter({ hasText: tag });
    // A member's text is shown as text, never run.
    await expect(item).toContainText('<img src=x onerror="window.__r2x=1">');
    expect(await curator.page.evaluate(() => (window as unknown as { __r2x?: number }).__r2x)).toBeUndefined();
    await item.getByRole("button", { name: "Accept" }).click();
    await expect(flash(curator.page, "Nothing in the catalog changes until an editor updates it")).toBeVisible();
    // Accepting changed nothing a visitor can see.
    await visitor.goto(`/foods/${made.foodItemId}`);
    await expect(seen(visitor, "fit-result")).toContainText("Vegan · stated");
    await expect(visitor.getByTestId("under-review")).toHaveCount(0);
    const revBefore = (await pool.query("select current_revision_id from public.food_items where id = $1", [made.foodItemId])).rows[0].current_revision_id;
    await member.page.goto("/account");
    await member.page.getByRole("link", { name: "Problems you have reported" }).click();
    await expect(seen(member.page, "my-corrections").locator("li").filter({ hasText: tag })).toContainText("Accepted");
    await expect(seen(member.page, "my-corrections").locator("li").filter({ hasText: tag })).toContainText("The page has not been changed yet.");
    await expectAccessible(member.page);
    await shot(member.page, "07-my-reports");

    // --- Mark as needing review: out of the filters at once (R2 test 3) ---
    await curator.page.goto("/moderation/corrections");
    const decided = seen(curator.page, "corrections-decided").locator("li").filter({ hasText: made.dishName }).first();
    await shot(curator.page, "08-accepted-correction");
    await decided.getByRole("button", { name: "Mark as needing review" }).click();
    await expect(flash(curator.page, "It has left every dietary filter")).toBeVisible();
    flaggedFoods.add(made.foodItemId);
    await visitor.goto(`/venues/${made.venueId}`);
    await expect(visitor.getByTestId("dish-card").filter({ hasText: made.dishName })).toHaveCount(0);
    await visitor.goto(`/venues/${made.venueId}?view=needs_confirmation`);
    const flagged = seen(visitor, "dish-card").filter({ hasText: made.dishName });
    await expect(flagged).toContainText("Being re-checked, not confirmed");
    await expect(flagged.getByTestId("under-review")).toBeVisible();
    await shot(visitor, "09-flagged-dish-needs-confirmation");
    await visitor.goto(`/discover?q=${encodeURIComponent(made.dishName)}`);
    await expect(visitor.getByTestId("dish-card").filter({ hasText: made.dishName })).toHaveCount(0);
    await visitor.goto(`/protein?q=${encodeURIComponent(made.dishName)}`);
    await expect(visitor.getByTestId("ranked-row").filter({ hasText: made.dishName })).toHaveCount(0);
    await visitor.goto(`/foods/${made.foodItemId}`);
    await expect(seen(visitor, "under-review")).toBeVisible();
    await expect(seen(visitor, "fit-result")).not.toContainText("Vegan · stated");
    await shot(visitor, "10-flagged-dish-page");
    const search = await (await visitor.request.get(`/api/v1/catalog/search?q=${encodeURIComponent(made.dishName)}&diet=vegan`)).json();
    expect(search.data.items.filter((i: { foodItemId: string }) => i.foodItemId === made.foodItemId)).toEqual([]);

    // --- Act on the correction with a sourced change, checked by a second person ---
    await curator.page.goto("/moderation/corrections");
    await seen(curator.page, "corrections-decided").locator("li").filter({ hasText: made.dishName }).first().getByRole("button", { name: "Start a change from this" }).click();
    await expect(flash(curator.page, "Draft started.")).toBeVisible();
    const fix = changeIdOf(curator.page);
    await expect(seen(curator.page, "change-correction")).toContainText("A member’s report is a lead, not a source");
    await fillSource(curator.page, "The cook, by phone (invented for this test)", "The tofu is now finished with butter. New protein figure from the recipe card.");
    await curator.page.getByLabel("One line for the person who will check this").fill("R2 test: butter added, no longer vegan");
    await curator.page.getByLabel("Vegan", { exact: true }).selectOption("incompatible");
    await curator.page.getByLabel("Dairy", { exact: true }).selectOption("present");
    await curator.page.getByLabel("Protein", { exact: false }).first().fill("18");
    await curator.page.getByLabel(/I checked every statement above again/).check();
    await curator.page.getByRole("button", { name: "Save and send for checking" }).click();
    await expect(flash(curator.page, "Sent for checking.")).toBeVisible();
    // Still nothing public has changed.
    expect((await pool.query("select current_revision_id from public.food_items where id = $1", [made.foodItemId])).rows[0].current_revision_id).toBe(revBefore);
    await publisher.page.goto(`/editor/changes/${fix}`);
    await expect(seen(publisher.page, "change-touches")).toBeVisible();
    await expect(seen(publisher.page, "change-compare").locator('tr[data-changed="yes"]')).not.toHaveCount(0);
    await expect(seen(publisher.page, "change-compare")).toContainText("Changed");
    await shot(publisher.page, "11-compare-published-and-proposed");
    await approve(publisher.page, fix);

    // The checked version is live: not vegan, vegetarian yes, no longer "being re-checked".
    await visitor.goto(`/foods/${made.foodItemId}`);
    await expect(visitor.getByTestId("under-review")).toHaveCount(0);
    await expect(seen(visitor, "fit-result")).toContainText("Contains dairy");
    await visitor.goto(`/venues/${made.venueId}?view=needs_confirmation`);
    await expect(visitor.getByTestId("dish-card").filter({ hasText: made.dishName })).toHaveCount(0);
    await setDiet(guest, "vegetarian");
    await visitor.goto(`/venues/${made.venueId}`);
    await expect(seen(visitor, "dish-card").filter({ hasText: made.dishName })).toContainText("Vegetarian · stated");
    await expect(seen(visitor, "dish-card").filter({ hasText: made.dishName })).toContainText("18");
    await curator.page.goto("/moderation/corrections");
    await expect(seen(curator.page, "corrections-decided").locator("li").filter({ hasText: made.dishName }).first()).toContainText("Acted on: see the published change");
    await member.page.goto("/account/corrections");
    await expect(seen(member.page, "my-corrections").locator("li").filter({ hasText: tag })).toContainText("The page has been updated after a second check.");
    // The diary entry made before the change keeps its numbers (R2 test 4).
    await member.page.goto("/diary");
    await expect(member.page.locator("main")).toContainText(made.dishName);
    expect((await dayRecord()).join("\n")).toBe(diaryBefore);
    // Every step is on the record with who did it.
    const audit = await pool.query("select action, actor_id from public.audit_events where entity_id = $1 order by occurred_at", [fix]);
    expect(audit.rows.map((r) => r.action)).toEqual(["catalog_change.started", "catalog_change.submitted", "catalog_change.published"]);
    expect(audit.rows[2].actor_id).toBe(publisher.id);
  });

  test("a change that contradicts itself cannot be published, and the second person can send it back", async ({ browser }) => {
    const curator = await newMember(browser, "curb", ["curator"]);
    const publisher = await newMember(browser, "pubb", ["publisher"]);
    const tag = randomUUID().slice(0, 6);
    const made = await enterPlaceAndDish(curator, publisher, tag);
    await fillVeganDish(curator.page, "20");
    // Says vegan and says it contains dairy: the publication check refuses this.
    await curator.page.getByLabel("Dairy", { exact: true }).selectOption("present");
    await curator.page.getByRole("button", { name: "Save and send for checking" }).click();
    await expect(flash(curator.page, "Sent for checking.")).toBeVisible();
    await publisher.page.goto(`/editor/changes/${made.dishChange}`);
    await expect(seen(publisher.page, "change-gate")).toContainText("This cannot be published as it stands");
    const form = seen(publisher.page, "review-form");
    await form.getByLabel(/I looked at the source myself/).check();
    await form.getByLabel(/Nothing here is copied/).check();
    await form.getByRole("button", { name: "Approve and publish" }).click();
    await expect(flashError(publisher.page, "This can't be published yet.")).toBeVisible();
    await shot(publisher.page, "12-publication-check-refused");
    expect((await pool.query("select status from public.food_items where id = $1", [made.foodItemId])).rows[0].status).not.toBe("published");
    await seen(publisher.page, "review-form").getByLabel(/Note/).fill("Vegan and dairy cannot both be right. Please check with the cook.");
    await seen(publisher.page, "review-form").getByRole("button", { name: "Send back" }).click();
    await expect(flash(publisher.page, "Sent back with your note.")).toBeVisible();
    await curator.page.goto(`/editor/changes/${made.dishChange}`);
    await expect(seen(curator.page, "change-review-note")).toContainText("Vegan and dairy cannot both be right");
  });
});

test.describe("place history (R2 fix-up)", () => {
  test("changing a place keeps what it was before and after, who entered and checked it, and the source; the record cannot be rewritten", async ({ browser }) => {
    const curator = await newMember(browser, "cure", ["curator"]);
    const publisher = await newMember(browser, "pube", ["publisher"]);
    const tag = randomUUID().slice(0, 6);
    const made = await enterPlaceAndDish(curator, publisher, tag);

    // A second change: new street, a map pin and hours. The form starts from what is published now.
    await curator.page.goto(`/editor/items?q=${encodeURIComponent(made.placeName)}`);
    await seen(curator.page, "editor-venues").locator("li").filter({ hasText: made.placeName }).getByRole("button", { name: "Start a change" }).click();
    await expect(flash(curator.page, "Draft started.")).toBeVisible();
    const change = changeIdOf(curator.page);
    await expect(curator.page.getByLabel("Street")).toHaveValue("1 Example Street");
    await fillSource(curator.page, "The owner, by phone (invented for this test)", "They moved next door and gave their new hours.");
    await curator.page.getByLabel("One line for the person who will check this").fill("R2 test: moved next door, new hours");
    await curator.page.getByLabel("Street").fill("3 Example Street");
    await curator.page.getByLabel("Latitude (optional)").fill("42.3601");
    await curator.page.getByLabel("Longitude (optional)").fill("-71.0589");
    await curator.page.getByLabel(/Hours, as the source gives them/).fill("Invented hours: 11 to 9 daily");
    await curator.page.getByRole("button", { name: "Save and send for checking" }).click();
    await expect(flash(curator.page, "Sent for checking.")).toBeVisible();
    // Not public until the second person checks it.
    await curator.page.goto(`/venues/${made.venueId}`);
    await expect(curator.page.locator("main")).toContainText("1 Example Street");
    await expect(curator.page.locator("main")).not.toContainText("Invented hours");

    await publisher.page.goto(`/editor/changes/${change}`);
    const compare = seen(publisher.page, "change-compare");
    await expect(compare.locator("tr").filter({ hasText: "Street" })).toContainText("1 Example Street");
    await expect(compare.locator("tr").filter({ hasText: "Street" })).toContainText("3 Example Street");
    await approve(publisher.page, change);
    const history = seen(publisher.page, "place-history");
    const v2 = history.locator('li[data-revision="2"]');
    await expect(v2).toContainText("Street: 1 Example Street → 3 Example Street");
    await expect(v2).toContainText("Hours: not stated → Invented hours: 11 to 9 daily");
    await expect(v2).toContainText(`Entered by @${curator.handle} · checked by @${publisher.handle}`);
    await expect(v2).toContainText("The owner, by phone (invented for this test)");
    await expect(history.locator('li[data-revision="1"]')).toContainText("First published version of this place.");
    await expectAccessible(publisher.page);
    await expectNoSidewaysScroll(publisher.page);
    await shot(publisher.page, "22-place-history");

    // The published page shows the new values; the stored history shows both, and cannot be rewritten.
    await publisher.page.goto(`/venues/${made.venueId}`);
    await expect(publisher.page.locator("main")).toContainText("3 Example Street");
    await expect(publisher.page.locator("main")).toContainText("Invented hours: 11 to 9 daily");
    const rows = await pool.query("select revision_no, before_values ->> 'street' as b, after_values ->> 'street' as a, author_id, reviewer_id from public.venue_revisions where venue_id = $1 order by revision_no", [made.venueId]);
    expect(rows.rows).toEqual([
      { revision_no: 1, b: null, a: "1 Example Street", author_id: curator.id, reviewer_id: publisher.id },
      { revision_no: 2, b: "1 Example Street", a: "3 Example Street", author_id: curator.id, reviewer_id: publisher.id },
    ]);
    await expect(pool.query("update public.venue_revisions set after_values = '{}'::jsonb where venue_id = $1", [made.venueId])).rejects.toThrow(/HISTORY_IS_PERMANENT/);
    await expect(pool.query("update public.catalog_changes set summary = 'rewritten' where id = $1", [change])).rejects.toThrow(/HISTORY_IS_PERMANENT/);
    // A curator alone cannot change the published hours behind the check, through the Data API either.
    await expect(asMember(curator.id, (c) => c.query("update public.venue_facts set typed_value = '{\"text\":\"x\"}' where venue_id = $1", [made.venueId]))).rejects.toThrow(/permission denied/);
  });
});

test.describe("out-of-date and being re-checked labels", () => {
  test("an old dish and place carry the label on every screen that shows them, and lose it once checked again; a flagged recipe says it is being re-checked", async ({ browser }) => {
    const curator = await newMember(browser, "curc", ["curator"]);
    const publisher = await newMember(browser, "pubc", ["publisher"]);
    const member = await newMember(browser, "reader", [], { approved: true });
    const tag = randomUUID().slice(0, 6);
    const made = await enterPlaceAndDish(curator, publisher, tag);
    await fillVeganDish(curator.page, "19");
    await curator.page.getByRole("button", { name: "Save and send for checking" }).click();
    await expect(flash(curator.page, "Sent for checking.")).toBeVisible();
    await approve(publisher.page, made.dishChange);

    // The member saves both, lists both and rates both, so every kind of screen shows them.
    const as = (sql: string, params: unknown[]) => asMember(member.id, (c) => c.query(sql, params), { commit: true });
    await member.page.goto(`/foods/${made.foodItemId}`);
    await expect(member.page.getByTestId("out-of-date")).toHaveCount(0);
    await member.page.getByRole("button", { name: /^Save/ }).first().click();
    await member.page.goto(`/venues/${made.venueId}`);
    await member.page.getByRole("button", { name: /^Save/ }).first().click();
    const listId = (await as("select public.save_list(null, $1, null) as l", [`R2 list ${tag}`])).rows[0].l.listId as string;
    await as("select public.add_to_list($1, 'food', $2, null, true)", [listId, made.foodItemId]);
    await as("select public.add_to_list($1, 'venue', $2, null, true)", [listId, made.venueId]);
    await as("select public.publish_list($1)", [listId]);
    for (const [kind, id] of [["food", made.foodItemId], ["venue", made.venueId]] as const) {
      await member.page.goto(`/review?kind=${kind}&id=${id}`);
      await member.page.locator(".rating-pick label").filter({ hasText: /^4Very good$/ }).click();
      await member.page.getByRole("radio", { name: /^Everyone/ }).check();
      await member.page.getByRole("button", { name: "Save review" }).click();
      await expect(member.page).toHaveURL(new RegExp(kind === "venue" ? `/venues/${id}` : `/foods/${id}`));
    }

    const q = encodeURIComponent(made.dishName);
    const surfaces: { path: string; what: string; count: number }[] = [
      { path: `/discover?q=${q}`, what: "Discover", count: 1 },
      { path: `/protein?q=${q}`, what: "Protein Explorer", count: 1 },
      { path: `/protein?q=${q}&compare=${made.foodItemId}`, what: "Protein Explorer compare", count: 2 },
      { path: `/venues/${made.venueId}`, what: "place page (place and dish)", count: 2 },
      { path: `/foods/${made.foodItemId}`, what: "dish page", count: 1 },
      { path: "/saved", what: "Saved (dish and place)", count: 2 },
      { path: `/friends/lists/${listId}`, what: "own list (dish and place)", count: 2 },
      { path: `/lists/${listId}`, what: "public list (dish and place)", count: 2 },
      { path: "/friends/reviews", what: "own reviews (dish and place)", count: 2 },
      { path: `/u/${member.handle}`, what: "member profile (dish and place)", count: 2 },
      { path: `/diary/add?q=${q}`, what: "diary add", count: 1 },
      { path: `/diary/log?food=${made.foodItemId}`, what: "diary log", count: 1 },
    ];
    for (const s of surfaces) {
      await member.page.goto(s.path);
      await expect(member.page.locator("main").filter({ visible: true }).first(), s.what).toContainText(/R2 test/);
      await expect(member.page.getByTestId("out-of-date"), `${s.what} before ageing`).toHaveCount(0);
    }

    // Move the clock: published revisions cannot be edited, so the test ages them with the guards off.
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica");
      await c.query("update public.food_revisions set published_at = now() - interval '61 days' where id = (select current_revision_id from public.food_items where id = $1)", [made.foodItemId]);
      await c.query("update public.venues set reviewed_at = now() - interval '61 days' where id = $1", [made.venueId]);
      await c.query("commit");
    } finally {
      c.release();
    }
    for (const s of surfaces) {
      await member.page.goto(s.path);
      await expect(member.page.getByTestId("out-of-date").filter({ visible: true }), `${s.what} after ageing`).toHaveCount(s.count);
      await expect(member.page.getByTestId("out-of-date").filter({ visible: true }).first()).toContainText("May be out of date");
      await expectNoSidewaysScroll(member.page);
    }
    await member.page.goto(`/venues/${made.venueId}`);
    await expectAccessible(member.page);
    await shot(member.page, "13-out-of-date-place-and-dish");
    await member.page.goto(`/discover?q=${q}`);
    await shot(member.page, "14-out-of-date-in-discover");
    // The public list page and the API say the same to a guest.
    const guest = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: "America/New_York" });
    open.push(guest);
    const visitor = await guest.newPage();
    const api = await (await visitor.request.get(`/api/v1/catalog/search?q=${q}`)).json();
    expect(api.data.items.find((i: { foodItemId: string }) => i.foodItemId === made.foodItemId).freshness.state).toBe("out_of_date");
    // The editors' desk lists it as due.
    await curator.page.goto("/editor");
    await expect(seen(curator.page, "desk-out-of-date")).toContainText(made.dishName);
    await shot(curator.page, "15-desk-with-out-of-date");

    // Checking the dish again (a new checked revision) removes its label.
    await curator.page.goto(`/editor/items?q=${q}`);
    await seen(curator.page, "editor-foods").locator("li").filter({ hasText: made.dishName }).getByRole("button", { name: "Start a change" }).click();
    await expect(flash(curator.page, "Draft started.")).toBeVisible();
    const again = changeIdOf(curator.page);
    await fillSource(curator.page, "The cook, in person (invented for this test)", "Checked every statement again today.");
    await curator.page.getByLabel("One line for the person who will check this").fill("R2 test: routine re-check, nothing changed");
    await curator.page.getByLabel(/I checked every statement above again/).check();
    await curator.page.getByRole("button", { name: "Save and send for checking" }).click();
    await expect(flash(curator.page, "Sent for checking.")).toBeVisible();
    await approve(publisher.page, again);
    await member.page.goto(`/foods/${made.foodItemId}`);
    await expect(member.page.getByTestId("out-of-date")).toHaveCount(0);

    // A recipe never expires by age alone, but a flagged one says it is being re-checked on the library and its page.
    const recipe = M4.recipe(M4.chana);
    await curator.page.goto("/editor/items?q=chana");
    const row = seen(curator.page, "editor-foods").locator("li").filter({ has: curator.page.locator(`input[name="foodItemId"][value="${recipe}"]`) });
    await row.getByText("Mark as needing review", { exact: true }).first().click();
    await row.getByLabel("Why it needs review").fill("R2 test: a member says the tin now lists ghee");
    flaggedFoods.add(recipe);
    await row.getByRole("button", { name: "Mark as needing review" }).click();
    await expect(flash(curator.page, "Marked as needing review.")).toBeVisible();
    await shot(curator.page, "16-find-a-record");
    await setDiet(member.context, "none");
    await member.page.goto("/cook?q=chana");
    await expect(seen(member.page, "recipe-card").filter({ has: member.page.locator(`a[href="/cook/${recipe}"]`) }).getByTestId("under-review")).toBeVisible();
    await member.page.goto(`/cook/${recipe}`);
    await expect(seen(member.page, "under-review")).toContainText("Being re-checked");
    await shot(member.page, "17-recipe-being-rechecked");
    await setDiet(member.context, "vegetarian");
    await member.page.goto("/cook?q=chana");
    await expect(member.page.getByTestId("recipe-card").filter({ has: member.page.locator(`a[href="/cook/${recipe}"]`) })).toHaveCount(0);
    await pool.query("delete from public.review_flags where food_item_id = $1", [recipe]);
    flaggedFoods.delete(recipe);
    await member.page.goto("/cook?q=chana");
    await expect(seen(member.page, "recipe-card").filter({ has: member.page.locator(`a[href="/cook/${recipe}"]`) })).toBeVisible();
  });
});

test.describe("moderator alerts, suspension and member history", () => {
  test("a suspended member cannot post, their content is hidden and leaves the averages; reinstating restores it; diary data is never shown to the moderator", async ({ browser }) => {
    const moderator = await newMember(browser, "mod", ["moderator"]);
    const author = await newMember(browser, "loud", [], { approved: true });
    const other = await newMember(browser, "bystander");
    const curator = await newMember(browser, "curd", ["curator"]);
    const tag = randomUUID().slice(0, 6);
    const venue = IDS.venueBackBay;
    const count = async () => (await (await other.page.request.get(`/api/v1/reviews?kind=venue&id=${venue}`)).json()).data.summary.count as number;
    const before = await count();
    await author.page.goto(`/review?kind=venue&id=${venue}`);
    await author.page.locator(".rating-pick label").filter({ hasText: /^1Poor$/ }).click();
    await author.page.getByLabel(/What would you tell a friend/).fill(`Loud review ${tag}`);
    await author.page.getByRole("radio", { name: /^Everyone/ }).check();
    await author.page.getByRole("button", { name: "Save review" }).click();
    await expect(author.page).toHaveURL(new RegExp(`/venues/${venue}`));
    expect(await count()).toBe(before + 1);
    // A private diary entry that must never reach the moderator.
    await logFood(author.page, IDS.tofu.item);

    await moderator.page.goto("/moderation");
    await expect(seen(moderator.page, "staff-nav")).toBeVisible();
    await expectAccessible(moderator.page);
    await moderator.page.goto(`/moderation/members?handle=${author.handle}`);
    await expect(moderator.page).toHaveURL(new RegExp(`/moderation/members/${author.handle}`));
    await expect(seen(moderator.page, "member-name")).toContainText(author.handle);
    const history = await moderator.page.locator("main").innerText();
    // Counts of public content and past decisions only: nothing from the diary entry made a moment ago.
    expect(history).not.toMatch(/tofu|protein|kcal|calories|lunch|@example\.test/i);
    const raw = (await (await moderator.page.request.get(`/api/v1/moderation/members/${author.handle}`)).json()).data;
    expect(Object.keys(raw).sort()).toEqual(["counts", "displayName", "events", "firstPublicApprovedAt", "handle", "isDemo", "isStaff", "profileHiddenAt", "suspendedAt", "suspendedReason"]);
    expect(JSON.stringify(raw)).not.toMatch(/tofu|protein|example\.test/i);
    await expectAccessible(moderator.page);
    await expectNoSidewaysScroll(moderator.page);
    await shot(moderator.page, "18-member-history");
    // A reason is required.
    await seen(moderator.page, "suspension-form").getByLabel(/Reason/).fill(`Repeated abusive reviews ${tag}`);
    await seen(moderator.page, "suspension-form").getByRole("button").click();
    await expect(flash(moderator.page, "Account suspended.")).toBeVisible();
    await expect(seen(moderator.page, "member-suspended")).toBeVisible();
    await expect(seen(moderator.page, "member-events")).toContainText(`Repeated abusive reviews ${tag}`);
    await shot(moderator.page, "19-member-suspended");

    // Hidden from others and out of the average at once.
    expect(await count()).toBe(before);
    await other.page.goto(`/venues/${venue}`);
    await expect(seen(other.page, "reviews-section")).not.toContainText(`Loud review ${tag}`);
    await other.page.goto(`/u/${author.handle}`);
    await expect(other.page.getByTestId("profile-name")).toHaveCount(0);
    // The suspended member cannot post, and is told why; their private pages still work.
    await author.page.goto(`/review?kind=venue&id=${IDS.venueDavis}`);
    await author.page.locator(".rating-pick label").filter({ hasText: /^5Excellent$/ }).click();
    await author.page.getByRole("radio", { name: /^Only me/ }).check();
    await author.page.getByRole("button", { name: "Save review" }).click();
    await expect(flashError(author.page, "Your account is suspended")).toBeVisible();
    await shot(author.page, "20-suspended-member-told");
    expect((await pool.query("select count(*)::int as n from public.reviews where author_id = $1", [author.id])).rows[0].n).toBe(1);
    await author.page.goto("/diary");
    await expect(author.page.locator("main")).toContainText(/tofu/i);
    // A moderator cannot suspend a member of staff; a curator cannot suspend anyone.
    const staff = await moderator.page.request.post(`/api/v1/moderation/members/${curator.handle}`, { headers: POST, data: { suspend: true, reason: "test" } });
    expect(staff.status()).toBe(403);
    expect((await pool.query("select app.is_suspended($1) as s", [curator.id])).rows[0].s).toBe(false);

    // Reinstate: back on the page and in the average.
    await moderator.page.goto(`/moderation/members/${author.handle}`);
    await seen(moderator.page, "suspension-form").getByRole("button").click();
    await expect(flash(moderator.page, "Account reinstated.")).toBeVisible();
    expect(await count()).toBe(before + 1);
    await other.page.goto(`/venues/${venue}`);
    await expect(seen(other.page, "reviews-section")).toContainText(`Loud review ${tag}`);
    const audit = await pool.query("select action from public.audit_events where entity_id = $1 and action like 'moderation.%' order by occurred_at", [author.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(["moderation.suspend", "moderation.reinstate"]);
    await pool.query("delete from public.reviews where author_id = $1", [author.id]);
  });
});

test.describe("staff screens on a small screen and at 200% zoom", () => {
  test("the desk, the entry form, the record finder and the corrections queue reflow at 320 px and pass the accessibility scan", async ({ browser }) => {
    const staff = await newMember(browser, "allroles", ["curator", "publisher", "moderator"]);
    await staff.page.setViewportSize({ width: 320, height: 640 });
    for (const path of ["/editor", "/editor/items?q=tofu", "/editor/new", "/moderation/corrections", "/moderation", "/account/corrections"]) {
      await staff.page.goto(path);
      await expect(staff.page.locator("main h1").filter({ visible: true })).toBeVisible();
      await expectNoSidewaysScroll(staff.page);
      await expectAccessible(staff.page);
    }
    await staff.page.goto("/editor/new");
    await seen(staff.page, "new-recipe").getByLabel("Name of the recipe").fill(`R2 test Recipe ${randomUUID().slice(0, 6)}`);
    await seen(staff.page, "new-recipe").getByRole("button").click();
    await expect(flash(staff.page, "Draft started.")).toBeVisible();
    await expect(staff.page.getByLabel("Steps, one per line, in our own words")).toBeVisible();
    await expectNoSidewaysScroll(staff.page);
    await expectAccessible(staff.page);
    await shot(staff.page, "21-recipe-draft-320px");
    await staff.page.getByRole("button", { name: "Withdraw this draft" }).click();
    await expect(flash(staff.page, "Draft withdrawn.")).toBeVisible();
  });
});
