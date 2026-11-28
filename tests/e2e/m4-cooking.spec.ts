import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { M4 } from "../fixtures/ids";
import { completeSignIn, expectNoSidewaysScroll, setDiet } from "./helpers";

/**
 * M4 acceptance in a real browser (plans/2026-11-14-m4-implementation-plan.md, docs/14 T-COOK):
 * find a recipe, change servings and swaps, cook it step by step, leave and come back,
 * finish, and only then choose whether to log what was eaten. Also: substitution safety
 * under a dietary filter, no duplicate logging, privacy between two members, keyboard
 * use and small screens. Local production build and local Supabase only.
 *
 * Set M4_SHOTS=<folder> to save review screenshots along the way.
 */
test.use({ timezoneId: "America/New_York" });

const SHOTS = process.env.M4_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};
const email = (label: string) => `m4-${label}-${randomUUID().slice(0, 8)}@example.test`;
const recipeUrl = (n: number, query = "") => `/cook/${M4.recipe(n)}${query}`;

async function signInAt(page: Page, path: string, who: string) {
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await completeSignIn(page, who);
  await expect(page).toHaveURL(new RegExp(path.split("?")[0].replace(/[/]/g, "\\/")));
}
async function expectAccessible(page: Page) {
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`), `accessibility problems on ${page.url()}`).toEqual([]);
}
const api = async (page: Page, path: string) => (await (await page.request.get(path)).json()).data;
const diaryEntries = async (page: Page) => (await api(page, "/api/v1/diary")).entries as { name: string; cookSessionId?: string | null; nutrients: Record<string, { value: number | null }> }[];
const weekHome = async (page: Page) => {
  const week = await api(page, "/api/v1/diary/week");
  return {
    home: week.days.reduce((n: number, d: { homeMeals: number }) => n + d.homeMeals, 0) as number,
    protein: week.days.reduce((n: number, d: { proteinKnown: number | null }) => n + (d.proteinKnown ?? 0), 0) as number,
    planned: week.days.reduce((n: number, d: { plannedCount: number }) => n + d.plannedCount, 0) as number,
  };
};
/** Starts cooking the recipe shown and steps to the end without finishing. */
async function cookToLastStep(page: Page) {
  await page.getByTestId("start-cooking").click();
  await expect(page.getByTestId("cook-mode")).toBeVisible();
  while (await page.getByTestId("cook-next").isVisible()) {
    const before = await page.getByTestId("cook-progress").textContent();
    await page.getByTestId("cook-next").click();
    await expect(page.getByTestId("cook-progress")).not.toHaveText(before ?? "");
  }
  await expect(page.getByTestId("cook-finish")).toBeVisible();
}

test.describe("find a recipe, adjust it, cook it, then decide what to log (360 px)", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("the complete journey", async ({ page }) => {
    test.setTimeout(120_000);
    const who = email("journey");

    // The library: every demo recipe, protein leading on each card.
    await page.goto("/cook");
    await expect(page.getByTestId("recipe-card")).toHaveCount(12);
    await expect(page.getByTestId("recipe-card").first().getByTestId("protein-figure")).toBeVisible();
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);
    await shot(page, "01-recipe-library");

    // Filters narrow it: Indian, then high protein.
    await page.getByRole("navigation", { name: "Style of cooking and protein" }).getByRole("link", { name: "Indian" }).click();
    await expect(page).toHaveURL(/cuisine=indian/);
    await expect(page.getByTestId("recipe-card")).toHaveCount(4);
    await page.getByTestId("high-protein-chip").click();
    await expect(page).toHaveURL(/protein=high/);
    await expect(page.getByTestId("recipe-card")).toHaveCount(3);
    await expect(page.getByTestId("recipe-card").filter({ hasText: "chana masala" })).toHaveCount(0);

    // Open the spinach and paneer curry.
    await page.getByRole("link", { name: /spinach and paneer curry/i }).click();
    await expect(page.getByTestId("recipe-name")).toHaveText("Spinach and paneer curry");
    await expect(page.getByTestId("recipe-servings")).toHaveText("3 servings");
    await expect(page.getByTestId("recipe-protein")).toHaveText(/20\.8 g|21 g/);
    await expect(page.getByTestId("ingredients")).toContainText("250 g paneer");
    await expect(page.getByTestId("recipe-diet")).toContainText("Contains dairy");
    await expect(page.getByTestId("recipe-allergens")).toContainText("contains milk");
    await expect(page.getByTestId("equipment")).toBeVisible();
    await expect(page.getByTestId("method").getByRole("listitem")).toHaveCount(6);
    await page.getByTestId("nutrition-source").locator("summary").click();
    await expect(page.getByTestId("nutrition-source")).toContainText("calculated");
    await expect(page.getByTestId("nutrition-source")).toContainText("invented demo values");
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);
    await shot(page, "02-recipe-page");

    // More servings: the amounts double, the per-serving protein stays the same.
    const proteinAsWritten = await page.getByTestId("recipe-protein").textContent();
    for (let n = 4; n <= 6; n++) {
      await page.getByTestId("servings-more").click();
      await expect(page.getByTestId("recipe-servings")).toHaveText(`${n} servings`);
    }
    await expect(page.getByTestId("ingredients")).toContainText("500 g paneer");
    await expect(page.getByTestId("ingredients")).toContainText("800 g spinach");
    await expect(page.getByTestId("recipe-protein")).toHaveText(proteinAsWritten ?? "");

    // Swap paneer for tofu and cream for coconut milk: amounts, nutrition, dietary result and allergens are all worked out again.
    await page.getByLabel("Protein", { exact: true }).selectOption(M4.line(M4.paneerCurry, 4));
    await expect(page).toHaveURL(/swap_protein=/);
    await expect(page.getByTestId("ingredients")).toContainText("560 g extra-firm tofu");
    await expect(page.getByTestId("ingredients")).not.toContainText("paneer");
    await expect(page.getByTestId("recipe-protein")).not.toHaveText(proteinAsWritten ?? "");
    await expect(page.getByTestId("recipe-diet")).toContainText("Contains dairy"); // the cream is still in
    await page.getByLabel("Cream", { exact: true }).selectOption(M4.line(M4.paneerCurry, 13));
    await expect(page).toHaveURL(/swap_cream=/);
    await expect(page.getByTestId("recipe-diet")).not.toContainText("Contains dairy");
    await expect(page.getByTestId("recipe-diet")).toContainText("with your swaps");
    await expect(page.getByTestId("recipe-allergens")).not.toContainText("milk.");
    await expect(page.getByTestId("recipe-allergens")).toContainText("soy");
    await expect(page.getByTestId("swap-note").first()).toBeVisible();
    await expect(page.getByTestId("recalculated")).toBeAttached();
    await shot(page, "03-recipe-swapped-6-servings");

    // Back to 2 servings by typing, then start. A guest signs in first and returns to the same version of the recipe.
    await page.getByRole("spinbutton", { name: "Servings" }).fill("2");
    await page.getByRole("button", { name: "Update recipe" }).click();
    await expect(page.getByTestId("recipe-servings")).toHaveText("2 servings");
    await page.getByTestId("start-cooking").click();
    await expect(page).toHaveURL(/\/login\?next=/);
    await completeSignIn(page, who);
    await expect(page).toHaveURL(/swap_protein=/);
    await expect(page.getByTestId("recipe-servings")).toHaveText("2 servings");
    expect((await api(page, "/api/v1/cook-sessions")).inProgress).toEqual([]);

    await page.getByTestId("start-cooking").click();
    await expect(page).toHaveURL(/\/cook\/session\//);
    const sessionUrl = page.url();
    const sessionId = sessionUrl.split("/").pop() as string;

    // Cook mode: no tabs, one thing at a time. Get ready, with a checklist for the swapped, scaled recipe.
    await expect(page.getByTestId("cook-progress")).toHaveText("Get ready");
    await expect(page.locator(".tabbar").filter({ visible: true })).toHaveCount(0);
    const checklist = page.getByTestId("ingredient-checklist");
    await expect(checklist).toContainText("extra-firm tofu");
    await expect(checklist).toContainText("Your swap");
    await expect(checklist).not.toContainText("paneer");
    await checklist.getByRole("checkbox").nth(0).check();
    await checklist.getByRole("checkbox").nth(2).check();
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);
    await shot(page, "04-cook-get-ready");

    await page.getByTestId("cook-next").click();
    await expect(page.getByTestId("cook-progress")).toHaveText("Step 1 of 6");
    await expect(page.getByTestId("cook-heading")).toBeFocused();
    await page.getByTestId("cook-next").click();
    await expect(page.getByTestId("cook-progress")).toHaveText("Step 2 of 6");
    const stepTwo = await page.getByTestId("cook-instruction").textContent();
    const instructionSize = await page.getByTestId("cook-instruction").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(instructionSize).toBeGreaterThanOrEqual(20);

    // The optional timer does nothing until asked, then counts down.
    await expect(page.getByTestId("step-timer")).toHaveAttribute("data-state", "idle");
    await page.getByTestId("timer-start").click();
    await expect(page.getByTestId("step-timer")).toHaveAttribute("data-state", "running");
    await expect(page.getByTestId("timer-clock")).toHaveText(/^[0-4]:\d\d$/);
    await expectAccessible(page);
    await shot(page, "05-cook-step-with-timer");

    // Close the page and come back: same step, same ticks, timer still running.
    await page.waitForLoadState("networkidle");
    await page.goto("/cook");
    await expect(page.getByTestId("resume-row")).toContainText("Step 2 of 6");
    await shot(page, "06-your-kitchen-resume");
    await page.getByTestId("resume-row").getByRole("link", { name: /Resume/ }).click();
    await expect(page.getByTestId("cook-progress")).toHaveText("Step 2 of 6");
    await expect(page.getByTestId("cook-instruction")).toHaveText(stepTwo ?? "");
    await expect(page.getByTestId("step-timer")).toHaveAttribute("data-state", "running");
    await page.getByTestId("toggle-ingredients").click();
    await expect(page.getByTestId("ingredient-checklist").getByRole("checkbox", { checked: true })).toHaveCount(2);
    await page.reload();
    await expect(page.getByTestId("cook-progress")).toHaveText("Step 2 of 6");

    // Back works, then on to the end.
    await page.getByTestId("cook-back").click();
    await expect(page.getByTestId("cook-progress")).toHaveText("Step 1 of 6");
    for (let n = 2; n <= 6; n++) {
      await page.getByTestId("cook-next").click();
      await expect(page.getByTestId("cook-progress")).toHaveText(`Step ${n} of 6`);
    }
    await expect(page.getByTestId("cook-next")).toHaveCount(0);
    await page.getByTestId("cook-finish").click();

    // Finished: asked how much was eaten, with "Not now". Nothing is in the diary; the cooking counts once for the week.
    await expect(page).toHaveURL(/\/done$/);
    await expect(page.getByTestId("done-title")).toHaveText("Spinach and paneer curry is ready");
    await expect(page.getByTestId("done-summary")).toContainText("2 servings with your swaps");
    await expect(page.getByTestId("done-not-logged")).toContainText("Nothing has been added to your diary");
    await expect(page.getByTestId("not-now")).toBeVisible();
    expect(await diaryEntries(page)).toEqual([]);
    expect(await weekHome(page)).toMatchObject({ home: 1, protein: 0 });
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);
    await shot(page, "07-finished-how-much-did-you-eat");

    // "Not now": still nothing logged, and the question is not asked again until they choose to.
    await page.getByTestId("not-now").click();
    await expect(page).toHaveURL(/\/cook\?/);
    await expect(page.getByTestId("cook-note")).toContainText("Nothing was added to your diary");
    expect(await diaryEntries(page)).toEqual([]);
    expect(await weekHome(page)).toMatchObject({ home: 1, protein: 0 });

    // Later, from "Your kitchen", they log one and a half servings.
    await page.getByTestId("cooked-row").getByRole("link").first().click();
    await expect(page).toHaveURL(new RegExp(`/cook/session/${sessionId}/done`));
    await page.getByRole("radio", { name: "A different amount" }).check();
    await page.getByRole("spinbutton", { name: "Servings" }).fill("1.5");
    await expect(page.getByTestId("ate-preview")).toContainText("g protein");
    await page.getByTestId("ate-submit").click();
    await expect(page).toHaveURL(/\/diary\?date=/);
    await expect(page.getByTestId("diary-entry")).toHaveCount(1);
    await expect(page.getByTestId("diary-entry")).toContainText("spinach and paneer curry");
    await expect(page.getByTestId("diary-entry")).toContainText("1.5 servings, cooked from the recipe");
    await shot(page, "08-diary-after-logging");
    const entries = await diaryEntries(page);
    expect(entries).toHaveLength(1);
    expect(entries[0].cookSessionId).toBe(sessionId);
    const swapped = await api(page, `/api/v1/recipes/${M4.recipe(M4.paneerCurry)}?swap_protein=${M4.line(M4.paneerCurry, 4)}&swap_cream=${M4.line(M4.paneerCurry, 13)}`);
    expect(entries[0].nutrients.protein_g.value).toBeCloseTo(swapped.nutrients.protein_g.value * 1.5, 1);

    // The meal counts once toward home cooking, not once for cooking and again for eating.
    const after = await weekHome(page);
    expect(after.home).toBe(1);
    expect(after.protein).toBeCloseTo(swapped.nutrients.protein_g.value * 1.5, 1);
    await page.goto("/diary/week");
    await expect(page.getByTestId("week-home")).toContainText("1");
    await expect(page.getByTestId("week-home")).toContainText("counted once");
    await expectAccessible(page);
    await shot(page, "09-week-home-cooking");

    // Sending the same log again is refused; a later helping must say so and cannot exceed what was cooked.
    const body = { servings: 0.5, mealSlot: "dinner", date: (await api(page, "/api/v1/diary")).date };
    const again = await page.request.post(`/api/v1/cook-sessions/${sessionId}/log`, { data: { ...body, idempotencyKey: randomUUID() } });
    expect(again.status()).toBe(409);
    expect((await again.json()).error.code).toBe("ALREADY_LOGGED");
    const tooMuch = await page.request.post(`/api/v1/cook-sessions/${sessionId}/log`, { data: { ...body, servings: 1, additional: true, idempotencyKey: randomUUID() } });
    expect(tooMuch.status()).toBe(422);
    expect(await diaryEntries(page)).toHaveLength(1);

    // The finish screen now lists what is in the diary and no longer offers "Not now".
    await page.goto(`/cook/session/${sessionId}/done`);
    await expect(page.getByTestId("done-logged")).toContainText("1½ servings");
    await expect(page.getByTestId("not-now")).toHaveCount(0);
    await shot(page, "10-log-more-from-batch");
  });
});

test.describe("substitution safety under a dietary filter", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("vegan filter: excluded recipes are hidden and excluded swaps are never offered", async ({ page, context }) => {
    await setDiet(context, "vegan");
    await page.goto("/cook");
    const cards = page.getByTestId("recipe-card");
    await expect(cards.filter({ hasText: /red lentil dal/i })).toHaveCount(1);
    await expect(cards.filter({ hasText: /paneer/i })).toHaveCount(0);
    await expect(cards.filter({ hasText: /baked eggs/i })).toHaveCount(0);
    await expect(cards.filter({ hasText: /yogurt bowl/i })).toHaveCount(0);
    await shot(page, "11-library-vegan-filter");

    // The dal is vegan as written. Ghee is an approved swap in general, but it is not offered here.
    await page.goto(recipeUrl(M4.dal));
    await expect(page.getByTestId("recipe-fit")).toHaveAttribute("data-status", "eligible");
    const fat = page.getByLabel("Cooking fat", { exact: true });
    await expect(fat.locator("option")).toHaveCount(1);
    await expect(fat).not.toContainText("ghee");
    await expect(page.getByTestId("swaps-hidden")).toContainText("1 swap is not offered");

    // Forcing the ghee swap through the address shows the truth (does not fit) rather than keeping the old claim.
    await page.goto(recipeUrl(M4.dal, `?swap_fat=${M4.line(M4.dal, 8)}`));
    await expect(page.getByTestId("ingredients")).toContainText("ghee");
    await expect(page.getByTestId("recipe-fit")).toHaveAttribute("data-status", "excluded");
    await expect(page.getByTestId("recipe-fit")).toContainText("does not fit your dietary filter");
    await shot(page, "12-excluded-swap-forced");

    // The paneer curry as written is excluded; with both approved swaps it fits.
    await page.goto(recipeUrl(M4.paneerCurry));
    await expect(page.getByTestId("recipe-fit")).toHaveAttribute("data-status", "excluded");
    await page.goto(recipeUrl(M4.paneerCurry, `?swap_protein=${M4.line(M4.paneerCurry, 4)}&swap_cream=${M4.line(M4.paneerCurry, 13)}`));
    await expect(page.getByTestId("recipe-fit")).toHaveAttribute("data-status", "eligible");
    // One swap alone is not enough, and the page says so.
    await page.goto(recipeUrl(M4.paneerCurry, `?swap_protein=${M4.line(M4.paneerCurry, 4)}`));
    await expect(page.getByTestId("recipe-fit")).toHaveAttribute("data-status", "excluded");
  });

  test("an unknown ingredient is never treated as suitable: it needs an explicit opt-in and stays labelled", async ({ page, context }) => {
    await setDiet(context, "vegan");
    await page.goto(recipeUrl(M4.noodles));
    await expect(page.getByTestId("recipe-fit")).toHaveAttribute("data-status", "eligible");
    const noodles = page.getByLabel("Noodles", { exact: true });
    await expect(noodles).not.toContainText("fresh market noodles");
    await expect(noodles).not.toContainText("egg noodles");
    await page.getByRole("checkbox", { name: /Show swaps that need confirmation/ }).check();
    await expect(page).toHaveURL(/unsure=1/);
    await expect(page.getByLabel("Noodles", { exact: true })).toContainText("needs confirmation");
    await page.getByLabel("Noodles", { exact: true }).selectOption(M4.line(M4.noodles, 3));
    await expect(page).toHaveURL(/swap_noodles=/);
    await expect(page.getByTestId("recipe-fit")).toHaveAttribute("data-status", "needs_confirmation");
    await expect(page.getByTestId("recipe-fit")).toContainText("Not confirmed");
    await shot(page, "13-needs-confirmation-swap");
  });

  test("cooking cannot be started with a swap the member's filter excludes", async ({ page, context }) => {
    const who = email("excluded");
    await signInAt(page, "/cook", who);
    await setDiet(context, "vegan");
    await page.goto("/diet");
    await page.getByRole("radio", { name: /^Vegan/ }).check();
    await page.getByRole("button", { name: /Save|Apply|Show/ }).first().click();
    await page.goto(recipeUrl(M4.dal, `?swap_fat=${M4.line(M4.dal, 8)}`));
    await expect(page.getByTestId("recipe-fit")).toHaveAttribute("data-status", "excluded");
    await page.getByTestId("start-cooking").click();
    await expect(page.getByTestId("recipe-note")).toContainText("your dietary filter leaves out");
    expect((await api(page, "/api/v1/cook-sessions")).inProgress).toEqual([]);
  });
});

test.describe("cooking, planning and eating stay separate", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("a planned recipe counts toward nothing until it is cooked; cooked and logged in the same meal counts once", async ({ page }) => {
    test.setTimeout(120_000);
    const who = email("plan");
    await signInAt(page, recipeUrl(M4.scramble), who);

    // Plan it for today.
    await page.getByTestId("plan-sheet").locator("summary").click();
    await page.getByTestId("plan-sheet").getByRole("button", { name: "Add to week plan" }).click();
    await expect(page).toHaveURL(/\/cook\/plan\?/);
    await expect(page.getByTestId("plan-note")).toBeVisible();
    await expect(page.getByTestId("plan-item")).toHaveCount(1);
    await expect(page.getByTestId("plan-explainer")).toContainText("not counted");
    await expect(page.getByTestId("plan-status")).toHaveText("Planned, not cooked");
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);
    await shot(page, "14-week-plan");
    expect(await diaryEntries(page)).toEqual([]);
    expect(await weekHome(page)).toMatchObject({ home: 0, protein: 0, planned: 1 });
    await page.goto("/diary/week");
    await expect(page.getByTestId("week-planned")).toContainText("add nothing");
    await expect(page.getByTestId("week-home").locator(".big")).toHaveText("0");

    // Cook it, log one serving straight away at breakfast.
    await page.goto(recipeUrl(M4.scramble));
    await cookToLastStep(page);
    await page.getByTestId("cook-finish").click();
    await expect(page).toHaveURL(/\/done$/);
    expect(await weekHome(page)).toMatchObject({ home: 1, protein: 0 });
    await page.getByTestId("ate-submit").click();
    await expect(page).toHaveURL(/\/diary\?date=/);
    await expect(page.getByTestId("diary-entry")).toHaveCount(1);
    const one = await weekHome(page);
    expect(one.home).toBe(1);
    expect(one.protein).toBeGreaterThan(30);

    // Pressing the browser's Back button and submitting the form again does not add a second entry.
    await page.goBack();
    await page.reload();
    await expect(page.getByTestId("done-logged")).toBeVisible();
    await expect(page.getByTestId("not-now")).toHaveCount(0);
    expect(await diaryEntries(page)).toHaveLength(1);

    // The leftover serving, eaten later in the same batch, is more food but not more cooking.
    await page.getByTestId("ate-submit").click();
    await expect(page).toHaveURL(/\/diary\?date=/);
    await expect(page.getByTestId("diary-entry")).toHaveCount(2);
    const two = await weekHome(page);
    expect(two.home).toBe(1);
    expect(two.protein).toBeCloseTo(one.protein * 2, 0);
    await page.goto(page.url().replace(/\/diary.*/, "/cook"));
    await expect(page.getByTestId("my-cooking")).toBeVisible();
  });

  test("a cooked entry is edited in servings and can never exceed the batch", async ({ page }) => {
    const who = email("edit");
    await signInAt(page, recipeUrl(M4.crispyChickpeas), who);
    await cookToLastStep(page);
    await page.getByTestId("cook-finish").click();
    await page.getByTestId("ate-submit").click();
    await expect(page.getByTestId("diary-entry")).toHaveCount(1);
    await page.getByTestId("diary-entry").getByRole("link", { name: /Edit/ }).click();
    await page.getByLabel("Servings you ate").fill("99");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status").filter({ hasText: "more than you cooked" })).toBeVisible();
    await page.getByLabel("Servings you ate").fill("2");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByTestId("diary-entry")).toContainText("2 servings, cooked from the recipe");
  });
});

test.describe("privacy between two members", () => {
  test("one member's cooking session, plan and cooked entries are invisible to another", async ({ browser }) => {
    test.setTimeout(120_000);
    const a = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const b = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const pa = await a.newPage();
    const pb = await b.newPage();
    await signInAt(pa, recipeUrl(M4.oats), email("a"));
    await pa.getByTestId("start-cooking").click();
    await expect(pa).toHaveURL(/\/cook\/session\//);
    const sessionId = pa.url().split("/").pop() as string;
    const planned = await pa.request.post("/api/v1/plan", { data: { foodItemId: M4.recipe(M4.dal), date: (await api(pa, "/api/v1/diary")).date } });
    expect(planned.status()).toBe(201);

    await signInAt(pb, "/cook", email("b"));
    // The other member's session looks exactly like one that does not exist, on the screen and through the API.
    for (const path of [`/cook/session/${sessionId}`, `/cook/session/${sessionId}/done`, `/cook/session/${randomUUID()}`]) {
      await pb.goto(path);
      await expect(pb.getByRole("heading", { level: 1 })).toHaveText("We couldn’t find that");
      await expect(pb.getByTestId("cook-mode")).toHaveCount(0);
    }
    expect((await pb.request.get(`/api/v1/cook-sessions/${sessionId}`)).status()).toBe(404);
    expect((await pb.request.get(`/api/v1/cook-sessions/${randomUUID()}`)).status()).toBe(404);
    for (const data of [{ currentStep: 3 }, { action: "complete" }, { action: "abandon" }]) {
      expect((await pb.request.patch(`/api/v1/cook-sessions/${sessionId}`, { data })).status()).toBe(404);
    }
    const log = await pb.request.post(`/api/v1/cook-sessions/${sessionId}/log`, { data: { idempotencyKey: randomUUID(), servings: 1, mealSlot: "breakfast", date: (await api(pb, "/api/v1/diary")).date } });
    expect(log.status()).toBe(404);
    expect((await api(pb, "/api/v1/cook-sessions")).inProgress).toEqual([]);
    expect(await api(pb, "/api/v1/plan")).toEqual([]);
    expect(await weekHome(pb)).toMatchObject({ home: 0, planned: 0 });
    await pb.goto("/cook");
    await expect(pb.getByTestId("resume-row")).toHaveCount(0);

    // A is untouched by B's attempts.
    const mine = await api(pa, `/api/v1/cook-sessions/${sessionId}`);
    expect(mine.currentStep).toBe(0);
    expect(mine.completedAt).toBeNull();
    expect(mine.abandonedAt ?? null).toBeNull();

    // A guest gets nothing private either.
    const guest = await browser.newContext();
    const pg = await guest.newPage();
    expect((await pg.request.get(`/api/v1/cook-sessions/${sessionId}`)).status()).toBe(401);
    expect((await pg.request.get("/api/v1/plan")).status()).toBe(401);
    await pg.goto(`/cook/session/${sessionId}`);
    await expect(pg).toHaveURL(/\/login\?next=/);
    await Promise.all([a.close(), b.close(), guest.close()]);
  });
});

test.describe("keyboard and small screens", () => {
  test("cook a recipe from start to finish with the keyboard only", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signInAt(page, recipeUrl(M4.crispyChickpeas), email("keys"));
    await page.waitForLoadState("networkidle");
    await page.getByTestId("start-cooking").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("cook-mode")).toBeVisible();

    // Tick the first ingredient with Space.
    await page.getByTestId("ingredient-checklist").getByRole("checkbox").first().focus();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("ingredient-checklist").getByRole("checkbox").first()).toBeChecked();

    // Each "Next" moves focus to the new step's heading, so the next Tab continues from the step, not the top of the page.
    const total = Number(((await page.getByTestId("cook-mode").getAttribute("data-step")) ?? "0") === "0" ? await page.getByRole("progressbar").getAttribute("aria-valuemax") : 0);
    for (let n = 1; n <= total; n++) {
      await page.getByTestId("cook-next").focus();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("cook-progress")).toHaveText(`Step ${n} of ${total}`);
      await expect(page.getByTestId("cook-heading")).toBeFocused();
    }
    // From the heading, Tab reaches the controls in reading order and ends on Finish.
    let reached = false;
    for (let i = 0; i < 12 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await page.getByTestId("cook-finish").evaluate((el) => el === document.activeElement);
    }
    expect(reached).toBe(true);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/done$/);

    // "Not now" is reachable and works from the keyboard.
    await page.getByTestId("not-now").focus();
    await expect(page.getByTestId("not-now")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("cook-note")).toBeVisible();
    expect(await diaryEntries(page)).toEqual([]);
  });

  test("320 px wide (the same as 400% zoom): nothing scrolls sideways and touch targets stay large", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 480 });
    await signInAt(page, "/cook", email("small"));
    await expectNoSidewaysScroll(page);
    await page.goto(recipeUrl(M4.noodles, "?servings=7"));
    await expect(page.getByTestId("recipe-servings")).toHaveText("7 servings");
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);
    await page.getByTestId("start-cooking").click();
    await expect(page.getByTestId("cook-mode")).toBeVisible();
    await expectNoSidewaysScroll(page);
    await page.getByTestId("cook-next").click();
    await expectNoSidewaysScroll(page);
    for (const id of ["cook-back", "cook-next"]) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await expectAccessible(page);
    await page.goto("/cook/plan");
    await expectNoSidewaysScroll(page);
  });

  test("desktop width keeps the same journey usable", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/cook");
    await expect(page.getByTestId("recipe-card")).toHaveCount(12);
    await expectAccessible(page);
    await shot(page, "15-desktop-library");
    await page.goto(recipeUrl(M4.stirFry));
    await expect(page.getByTestId("recipe-name")).toHaveText("Sesame tofu and broccoli stir-fry");
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);
    await shot(page, "16-desktop-recipe");
  });
});

test("a recipe that does not exist, and a recipe address with a swap that is not approved", async ({ page }) => {
  expect((await page.goto(`/cook/${randomUUID()}`))?.status()).toBe(404);
  // A made-up swap falls back to the recipe as written and says so; it never shows numbers for a version that was not checked.
  await page.goto(recipeUrl(M4.dal, `?swap_fat=${M4.line(M4.paneerCurry, 3)}`));
  await expect(page.getByTestId("recipe-note")).toBeVisible();
  await expect(page.getByTestId("ingredients")).not.toContainText("paneer");
  const bad = await page.request.get(`/api/v1/recipes/${M4.recipe(M4.dal)}?swap_fat=${M4.line(M4.paneerCurry, 3)}`);
  expect(bad.status()).toBe(422);
});
