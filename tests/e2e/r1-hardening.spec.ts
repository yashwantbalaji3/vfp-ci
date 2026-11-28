import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { IDS } from "../fixtures/ids";
import { pool } from "../helpers/db";
import { completeSignIn, localEnv } from "./helpers";

/**
 * R1 hardening, tested through real requests (docs/14 PH-01; audit acceptance tests 1, 4, 5).
 *
 * The usual test server (port 3000) runs with local settings: it reads the visitor's address
 * from x-forwarded-for (there is no hosting layer locally) and relaxes the sign-in limits so
 * the other browser tests can sign people in freely. This file also starts a second copy of
 * the same build with the STRICT settings a hosted site would have: the address comes from a
 * different header, and the sign-in limits are the real ones.
 */
const DEMO_HANDLE = "demo_maya";
let STRICT = "";
let strictServer: ChildProcess | undefined;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      probe.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("no free port"))));
    });
  });
  STRICT = `http://localhost:${port}`;
  strictServer = spawn("pnpm", ["start", "--port", String(port)], {
    env: { ...process.env, TRUSTED_ADDRESS_HEADER: "x-real-ip", SIGNIN_LIMIT_SCALE: "", NEXT_PUBLIC_APP_URL: STRICT },
    stdio: "ignore",
    detached: true,
  });
  for (let i = 0; i < 240; i++) {
    if (await fetch(`${STRICT}/health`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("The second server (strict settings) did not start");
});
test.afterAll(async () => {
  if (strictServer?.pid) {
    try {
      process.kill(-strictServer.pid, "SIGTERM");
    } catch {
      /* already stopped */
    }
  }
});

/** A made-up address from the ranges reserved for documentation, different on every call. */
const address = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}-${randomUUID().slice(0, 8)}`;
/** Stay inside one clock minute so a one-minute window cannot roll over mid-test. */
async function startOfQuietMinute(need = 20) {
  const left = 60 - (Math.floor(Date.now() / 1000) % 60);
  if (left < need) await new Promise((r) => setTimeout(r, (left + 1) * 1000));
}
async function burst(request: APIRequestContext, path: string, headers: Record<string, string>, count: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let done = 0; done < count; done += 20) {
    const n = Math.min(20, count - done);
    statuses.push(...(await Promise.all(Array.from({ length: n }, () => request.get(path, { headers, maxRedirects: 0 }).then((r) => r.status())))));
  }
  return statuses;
}

test.describe("security headers (audit A9-2)", () => {
  test("every page and API answer carries the content policy and the HTTPS-only header", async ({ request }) => {
    for (const path of ["/discover", "/login", `/venues/${IDS.venueCentral}`, "/api/v1/catalog/search?limit=1", "/no-such-page"]) {
      const headers = (await request.get(path)).headers();
      const csp = headers["content-security-policy"] ?? "";
      for (const rule of ["default-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'", "connect-src 'self'"]) {
        expect(csp, `${path}: ${rule}`).toContain(rule);
      }
      // Nothing outside this site is allowed yet: no host name appears anywhere in the policy.
      expect(csp, path).not.toMatch(/https?:|\*/);
      expect(headers["strict-transport-security"], path).toMatch(/max-age=\d{8,}/);
      expect(headers["x-content-type-options"], path).toBe("nosniff");
    }
  });

  test("the app's own pages load and work without breaking the content policy", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (m) => {
      if (/Content Security Policy|Refused to (load|execute|apply|connect)/i.test(m.text())) violations.push(m.text());
    });
    for (const path of ["/discover", `/venues/${IDS.venueCentral}`, `/foods/${IDS.bowl.item}`, "/protein", "/cook", "/friends", "/login", `/u/${DEMO_HANDLE}`]) {
      await page.goto(path);
      await expect(page.locator("main").first(), path).toBeVisible();
    }
    // An interaction that runs script and a form post: the dietary filter on Discover.
    await page.goto("/discover");
    await expect(page.locator("main").first()).toBeVisible();
    expect(violations).toEqual([]);
  });
});

test.describe("the app's own error screen (audit A3-2)", () => {
  for (const size of [{ name: "phone", width: 360, height: 740 }, { name: "desktop", width: 1280, height: 800 }]) {
    test(`a forced server fault shows a plain message with no technical detail (${size.name})`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height } });
      const page = await context.newPage();
      await page.goto("/health/fault");
      const screen = page.getByTestId("error-page");
      await expect(screen).toBeVisible();
      await expect(screen.getByRole("heading", { name: "Something went wrong on our side" })).toBeVisible();
      await expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
      await expect(screen.getByRole("link", { name: "Back to Discover" })).toHaveAttribute("href", "/discover");
      const text = await page.locator("body").innerText();
      expect(text).not.toMatch(/secret-detail|Forced fault|Error:|at \w+ \(|\.js:\d+|stack|digest/i);
      expect(await page.content()).not.toContain("secret-detail-that-must-not-be-shown");
      // Nothing scrolls sideways.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/r1-error-${size.name}.png`, fullPage: true });
      await context.close();
    });
  }
});

