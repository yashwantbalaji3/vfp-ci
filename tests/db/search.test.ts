import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { asMember, createTestUser, deleteTestUsers, pgError, pool } from "../helpers/db";
import { IDS } from "../fixtures/ids";

// M2 · T-DISCOVERY and T-PROTEIN at the database layer (docs/14).
// R-D01, R-D02, R-D04, R-D07, R-D08, R-P02, R-P03, R-P04, R-D06, R-005.

type Item = {
  foodItemId: string;
  name: string;
  kind: string;
  distanceM: number | null;
  venue: { name: string; neighborhood: string } | null;
  protein: { perServing: number | null; per100g: number | null; per100kcal: number | null; perServingReason: string | null; method: string };
  eligibility: { status: string; reasons: { code: string; family?: string }[] };
};
type Result = {
  items: Item[];
  nextOffset: number | null;
  counts: { matches: number; needsConfirmation: number; hidden: number; notComparable: number };
  hiddenReasons: { code: string; family: string | null; count: number }[];
  applied: { sort: string };
};

let memberA: string;
let memberB: string;
beforeAll(async () => {
  memberA = await createTestUser("search-a");
  memberB = await createTestUser("search-b");
});
afterAll(async () => {
  await pool.query("delete from public.rate_limit_windows where bucket like 'test:%'");
  await deleteTestUsers([memberA, memberB]);
  await pool.end();
});

/** Search as a guest through the same function the app calls. Demo content is switched on explicitly. */
async function search(params: Record<string, unknown>, user: string | null = null): Promise<Result> {
  return asMember(user, async (c) => {
    const { rows } = await c.query("select public.search_catalog($1::jsonb) as r", [JSON.stringify({ includeDemo: true, limit: 50, ...params })]);
    return rows[0].r as Result;
  });
}
const names = (r: Result) => r.items.map((i) => i.name).sort();
const EGG_FREE = { diet: "vegetarian", exclusions: ["egg"] };

describe("strict dietary filter (owner rule 2026-11-13, R-D08)", () => {
  it("'matches' returns confirmed dishes only", async () => {
    const r = await search({ ...EGG_FREE, kinds: ["dish"] });
    expect(names(r)).toEqual([
      "Demo chickpea power bowl", "Demo house dal", "Demo idli sambar", "Demo masala dosa",
      "Demo paneer tikka", "Demo soft tofu stew", "Demo tempeh rice bowl",
    ]);
    expect(r.items.every((i) => i.eligibility.status === "eligible")).toBe(true);
    expect(r.counts).toMatchObject({ matches: 7, needsConfirmation: 3, hidden: 3 });
  });

  it("unknown egg status appears only in the separate 'needs_confirmation' view, with the unresolved ingredient named", async () => {
    const r = await search({ ...EGG_FREE, kinds: ["dish"], view: "needs_confirmation" });
    expect(names(r)).toEqual(["Demo mushroom toast", "Demo peanut noodles", "Demo veggie burger"]);
    const burger = r.items.find((i) => i.name === "Demo veggie burger")!;
    expect(burger.eligibility.status).toBe("needs_confirmation");
    expect(burger.eligibility.reasons).toContainEqual({ code: "unconfirmed_excluded_family", family: "egg" });
  });

  it("dishes that contain an excluded ingredient are in neither view; they are only counted with a reason", async () => {
    const hiddenNames = ["Demo egg noodle stir-fry", "Demo tofu bibimbap", "Demo green papaya salad"];
    for (const view of ["matches", "needs_confirmation"]) {
      const r = await search({ ...EGG_FREE, kinds: ["dish"], view });
      for (const n of hiddenNames) expect(names(r)).not.toContain(n);
      expect(r.hiddenReasons).toContainEqual({ code: "contains_excluded_family", family: "egg", count: 2 });
      expect(r.hiddenReasons).toContainEqual({ code: "contains_family", family: "fish_sauce", count: 1 });
    }
  });

  it("applies the same rule to recipes and packaged foods", async () => {
    const matches = await search({ ...EGG_FREE, kinds: ["recipe", "packaged"] });
    // Every recipe except the one made with eggs (the M4 library added eleven recipes).
    expect(names(matches)).toHaveLength(11);
    expect(names(matches)).toContain("Demo red lentil soup");
    expect(names(matches)).not.toContain("Demo baked eggs in pepper and tomato sauce");
    const ask = await search({ ...EGG_FREE, kinds: ["recipe", "packaged"], view: "needs_confirmation" });
    expect(names(ask)).toEqual(["Demo protein crispbread"]);
  });

  it("a dish that needs a change is not a confirmed match unless the person opted in", async () => {
    expect(names(await search({ ...EGG_FREE, kinds: ["dish"] }))).not.toContain("Demo peanut noodles");
    const optedIn = await search({ ...EGG_FREE, kinds: ["dish"], includeConditional: true });
    const noodles = optedIn.items.find((i) => i.name === "Demo peanut noodles")!;
    expect(noodles.eligibility.status).toBe("conditional");
    expect(noodles.eligibility.reasons[0].code).toBe("requires_modification");
  });

  it("vegan: no claim or unknown dairy needs confirmation; dairy present is hidden", async () => {
    const matches = await search({ diet: "vegan", kinds: ["dish"] });
    expect(names(matches)).toEqual(["Demo chickpea power bowl", "Demo idli sambar", "Demo soft tofu stew", "Demo tempeh rice bowl"]);
    const ask = await search({ diet: "vegan", kinds: ["dish"], view: "needs_confirmation" });
    expect(names(ask)).toContain("Demo masala dosa");
    expect(names(ask)).not.toContain("Demo paneer tikka");
    expect(matches.hiddenReasons.find((h) => h.family === "dairy")!.count).toBeGreaterThanOrEqual(2);
  });

  it("with no dietary filter nothing is hidden", async () => {
    const r = await search({ kinds: ["dish"] });
    expect(r.counts.hidden).toBe(0);
    expect(r.counts.needsConfirmation).toBe(0);
    expect(r.items).toHaveLength(13);
  });
});

