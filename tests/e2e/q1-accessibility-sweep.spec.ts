import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { M4 } from "../fixtures/ids";
import { pool } from "../helpers/db";
import { FOOD, VENUE, completeSignIn, expectNoSidewaysScroll } from "./helpers";

/**
 * Quality pass Q-1: every screen a visitor, a member or a staff member can reach, scanned for
 * WCAG 2.1 A/AA problems (axe) and checked for sideways scrolling, at the narrowest phone width
 * (320 px) and at desktop width. Pages that need an id use seeded demo records. This does not
 * replace the real iPhone or manual screen-reader checks, which are still not done.
 */
test.setTimeout(300_000);
test.use({ timezoneId: "America/New_York" });

const PUBLIC = ["/discover", "/discover?view=list", "/protein", "/diet", "/cook", `/cook/${M4.recipe(M4.dal)}`, "/login", `/venues/${VENUE.central}`, `/foods/${FOOD.bowl}`, `/foods/${FOOD.tempeh}`];
const MEMBER = [
  "/account", "/account/corrections", "/account/delete", "/saved",
  "/diary", "/diary/add", "/diary/custom", "/diary/goals", "/diary/week",
  "/cook/plan", "/friends", "/friends/people", "/friends/lists", "/friends/profile", "/friends/ranking", "/friends/reviews",
];
const STAFF = ["/editor", "/editor/items", "/editor/new", "/moderation", "/moderation/corrections", "/moderation/members"]; // /moderation/members sends a non-admin back to /moderation;
const WIDTHS = [320, 1280];

async function scan(page: Page, path: string) {
  const res = await page.goto(path);
  expect(res?.status(), path).toBeLessThan(400);
  await page.waitForLoadState("networkidle");
  await expectNoSidewaysScroll(page);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return r.violations.map((v) => `${path}: ${v.id} (${v.nodes.length}) ${v.nodes[0]?.target.join(" ")}`);
}

for (const width of WIDTHS) {
  test(`visitor screens at ${width} px have no WCAG A/AA failures and no sideways scroll`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const found: string[] = [];
    for (const p of PUBLIC) found.push(...(await scan(page, p)));
    expect(found).toEqual([]);
  });

  test(`member and staff screens at ${width} px have no WCAG A/AA failures and no sideways scroll`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const email = `q1-${width}-${randomUUID().slice(0, 8)}@example.test`;
    await page.goto("/login?next=%2Faccount");
    await completeSignIn(page, email);
    const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
    for (const role of ["curator", "publisher", "moderator"]) await pool.query("insert into public.role_assignments (user_id, role) values ($1, $2) on conflict do nothing", [id, role]);
    const found: string[] = [];
    for (const p of [...MEMBER, ...STAFF]) found.push(...(await scan(page, p)));
    expect(found).toEqual([]);
  });
}
