import { expect, test, type Browser } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";
import { completeSignIn, expectNoSidewaysScroll } from "../e2e/helpers";

/**
 * Community evidence (owner directive 24 Nov 2026 14:59 UTC, priority 2B; migration 20261124000300) on real local data.
 * The switch stays off: an ordinary member is told suggestions aren't open; the founder can try the whole flow. A
 * suggestion and its review change no fact, dish, listing or publication state.
 */
test.use({ timezoneId: "America/New_York" });
test.setTimeout(180_000);

async function person(browser: Browser, label: string, founder: boolean, width: number) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: "America/New_York" });
  const page = await context.newPage();
  const email = `ce-${label}-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2Ftoday");
  await completeSignIn(page, email);
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
  if (founder) await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher') on conflict do nothing", [id]);
  return { page, context, id };
}

test("suggestions are closed to members while the switch is off, and the founder can try the flow end to end", async ({ browser }) => {
  expect((await pool.query("select enabled from app.platform_switches where name = 'community_submissions'")).rows).toEqual([{ enabled: false }]);
  const slug = (await pool.query("select pl.slug from public.place_listings pl join staging.live_catalog_links k on k.candidate_id = pl.candidate_id order by pl.name limit 1")).rows[0]?.slug as string | undefined;
  test.skip(!slug, "No researched restaurant here");
  const snap = async () =>
    (await pool.query(`select (select count(*) from staging.facts) f, (select count(*) from staging.dishes) d, (select count(*) from public.place_listings where visibility = 'public') p`)).rows[0];
  const before = await snap();

  const m = await person(browser, "member", false, 390);
  try {
    await m.page.goto("/contribute");
    await expect(m.page.getByTestId("contribute-closed")).toContainText("Suggestions aren’t open yet");
    await m.page.goto(`/places/${slug}`);
    await expect(m.page.getByTestId("place-suggest")).toHaveCount(0);
  } finally {
    await m.context.close();
  }

  const f = await person(browser, "founder", true, 390);
  try {
    await f.page.goto(`/places/${slug}`);
    await f.page.getByTestId("place-suggest").getByRole("link", { name: "Suggest a change" }).click();
    await expect(f.page.getByTestId("contribute-place")).toBeVisible();
    await f.page.getByTestId("contribute-kind-missing_dish").click();
    const form = f.page.getByTestId("contribute-form");
    await form.getByLabel(/Dish name/).fill("Test chickpea curry");
    await form.getByLabel("It says vegan").check();
    await form.getByLabel(/own words/).fill("Vegan");
    await form.getByLabel(/Where did you see this/).selectOption("printed_menu");
    await form.getByTestId("contribute-agree").check();
    await expectNoSidewaysScroll(f.page);
    await form.getByTestId("contribute-send").click();
    await expect(f.page.getByTestId("contribute-ok")).toContainText("We check every suggestion at its source");
    await expect(f.page.getByTestId("contribute-row").first()).toHaveAttribute("data-status", "submitted");

    await f.page.goto("/places/contributions");
    await expect(f.page.getByTestId("contrib-status")).toContainText("A suggestion is a lead, never a fact");
    const item = f.page.getByTestId("contrib-item").filter({ hasText: "Test chickpea curry" });
    await expect(item).toContainText("The printed menu or menu board");
    await expect(item).not.toContainText("@example.test");
    await item.getByLabel(/Note/).fill("Will check the menu");
    await item.getByTestId("contrib-useful").click();
    await expect(f.page.getByTestId("contrib-message")).toContainText("Nothing on any restaurant changed");
    await f.page.goto("/contribute");
    await expect(f.page.getByTestId("contribute-row").first()).toHaveAttribute("data-status", "useful_lead");
    await expect(f.page.getByTestId("contribute-row").first()).toContainText("Will check the menu");
    expect(await snap()).toEqual(before);
  } finally {
    await f.context.close();
    await pool.query("delete from public.community_submissions where user_id = $1", [f.id]);
  }
});

test("v2: an out-of-date menu report keeps its review history and is never publishable", async ({ browser }) => {
  const slug = (await pool.query("select pl.slug from public.place_listings pl join staging.live_catalog_links k on k.candidate_id = pl.candidate_id order by pl.name limit 1")).rows[0]?.slug as string | undefined;
  test.skip(!slug, "No researched restaurant here");
  const f = await person(browser, "founder2", true, 1280);
  try {
    await f.page.goto(`/contribute?place=${slug}`);
    await f.page.getByTestId("contribute-kind-stale_menu").click();
    const form = f.page.getByTestId("contribute-form");
    await form.getByLabel(/What has changed/).fill("TEST ONLY: the lunch menu changed");
    await form.getByLabel(/Where did you see this/).selectOption("printed_menu");
    await form.getByTestId("contribute-agree").check();
    await form.getByTestId("contribute-send").click();
    await expect(f.page.getByTestId("contribute-ok")).toBeVisible();

    await f.page.goto("/places/contributions");
    const item = f.page.getByTestId("contrib-item").filter({ hasText: "TEST ONLY: the lunch menu changed" });
    await expect(item).toContainText("Out-of-date menu");
    await expect(item).toContainText("Never published");
    await item.getByLabel(/Note/).fill("Which dishes?");
    await item.getByTestId("contrib-more").click();
    const again = f.page.getByTestId("contrib-item").filter({ hasText: "TEST ONLY: the lunch menu changed" });
    await again.locator("summary", { hasText: "History" }).click();
    await expect(again.getByTestId("contrib-history").locator("li")).toHaveCount(2);
    await expect(again.getByTestId("contrib-history")).toContainText("Which dishes?");
  } finally {
    await f.context.close();
    await pool.query("delete from public.community_submissions where user_id = $1", [f.id]);
  }
});
