import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { pool } from "../helpers/db";
import { completeSignIn, expectNoSidewaysScroll } from "../e2e/helpers";

/**
 * Today (docs/68, launch blockers L1 and L2), in real mode. The founder opens the app on Today, gets ideas for
 * the next meal with no goal set (each naming where its protein figure came from), sets goals, logs a real
 * restaurant meal from an idea, logs yesterday's food again from Today, and sees Today, the diary and the week
 * view agree. A member who isn't the founder gets recipes only, and a visitor gets a welcome. Runs only where
 * the real menus and the real recipes are loaded, so it skips on a freshly reset test database.
 */
test.use({ timezoneId: "America/New_York" });
test.setTimeout(600_000);
const SHOTS = process.env.SHOTS_DIR ?? "test-results/today";

let ready = false;
test.beforeAll(async () => {
  const r = await pool.query(`
    select (select count(*)::int from staging.live_catalog_links) links,
           (select count(*)::int from public.food_items where kind = 'recipe' and not is_demo) recipes`);
  ready = r.rows[0].links >= 8 && r.rows[0].recipes >= 1;
  mkdirSync(SHOTS, { recursive: true });
});

const check = async (page: Page) => {
  await expectNoSidewaysScroll(page);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
};
const yesterday = () => {
  const ny = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  ny.setDate(ny.getDate() - 1);
  return `${ny.getFullYear()}-${String(ny.getMonth() + 1).padStart(2, "0")}-${String(ny.getDate()).padStart(2, "0")}`;
};
async function signIn(browser: Browser, label: string, width: number, founder: boolean): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height: width > 800 ? 900 : 844 }, deviceScaleFactor: 2, isMobile: width < 800, hasTouch: width < 800, timezoneId: "America/New_York" });
  const page = await context.newPage();
  const email = `today-${label}-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2Fdiscover");
  await completeSignIn(page, email);
  if (founder) {
    const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id;
    await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher') on conflict do nothing", [id]);
  }
  return page;
}

for (const width of [390, 1440]) {
  const size = width > 800 ? "desktop" : "phone";
  test(`the founder's day on Today: ideas, goals, a real meal, log again, and the week agrees (${size})`, async ({ browser }) => {
    test.skip(!ready, "Needs the real menus and the real recipes loaded");
    const page = await signIn(browser, `founder-${size}`, width, true);

    // The app opens on Today for a signed-in person. With no goal there are still ideas, each with its basis.
    await page.goto("/");
    await expect(page).toHaveURL(/\/today$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Today");
    const ideas = page.getByTestId("protein-to-go");
    await expect(ideas).toHaveAttribute("data-aim", "open");
    await expect(ideas).toContainText("Ideas for your next meal");
    await expect(page.getByTestId("togo-meal").first()).toContainText("Unverified preview");
    for (const t of await page.getByTestId("togo-basis").allTextContents()) expect(t).toMatch(/printed by the restaurant|USDA estimate|restaurant's estimate/);
    await expect(page.getByTestId("togo-recipe").first()).toContainText("per serving");
    await expect(page.getByTestId("today-week-goal")).toContainText("No goal set");
    await expect(page.getByTestId("today-logged")).toContainText("Nothing logged yet today");
    await check(page);
    await page.screenshot({ path: `${SHOTS}/${size}-01-today-no-goal.png`, fullPage: true });

    // Goals: 90 g a day and 3 home-cooked meals a week. Today now counts down from the goal.
    await page.goto("/diary/goals");
    await page.getByLabel("Protein per day (grams)").fill("90");
    await page.getByLabel("Home-cooked meals per week").fill("3");
    await page.getByRole("button", { name: "Save goals" }).click();
    await expect(page.getByTestId("goals-saved")).toBeVisible();
    await page.goto("/today");
    await expect(page.getByTestId("protein-to-go")).toContainText("90 g protein to go today");
    await expect(page.getByTestId("today-week-home")).toContainText("of your 3");

    // Log the first idea, a real restaurant meal, from its own page.
    await page.getByTestId("togo-meal").first().locator("a").first().click();
    await expect(page).toHaveURL(/\/meals\/[0-9a-f-]+\?from=%2Ftoday/);
    await page.getByTestId("meal-log").click();
    await expect(page.getByTestId("custom-prefill-note")).toContainText("Unverified preview");
    const name = await page.getByLabel("What was it?").inputValue();
    await page.getByRole("button", { name: "Add to diary" }).click();
    await page.waitForURL(/\/diary(\?|$)/);

    // Something from yesterday, to log again from Today.
    await page.goto(`/diary/custom?date=${yesterday()}`);
    const lentils = `Lentil soup ${randomUUID().slice(0, 4)}`;
    await page.getByLabel("What was it?").fill(lentils);
    await page.getByLabel("Protein (g)").fill("18");
    await page.getByRole("button", { name: "Add to diary" }).click();
    await page.waitForURL(/\/diary(\?|$)/);

    await page.goto("/today");
    await expect(page.getByTestId("today-entry").filter({ hasText: name })).toHaveCount(1);
    await expect(page.getByTestId("today-again")).toContainText(lentils);
    await page.getByTestId("today-again").getByRole("button", { name: new RegExp(`Log again ${lentils}`) }).click();
    await expect(page).toHaveURL(/\/today\?done=repeated/);
    await expect(page.getByTestId("today-flash")).toContainText("Logged again.");
    await expect(page.getByTestId("today-entry")).toHaveCount(2);
    await check(page);
    await page.screenshot({ path: `${SHOTS}/${size}-02-today-logged.png`, fullPage: true });

    // Today, the diary and the week view read the same records.
    const todayProtein = (await page.getByTestId("day-protein").textContent())!.replace(/\s+/g, " ").trim();
    const todayGoal = (await page.getByTestId("day-goal").textContent())!.trim();
    const todayWeekGoal = (await page.getByTestId("today-week-goal").locator(".big").textContent())!.trim();
    await page.goto("/diary");
    await expect(page.getByTestId("diary-entry")).toHaveCount(2);
    expect((await page.getByTestId("day-protein").textContent())!.replace(/\s+/g, " ").trim()).toBe(todayProtein);
    expect((await page.getByTestId("day-goal").textContent())!.trim()).toBe(todayGoal);
    await page.goto("/diary/week");
    expect((await page.getByTestId("week-goal-days").locator(".big").textContent())!.trim()).toBe(todayWeekGoal);
    await page.context().close();
  });
}

