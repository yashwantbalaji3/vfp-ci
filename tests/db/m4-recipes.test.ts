import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { asMember, createTestUser, deleteTestUsers, pgError, pool } from "../helpers/db";
import { IDS, M4 } from "../fixtures/ids";

// M4 Recipes and Cooking (T-COOK in docs/14): library and strict dietary rule, scaling,
// substitutions re-evaluated from ingredients, cook sessions, cook-to-log without
// duplicates, the home-cooking goal counted once, plans excluded from totals.

let userA: string;
let userB: string;
const TZ = "America/New_York";
const MON = "2026-09-07"; // a Monday

beforeAll(async () => {
  userA = await createTestUser("m4-a");
  userB = await createTestUser("m4-b");
});
afterAll(async () => {
  await deleteTestUsers([userA, userB]);
  await pool.end();
});

type Cell = { value: number | null; method: string; missingReason: string | null; missingIngredients: number; knownSubtotal: number };
type Detail = {
  name: string; servings: number; yieldServings: number; scale: number; swapped: boolean; swaps: Record<string, string>;
  ingredients: { id: string; name: string; quantity: number; unit: string; grams: number | null; group: string | null; included: boolean;
    alternatives: { id: string; name: string; status: string; selected: boolean; isDefault: boolean }[] }[];
  steps: { ordinal: number; instruction: string; timerSeconds: number | null }[];
  nutrients: Record<string, Cell>;
  eligibility: { status: string; basis: string; reasons: { code: string; family?: string; ingredient?: string }[] };
  suitability: { vegan: string; vegetarian: string };
  families: string[];
  allergens: { contains: string[]; unconfirmed: string[] };
};

const list = async (c: PoolClient, p: Record<string, unknown> = {}) =>
  (await c.query("select public.recipe_list($1) as r", [JSON.stringify({ includeDemo: true, ...p })])).rows[0].r as {
    items: { name: string; proteinG: number | null; eligibility: { status: string } }[];
    counts: { matches: number; needsConfirmation: number; hidden: number; notComparable: number };
  };
const detail = async (c: PoolClient, n: number | string, o: { servings?: number; swaps?: Record<string, string>; diet?: string; excl?: string[] } = {}) =>
  (
    await c.query("select public.recipe_detail($1, $2, $3, $4, $5, false, true) as r", [
      typeof n === "number" ? M4.recipe(n) : n,
      o.servings ?? null,
      JSON.stringify(o.swaps ?? {}),
      o.diet ?? "none",
      o.excl ?? [],
    ])
  ).rows[0].r as Detail;
const names = (r: { items: { name: string }[] }) => r.items.map((i) => i.name);
const start = async (c: PoolClient, n: number, o: { servings?: number; swaps?: Record<string, string>; date?: string; key?: string; plan?: string } = {}) =>
  (
    await c.query("select public.start_cook_session($1, $2, $3, $4, $5, $6, $7, true) as r", [
      o.key ?? randomUUID(), M4.recipe(n), o.servings ?? null, JSON.stringify(o.swaps ?? {}), o.date ?? MON, TZ, o.plan ?? null,
    ])
  ).rows[0].r as { sessionId: string; replayed: boolean };
const complete = async (c: PoolClient, id: string, date = MON) =>
  (await c.query("select public.complete_cook_session($1, $2, $3) as r", [id, date, TZ])).rows[0].r as { replayed: boolean };
const logCook = async (c: PoolClient, id: string, servings: number, o: { slot?: string; date?: string; key?: string; additional?: boolean } = {}) =>
  (
    await c.query("select public.log_cook_session($1, $2, $3, $4, $5, $6, $7) as r", [
      o.key ?? randomUUID(), id, servings, o.slot ?? "dinner", o.date ?? MON, TZ, o.additional ?? false,
    ])
  ).rows[0].r as { entryId: string; replayed: boolean };
const day = async (c: PoolClient, date: string) => (await c.query("select public.diary_day($1) as r", [date])).rows[0].r;
const week = async (c: PoolClient, s: string) => (await c.query("select public.diary_week($1) as r", [s])).rows[0].r;
const homeMeals = (w: { days: { date: string; homeMeals: number }[] }) => w.days.reduce((n, d) => n + d.homeMeals, 0);
const session = async (c: PoolClient, id: string) => (await c.query("select public.my_cook_session($1) as r", [id])).rows[0].r;

