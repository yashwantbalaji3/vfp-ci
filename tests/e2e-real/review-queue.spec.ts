import { expect, test, type Browser } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";
import { completeSignIn } from "../e2e/helpers";
import { removeTestSourceReviews } from "./beta-switch";

/**
 * The founder review queue on real local data (owner directive 25 Nov 2026 04:01 UTC, section 4; migration
 * 20261125000100). Reads the queue, flags one meal for restaurant confirmation and clears it again. It never approves
 * or rejects a fact (that is the founder's own decision), and removes its own notes at the end (sandbox only).
 */
test.use({ timezoneId: "America/New_York" });
test.setTimeout(180_000);

const made: string[] = [];
async function person(browser: Browser, label: string, founder: boolean, width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: "America/New_York" });
  const page = await context.newPage();
  const email = `rq-${label}-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2Ftoday");
  await completeSignIn(page, email);
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
  if (founder) await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher') on conflict do nothing", [id]);
  made.push(id);
  return { page, context, id };
}

test.afterAll(async () => {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("alter table staging.meal_review_notes disable trigger meal_review_notes_guard");
    await c.query("delete from staging.meal_review_notes where recorded_by = any($1::uuid[])", [made]);
    await c.query("alter table staging.meal_review_notes enable trigger meal_review_notes_guard");
    await c.query("commit");
  } finally {
    c.release();
  }
  for (const id of made) await removeTestSourceReviews(id);
});

test("the founder sees a diversified proposal with separate counts, and can flag a meal without changing it", async ({ browser }) => {
  const f = await person(browser, "founder", true);
  const page = f.page;
  await page.goto("/places/review/queue");
  const counts = page.getByTestId("rq-counts");
  await expect(counts).toBeVisible();
  test.skip((await page.getByTestId("rq-meal").count()) === 0, "Needs the real menus loaded");
  for (const k of ["restaurantLabelled", "sourceBacked", "staffConfirmed", "ingredientSupported", "sourceReviewed", "dietaryConfirmed", "nutritionPrinted", "nutritionEstimate", "betaEligible", "memberEligible", "published", "awaitingEvidence", "conflicted"])
    await expect(counts.getByTestId(`rq-count-${k}`)).toBeVisible();
  // The three dimensions are separate rows, and every card shows all three plus whether testers can see it.
  await expect(page.getByTestId("rq-meal").first().getByTestId("rq-dimensions")).toContainText("1. Source review");
  await expect(page.getByTestId("rq-meal").first().getByTestId("rq-dim-nutrition")).toHaveAttribute("data-state", /published_|estimate|unknown/);
  await expect(counts.getByTestId("rq-count-published").locator("td")).toHaveText("0");

  // Diversified: no more than six from one restaurant, and the first six cards are not all one restaurant.
  const eyebrows = await page.getByTestId("rq-meal").locator(".eyebrow").allInnerTexts();
  const names = eyebrows.map((e) => e.replace(/^#\d+ · /, "").split(" · ")[0]);
  const most = Math.max(...[...new Set(names)].map((n) => names.filter((x) => x === n).length));
  expect(most).toBeLessThanOrEqual(6);
  expect(new Set(names.slice(0, 6)).size).toBeGreaterThan(1);
  await page.screenshot({ path: "test-results/review-queue-desktop.png", fullPage: false });

  // Every card shows the restaurant's words, the source, nutrition and what stays unverified.
  const card = page.getByTestId("rq-meal").first();
  await expect(card.getByTestId("rq-wording")).not.toBeEmpty();
  await expect(card).toContainText("Source");
  await expect(card).toContainText("Nutrition");
  await card.locator("summary", { hasText: "What approving does" }).click();
  await expect(card).toContainText("Stays unverified");
  const facts = (await pool.query("select count(*)::int n from staging.facts where status = 'submitted'")).rows[0].n;

  // Flag, then clear: the meal's facts do not change.
  await card.locator("textarea[name=note]").fill("TEST ONLY: is the sauce made with fish sauce?");
  await card.getByTestId("rq-flag").click();
  await page.waitForURL(/m=restaurant_confirmation/);
  await expect(page.getByTestId("rq-message")).toContainText("Nobody was contacted");
  // A flagged meal leaves the proposal (it is not evidence-ready) and shows under "Flagged" with its question.
  await page.goto("/places/review/queue?view=flagged");
  await expect(page.getByTestId("rq-meal")).toHaveCount(1);
  await expect(page.getByTestId("rq-meal").first().getByTestId("rq-open-note")).toContainText("fish sauce");
  await page.getByTestId("rq-meal").first().locator("textarea[name=note]").fill("TEST ONLY: cleared");
  await page.getByTestId("rq-meal").first().getByTestId("rq-clear").click();
  await page.waitForURL(/m=cleared/);
  await page.goto("/places/review/queue?view=flagged");
  await expect(page.getByTestId("rq-none")).toBeVisible();
  expect((await pool.query("select count(*)::int n from staging.facts where status = 'submitted'")).rows[0].n).toBe(facts);

  // Phone width: readable, no sideways scroll.
  const phone = await f.context.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto("/places/review/queue");
  expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await phone.screenshot({ path: "test-results/review-queue-phone.png" });
  await f.context.close();

  // A member cannot open it.
  const m = await person(browser, "member", false);
  await m.page.goto("/places/review/queue");
  await expect(m.page.getByRole("heading", { name: /We couldn.t find that/ })).toBeVisible();
  await expect(m.page.getByTestId("rq-meal")).toHaveCount(0);
  await m.context.close();
});

test("the founder reviews one field at a time, sees what is left, and previews the member view without publishing", async ({ browser }) => {
  const f = await person(browser, "fields", true, 390);
  const page = f.page;
  await page.goto("/places/review/queue?view=proposed&todo=1");
  const cards = page.getByTestId("rq-meal");
  test.skip((await cards.count()) === 0, "Needs the real menus loaded");
  await expect(page.getByTestId("rq-progress")).toContainText(/\d+ of \d+ source-reviewed by you/);
  const card = cards.first();
  const dish = ((await card.getAttribute("id")) ?? "").replace("meal-", "");
  // Each field shows what the saved page says, with its own decision buttons.
  const item = card.locator("[data-testid=rq-fact][data-kind=menu_item]").first();
  await expect(item).toHaveAttribute("data-reviewed", "no");
  const before = Number((await pool.query("select count(*) n from staging.fact_confirmations")).rows[0].n);
  await item.getByTestId("rq-fact-approve").click();
  await expect(page.getByTestId("rq-message")).toContainText("Recorded 1 fact decisions", { timeout: 30_000 });
  // Exactly one field was confirmed, as a source review (never verified), and only that one.
  expect(Number((await pool.query("select count(*) n from staging.fact_confirmations")).rows[0].n)).toBe(before + 1);
  expect(Number((await pool.query("select count(*) n from staging.fact_confirmations where confirmed_by = $1 and level = 'transcription'", [f.id])).rows[0].n)).toBe(1);
  const again = page.locator(`#meal-${dish}`);
  await expect(again.getByTestId("rq-dim-source")).toHaveAttribute("data-state", "partial");
  await expect(again.locator("[data-testid=rq-fact][data-kind=menu_item]").first()).toHaveAttribute("data-reviewed", "yes");
  // Rejecting a field needs a note; without one nothing changes.
  await again.locator("[data-testid=rq-fact][data-kind=price]").first().getByTestId("rq-fact-reject").click();
  await expect(page.getByTestId("rq-error")).toContainText("Write a short note", { timeout: 30_000 });
  expect(Number((await pool.query("select count(*) n from staging.facts where dish_id = $1 and status = 'rejected'", [dish])).rows[0].n)).toBe(0);

  // The member preview: gates listed, nothing visible to members yet, warnings and estimates shown as members see them.
  await page.goto(`/places/review/queue/preview/${dish}?as=egg-free`);
  await expect(page.getByTestId("mp-banner")).toContainText("Nothing is published");
  await expect(page.getByTestId("mp-gates")).toContainText("Members cannot see this meal yet");
  await expect(page.getByTestId("mp-gate-reviewed")).toHaveAttribute("data-pass", "no");
  await expect(page.getByTestId("mp-gate-included")).toHaveAttribute("data-pass", "no");
  await expect(page.getByTestId("mp-hero")).toBeVisible();
  await expect(page.getByTestId("mp-protein")).toContainText(/printed by the restaurant|estimate|unknown/i);
  // An ordinary member cannot open the preview.
  const m = await person(browser, "member", false, 390);
  await m.page.goto(`/places/review/queue/preview/${dish}`);
  await expect(m.page.getByRole("heading", { level: 1, name: /couldn.t find that/i })).toBeVisible();
  await m.context.close();
  await f.context.close();
  expect(Number((await pool.query("select count(*) n from public.place_listings where visibility = 'public'")).rows[0].n)).toBe(0);
});
