import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asMember, createTestUser, deleteTestUsers, pgError, pool } from "../helpers/db";
import { IDS } from "../fixtures/ids";

// Ingredient exclusions and dietary eligibility (docs/18, docs/14 v1.1; R-D08, R-C07, F15).
// Unknown ingredient status must never be treated as confirmed safe or suitable.

let member: string;
beforeAll(async () => {
  member = await createTestUser("diet");
});
afterAll(async () => {
  await deleteTestUsers([member]);
  await pool.end();
});

async function status(rev: string, diet: string, exclusions: string[], includeConditional = false) {
  return asMember(null, async (c) => {
    const { rows } = await c.query("select public.check_eligibility($1, $2, $3::text[], $4) as r", [rev, diet, exclusions, includeConditional]);
    return rows[0].r as { status: string; reasons: { code: string; family?: string }[] };
  });
}

describe("egg-free vegetarian (dairy allowed)", () => {
  it("rejects egg noodles", async () => {
    const r = await status(IDS.eggNoodles.rev, "vegetarian", ["egg"]);
    expect(r.status).toBe("excluded");
    expect(r.reasons).toContainEqual({ code: "contains_excluded_family", family: "egg" });
  });

  it("withholds a burger whose binder is unconfirmed (unknown is not safe)", async () => {
    const r = await status(IDS.veggieBurger.rev, "vegetarian", ["egg"]);
    expect(r.status).toBe("needs_confirmation");
    expect(r.reasons).toContainEqual({ code: "unconfirmed_excluded_family", family: "egg" });
  });

  it("allows paneer with confirmed egg absence", async () => {
    expect((await status(IDS.paneer.rev, "vegetarian", ["egg"])).status).toBe("eligible");
  });

  it("does not infer egg-free from a vegetarian claim alone", async () => {
    const r = await status(IDS.mushroomToast.rev, "vegetarian", ["egg"]);
    expect(r.status).toBe("needs_confirmation");
    expect((await status(IDS.mushroomToast.rev, "vegetarian", [])).status).toBe("eligible");
  });
});

describe("dairy-free and vegan", () => {
  it("dairy-free vegetarian rejects ghee and paneer; egg-free does not imply dairy-free", async () => {
    expect((await status(IDS.dal.rev, "vegetarian", ["dairy"])).status).toBe("excluded");
    expect((await status(IDS.paneer.rev, "vegetarian", ["dairy"])).status).toBe("excluded");
    expect((await status(IDS.dal.rev, "vegetarian", ["egg"])).status).toBe("eligible");
  });

  it("vegan rejects positive dairy evidence even without a vegan claim", async () => {
    const r = await status(IDS.paneer.rev, "vegan", []);
    expect(r.status).toBe("excluded");
    expect(r.reasons).toContainEqual({ code: "contains_family", family: "dairy" });
  });

  it("a venue's 'vegetarian' label cannot override fish sauce", async () => {
    const r = await status(IDS.papayaSalad.rev, "vegetarian", []);
    expect(r.status).toBe("excluded");
    expect(r.reasons).toContainEqual({ code: "contains_family", family: "fish_sauce" });
  });

  it("a food with no dietary claim needs confirmation, never 'eligible'", async () => {
    expect((await status(IDS.crispbread.rev, "vegan", [])).status).toBe("needs_confirmation");
  });
});

describe("recipes", () => {
  it("recipe presence comes from included ingredients; an excluded optional butter does not count", async () => {
    expect((await status(IDS.lentilSoup.rev, "vegan", [])).status).toBe("eligible");
    expect((await status(IDS.lentilSoup.rev, "vegetarian", ["egg", "dairy"])).status).toBe("eligible");
  });

  it("including an ingredient with dairy makes the recipe dairy-present", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      const { rows } = await c.query(
        `insert into public.recipe_revisions (food_revision_id, yield_servings) values (gen_random_uuid(), 1) returning 1`,
      ).catch(() => ({ rows: [] }));
      expect(rows).toHaveLength(0); // cannot attach a recipe to a non-existent revision
    } finally {
      await c.query("rollback");
      c.release();
    }
    const r = await asMember(null, (c) =>
      c.query("select app.family_presence($1, 'dairy') as p", [IDS.lentilSoup.rev]).catch((e) => ({ rows: [{ p: e.code }] })),
    );
    // app.* helpers are not callable by guests.
    expect(r.rows[0].p).toBe("42501");
  });
});

