import { afterAll, describe, expect, it } from "vitest";
import { asMember, pool } from "../helpers/db";

// "Can be made vegan" (BACKLOG FUT-01, migration 20261118000900, docs/55). Demo recipes with approved swaps:
//   spinach and paneer curry: paneer -> extra-firm tofu, single cream -> coconut milk (vegetarian as written)
//   baked eggs: eggs -> canned white beans; yogurt bowl: Greek yogurt -> soy yogurt, honey -> maple syrup.

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const list = (p: J) =>
  asMember(null, async (c) => (await c.query("select public.recipe_list($1::jsonb) as r", [JSON.stringify({ includeDemo: true, ...p })])).rows[0].r as J);
const names = (xs: J[]) => xs.map((x) => x.name).sort();

afterAll(async () => {
  await pool.end();
});

describe("can be made to fit", () => {
  it("vegan: the paneer curry is listed as 'can be made', with its swaps named, and never as vegan", async () => {
    const r = await list({ diet: "vegan" });
    expect(names(r.canBeMade)).toEqual(["Demo baked eggs in pepper and tomato sauce", "Demo spinach and paneer curry", "Demo yogurt bowl with walnuts and berries"]);
    const curry = (r.canBeMade as J[]).find((x) => x.name === "Demo spinach and paneer curry")!;
    expect(curry.swapNames).toEqual([
      { group: "protein", from: "Demo paneer", to: "Demo extra-firm tofu" },
      { group: "cream", from: "Demo single cream", to: "Demo coconut milk" },
    ]);
    expect(Object.keys(curry.swaps).sort()).toEqual(["cream", "protein"]);
    // Never among, or counted with, the recipes that already fit.
    expect((r.items as J[]).map((x) => x.name)).not.toContain("Demo spinach and paneer curry");
    expect(r.counts.matches).toBe((r.items as J[]).length);
    expect(r.counts.canBeMade).toBe(3);
    // As written they still contain something left out, so they are still counted as hidden.
    expect(r.counts.hidden).toBe(3);
  });

  it("the swaps offered really make it fit: the variant rule says eligible for each one", async () => {
    const r = await list({ diet: "vegan" });
    for (const x of r.canBeMade as J[]) {
      const v = await pool.query("select app.variant_eligibility($1, $2::jsonb, 'vegan', '{}', false) ->> 'status' as s", [x.revisionId, JSON.stringify(x.swaps)]);
      expect(v.rows[0].s).toBe("eligible");
    }
    // As written, each one does not fit.
    const asWritten = await pool.query(
      `select r.name, app.eligibility(r.id, 'vegan', '{}', false) ->> 'status' as s
         from public.food_items fi join public.food_revisions r on r.id = fi.current_revision_id
        where r.name = any($1)`,
      [names(r.canBeMade)],
    );
    expect(asWritten.rows.every((row) => row.s !== "eligible" && row.s !== "conditional")).toBe(true);
  });

  it("the fewest swaps are offered: egg-free vegetarian only swaps the eggs", async () => {
    const r = await list({ diet: "vegetarian", exclusions: ["egg"] });
    expect(names(r.canBeMade)).toEqual(["Demo baked eggs in pepper and tomato sauce"]);
    expect(r.canBeMade[0].swapNames).toEqual([{ group: "protein", from: "Demo eggs", to: "Demo canned white beans" }]);
  });

  it("nothing is offered without a filter, for a recipe that already fits, or in the needs-confirmation view", async () => {
    const none = await list({});
    expect(none.canBeMade).toEqual([]);
    expect(none.counts.canBeMade).toBe(0);
    const veg = await list({ diet: "vegetarian" });
    expect(veg.canBeMade).toEqual([]);
    expect((veg.items as J[]).map((x) => x.name)).toContain("Demo spinach and paneer curry");
    const needs = await list({ diet: "vegan", view: "needs_confirmation" });
    expect(needs.canBeMade).toEqual([]);
  });
});
