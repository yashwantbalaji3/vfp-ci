import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { FOOD, VENUE, completeSignIn, expectNoSidewaysScroll, setDiet } from "./helpers";

/**
 * M2 acceptance in a real browser (plans/2026-11-13-m2-implementation-plan.md §7, docs/14
 * T-DISCOVERY and T-PROTEIN): guest journey at 360 px, keyboard-only, reflow at 320 px
 * (the 200% zoom check), strict dietary views, sources, compare, saves and corrections.
 * Local production build and local Supabase only.
 */
/** Names on the dish cards now showing. Read it through expect.poll: a single read can catch the page between two states (AUD-D4). */
const cardNames = (page: Page) => page.getByTestId("dish-card").filter({ visible: true }).locator("h3").allTextContents();

test.describe("guest journey at 360 px (R-001, R-006, R-D08, R-005, R-P04)", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("search, filter egg-free vegetarian, open a dish, see sources, compare two foods", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/discover$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Find something good to eat");
    await expectNoSidewaysScroll(page);

    // No filter yet: nothing is checked against a diet, and nothing is labelled as a match.
    await expect(page.getByTestId("results-heading")).toHaveText("13 dishes");
    await expect(page.locator(".conf")).toHaveCount(0);

    // Choose egg-free vegetarian.
    await page.getByTestId("diet-chip").click();
    await expect(page).toHaveURL(/\/diet\?return=/);
    await expectNoSidewaysScroll(page);
    await page.getByRole("radio", { name: /^Vegetarian/ }).check();
    await page.getByRole("checkbox", { name: "Eggs" }).check();
    await page.getByRole("button", { name: "Apply filter" }).click();
    await expect(page).toHaveURL(/\/discover$/);
    await expect(page.getByTestId("diet-chip")).toContainText("Egg-free vegetarian");
    await expect(page.getByTestId("results-heading")).toHaveText("7 confirmed matches");

    // Confirmed matches only: nothing unknown, nothing that contains egg.
    await expect.poll(async () => (await cardNames(page)).length).toBe(7);
    const matches = await cardNames(page);
    expect(matches).toHaveLength(7);
    for (const hiddenOrUnknown of ["Demo mushroom toast", "Demo veggie burger", "Demo peanut noodles", "Demo egg noodles", "Demo tofu bibimbap", "Demo green papaya salad"]) {
      expect(matches).not.toContain(hiddenOrUnknown);
    }
    await expect(page.locator(".conf.ok")).toHaveCount(7);
    await expect(page.locator(".conf.ask, .conf.no")).toHaveCount(0);
    await expect(page.getByTestId("hidden-note")).toContainText("2 items with egg, 1 item with fish sauce");
    await expectNoSidewaysScroll(page);

    // Unknown items are one deliberate step away, clearly labelled, and still exclude "contains".
    await page.getByTestId("needs-reveal").getByRole("link").click();
    await expect(page).toHaveURL(/view=needs_confirmation/);
    await expect(page.getByTestId("results-heading")).toHaveText("3 dishes need confirmation");
    await expect(page.getByTestId("needs-note")).toContainText("They are not matches");
    await expect.poll(async () => (await cardNames(page)).sort()).toEqual(["Demo mushroom toast", "Demo peanut noodles", "Demo veggie burger"]);
    await expect(page.getByText("Egg unconfirmed")).toHaveCount(2);
    await expect(page.locator(".conf.ok")).toHaveCount(0);
    await expectNoSidewaysScroll(page);

    // Text search keeps the filter.
    await page.getByRole("link", { name: /^Confirmed/ }).click();
    await page.getByLabel("Search dishes and places").fill("chickpea");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByTestId("results-heading")).toHaveText("1 confirmed match");

    // Open the dish; its sources are one action away.
    await page.getByRole("link", { name: "Demo chickpea power bowl" }).click();
    await expect(page.getByTestId("food-name")).toHaveText("Demo chickpea power bowl");
    await expect(page.getByTestId("fit-result")).toContainText("No egg · stated");
    await expect(page.getByText("Illustration · photo pending")).toBeVisible();
    const source = page.locator("details.src").first();
    await source.locator("summary").click();
    await expect(source.locator(".src-body")).toContainText("Synthetic demo fixtures");
    await expect(source.locator(".src-body")).toContainText("Checked");
    await expect(page.getByText("never an allergy-safety guarantee")).toBeVisible();
    await expectNoSidewaysScroll(page);

    // Protein Explorer through the bottom tabs, then compare two foods.
    await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Protein" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Protein Explorer");
    // Recipes now share this list (M4), so narrow it to restaurant dishes for the comparison.
    await page.getByRole("navigation", { name: "Kind of food" }).getByRole("link", { name: "Dishes" }).click();
    await expect(page).toHaveURL(/kind=/);
    const rows = page.getByTestId("ranked-row");
    await expect(rows.first()).toContainText("Demo paneer tikka");
    await rows.nth(0).getByRole("link", { name: /^Compare/ }).click();
    await expect(page.getByTestId("compare-panel")).toContainText("Comparing 1 of up to 3");
    await page.getByTestId("ranked-row").nth(1).getByRole("link", { name: /^Compare/ }).click();
    const panel = page.getByTestId("compare-panel");
    await expect(panel).toContainText("Comparing 2 of up to 3");
    await expect(panel.getByTestId("compare-card")).toHaveCount(2);
    await expect(panel).toContainText("Demo paneer tikka");
    await expect(panel).toContainText("Demo chickpea power bowl");
    await expect(panel).toContainText("26 g");
    await expect(panel).toContainText("24 g");
    await expectNoSidewaysScroll(page);
  });
});

