import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { asMember, createTestUser, deleteTestUsers, pool } from "../helpers/db";

// One dietary answer everywhere (R1 acceptance test 6; docs/14 "the same exclusion produces
// the same eligibility" everywhere).
//
// Every demo dish, recipe and packaged food is run through every surface that can show food:
// Discover, Protein Explorer, the recipe library, a recipe page and its swaps, saved items,
// the following feed, a shared list, recommendations and a member's profile. Under each of
// three dietary filters, each surface must agree with the single rule (check_eligibility):
//   - a food confirmed to fit        appears in the normal view;
//   - a food that needs confirmation appears ONLY in the opt-in "Needs confirmation" view;
//   - a food that contains something excluded appears NOWHERE.
// The surfaces are read as the application reads them, and compared by food id, so a surface
// that quietly used its own rule would fail here.

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Filter = { name: string; diet: string; exclusions: string[]; conditional: boolean };
type Food = { id: string; rev: string; kind: string; name: string };
type Group = "match" | "unsure" | "hidden";

const FILTERS: Filter[] = [
  { name: "vegan", diet: "vegan", exclusions: [], conditional: false },
  { name: "vegetarian, egg-free", diet: "vegetarian", exclusions: ["egg"], conditional: false },
  { name: "vegan, including dishes that need a change", diet: "vegan", exclusions: [], conditional: true },
];
const NONE: Filter = { name: "no filter", diet: "none", exclusions: [], conditional: false };

let author: string; // publishes a list and reviews of every food
let reader: string; // follows the author, saves every food, and reads every surface
let handle: string;
let listId: string;
let foods: Food[] = [];
const known = new Map<string, Food>();
const reference = new Map<string, Group>(); // `${filter.name}|${foodId}` -> group

const run = (uid: string | null, sql: string, params: unknown[] = []) => asMember(uid, (c) => c.query(sql, params), { commit: true });
const read = async (sql: string, params: unknown[] = []): Promise<J> => asMember(reader, async (c: PoolClient) => (await c.query(`select ${sql} as r`, params)).rows[0].r as J);

/** Every known food id that appears anywhere in an answer. Position does not matter: an excluded food must not be mentioned at all. */
function foodIdsIn(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    if (known.has(value)) found.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) foodIdsIn(v, found);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) foodIdsIn(v, found);
  }
  return found;
}
const dietArgs = (f: Filter) => [f.diet, f.exclusions, f.conditional];

/** Each surface: given a filter and a view, the set of food ids it shows. */
const SURFACES: Record<string, (f: Filter, view: "matches" | "needs_confirmation") => Promise<Set<string>>> = {
  Discover: async (f, view) => {
    const found = new Set<string>();
    for (let offset = 0; offset !== null && offset < 500; ) {
      const r = await read("public.search_catalog($1)", [
        { market: "boston", includeDemo: true, view, diet: f.diet === "none" ? undefined : f.diet, exclusions: f.exclusions, includeConditional: f.conditional, evidenceMode: "include_estimates", limit: 50, offset },
      ]);
      foodIdsIn(r.items, found);
      offset = r.nextOffset;
    }
    return found;
  },
  "Protein Explorer": async (f, view) => {
    const found = new Set<string>();
    for (let offset = 0; offset !== null && offset < 500; ) {
      const r = await read("public.search_catalog($1)", [
        { market: "boston", includeDemo: true, view, sort: "protein", diet: f.diet === "none" ? undefined : f.diet, exclusions: f.exclusions, includeConditional: f.conditional, evidenceMode: "include_estimates", limit: 50, offset },
      ]);
      foodIdsIn(r.items, found);
      offset = r.nextOffset;
    }
    return found;
  },
  "Recipe library": async (f, view) =>
    foodIdsIn((await read("public.recipe_list($1)", [{ includeDemo: true, view, diet: f.diet, exclusions: f.exclusions, includeConditional: f.conditional }])).items ?? []),
  "Following feed": async (f, view) => foodIdsIn((await read("public.social_feed('following', $1, $2, $3, $4, null, 50, true)", [view, ...dietArgs(f)])).items ?? []),
  "Shared list": async (f, view) => foodIdsIn((await read("public.list_view($1, $2, $3, $4, $5, true)", [listId, view, ...dietArgs(f)])).items ?? []),
  "Member profile": async (f, view) => {
    const r = await read("public.profile_view($1, $2, $3, $4, $5, true)", [handle, view, ...dietArgs(f)]);
    return foodIdsIn(r.reviews ?? []);
  },
  Recommendations: async (f, view) => foodIdsIn(await read("public.social_recommendations($1, $2, $3, $4, true)", [view, ...dietArgs(f)])),
};