describe("text, place and independent filters (R-D01, R-D02)", () => {
  it("finds by dish name, venue name and cuisine", async () => {
    expect(names(await search({ q: "dal" }))).toContain("Demo house dal");
    expect(names(await search({ q: "Tofu House", kinds: ["dish"] }))).toEqual(["Demo soft tofu stew", "Demo tofu bibimbap"]);
    expect(names(await search({ q: "south-indian" }))).toEqual(["Demo idli sambar", "Demo masala dosa"]);
  });

  it("treats % and _ in the query as text, and rejects over-long queries", async () => {
    expect((await search({ q: "%" })).items).toHaveLength(0);
    const err = await pgError(search({ q: "x".repeat(121) }));
    expect(err.code).toBe("PT422");
  });

  it("neighborhood, cuisine, price and venue type combine", async () => {
    expect(names(await search({ neighborhood: "Allston" }))).toEqual(["Demo idli sambar", "Demo masala dosa"]);
    expect(names(await search({ cuisine: "korean", ...EGG_FREE }))).toEqual(["Demo soft tofu stew"]);
    const cheap = await search({ maxPriceBand: 1, kinds: ["dish"] });
    expect(new Set(cheap.items.map((i) => i.venue!.name))).toEqual(new Set(["Demo Back Bay Garden Café", "Demo Allston Dosa Corner"]));
    expect(names(await search({ venueType: "cafe" }))).toEqual(["Demo house dal", "Demo mushroom toast"]);
    expect(names(await search({ neighborhood: "Allston", cuisine: "korean" }))).toEqual([]);
  });

  it("radius search returns only venues inside the circle, nearest first (R-D07)", async () => {
    const central = { lat: 42.3655, lon: -71.104 };
    const near = await search({ ...central, radiusM: 500, kinds: ["dish"] });
    expect(new Set(near.items.map((i) => i.venue!.name))).toEqual(new Set(["Demo Central Kitchen"]));
    const wide = await search({ ...central, radiusM: 10000, kinds: ["dish"] });
    expect(wide.applied.sort).toBe("distance");
    const distances = wide.items.map((i) => i.distanceM!);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    expect(wide.items[0].distanceM).toBe(0);
    expect(wide.items.length).toBeGreaterThan(near.items.length);
  });

  it("rejects invalid coordinates, radius, basis, view, kind and limit", async () => {
    for (const bad of [
      { lat: 91, lon: 0 }, { lat: 42 }, { lat: 42, lon: -71, radiusM: 60000 }, { basis: "cup" }, { view: "all" },
      { kinds: ["custom"] }, { limit: 51 }, { market: "atlantis" }, { minProtein: -1 }, { sort: "paid" },
    ]) {
      expect((await pgError(search(bad))).code, JSON.stringify(bad)).toBe("PT422");
    }
  });

  it("does not show demo content unless it is explicitly allowed", async () => {
    const r = await search({ includeDemo: false });
    expect(r.items).toHaveLength(0);
    expect(r.counts.matches).toBe(0);
  });
});