test.describe("keyboard only (R-006)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  async function tabTo(page: Page, matches: (text: string, tag: string) => boolean, limit = 120) {
    // Start tabbing only once the page has finished loading and streaming; pressing Tab while
    // content is still arriving races the page and says nothing about keyboard access.
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

  test("the whole journey works with Tab, Space and Enter, and focus is always visible", async ({ page, context }) => {
    await page.goto("/discover");
    // Skip link is the first stop.
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus")).toHaveText("Skip to content");

    await tabTo(page, (t) => t.includes("No dietary filter"));
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/diet/);
    await page.getByRole("radio", { name: /^Vegetarian/ }).focus();
    await page.keyboard.press("Space");
    await page.getByRole("checkbox", { name: "Eggs" }).focus();
    await page.keyboard.press("Space");
    await tabTo(page, (t) => t === "Apply filter");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("results-heading")).toHaveText("7 confirmed matches");

    await tabTo(page, (t, tag) => tag === "INPUT" && t === "");
    await page.keyboard.type("paneer");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("results-heading")).toHaveText("1 confirmed match");

    await expect(page.getByRole("link", { name: "Demo paneer tikka" })).toBeVisible();
    await tabTo(page, (t) => t === "Demo paneer tikka");
    const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
    expect(outline).not.toBe("none");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("food-name")).toHaveText("Demo paneer tikka");

    await tabTo(page, (t) => t === "Who says so, and when");
    await page.keyboard.press("Enter");
    await expect(page.locator("details.src[open] .src-body").first()).toContainText("Synthetic demo fixtures");

    await tabTo(page, (t) => t === "Compare protein");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("compare-panel")).toContainText("Comparing 1 of up to 3");
    await tabTo(page, (t) => t.startsWith("Compare") && t.includes("Demo chickpea power bowl"));
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("compare-panel")).toContainText("Comparing 2 of up to 3");
    expect((await context.cookies()).find((c) => c.name === "diet_pref")?.httpOnly).toBe(true);
  });
});

test.describe("reflow at 320 px, the 200% zoom check (R-006, WCAG 1.4.10)", () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test("core screens do not scroll sideways and keep 44 px targets", async ({ page, context }) => {
    await setDiet(context, "vegetarian", ["egg"]);
    for (const path of [
      "/discover",
      "/discover?view=needs_confirmation",
      "/diet",
      `/foods/${FOOD.peanutNoodles}`,
      `/venues/${VENUE.central}`,
      "/protein",
      `/protein?basis=100g&compare=${FOOD.tofu},${FOOD.crispbread},${FOOD.lentils}`,
      "/saved",
      "/diary",
      "/login",
    ]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoSidewaysScroll(page);
    }
    await page.goto("/discover");
    const small = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("nav.tabbar a, .btn, .chip, .seg a, input[type=search], summary")]
        .filter((el) => el.offsetParent !== null)
        .map((el) => ({ text: el.innerText.slice(0, 30), h: Math.round(el.getBoundingClientRect().height) }))
        .filter((x) => x.h < 44),
    );
    expect(small).toEqual([]);
    // Five tabs on phones, with Diary and Goals together.
    await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link")).toHaveText(["Discover", "Protein", "Today", "Cook", "Friends"]);
  });
});

