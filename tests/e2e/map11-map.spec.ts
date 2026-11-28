import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { VENUE, expectNoSidewaysScroll, setDiet } from "./helpers";

/**
 * MAP-1.1 acceptance in a real browser (plans/2026-11-15-map-1-1-plan.md section 8,
 * plans/2026-11-15-zero-cost-resource-audit.md section 10). Local production build and local
 * Supabase only. The server has a street-map file configured (the small committed test map in CI,
 * or the full Boston file locally), so the street path is exercised; the plain fallback is tested
 * by making that file unavailable.
 */
const WIDE = { width: 1280, height: 860 };
const PHONE = { width: 390, height: 844 };

async function openMap(page: Page) {
  await page.getByRole("group", { name: "Show results as" }).getByRole("button", { name: "Map" }).click();
  await expect(page.getByTestId("map-view")).toBeVisible();
  // A first visit has a welcome above the results, so the map may start below the fold: scroll to it as a person would.
  await page.getByTestId("map-view").scrollIntoViewIfNeeded();
  await expect(page.locator(".map-pin, .map-bubble").first()).toBeVisible();
}
async function drawn(page: Page) {
  return page.evaluate(() => {
    const pins = [...document.querySelectorAll<HTMLElement>("[data-testid=map-pin]")].map((e) => e.dataset.placeId!);
    const bubbles = [...document.querySelectorAll<HTMLElement>("[data-testid=map-bubble]")].map((b) => Number(b.dataset.count));
    return { pins, bubbles, total: pins.length + bubbles.reduce((a, b) => a + b, 0) };
  });
}
async function marketPlaces(page: Page) {
  const res = await page.request.post("/api/v1/map/search", { data: { area: { kind: "market" } } });
  return ((await res.json()) as { data: { places: { id: string }[] } }).data.places.length;
}
async function zoomOutFully(page: Page) {
  const out = page.getByRole("button", { name: "Zoom out" });
  const zoom = () => page.getByTestId("map-canvas").getAttribute("data-zoom");
  for (let i = 0; i < 12; i++) {
    if (await out.isDisabled()) break;
    const before = await zoom();
    await out.click();
    // Let each step finish before checking again: at the widest zoom the button switches off, and a
    // click sent while the previous step is still moving would wait for a button that never returns.
    await expect.poll(zoom).not.toBe(before);
    await expect
      .poll(async () => {
        const a = await zoom();
        await page.waitForTimeout(250);
        return a === (await zoom());
      })
      .toBe(true);
  }
  await expect(out).toBeDisabled();
  await page.waitForTimeout(400);
}

