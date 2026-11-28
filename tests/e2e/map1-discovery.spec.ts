import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Request } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { VENUE, completeSignIn, expectNoSidewaysScroll, setDiet } from "./helpers";

/**
 * MAP-1 acceptance in a real browser (plans/2026-11-15-map-1-architecture-proposal.md, docs/14
 * T-MAP, docs/20 section 16). Local production build and local Supabase only; the ordinary
 * seed data (5 demo places), not the optional map demo places.
 */
const WIDE = { width: 1280, height: 860 };
const isMapSearch = (r: Request) => r.url().endsWith("/api/v1/map/search") && r.method() === "POST";

async function openMap(page: Page) {
  await page.getByRole("group", { name: "Show results as" }).getByRole("button", { name: "Map" }).click();
  await expect(page.getByTestId("map-view")).toBeVisible();
  // A first visit has a welcome above the results, so the map may start below the fold: scroll to it as a person would.
  await page.getByTestId("map-view").scrollIntoViewIfNeeded();
  await expect(page.locator(".map-pin, .map-bubble").first()).toBeVisible();
}

/** Places drawn on the map (MAP-1.1): single pins plus the places inside each numbered bubble. */
async function placesOnMap(page: Page) {
  return page.evaluate(() => {
    const pins = document.querySelectorAll("[data-testid=map-pin]").length;
    const inBubbles = [...document.querySelectorAll<HTMLElement>("[data-testid=map-bubble]")].reduce((n, b) => n + Number(b.dataset.count), 0);
    return pins + inBubbles;
  });
}

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