test.describe("automated accessibility scan (docs/14)", () => {
  for (const viewport of [{ width: 360, height: 740 }, { width: 1280, height: 800 }]) {
    test(`no serious or critical findings at ${viewport.width} px`, async ({ page, context }) => {
      await page.setViewportSize(viewport);
      await setDiet(context, "vegetarian", ["egg"]);
      for (const path of ["/discover", "/discover?view=needs_confirmation", "/diet", `/foods/${FOOD.peanutNoodles}`, `/foods/${FOOD.bowl}`, `/venues/${VENUE.central}`, `/protein?compare=${FOOD.tofu},${FOOD.crispbread}`, "/saved", "/login"]) {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await page.locator("details").evaluateAll((all) => all.forEach((d) => ((d as HTMLDetailsElement).open = true)));
        const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
        const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
        expect(blocking.map((v) => `${path}: ${v.id} (${v.nodes.length}) ${v.nodes[0]?.target}`)).toEqual([]);
      }
    });
  }
});

test.describe("honest numbers and filters", () => {
  test("unknown values are worded, never shown as 0; estimates are opt-in and labelled (R-P03, R-005)", async ({ page }) => {
    await page.goto("/discover?q=tempeh");
    const card = page.getByTestId("dish-card");
    await expect(card).toContainText("Estimate hidden");
    await expect(card).not.toContainText(/\b0 g/);
    await page.goto("/discover?q=tempeh&est=1");
    await expect(page.getByTestId("dish-card")).toContainText("about 28 g protein");
    await expect(page.getByTestId("dish-card")).toContainText("Estimated");

    await page.goto(`/foods/${FOOD.tempeh}`);
    await expect(page.getByTestId("protein-figure").first()).toHaveText("Estimate hidden");
    await page.getByRole("link", { name: "Show estimated values" }).click();
    await expect(page.getByTestId("protein-figure").first()).toContainText("28");
    await expect(page.getByTestId("nutrition-details").locator("table.data")).toContainText("Estimated");

    await page.goto("/discover?q=mushroom");
    await expect(page.getByTestId("dish-card")).toContainText("Protein not provided");
    await page.goto("/discover?q=zzzzqqqq");
    await expect(page.getByTestId("empty-state")).toContainText("No dishes match this search");
    await expect(page.getByTestId("empty-state")).toContainText("never fill gaps with guesses");
  });

  test("filters combine, and the minimum-protein filter says what it left out (R-D02)", async ({ page, context }) => {
    await setDiet(context, "vegetarian", ["egg"]);
    await page.goto("/discover");
    await page.locator("details.sheet > summary").first().click();
    await page.getByLabel("Protein per serving").selectOption("20");
    await page.getByLabel("Price").selectOption("2");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(page).toHaveURL(/protein=20/);
    await expect
      .poll(async () => (await page.getByTestId("dish-card").filter({ visible: true }).locator("h3").allTextContents()).sort())
      .toEqual(["Demo chickpea power bowl", "Demo paneer tikka", "Demo soft tofu stew"]);
    await expect(page.getByText("left out of the protein filter")).toBeVisible();
    await page.getByLabel("Neighbourhood", { exact: true }).selectOption("Harvard Square");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(page).toHaveURL(/hood=Harvard/);
    await expect(page.getByTestId("dish-card").locator("h3")).toHaveText(["Demo soft tofu stew"]); // waits for the new results
    await page.getByRole("link", { name: "Clear filters" }).click();
    await expect(page.getByTestId("results-heading")).toHaveText("7 confirmed matches");
  });

  test("a dish that contains an excluded ingredient says so plainly when opened directly", async ({ page, context }) => {
    await setDiet(context, "vegetarian", ["egg"]);
    await page.goto(`/foods/${FOOD.bibimbap}`);
    await expect(page.getByTestId("fit-result")).toContainText("Contains egg");
    await expect(page.getByTestId("fit-result")).toContainText("hidden from your search results");
    await page.goto(`/foods/${FOOD.peanutNoodles}`);
    await expect(page.getByTestId("fit-result")).toContainText("Only with a change");
    await expect(page.getByTestId("fit-result")).toContainText("without fish sauce");
    await expect(page.getByTestId("unknown-families")).toContainText("Not confirmed");
  });

  test("including dishes that need a change is a deliberate choice", async ({ page, context }) => {
    await setDiet(context, "vegetarian", [], true);
    await page.goto("/discover?q=peanut");
    await expect(page.getByTestId("results-heading")).toHaveText("1 confirmed match");
    await expect(page.getByTestId("dish-card")).toContainText("Only with a change");
    await expect(page.getByTestId("dish-card")).toContainText("Ask for the dressing without fish sauce.");
    await setDiet(context, "vegetarian", [], false);
    await page.goto("/discover?q=peanut");
    await expect(page.getByTestId("results-heading")).toHaveText("0 confirmed matches");
  });

  test("a dish or place that does not exist returns a real HTTP 404 with the not-found page", async ({ page, request }) => {
    for (const path of [`/foods/${randomUUID()}`, "/foods/not-an-id", `/dishes/${randomUUID()}`, `/venues/${randomUUID()}`, "/venues/not-an-id", `/foods/${randomUUID()}?est=1`]) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(404);
      expect(res?.headers()["cache-control"], path).toContain("no-store");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("We couldn’t find that");
      await expect(page.getByRole("link", { name: "Back to Discover" })).toBeVisible();
      await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute("content", /noindex/);
    }
    // The same answer without a browser, and for any other unknown address.
    expect((await request.get(`/foods/${randomUUID()}`)).status()).toBe(404);
    expect((await request.get("/no-such-page")).status()).toBe(404);
    // Real items are unaffected.
    expect((await request.get(`/foods/${FOOD.bowl}`)).status()).toBe(200);
    expect((await request.get(`/venues/${VENUE.central}`)).status()).toBe(200);
    const dishAlias = await request.get(`/dishes/${FOOD.bowl}`, { maxRedirects: 0 });
    expect([200, 307, 308]).toContain(dishAlias.status());
  });
});