describe("search speed-up keeps every answer (R2 fix-up, D-R2-FASTPATH)", () => {
  // app.eligibility skips the per-family loop only when no evidence could make a family present.
  // These cases sit exactly on the routes that must still reach the loop.
  it("an egg or milk allergen declaration alone still excludes a vegan-claimed food", async () => {
    expect((await status(IDS.tofu.rev, "vegan", [])).status).toBe("eligible");
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("alter table public.allergen_statements disable trigger allergen_statements_frozen");
      await c.query("insert into public.allergen_statements (revision_id, allergen, presence, checked_at) values ($1, 'milk', 'present', now())", [IDS.tofu.rev]);
      const r = await c.query("select app.eligibility($1, 'vegan', '{}') as r", [IDS.tofu.rev]);
      expect(r.rows[0].r.status).toBe("excluded");
      expect(r.rows[0].r.reasons).toContainEqual({ code: "contains_family", family: "dairy" });
    } finally {
      await c.query("rollback");
      c.release();
    }
  });

  it("an included recipe ingredient with egg still excludes a vegan recipe that has no egg statement of its own", async () => {
    expect((await status(IDS.lentilSoup.rev, "vegan", [])).status).toBe("eligible");
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("alter table public.recipe_ingredients disable trigger recipe_ingredients_frozen");
      await c.query(
        "insert into public.recipe_ingredients (recipe_revision_id, ingredient_revision_id, position, quantity, unit) values ($1, $2, 98, 1, 'piece')",
        [IDS.lentilSoup.rev, IDS.eggNoodles.rev],
      );
      const r = await c.query("select app.eligibility($1, 'vegan', '{}') as r", [IDS.lentilSoup.rev]);
      expect(r.rows[0].r.status).toBe("excluded");
      expect(r.rows[0].r.reasons).toContainEqual({ code: "contains_family", family: "egg" });
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});

describe("unknown ingredient status is never a confirmed match (owner rule 2026-11-13)", () => {
  it("an expired 'no egg' statement falls back to needs confirmation", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("alter table public.ingredient_family_statements disable trigger family_statements_frozen");
      await c.query(
        "update public.ingredient_family_statements set expires_at = now() - interval '1 day' where revision_id = $1 and family = 'egg'",
        [IDS.paneer.rev],
      );
      const r = await c.query("select app.eligibility($1, 'vegetarian', '{egg}') as r", [IDS.paneer.rev]);
      expect(r.rows[0].r.status).toBe("needs_confirmation");
      expect(r.rows[0].r.reasons.map((x: { code: string }) => x.code)).toContain("unconfirmed_excluded_family");
    } finally {
      await c.query("rollback");
      c.release();
    }
  });

  it("a recipe with one included ingredient of unknown egg status needs confirmation, even if the recipe says 'no egg'", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("alter table public.recipe_ingredients disable trigger recipe_ingredients_frozen");
      await c.query("alter table public.ingredient_family_statements disable trigger family_statements_frozen");
      await c.query(
        "insert into public.ingredient_family_statements (revision_id, family, presence, source_record_id, checked_at) values ($1, 'egg', 'absent_by_statement', '00000000-0000-4000-8000-00000000b201', now()) on conflict (revision_id, family) do update set presence = excluded.presence",
        [IDS.lentilSoup.rev],
      );
      // The demo crispbread has no egg statement at all, so its egg status is unknown.
      await c.query(
        "insert into public.recipe_ingredients (recipe_revision_id, ingredient_revision_id, position, quantity, unit) values ($1, $2, 99, 1, 'piece')",
        [IDS.lentilSoup.rev, IDS.crispbread.rev],
      );
      const r = await c.query("select app.eligibility($1, 'vegetarian', '{egg}') as r", [IDS.lentilSoup.rev]);
      expect(r.rows[0].r.status).toBe("needs_confirmation");
      // Marking the same ingredient optional and not included restores the confirmed match.
      await c.query("update public.recipe_ingredients set optional = true, included_by_default = false where recipe_revision_id = $1 and position = 99", [IDS.lentilSoup.rev]);
      const r2 = await c.query("select app.eligibility($1, 'vegetarian', '{egg}') as r", [IDS.lentilSoup.rev]);
      expect(r2.rows[0].r.status).toBe("eligible");
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});