describe("protein bases and evidence (R-P02, R-P03)", () => {
  it("computes per serving, per 100 g and per 100 kcal, and explains what cannot be computed", async () => {
    const r = { items: [...(await search({ kinds: ["ingredient"], q: "Demo firm tofu" })).items, ...(await search({ kinds: ["dish"], q: "Demo", limit: 50 })).items] };
    const tofu = r.items.find((i) => i.name === "Demo firm tofu")!;
    expect(Number(tofu.protein.perServing)).toBeCloseTo(18, 6);
    expect(Number(tofu.protein.per100g)).toBeCloseTo(12, 6);
    expect(Number(tofu.protein.per100kcal)).toBeCloseTo((12 / 144) * 100, 6);
    const bowl = r.items.find((i) => i.name === "Demo chickpea power bowl")!;
    expect(Number(bowl.protein.perServing)).toBe(24);
    expect(bowl.protein.per100g).toBeNull();
    expect(Number(bowl.protein.per100kcal)).toBeCloseTo((24 / 610) * 100, 6);
    const dal = r.items.find((i) => i.name === "Demo house dal")!;
    expect(dal.protein.perServing).toBeNull();
    expect(dal.protein.perServingReason).toBe("serving_weight_unknown");
    expect(Number(dal.protein.per100g)).toBe(7);
    const toast = r.items.find((i) => i.name === "Demo mushroom toast")!;
    expect(toast.protein.perServing).toBeNull();
    expect(toast.protein.perServingReason).toBe("not_provided");
  });

  it("minimum protein never treats unknown as zero: unknown rows are set aside and counted", async () => {
    const r = await search({ kinds: ["dish"], minProtein: 20 });
    expect(names(r)).toEqual(["Demo chickpea power bowl", "Demo paneer tikka", "Demo soft tofu stew", "Demo tofu bibimbap", "Demo veggie burger"]);
    // dal (no serving weight), mushroom toast (not provided) and tempeh bowl (estimate hidden)
    expect(r.counts.notComparable).toBe(3);
  });

  it("estimated restaurant protein is hidden by default and shown only on opt-in", async () => {
    const hidden = await search({ q: "tempeh" });
    expect(hidden.items[0].protein.perServing).toBeNull();
    expect(hidden.items[0].protein.perServingReason).toBe("estimate_hidden");
    const shown = await search({ q: "tempeh", evidenceMode: "include_estimates" });
    expect(Number(shown.items[0].protein.perServing)).toBe(28);
    expect(shown.items[0].protein.method).toBe("estimated");
  });

  it("sorting by protein puts unknown values last, never first as zero", async () => {
    const r = await search({ kinds: ["dish"], sort: "protein" });
    const values = r.items.map((i) => (i.protein.perServing === null ? null : Number(i.protein.perServing)));
    const firstNull = values.indexOf(null);
    expect(values.slice(0, firstNull)).toEqual([...values.slice(0, firstNull)].sort((a, b) => b! - a!));
    expect(values.slice(firstNull).every((v) => v === null)).toBe(true);
    expect(r.items[0].name).toBe("Demo paneer tikka");
    const per100g = await search({ kinds: ["ingredient", "packaged"], sort: "protein", basis: "100g" });
    expect(per100g.items[0].name).toBe("Demo protein crispbread"); // 20 g in a 50 g pack = 40 g per 100 g
  });
});