test.describe("Protein Explorer (R-P01 to R-P05)", () => {
  test("three bases, unranked group, compare cap and deep link", async ({ page }) => {
    await page.goto("/protein");
    // Across everything, a home recipe leads since M4; among restaurant dishes it is still the paneer tikka.
    await expect(page.getByTestId("ranked-row").first()).toContainText("Demo sesame tofu and broccoli stir-fry");
    await page.getByRole("navigation", { name: "Kind of food" }).getByRole("link", { name: "Dishes" }).click();
    await expect(page.getByTestId("ranked-row").first()).toContainText("Demo paneer tikka");
    await page.goto("/protein");
    await expect(page.getByTestId("unranked-row").filter({ hasText: "Demo mushroom toast" })).toContainText("Protein not provided");

    await page.getByRole("link", { name: "Per 100 g" }).click();
    await expect(page).toHaveURL(/basis=100g/);
    await expect(page.getByTestId("ranked-row").first()).toContainText("Demo protein crispbread");
    await expect(page.getByTestId("ranked-row").first()).toContainText("40");
    await expect(page.getByTestId("unranked-row").filter({ hasText: "Demo veggie burger" })).toContainText("Serving weight not provided");

    await page.getByRole("link", { name: "Recipes" }).click();
    await expect(page.getByTestId("ranked-row").or(page.getByTestId("unranked-row")).filter({ hasText: "Demo red lentil soup" })).toHaveCount(1);

    // Deep link restores the selection; a fourth food cannot be added.
    await page.goto(`/protein?basis=100g&compare=${FOOD.tofu},${FOOD.crispbread},${FOOD.lentils}`);
    const panel = page.getByTestId("compare-panel");
    await expect(panel).toContainText("Comparing 3 of up to 3");
    for (const name of ["Demo firm tofu", "Demo protein crispbread", "Demo dry red lentils"]) await expect(panel).toContainText(name);
    await expect(page.getByText("Compare is full (3)").first()).toBeVisible();
    await page.goto(`/protein?compare=${FOOD.tofu},${FOOD.crispbread},${FOOD.lentils},${FOOD.stock}`);
    await expect(page.getByTestId("compare-panel")).toContainText("Comparing 3 of up to 3");
    await expect(page.getByTestId("compare-panel")).not.toContainText("Demo vegetable stock");

    // Incompatible basis prompts a change instead of showing a made-up number.
    await page.goto(`/protein?basis=100g&compare=${FOOD.tofu},${FOOD.peanutNoodles}`);
    await expect(page.getByTestId("compare-basis-warning")).toContainText("Demo peanut noodles");
    await panel.getByRole("link", { name: /Remove Demo peanut noodles/ }).click();
    await expect(page.getByTestId("compare-panel")).toContainText("Comparing 1 of up to 3");
  });
});

