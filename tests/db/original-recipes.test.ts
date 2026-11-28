import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../helpers/db";
import data from "../../data/recipes/original-v2.json";
import { PREFIX, fixedId, load, status } from "../../scripts/lib/original-recipes.mjs";

// Recipe library v2 (scripts/original-recipes.mjs). Everything runs in ONE transaction that is rolled back,
// so nothing stays behind. It needs the full USDA SR Legacy 2018-04 release and the real ingredients from
// scripts/real-recipes.mjs; a database without them (a fresh CI database) skips these checks and says so.

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ings = data.ingredients as unknown as Record<string, J>;
const recipes = data.recipes as unknown as J[];

const ready = await (async () => {
  const sr = await pool.query("select count(*)::int n from app.usda_foods uf join app.usda_releases ur on ur.id = uf.release_id where ur.release_label = '2018-04' and ur.dataset = 'sr_legacy'");
  const reuse = Object.values(ings).filter((i) => i.reuse).map((i) => i.reuse);
  const real = await pool.query("select count(*)::int n from public.food_revisions where id = any($1::uuid[])", [reuse]);
  return sr.rows[0].n > 7000 && real.rows[0].n === reuse.length;
})();
if (!ready) console.warn("original-recipes: skipped (needs the full USDA SR Legacy 2018-04 release and scripts/real-recipes.mjs load).");

async function tx(fn: (c: PoolClient) => Promise<void>) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await fn(c);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
  }
}
const query = (c: PoolClient) => (sql: string, args: unknown[] = []) => c.query(sql, args).then((r) => r.rows);
const counts = async (c: PoolClient) =>
  (await c.query(`select (select count(*) from public.food_items)::int items, (select count(*) from public.food_revisions)::int revs,
                         (select count(*) from public.nutrient_values)::int nutrients, (select count(*) from public.recipe_ingredients)::int lines,
                         (select count(*) from public.dietary_claims)::int claims, (select count(*) from public.source_records)::int records`)).rows[0];

afterAll(async () => {
  await pool.end();
});

describe.skipIf(!ready)("original recipes v2 on the database", () => {
  it("every new ingredient names a USDA food that exists in the local SR Legacy 2018-04 release", async () => {
    const fdc = Object.values(ings).filter((i) => !i.reuse).map((i) => i.fdcId);
    const r = await pool.query(
      `select array_agg(distinct uf.fdc_id) ids from app.usda_foods uf join app.usda_releases ur on ur.id = uf.release_id
        where ur.release_label = '2018-04' and ur.dataset = 'sr_legacy' and uf.fdc_id = any($1::int[])`, [fdc]);
    expect([...r.rows[0].ids].sort()).toEqual([...new Set(fdc)].sort());
  });

  it("loads additively, then a second run changes nothing", async () => {
    await tx(async (c) => {
      const q = query(c);
      const before = await counts(c);
      const already = Number((await q("select count(*)::int n from public.food_items where id::text like $1 and kind = 'recipe'", [`${PREFIX}%`]))[0].n);
      const first = await load(q, data);
      expect(first.newRecipes).toBe(38 - already);
      const after = await counts(c);
      // Nothing that was there is gone.
      for (const k of Object.keys(before)) expect(after[k]).toBeGreaterThanOrEqual(before[k]);
      const again = await load(q, data);
      expect(again).toEqual({ newRecipes: 0, newIngredients: 0, mapped: 0 });
      expect(await counts(c)).toEqual(after);
    });
  });

  it("adds 38 published, non-demo recipes whose per-serving numbers are the database's own calculation", async () => {
    await tx(async (c) => {
      const q = query(c);
      await load(q, data);
      const s = await status(q);
      expect(s.recipes).toBe(38);
      expect(s.published).toBe(38);
      expect(s.vegan).toBeGreaterThanOrEqual(19);
      expect(s.highProtein).toBeGreaterThanOrEqual(15);
      expect(s.newIngredientsWithUsda).toBe(s.newIngredients);
      const rows = await q(
        `select fr.id, nv.nutrient_code, nv.value, nv.method, (app.recipe_variant_nutrients(fr.id, '{}'::jsonb) -> nv.nutrient_code ->> 'value')::numeric calc
           from public.food_items fi join public.food_revisions fr on fr.id = fi.current_revision_id
           join public.nutrient_values nv on nv.revision_id = fr.id
          where fi.id::text like $1 and fi.kind = 'recipe'`, [`${PREFIX}%`]);
      expect(rows.length).toBe(38 * 6);
      for (const r of rows) {
        expect(r.value === null ? null : Number(r.value)).toEqual(r.calc === null ? null : Number(r.calc));
        expect(r.method).toBe(r.value === null ? "unknown" : "calculated");
      }
    });
  });

  it("a recipe stated vegan is eligible for a vegan member as written; one with egg or dairy never is", async () => {
    await tx(async (c) => {
      const q = query(c);
      await load(q, data);
      for (const r of recipes) {
        const rev = fixedId("22", r.slug);
        const vegan = (await q("select app.eligibility($1, 'vegan', '{}', false) ->> 'status' s", [rev]))[0].s;
        if (r.diet.vegan === "compatible") expect(vegan, r.name).toBe("eligible");
        else expect(vegan, r.name).not.toBe("eligible");
        const present = await q(
          `select distinct s.family from public.recipe_ingredients ri join public.ingredient_family_statements s on s.revision_id = ri.ingredient_revision_id
            where ri.recipe_revision_id = $1 and ri.included_by_default and s.presence = 'present'`, [rev]);
        if (r.diet.vegan === "compatible") expect(present, r.name).toEqual([]);
      }
    });
  });

  it("the paneer swap makes the protein not known, never zero", async () => {
    await tx(async (c) => {
      const q = query(c);
      await load(q, data);
      const rev = fixedId("22", "tofu-pea-curry");
      const line = (await q("select id from public.recipe_ingredients where recipe_revision_id = $1 and substitution_group = 'protein' and not included_by_default", [rev]))[0].id;
      const n = (await q("select app.recipe_variant_nutrients($1, jsonb_build_object('protein', $2::text)) v", [rev, line]))[0].v;
      expect(n.protein_g.value).toBeNull();
      expect(n.protein_g.missingReason).toBe("incomplete_recipe");
    });
  });
});