describe("paging, visibility and market boundaries (R-D01, R-D04)", () => {
  async function inTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query("begin");
      return await fn(c);
    } finally {
      await c.query("rollback");
      c.release();
    }
  }
  const run = async (c: PoolClient, params: Record<string, unknown>) =>
    (await c.query("select public.search_catalog($1::jsonb) as r", [JSON.stringify({ includeDemo: true, ...params })])).rows[0].r as Result;

  it("pages are stable when many rows tie: no duplicates, nothing skipped", async () => {
    await inTransaction(async (c) => {
      // 120 synthetic dishes with identical publish times, created only inside this transaction.
      await c.query(`
        with items as (
          insert into public.food_items (kind, visibility, status, is_demo)
          select 'dish', 'public', 'published', true from generate_series(1, 120) returning id
        ), revs as (
          insert into public.food_revisions (food_item_id, revision_no, name, basis_kind, basis_amount, basis_unit, published_at)
          select id, 1, 'Demo bulk dish', 'serving', 1, 'serving', now() from items returning id, food_item_id
        ), d as (
          insert into public.dishes (food_item_id, venue_id) select food_item_id, $1 from revs
        )
        select 1`, [IDS.venueCentral]);
      await c.query("set local session_replication_role = replica");
      await c.query("update public.food_items fi set current_revision_id = r.id from public.food_revisions r where r.food_item_id = fi.id and r.name = 'Demo bulk dish'");
      const seen = new Set<string>();
      let offset: number | null = 0;
      let pages = 0;
      while (offset !== null) {
        const page: Result = await run(c, { q: "bulk", limit: 25, offset });
        for (const i of page.items) {
          expect(seen.has(i.foodItemId)).toBe(false);
          seen.add(i.foodItemId);
        }
        offset = page.nextOffset;
        pages += 1;
      }
      expect(seen.size).toBe(120);
      expect(pages).toBe(5);
    });
  });

  it("never returns drafts, withdrawn food, retired dishes or closed venues", async () => {
    await inTransaction(async (c) => {
      await c.query("set local session_replication_role = replica");
      await c.query("update public.food_items set status = 'withdrawn' where id = $1", [IDS.bowl.item]);
      await c.query("update public.dishes set availability_status = 'retired' where food_item_id = $1", [IDS.paneerItem]);
      await c.query("update public.venues set status = 'closed' where id = $1", [IDS.venueAllston]);
      const r = await run(c, { kinds: ["dish"], limit: 50 });
      const n = r.items.map((i) => i.name);
      expect(n).not.toContain("Demo chickpea power bowl");
      expect(n).not.toContain("Demo paneer tikka");
      expect(n).not.toContain("Demo masala dosa");
      expect((await pgError(c.query("select public.food_detail($1, true)", [IDS.bowl.item]))).code).toBe("PT404");
    });
  });

  it("does not silently return dishes from another market", async () => {
    await inTransaction(async (c) => {
      const m = await c.query(
        "insert into public.markets (slug, name, default_timezone) values ('demo-elsewhere', 'Demo elsewhere', 'America/Chicago') returning id",
      );
      await c.query("update public.venues set market_id = $1 where id = $2", [m.rows[0].id, IDS.venueHarvard]);
      const boston = await run(c, { kinds: ["dish"], limit: 50 });
      expect(boston.items.map((i) => i.name)).not.toContain("Demo soft tofu stew");
      const other = await run(c, { kinds: ["dish"], market: "demo-elsewhere", limit: 50 });
      expect(other.items.map((i) => i.name).sort()).toEqual(["Demo soft tofu stew", "Demo tofu bibimbap"]);
    });
  });
});