beforeAll(async () => {
  foods = (
    await pool.query(
      `select fi.id, fi.current_revision_id as rev, fi.kind, r.name from public.food_items fi
         join public.food_revisions r on r.id = fi.current_revision_id and r.published_at is not null
        where fi.visibility = 'public' and fi.status = 'published' and fi.is_demo and fi.kind in ('dish', 'recipe', 'packaged') order by fi.id`,
    )
  ).rows as Food[];
  for (const f of foods) known.set(f.id, f);

  author = await createTestUser("r1-matrix-author");
  reader = await createTestUser("r1-matrix-reader");
  handle = `matrix_${author.slice(0, 8)}`;
  await run(author, "select public.save_my_profile($1, 'Matrix Author', null, '{}', true, false, false)", [handle]);
  await run(reader, "select public.save_my_profile($1, 'Matrix Reader', null, '{}', true, false, false)", [`reader_${reader.slice(0, 8)}`]);
  await pool.query("insert into public.member_standing (user_id, first_public_approved_at) values ($1, now()) on conflict (user_id) do update set first_public_approved_at = now()", [author]);
  // A public list holding every food, and a public review of every food.
  listId = (await run(author, "select public.save_list(null, 'Matrix list of every demo food', null) as r")).rows[0].r.listId;
  await run(author, "select public.set_list_items($1, $2, true)", [listId, JSON.stringify(foods.map((f) => ({ kind: "food", id: f.id })))]);
  await run(author, "select public.publish_list($1)", [listId]);
  // Written directly so the per-hour posting limit (tested elsewhere) does not get in the way of 26 reviews.
  await pool.query(
    `insert into public.reviews (author_id, food_item_id, rating, body, audience, publication_state, published_at)
     select $1, x, 4, 'Matrix test review', 'public', 'visible', now() from unnest($2::uuid[]) x`,
    [author, foods.map((f) => f.id)],
  );
  await run(reader, "select public.follow_user($1, true)", [handle]);
  await pool.query("insert into public.saves (owner_id, food_item_id) select $1, x from unnest($2::uuid[]) x", [reader, foods.map((f) => f.id)]);

  // The single rule every surface must agree with.
  for (const f of FILTERS) {
    for (const food of foods) {
      const status = (await read("public.check_eligibility($1, $2, $3, $4)", [food.rev, ...dietArgs(f)])).status as string;
      reference.set(`${f.name}|${food.id}`, status === "eligible" || status === "conditional" ? "match" : status === "needs_confirmation" ? "unsure" : "hidden");
    }
  }
});
afterAll(async () => {
  await deleteTestUsers([author, reader]);
  await pool.end();
});

/** Surfaces that show only a short top list. */
const CAPPED = new Set(["Recommendations"]);
const names = (ids: Iterable<string>) => [...ids].map((id) => known.get(id)!.name).sort();

describe("the fixed set of foods is a real test of the rule", () => {
  it("covers dishes, recipes and a packaged food, and every filter has confirmed, unknown and excluded foods", () => {
    expect(foods.length).toBeGreaterThanOrEqual(20);
    expect(new Set(foods.map((f) => f.kind))).toEqual(new Set(["dish", "recipe", "packaged"]));
    for (const f of FILTERS) {
      const groups = foods.map((food) => reference.get(`${f.name}|${food.id}`));
      for (const g of ["match", "unsure", "hidden"]) expect(groups.filter((x) => x === g).length, `${f.name}: ${g}`).toBeGreaterThan(0);
    }
  });

  it("asking to include dishes that need a change only ever moves a food from 'needs confirmation' to 'fits', never out of 'excluded'", () => {
    for (const food of foods) {
      const strict = reference.get(`vegan|${food.id}`);
      const relaxed = reference.get(`vegan, including dishes that need a change|${food.id}`);
      if (strict === "hidden") expect(relaxed, food.name).toBe("hidden");
      if (strict === "match") expect(relaxed, food.name).toBe("match");
    }
  });
});