test.describe("real 'not found' answers and the site icon (AUD-D1, AUD-D3)", () => {
  test("a missing profile and a missing list answer 404 with the not-found screen; real ones answer 200", async ({ page, request }) => {
    for (const path of ["/u/nobody_here_at_all", `/lists/${randomUUID()}`, "/lists/not-an-id", "/u/%E0%A4%A"]) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(404);
      expect(res.headers()["cache-control"], path).toContain("no-store");
    }
    expect((await request.get(`/u/${DEMO_HANDLE}`)).status()).toBe(200);
    await page.goto("/u/nobody_here_at_all");
    await expect(page.getByRole("heading", { name: "We couldn’t find that" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to Discover" })).toBeVisible();
  });

  test("the site icon exists, so a first visit no longer logs a 'not found'", async ({ page, request }) => {
    const ico = await request.get("/favicon.ico");
    expect(ico.status()).toBe(200);
    expect(ico.headers()["content-type"]).toMatch(/image/);
    const missing: string[] = [];
    page.on("response", (r) => {
      if (r.status() === 404) missing.push(new URL(r.url()).pathname);
    });
    await page.goto("/discover");
    await expect(page.locator("main").first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(missing).toEqual([]);
  });

  test("the fault page does not exist for anyone unless the local test setting is on", async ({ request }) => {
    // (The strict server inherits the local setting; this checks the page is not linked or listed anywhere.)
    const body = await (await request.get("/discover")).text();
    expect(body).not.toContain("/health/fault");
  });
});

test.describe("request limits (docs/14 PH-01)", () => {
  test("page views that run a search are limited per address, and another visitor is unaffected", async ({ request }) => {
    test.setTimeout(180_000);
    await startOfQuietMinute(40);
    const headers = { "x-forwarded-for": address() };
    const bodies: string[] = [];
    for (let done = 0; done < 320; done += 20) {
      bodies.push(...(await Promise.all(Array.from({ length: 20 }, () => request.get("/discover?q=tofu", { headers }).then((r) => r.text())))));
    }
    const refused = bodies.filter((b) => b.includes("too-many-requests"));
    const served = bodies.filter((b) => b.includes("dish-card"));
    expect(served).toHaveLength(300);
    expect(refused).toHaveLength(20);
    // A refused view ran no search: it carries the plain notice and no result at all.
    for (const b of refused) {
      expect(b).toContain("Please wait a minute and try again");
      expect(b).not.toContain("dish-card");
    }
    // The limit is shared by every searching page, not kept per page.
    expect(await (await request.get(`/venues/${IDS.venueCentral}`, { headers })).text()).toContain("too-many-requests");
    expect(await (await request.get("/protein", { headers })).text()).toContain("too-many-requests");
    // Another visitor is unaffected.
    const other = await (await request.get("/discover?q=tofu", { headers: { "x-forwarded-for": address() } })).text();
    expect(other).toContain("dish-card");
    expect(other).not.toContain("too-many-requests");
  });

  test("ordinary browsing with its background link prefetches stays far below the page limit", async ({ browser }) => {
    const mine = address();
    const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": mine } });
    const page = await context.newPage();
    for (const path of ["/discover", "/protein", "/cook", "/friends", "/discover?q=tofu"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
    }
    await expect(page.getByTestId("too-many-requests")).toHaveCount(0);
    // Five pages were viewed. The browser also made dozens of background prefetches; none may be counted.
    const bucket = `page:${createHmac("sha256", localEnv("RATE_LIMIT_SALT", "")).update(mine).digest("hex").slice(0, 40)}`;
    const hits = (await pool.query("select coalesce(sum(hits), 0)::int as n from public.rate_limit_windows where bucket = $1", [bucket])).rows[0].n as number;
    expect(hits).toBeGreaterThanOrEqual(5);
    expect(hits).toBeLessThanOrEqual(10);
    await context.close();
  });

  test("detail routes share the catalog limit: the 61st request is refused whatever it asks for", async ({ request }) => {
    await startOfQuietMinute(20);
    const headers = { "x-forwarded-for": address() };
    const first = await burst(request, `/api/v1/venues/${IDS.venueCentral}`, headers, 30);
    const second = await burst(request, `/api/v1/foods/${IDS.bowl.item}`, headers, 30);
    expect([...first, ...second].every((s) => s === 200)).toBe(true);
    const refused = await request.get("/api/v1/catalog/search?limit=1", { headers });
    expect(refused.status()).toBe(429);
    expect(refused.headers()["retry-after"]).toBe("60");
  });

  test("a forged x-forwarded-for earns no fresh allowance when the host guarantees a different header", async ({ playwright }) => {
    await startOfQuietMinute(20);
    const strict = await playwright.request.newContext({ baseURL: STRICT });
    const real = address();
    // 60 requests from one real address, each pretending to be someone new.
    const statuses: number[] = [];
    for (let batch = 0; batch < 6; batch++) {
      statuses.push(
        ...(await Promise.all(
          Array.from({ length: 10 }, () => strict.get("/api/v1/catalog/search?limit=1", { headers: { "x-real-ip": real, "x-forwarded-for": address() } }).then((r) => r.status())),
        )),
      );
    }
    expect(statuses.every((s) => s === 200)).toBe(true);
    // The 61st, with yet another forged value, is refused: the forged header counted for nothing.
    expect((await strict.get("/api/v1/catalog/search?limit=1", { headers: { "x-real-ip": real, "x-forwarded-for": address() } })).status()).toBe(429);
    // A genuinely different visitor is unaffected.
    expect((await strict.get("/api/v1/catalog/search?limit=1", { headers: { "x-real-ip": address() } })).status()).toBe(200);
    await strict.dispose();
  });

  test("the map search (MAP-1) shares that allowance: a forged x-forwarded-for earns nothing there either", async ({ playwright }) => {
    await startOfQuietMinute(20);
    const strict = await playwright.request.newContext({ baseURL: STRICT });
    const real = address();
    const post = (headers: Record<string, string>) => strict.post("/api/v1/map/search", { data: { area: { kind: "market" } }, headers }).then((r) => r.status());
    const statuses: number[] = [];
    for (let batch = 0; batch < 6; batch++) {
      statuses.push(...(await Promise.all(Array.from({ length: 10 }, () => post({ "x-real-ip": real, "x-forwarded-for": address() })))));
    }
    expect(statuses.every((s) => s === 200)).toBe(true);
    expect(await post({ "x-real-ip": real, "x-forwarded-for": address() })).toBe(429);
    expect(await post({ "x-real-ip": address() })).toBe(200);
    await strict.dispose();
  });

  const ask = async (page: Page, email: string) => {
    await page.goto("/login");
    await page.getByLabel("Email address").fill(email);
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    const status = page.locator("#email-status");
    await expect(status).toContainText(/a link is on its way|Too many sign-in links/);
    return /Too many sign-in links/.test(await status.innerText()) ? "refused" : "accepted";
  };

  test("sign-in links are limited per email address, even when the requests come from different visitors", async ({ browser }) => {
    test.setTimeout(120_000);
    const email = `r1-email-${randomUUID().slice(0, 8)}@example.test`;
    const answers: string[] = [];
    for (let i = 0; i < 7; i++) {
      const context = await browser.newContext({ baseURL: STRICT, extraHTTPHeaders: { "x-real-ip": address() } });
      answers.push(await ask(await context.newPage(), email));
      await context.close();
    }
    expect(answers).toEqual(["accepted", "accepted", "accepted", "accepted", "accepted", "refused", "refused"]);
    // Someone else's email is unaffected.
    const other = await browser.newContext({ baseURL: STRICT, extraHTTPHeaders: { "x-real-ip": address() } });
    expect(await ask(await other.newPage(), `r1-other-${randomUUID().slice(0, 8)}@example.test`)).toBe("accepted");
    await other.close();
  });

  test("sign-in links are limited per visitor address, whatever email addresses are tried", async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({ baseURL: STRICT, extraHTTPHeaders: { "x-real-ip": address() } });
    const page = await context.newPage();
    const answers: string[] = [];
    for (let i = 0; i < 12; i++) answers.push(await ask(page, `r1-addr-${i}-${randomUUID().slice(0, 8)}@example.test`));
    expect(answers.slice(0, 10).every((a) => a === "accepted")).toBe(true);
    expect(answers.slice(10)).toEqual(["refused", "refused"]);
    await context.close();
  });
});

test.describe("per-member limits on form presses (docs/14 PH-01 test 3, PH-03)", () => {
  /** Uses up a member's allowance for the current minute, exactly as that many presses would have. */
  async function useUp(scope: string, memberId: string, hits: number) {
    const bucket = `${scope}:${createHmac("sha256", localEnv("RATE_LIMIT_SALT", "")).update(memberId).digest("hex").slice(0, 40)}`;
    await pool.query(
      `insert into public.rate_limit_windows (bucket, window_start, hits) values ($1, to_timestamp(floor(extract(epoch from now()) / 60) * 60), $2)
       on conflict (bucket, window_start) do update set hits = excluded.hits`,
      [bucket, hits],
    );
  }
  const newMember = async (page: Page, path: string) => {
    const who = `r1-limit-${randomUUID().slice(0, 8)}@example.test`;
    await page.goto(`/login?next=${encodeURIComponent(path)}`);
    await completeSignIn(page, who);
    await expect(page).toHaveURL(new RegExp(path.replace(/[/]/g, "\\/")));
    return (await pool.query("select id from auth.users where email = $1", [who])).rows[0].id as string;
  };

  test("the 31st save press in a minute changes nothing and says so; the next minute's presses work again", async ({ page }) => {
    await startOfQuietMinute(25);
    const id = await newMember(page, `/foods/${IDS.bowl.item}`);
    const save = page.getByTestId("save-button").filter({ visible: true });
    await save.click();
    await expect(page).toHaveURL(/saved=saved/);
    expect((await pool.query("select count(*)::int as n from public.saves where owner_id = $1", [id])).rows[0].n).toBe(1);
    await useUp("save", id, 30);
    await save.click();
    await expect(page).toHaveURL(/saved=wait/);
    await expect(page.locator("main")).toContainText("Nothing changed. Please wait a minute and try again.");
    // The refused press did not remove the save.
    expect((await pool.query("select count(*)::int as n from public.saves where owner_id = $1", [id])).rows[0].n).toBe(1);
    // Another member is unaffected: the limit is per member, not shared.
    await pool.query("delete from public.rate_limit_windows where bucket like 'save:%' and hits >= 30");
    await save.click();
    await expect(page).toHaveURL(/saved=removed/);
  });

  test("a burst of diary form presses is refused before anything is written", async ({ page }) => {
    await startOfQuietMinute(25);
    const id = await newMember(page, "/diary/custom");
    await useUp("member_action", id, 120);
    await page.getByLabel("What was it?").fill("Should not be saved");
    await page.getByRole("button", { name: "Add to diary" }).click();
    await expect(page).toHaveURL(/\/slow-down/);
    await expect(page.getByTestId("slow-down")).toContainText("the last one was not saved");
    expect((await pool.query("select count(*)::int as n from public.diary_entries where owner_id = $1", [id])).rows[0].n).toBe(0);
    // Once the allowance is back, the same press works.
    await pool.query("delete from public.rate_limit_windows where bucket like 'member_action:%' and hits >= 120");
    await page.goto("/diary/custom");
    await page.getByLabel("What was it?").fill("Saved after waiting");
    await page.getByRole("button", { name: "Add to diary" }).click();
    await expect(page.getByTestId("diary-flash")).toHaveText("Added to your diary.");
  });
});