describe("recipe library (R-C01)", () => {
  it("holds twelve demo recipes across all four meal types and four cuisines, and none without the demo flag", async () => {
    await asMember(null, async (c) => {
      const all = await list(c);
      expect(all.items).toHaveLength(12);
      expect((await list(c, { includeDemo: false })).items).toHaveLength(0);
      for (const meal of ["breakfast", "lunch", "dinner", "snack"]) expect((await list(c, { meal })).items.length).toBeGreaterThan(0);
      for (const cuisine of ["indian", "asian", "mediterranean", "everyday"]) expect((await list(c, { cuisine })).items.length).toBeGreaterThan(0);
    });
  });

  it("at least four recipes give 20 g of protein or more per serving, from the ingredient calculation", async () => {
    await asMember(null, async (c) => {
      const high = await list(c, { minProtein: 20 });
      expect(high.items.length).toBeGreaterThanOrEqual(4);
      expect(high.items.every((i) => i.proteinG !== null && i.proteinG >= 20)).toBe(true);
      expect(names(high)).not.toContain("Demo red lentil soup");
    });
  });

  it("every recipe has ingredients with amounts, numbered steps, times, equipment and a serving portion", async () => {
    const r = await pool.query(
      `select r.name,
              (select count(*) from recipe_ingredients ri where ri.recipe_revision_id = r.id)::int as lines,
              (select count(*) from recipe_steps st where st.recipe_revision_id = r.id)::int as steps,
              (select count(*) from portions po where po.revision_id = r.id and po.unit = 'serving')::int as portions,
              rr.prep_minutes, rr.cook_minutes, cardinality(rr.equipment) as equipment, cardinality(rr.meal_types) as meals, rr.cuisine,
              rr.rights_record_id
         from recipe_revisions rr join food_revisions r on r.id = rr.food_revision_id`,
    );
    expect(r.rows).toHaveLength(12);
    for (const row of r.rows) {
      expect(row.lines, row.name).toBeGreaterThanOrEqual(3);
      expect(row.steps, row.name).toBeGreaterThanOrEqual(3);
      expect(row.portions, row.name).toBeGreaterThanOrEqual(1);
      expect(row.prep_minutes, row.name).not.toBeNull();
      expect(row.cook_minutes, row.name).not.toBeNull();
      expect(row.equipment, row.name).toBeGreaterThanOrEqual(1);
      expect(row.meals, row.name).toBeGreaterThanOrEqual(1);
      expect(row.cuisine, row.name).not.toBeNull();
      expect(row.rights_record_id, row.name).not.toBeNull(); // rights record: original demo recipe
    }
  });

  it("the stored per-serving numbers of every recipe equal the ingredient-level calculation", async () => {
    const r = await pool.query(
      `select r.name, nv.nutrient_code, nv.value, nv.method, nv.source_record_id,
              (app.recipe_variant_nutrients(r.id, '{}') -> nv.nutrient_code ->> 'value')::numeric as calc
         from recipe_revisions rr join food_revisions r on r.id = rr.food_revision_id
         join nutrient_values nv on nv.revision_id = r.id`,
    );
    expect(r.rows.length).toBeGreaterThanOrEqual(12 * 5);
    for (const row of r.rows) {
      expect(row.method).toBe("calculated");
      expect(row.source_record_id).not.toBeNull();
      if (row.value === null) expect(row.calc, `${row.name} ${row.nutrient_code}`).toBeNull();
      else expect(Number(row.value), `${row.name} ${row.nutrient_code}`).toBeCloseTo(Number(row.calc), 3);
    }
  });

  it("the dietary result of each recipe as written agrees with its ingredients checked one by one", async () => {
    const r = await pool.query(
      `select r.name, d.diet, x.excl,
              app.eligibility(r.id, d.diet, x.excl, false) ->> 'status' as as_written,
              (select max(array_position(array['eligible','conditional','needs_confirmation','excluded'],
                          app.eligibility(s.ingredient_revision_id, d.diet, x.excl, false) ->> 'status'))
                 from app.recipe_selection(r.id, '{}') s) as worst
         from recipe_revisions rr join food_revisions r on r.id = rr.food_revision_id
        cross join (values ('none'), ('vegetarian'), ('vegan')) d(diet)
        cross join (values ('{}'::text[]), ('{egg}'), ('{dairy}'), ('{honey}'), ('{egg,dairy,honey}')) x(excl)
        where r.id <> $1`,
      [IDS.lentilSoup.rev],
    );
    expect(r.rows).toHaveLength(11 * 3 * 5);
    const order = ["eligible", "conditional", "needs_confirmation", "excluded"];
    for (const row of r.rows) expect(row.as_written, `${row.name} ${row.diet} ${row.excl}`).toBe(order[row.worst - 1]);
  });
});

describe("strict dietary rule in the recipe list (same as Discover)", () => {
  it("vegan: confirmed matches only; recipes that contain dairy, egg or honey are never listed, only counted", async () => {
    await asMember(null, async (c) => {
      const vegan = await list(c, { diet: "vegan" });
      expect(vegan.items.every((i) => i.eligibility.status === "eligible")).toBe(true);
      for (const hidden of ["Demo spinach and paneer curry", "Demo baked eggs in pepper and tomato sauce", "Demo yogurt bowl with walnuts and berries"]) {
        expect(names(vegan)).not.toContain(hidden);
        expect(names(await list(c, { diet: "vegan", view: "needs_confirmation" }))).not.toContain(hidden);
      }
      expect(vegan.counts.hidden).toBe(3);
      expect(vegan.counts.matches).toBe(9);
    });
  });

  it("an exclusion with no evidence puts a recipe under 'needs confirmation', never among the matches", async () => {
    await asMember(null, async (c) => {
      // The soup's older ingredients carry no statement about honey.
      const matches = await list(c, { exclusions: ["honey"] });
      const unsure = await list(c, { exclusions: ["honey"], view: "needs_confirmation" });
      expect(names(matches)).not.toContain("Demo red lentil soup");
      expect(names(unsure)).toEqual(["Demo red lentil soup"]);
      expect(names(matches)).not.toContain("Demo yogurt bowl with walnuts and berries"); // contains honey
      expect(names(unsure)).not.toContain("Demo yogurt bowl with walnuts and berries");
    });
  });

  it("egg-free vegetarian hides the egg dish and keeps the dairy dishes", async () => {
    await asMember(null, async (c) => {
      const r = await list(c, { diet: "vegetarian", exclusions: ["egg"] });
      expect(names(r)).not.toContain("Demo baked eggs in pepper and tomato sauce");
      expect(names(r)).toContain("Demo spinach and paneer curry");
    });
  });

  it("rejects unknown filters", async () => {
    await asMember(null, async (c) => {
      for (const p of [{ meal: "brunch" }, { cuisine: "martian" }, { view: "all" }, { minProtein: -1 }, { diet: "keto" }, { exclusions: ["gluten"] }]) {
        await c.query("savepoint s");
        expect((await pgError(c.query("select public.recipe_list($1)", [JSON.stringify(p)]))).code, JSON.stringify(p)).toBe("PT422");
        await c.query("rollback to savepoint s");
      }
    });
  });
});

