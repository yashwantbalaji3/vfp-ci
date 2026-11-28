import { expect, test } from "@playwright/test";
import { VENUE } from "./helpers";

/**
 * The phone tab bar never covers what a person is reading or using (owner request 15 Nov 2026).
 * At three phone widths, on the busiest pages:
 *   1. the end of each page can be scrolled clear of the bar;
 *   2. every link, button and field reached with the keyboard is not hidden behind the bar;
 *   3. opening hours, dish cards and buttons brought into view by the browser stay above the bar.
 */
const PAGES = [`/venues/${VENUE.central}`, "/venues/00000000-0000-4000-8000-00000000c003", "/discover", "/discover?open=1", "/protein", "/cook", "/friends"];

for (const width of [320, 360, 390]) {
  test(`at ${width} px the bottom bar covers no content, focus or hours`, async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({ viewport: { width, height: 700 }, timezoneId: "America/New_York" });
    const page = await context.newPage();
    const problems: string[] = [];
    for (const path of PAGES) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const found = await page.evaluate(async () => {
        const bar = document.querySelector(".tabbar");
        if (!bar || getComputedStyle(bar).display === "none") return ["no bottom bar at phone width"];
        const out: string[] = [];
        const under = (el: Element) => {
          const r = el.getBoundingClientRect();
          return r.height > 0 && r.bottom > bar.getBoundingClientRect().top + 0.5 && r.top < window.innerHeight;
        };
        const name = (el: Element) => (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().replace(/\s+/g, " ").slice(0, 40);
        const main = document.querySelector("main")!;
        window.scrollTo(0, document.documentElement.scrollHeight);
        const leaves = [...main.querySelectorAll("*")].filter((e) => e.children.length === 0 && e.getBoundingClientRect().height > 0);
        const last = leaves.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
        if (last && under(last)) out.push(`end of page "${name(last)}"`);
        for (const el of main.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, summary")) {
          if (el.getBoundingClientRect().height === 0) continue;
          window.scrollTo(0, 0);
          el.focus();
          if (document.activeElement === el && under(el)) out.push(`focused "${name(el)}"`);
        }
        for (const el of main.querySelectorAll("[data-testid='hours-status'], [data-testid='opening-hours'] tr, [data-testid='dish-card'], button")) {
          el.scrollIntoView({ block: "end" });
          if (under(el)) out.push(`scrolled to "${name(el)}"`);
        }
        return out;
      });
      problems.push(...found.map((p) => `${path}: ${p}`));
    }
    await context.close();
    expect(problems).toEqual([]);
  });
}
