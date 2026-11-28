import { expect, test, type APIRequestContext, type Response } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";

/**
 * Localhost stabilization (owner directive, 15 Nov 2026). Ordinary use must never be refused,
 * real overuse must still be refused, and a request counter that cannot be checked must be
 * reported as "temporarily unavailable", not as "too many requests". Each test uses its own
 * visitor address so the counts are its own.
 */
const address = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}-${randomUUID().slice(0, 8)}`;
async function startOfQuietMinute(need: number) {
  const left = 60 - (Math.floor(Date.now() / 1000) % 60);
  if (left < need) await new Promise((r) => setTimeout(r, (left + 1) * 1000));
}
const mapSearch = (request: APIRequestContext, headers: Record<string, string>, extra: Record<string, unknown> = {}) =>
  request.post("/api/v1/map/search", { headers, data: { area: { kind: "market" }, ...extra } });

test.describe("ordinary use is never refused", () => {
  test("browsing every tab three times, with Map and List switching, shows no refusal", async ({ browser }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": address() } });
    const page = await context.newPage();
    const refusals: string[] = [];
    page.on("response", (r: Response) => [429, 503].includes(r.status()) && refusals.push(`${r.status()} ${new URL(r.url()).pathname}`));
    for (let round = 0; round < 3; round++) {
      for (const path of ["/discover", "/protein", "/diary", "/cook", "/friends"]) {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        await expect(page.getByTestId("too-many-requests"), path).toHaveCount(0);
        await expect(page.getByTestId("limit-unavailable"), path).toHaveCount(0);
      }
      await page.goto("/discover");
      const views = page.getByRole("group", { name: "Show results as" });
      await views.getByRole("button", { name: "Map" }).click();
      await expect(page.getByTestId("map-view")).toBeVisible();
      await views.getByRole("button", { name: "List" }).click();
    }
    expect(refusals).toEqual([]);
    await context.close();
  });

  test("repeated searches and filter changes in the browser show no refusal", async ({ browser }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": address() } });
    const page = await context.newPage();
    const refusals: string[] = [];
    page.on("response", (r: Response) => [429, 503].includes(r.status()) && refusals.push(`${r.status()} ${new URL(r.url()).pathname}`));
    const searches = ["tofu", "bowl", "lentil", "paneer", "tempeh", "curry", "salad", "burger"];
    for (const [i, q] of [...searches, ...searches, ...searches].entries()) {
      const view = i % 3 === 0 ? "&view=needs_confirmation" : "";
      await page.goto(`/discover?q=${q}${view}${i % 2 ? "&protein=15" : ""}${i % 4 === 1 ? "&price=2" : ""}`);
      await expect(page.getByTestId("too-many-requests")).toHaveCount(0);
      await expect(page.getByTestId("limit-unavailable")).toHaveCount(0);
    }
    // Map view: changing the distance repeatedly runs one map search each time.
    await page.goto("/discover");
    await page.getByRole("group", { name: "Show results as" }).getByRole("button", { name: "Map" }).click();
    await expect(page.locator(".map-pin, .map-bubble").first()).toBeVisible();
    const within = page.getByLabel("Within");
    const values = await within.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    expect(values.length).toBeGreaterThan(2);
    for (const value of [...values, ...values].reverse()) await within.selectOption(value);
    await page.waitForLoadState("networkidle");
    expect(refusals).toEqual([]);
    await context.close();
  });

  test("25 map searches at the same moment are all answered", async ({ request }) => {
    await startOfQuietMinute(15);
    const headers = { "x-forwarded-for": address() };
    const statuses = await Promise.all(Array.from({ length: 25 }, (_, i) => mapSearch(request, headers, i % 2 ? { diet: "vegan" } : {}).then((r) => r.status())));
    expect(statuses).toEqual(Array(25).fill(200));
  });
});

test.describe("real overuse is still refused", () => {
  test("the 61st catalog request in a minute gets 429 with Retry-After; another visitor is unaffected", async ({ request }) => {
    test.setTimeout(120_000);
    await startOfQuietMinute(30);
    const headers = { "x-forwarded-for": address() };
    const statuses: number[] = [];
    let retryAfter: string | undefined;
    for (let done = 0; done < 70; done += 10) {
      const batch = await Promise.all(Array.from({ length: 10 }, () => mapSearch(request, headers)));
      for (const r of batch) {
        statuses.push(r.status());
        if (r.status() === 429) retryAfter = r.headers()["retry-after"];
      }
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(60);
    expect(statuses.filter((s) => s === 429)).toHaveLength(10);
    expect(retryAfter).toBe("60");
    expect((await mapSearch(request, { "x-forwarded-for": address() })).status()).toBe(200);
  });
});

test.describe("a request counter that cannot be checked", () => {
  test("refuses to search but says 'temporarily unavailable', not 'too many requests'; recovers when fixed", async ({ page, request }) => {
    const headers = { "x-forwarded-for": address() };
    const saved = (await pool.query("select purpose, digest, added_at from app.server_keys where purpose = 'rate_limit'")).rows;
    expect(saved.length).toBeGreaterThan(0);
    try {
      // The same fault as a database that never registered this server's key (seen on a local setup).
      await pool.query("delete from app.server_keys where purpose = 'rate_limit'");
      await page.setExtraHTTPHeaders(headers);
      await page.goto("/discover?q=tofu");
      await expect(page.getByTestId("limit-unavailable")).toContainText("temporarily unavailable");
      await expect(page.getByTestId("too-many-requests")).toHaveCount(0);
      await expect(page.getByTestId("dish-card")).toHaveCount(0);
      const api = await mapSearch(request, headers);
      expect(api.status()).toBe(503);
      expect(((await api.json()) as { error: { code: string } }).error.code).toBe("LIMITER_UNAVAILABLE");
    } finally {
      for (const k of saved) await pool.query("insert into app.server_keys (purpose, digest, added_at) values ($1, $2, $3) on conflict do nothing", [k.purpose, k.digest, k.added_at]);
    }
    await page.goto("/discover?q=tofu");
    await expect(page.getByTestId("limit-unavailable")).toHaveCount(0);
    await expect(page.getByTestId("dish-card").first()).toBeVisible();
    expect((await mapSearch(request, headers)).status()).toBe(200);
  });
});