describe("scaling (R-C02)", () => {
  it("doubling the servings doubles every amount and leaves per-serving numbers unchanged", async () => {
    await asMember(null, async (c) => {
      const base = await detail(c, M4.scramble);
      const twice = await detail(c, M4.scramble, { servings: 4 });
      expect(base.servings).toBe(2);
      expect(twice.scale).toBe(2);
      for (const [i, ing] of base.ingredients.entries()) {
        expect(twice.ingredients[i].quantity).toBeCloseTo(ing.quantity * 2, 6);
        expect(twice.ingredients[i].grams).toBeCloseTo((ing.grams as number) * 2, 6);
      }
      expect(twice.nutrients).toEqual(base.nutrients);
      expect(base.nutrients.protein_g.value).toBeCloseTo(32.52, 1);
    });
  });

  it("halving works, odd numbers of servings keep the ratio, and impossible servings are refused", async () => {
    await asMember(null, async (c) => {
      const half = await detail(c, M4.chana, { servings: 2 });
      expect(half.ingredients.find((i) => i.name === "Demo canned chickpeas")?.grams).toBeCloseTo(240, 6);
      const three = await detail(c, M4.chana, { servings: 3 });
      expect(three.ingredients.find((i) => i.name === "Demo canned chickpeas")?.grams).toBeCloseTo(360, 6);
      for (const bad of [0, -1, 101]) {
        await c.query("savepoint s");
        expect((await pgError(c.query("select public.recipe_detail($1, $2, '{}', 'none', '{}', false, true)", [M4.recipe(M4.chana), bad]))).message).toBe("INVALID_SERVINGS");
        await c.query("rollback to savepoint s");
      }
    });
  });

  it("an unknown ingredient value stays unknown for the recipe at any size: never zero, never a partial total", async () => {
    await asMember(null, async (c) => {
      for (const servings of [4, 8, 1]) {
        const soup = await detail(c, IDS.lentilSoup.item, { servings });
        expect(soup.nutrients.carb_g.value).toBeNull();
        expect(soup.nutrients.carb_g.missingReason).toBe("incomplete_recipe");
        expect(soup.nutrients.carb_g.missingIngredients).toBe(2);
        expect(soup.nutrients.protein_g.value).toBeCloseTo(12.5, 4);
      }
    });
  });

  it("an amount that cannot be converted makes the affected numbers unknown, and the known part is labelled as partial", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica"); // test-only: change a published fixture inside a rolled-back transaction
      await c.query("update recipe_ingredients set unit = 'pinch', grams = null where id = $1", [M4.line(M4.scramble, 7)]);
      const n = (await c.query("select app.recipe_variant_nutrients($1, '{}') as r", [M4.rev(M4.scramble)])).rows[0].r as Record<string, Cell>;
      expect(n.protein_g.value).toBeNull();
      expect(n.protein_g.missingIngredients).toBe(1);
      expect(n.protein_g.knownSubtotal).toBeGreaterThan(30);
      expect(n.energy_kcal.value).toBeNull();
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});

describe("substitutions (R-C04)", () => {
  const TOFU = { protein: M4.line(M4.paneerCurry, 4) };
  const TOFU_COCONUT = { protein: M4.line(M4.paneerCurry, 4), cream: M4.line(M4.paneerCurry, 13) };

  it("a swap recalculates nutrition from the ingredients actually used", async () => {
    await asMember(null, async (c) => {
      const base = await detail(c, M4.paneerCurry);
      const tofu = await detail(c, M4.paneerCurry, { swaps: TOFU });
      expect(base.swapped).toBe(false);
      expect(tofu.swapped).toBe(true);
      expect(base.nutrients.protein_g.value).toBeCloseTo(20.77, 1);
      // 280 g tofu (42 g protein) replaces 250 g paneer (45 g): 3 g less in the pan, 1 g less per serving.
      expect(tofu.nutrients.protein_g.value).toBeCloseTo((base.nutrients.protein_g.value as number) - 1, 2);
      expect(tofu.nutrients.fat_g.value).toBeLessThan(base.nutrients.fat_g.value as number);
      expect(tofu.ingredients.some((i) => i.name === "Demo paneer")).toBe(false);
      expect(tofu.ingredients.find((i) => i.group === "protein")?.name).toBe("Demo extra-firm tofu");
    });
  });

  it("a swap re-evaluates the dietary result from the ingredients: nothing is inherited from the recipe as written", async () => {
    await asMember(null, async (c) => {
      const base = await detail(c, M4.paneerCurry, { diet: "vegan" });
      expect(base.eligibility).toMatchObject({ status: "excluded", basis: "as_written" });
      const half = await detail(c, M4.paneerCurry, { diet: "vegan", swaps: TOFU });
      expect(half.eligibility.status).toBe("excluded"); // the cream is still dairy
      expect(half.eligibility.reasons.some((r) => r.code === "contains_family" && r.family === "dairy" && r.ingredient === "Demo single cream")).toBe(true);
      const both = await detail(c, M4.paneerCurry, { diet: "vegan", swaps: TOFU_COCONUT });
      expect(both.eligibility).toMatchObject({ status: "eligible", basis: "ingredients" });
      expect(both.suitability).toEqual({ vegan: "eligible", vegetarian: "eligible" });
      expect(both.families).toEqual([]);
      expect(both.allergens.contains).toEqual(["soy"]);
      expect(base.allergens.contains).toEqual(["milk"]);
    });
  });

  it("a vegan recipe does not stay 'vegan' after swapping in ghee, honey or egg noodles", async () => {
    await asMember(null, async (c) => {
      const dal = await detail(c, M4.dal, { diet: "vegan", swaps: { fat: M4.line(M4.dal, 8) } });
      expect(dal.eligibility.status).toBe("excluded");
      expect(dal.suitability).toEqual({ vegan: "excluded", vegetarian: "eligible" });
      const oats = await detail(c, M4.oats, { swaps: { sweetener: M4.line(M4.oats, 7) } });
      expect(oats.suitability.vegan).toBe("excluded");
      expect(oats.families).toEqual(["Honey"]);
      const noodles = await detail(c, M4.noodles, { excl: ["egg"], swaps: { noodles: M4.line(M4.noodles, 2) } });
      expect(noodles.eligibility.status).toBe("excluded");
    });
  });

  it("swapping to an ingredient whose status is not confirmed moves the recipe to 'needs confirmation', never to a match", async () => {
    await asMember(null, async (c) => {
      const fresh = { noodles: M4.line(M4.noodles, 3) };
      for (const o of [{ diet: "vegan" }, { excl: ["egg"] }]) {
        const d = await detail(c, M4.noodles, { ...o, swaps: fresh });
        expect(d.eligibility.status).toBe("needs_confirmation");
        expect(d.eligibility.reasons.every((r) => r.ingredient === "Demo fresh market noodles")).toBe(true);
      }
      const d = await detail(c, M4.noodles, { excl: ["egg"] });
      const alts = d.ingredients.find((i) => i.group === "noodles")!.alternatives;
      expect(alts.map((a) => [a.name, a.status])).toEqual([
        ["Demo wheat noodles", "eligible"],
        ["Demo egg noodles", "excluded"],
        ["Demo fresh market noodles", "needs_confirmation"],
      ]);
      expect((await detail(c, M4.noodles, { swaps: fresh })).allergens.unconfirmed).toEqual(["egg"]);
    });
  });

  it("only approved alternatives of that recipe are accepted", async () => {
    await asMember(null, async (c) => {
      const bad: Record<string, string>[] = [
        { protein: M4.line(M4.dal, 8) }, // a line of another recipe
        { protein: M4.line(M4.paneerCurry, 13) }, // a line of another group
        { nonsense: M4.line(M4.paneerCurry, 4) },
        { protein: "not-an-id" },
        { protein: M4.line(M4.paneerCurry, 1) }, // an ordinary ingredient, not an alternative
      ];
      for (const swaps of bad) {
        await c.query("savepoint s");
        const e = await pgError(c.query("select public.recipe_detail($1, null, $2, 'none', '{}', false, true)", [M4.recipe(M4.paneerCurry), JSON.stringify(swaps)]));
        expect(e, JSON.stringify(swaps)).toMatchObject({ code: "PT422", message: "INVALID_SUBSTITUTION" });
        await c.query("rollback to savepoint s");
      }
      // Choosing the default again is the recipe as written.
      const same = await detail(c, M4.paneerCurry, { swaps: { protein: M4.line(M4.paneerCurry, 3) } });
      expect(same.swapped).toBe(false);
      expect(same.eligibility.basis).toBe("as_written");
    });
  });

  it("a member cannot start cooking with a swap that contains something they exclude", async () => {
    await asMember(userA, async (c) => {
      await c.query("select public.save_my_diet('vegan', '{}', false)");
      const e = await pgError(start(c, M4.dal, { swaps: { fat: M4.line(M4.dal, 8) } }));
      expect(e).toMatchObject({ code: "PT422", message: "SUBSTITUTION_EXCLUDED" });
    });
  });
});

describe("cook sessions (R-C03): progress, resume, privacy", () => {
  it("guests cannot start, and a recipe that does not exist is not found", async () => {
    await asMember(null, async (c) => {
      expect((await pgError(start(c, M4.dal))).code).toMatch(/42501|PT401/);
    });
    await asMember(userA, async (c) => {
      await c.query("savepoint s");
      const e = await pgError(c.query("select public.start_cook_session($1, $2, null, '{}', $3, $4, null, true)", [randomUUID(), randomUUID(), MON, TZ]));
      expect(e).toMatchObject({ code: "PT404", message: "RECIPE_NOT_FOUND" });
      await c.query("rollback to savepoint s");
      // A demo recipe is not reachable when demo content is off.
      const off = await pgError(c.query("select public.start_cook_session($1, $2, null, '{}', $3, $4, null, false)", [randomUUID(), M4.recipe(M4.dal), MON, TZ]));
      expect(off.message).toBe("RECIPE_NOT_FOUND");
    });
  });

  it("a session keeps its servings, swaps, step and checked ingredients, so it can be resumed", async () => {
    await asMember(userA, async (c) => {
      const key = randomUUID();
      const swaps = { protein: M4.line(M4.paneerCurry, 4) };
      const s = await start(c, M4.paneerCurry, { servings: 6, swaps, key });
      expect((await start(c, M4.paneerCurry, { servings: 6, swaps, key })).sessionId).toBe(s.sessionId); // double press
      await c.query("select public.save_cook_progress($1, 3, $2)", [s.sessionId, [M4.line(M4.paneerCurry, 1), M4.line(M4.paneerCurry, 4), randomUUID()]]);
      const got = await session(c, s.sessionId);
      expect(got.currentStep).toBe(3);
      expect(got.checkedIngredients.sort()).toEqual([M4.line(M4.paneerCurry, 1), M4.line(M4.paneerCurry, 4)].sort()); // the stray id was dropped
      expect(got.servings).toBe(6);
      expect(got.recipe.scale).toBe(2);
      expect(got.recipe.ingredients.find((i: { group: string | null }) => i.group === "protein").name).toBe("Demo extra-firm tofu");
      expect(got.completedAt).toBeNull();
      const cooking = (await c.query("select public.my_cooking($1) as r", [MON])).rows[0].r;
      expect(cooking.inProgress).toHaveLength(1);
      expect(cooking.inProgress[0]).toMatchObject({ sessionId: s.sessionId, currentStep: 3, stepCount: 6 });
      expect((await pgError(c.query("select public.save_cook_progress($1, 99, '{}')", [s.sessionId]))).message).toBe("INVALID_STEP");
    });
  });

  it("another member gets 'not found' for every session function, and cannot read the row", async () => {
    const s = await asMember(userA, (c) => start(c, M4.dal), { commit: true });
    await asMember(userB, async (c) => {
      const calls: [string, unknown[]][] = [
        ["select public.my_cook_session($1)", [s.sessionId]],
        ["select public.save_cook_progress($1, 1, '{}')", [s.sessionId]],
        ["select public.complete_cook_session($1, $2, $3)", [s.sessionId, MON, TZ]],
        ["select public.abandon_cook_session($1)", [s.sessionId]],
        ["select public.decline_cook_log($1)", [s.sessionId]],
        ["select public.log_cook_session($1, $2, 1, 'dinner', $3, $4, false)", [randomUUID(), s.sessionId, MON, TZ]],
      ];
      for (const [sql, args] of calls) {
        await c.query("savepoint s");
        expect(await pgError(c.query(sql, args)), sql).toMatchObject({ code: "PT404", message: "SESSION_NOT_FOUND" });
        await c.query("rollback to savepoint s");
      }
      expect((await c.query("select id from public.cook_sessions")).rows).toEqual([]);
      expect((await c.query("select public.my_cooking($1) as r", [MON])).rows[0].r).toEqual({ inProgress: [], recent: [] });
    });
    await asMember(null, async (c) => {
      expect((await pgError(c.query("select public.my_cook_session($1)", [s.sessionId]))).code).toMatch(/42501|PT401/);
      await c.query("rollback");
      await c.query("begin");
      await c.query("set local role anon");
      // Since R1 a signed-out caller has no privilege on this table at all (previously: allowed to ask, shown nothing).
      expect((await pgError(c.query("select id from public.cook_sessions"))).code).toBe("42501");
    });
    await pool.query("delete from cook_sessions where id = $1", [s.sessionId]);
  });

  it("members cannot write cook sessions directly, only through the checked functions", async () => {
    await asMember(userA, async (c) => {
      const e = await pgError(
        c.query("insert into public.cook_sessions (owner_id, recipe_revision_id, local_date, completed_at) values ($1, $2, $3, now())", [userA, M4.rev(M4.dal), MON]),
      );
      expect(e.code).toBe("42501");
    });
  });
});

describe("finishing, logging and the home-cooking goal (R-C05, owner rules of 2026-11-14)", () => {
  const WEEK2 = "2026-09-14";
  it("finishing a cook session writes nothing to the diary and changes no protein or calories", async () => {
    await asMember(userA, async (c) => {
      const s = await start(c, M4.dal, { date: WEEK2 });
      expect((await complete(c, s.sessionId, WEEK2)).replayed).toBe(false);
      expect((await complete(c, s.sessionId, WEEK2)).replayed).toBe(true); // pressing Finish twice
      const d = await day(c, WEEK2);
      expect(d.entries).toEqual([]);
      expect(d.totals).toEqual({});
      const w = await week(c, WEEK2);
      expect(w.days[0]).toMatchObject({ entryCount: 0, proteinKnown: null, energyKnown: null, homeMeals: 1, cookSessions: 1 });
      expect(homeMeals(w)).toBe(1);
      expect((await session(c, s.sessionId)).logPrompt).toBe("pending");
      await c.query("select public.decline_cook_log($1)", [s.sessionId]); // "Not now"
      expect((await session(c, s.sessionId)).logPrompt).toBe("declined");
      expect((await day(c, WEEK2)).entries).toEqual([]);
      expect(homeMeals(await week(c, WEEK2))).toBe(1); // still counts as cooking, still nothing eaten
    });
  });

  it("a session that was not finished cannot be logged and does not count", async () => {
    await asMember(userA, async (c) => {
      const s = await start(c, M4.dal, { date: WEEK2 });
      expect((await pgError(logCook(c, s.sessionId, 1, { date: WEEK2 }))).message).toBe("COOK_NOT_FINISHED");
      await c.query("rollback");
    });
    await asMember(userA, async (c) => {
      const s = await start(c, M4.dal, { date: WEEK2 });
      expect(homeMeals(await week(c, WEEK2))).toBe(0);
      await c.query("select public.abandon_cook_session($1)", [s.sessionId]);
      expect(homeMeals(await week(c, WEEK2))).toBe(0);
      expect((await pgError(complete(c, s.sessionId, WEEK2))).message).toBe("SESSION_CLOSED");
    });
  });

  it("logging what was eaten creates one private entry with the recipe as cooked, and the meal still counts once", async () => {
    await asMember(userA, async (c) => {
      const swaps = { protein: M4.line(M4.paneerCurry, 4), cream: M4.line(M4.paneerCurry, 13) };
      const s = await start(c, M4.paneerCurry, { servings: 3, swaps, date: WEEK2 });
      await complete(c, s.sessionId, WEEK2);
      const perServing = (await detail(c, M4.paneerCurry, { swaps })).nutrients;
      const key = randomUUID();
      const first = await logCook(c, s.sessionId, 1.5, { date: WEEK2, key });
      expect(first.replayed).toBe(false);
      const again = await logCook(c, s.sessionId, 1.5, { date: WEEK2, key }); // the same press sent twice
      expect(again).toMatchObject({ entryId: first.entryId, replayed: true });

      const d = await day(c, WEEK2);
      expect(d.entries).toHaveLength(1);
      const e = d.entries[0];
      expect(e).toMatchObject({ context: "home", mealSlot: "dinner", name: "Demo spinach and paneer curry", quantity: 1.5, cookSessionId: s.sessionId });
      expect(e.portion).toMatchObject({ kind: "cooked", substituted: true });
      expect(e.nutrients.protein_g.value).toBeCloseTo((perServing.protein_g.value as number) * 1.5, 3);
      expect(e.nutrients.protein_g.method).toBe("calculated");
      expect(e.nutrients.sodium_mg.value).toBeNull(); // unknown stays unknown in the snapshot

      // The frozen evidence describes the swapped recipe and carries no claim from the recipe as written.
      const snap = (await c.query("select evidence_snapshot from public.diary_snapshots where entry_id = $1", [first.entryId])).rows[0].evidence_snapshot;
      expect(snap.dietaryClaims).toEqual([]);
      expect(snap.cooked).toMatchObject({ substituted: true, servingsCooked: 3, suitability: { vegan: "eligible", vegetarian: "eligible" } });
      expect(snap.cooked.ingredients.some((i: { name: string; swappedIn: boolean }) => i.name === "Demo extra-firm tofu" && i.swappedIn)).toBe(true);

      const w = await week(c, WEEK2);
      expect(w.days[0]).toMatchObject({ entryCount: 1, homeMeals: 1, cookSessions: 1, homeMealsFromDiary: 0 });
      expect(homeMeals(w)).toBe(1);
    });
  });

  it("the same cooked meal cannot be logged twice by accident, and never more than was cooked", async () => {
    await asMember(userA, async (c) => {
      const s = await start(c, M4.dal, { servings: 3, date: WEEK2 });
      await complete(c, s.sessionId, WEEK2);
      await logCook(c, s.sessionId, 1, { date: WEEK2 });
      await c.query("savepoint s");
      expect(await pgError(logCook(c, s.sessionId, 1, { date: WEEK2 }))).toMatchObject({ code: "PT409", message: "ALREADY_LOGGED" });
      await c.query("rollback to savepoint s");
      // Leftovers the next day are a deliberate second entry from the same batch.
      await logCook(c, s.sessionId, 1, { date: "2026-09-15", slot: "lunch", additional: true });
      await c.query("savepoint s2");
      expect(await pgError(logCook(c, s.sessionId, 1.5, { date: "2026-09-16", additional: true }))).toMatchObject({ code: "PT422", message: "MORE_THAN_COOKED" });
      await c.query("rollback to savepoint s2");
      const got = await session(c, s.sessionId);
      expect(got.loggedServings).toBe(2);
      expect(got.entries).toHaveLength(2);
      const w = await week(c, WEEK2);
      expect(homeMeals(w)).toBe(1); // one cooking session, eaten over two days
      expect(w.days[1]).toMatchObject({ entryCount: 1, homeMeals: 0 });
      expect(w.days[0].proteinKnown).toBeCloseTo(21.04, 1);
    });
  });

  it("home-cooked meals are each counted once across cook sessions and ordinary diary entries", async () => {
    await asMember(userA, async (c) => {
      // Monday: dal cooked and eaten at dinner, with a home-made side logged at the same dinner.
      const s = await start(c, M4.dal, { servings: 3, date: WEEK2 });
      await complete(c, s.sessionId, WEEK2);
      await logCook(c, s.sessionId, 1, { date: WEEK2, slot: "dinner" });
      await c.query("select public.log_new_custom_food($1, 'Home rice', null, '{}', null, null, 1, 'home', 'dinner', $2, $3)", [randomUUID(), WEEK2, TZ]);
      let w = await week(c, WEEK2);
      expect(w.days[0].homeMeals).toBe(1);
      // A second recipe cooked for the same dinner is still one meal.
      const s2 = await start(c, M4.crispyChickpeas, { date: WEEK2 });
      await complete(c, s2.sessionId, WEEK2);
      await logCook(c, s2.sessionId, 1, { date: WEEK2, slot: "dinner" });
      w = await week(c, WEEK2);
      expect(w.days[0]).toMatchObject({ homeMeals: 1, cookSessions: 2 });
      // Monday breakfast, home-cooked and logged by hand: a separate meal.
      await c.query("select public.log_new_custom_food($1, 'Porridge', null, '{}', null, null, 1, 'home', 'breakfast', $2, $3)", [randomUUID(), WEEK2, TZ]);
      expect((await week(c, WEEK2)).days[0].homeMeals).toBe(2);
      // Tuesday: cooked the stir-fry, did not use the prompt, then logged the same recipe by hand from its food page.
      const s3 = await start(c, M4.stirFry, { date: "2026-09-15" });
      await complete(c, s3.sessionId, "2026-09-15");
      const portion = (await c.query("select id from public.portions where revision_id = $1", [M4.rev(M4.stirFry)])).rows[0].id;
      await c.query("select public.log_food_entry($1, $2, $3, 1, null, 'home', 'dinner', $4, $5)", [randomUUID(), M4.rev(M4.stirFry), portion, "2026-09-15", TZ]);
      w = await week(c, WEEK2);
      expect(w.days[1]).toMatchObject({ homeMeals: 1, cookSessions: 1 });
      // A restaurant meal never counts.
      await c.query("select public.log_food_entry($1, $2, $3, 1, null, 'restaurant', 'lunch', $4, $5)", [randomUUID(), IDS.bowl.rev, IDS.bowl.portionServing, "2026-09-16", TZ]);
      expect(homeMeals(await week(c, WEEK2))).toBe(3);
    });
  });

  it("removing the diary entry leaves the cooking counted; the amount of a cooked entry can be corrected without recalculating from the catalog", async () => {
    await asMember(userA, async (c) => {
      const swaps = { fat: M4.line(M4.dal, 8) };
      const s = await start(c, M4.dal, { servings: 3, swaps, date: WEEK2 });
      await complete(c, s.sessionId, WEEK2);
      const e = await logCook(c, s.sessionId, 1, { date: WEEK2 });
      const before = (await day(c, WEEK2)).entries[0];
      const upd = (await c.query("select public.update_diary_entry($1, 1, null, 2, null, null, null) as r", [e.entryId])).rows[0].r;
      expect(upd.version).toBe(2);
      const after = (await day(c, WEEK2)).entries[0];
      expect(after.quantity).toBe(2);
      expect(after.nutrients.fat_g.value).toBeCloseTo(before.nutrients.fat_g.value * 2, 3); // still the ghee version
      expect(after.portion).toMatchObject({ kind: "cooked", multiplier: 2 });
      await c.query("savepoint s");
      expect((await pgError(c.query("select public.update_diary_entry($1, 2, null, 4, null, null, null)", [e.entryId]))).message).toBe("MORE_THAN_COOKED");
      await c.query("rollback to savepoint s");
      // Repeating copies the frozen snapshot as an ordinary entry.
      const rep = (await c.query("select public.repeat_diary_entry($1, $2, $3, $4, 'lunch') as r", [randomUUID(), e.entryId, "2026-09-17", TZ])).rows[0].r;
      expect(rep.basis).toBe("copied");
      const copy = (await day(c, "2026-09-17")).entries[0];
      expect(copy.cookSessionId).toBeNull();
      expect(copy.nutrients.fat_g.value).toBeCloseTo(after.nutrients.fat_g.value, 3);
      await c.query("select public.delete_diary_entry($1, 2)", [e.entryId]);
      const w = await week(c, WEEK2);
      expect(w.days[0]).toMatchObject({ entryCount: 0, proteinKnown: null, homeMeals: 1 });
      expect((await session(c, s.sessionId)).loggedServings).toBe(0);
    });
  });

  it("the diary entry keeps its numbers when the recipe is revised later (immutable snapshot)", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userA, role: "authenticated" })]);
      const s = await start(c, M4.chana, { date: WEEK2 });
      await complete(c, s.sessionId, WEEK2);
      await logCook(c, s.sessionId, 1, { date: WEEK2 });
      const before = (await day(c, WEEK2)).entries[0].nutrients.protein_g.value;
      await c.query("reset role");
      await c.query("set local session_replication_role = replica"); // stand-in for a curator publishing changed ingredient data
      await c.query("update nutrient_values set value = value * 3 where revision_id = $1", [M4.ingredientRev(30)]);
      await c.query("set local session_replication_role = origin");
      await c.query("set local role authenticated");
      expect((await day(c, WEEK2)).entries[0].nutrients.protein_g.value).toBe(before);
      expect((await detail(c, M4.chana)).nutrients.protein_g.value).toBeGreaterThan(before * 2);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});

