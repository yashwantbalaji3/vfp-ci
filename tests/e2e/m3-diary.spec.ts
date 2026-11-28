import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { FOOD, completeSignIn, expectNoSidewaysScroll } from "./helpers";

/**
 * M3 acceptance in a real browser (plans/2026-11-13-m3-implementation-plan.md §7,
 * docs/14 T-DIARY and T-GOALS): the whole journey from finding a dish to logging,
 * editing, repeating and reading goal progress; meals with no nutrition; privacy
 * between members; timezones; keyboard use and small screens.
 * Local production build and local Supabase only.
 */
test.use({ timezoneId: "America/New_York" });

const email = (label: string) => `m3-${label}-${randomUUID().slice(0, 8)}@example.test`;
const todayIn = (timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

async function signInAt(page: Page, path: string, who: string) {
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await completeSignIn(page, who);
  await expect(page).toHaveURL(new RegExp(path.replace(/[?]/g, "\\?").split("\\?")[0]));
}
async function expectAccessible(page: Page) {
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`), `accessibility problems on ${page.url()}`).toEqual([]);
}
async function logOwnFood(page: Page, name: string, fields: Record<string, string> = {}) {
  await page.goto("/diary/custom");
  await page.getByLabel("What was it?").fill(name);
  if (Object.keys(fields).some((k) => !["Protein (g)", "Calories (kcal)"].includes(k))) await page.getByText("More details (optional)").click();
  for (const [label, value] of Object.entries(fields)) await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByRole("button", { name: "Add to diary" }).click();
  await expect(page.getByTestId("diary-flash")).toHaveText("Added to your diary.");
}

test.describe("discover a dish, log it, edit it, repeat it, see goal progress (360 px)", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("the complete journey", async ({ page }) => {
    const who = email("journey");

    // A guest finds a dish and presses "Log this".
    await page.goto(`/foods/${FOOD.bowl}`);
    await expect(page.getByTestId("food-name")).toHaveText("Demo chickpea power bowl");
    await page.getByTestId("log-this").click();

    // They are asked to sign in, then land back on the same log form. Nothing was logged for them on the way.
    await expect(page).toHaveURL(/\/login\?next=/);
    await completeSignIn(page, who);
    await expect(page).toHaveURL(new RegExp(`/diary/log\\?food=${FOOD.bowl}`));
    await expect(page.getByTestId("log-food-name")).toHaveText("Demo chickpea power bowl");
    const before = await page.request.get("/api/v1/diary");
    expect((await before.json()).data.entries).toEqual([]);
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);

    // The form shows what the portion adds, protein first.
    await expect(page.getByTestId("log-preview")).toContainText("24 g protein");
    await expect(page.getByTestId("log-preview")).toContainText("610 kcal");
    await expect(page.getByRole("radio", { name: "Restaurant or takeout" })).toBeChecked();
    await page.getByLabel("Meal").selectOption("lunch");
    await page.getByRole("button", { name: "Add to diary" }).click();

    // Day view: protein leads, calories smaller beside it.
    await expect(page).toHaveURL(/\/diary\?date=/);
    await expect(page.getByTestId("diary-flash")).toHaveText("Added to your diary.");
    await expect(page.getByTestId("diary-date")).toHaveText("Today");
    await expect(page.getByTestId("day-protein")).toHaveText("24 g");
    await expect(page.getByTestId("day-kcal")).toHaveText("610 kcal");
    await expect(page.getByTestId("diary-entry")).toHaveCount(1);
    await expect(page.getByRole("heading", { name: "Lunch" })).toBeVisible();
    const sizes = await page.evaluate(() => ({
      protein: parseFloat(getComputedStyle(document.querySelector('[data-testid="day-protein"] .v')!).fontSize),
      kcal: parseFloat(getComputedStyle(document.querySelector('[data-testid="day-kcal"]')!).fontSize),
    }));
    expect(sizes.protein).toBeGreaterThan(sizes.kcal * 1.5);
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);

    // Edit: two bowls instead of one.
    await page.getByRole("link", { name: "Edit Demo chickpea power bowl" }).click();
    await expect(page.getByTestId("edit-name")).toHaveText("Demo chickpea power bowl");
    await expect(page.getByTestId("edit-nutrients")).toContainText("24 g · Published");
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);
    await page.getByRole("spinbutton", { name: /^How many/ }).fill("2");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByTestId("diary-flash")).toHaveText("Entry updated.");
    await expect(page.getByTestId("day-protein")).toHaveText("48 g");
    await expect(page.getByTestId("day-kcal")).toHaveText("1220 kcal");
    await expect(page.getByTestId("diary-entry")).toContainText("2 × 1 bowl");

    // Goals are optional and chosen by the member; nothing is prefilled.
    await page.getByRole("link", { name: "Goals", exact: true }).first().click();
    await expect(page).toHaveURL(/\/diary\/goals/);
    await expect(page.getByLabel("Protein per day (grams)")).toHaveValue("");
    await expect(page.getByLabel("Home-cooked meals per week")).toHaveValue("");
    await page.getByLabel("Protein per day (grams)").fill("90");
    await page.getByLabel("Home-cooked meals per week").fill("4");
    await page.getByRole("button", { name: "Save goals" }).click();
    await expect(page.getByTestId("goals-saved")).toBeVisible();
    await expect(page.getByLabel("Protein per day (grams)")).toHaveValue("90");
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);

    // Back on the day: neutral progress wording.
    await page.goto("/diary");
    await expect(page.getByTestId("day-goal")).toContainText("48 g recorded of your 90 g goal.");

    // Repeat the meal: a second, separate entry.
    await page.getByRole("button", { name: /^Log again/ }).click();
    await expect(page.getByTestId("diary-flash")).toHaveText("Logged again.");
    await expect(page.getByTestId("diary-entry")).toHaveCount(2);
    await expect(page.getByTestId("day-protein")).toHaveText("96 g");
    await expect(page.getByTestId("day-goal")).toContainText("You reached your 90 g goal.");

    // Remove one, then undo.
    await page.getByRole("button", { name: /^Remove/ }).first().click();
    await expect(page.getByTestId("diary-undo")).toContainText("Entry removed.");
    await expect(page.getByTestId("diary-entry")).toHaveCount(1);
    await expect(page.getByTestId("day-protein")).toHaveText("48 g");
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByTestId("diary-flash")).toHaveText("Entry restored.");
    await expect(page.getByTestId("diary-entry")).toHaveCount(2);
    await expect(page.getByTestId("day-protein")).toHaveText("96 g");

    // Week view: totals, average with its basis, goal days, coverage, day by day.
    await page.getByRole("link", { name: "Week", exact: true }).click();
    await expect(page.getByTestId("week-range")).toHaveText("This week");
    await expect(page.getByTestId("week-total")).toContainText("96 g");
    await expect(page.getByTestId("week-average")).toContainText("96 g");
    await expect(page.getByTestId("week-average")).toContainText("Across 1 fully logged day");
    await expect(page.getByTestId("week-goal-days")).toContainText("1 of 1 day");
    await expect(page.getByTestId("week-home")).toContainText("0 of your 4");
    await expect(page.getByTestId("week-coverage")).toContainText("You logged food on 1 of 7 days.");
    await expect(page.getByTestId("week-coverage")).toContainText("never counted as zero");
    await expect(page.getByTestId("week-day")).toHaveCount(7);
    await expect(page.getByTestId("week-day").filter({ hasText: "Today" })).toContainText("96 g · goal 90 g · goal reached");
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);
  });
});

test.describe("meals without nutrition information (360 px)", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("a meal can be recorded with only a name, and unknown is never shown or counted as zero", async ({ page }) => {
    await signInAt(page, "/diary", email("unknown"));
    await expect(page.getByTestId("diary-empty")).toContainText("never counted as eating nothing");
    // Bug B5 (docs/68): an empty day offers the ways to start it.
    await expect(page.getByTestId("diary-empty-next").getByRole("link")).toHaveText(["Log something you ate", "Find a protein-rich meal", "Cook a recipe"]);
    await page.getByTestId("add-food").click();
    await expect(page).toHaveURL(/\/diary\/add/);
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);
    await page.getByTestId("add-own").click();
    await expectAccessible(page);

    // Only a name.
    await page.getByLabel("What was it?").fill("Potluck plate");
    await page.getByRole("button", { name: "Add to diary" }).click();
    await expect(page.getByTestId("diary-entry")).toContainText("Protein not known");
    await expect(page.getByTestId("day-summary")).toContainText("Not known for what you logged");
    await expect(page.getByTestId("day-kcal")).toHaveText("Calories not known");
    await expect(page.getByTestId("day-summary")).not.toContainText(/\b0 g\b/);
    await expect(page.getByTestId("day-summary")).not.toContainText("0 kcal");

    // A second food with protein, carbohydrate and fat but no fiber or calories.
    await logOwnFood(page, "Protein bar", { "Protein (g)": "20", "Carbohydrate (g)": "22", "Fat (g)": "7" });
    await expect(page.getByTestId("day-protein")).toHaveText("at least 20 g");
    await expect(page.getByTestId("day-incomplete")).toContainText("1 item has no protein value");
    await expect(page.getByTestId("day-kcal")).toHaveText("Calories not known");
    await page.getByText("More nutrition").click();
    const more = page.getByTestId("more-nutrition");
    await expect(more).toContainText("At least 22 g (1 without a value)");
    await expect(more).toContainText("At least 7 g (1 without a value)");
    await expect(more.locator("div").filter({ hasText: "Fiber" })).toContainText("Not known");

    // The week keeps the same honesty: a lower bound, and no average from an incomplete day.
    await page.goto("/diary/week");
    await expect(page.getByTestId("week-total")).toContainText("at least 20 g");
    await expect(page.getByTestId("week-average")).toContainText("Not enough logged");
    await expect(page.getByTestId("week-goal-days")).toContainText("No goal set");
    await expect(page.getByTestId("week-coverage")).toContainText("1 day has items without a protein value");
    await expect(page.getByTestId("week-day").filter({ hasText: "Today" })).toContainText("At least 20 g · 1 item without protein");
    const emptyDays = page.getByTestId("week-day").filter({ hasText: /Nothing logged|Not yet/ });
    await expect(emptyDays).toHaveCount(6);

    // The saved food can be logged again from "Your own foods" and from "Logged recently".
    await page.goto("/diary/add");
    await expect(page.getByTestId("add-own-list")).toContainText("Protein bar");
    await expect(page.getByTestId("add-recent")).toContainText("Potluck plate");
    await page.getByTestId("add-own-list").getByRole("link", { name: "Protein bar" }).click();
    await expect(page.getByTestId("log-preview")).toContainText("20 g protein");
    await expect(page.getByTestId("log-preview")).toContainText("Calories not known");
    await page.getByRole("spinbutton", { name: "How many" }).fill("0.5");
    await expect(page.getByTestId("log-preview")).toContainText("10 g protein");
    await page.getByRole("button", { name: "Add to diary" }).click();
    await expect(page.getByTestId("day-protein")).toHaveText("at least 30 g");
  });

  test("mistakes are explained next to the field and what was typed is kept", async ({ page }) => {
    await signInAt(page, "/diary/custom", email("validation"));
    await page.getByLabel("Protein (g)").fill("12");
    await page.getByRole("button", { name: "Add to diary" }).click();
    await expect(page.getByTestId("err-name")).toHaveText("Give it a name");
    await expect(page.getByLabel("Protein (g)")).toHaveValue("12");

    await page.getByLabel("What was it?").fill("Soup");
    await page.getByLabel("How many servings").fill("0");
    await page.getByRole("button", { name: "Add to diary" }).click();
    await expect(page.getByTestId("err-quantity")).toContainText("more than 0");
    await expect(page.getByLabel("What was it?")).toHaveValue("Soup");

    // Nothing was saved by the failed attempts.
    expect((await (await page.request.get("/api/v1/diary")).json()).data.entries).toEqual([]);

    // Goals outside the allowed range are refused with a reason.
    await page.goto("/diary/goals");
    await page.getByLabel("Protein per day (grams)").fill("0");
    await page.getByRole("button", { name: "Save goals" }).click();
    await expect(page.getByTestId("err-proteinPerDay")).toHaveText("Enter at least 1 g");
    expect((await (await page.request.get("/api/v1/goals")).json()).data.proteinPerDay).toBeNull();
  });
});

test.describe("logging by weight and searching (360 px)", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("search inside Add food, log 200 g of an ingredient, home-cooked meals count toward the weekly goal", async ({ page }) => {
    await signInAt(page, "/diary/add", email("grams"));
    await page.getByLabel("Search dishes, recipes and packaged foods").fill("tofu");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByTestId("add-results")).toContainText("Demo firm tofu");
    await page.getByTestId("add-results").getByRole("link", { name: "Demo firm tofu" }).click();
    await expect(page.getByTestId("log-food-name")).toHaveText("Demo firm tofu");
    await page.getByRole("radio", { name: /Enter a weight in grams/ }).check();
    await page.getByRole("spinbutton", { name: "Weight in grams" }).fill("200");
    await expect(page.getByTestId("log-preview")).toContainText("24 g protein");
    await page.getByRole("radio", { name: "Home-cooked" }).check();
    await page.getByLabel("Meal").selectOption("dinner");
    await page.getByRole("button", { name: "Add to diary" }).click();
    await expect(page.getByTestId("day-protein")).toHaveText("24 g");
    await expect(page.getByTestId("diary-entry")).toContainText("200 g · Home-cooked");

    await page.request.put("/api/v1/goals", { data: { homeMealsPerWeek: 3 } });
    await page.goto("/diary/week");
    await expect(page.getByTestId("week-home")).toContainText("1 of your 3");
  });
});

test.describe("privacy between members, caching and the API", () => {
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;

  test("B and a guest get nothing of A's diary through pages or the API; private responses are never cacheable", async ({ browser }) => {
    ctxA = await browser.newContext({ timezoneId: "America/New_York" });
    ctxB = await browser.newContext({ timezoneId: "America/New_York" });
    const guest = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await signInAt(a, "/diary", email("priv-a"));
    await signInAt(b, "/diary", email("priv-b"));

    await logOwnFood(a, "A's secret midnight noodles", { "Protein (g)": "33" });
    await a.request.put("/api/v1/goals", { data: { proteinPerDay: 123 } });
    const dayA = (await (await a.request.get("/api/v1/diary")).json()).data;
    expect(dayA.entries).toHaveLength(1);
    const entry = dayA.entries[0];

    // B's pages, interleaved with A's, never show A's data.
    for (const path of ["/diary", "/diary/week", "/diary/add", "/diary/goals"]) {
      await a.goto(path);
      const res = await b.goto(path);
      expect(res?.headers()["cache-control"], path).toContain("no-store");
      await b.waitForLoadState("networkidle");
      await expect(b.locator("main")).not.toContainText("secret midnight noodles");
      await expect(b.locator("main")).not.toContainText("123");
      await expect(b.locator("main")).not.toContainText("33 g");
    }
    await b.goto(`/diary/edit?entry=${entry.entryId}&date=${dayA.date}`);
    await expect(b.getByTestId("edit-missing")).toBeVisible();
    await b.goto(`/diary/log?food=${entry.foodItemId}`);
    await expect(b.getByTestId("log-missing")).toBeVisible();

    // B's API calls against A's entry are "not found"; A's entry is unchanged.
    const json = { "content-type": "application/json", origin: "http://localhost:3000" };
    const patch = await b.request.patch(`/api/v1/diary/entries/${entry.entryId}`, { headers: json, data: { expectedVersion: 1, portionId: entry.portion.portionId, quantity: 9 } });
    expect(patch.status()).toBe(404);
    expect((await b.request.delete(`/api/v1/diary/entries/${entry.entryId}?expectedVersion=1`, { headers: { origin: "http://localhost:3000" } })).status()).toBe(404);
    expect((await b.request.post(`/api/v1/diary/entries/${entry.entryId}/repeat`, { headers: json, data: { idempotencyKey: randomUUID(), date: dayA.date } })).status()).toBe(404);
    expect((await b.request.post(`/api/v1/diary/entries/${entry.entryId}/restore`, { headers: json, data: {} })).status()).toBe(404);
    const dayB = await b.request.get(`/api/v1/diary?date=${dayA.date}`);
    expect((await dayB.json()).data.entries).toEqual([]);
    expect((await (await b.request.get("/api/v1/goals")).json()).data.proteinPerDay).toBeNull();
    const exportB = await b.request.get("/api/v1/me/export?format=json");
    expect(await exportB.text()).not.toContain("secret midnight noodles");
    expect((await (await a.request.get("/api/v1/diary")).json()).data.entries[0].version).toBe(1);

    // Every private response says: do not cache.
    for (const res of [dayB, exportB, await a.request.get("/api/v1/diary/week"), await a.request.get("/api/v1/goals"), await a.request.get("/api/v1/me/export?format=csv")]) {
      expect(res.headers()["cache-control"]).toContain("private");
      expect(res.headers()["cache-control"]).toContain("no-store");
    }

    // A guest right after both members: sign-in prompts on pages, 401 from the API.
    for (const path of ["/api/v1/diary", "/api/v1/diary/week", "/api/v1/goals", "/api/v1/me/export"]) {
      const res = await guest.request.get(path);
      expect(res.status(), path).toBe(401);
      expect(await res.text()).not.toContain("noodles");
    }
    expect((await guest.request.post("/api/v1/diary/entries", { headers: json, data: {} })).status()).toBe(401);
    const g = await guest.newPage();
    for (const path of ["/diary", "/diary/week", "/diary/goals", "/diary/add"]) {
      await g.goto(path);
      // The page streams in, so wait for exactly one visible prompt rather than the first copy that arrives.
      await expect(g.getByTestId("diary-signin").filter({ visible: true })).toHaveCount(1);
      await expect(g.locator("main")).not.toContainText("noodles");
    }
    await g.goto(`/diary/edit?entry=${entry.entryId}&date=${dayA.date}`);
    await expect(g).toHaveURL(/\/login/);

    // A's own export has the entry; unknown calories are an empty cell, not 0.
    const csv = await (await a.request.get("/api/v1/me/export?format=csv")).text();
    expect(csv).toContain("A's secret midnight noodles");
    expect(csv.split("\r\n")[1]).toMatch(/,33,,,,,user_entered$/);
    await guest.close();
  });

  test("the API is idempotent, checks versions, validates input and refuses other sites", async ({ browser }) => {
    const ctx = await browser.newContext({ timezoneId: "America/New_York" });
    const page = await ctx.newPage();
    await signInAt(page, "/diary", email("api"));
    const json = { "content-type": "application/json", origin: "http://localhost:3000" };
    const date = todayIn("America/New_York");
    const food = (await (await page.request.get(`/api/v1/foods/${FOOD.bowl}`)).json()).data;
    const body = { idempotencyKey: randomUUID(), revisionId: food.revisionId, portionId: food.portions[0].id, quantity: 1, context: "restaurant", mealSlot: "lunch", date };

    // The same request twice (a double tap or a retry) creates one entry.
    const first = await page.request.post("/api/v1/diary/entries", { headers: json, data: body });
    const second = await page.request.post("/api/v1/diary/entries", { headers: json, data: body });
    expect(first.status()).toBe(201);
    expect(second.status()).toBe(200);
    const id = (await first.json()).data.entryId;
    expect((await second.json()).data.entryId).toBe(id);
    expect((await (await page.request.get("/api/v1/diary")).json()).data.entries).toHaveLength(1);
    // The same key with a different request is refused, not silently merged.
    expect((await page.request.post("/api/v1/diary/entries", { headers: json, data: { ...body, quantity: 3 } })).status()).toBe(409);

    // Two edits from the same starting version: one wins, the other is told to reload.
    const edit = (quantity: number) => page.request.patch(`/api/v1/diary/entries/${id}`, { headers: json, data: { expectedVersion: 1, portionId: body.portionId, quantity } });
    expect((await edit(2)).status()).toBe(200);
    expect((await edit(3)).status()).toBe(409);
    expect((await (await page.request.get("/api/v1/diary")).json()).data.totals.protein_g.known).toBe(48);

    // Invalid input is a 422 with field messages; nothing is stored.
    const bad = await page.request.post("/api/v1/diary/entries", { headers: json, data: { ...body, idempotencyKey: randomUUID(), quantity: -1, date: "2026-02-30" } });
    expect(bad.status()).toBe(422);
    expect(Object.keys((await bad.json()).error.fields)).toEqual(expect.arrayContaining(["quantity", "date"]));
    expect((await page.request.post("/api/v1/diary/entries", { headers: json, data: { ...body, idempotencyKey: randomUUID(), grams: 100, portionId: undefined, quantity: undefined } })).status()).toBe(422); // no serving weight on file
    expect((await page.request.put("/api/v1/goals", { headers: json, data: { proteinPerDay: 5000 } })).status()).toBe(422);
    expect((await page.request.get("/api/v1/diary?date=tomorrow")).status()).toBe(422);

    // A page on another site cannot write with the member's cookies.
    const foreign = await page.request.post("/api/v1/diary/entries", { headers: { "content-type": "application/json", origin: "https://evil.example" }, data: { ...body, idempotencyKey: randomUUID() } });
    expect(foreign.status()).toBe(403);
    const form = await page.request.post("/api/v1/diary/entries", { headers: { origin: "http://localhost:3000", "content-type": "text/plain" }, data: JSON.stringify({ ...body, idempotencyKey: randomUUID() }) });
    expect(form.status()).toBe(403);
    expect((await (await page.request.get("/api/v1/diary")).json()).data.entries).toHaveLength(1);

    // Delete, then undo through the API.
    expect((await page.request.delete(`/api/v1/diary/entries/${id}?expectedVersion=2`, { headers: { origin: "http://localhost:3000" } })).status()).toBe(200);
    expect((await (await page.request.get("/api/v1/diary")).json()).data.entries).toHaveLength(0);
    expect((await page.request.post(`/api/v1/diary/entries/${id}/restore`, { headers: json, data: {} })).status()).toBe(200);
    expect((await (await page.request.get("/api/v1/diary")).json()).data.entries).toHaveLength(1);
    await ctx.close();
  });
});

test.describe("timezones", () => {
  test("'today' follows the person's own timezone, and an entry stays on the day it was logged after travel", async ({ browser }) => {
    const who = email("travel");
    const home = await browser.newContext({ timezoneId: "Pacific/Honolulu" });
    const page = await home.newPage();
    await signInAt(page, "/diary", who);
    const honolulu = todayIn("Pacific/Honolulu");
    await logOwnFood(page, "Poke-style tofu bowl", { "Protein (g)": "28" });
    await expect(page).toHaveURL(new RegExp(`date=${honolulu}`));
    await expect(page.getByTestId("diary-date")).toHaveText("Today");

    // The same member, now in a place that is 23 hours ahead: always a different calendar day.
    const away = await browser.newContext({ timezoneId: "Pacific/Kiritimati", storageState: await home.storageState() });
    const there = await away.newPage();
    const kiritimati = todayIn("Pacific/Kiritimati");
    expect(kiritimati).not.toBe(honolulu);
    await there.goto("/diary");
    await there.waitForLoadState("networkidle");
    await expect(there.getByTestId("diary-date")).toHaveText("Today");
    expect((await (await there.request.get("/api/v1/diary")).json()).data.date).toBe(kiritimati);
    await expect(there.getByTestId("diary-entry")).toHaveCount(0); // today there is a new, empty day
    await there.goto(`/diary?date=${honolulu}`);
    await expect(there.getByTestId("diary-entry")).toContainText("Poke-style tofu bowl"); // still on the day it was eaten
    await expect(there.getByTestId("day-protein")).toHaveText("28 g");
    await home.close();
    await away.close();
  });
});

test.describe("dietary filter follows the member (R-D08)", () => {
  test("a guest's filter is kept at first sign-in, follows the account, and is never replaced without asking", async ({ browser }) => {
    const who = email("diet");
    const first = await browser.newContext();
    const p1 = await first.newPage();
    await p1.goto("/diet");
    await expect(p1.getByTestId("diet-where")).toContainText("Saved on this browser");
    await p1.getByRole("radio", { name: /^Vegan/ }).check();
    await p1.getByRole("button", { name: "Apply filter" }).click();
    await expect(p1.getByTestId("diet-chip")).toContainText("Vegan");
    await signInAt(p1, "/discover", who);
    await expect(p1.getByTestId("diet-chip")).toContainText("Vegan"); // results did not quietly widen
    await p1.goto("/diet");
    await expect(p1.getByTestId("diet-where")).toContainText("Saved to your account");

    // Another browser with no filter: the account's choice applies after sign-in.
    const second = await browser.newContext();
    const p2 = await second.newPage();
    await p2.goto("/discover");
    await expect(p2.getByTestId("diet-chip")).toContainText("No dietary filter");
    await signInAt(p2, "/discover", who);
    await expect(p2.getByTestId("diet-chip")).toContainText("Vegan");

    // A third browser where a different filter was chosen while signed out: the account wins, and the member is asked.
    const third = await browser.newContext();
    const p3 = await third.newPage();
    await p3.goto("/diet");
    await p3.getByRole("radio", { name: /^Vegetarian/ }).check();
    await p3.getByRole("checkbox", { name: "Eggs" }).check();
    await p3.getByRole("button", { name: "Apply filter" }).click();
    await expect(p3.getByTestId("diet-chip")).toContainText("Egg-free vegetarian");
    await signInAt(p3, "/discover", who);
    await expect(p3.getByTestId("diet-chip")).toContainText("Vegan");
    await p3.goto("/diet");
    await expect(p3.getByTestId("diet-conflict")).toContainText("Egg-free vegetarian");
    await p3.getByRole("button", { name: "Keep my account’s filter" }).click();
    await expect(p3.getByTestId("diet-conflict")).toHaveCount(0);
    await expect(p3.getByRole("radio", { name: /^Vegan/ })).toBeChecked();
    for (const c of [first, second, third]) await c.close();
  });
});

test.describe("keyboard only, desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  async function tabTo(page: Page, matches: (text: string, tag: string) => boolean, limit = 120) {
    await page.waitForLoadState("networkidle");
    for (let i = 0; i < limit; i++) {
      await page.keyboard.press("Tab");
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return { text: (el?.innerText || el?.getAttribute("aria-label") || "").trim(), tag: el?.tagName ?? "" };
      });
      if (matches(info.text, info.tag)) return;
    }
    throw new Error("Could not reach the control with the Tab key");
  }

  test("log a dish, edit it, repeat it and open the week without a mouse", async ({ page }) => {
    await signInAt(page, `/foods/${FOOD.bowl}`, email("keys"));
    await expect(page.getByTestId("log-this")).toBeVisible();
    await tabTo(page, (t) => t === "Log this");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("log-food-name")).toBeVisible();
    await tabTo(page, (t) => t === "Add to diary");
    const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
    expect(outline).not.toBe("none");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("day-protein")).toHaveText("24 g");

    await tabTo(page, (t) => t.startsWith("Edit"));
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("edit-name")).toBeVisible();
    await tabTo(page, (_t, tag) => tag === "INPUT");
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("3");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("day-protein")).toHaveText("72 g");

    await tabTo(page, (t) => t.startsWith("Log again"));
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("day-protein")).toHaveText("144 g");

    await tabTo(page, (t) => t === "Week");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("week-total")).toContainText("144 g");
    // On wide screens Goals has its own entry in the side navigation.
    await expect(page.locator("aside").getByRole("link", { name: "Goals" })).toHaveAttribute("href", "/diary/goals");
  });
});

test.describe("200% zoom (320 px reflow)", () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test("every diary screen reflows without sideways scrolling", async ({ page }) => {
    await signInAt(page, "/diary", email("zoom"));
    await logOwnFood(page, "A dish with quite a long descriptive name, extra chutney on the side", { "Protein (g)": "17.5", "Calories (kcal)": "432" });
    await page.request.put("/api/v1/goals", { data: { proteinPerDay: 80, homeMealsPerWeek: 5 } });
    for (const path of ["/diary", "/diary/week", "/diary/goals", "/diary/add", "/diary/add?q=demo", "/diary/custom", `/diary/log?food=${FOOD.tofu}`]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await expectNoSidewaysScroll(page);
    }
    await page.goto("/diary");
    await page.getByRole("link", { name: /^Edit/ }).click();
    await expect(page.getByTestId("edit-name")).toBeVisible();
    await expectNoSidewaysScroll(page);
  });
});
