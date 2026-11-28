import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { deleteTestListings, pool } from "../helpers/db";
import { completeSignIn } from "./helpers";

/**
 * Phone layouts (owner 17 Nov 03:17 UTC): at 320, 375 and 390 px the bottom navigation must never
 * cover a map, content, a source record or a button, and no page may scroll sideways. Every visible
 * map, button, link, form field, list row and the last line of each page is scrolled to the lowest
 * place it can be fully seen, and must then end above the navigation.
 */
test.setTimeout(240_000);

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const SLUG = `mobile-e2e-${tag}`;
const SRC = JSON.stringify([{ key: "overture_places", title: "Test dataset", attribution: "Test attribution e2e", release: "r-e2e" }]);
let listing = "";

test.beforeAll(async () => {
  listing = (await pool.query(
    `insert into public.place_listings (candidate_id, slug, name, street, locality, postcode, area, lat, lon, category, identity_status, sources, built_from)
     values (gen_random_uuid(), $1, $2, '12 Sample Row', 'Boston', '02118', 'South End', 42.3412, -71.0731, 'Café', 'corroborated', $3, 'e2e') returning id`,
    [SLUG, `Mobile e2e Wren ${tag}`, SRC])).rows[0].id;
});
test.afterAll(async () => {
  await deleteTestListings("l.id = $1", [listing]);
});

const PAGES = [
  ["discover", "/discover"],
  ["places list", "/places"],
  ["places map", "/places?view=map"],
  ["place", `/places/${SLUG}`],
  ["review start", "/places/review"],
  ["batches", "/places/review/batches"],
  ["reports", "/places/review/reports"],
] as const;

async function problems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    if (document.documentElement.scrollWidth > window.innerWidth + 1) bad.push("page scrolls sideways");
    const navEl = document.querySelector(".tabbar");
    if (!navEl) return bad;
    const sel = "main .map-canvas, main [data-testid$=map], main a, main button, main input, main select, main textarea, main summary, main li, main [data-testid*=source], main [data-testid*=record]";
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      if (!el.offsetParent) continue;
      el.scrollIntoView({ block: "end" });
      const b = el.getBoundingClientRect();
      const navTop = navEl.getBoundingClientRect().top;
      if (b.height >= navTop) continue; // taller than the space above the nav: can never be seen whole
      const name = `${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ""} "${(el.textContent ?? "").trim().slice(0, 30)}"`;
      if (b.bottom > navTop + 0.5) bad.push(`${name} ends at ${Math.round(b.bottom)}, under the nav at ${Math.round(navTop)}`);
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
    const navTop = navEl.getBoundingClientRect().top;
    const main = document.querySelector("main");
    const last = Math.max(0, ...Array.from(main?.querySelectorAll<HTMLElement>("*") ?? []).filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect().bottom));
    if (last > navTop + 0.5) bad.push(`end of page ${Math.round(last)} is under the nav at ${Math.round(navTop)}`);
    const nb = navEl.getBoundingClientRect();
    if (!document.elementFromPoint(nb.left + nb.width / 2, nb.top + nb.height / 2)?.closest(".tabbar")) bad.push("something draws over the nav");
    return bad;
  });
}

for (const width of [320, 375, 390]) {
  test(`at ${width} px the bottom navigation covers nothing on the real-place pages`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height: width === 320 ? 568 : 812 }, hasTouch: true, isMobile: true, timezoneId: "America/New_York" });
    const page = await context.newPage();
    const email = `mobile-${width}-${randomUUID().slice(0, 8)}@example.test`;
    await page.goto("/login?next=%2F");
    await completeSignIn(page, email);
    const uid = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
    await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher') on conflict do nothing", [uid]);
    const found: string[] = [];
    for (const [label, url] of PAGES) {
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      // Open every closed section, one at a time: opening one changes which are still closed.
      for (let i = 0; i < 20; i++) {
        const closed = page.locator("main details:not([open]) > summary").filter({ visible: true }).first();
        if ((await closed.count()) === 0) break;
        await closed.click();
      }
      for (const p of await problems(page)) found.push(`${label}: ${p}`);
    }
    await context.close();
    expect(found).toEqual([]);
  });
}