test.describe("location (R-D01, R-D04)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("near me lists the closest matches with distance", async ({ browser }) => {
    const context = await browser.newContext({ geolocation: { latitude: 42.3655, longitude: -71.104 }, permissions: ["geolocation"], viewport: { width: 390, height: 844 } });
    await setDiet(context, "vegetarian", ["egg"]);
    const page = await context.newPage();
    const posted: string[] = [];
    // With MAP-1 the List and the Map share one search (/api/v1/map/search); the point travels the same way.
    page.on("request", (r) => /\/api\/v1\/(catalog\/nearby|map\/search)/.test(r.url()) && posted.push(`${r.method()} ${r.url()}`));
    await page.goto("/discover");
    await page.getByRole("button", { name: "Use my location" }).click();
    const near = page.getByTestId("near-results").getByTestId("dish-card");
    await expect(near.first()).toContainText("Demo Central Kitchen");
    await expect(near.first()).toContainText("Under 0.1 mi");
    // Checked on the live list, so a late-arriving card would still be caught.
    await expect(near.locator("h3").filter({ hasText: "Demo veggie burger" })).toHaveCount(0);
    await expect(near.locator("h3").filter({ hasText: "Demo egg noodles" })).toHaveCount(0);
    // Coordinates travel in the request body, never in an address.
    expect(posted).toEqual(["POST http://localhost:3000/api/v1/map/search"]);
    expect(page.url()).not.toMatch(/42\.36|71\.10/);
    await context.close();
  });

  test("denied location offers neighbourhood entry; outside coverage is explained", async ({ browser }) => {
    const denied = await browser.newContext({ permissions: [] });
    const page = await denied.newPage();
    await page.goto("/discover");
    await page.getByRole("button", { name: "Use my location" }).click();
    await expect(page.getByText("Location is off, and that's fine. Type a neighbourhood, city or ZIP code instead.")).toBeVisible();
    await page.locator("details.sheet > summary").first().click();
    await page.getByLabel("Neighbourhood", { exact: true }).selectOption("Allston");
    await page.getByRole("button", { name: "Apply filters" }).click();
    // Wait for the filtered results to arrive: reading the cards once, straight after the
    // click, can catch the moment before the new list is on the page.
    await expect
      .poll(async () => (await page.getByTestId("dish-card").filter({ visible: true }).locator("h3").allTextContents()).sort())
      .toEqual(["Demo idli sambar", "Demo masala dosa"]);
    await denied.close();

    const far = await browser.newContext({ geolocation: { latitude: 34.05, longitude: -118.24 }, permissions: ["geolocation"] });
    const farPage = await far.newPage();
    await farPage.goto("/discover");
    await farPage.getByRole("button", { name: "Use my location" }).click();
    await expect(farPage.getByText(/We currently cover the Boston area only/)).toBeVisible();
    await far.close();
  });
});

