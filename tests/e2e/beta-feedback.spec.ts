import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";
import { completeSignIn, expectNoSidewaysScroll } from "./helpers";

/**
 * Tester feedback (owner direction 23 Nov 2026 19:34 UTC item 4; migration 20261123000300): a member finds the form
 * from Account, sends the weekly answers once, adds a note, sees only their own feedback under a tester code and can
 * delete it. Nothing is sent anywhere outside the app.
 */
test("a member sends weekly answers and a note, and can delete their own feedback", async ({ page }) => {
  const email = `feedback-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2Faccount");
  await completeSignIn(page, email);
  await page.goto("/account");
  await page.getByTestId("feedback-link").click();
  await expect(page).toHaveURL(/\/feedback$/);
  await expect(page.getByTestId("feedback-code")).toHaveText(/^[0-9a-f]{6}$/);
  await expect(page.getByTestId("feedback-privacy")).toContainText("don’t include health");
  await expectNoSidewaysScroll(page);

  const week = page.getByTestId("feedback-week");
  await week.getByLabel("A few times").check();
  await week.getByLabel("Yes, they matched").check();
  await week.locator("input[name=trust][value='4']").check();
  await week.locator("input[name=recommend][value='5']").check();
  await week.locator("textarea[name=missing]").fill("More places in Chinatown");
  await page.getByTestId("feedback-week-send").click();
  await expect(page.getByTestId("feedback-ok")).toContainText("answers are saved");

  // A second weekly answer within 6 days is refused, kindly.
  await week.getByLabel("Once").check();
  await week.getByLabel("I didn't check").check();
  await week.locator("input[name=trust][value='3']").check();
  await week.locator("input[name=recommend][value='3']").check();
  await page.getByTestId("feedback-week-send").click();
  await expect(page.getByTestId("feedback-error")).toContainText("already answered");

  await page.getByTestId("feedback-note").locator("textarea[name=text]").fill("Search found what I wanted");
  await page.getByTestId("feedback-note-send").click();
  await expect(page.getByTestId("feedback-ok")).toContainText("note is saved");
  await expect(page.getByTestId("feedback-item")).toHaveCount(2);

  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
  const rows = (await pool.query("select form, answers from public.beta_feedback where user_id = $1 order by created_at", [id])).rows;
  expect(rows.map((r) => r.form)).toEqual(["week", "note"]);
  expect(rows[0].answers).toEqual({ used: "a_few_times", labels: "matched", trust: 4, recommend: 5, missing: "More places in Chinatown" });

  await page.getByTestId("feedback-item").first().getByTestId("feedback-delete").click();
  await expect(page.getByTestId("feedback-ok")).toContainText("Deleted");
  await expect(page.getByTestId("feedback-item")).toHaveCount(1);
  await pool.query("delete from public.beta_feedback where user_id = $1", [id]);
});

test("the founder's feedback page is not available to an ordinary member", async ({ page }) => {
  await page.goto("/login?next=%2Ffeedback%2Fall");
  await completeSignIn(page, `feedback-x-${randomUUID().slice(0, 8)}@example.test`);
  await page.goto("/feedback/all");
  await expect(page.getByRole("heading", { level: 1, name: /couldn.t find that/i })).toBeVisible();
});
