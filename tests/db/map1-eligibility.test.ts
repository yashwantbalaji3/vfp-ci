import { afterAll, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { asMember, pgError, pool } from "../helpers/db";
import { IDS } from "../fixtures/ids";

// MAP-1 step 1 (SCALE-1, owner decision M-3): the set-based dietary rule must give the same
// answer as the one-dish-at-a-time rule for every dish, diet and exclusion, including
// confirmed, unknown, excluded, expired, disputed, flagged and recipe-ingredient states.
// "Same answer" means the same status and the same set of reasons (docs/17 D-MAP-ELIG).

afterAll(async () => {
  await pool.end();
});

const DIETS = ["none", "vegan", "vegetarian"];
const EXCLUSIONS = [[], ["egg"], ["dairy", "honey"], ["gelatin"], ["egg", "dairy", "honey", "gelatin", "animal_stock", "fish_sauce", "animal_rennet"]];

/** Compares the two rules over every revision in the database. Returns the number of differences. */
async function compareAll(c: PoolClient, oldFn: string): Promise<{ cases: number; differences: number; sample: unknown[] }> {
  await c.query(`create or replace function pg_temp.norm(j jsonb) returns jsonb language sql immutable as $$
    select jsonb_build_object('status', j->'status', 'reasons',
      coalesce((select jsonb_agg(x order by x::text) from jsonb_array_elements(j->'reasons') x), '[]'::jsonb)) $$`);
  let cases = 0;
  let differences = 0;
  const sample: unknown[] = [];
  for (const diet of DIETS) {
    for (const excl of EXCLUSIONS) {
      for (const cond of [false, true]) {
        const { rows } = await c.query(
          `with revs as (select array_agg(id) as ids from public.food_revisions),
                o as (select r.id as rev, ${oldFn}(r.id, $1, $2::text[], $3) as res from public.food_revisions r),
                n as (select m.revision_id as rev, m.eligibility as res from revs, app.eligibility_many(revs.ids, $1, $2::text[], $3) m)
           select count(*)::int as cases,
                  count(*) filter (where n.rev is null or pg_temp.norm(o.res) is distinct from pg_temp.norm(n.res))::int as diff,
                  (array_agg(jsonb_build_object('rev', o.rev, 'old', o.res, 'new', n.res))
                     filter (where n.rev is null or pg_temp.norm(o.res) is distinct from pg_temp.norm(n.res)))[1:2] as sample
             from o left join n on n.rev = o.rev`,
          [diet, excl, cond],
        );
        cases += rows[0].cases;
        differences += rows[0].diff;
        if (rows[0].sample) sample.push({ diet, excl, cond, rows: rows[0].sample });
      }
    }
  }
  return { cases, differences, sample };
}

async function many(c: PoolClient, rev: string, diet: string, excl: string[] = []) {
  const { rows } = await c.query("select eligibility as r from app.eligibility_many(array[$1::uuid], $2, $3::text[], false)", [rev, diet, excl]);
  return rows[0].r as { status: string; reasons: { code: string; family?: string }[] };
}

/** The one-dish form of the rule (used by dish pages, feeds and lists); searches use the set-based form. */
const REFERENCE = "app.eligibility";

describe("set-based dietary rule equals the one-dish rule (SCALE-1, M-3)", () => {
  it("on the demo catalog as seeded: every revision, 3 diets, 5 exclusion sets, conditional on and off", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      const r = await compareAll(c, REFERENCE);
      expect(r.sample).toEqual([]);
      expect(r.differences).toBe(0);
      expect(r.cases).toBeGreaterThan(2000);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });

  it("with every kind of evidence state made to occur: flagged, expired, disputed, community-only, expired 'no egg', allergen-only, recipe ingredients present, unknown and optional", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      // Test-only: let this transaction change published evidence; nothing is committed.
      await c.query("set local session_replication_role = replica");
      const tofuItem = (await c.query("select food_item_id from public.food_revisions where id = $1", [IDS.tofu.rev])).rows[0].food_item_id;
      // Flagged as needing review (R2).
      await c.query("insert into public.review_flags (food_item_id, flagged_revision_id, reason) values ($1, $2, 'map1 test')", [tofuItem, IDS.tofu.rev]);
      // Expired, disputed and community-only claims.
      await c.query("update public.dietary_claims set expires_at = now() - interval '1 day' where revision_id = $1", [IDS.dal.rev]);
      await c.query("update public.dietary_claims set conflict_state = 'disputed' where revision_id = $1", [IDS.mushroomToast.rev]);
      await c.query("update public.dietary_claims set evidence_tier = 'community_report' where revision_id = $1", [IDS.idli.rev]);
      // An expired "no egg" statement becomes unknown.
      await c.query("update public.ingredient_family_statements set expires_at = now() - interval '1 day' where revision_id = $1 and family = 'egg'", [IDS.paneer.rev]);
      // A milk allergen declaration with no family statement.
      await c.query("insert into public.allergen_statements (revision_id, allergen, presence, checked_at) values ($1, 'milk', 'present', now())", [IDS.lentils.rev]);
      // Recipe ingredients: one containing egg, one with unknown status, one optional and left out.
      await c.query("insert into public.recipe_ingredients (recipe_revision_id, ingredient_revision_id, position, quantity, unit) values ($1, $2, 97, 1, 'piece')", [IDS.tofuStew.rev, IDS.eggNoodles.rev]);
      await c.query("insert into public.recipe_ingredients (recipe_revision_id, ingredient_revision_id, position, quantity, unit) values ($1, $2, 98, 1, 'piece')", [IDS.lentilSoup.rev, IDS.crispbread.rev]);
      await c.query(
        "insert into public.recipe_ingredients (recipe_revision_id, ingredient_revision_id, position, quantity, unit, optional, included_by_default) values ($1, $2, 99, 1, 'piece', true, false)",
        [IDS.dosa.rev, IDS.eggNoodles.rev],
      );

      // Each state does what it should in the new rule …
      expect((await many(c, IDS.tofu.rev, "vegan")).reasons).toContainEqual({ code: "needs_review" });
      expect((await many(c, IDS.dal.rev, "vegetarian")).reasons.map((x) => x.code)).toContain("dietary_claim_expired");
      expect((await many(c, IDS.paneer.rev, "vegetarian", ["egg"])).reasons).toContainEqual({ code: "unconfirmed_excluded_family", family: "egg" });
      expect((await many(c, IDS.lentils.rev, "vegan")).status).toBe("excluded");
      expect((await many(c, IDS.tofuStew.rev, "vegan")).reasons).toContainEqual({ code: "contains_family", family: "egg" });
      expect((await many(c, IDS.lentilSoup.rev, "vegetarian", ["egg"])).status).toBe("needs_confirmation");
      // … and the whole matrix still matches the one-dish rule.
      const r = await compareAll(c, REFERENCE);
      expect(r.sample).toEqual([]);
      expect(r.differences).toBe(0);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });

  it("refuses the same bad input and is not callable by members or guests", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("savepoint a");
      expect((await pgError(c.query("select * from app.eligibility_many(array[$1::uuid], 'carnivore', '{}')", [IDS.tofu.rev]))).message).toBe("INVALID_DIET");
      await c.query("rollback to savepoint a");
      expect((await pgError(c.query("select * from app.eligibility_many(array[$1::uuid], 'vegan', '{peanut}')", [IDS.tofu.rev]))).message).toBe("INVALID_EXCLUSION");
    } finally {
      await c.query("rollback");
      c.release();
    }
    const guest = await pgError(asMember(null, (g) => g.query("select * from app.eligibility_many(array[$1::uuid], 'vegan', '{}')", [IDS.tofu.rev])));
    expect(guest.code).toBe("42501");
  });
});
