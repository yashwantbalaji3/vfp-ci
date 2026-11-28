import { expect, test, type Browser } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";
import { completeSignIn, expectNoSidewaysScroll } from "../e2e/helpers";
import { memberBetaForThisFile } from "./beta-switch";

/**
 * Community suggestions with ordinary members (owner decision 5, 24 Nov 2026 17:45 UTC). The switch is turned on for
 * this file only, on the local test database, and put back afterwards; it stays off on the owner's Mac. Covers
 * submission, a refused duplicate, the same lead from a second member, privacy between members, the founder's review,
 * the member's correction cycle (needs more, withdraw, resend), and removal with the account. Nothing on any
 * restaurant changes.
 */
test.use({ timezoneId: "America/New_York" });
// Members can only open a restaurant page through the staged local beta, so it is on for this file too (local only).
memberBetaForThisFile(true);
test.setTimeout(240_000);

let before: boolean | null = null;
test.beforeAll(async () => {
  before = (await pool.query("select enabled from app.platform_switches where name = 'community_submissions'")).rows[0]?.enabled ?? null;
  await pool.query("update app.platform_switches set enabled = true where name = 'community_submissions'");
});
test.afterAll(async () => {
  await pool.query("update app.platform_switches set enabled = $1 where name = 'community_submissions'", [before ?? false]);
});

async function person(browser: Browser, label: string, founder: boolean) {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, timezoneId: "America/New_York" });
  const page = await context.newPage();
  const email = `cm-${label}-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2Ftoday");
  await completeSignIn(page, email);
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
  if (founder) await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher') on conflict do nothing", [id]);
  return { page, context, id, email };
}

async function sendCorrection(page: import("@playwright/test").Page, slug: string, right: string) {
  await page.goto(`/places/${slug}`);
  await page.getByTestId("place-suggest").getByRole("link", { name: "Suggest a change" }).click();
  await page.getByTestId("contribute-kind-menu_correction").click();
  const form = page.getByTestId("contribute-form");
  await form.getByLabel(/What.s wrong\?/).selectOption("name");
  await form.getByLabel(/What it should say/).fill(right);
  await form.getByLabel(/Where did you see this/).selectOption("printed_menu");
  await form.getByTestId("contribute-agree").check();
  await form.getByTestId("contribute-send").click();
}

test("members suggest, a duplicate is refused, the founder reviews, and a member corrects and withdraws; nothing on a restaurant changes", async ({ browser }) => {
  const slug = (await pool.query(`select pl.slug from public.place_listings pl join staging.live_catalog_links k on k.candidate_id = pl.candidate_id
                                   join staging.member_beta_places b on b.place_id = k.staging_place where pl.visibility = 'preview' order by pl.name limit 1`)).rows[0]?.slug as string | undefined;
  test.skip(!slug, "No beta restaurant here");
  const snap = async () =>
    (await pool.query(`select (select count(*) from staging.facts) f, (select count(*) from staging.facts where status = 'verified') v, (select count(*) from staging.dishes) d,
                              (select count(*) from public.place_listings where visibility = 'public') p, (select md5(string_agg(name || street, ',' order by id)) from public.place_listings) l`)).rows[0];
  const start = await snap();
  const right = `Tofu curry ${randomUUID().slice(0, 4)}`;

  const a = await person(browser, "a", false);
  const b = await person(browser, "b", false);
  const f = await person(browser, "founder", true);
  try {
    // 1. Member A sends a correction; sending the same one again is refused in plain words.
    await sendCorrection(a.page, slug!, right);
    await expect(a.page.getByTestId("contribute-ok")).toBeVisible();
    await expectNoSidewaysScroll(a.page);
    await sendCorrection(a.page, slug!, right);
    await expect(a.page.getByTestId("contribute-error")).toContainText("already sent this suggestion");
    expect((await pool.query("select count(*)::int n from public.community_submissions where user_id = $1", [a.id])).rows[0].n).toBe(1);

    // 2. Member B sends the same correction. B sees only B's own suggestion; neither sees the other's.
    await sendCorrection(b.page, slug!, right);
    await expect(b.page.getByTestId("contribute-ok")).toBeVisible();
    await b.page.goto("/contribute");
    await expect(b.page.getByTestId("contribute-row")).toHaveCount(1);
    // B cannot open the founder queue: the page says it doesn't exist (the queue streams in, so the status is 200).
    await b.page.goto("/places/contributions");
    await expect(b.page.getByRole("heading", { name: /We couldn.t find that/ })).toBeVisible();
    await expect(b.page.getByTestId("contrib-item")).toHaveCount(0);

    // 3. The founder sees both as the same suggestion, with codes instead of names, and asks A for more.
    await f.page.goto("/places/contributions");
    const items = f.page.getByTestId("contrib-item").filter({ hasText: right });
    await expect(items).toHaveCount(2);
    await expect(items.first().getByTestId("contrib-duplicates")).toContainText("Same suggestion from 1 other person");
    await expect(f.page.getByTestId("contrib-item").filter({ hasText: right }).first()).not.toContainText("@example.test");
    // Codes, not names: the founder never sees who sent it. Review A's suggestion (found by its id).
    const aId = (await pool.query("select id from public.community_submissions where user_id = $1", [a.id])).rows[0].id as string;
    const code = (await pool.query("select public.community_contributor_code($1) c", [a.id])).rows[0].c as string;
    const item = f.page.locator(`[data-testid="contrib-item"]:has(input[value="${aId}"])`).first();
    await expect(item).toContainText(`Contributor ${code}`);
    await item.getByLabel(/Note/).fill("Which menu, the lunch one?");
    await item.getByTestId("contrib-more").click();
    await expect(f.page.getByTestId("contrib-message")).toContainText("Marked as needing more detail");

    // 4. A sees "needs more" with the founder's note, withdraws it, and may then send it again.
    await a.page.goto("/contribute");
    const row = a.page.getByTestId("contribute-row").first();
    await expect(row).toHaveAttribute("data-status", "needs_more");
    await expect(row).toContainText("Which menu, the lunch one?");
    await row.getByTestId("contribute-withdraw").click();
    await expect(a.page.getByTestId("contribute-row").first()).toHaveAttribute("data-status", "withdrawn");
    await sendCorrection(a.page, slug!, right);
    await expect(a.page.getByTestId("contribute-ok")).toBeVisible();

    // 5. Nothing on any restaurant changed.
    expect(await snap()).toEqual(start);

    // 6. Deleting A's account removes A's suggestions; B's stays.
    await a.page.goto("/account/delete");
    await a.page.getByLabel("Type DELETE to confirm").fill("DELETE");
    await a.page.getByRole("button", { name: "Delete my account and all my data" }).click();
    await expect.poll(async () => (await pool.query("select count(*)::int n from public.community_submissions where user_id = $1", [a.id])).rows[0].n).toBe(0);
    expect((await pool.query("select count(*)::int n from public.community_submissions where user_id = $1", [b.id])).rows[0].n).toBe(1);
  } finally {
    for (const p of [a, b, f]) await p.context.close();
    await pool.query("delete from public.community_submissions where user_id = any($1::uuid[])", [[a.id, b.id, f.id]]);
  }
});
