import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { placeCoverage } from "@/contracts/menu-coverage";
import { previewMeals } from "@/contracts/menu-preview";
import { menuPlaceSchema } from "@/contracts/menu-review";
import { pool } from "../helpers/db";

/**
 * Boston eligibility report (owner direction 22 Nov 2026 06:25 UTC; docs/68). For every place in the founder's
 * private preview it sorts each drafted row (complete meals, group platters, sides/drinks/desserts, build-your-own
 * meals and their parts, unsorted) and each complete meal by diet (explicitly suitable, excluded, unknown) and
 * protein basis, using the app's own rules, so a raw menu row never counts as a suitable meal. Runs only when
 * REPORT_OUT names a file to write; reads only, as the founder, inside a transaction that is rolled back.
 */
const OUT = process.env.REPORT_OUT;

describe.skipIf(!OUT)("Boston eligibility report", () => {
  it("writes the counts", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      const founder = (await c.query("select user_id from public.role_assignments where role = 'publisher' order by user_id limit 1")).rows[0]?.user_id;
      expect(founder).toBeTruthy();
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify({ sub: founder, role: "authenticated" }), founder]);
      const index = (await c.query("select public.menu_preview_index() j")).rows[0].j as { placeId: string; name: string; slug: string }[];
      const rows: Record<string, string | number>[] = [];
      for (const e of index) {
        const place = menuPlaceSchema.parse((await c.query("select public.menu_review_place($1) j", [e.placeId])).rows[0].j);
        const cov = placeCoverage(place);
        const meals = previewMeals(place);
        const suitable = meals.filter((m) => !m.excluded && (m.diet === "vegan_stated" || m.diet === "vegetarian_stated"));
        const unknown = meals.filter((m) => !m.excluded && m.diet === "unknown");
        rows.push({
          name: e.name,
          area: place.area,
          rows: cov.rows,
          completeMeals: cov.completeMeals,
          groupPlatters: cov.groupPlatters,
          sidesDrinksDesserts: cov.sidesDrinksDesserts,
          buildYourOwn: cov.customizableMeals,
          buildYourOwnParts: cov.parts,
          unsorted: cov.unclassified,
          suitableStated: suitable.length,
          veganStated: suitable.filter((m) => m.diet === "vegan_stated").length,
          excluded: meals.filter((m) => m.excluded).length,
          unknownDiet: unknown.length,
          proteinPrinted: meals.filter((m) => ["published", "published_range", "restaurant_estimate"].includes(m.protein.basis)).length,
          proteinUsdaRange: meals.filter((m) => m.protein.basis === "usda_range").length,
          suitableWithPrintedProtein: suitable.filter((m) => ["published", "published_range", "restaurant_estimate"].includes(m.protein.basis)).length,
          suitableWithUsdaRange: suitable.filter((m) => m.protein.basis === "usda_range").length,
        });
      }
      await c.query("rollback");
      const sum = (k: string) => rows.reduce((a, r) => a + (r as unknown as Record<string, number>)[k], 0);
      const keys = Object.keys(rows[0] ?? {}).filter((k) => typeof (rows[0] as Record<string, unknown>)[k] === "number");
      const totals = Object.fromEntries(keys.map((k) => [k, sum(k)]));
      writeFileSync(OUT!, JSON.stringify({ at: new Date().toISOString(), places: rows.length, totals, rows }, null, 2));
      // Every complete meal sits in exactly one diet bucket.
      const n = (r: Record<string, string | number>, k: string) => Number(r[k]);
      for (const r of rows) expect(n(r, "suitableStated") + n(r, "excluded") + n(r, "unknownDiet")).toBeLessThanOrEqual(n(r, "completeMeals"));
    } finally {
      c.release();
    }
  });
});