test.describe("List and Map (R-MAP-01, R-MAP-06, MAP-D)", () => {
  test("List is the default; the map code loads only when Map is opened; both show the same dishes", async ({ browser }) => {
    const context = await browser.newContext({ viewport: WIDE });
    await setDiet(context, "vegan");
    const page = await context.newPage();
    const scripts: string[] = [];
    const hosts = new Set<string>();
    page.on("request", (r) => {
      hosts.add(new URL(r.url()).host);
      if (/maplibre|map-canvas/i.test(r.url())) scripts.push(r.url());
    });
    await page.goto("/discover");
    await expect(page.getByRole("group", { name: "Show results as" }).getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("dish-card").first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(scripts, "MapLibre must not load in List view (T-MAP 17)").toEqual([]);
    await expect(page.getByTestId("map-view")).toHaveCount(0);

    await openMap(page);
    expect(scripts.some((u) => /maplibre-gl-worker-[\d.]+\.mjs$/.test(u))).toBe(true);
    // The choice is kept for this visit only.
    await page.reload();
    await expect(page.getByTestId("map-view")).toBeVisible();
    await expect(page.locator(".map-pin, .map-bubble").first()).toBeVisible();

    // Matches view: every pin is the round "fits" pin with a number, never the dashed one.
    const pins = page.getByTestId("map-pin");
    const n = await placesOnMap(page);
    expect(n).toBeGreaterThan(0);
    await expect(page.locator(".map-pin.unsure, .map-bubble.unsure")).toHaveCount(0);
    // After a new search the map shows every place: each pin and bubble is drawn inside the map, at its position.
    const outside = await page.evaluate(() => {
      const c = document.querySelector("[data-testid=map-canvas]")!.getBoundingClientRect();
      return [...document.querySelectorAll(".map-pin, .map-bubble")].filter((e) => {
        const q = e.getBoundingClientRect();
        return !(getComputedStyle(e).position === "absolute" && q.left >= c.left && q.right <= c.right && q.top >= c.top && q.bottom <= c.bottom);
      }).length;
    });
    expect(outside).toBe(0);
    for (let i = 0; i < (await pins.count()); i++) await expect(pins.nth(i)).toHaveAttribute("aria-label", /dish(es)? fits?\b/);

    // Same dishes as the List for the same filter (the list API and the map API share one search).
    const list = await (await page.request.get("/api/v1/catalog/search?diet=vegan&kinds=dish&limit=50")).json();
    const map = await (await page.request.post("/api/v1/map/search", { data: { diet: "vegan", area: { kind: "market" } } })).json();
    const listIds = list.data.items.map((i: { foodItemId: string }) => i.foodItemId).sort();
    const mapIds = map.data.places.flatMap((p: { dishes: { foodItemId: string }[] }) => p.dishes.map((d) => d.foodItemId)).sort();
    expect(mapIds).toEqual(listIds);
    expect(map.data.places).toHaveLength(n);

    // The credit for whichever background is drawn is visible, and no request leaves this computer.
    if ((await page.getByTestId("map-canvas").getAttribute("data-background")) === "street") {
      await expect(page.locator(".maplibregl-ctrl-attrib").getByRole("link", { name: "OpenStreetMap" })).toBeVisible();
    } else {
      await expect(page.getByText("Demo map: plain background, no street map.")).toBeVisible();
    }
    expect([...hosts]).toEqual(["localhost:3000"]);
    await context.close();
  });

  test("Needs confirmation shows only dashed question-mark pins and says so", async ({ browser }) => {
    const context = await browser.newContext({ viewport: WIDE });
    await setDiet(context, "vegan");
    const page = await context.newPage();
    await page.goto("/discover?view=needs_confirmation");
    await openMap(page);
    await expect(page.locator(".map-pin.fits")).toHaveCount(0);
    const pins = page.getByTestId("map-pin");
    for (let i = 0; i < (await pins.count()); i++) {
      await expect(pins.nth(i)).toHaveText("?");
      await expect(pins.nth(i)).toHaveAttribute("aria-label", /need(s)? confirmation/);
    }
    await pins.first().click();
    const panel = page.getByTestId("place-panel");
    await expect(panel.getByText("Not confirmed.", { exact: true })).toBeVisible();
    await expect(panel.getByRole("heading", { level: 3 })).toContainText("Not confirmed for your filter");
    await context.close();
  });

  test("place panel by keyboard: details, dishes with protein, directions, and focus returns to the pin", async ({ browser }) => {
    const context = await browser.newContext({ viewport: WIDE });
    await setDiet(context, "vegetarian", ["egg"]);
    const page = await context.newPage();
    await page.goto("/discover");
    await openMap(page);
    const pin = page.locator(`.map-pin[data-place-id="${VENUE.central}"]`);
    await pin.focus();
    await page.keyboard.press("Enter");
    const panel = page.getByTestId("place-panel");
    await expect(panel.getByRole("heading", { level: 2 })).toHaveText("Demo Central Kitchen");
    await expect(panel.getByRole("heading", { level: 2 })).toBeFocused();
    await expect(pin).toHaveAttribute("aria-pressed", "true");
    await expect(panel).toContainText("Demo data.");
    await expect(panel.getByRole("heading", { level: 3 })).toContainText("Dishes that fit your filter");
    await expect(panel.getByTestId("place-dish").first()).toContainText("g protein");
    // Egg-free vegetarian: the egg dish is not in the panel.
    await expect(panel.getByTestId("place-dish").filter({ hasText: "Demo egg noodles" })).toHaveCount(0);
    for (const name of ["Apple Maps", "Google Maps", "OpenStreetMap"]) {
      const link = panel.getByRole("link", { name: new RegExp(name) });
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", /noopener/);
      expect(await link.getAttribute("href")).toMatch(/^https:\/\//);
    }
    await expect(panel.getByRole("link", { name: "See the place" })).toHaveAttribute("href", `/venues/${VENUE.central}`);
    await panel.getByRole("button", { name: "Back to all places" }).click();
    await expect(pin).toBeFocused();
    await expect(page.getByTestId("map-sheet").getByRole("button", { name: /Demo Central Kitchen/ })).toBeVisible();
    await context.close();
  });

  test("radius choices are 0.25 to 5 miles; changing it searches again with the chosen distance", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto("/discover");
    const radius = page.getByLabel("Within");
    await expect(radius).toHaveValue("805"); // phone default 0.5 mile
    expect(await radius.locator("option").allTextContents()).toEqual(["0.25 mile", "0.5 mile", "1 mile", "3 miles", "5 miles"]);
    await page.getByLabel("Neighbourhood, city or ZIP code").fill("Harvard Square");
    const first = page.waitForRequest(isMapSearch);
    await page.getByRole("button", { name: "Go", exact: true }).click();
    expect(JSON.parse((await first).postData() ?? "{}").area).toMatchObject({ kind: "radius", radiusM: 805 });
    await expect(page.getByTestId("map-status")).toContainText("within 0.5 mile of Harvard Square (approximate centre)");
    const second = page.waitForRequest(isMapSearch);
    await radius.selectOption("4828");
    expect(JSON.parse((await second).postData() ?? "{}").area).toMatchObject({ kind: "radius", radiusM: 4828 });
    await expect(page.getByTestId("map-status")).toContainText("within 3 miles of Harvard Square");
    await context.close();

    const wide = await browser.newContext({ viewport: WIDE });
    const widePage = await wide.newPage();
    await widePage.goto("/discover");
    await expect(widePage.getByLabel("Within")).toHaveValue("1609"); // desktop default 1 mile
    await wide.close();
  });

  test("filters keep the map and the chosen area", async ({ browser }) => {
    const context = await browser.newContext({ viewport: WIDE });
    await setDiet(context, "vegan");
    const page = await context.newPage();
    await page.goto("/discover");
    await openMap(page);
    await page.getByLabel("Neighbourhood, city or ZIP code").fill("Allston");
    await page.getByRole("button", { name: "Go", exact: true }).click();
    await expect(page.getByTestId("map-status")).toContainText("of Allston (approximate centre)");
    const next = page.waitForRequest(isMapSearch);
    await page.getByLabel("Search dishes and places").fill("dosa");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const body = JSON.parse((await next).postData() ?? "{}");
    expect(body.q).toBe("dosa");
    expect(body.area.kind).toBe("radius");
    await expect(page.getByTestId("map-view")).toBeVisible();
    await expect(page.getByTestId("map-status")).toContainText("of Allston");
    await context.close();
  });
});

test.describe("Search this area (R-MAP-09)", () => {
  test("appears only after the person moves the map, and sends exactly one search", async ({ browser }) => {
    const context = await browser.newContext({ viewport: WIDE });
    const page = await context.newPage();
    const searches: Request[] = [];
    page.on("request", (r) => isMapSearch(r) && searches.push(r));
    await page.goto("/discover");
    await openMap(page);
    await page.waitForLoadState("networkidle");
    const before = searches.length;
    await expect(page.getByRole("button", { name: "Search this area" })).toHaveCount(0);

    // Drag the map: no search is sent while moving.
    const box = (await page.getByTestId("map-canvas").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 150, box.y + box.height / 2 - 60, { steps: 12 });
    await page.mouse.up();
    await expect(page.getByRole("button", { name: "Search this area" })).toBeVisible();
    await page.waitForTimeout(500);
    expect(searches.length).toBe(before);

    await page.getByRole("button", { name: "Search this area" }).click();
    await expect(page.getByTestId("map-status")).toContainText("this map area");
    await page.waitForLoadState("networkidle");
    expect(searches.length).toBe(before + 1);
    const area = JSON.parse(searches[searches.length - 1].postData() ?? "{}").area;
    expect(area.kind).toBe("box");
    for (const k of ["west", "south", "east", "north"]) expect(String(area[k])).toMatch(/^-?\d+(\.\d{1,3})?$/);
    // The app's own move to the new results does not offer the button again.
    await expect(page.getByRole("button", { name: "Search this area" })).toHaveCount(0);
    await context.close();
  });
});

test.describe("location privacy (R-MAP-02, docs/20 section 10)", () => {
  test("one reading, rounded to about 100 m, sent only in a request body, never in the address or storage", async ({ browser }) => {
    const context = await browser.newContext({ geolocation: { latitude: 42.365519, longitude: -71.104031 }, permissions: ["geolocation"], viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const w = window as unknown as { __geoCalls: { get: number; watch: number } };
      w.__geoCalls = { get: 0, watch: 0 };
      const g = navigator.geolocation;
      const get = g.getCurrentPosition.bind(g);
      g.getCurrentPosition = (...a: Parameters<Geolocation["getCurrentPosition"]>) => {
        w.__geoCalls.get++;
        return get(...a);
      };
      g.watchPosition = () => {
        w.__geoCalls.watch++;
        return 0;
      };
    });
    const all: Request[] = [];
    page.on("request", (r) => all.push(r));
    await page.goto("/discover");
    await expect(page.getByText(/an approximate position \(about 100 m\) is sent to our server for this one search and is\s+not saved/)).toBeVisible();
    // Nothing is asked before the button is pressed.
    expect(await page.evaluate(() => (window as unknown as { __geoCalls: { get: number } }).__geoCalls.get)).toBe(0);

    await page.getByRole("button", { name: "Use my location" }).click();
    await expect(page.getByTestId("near-results").getByTestId("dish-card").first()).toContainText("Demo Central Kitchen");
    expect(await page.evaluate(() => (window as unknown as { __geoCalls: { get: number; watch: number } }).__geoCalls)).toEqual({ get: 1, watch: 0 });

    const sent = all.filter(isMapSearch);
    expect(sent).toHaveLength(1);
    const body = sent[0].postData() ?? "";
    expect(JSON.parse(body).area).toEqual({ kind: "radius", lat: 42.366, lon: -71.104, radiusM: 805 });
    expect(body).not.toMatch(/42\.3655|71\.10403/);
    for (const r of all) expect(r.url(), "no position in any address").not.toMatch(/42\.36|71\.10/);
    expect(page.url()).not.toMatch(/42\.36|71\.10/);
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie);
    expect(stored).not.toMatch(/42\.36|71\.10/);

    // Switching to the Map keeps using the same reading; it does not ask again.
    await openMap(page);
    expect(await page.evaluate(() => (window as unknown as { __geoCalls: { get: number } }).__geoCalls.get)).toBe(1);
    await context.close();
  });

  test("with location denied, typing a neighbourhood, city or ZIP code still works; addresses are not guessed", async ({ browser }) => {
    const context = await browser.newContext({ permissions: [], viewport: { width: 390, height: 844 } });
    await setDiet(context, "vegetarian");
    const page = await context.newPage();
    await page.goto("/discover");
    await page.getByRole("button", { name: "Use my location" }).click();
    await expect(page.getByText("Location is off, and that's fine. Type a neighbourhood, city or ZIP code instead.")).toBeVisible();

    const place = page.getByLabel("Neighbourhood, city or ZIP code");
    await place.fill("Allston");
    await page.getByRole("button", { name: "Go", exact: true }).click();
    await expect(page.getByTestId("map-status")).toContainText("of Allston (approximate centre)");
    await expect
      .poll(async () => (await page.getByTestId("near-results").getByTestId("dish-card").locator("h3").allTextContents()).sort())
      .toEqual(["Demo idli sambar", "Demo masala dosa"]);

    await place.fill("02139");
    await page.getByRole("button", { name: "Go", exact: true }).click();
    await expect(page.getByTestId("map-status")).toContainText("of 02139 (approximate centre)");

    await place.fill("12 Example Street");
    await page.getByRole("button", { name: "Go", exact: true }).click();
    await expect(page.getByText(/Street addresses are not supported yet/)).toBeVisible();
    await context.close();
  });
});