describe("detail, sources and compare (R-D03, R-005, R-P04)", () => {
  it("food detail keeps unknown nutrients as null with a reason and exposes the source of each known value", async () => {
    const d = await asMember(null, async (c) => (await c.query("select public.food_detail($1, true) as r", [IDS.bowl.item])).rows[0].r);
    const byCode = Object.fromEntries(d.nutrients.map((n: { code: string }) => [n.code, n]));
    expect(Number(byCode.protein_g.value)).toBe(24);
    expect(byCode.protein_g.method).toBe("published");
    expect(byCode.protein_g.source.publisher).toBe("Synthetic demo fixtures");
    expect(byCode.carb_g.value).toBeNull();
    expect(byCode.carb_g.missingReason).toBe("not_provided");
    expect(d.venue.name).toBe("Demo Central Kitchen");
    expect(d.prices[0].amountMinor).toBe(1350);
    const egg = d.families.find((f: { family: string }) => f.family === "egg");
    expect(egg.presence).toBe("absent_by_statement");
    expect(d.families.find((f: { family: string }) => f.family === "gelatin").presence).toBe("unknown");
  });

  it("recipe detail lists ingredients and steps", async () => {
    const d = await asMember(null, async (c) => (await c.query("select public.food_detail($1, true) as r", [IDS.lentilSoup.item])).rows[0].r);
    expect(d.recipe.steps).toHaveLength(3);
    expect(d.recipe.ingredients.map((i: { name: string }) => i.name)).toEqual(["Demo dry red lentils", "Demo vegetable stock", "Demo butter"]);
    expect(d.recipe.ingredients[2]).toMatchObject({ optional: true, includedByDefault: false });
  });

  it("a member's private custom food is never reachable through public detail, search or compare", async () => {
    const custom = await asMember(memberA, async (c) => {
      const { rows } = await c.query(
        `select public.create_custom_food('Secret snack', null, 'serving', 1, '{"protein_g": 9}'::jsonb, '[]'::jsonb, null) as r`,
      );
      return rows[0].r as { foodItemId?: string; food_item_id?: string };
    }, { commit: true });
    const itemId = (custom.foodItemId ?? custom.food_item_id)!;
    try {
      for (const user of [null, memberB, memberA]) {
        expect((await pgError(asMember(user, (c) => c.query("select public.food_detail($1, true)", [itemId])))).code).toBe("PT404");
        expect((await pgError(asMember(user, (c) => c.query("select public.protein_compare($1::uuid[], true)", [[itemId]])))).code).toBe("PT404");
        expect(names(await search({ q: "Secret snack" }, user))).toEqual([]);
      }
    } finally {
      await pool.query("delete from public.food_items where id = $1", [itemId]);
    }
  });

  it("venue detail returns public facts; unknown venues are not found", async () => {
    const v = await asMember(null, async (c) => (await c.query("select public.venue_detail($1, true) as r", [IDS.venueCentral])).rows[0].r);
    expect(v).toMatchObject({ name: "Demo Central Kitchen", neighborhood: "Central Square", priceBand: 2 });
    expect(v.lat).toBeCloseTo(42.3655, 4);
    const err = await pgError(asMember(null, (c) => c.query("select public.venue_detail(gen_random_uuid(), true)")));
    expect(err.code).toBe("PT404");
    expect((await pgError(asMember(null, (c) => c.query("select public.venue_detail($1, false)", [IDS.venueCentral])))).code).toBe("PT404");
  });

  it("compares one to three foods and refuses a fourth", async () => {
    const three = await asMember(null, async (c) =>
      (await c.query("select public.protein_compare($1::uuid[], true) as r", [[IDS.bowl.item, IDS.paneerItem, IDS.tofu.item]])).rows[0].r);
    expect(three.map((f: { name: string }) => f.name)).toEqual(["Demo chickpea power bowl", "Demo paneer tikka", "Demo firm tofu"]);
    const err = await pgError(asMember(null, (c) =>
      c.query("select public.protein_compare($1::uuid[], true)", [[IDS.bowl.item, IDS.paneerItem, IDS.tofu.item, IDS.dalItem]])));
    expect(err.code).toBe("PT422");
  });

  it("guests cannot call internal helpers directly", async () => {
    expect((await pgError(asMember(null, (c) => c.query("select app.protein_facts($1)", [IDS.bowl.rev])))).code).toBe("42501");
    expect((await pgError(asMember(null, (c) => c.query("select app.source_summary($1)", [IDS.sourceRecord])))).code).toBe("42501");
  });
});

