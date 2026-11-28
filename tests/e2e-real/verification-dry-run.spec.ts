import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";
import { completeSignIn } from "../e2e/helpers";

// Verification dry run (owner directive 28 Nov 2026 04:59 UTC): the founder page sorts every source-backed meal into the
// five separate results, changes nothing, and agrees with the review queue about which meals are proposed. Founder view
// through a disposable publisher account in the cloud copy (never on the Mac). With VERIFY_REPORT set, the counts for
// both views are written there for the checkpoint report.

type Counts = {
  view: string; meals: number; proposed: number; published: number;
  source: Record<"A" | "B" | "E", number>;
  diet: Record<"vegetarian" | "vegan" | "egg_free", Record<"candidate" | "B" | "C" | "D", number>>;
  eligible: Record<string, number>; nutrition: Record<string, number>;
  workload: { meals: number; transcriptionChecksReplaceable: number; stillNeedSourceException: number; dietExceptions: number };
};
const snapshot = async () =>
  (await pool.query(`select (select count(*) from staging.facts) facts, (select count(*) from staging.fact_confirmations) confirmations,
     (select count(*) from staging.diet_confirmations) diet, (select count(*) from staging.publications) pubs,
     (select count(*) from staging.member_beta_places) beta, (select count(*) from staging.fact_machine_checks) checks`)).rows[0];

test("the verification dry run sorts every meal, agrees with the queue, and changes nothing", async ({ browser }) => {
  test.setTimeout(180_000);
  const before = await snapshot();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "America/New_York" });
  const page = await context.newPage();
  const email = `verify-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2F");
  await completeSignIn(page, email);
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
  await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher') on conflict do nothing", [id]);
  const report: Record<string, Counts> = {};
  try {
    for (const view of ["all", "proposed"] as const) {
      await page.goto(`/places/review/verification?view=${view}`);
      await expect(page.getByTestId("vr-dry-run")).toBeVisible({ timeout: 60_000 });
      const c = JSON.parse((await page.getByTestId("vr-counts").textContent()) ?? "{}") as Counts;
      report[view] = c;
      expect(c.meals).toBeGreaterThan(0);
      expect(c.source.A + c.source.B + c.source.E).toBe(c.meals);
      for (const f of ["vegetarian", "vegan", "egg_free"] as const) {
        const d = c.diet[f];
        expect(d.candidate + d.B + d.C + d.D).toBe(c.meals);
        expect(c.eligible[f]).toBeLessThanOrEqual(d.candidate);
      }
      expect(c.published).toBe(0);
      // Nothing on the page can change a record.
      await expect(page.locator("main form")).toHaveCount(0);
      // Phone width: no sideways page scroll.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    }
    expect(report.proposed.meals).toBe(report.all.proposed);
    // The queue's proposed selection is the same set.
    await page.goto("/places/review/queue?view=proposed");
    await expect(page.getByTestId("rq-proposal")).toContainText(`Proposed first beta selection: ${report.all.proposed} meals`, { timeout: 60_000 });
    await expect(page.getByTestId("rq-verification-link")).toBeVisible();
  } finally {
    await context.close();
    await pool.query("delete from public.role_assignments where user_id = $1", [id]);
  }
  expect(await snapshot()).toEqual(before);
  if (process.env.VERIFY_REPORT) writeFileSync(process.env.VERIFY_REPORT, JSON.stringify(report, null, 2));
});