describe("saves and the week plan (R-C06)", () => {
  const WEEK3 = "2026-09-21";
  const plan = async (c: PoolClient, n: number, date: string, o: { servings?: number; slot?: string } = {}) =>
    (await c.query("select public.plan_recipe($1, $2, $3, $4, true) as r", [M4.recipe(n), date, o.servings ?? null, o.slot ?? null])).rows[0].r as { planId: string; existing: boolean };
  const myPlan = async (c: PoolClient) => (await c.query("select public.my_plan($1, $2) as r", [WEEK3, "2026-09-27"])).rows[0].r as { planId: string; name: string; cooked: boolean; date: string; servings: number }[];

  beforeAll(async () => {
    // plan_recipe accepts dates near the real "today" only; these tests use the current week.
  });

  it("a planned recipe is in no total and no count until it is cooked or logged", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await asMember(userA, async (c) => {
      const p = (await c.query("select public.plan_recipe($1, $2, 4, 'dinner', true) as r", [M4.recipe(M4.dal), today])).rows[0].r;
      expect(p.existing).toBe(false);
      const twice = (await c.query("select public.plan_recipe($1, $2, 2, 'dinner', true) as r", [M4.recipe(M4.dal), today])).rows[0].r;
      expect(twice).toMatchObject({ planId: p.planId, existing: true }); // same recipe, day and meal: one plan
      const d = await day(c, today);
      expect(d.entries).toEqual([]);
      expect(d.totals).toEqual({});
      const monday = (await c.query("select ($1::date - ((extract(isodow from $1::date))::int - 1))::text as m", [today])).rows[0].m;
      const w = await week(c, monday);
      const cell = w.days.find((x: { date: string }) => x.date === today);
      expect(cell).toMatchObject({ entryCount: 0, proteinKnown: null, energyKnown: null, homeMeals: 0, cookSessions: 0, plannedCount: 1 });
      const plans = (await c.query("select public.my_plan($1, $1) as r", [today])).rows[0].r;
      expect(plans).toHaveLength(1);
      expect(plans[0]).toMatchObject({ name: "Demo red lentil dal with spinach", servings: 2, mealSlot: "dinner", cooked: false, sessionId: null });

      // Cooking from the plan marks it cooked. Eating is still a separate step.
      const s = await start(c, M4.dal, { date: today, plan: p.planId });
      await complete(c, s.sessionId, today);
      const after = (await c.query("select public.my_plan($1, $1) as r", [today])).rows[0].r;
      expect(after[0]).toMatchObject({ cooked: true, sessionId: s.sessionId });
      expect((await day(c, today)).entries).toEqual([]);

      await c.query("select public.remove_plan($1)", [p.planId]);
      expect((await c.query("select public.my_plan($1, $1) as r", [today])).rows[0].r).toEqual([]);
      expect((await session(c, s.sessionId)).completedAt).not.toBeNull(); // removing a plan does not undo the cooking
    });
    void plan;
    void myPlan;
  });

  it("plans are private: another member cannot see, remove or cook from them", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const p = await asMember(userA, async (c) => (await c.query("select public.plan_recipe($1, $2, 2, null, true) as r", [M4.recipe(M4.chana), today])).rows[0].r, { commit: true });
    await asMember(userB, async (c) => {
      expect((await c.query("select public.my_plan($1, $1) as r", [today])).rows[0].r).toEqual([]);
      expect((await c.query("select id from public.meal_plans")).rows).toEqual([]);
      await c.query("savepoint s");
      expect((await pgError(c.query("select public.remove_plan($1)", [p.planId]))).message).toBe("PLAN_NOT_FOUND");
      await c.query("rollback to savepoint s");
      expect((await pgError(start(c, M4.chana, { date: today, plan: p.planId }))).message).toBe("PLAN_NOT_FOUND");
    });
    await pool.query("delete from meal_plans where id = $1", [p.planId]);
  });

  it("dates far in the past or future, unknown meals and unknown recipes are refused", async () => {
    await asMember(userA, async (c) => {
      for (const [args, msg] of [
        [[M4.recipe(M4.dal), "2020-01-01", 2, null], "INVALID_DATE"],
        [[M4.recipe(M4.dal), "2031-01-01", 2, null], "INVALID_DATE"],
        [[M4.recipe(M4.dal), new Date().toISOString().slice(0, 10), 2, "brunch"], "INVALID_MEAL_SLOT"],
        [[M4.recipe(M4.dal), new Date().toISOString().slice(0, 10), 0, null], "INVALID_SERVINGS"],
        [[IDS.tofu.item, new Date().toISOString().slice(0, 10), 1, null], "RECIPE_NOT_FOUND"],
      ] as [unknown[], string][]) {
        await c.query("savepoint s");
        expect((await pgError(c.query("select public.plan_recipe($1, $2, $3, $4, true)", args))).message, msg).toBe(msg);
        await c.query("rollback to savepoint s");
      }
    });
  });

  it("the data download includes the member's own cook sessions and plans, and nobody else's", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await asMember(userA, async (c) => {
      const s = await start(c, M4.oats, { date: today });
      await complete(c, s.sessionId, today);
      await c.query("select public.plan_recipe($1, $2, 1, 'breakfast', true)", [M4.recipe(M4.oats), today]);
      const mine = (await c.query("select public.export_my_data() as r")).rows[0].r;
      expect(mine.cookSessions.map((x: { recipe: string }) => x.recipe)).toContain("Demo peanut butter overnight oats");
      expect(mine.mealPlans).toHaveLength(1);
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userB, role: "authenticated" })]);
      const theirs = (await c.query("select public.export_my_data() as r")).rows[0].r;
      expect(theirs.cookSessions).toEqual([]);
      expect(theirs.mealPlans).toEqual([]);
    });
  });
});

describe("helper functions are not callable over HTTP", () => {
  it("members and guests cannot execute app.* helpers directly", async () => {
    for (const who of [userA, null]) {
      await asMember(who, async (c) => {
        for (const sql of [
          "select app.recipe_view($1, null, '{}', 'none', '{}', false)",
          "select app.recipe_variant_nutrients($1, '{}')",
          "select app.variant_eligibility($1, '{}', 'none', '{}', false)",
          "select * from app.recipe_selection($1, '{}')",
        ]) {
          await c.query("savepoint s");
          expect((await pgError(c.query(sql, [M4.rev(M4.dal)]))).code, sql).toBe("42501");
          await c.query("rollback to savepoint s");
        }
      });
    }
  });
});
