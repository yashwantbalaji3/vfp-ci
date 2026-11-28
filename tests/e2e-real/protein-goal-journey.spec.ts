import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";
import { completeSignIn } from "../e2e/helpers";

/**
 * Owner follow-up 22 Nov 2026 15:37 UTC, item 2: an isolated, persistent-data browser journey for a populated
 * protein goal. A NEW test account (never the owner's) with a vegetarian diet and a 90 g goal logs a real meal that
 * prints its protein, the entry keeps its nutrition evidence in the database, the diary shows the protein still to
 * go, the person follows a suggestion that fits their diet, and returns to the diary where the entry is unchanged.
 * Adds only its own account and rows.
 */
test.use({ timezoneId: "America/New_York" });
test.setTimeout(300_000);

test("protein goal: log a real meal, keep its evidence, see protein to go, follow a fitting idea, back to the diary", async ({ browser }) => {
  const printed = (
    await pool.query(`select count(*)::int n from staging.facts f join staging.live_catalog_links l on l.staging_place = f.place_id
                       where f.kind = 'published_nutrition' and f.subject = 'protein_g' and not f.is_unknown`)
  ).rows[0].n as number;
  test.skip(printed === 0, "Needs real menus with printed protein loaded");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "America/New_York" });
  const page = await context.newPage();
  const email = `goal-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2Fdiary%2Fgoals");
  await completeSignIn(page, email);
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
  // Logging a real meal is founder-only in the private preview, so this test account gets the founder role.
  await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher') on conflict do nothing", [id]);

  // 1. A vegetarian diet and a populated 90 g goal.
  await page.goto("/diet?return=%2Fdiary");
  await page.locator("main:visible input[name='diet'][value='vegetarian']").check();
  await page.getByRole("button", { name: "Apply filter" }).click();
  await page.waitForURL(/\/diary/);
  await page.goto("/diary/goals");
  await page.getByLabel("Protein per day (grams)").fill("90");
  await page.getByRole("button", { name: "Save goals" }).click();
  await expect(page.getByTestId("goals-saved")).toBeVisible();

  // 2. A real meal whose protein the restaurant prints, logged from its page.
  await page.goto("/protein/meals?min=20");
  const card = page.getByTestId("preview-meal").filter({ visible: true }).filter({ has: page.locator("[data-testid='preview-protein-tile'][data-basis='published']") }).first();
  const href = (await card.locator("a[href^='/meals/']").first().getAttribute("href"))!;
  const dishId = href.split("/meals/")[1].split("?")[0];
  await page.goto(`/meals/${dishId}`);
  await page.getByTestId("meal-log").filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/diary\/custom\?meal=/);
  const protein = Number(await page.getByLabel("Protein (g)").inputValue());
  const name = await page.getByLabel("What was it?").inputValue();
  expect(protein).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Add to diary" }).click();
  await page.waitForURL(/\/diary(\?|$)/);

  // 3. Persisted, with its evidence: the restaurant's printed figure, its page, and that it is an unverified draft.
  const rows = (
    await pool.query(
      `select a.attribution from public.diary_entries e join public.food_revisions r on r.food_item_id = e.food_item_id
         join public.custom_food_attributions a on a.revision_id = r.id where e.owner_id = $1`, [id])
  ).rows;
  expect(rows).toHaveLength(1);
  const attr = rows[0].attribution;
  expect(attr.kind).toBe("real_meal");
  expect(attr.dish.id).toBe(dishId);
  expect(attr.protein.evidence).toMatch(/published|restaurant/);
  expect(Number(attr.protein.logged)).toBe(protein);
  expect(attr.source.url).toMatch(/^https:\/\//);
  expect(attr.status).not.toBe("verified");

  // 4. The diary shows what is still to go.
  await page.goto("/diary");
  await expect(page.getByTestId("diary-entry").filter({ hasText: name }).filter({ visible: true })).toHaveCount(1);
  const left = Math.round((90 - protein) * 10) / 10;
  if (left > 0) await expect(page.getByTestId("protein-to-go").filter({ visible: true })).toContainText(`${String(left).replace(/\.0$/, "")} g protein to go today`);

  // 5. Follow a suggestion: it opens a meal that fits the vegetarian diet by the restaurant's own words.
  const idea = page.getByTestId("togo-meal").filter({ visible: true }).first();
  test.skip((await idea.count()) === 0, "No meal idea fits here");
  await idea.locator("a[href^='/meals/']").first().click();
  await page.waitForURL(/\/meals\//);
  const hero = page.getByTestId("meal-hero").filter({ visible: true });
  await expect(hero).toContainText(/(Vegetarian|Vegan) \(stated\)/);
  await expect(hero).toContainText(/Fits, as stated/);

  // 6. Back to the diary: the entry and the total are unchanged after a full reload.
  await page.goto("/diary");
  await page.reload();
  await expect(page.getByTestId("diary-entry").filter({ hasText: name }).filter({ visible: true })).toHaveCount(1);
  await expect(page.getByTestId("day-protein").filter({ visible: true })).toContainText(String(protein).replace(/\.0$/, ""));
  expect((await pool.query("select count(*)::int n from public.diary_entries where owner_id = $1", [id])).rows[0].n).toBe(1);
  await context.close();
});