test.describe("street map (MAP-1.1)", () => {
  for (const vp of [{ width: 320, height: 700 }, WIDE]) {
    test(`draws the Boston street map from this site only, with a visible linked credit at ${vp.width} px`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: vp });
      const page = await context.newPage();
      const hosts = new Set<string>();
      const ranges: number[] = [];
      page.on("request", (r) => hosts.add(new URL(r.url()).host));
      page.on("response", (r) => {
        if (r.url().endsWith("/map-data/streets")) ranges.push(r.status());
      });
      await page.goto("/discover");
      await openMap(page);
      await expect(page.getByTestId("map-canvas")).toHaveAttribute("data-background", "street");
      const credit = page.locator(".maplibregl-ctrl-attrib");
      await expect(credit.getByRole("link", { name: "OpenStreetMap" })).toBeVisible();
      await expect(credit.getByRole("link", { name: "OpenStreetMap" })).toHaveAttribute("href", "https://www.openstreetmap.org/copyright");
      await expect(credit.getByRole("link", { name: "Protomaps" })).toBeVisible();
      await expect(page.getByText("Demo map: plain background")).toHaveCount(0);
      // The credit is not covered by the sheet, a control or a pin.
      await credit.scrollIntoViewIfNeeded();
      const covered = await page.evaluate(() => {
        const a = document.querySelector(".maplibregl-ctrl-attrib a[href*='openstreetmap']")!.getBoundingClientRect();
        const hit = document.elementFromPoint(a.left + a.width / 2, a.top + a.height / 2);
        return !hit?.closest(".maplibregl-ctrl-attrib");
      });
      expect(covered).toBe(false);
      await expectNoSidewaysScroll(page);
      expect(ranges.length).toBeGreaterThan(0);
      expect(ranges.every((s) => s === 206)).toBe(true);
      expect([...hosts]).toEqual(["localhost:3000"]);
      await context.close();
    });
  }

  test("falls back to the plain background, and says so, when the street-map file is unavailable", async ({ browser }) => {
    const context = await browser.newContext({ viewport: WIDE });
    const page = await context.newPage();
    await page.route("**/map-data/streets", (r) => r.fulfill({ status: 404, body: "gone" }));
    await page.goto("/discover");
    await openMap(page);
    await expect(page.getByTestId("map-canvas")).toHaveAttribute("data-background", "plain");
    await expect(page.getByTestId("street-fallback")).toContainText("The street map couldn’t be loaded");
    await expect(page.getByText("Demo map: plain background, no street map.")).toBeVisible();
    // The places and the list are unaffected.
    expect((await drawn(page)).total).toBe(await marketPlaces(page));
    await expect(page.getByTestId("map-sheet").locator("button.place-row").first()).toBeVisible();
    await context.close();
  });

  test("falls back when the file is not a street map (damaged or wrong file)", async ({ browser }) => {
    const context = await browser.newContext({ viewport: WIDE });
    const page = await context.newPage();
    await page.route("**/map-data/streets", (r) =>
      r.fulfill({ status: 206, headers: { "Content-Range": "bytes 0-16383/16384", "Accept-Ranges": "bytes" }, body: Buffer.alloc(16384, 7) }),
    );
    await page.goto("/discover");
    await openMap(page);
    await expect(page.getByTestId("map-canvas")).toHaveAttribute("data-background", "plain");
    await expect(page.getByTestId("street-fallback")).toBeVisible();
    await context.close();
  });

  test("when the map cannot be drawn at all, the list still has every place (T-MAP 13)", async ({ browser }) => {
    const context = await browser.newContext({ viewport: WIDE });
    await context.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        if (/webgl/i.test(type)) return null;
        return (original as (...a: unknown[]) => unknown).call(this, type, ...rest);
      } as typeof HTMLCanvasElement.prototype.getContext;
    });
    const page = await context.newPage();
    await page.goto("/discover");
    await page.getByRole("group", { name: "Show results as" }).getByRole("button", { name: "Map" }).click();
    await expect(page.getByText("The map can’t be drawn in this browser. The list beside it has the same places.")).toBeVisible();
    await expect(page.getByTestId("map-sheet").locator("button.place-row")).toHaveCount(await marketPlaces(page));
    await context.close();
  });
});

test.describe("clustering and decluttering (MAP-1.1)", () => {
  test("zoomed out, places merge into numbered bubbles; the count of places never changes; pressing a bubble zooms in", async ({ browser }) => {
    const context = await browser.newContext({ viewport: WIDE });
    const page = await context.newPage();
    await page.goto("/discover");
    await openMap(page);
    const expected = await marketPlaces(page);
    const before = await drawn(page);
    expect(before.total).toBe(expected);

    await zoomOutFully(page);
    const far = await drawn(page);
    expect(far.bubbles.length).toBeGreaterThan(0);
    expect(far.total).toBe(expected);
    // No two markers overlap at the whole-market zoom.
    const overlaps = await page.evaluate(() => {
      const r = [...document.querySelectorAll(".map-pin, .map-bubble")].map((e) => e.getBoundingClientRect());
      let n = 0;
      for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) if (r[i].left < r[j].right && r[j].left < r[i].right && r[i].top < r[j].bottom && r[j].top < r[i].bottom) n++;
      return n;
    });
    expect(overlaps).toBe(0);

    // A bubble is a labelled button; Enter on it zooms in and splits it.
    const bubble = page.getByTestId("map-bubble").first();
    await expect(bubble).toHaveAttribute("aria-label", /\d+ places with dishes that fit\. Press to zoom in/);
    const scaleBefore = await page.locator(".maplibregl-ctrl-scale").textContent();
    await bubble.focus();
    await page.keyboard.press("Enter");
    await expect.poll(async () => page.locator(".maplibregl-ctrl-scale").textContent()).not.toBe(scaleBefore);
    await expect.poll(async () => (await drawn(page)).pins.length).toBeGreaterThan(far.pins.length);

    // "Show all places" brings every place back into view.
    await page.getByRole("button", { name: "Show all places in the results" }).click();
    await expect.poll(async () => (await drawn(page)).total).toBe(expected);
    await context.close();
  });

  test("places at the same spot are spread side by side once zoomed in", async ({ browser }) => {
    const context = await browser.newContext({ viewport: WIDE });
    const page = await context.newPage();
    await page.goto("/discover");
    await openMap(page);
    const zoomIn = page.getByRole("button", { name: "Zoom in" });
    for (let i = 0; i < 4; i++) await zoomIn.click();
    await page.waitForTimeout(400);
    const overlaps = await page.evaluate(() => {
      const r = [...document.querySelectorAll(".map-pin")].map((e) => e.getBoundingClientRect());
      let n = 0;
      for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) if (r[i].left < r[j].right - 2 && r[j].left < r[i].right - 2 && r[i].top < r[j].bottom - 2 && r[j].top < r[i].bottom - 2) n++;
      return n;
    });
    expect(overlaps).toBe(0);
    await context.close();
  });
});