test.describe("catalog API (docs/11)", () => {
  test("validation, not found, cache headers and minimal fields", async ({ request }) => {
    const ok = await request.get("/api/v1/catalog/search?q=chickpea&diet=vegetarian&exclusions=egg");
    expect(ok.status()).toBe(200);
    expect(ok.headers()["cache-control"]).toContain("no-store");
    const body = await ok.json();
    const names = body.data.items.map((i: { name: string }) => i.name);
    expect(names).toContain("Demo chickpea power bowl");
    expect(names.every((n: string) => /chickpea|chana/i.test(n))).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/source_record_id|owner_id|created_by|service_role/);

    for (const bad of ["limit=500", "view=everything", "kinds=dish,weapon", "exclusions=peanut", "minProtein=-3", "offset=-1", "venueId=1%20or%201=1", "basis=cup"]) {
      const res = await request.get(`/api/v1/catalog/search?${bad}`);
      expect(res.status(), bad).toBe(422);
      expect((await res.json()).error.code).toMatch(/^INVALID_/);
    }
    expect((await request.get(`/api/v1/foods/${randomUUID()}`)).status()).toBe(404);
    expect((await request.get("/api/v1/foods/not-an-id")).status()).toBe(404);
    expect((await request.get(`/api/v1/venues/${randomUUID()}`)).status()).toBe(404);
    expect((await request.get(`/api/v1/venues/${VENUE.central}`)).status()).toBe(200);
    const food = await (await request.get(`/api/v1/foods/${FOOD.bowl}`)).json();
    expect(food.data.nutrients.find((n: { code: string }) => n.code === "protein_g").source.publisher).toBe("Synthetic demo fixtures");

    expect((await request.get("/api/v1/protein/compare")).status()).toBe(422);
    expect((await request.get(`/api/v1/protein/compare?ids=${[FOOD.tofu, FOOD.crispbread, FOOD.lentils, FOOD.stock].join(",")}`)).status()).toBe(422);
    const compare = await request.get(`/api/v1/protein/compare?ids=${FOOD.tofu},${FOOD.crispbread}`);
    expect((await compare.json()).data).toHaveLength(2);
  });

  test("nearby takes a point in the body only and never caches", async ({ request }) => {
    const res = await request.post("/api/v1/catalog/nearby", { data: { lat: 42.3655, lon: -71.104, radiusM: 1000, kinds: "dish" } });
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toBe("private, no-store");
    const body = await res.json();
    expect(body.data.applied.sort).toBe("distance");
    expect(body.data.items.every((i: { venue: { name: string } }) => i.venue.name === "Demo Central Kitchen")).toBe(true);
    expect(JSON.stringify(body)).not.toContain("42.3655");
    for (const data of [{ lat: 95, lon: 0 }, { lat: 42.3 }, { lat: 42.3, lon: -71.1, radiusM: 999999 }, [1, 2]]) {
      expect((await request.post("/api/v1/catalog/nearby", { data })).status()).toBe(422);
    }
    expect((await request.post("/api/v1/catalog/nearby", { data: "not json", headers: { "content-type": "application/json" } })).status()).toBe(422);
    expect((await request.get("/api/v1/catalog/nearby?lat=42.3&lon=-71.1")).status()).toBe(405);
  });

  test("the 61st request in a minute from one address is refused", async ({ request }) => {
    const headers = { "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 250) + 1}, 10.0.0.1` };
    // Stay inside one clock minute so the fixed window cannot roll over mid-test.
    const secondsLeft = 60 - (Math.floor(Date.now() / 1000) % 60);
    if (secondsLeft < 15) await new Promise((r) => setTimeout(r, (secondsLeft + 1) * 1000));
    const statuses: number[] = [];
    for (let batch = 0; batch < 7; batch++) {
      statuses.push(...(await Promise.all(Array.from({ length: 10 }, () => request.get("/api/v1/catalog/search?limit=1", { headers }).then((r) => r.status())))));
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(60);
    expect(statuses.filter((s) => s === 429)).toHaveLength(10);
    const limited = await request.get("/api/v1/catalog/search?limit=1", { headers });
    expect(limited.status()).toBe(429);
    expect(limited.headers()["retry-after"]).toBe("60");
    // A different address is unaffected.
    expect((await request.get("/api/v1/catalog/search?limit=1", { headers: { "x-forwarded-for": "198.51.100.7" } })).status()).toBe(200);
  });
});

test.describe("saves and corrections (R-001, R-D05, R-D06)", () => {
  test("guest save leads to sign-in and back without saving; saves are private; corrections are queued", async ({ browser }) => {
    test.setTimeout(120_000);
    const emailA = `m2-a-${randomUUID().slice(0, 8)}@example.test`;
    const emailB = `m2-b-${randomUUID().slice(0, 8)}@example.test`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();

    // Guest presses Save.
    await a.goto(`/foods/${FOOD.bowl}`);
    await a.getByTestId("save-button").click();
    await expect(a).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(`/foods/${FOOD.bowl}`)}`));
    await expect(a.getByText("you’ll go back to the page you were on")).toBeVisible();
    await completeSignIn(a, emailA);

    // Back on the dish, signed in, and NOT saved for them.
    await expect(a).toHaveURL(new RegExp(`/foods/${FOOD.bowl}$`));
    const save = a.getByTestId("save-button");
    await expect(save).toHaveText("Save");
    await expect(save).toHaveAttribute("aria-pressed", "false");
    await a.goto("/saved");
    await expect(a.getByTestId("saved-empty")).toBeVisible();

    // Now they save it themselves.
    await a.goto(`/foods/${FOOD.bowl}`);
    await a.getByTestId("save-button").click();
    await expect(a.getByTestId("save-button")).toHaveText("Saved · Remove");
    await expect(a.getByTestId("save-status")).toContainText("Only you can see your saved list");
    await a.goto(`/venues/${VENUE.central}`);
    await a.getByTestId("save-button").click();
    await expect(a.getByTestId("save-button")).toHaveText("Saved · Remove");
    const saved = await a.goto("/saved");
    expect(saved?.headers()["cache-control"]).toContain("no-store");
    await expect(a.getByTestId("saved-food")).toContainText("Demo chickpea power bowl");
    await expect(a.getByTestId("saved-venue")).toContainText("Demo Central Kitchen");

    // The save survives a new page in the same session and is invisible to another member.
    const b = await ctxB.newPage();
    await b.goto("/login?next=/saved");
    await completeSignIn(b, emailB);
    await expect(b).toHaveURL(/\/saved$/);
    await expect(b.getByTestId("saved-empty")).toBeVisible();
    await expect(b.locator("body")).not.toContainText("Demo chickpea power bowl");
    await b.goto(`/foods/${FOOD.bowl}`);
    await expect(b.getByTestId("save-button")).toHaveText("Save");

    // Correction: validation, then queued with a clear message; the page itself does not change.
    await a.goto(`/foods/${FOOD.bowl}`);
    await a.getByText("Report a problem with this page").click();
    // Scoped to the correction form: public reviews on the same dish each carry their own
    // "What is wrong?" report form, so an unscoped label matched several fields once other
    // journeys had left reviews here (seen in the re-run on main 0ac3ac8, 16 Nov).
    const correction = a.getByRole("form", { name: "Report a problem with this page" });
    await correction.getByLabel("What is wrong?").selectOption("egg");
    await correction.getByLabel("What should it say?").fill("The dressing has egg in it <script>alert(1)</script>");
    await correction.getByLabel("How do you know? (optional)").fill("Menu on 12 Nov");
    await correction.getByRole("button", { name: "Send correction" }).click();
    await expect(a.getByText("A person will review this before anything on the page changes.")).toBeVisible();
    await a.reload();
    await expect(a.getByTestId("food-name")).toHaveText("Demo chickpea power bowl");
    await expect(a.locator("body")).not.toContainText("The dressing has egg in it");

    // Guests are asked to sign in before reporting.
    const guest = await (await browser.newContext()).newPage();
    await guest.goto(`/venues/${VENUE.central}`);
    await guest.getByText("Report a problem with this page").click();
    await expect(guest.getByRole("link", { name: "Sign in to send a correction" })).toBeVisible();

    // Removing a save works.
    await a.getByTestId("save-button").click();
    await expect(a.getByTestId("save-button")).toHaveText("Save");
    await a.goto("/saved");
    await expect(a.getByTestId("saved-food")).toHaveCount(0);
    await expect(a.getByTestId("saved-venue")).toHaveCount(1);
  });
});