test.describe("your places (R-MAP-07)", () => {
  test("signed-in members can show only their saved places; guests see no personal layers", async ({ browser }) => {
    test.setTimeout(120_000);
    const guest = await browser.newContext({ viewport: WIDE });
    const g = await guest.newPage();
    await g.goto("/discover");
    await openMap(g);
    await expect(g.getByRole("group", { name: "Show only" })).toHaveCount(0);
    await guest.close();

    const context = await browser.newContext({ viewport: WIDE });
    const page = await context.newPage();
    await page.goto("/login");
    await completeSignIn(page, `map1-${randomUUID().slice(0, 8)}@example.test`);
    await page.goto(`/venues/${VENUE.central}`);
    await page.getByTestId("save-button").click();
    await expect(page.getByTestId("save-button")).toHaveText("Saved · Remove");
    await page.goto("/discover");
    await openMap(page);
    const all = await page.getByTestId("map-pin").count();
    expect(all).toBeGreaterThan(1);
    await page.getByRole("group", { name: "Show only" }).getByLabel("Places I saved").check();
    await expect(page.getByTestId("map-pin")).toHaveCount(1);
    await page.getByTestId("map-pin").click();
    await expect(page.getByTestId("place-panel").getByRole("list", { name: "Yours" })).toContainText("Saved");
    await context.close();
  });
});