test.describe("map and list move together (MAP-1.1)", () => {
  test("focusing a list row rings its pin; pointing at a pin marks its row; choosing a row inside a bubble brings its pin out", async ({ browser }) => {
    const context = await browser.newContext({ viewport: WIDE });
    const page = await context.newPage();
    await page.goto("/discover");
    await openMap(page);
    const row = page.locator(`.place-row[data-place-id="${VENUE.central}"]`);
    const pin = page.locator(`.map-pin[data-place-id="${VENUE.central}"]`);
    if (await pin.count()) {
      await row.focus();
      await expect(pin).toHaveClass(/\bhover\b/);
      await row.blur();
      await expect(pin).not.toHaveClass(/\bhover\b/);
      await pin.hover();
      await expect(row).toHaveClass(/\bhover\b/);
    }

    // Zoomed out, the place is inside a bubble: the bubble is ringed, and choosing the row brings the pin out, selected.
    await zoomOutFully(page);
    await expect(pin).toHaveCount(0);
    await row.focus();
    await expect(page.locator(".map-bubble.hover")).toHaveCount(1);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("place-panel").getByRole("heading", { level: 2 })).toBeFocused();
    await expect(pin).toHaveAttribute("aria-pressed", "true");
    await expect(pin).toHaveClass(/\bselected\b/);

    // Back returns to the row that opened the panel, still in view.
    await page.getByTestId("place-panel").getByRole("button", { name: "Back to all places" }).click();
    await expect(row).toBeFocused();
    await expect(row).toBeInViewport();
    await context.close();
  });

  test("Map and List keep the filters and show the same places when switching", async ({ browser }) => {
    const context = await browser.newContext({ viewport: WIDE });
    await setDiet(context, "vegan");
    const page = await context.newPage();
    await page.goto("/discover?view=needs_confirmation");
    await openMap(page);
    const onMap = (await drawn(page)).total;
    const res = await page.request.post("/api/v1/map/search", { data: { diet: "vegan", view: "needs_confirmation", area: { kind: "market" } } });
    expect(onMap).toBe(((await res.json()) as { data: { places: unknown[] } }).data.places.length);
    await expect(page.locator(".map-pin.fits, .map-bubble:not(.unsure)")).toHaveCount(0);
    await page.getByRole("group", { name: "Show results as" }).getByRole("button", { name: "List" }).click();
    await expect(page).toHaveURL(/view=needs_confirmation/);
    await page.getByRole("group", { name: "Show results as" }).getByRole("button", { name: "Map" }).click();
    await expect.poll(async () => (await drawn(page)).total).toBe(onMap);
    await context.close();
  });
});

