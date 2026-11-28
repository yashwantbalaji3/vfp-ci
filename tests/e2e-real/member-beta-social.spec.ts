import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";
import { completeSignIn } from "../e2e/helpers";
import { memberBetaForThisFile } from "./beta-switch";

/**
 * Social and discovery on real data with several ordinary member accounts, in the staged local member beta (owner
 * decision 22 Nov 2026 15:26 UTC; migration 20261122000600). Two members become friends and a third looks on. Both
 * friends see the same beta restaurants; a friends-only review of a beta restaurant reaches the friend and not the
 * stranger; a saved meal and a diary entry reach nobody; a founder-only restaurant stays invisible to all three.
 * Runs only where the beta switch is already on. Every account is a local @example.test identity.
 */
test.use({ timezoneId: "America/New_York" });

// With the staged local member beta on, whatever state the database was in.
memberBetaForThisFile(true);
test.setTimeout(300_000);

let slug = "";
let outside = "";
let mealId = "";
test.beforeAll(async () => {
  const on = (await pool.query("select enabled from staging.member_beta_switch")).rows[0]?.enabled === true;
  if (!on) return;
  const fallback = (await pool.query(`select pl.slug, d.id dish from staging.member_beta_places b join staging.live_catalog_links k on k.staging_place = b.place_id
      join public.place_listings pl on pl.candidate_id = k.candidate_id and pl.visibility = 'preview'
      join staging.dishes d on d.place_id = b.place_id
      where app.preview_meal_ok(d.id) and not exists (select 1 from staging.dish_structure s where s.dish_id = d.id and concat_ws(' ', s.section, s.portion_label) ~* '(cater|(serves|feeds) [0-9]{2,}|platters?.*people)')
        and exists (select 1 from staging.facts f where f.dish_id = d.id and f.kind = 'menu_item' and staging.member_fact_ok(f))
      order by pl.slug, d.id limit 1`));
  if (fallback.rows[0]) [slug, mealId] = [fallback.rows[0].slug, fallback.rows[0].dish];
  outside = (await pool.query(`select pl.slug from staging.live_catalog_links k join public.place_listings pl on pl.candidate_id = k.candidate_id
      where pl.visibility = 'preview' and k.staging_place not in (select place_id from staging.member_beta_places) order by pl.slug limit 1`)).rows[0]?.slug ?? "";
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

test("members: friends share a beta restaurant review; saves, diaries and founder-only places reach nobody", async ({ browser }) => {
  test.skip(!slug, "Needs the member beta on with a beta restaurant listed");
  const tag = randomUUID().slice(0, 6);
  const a = await person(browser, "amem", "Alex Member");
  const b = await person(browser, "bmem", "Blair Member");
  const c = await person(browser, "cmem", "Casey Stranger");

  // Discovery: both friends see the same beta restaurants with menus.
  const names = async (p: Page) => {
    await p.goto("/places/menus");
    // allInnerTexts does not wait: read the list only once the streamed page has finished loading (no skeleton left).
    await expect(seen(p, "menus-place").first()).toBeVisible();
    await expect(p.locator('[aria-busy="true"]')).toHaveCount(0);
    await p.waitForLoadState("load");
    return (await seen(p, "menus-place").locator("h3").allInnerTexts()).map((s) => s.trim()).sort();
  };
  const seenByA = await names(a.page);
  expect(seenByA.length).toBeGreaterThan(0);
  expect(await names(b.page)).toEqual(seenByA);

  // Friendship: requested by exact handle, accepted.
  await b.page.goto("/friends/people");
  await b.page.getByLabel("Exact handle").fill(a.handle);
  await b.page.getByRole("button", { name: "Find" }).click();
  await seen(b.page, "people-results").getByRole("link", { name: "View profile" }).click();
  await seen(b.page, "rel-follow").click();
  await expect(flash(b.page, "You're following them")).toBeVisible();
  await seen(b.page, "rel-request").click();
  await expect(flash(b.page, "Friend request sent")).toBeVisible();
  await a.page.goto("/friends/people");
  await seen(a.page, "group-incoming").getByRole("button", { name: `Accept: ${b.name}` }).click();
  await expect(flash(a.page, "You're now friends")).toBeVisible();

  // A reviews a beta restaurant for friends.
  await a.page.goto(`/places/${slug}`);
  await expect(seen(a.page, "place-social")).toBeVisible();
  const venueId = (await pool.query("select venue_id from public.place_listings where slug = $1", [slug])).rows[0].venue_id as string;
  await review(a.page, "venue", venueId, 5, `Beta place note ${tag}`, "My friends");
  // A saves a beta meal and logs a private diary entry.
  await a.page.goto(`/meals/${mealId}`);
  const mealName = (await seen(a.page, "meal-name").textContent())!.trim();
  await seen(a.page, "meal-save").click();
  await expect(seen(a.page, "meal-save")).toHaveAttribute("aria-pressed", "true");
  await a.page.goto("/diary/custom");
  await a.page.getByLabel("What was it?").fill(`Diary secret ${tag}`);
  await a.page.getByLabel("Protein (g)").fill("18");
  await a.page.getByRole("button", { name: "Add to diary" }).click();
  await a.page.waitForURL(/\/diary(\?|$)/);

  // The friend sees the review in the Friends feed; never the save or the diary.
  await b.page.goto("/friends?feed=friends");
  await expect(seen(b.page, "feed")).toContainText(`Beta place note ${tag}`);
  for (const path of ["/friends", "/friends?feed=friends", `/u/${a.handle}`, "/saved"]) {
    await b.page.goto(path);
    const body = (await b.page.locator("main:visible").first().textContent()) ?? "";
    expect(body, path).not.toContain(`Diary secret ${tag}`);
    if (path !== "/friends?feed=friends") expect(body, path).not.toContain(mealName);
  }
  // The stranger: no review, no save, no diary.
  for (const path of ["/friends", `/u/${a.handle}`, `/places/${slug}`]) {
    await c.page.goto(path);
    const body = (await c.page.locator("main:visible").first().textContent()) ?? "";
    expect(body, path).not.toContain(`Beta place note ${tag}`);
    expect(body, path).not.toContain(`Diary secret ${tag}`);
  }
  // A founder-only restaurant stays invisible to every member.
  if (outside) {
    for (const p of [a.page, b.page, c.page]) {
      await p.goto(`/places/${outside}`);
      await expect(p.getByRole("heading", { level: 1, name: /couldn.t find that/i })).toBeVisible();
    }
  }
  await pool.query("delete from staging.preview_saves where user_id = $1", [a.id]);
});
