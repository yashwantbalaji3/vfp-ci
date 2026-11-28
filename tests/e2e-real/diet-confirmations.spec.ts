import { expect, test, type Browser } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";
import { completeSignIn } from "../e2e/helpers";

/**
 * Founder-only dietary confirmation records on real local data (owner decision 24 Nov 2026 21:20 UTC, decision 2;
 * migration 20261124000900). The founder records a documented answer for one meal that has no published diet label,
 * sees it as its own category, then withdraws it. A member cannot open the page. Removes the test's own records at
 * the end (sandbox only: the table is append-only for everyone else).
 */
test.use({ timezoneId: "America/New_York" });
test.setTimeout(180_000);

const made: string[] = [];
async function person(browser: Browser, label: string, founder: boolean) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "America/New_York" });
  const page = await context.newPage();
  const email = `dc-${label}-${randomUUID().slice(0, 8)}@example.test`;
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
    await c.query("alter table staging.diet_confirmations disable trigger diet_confirmations_guard");
    await c.query("delete from staging.diet_confirmations where recorded_by = any($1::uuid[])", [made]);
    await c.query("alter table staging.diet_confirmations enable trigger diet_confirmations_guard");
    await c.query("commit");
  } finally {
    c.release();
  }
  // The pool is shared with the other files in this worker, so it is not ended here.
});

test("the founder records a staff answer for one meal, sees it kept apart, and withdraws it; a member cannot", async ({ browser }) => {
  const f = await person(browser, "founder", true);
  const page = f.page;
  await page.goto("/places/menus/confirm");
  const places = page.getByTestId("confirm-place").filter({ visible: true });
  test.skip((await places.count()) === 0, "Needs the real menus loaded");
  await places.first().locator("summary").click();
  const meal = places.first().getByTestId("confirm-meal").first();
  await meal.getByTestId("confirm-record-link").click();
  await page.waitForURL(/\/places\/menus\/confirm\/[0-9a-f-]{36}$/);
  const dishUrl = page.url();
  await expect(page.getByTestId("dc-none")).toBeVisible();
  const before = await page.getByTestId("dc-category-vegetarian").getAttribute("data-category");
  expect(["ingredient_supported", "unknown"]).toContain(before);

  // An empty answer is refused by the browser and the server alike; fill every required field.
  const form = page.getByTestId("dc-form");
  await form.getByLabel("Vegetarian").check();
  await form.getByLabel("Meat or fish stock").check();
  await form.getByLabel("Suitable", { exact: true }).check();
  await form.getByLabel(/What was said or printed/).fill("TEST ONLY: no meat or fish stock, per the shift manager");
  await form.getByLabel("How you obtained it").selectOption("staff_in_person");
  await form.getByLabel(/Source.s role/).fill("Shift manager");
  await form.getByLabel("Limitations").fill("Verbal answer only; not an allergen or cross-contact statement");
  await form.getByTestId("dc-submit").click();
  await page.waitForURL(/m=recorded/);
  await expect(page.getByTestId("dc-message")).toContainText("no menu fact changed");
  await expect(page.getByTestId("dc-category-vegetarian")).toHaveAttribute("data-category", "staff_confirmed");
  // A vegetarian answer is never read as vegan.
  await expect(page.getByTestId("dc-category-vegan")).not.toHaveAttribute("data-category", "staff_confirmed");
  const record = page.getByTestId("dc-record");
  await expect(record).toHaveCount(1);
  await expect(record).toHaveAttribute("data-state", "current");
  await expect(record).toContainText("Asked staff in person");
  await expect(record).toContainText("Shift manager");

  // A member cannot open it.
  const m = await person(browser, "member", false);
  // The page streams in, so the status is 200; it says the page doesn't exist and shows no record or form.
  await m.page.goto(dishUrl);
  await expect(m.page.getByRole("heading", { name: /We couldn.t find that/ })).toBeVisible();
  await expect(m.page.getByTestId("dc-form")).toHaveCount(0);
  await expect(m.page.getByTestId("dc-record")).toHaveCount(0);
  await m.context.close();

  // Withdraw: kept, marked withdrawn, no longer counted.
  await record.getByLabel("Reason to withdraw").fill("End-to-end test record");
  await record.getByTestId("dc-withdraw").click();
  await page.waitForURL(/m=withdrawn/);
  await expect(page.getByTestId("dc-record")).toHaveAttribute("data-state", "withdrawn");
  await expect(page.getByTestId("dc-category-vegetarian")).toHaveAttribute("data-category", before!);
  await f.context.close();
});