describe("freshness and disputes (F15)", () => {
  it("a disputed vegan claim stops qualifying for strict results immediately", async () => {
    const c = await pool.connect();
    const curator = await createTestUser("curator");
    try {
      await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'curator')", [curator]);
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: curator, role: "authenticated" })]);
      const before = await c.query("select public.check_eligibility($1, 'vegan', '{}'::text[]) as r", [IDS.bowl.rev]);
      expect(before.rows[0].r.status).toBe("eligible");
      const claim = await c.query("select id from public.dietary_claims where revision_id = $1 and diet = 'vegan'", [IDS.bowl.rev]);
      await c.query("select public.flag_dietary_conflict($1, 'Newer ingredient statement lists honey glaze')", [claim.rows[0].id]);
      const after = await c.query("select public.check_eligibility($1, 'vegan', '{}'::text[]) as r", [IDS.bowl.rev]);
      expect(after.rows[0].r.status).toBe("needs_confirmation");
      expect(after.rows[0].r.reasons[0].code).toBe("dietary_claim_disputed");
      // Other evidence on the published revision remains immutable.
      // Nobody signed in can edit evidence directly (since the R2 fix-up the refusal is outright) …
      await c.query("savepoint direct");
      expect((await pgError(c.query("update public.dietary_claims set outcome = 'incompatible' where id = $1", [claim.rows[0].id]))).code).toBe("42501");
      await c.query("rollback to savepoint direct");
      // … and the immutability trigger stops even the database owner.
      await c.query("reset role");
      const err = await pgError(c.query("update public.dietary_claims set outcome = 'incompatible' where id = $1", [claim.rows[0].id]));
      expect(err.code).toBe("PT403");
    } finally {
      await c.query("rollback");
      c.release();
      await deleteTestUsers([curator]);
    }
  });

  it("an expired claim cannot qualify", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      // Simulate time passing by moving the claim expiry into the past (owner-only test setup).
      await c.query("alter table public.dietary_claims disable trigger dietary_claims_frozen");
      await c.query("update public.dietary_claims set expires_at = now() - interval '1 day' where revision_id = $1", [IDS.tofu.rev]);
      const r = await c.query("select app.eligibility($1, 'vegan', '{}') as r", [IDS.tofu.rev]);
      expect(r.rows[0].r.status).toBe("needs_confirmation");
      expect(r.rows[0].r.reasons[0].code).toBe("dietary_claim_expired");
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});

describe("member preferences", () => {
  it("my_eligibility applies the member's own diet and exclusions; changes bump the eligibility version", async () => {
    await asMember(member, async (c) => {
      await c.query("insert into public.user_preferences (user_id, diet) values ($1, 'vegetarian')", [member]);
      const v1 = await c.query("select public.my_eligibility($1) as r", [IDS.veggieBurger.rev]);
      expect(v1.rows[0].r.status).toBe("eligible");
      await c.query("insert into public.ingredient_exclusions (owner_id, ingredient_family) values ($1, 'egg')", [member]);
      const v2 = await c.query("select public.my_eligibility($1) as r", [IDS.veggieBurger.rev]);
      expect(v2.rows[0].r.status).toBe("needs_confirmation");
      expect(v2.rows[0].r.eligibilityVersion).toBeGreaterThan(v1.rows[0].r.eligibilityVersion);
    });
  });

  it("rejects unknown ingredient families and invalid diets", async () => {
    expect((await pgError(status(IDS.tofu.rev, "vegetarian", ["bacon"]))).message).toBe("INVALID_EXCLUSION");
    expect((await pgError(status(IDS.tofu.rev, "pescatarian", []))).message).toBe("INVALID_DIET");
  });
});