describe("corrections (R-D06)", () => {
  it("a guest cannot submit; a member's report is stored without changing the public record", async () => {
    expect((await pgError(asMember(null, (c) =>
      c.query("select public.submit_correction($1, null, 'egg', 'Contains egg wash', null)", [IDS.mushroomToastItem])))).code).toBe("42501");
    const before = await search({ ...EGG_FREE, kinds: ["dish"], view: "needs_confirmation" });
    const id = await asMember(memberA, async (c) =>
      (await c.query("select public.submit_correction($1, null, 'egg', 'Staff said the bread has egg wash', 'Asked on 13 Nov') as id", [IDS.mushroomToastItem])).rows[0].id,
      { commit: true });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const after = await search({ ...EGG_FREE, kinds: ["dish"], view: "needs_confirmation" });
    expect(names(after)).toEqual(names(before)); // no automatic public overwrite
    const mine = await asMember(memberA, (c) => c.query("select state, proposed_value from public.corrections where id = $1", [id]));
    expect(mine.rows[0]).toMatchObject({ state: "open" });
    const theirs = await asMember(memberB, (c) => c.query("select 1 from public.corrections where id = $1", [id]));
    expect(theirs.rowCount).toBe(0);
    const audit = await pool.query("select 1 from public.audit_events where entity_id = $1 and action = 'correction_submitted'", [id]);
    expect(audit.rowCount).toBe(1);
  });

  it("members cannot insert, edit or decide reports directly", async () => {
    expect((await pgError(asMember(memberA, (c) =>
      c.query("insert into public.corrections (reporter_id, food_item_id, field, proposed_value) values ($1, $2, 'other', 'direct insert')", [memberA, IDS.bowl.item])))).code).toBe("42501");
    // Since the R2 fix-up nobody signed in holds a direct update privilege on corrections; decisions go through the checked function.
    expect((await pgError(asMember(memberA, (c) => c.query("update public.corrections set state = 'accepted' where reporter_id = $1", [memberA])))).code).toBe("42501");
  });

  it("validates the target, field and length, and caps reports at 20 a day", async () => {
    const call = (args: unknown[]) => asMember(memberB, (c) => c.query("select public.submit_correction($1, $2, $3, $4, null)", args));
    expect((await pgError(call([IDS.bowl.item, IDS.venueCentral, "other", "two targets"]))).code).toBe("PT422");
    expect((await pgError(call(["00000000-0000-4000-8000-00000000ffff", null, "other", "missing food"]))).code).toBe("PT404");
    expect((await pgError(call([IDS.bowl.item, null, "not_a_field", "bad field value"]))).code).toBe("PT422");
    expect((await pgError(call([IDS.bowl.item, null, "other", "x"]))).code).toBe("PT422");
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: memberB, role: "authenticated" })]);
      for (let i = 0; i < 20; i++) await c.query("select public.submit_correction(null, $1, 'hours', $2, null)", [IDS.venueCentral, `Closes at ${i} pm`]);
      await c.query("savepoint s");
      const err = await pgError(c.query("select public.submit_correction(null, $1, 'hours', 'one too many', null)", [IDS.venueCentral]));
      expect(err.code).toBe("PT429");
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});

describe("rate limiting (docs/11)", () => {
  // Since R1 a hit needs the server's proof (tests/db/r1-hardening.test.ts covers refusal without it).
  const KEY = "local-development-only-rate-limit-key-0000";
  it("allows the limit and refuses the next hit in the same window", async () => {
    const bucket = `test:${Date.now()}`;
    const hit = () => asMember(null, async (c) => (await c.query("select public.rate_limit_hit($1, $2, 3, 3600) as ok", [KEY, bucket])).rows[0].ok as boolean, { commit: true });
    expect([await hit(), await hit(), await hit(), await hit()]).toEqual([true, true, true, false]);
    const direct = await pgError(asMember(null, (c) => c.query("select * from public.rate_limit_windows")));
    expect(direct.code).toBe("42501");
    expect((await pgError(asMember(null, (c) => c.query("select public.rate_limit_hit($1, 'x', 3, 60)", [KEY])))).code).toBe("PT422");
  });
});