test("a member who isn't the founder gets recipe ideas only, and no private-preview wording", async ({ browser }) => {
  test.skip(!ready, "Needs the real menus and the real recipes loaded");
  const page = await signIn(browser, "member", 390, false);
  // With the staged local member beta on (20261122000600), a member also gets ideas from the beta restaurants,
  // under a "Local beta" note instead of the founder's private-preview wording.
  const beta = (await pool.query("select enabled from staging.member_beta_switch")).rows[0]?.enabled === true;
  await page.goto("/today");
  await expect(page.getByTestId("protein-to-go")).toContainText("Ideas for your next meal");
  await expect(page.getByTestId("togo-recipe").first()).toBeVisible();
  if (beta) {
    // Today has no page-wide note (for the founder either); each beta meal idea carries its own "Unverified preview" tag.
    const meals = page.getByTestId("togo-meal");
    if (await meals.count()) await expect(meals.first()).toContainText("Unverified preview");
    await expect(page.getByText(/only you can see these real places/i)).toHaveCount(0);
  } else {
    await expect(page.getByTestId("togo-meal")).toHaveCount(0);
    await expect(page.getByTestId("real-banner")).toHaveCount(0);
    await expect(page.getByText(/unverified preview/i)).toHaveCount(0);
  }
  await check(page);
  await page.context().close();
});

test("a visitor opens on Discover, and Today welcomes them without showing anything personal", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/discover$/);
  await page.goto("/today");
  await expect(page.getByTestId("today-welcome")).toContainText("Your diary is private to you");
  await expect(page.getByTestId("today-welcome").getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login?next=%2Ftoday");
  await check(page);
});