test.describe("phone sheet, safe areas and controls (MAP-1.1)", () => {
  test("the sheet has collapsed, half and full positions, by buttons and by keyboard, and scrolls inside itself", async ({ browser }) => {
    const context = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    await page.goto("/discover");
    await openMap(page);
    const sheet = page.getByTestId("map-sheet");
    await expect(sheet).toHaveAttribute("data-sheet", "half");
    const height = async () => (await sheet.boundingBox())!.height;
    const half = await height();
    await sheet.getByRole("button", { name: "Show less", exact: true }).click();
    await expect(sheet).toHaveAttribute("data-sheet", "peek");
    await expect.poll(height).toBeLessThan(half);
    await expect(sheet.getByRole("button", { name: "Show less", exact: true })).toBeDisabled();
    await sheet.getByRole("button", { name: "Show more", exact: true }).click();
    await sheet.getByRole("button", { name: "Show more", exact: true }).click();
    await expect(sheet).toHaveAttribute("data-sheet", "full");
    await expect.poll(height).toBeGreaterThan(half);
    // The handle is a labelled button too.
    const handle = page.getByTestId("sheet-handle");
    await expect(handle).toHaveAccessibleName(/Full height panel/);
    await handle.focus();
    await page.keyboard.press("Enter");
    await expect(sheet).toHaveAttribute("data-sheet", "peek");
    // Its content scrolls inside it; the page behind does not scroll with it.
    const style = await sheet.evaluate((e) => ({ overflowY: getComputedStyle(e).overflowY, overscroll: getComputedStyle(e).overscrollBehaviorY }));
    expect(style).toEqual({ overflowY: "auto", overscroll: "contain" });
    // Choosing a pin raises a collapsed sheet to half so the details can be read.
    const target = page.locator(".map-pin").first();
    if ((await target.count()) === 0) await page.getByTestId("map-bubble").first().click();
    await page.locator(".map-pin").first().click();
    await expect(sheet).toHaveAttribute("data-sheet", "half");
    await expect(page.getByTestId("place-panel")).toBeVisible();
    // The map credit and the tab bar are never under the sheet.
    const layout = await page.evaluate(() => {
      const credit = document.querySelector(".maplibregl-ctrl-attrib")!.getBoundingClientRect();
      const sheetBox = document.querySelector("[data-testid=map-sheet]")!.getBoundingClientRect();
      return { creditAboveSheet: credit.bottom <= sheetBox.top + 1 };
    });
    expect(layout.creditAboveSheet).toBe(true);
    await expectNoSidewaysScroll(page);
    await context.close();
  });

  test("the page opts in to iPhone safe areas and every fixed bar keeps clear of the home bar", async ({ page }) => {
    await page.goto("/discover");
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /viewport-fit=cover/);
    const rules = await page.evaluate(() =>
      [...document.styleSheets]
        .flatMap((s) => {
          try {
            return [...s.cssRules].map((r) => r.cssText);
          } catch {
            return [];
          }
        })
        .filter((t) => /safe-area-inset/.test(t)),
    );
    for (const sel of [".tabbar", ".main-col", ".cook-nav", ".map-layout"]) {
      expect(rules.some((t) => t.startsWith(sel) && /safe-area-inset-bottom/.test(t)), sel).toBe(true);
    }
  });

  test("the search circle shows its distance and centre; the map moves and zooms by keyboard", async ({ browser }) => {
    const context = await browser.newContext({ viewport: WIDE });
    const page = await context.newPage();
    await page.goto("/discover");
    await openMap(page);
    await page.getByLabel("Neighbourhood, city or ZIP code").fill("Central Square");
    await page.getByRole("button", { name: "Go" }).click();
    await expect(page.getByTestId("radius-label")).toHaveText("1 mile");
    await expect(page.locator(".radius-centre")).toHaveCount(1);
    await page.getByLabel("Within").selectOption({ label: "0.5 mile" });
    await expect(page.getByTestId("radius-label")).toHaveText("0.5 mile");
    await expect(page.getByTestId("map-status")).toContainText(/within 0\.5 mile of Central Square/);

    // Keyboard: the map takes focus, + zooms in, arrows move it; nothing needs a pointer.
    const scale = page.locator(".maplibregl-ctrl-scale");
    const before = await scale.textContent();
    await page.locator(".maplibregl-canvas").focus();
    await page.keyboard.press("Equal");
    await expect.poll(async () => scale.textContent()).not.toBe(before);
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("button", { name: "Search this area" })).toBeVisible();
    // Every map control is a 44 px button with a name.
    for (const name of ["Zoom in", "Zoom out", "Show all places in the results"]) {
      const box = (await page.getByRole("button", { name }).boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await context.close();
  });

  for (const vp of [PHONE, WIDE]) {
    test(`Map view passes the automatic accessibility checks with the street map at ${vp.width} px`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: vp });
      const page = await context.newPage();
      await page.goto("/discover");
      await openMap(page);
      await page.locator(".map-pin, .map-bubble").first().click();
      await page.waitForTimeout(500);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
      await context.close();
    });
  }

  test("at 200% zoom the map, sheet and controls still work by keyboard without sideways scrolling", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 640, height: 450 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.goto("/discover");
    await page.evaluate(() => {
      document.documentElement.style.zoom = "2";
    });
    await page.getByRole("group", { name: "Show results as" }).getByRole("button", { name: "Map" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".map-pin, .map-bubble").first()).toBeVisible();
    await expectNoSidewaysScroll(page);
    await page.getByTestId("map-sheet").getByRole("button", { name: "Show more", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("map-sheet")).toHaveAttribute("data-sheet", "full");
    const row = page.getByTestId("map-sheet").locator("button.place-row").first();
    await row.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("place-panel").getByRole("heading", { level: 2 })).toBeFocused();
    await context.close();
  });
});