describe.each(Object.keys(SURFACES))("%s gives the same dietary answer as the single rule", (surface) => {
  const show = SURFACES[surface];
  let unfiltered: Set<string>;
  beforeAll(async () => {
    unfiltered = await show(NONE, "matches");
  });

  it("shows foods at all when no filter is chosen (so the checks below are not empty)", () => {
    expect(unfiltered.size, `${surface} showed no food without a filter`).toBeGreaterThan(0);
  });

  it.each(FILTERS)("under '$name': confirmed in the normal view, unknown only on request, excluded nowhere", async (f) => {
    const normal = await show(f, "matches");
    const onRequest = await show(f, "needs_confirmation");
    const groupOf = (id: string) => reference.get(`${f.name}|${id}`);

    // Whatever the surface shows in its normal view is confirmed to fit: nothing unknown, nothing excluded.
    expect(names([...normal].filter((id) => groupOf(id) === "hidden")), "excluded food in the normal view").toEqual([]);
    expect(names([...normal].filter((id) => groupOf(id) === "unsure")), "unknown food shown as if it fits").toEqual([]);
    // The opt-in view holds unknown foods only: nothing excluded, nothing already confirmed.
    expect(names([...onRequest].filter((id) => groupOf(id) === "hidden")), "excluded food in the needs-confirmation view").toEqual([]);
    expect(names([...onRequest].filter((id) => groupOf(id) !== "unsure")), "the needs-confirmation view holds something else").toEqual([]);
    // Nothing is lost: every food this surface shows without a filter is in the view the rule puts it in.
    // (Recommendations shows a short top list, so a food can drop off it for reasons other than diet.)
    if (!CAPPED.has(surface)) {
      expect(names([...unfiltered].filter((id) => groupOf(id) === "match" && !normal.has(id))), "confirmed food missing from the normal view").toEqual([]);
      expect(names([...unfiltered].filter((id) => groupOf(id) === "unsure" && !onRequest.has(id))), "unknown food missing from the needs-confirmation view").toEqual([]);
    }
  });
});

describe("surfaces that mark a food instead of hiding it use the same rule", () => {
  it.each(FILTERS.filter((f) => !f.conditional))("saved items under '$name' carry exactly the rule's answer, and none is removed", async (f) => {
    const saves = await read("public.my_saves(true, $1, $2)", [f.diet, f.exclusions]);
    expect(saves.foods).toHaveLength(foods.length);
    expect(saves.total).toBe(foods.length);
    for (const s of saves.foods as J[]) {
      const group = s.eligibility.status === "eligible" ? "match" : s.eligibility.status === "needs_confirmation" ? "unsure" : s.eligibility.status === "excluded" ? "hidden" : s.eligibility.status;
      expect(group, s.name).toBe(reference.get(`${f.name}|${s.foodItemId}`));
    }
  });

  it.each(FILTERS)("a recipe page under '$name' states the rule's answer for the recipe and for every swap", async (f) => {
    let swapsChecked = 0;
    let swapsExcluded = 0;
    for (const recipe of foods.filter((x) => x.kind === "recipe")) {
      const page = await read("public.recipe_detail($1, null, '{}', $2, $3, $4, true)", [recipe.id, ...dietArgs(f)]);
      const status = page.eligibility?.status as string;
      const group = status === "eligible" || status === "conditional" ? "match" : status === "needs_confirmation" ? "unsure" : "hidden";
      expect(group, recipe.name).toBe(reference.get(`${f.name}|${recipe.id}`));
      // Every alternative ingredient on the page carries the rule's own answer for that ingredient, so the
      // page can never present an excluded or unknown swap as suitable.
      for (const line of page.ingredients as J[]) {
        for (const alt of (line.alternatives ?? []) as J[]) {
          swapsChecked += 1;
          const rev = (await pool.query("select ingredient_revision_id as rev from public.recipe_ingredients where id = $1", [alt.id])).rows[0].rev;
          const rule = (await read("public.check_eligibility($1, $2, $3, $4)", [rev, ...dietArgs(f)])).status;
          expect(alt.status, `${recipe.name}: ${alt.name}`).toBe(rule);
          if (rule === "excluded") swapsExcluded += 1;
        }
      }
    }
    expect(swapsChecked).toBeGreaterThan(5);
    expect(swapsExcluded).toBeGreaterThan(0);
  });
});