test.describe("accessibility and layout (R-MAP-11, T-MAP 12)", () => {
  for (const [name, viewport] of [
    ["320 px (the 200% zoom check)", { width: 320, height: 640 }],
    ["phone", { width: 390, height: 844 }],
    ["desktop", WIDE],
  ] as const) {
    test(`List and Map have no automated accessibility failures and no sideways scroll at ${name}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport });
      await setDiet(context, "vegan");
      const page = await context.newPage();
      await page.goto("/discover");
      await expect(page.getByTestId("dish-card").first()).toBeVisible();
      await axe(page);
      await expectNoSidewaysScroll(page);
      await openMap(page);
      await page.getByTestId("map-pin").first().click();
      await expect(page.getByTestId("place-panel")).toBeVisible();
      await axe(page);
      await expectNoSidewaysScroll(page);
      await context.close();
    });
  }

  test("the 200% zoom equivalent keeps every control reachable by keyboard", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.goto("/discover");
    await page.evaluate(() => {
      document.documentElement.style.zoom = "2";
    });
    await expectNoSidewaysScroll(page);
    await page.getByRole("group", { name: "Show results as" }).getByRole("button", { name: "Map" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".map-pin, .map-bubble").first()).toBeVisible();
    // Every place is also a plain button in the list beside the map.
    const rows = page.getByTestId("map-sheet").locator("button.place-row");
    expect(await rows.count()).toBe(await placesOnMap(page));
    await rows.first().focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("place-panel").getByRole("heading", { level: 2 })).toBeFocused();
    await context.close();
  });
});

test.describe("map search API (docs/11, T-MAP 14 and 15)", () => {
  test("takes the area in the body only, validates it, never caches and returns minimal fields", async ({ request }) => {
    const ok = await request.post("/api/v1/map/search", { data: { diet: "vegan", area: { kind: "radius", lat: 42.365519, lon: -71.104031, radiusM: 805 } } });
    expect(ok.status()).toBe(200);
    expect(ok.headers()["cache-control"]).toBe("private, no-store");
    const text = await ok.text();
    expect(text).not.toMatch(/42\.365519|71\.104031|source_record_id|owner_id|created_by|service_role|user_id/);
    const body = JSON.parse(text);
    expect(body.data.applied).toMatchObject({ area: "radius", radiusM: 805, diet: "vegan" });
    // Guests get no personal layer.
    expect(body.data.places.every((p: { mine: unknown }) => p.mine === null)).toBe(true);

    for (const data of [
      { area: { kind: "radius", lat: 42.3, lon: -71.1, radiusM: 1000 } },
      { area: { kind: "box", west: -75, south: 40, east: -70, north: 43 } },
      { area: { kind: "radius", lat: "42.3", lon: -71.1, radiusM: 805 } },
      { area: { kind: "market" }, diet: "carnivore" },
      { area: { kind: "market" }, view: "everything" },
      {},
      [1, 2],
    ]) {
      const res = await request.post("/api/v1/map/search", { data });
      expect(res.status(), JSON.stringify(data)).toBe(422);
    }
    expect((await request.post("/api/v1/map/search", { data: "not json", headers: { "content-type": "application/json" } })).status()).toBe(422);
    expect((await request.post("/api/v1/map/search", { data: { area: { kind: "market" }, q: "x".repeat(5000) } })).status()).toBe(422);
    expect((await request.get("/api/v1/map/search")).status()).toBe(405);
  });

  test("shares the catalog rate limit: the 61st request in a minute from one address is refused", async ({ request }) => {
    // The forged-header case for this route runs against the strict second server in r1-hardening.spec.ts (T-MAP 15).
    const headers = { "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 250) + 1}, 10.0.0.1` };
    const secondsLeft = 60 - (Math.floor(Date.now() / 1000) % 60);
    if (secondsLeft < 15) await new Promise((r) => setTimeout(r, (secondsLeft + 1) * 1000));
    const statuses: number[] = [];
    for (let batch = 0; batch < 7; batch++) {
      statuses.push(
        ...(await Promise.all(Array.from({ length: 10 }, () => request.post("/api/v1/map/search", { data: { area: { kind: "market" } }, headers }).then((r) => r.status())))),
      );
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(60);
    expect(statuses.filter((s) => s === 429)).toHaveLength(10);
  });
});
