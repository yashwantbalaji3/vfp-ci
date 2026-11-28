import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { asMember, createTestUser, deleteTestUsers, pool } from "../helpers/db";

// Restaurant submissions (owner direction 17 Nov 2026 23:55 UTC, point 2; docs/48). Every test runs in
// one transaction that is rolled back, except the account-deletion test, which cleans up after itself.
// Places, people and dishes are invented.

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
const err = async (c: PoolClient, sql: string, params: unknown[] = []) => {
  await c.query("savepoint s");
  try {
    await c.query(sql, params);
  } catch (e) {
    await c.query("rollback to savepoint s");
    return e as { code: string; message: string };
  }
  throw new Error(`Expected to fail: ${sql}`);
};
const one = async (c: PoolClient, sql: string, params: unknown[] = []) => (await c.query(`select ${sql} as r`, params)).rows[0].r;

async function user(c: PoolClient, roles: string[] = []) {
  const id = randomUUID();
  await c.query(`insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
                 values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}', '{}', now(), now())`, [id, `partner-${id.slice(0, 8)}@example.test`]);
  for (const r of roles) await c.query("insert into public.role_assignments (user_id, role) values ($1, $2)", [id, r]);
  return id;
}
async function place(c: PoolClient, quality = "corroborated") {
  const run = (await c.query("insert into catalog_import.import_runs (source_key, release, file_sha256, retrieved_at, thresholds, status) values ('boston_food_licenses', 'partner-test', $1, now(), '{}', 'completed') returning id", ["0".repeat(64)])).rows[0].id;
  return (await c.query("insert into catalog_import.place_candidates (name, street, postcode, lat, lon, category, quality, created_run) values ('Partner Test Kitchen', '1 Sample St', '02116', 42.35, -71.07, 'restaurant', $1, $2) returning id", [quality, run])).rows[0].id as string;
}
const sha = (n: number) => n.toString(16).padStart(64, "0");
const item = (o: Record<string, unknown> = {}) => ({
  name: "Lentil bowl",
  section: "Bowls",
  serving: "1 bowl",
  serving_grams: 400,
  ingredients: "lentils, rice, tahini",
  allergens: "sesame",
  dietary: [{ claim: "vegan", words: "Vegan" }],
  nutrition: { protein_g: { amount: 21, unit: "g", per: "serving" }, energy_kcal: { amount: 540, unit: "kcal", per: "serving" } },
  ...o,
});

/** A claimed place, a moderator and (optionally) a passed ownership check. */
async function world(c: PoolClient, verified = true) {
  const rep = await user(c);
  const moderator = await user(c, ["publisher"]);
  const cand = await place(c);
  const claim = await one(c, "partner.create_claim($1, $2, 'Owner', 'Owner@Partner-Kitchen.example.test')", [rep, cand]);
  if (verified) await one(c, "partner.record_ownership_check($1, $2, 'phone_public_number', 'passed', 'Called the number in the city licence record')", [moderator, claim]);
  const submit = (items: unknown[], n = 1, actor = rep, licence = "v1-2026-11") =>
    one(c, "partner.submit_menu($1, $2, $3, 'menu.csv', $4, '2026-11-01', $5::jsonb)", [actor, claim, licence, sha(n), JSON.stringify(items)]);
  const queue = async (actor = moderator) => (await c.query("select * from partner.moderation_queue($1)", [actor])).rows.filter((r) => r.place_name === "Partner Test Kitchen");
  return { rep, moderator, cand, claim, submit, queue };
}

afterAll(async () => {
  await pool.end();
});

describe("restaurant submissions", () => {
  it("a claim starts pending and nothing can be submitted until a moderator's ownership check passes", () =>
    tx(async (c) => {
      const w = await world(c, false);
      expect(await one(c, "partner.claim_state($1)", [w.claim])).toBe("pending");
      expect((await err(c, "select partner.submit_menu($1, $2, 'v1-2026-11', 'm.csv', $3, null, $4::jsonb)", [w.rep, w.claim, sha(1), JSON.stringify([item()])])).message).toMatch(/PARTNER_CLAIM_NOT_VERIFIED/);
      expect(await one(c, "partner.record_ownership_check($1, $2, 'postal_code', 'failed', 'Code not returned')", [w.moderator, w.claim])).toBe("failed");
      expect(await one(c, "partner.record_ownership_check($1, $2, 'email_at_restaurant_domain', 'passed', 'Reply from the address on the restaurant domain')", [w.moderator, w.claim])).toBe("verified");
      expect(await w.submit([item()])).toMatch(/^[0-9a-f-]{36}$/);
    }));

  it("nobody checks their own claim, and only a moderator records a check", () =>
    tx(async (c) => {
      const w = await world(c, false);
      expect((await err(c, "select partner.record_ownership_check($1, $2, 'in_person', 'passed', 'I am the owner')", [w.rep, w.claim])).message).toMatch(/PARTNER_MODERATOR_REQUIRED/);
      // A moderator who claims a place cannot pass their own claim either.
      const modClaim = await one(c, "partner.create_claim($1, $2, 'Manager', 'mod@example.test')", [w.moderator, w.cand]);
      expect((await err(c, "select partner.record_ownership_check($1, $2, 'in_person', 'passed', 'Visited myself')", [w.moderator, modClaim])).message).toMatch(/PARTNER_SAME_PERSON/);
    }));

  it("claims need a signed-in person and a place in the catalog that was not rejected", () =>
    tx(async (c) => {
      const rep = await user(c);
      expect((await err(c, "select partner.create_claim(null, $1, 'Owner', 'a@b.test')", [await place(c)])).message).toMatch(/PARTNER_SIGN_IN_REQUIRED/);
      expect((await err(c, "select partner.create_claim($1, $2, 'Owner', 'a@b.test')", [rep, randomUUID()])).message).toMatch(/PARTNER_PLACE_NOT_FOUND/);
      expect((await err(c, "select partner.create_claim($1, $2, 'Owner', 'a@b.test')", [rep, await place(c, "rejected")])).message).toMatch(/PARTNER_PLACE_NOT_FOUND/);
      expect((await err(c, "select partner.create_claim($1, $2, 'Owner', 'not-an-email')", [rep, await place(c)])).code).toBe("23514");
    }));

  it("only the claimant submits, under a licence version that exists", () =>
    tx(async (c) => {
      const w = await world(c);
      const other = await user(c);
      expect((await err(c, "select partner.submit_menu($1, $2, 'v1-2026-11', 'm.csv', $3, null, $4::jsonb)", [other, w.claim, sha(1), JSON.stringify([item()])])).message).toMatch(/PARTNER_NOT_CLAIMANT/);
      expect((await err(c, "select partner.submit_menu($1, $2, 'v1-2026-11', 'm.csv', $3, null, $4::jsonb)", [w.moderator, w.claim, sha(1), JSON.stringify([item()])])).message).toMatch(/PARTNER_NOT_CLAIMANT/);
      expect((await err(c, "select partner.submit_menu($1, $2, 'v9-2030-01', 'm.csv', $3, null, $4::jsonb)", [w.rep, w.claim, sha(1), JSON.stringify([item()])])).message).toMatch(/PARTNER_LICENCE_REQUIRED/);
      expect((await err(c, "select partner.submit_menu($1, $2, 'v1-2026-11', 'm.csv', $3, null, '[]'::jsonb)", [w.rep, w.claim, sha(1)])).message).toMatch(/PARTNER_ITEMS_REQUIRED/);
      const sub = await w.submit([item()]);
      const row = (await c.query("select licence_version, licence_accepted_at, submitted_by, file_sha256 from partner.submissions where id = $1", [sub])).rows[0];
      expect(row).toMatchObject({ licence_version: "v1-2026-11", submitted_by: w.rep, file_sha256: sha(1) });
      expect(row.licence_accepted_at).toBeInstanceOf(Date);
      // The same file twice is refused, so a resubmission is always a new document.
      expect((await err(c, "select partner.submit_menu($1, $2, 'v1-2026-11', 'm.csv', $3, null, $4::jsonb)", [w.rep, w.claim, sha(1), JSON.stringify([item()])])).code).toBe("23505");
    }));

  it("nutrition needs the right unit and a basis, blanks stay null, and dietary statements keep the restaurant's words", () =>
    tx(async (c) => {
      const w = await world(c);
      const bad = (n: unknown) => err(c, "select partner.submit_menu($1, $2, 'v1-2026-11', 'm.csv', $3, null, $4::jsonb)", [w.rep, w.claim, sha(9), JSON.stringify([item({ nutrition: n })])]);
      expect((await bad({ protein_g: { amount: 21, unit: "mg", per: "serving" } })).message).toMatch(/PARTNER_BAD_NUTRITION/);
      expect((await bad({ protein_g: { amount: "21", unit: "g" } })).message).toMatch(/PARTNER_BAD_NUTRITION/);
      expect((await bad({ protein_g: { amount: -1, unit: "g" } })).message).toMatch(/PARTNER_BAD_NUTRITION/);
      expect((await bad({ protein_g: { amount: 21, unit: "g", per: "slice" } })).message).toMatch(/PARTNER_BAD_NUTRITION/);
      expect((await bad({ caffeine_mg: { amount: 1, unit: "mg" } })).message).toMatch(/PARTNER_BAD_NUTRITION/);
      const badDiet = await err(c, "select partner.submit_menu($1, $2, 'v1-2026-11', 'm.csv', $3, null, $4::jsonb)", [w.rep, w.claim, sha(9), JSON.stringify([item({ dietary: [{ claim: "plant-based", words: "Plant based" }] })])]);
      expect(badDiet.message).toMatch(/PARTNER_BAD_DIETARY/);
      const noName = await err(c, "select partner.submit_menu($1, $2, 'v1-2026-11', 'm.csv', $3, null, $4::jsonb)", [w.rep, w.claim, sha(9), JSON.stringify([item({ name: "  " })])]);
      expect(noName.message).toMatch(/PARTNER_ITEM_NAME_REQUIRED/);

      const sub = await w.submit([item({ nutrition: {}, description: "", dietary: [{ claim: "vegetarian", words: "Vegetarian (contains dairy)" }] })]);
      const it = (await c.query("select description, nutrition, dietary, serving_grams from partner.items where submission_id = $1", [sub])).rows[0];
      expect(it.description).toBeNull();
      expect(it.nutrition).toEqual({});
      expect(it.dietary).toEqual([{ claim: "vegetarian", words: "Vegetarian (contains dairy)" }]);
    }));

  it("automatic checks only flag, they never change what the restaurant said", () =>
    tx(async (c) => {
      const w = await world(c);
      const sub = await w.submit([
        item({ name: "Vegan cheesecake", ingredients: "cashew, cream cheese, sugar" }),
        item({ name: "Veg wrap", dietary: [{ claim: "vegetarian", words: "Vegetarian" }], ingredients: "hummus, chicken" }),
        item({ name: "Shake", nutrition: { protein_g: { amount: 60, unit: "g", per: "serving" }, energy_kcal: { amount: 200, unit: "kcal", per: "serving" } } }),
        item({ name: "Side", serving: null, serving_grams: null, nutrition: { protein_g: { amount: 4, unit: "g" } } }),
        item({ name: "Soup", allergens: null }),
        item({ name: "Eggplant stew", ingredients: "eggplant, tomato" }),
      ]);
      const rows = (await c.query("select name, flags, dietary from partner.items where submission_id = $1 order by position", [sub])).rows;
      const flags = Object.fromEntries(rows.map((r) => [r.name, r.flags]));
      expect(flags["Vegan cheesecake"]).toEqual(["vegan_statement_with_animal_ingredient_word"]);
      expect(flags["Veg wrap"]).toEqual(["vegetarian_statement_with_meat_or_fish_word"]);
      expect(flags["Shake"]).toEqual(["protein_energy_exceeds_calories"]);
      expect(flags["Side"]).toEqual(["nutrition_per_serving_without_serving_size"]);
      expect(flags["Soup"]).toEqual(["no_allergen_statement"]);
      expect(flags["Eggplant stew"]).toEqual([]);
      // The vegan statement is kept exactly as written, flagged for a person to check.
      expect(rows[0].dietary).toEqual([{ claim: "vegan", words: "Vegan" }]);
    }));

  it("the moderation queue is moderator-only and shows provenance", () =>
    tx(async (c) => {
      const w = await world(c);
      await w.submit([item(), item({ name: "Tofu bowl" })]);
      expect((await err(c, "select * from partner.moderation_queue($1)", [w.rep])).message).toMatch(/PARTNER_MODERATOR_REQUIRED/);
      const q = await w.queue();
      expect(q.map((r) => r.name)).toEqual(["Lentil bowl", "Tofu bowl"]);
      expect(q[0]).toMatchObject({ claimant_email: "owner@partner-kitchen.example.test", licence_version: "v1-2026-11", file_name: "menu.csv", file_sha256: sha(1), place_street: "1 Sample St" });
      expect(q[0].ownership).toMatchObject({ method: "phone_public_number" });
    }));

  it("no restaurant approves its own submission: a moderator who claims the place cannot review it", () =>
    tx(async (c) => {
      const w = await world(c);
      await w.submit([item()]);
      const [q] = await w.queue();
      expect((await err(c, "select partner.review_item($1, $2, 'verified')", [w.rep, q.item_id])).message).toMatch(/PARTNER_MODERATOR_REQUIRED/);
      // Give the representative the moderator role too: still refused for their own place.
      await c.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher')", [w.rep]);
      expect((await err(c, "select partner.review_item($1, $2, 'verified')", [w.rep, q.item_id])).message).toMatch(/PARTNER_SAME_PERSON/);
      // A moderator who has any claim on the same place, even an unverified one, is refused as well.
      const mod2 = await user(c, ["publisher"]);
      await one(c, "partner.create_claim($1, $2, 'Investor', 'inv@example.test')", [mod2, w.cand]);
      expect((await err(c, "select partner.review_item($1, $2, 'verified')", [mod2, q.item_id])).message).toMatch(/PARTNER_SAME_PERSON/);
      // An independent moderator reviews it once; a second decision is refused.
      expect(await one(c, "partner.review_item($1, $2, 'verified', 'Matches the printed menu')", [w.moderator, q.item_id])).toBe("verified");
      expect((await err(c, "select partner.review_item($1, $2, 'rejected')", [w.moderator, q.item_id])).message).toMatch(/PARTNER_ALREADY_REVIEWED/);
      expect((await err(c, "select partner.review_item($1, $2, 'maybe')", [w.moderator, (await w.queue())[0]?.item_id ?? randomUUID()])).message).toMatch(/PARTNER_(BAD_DECISION|NOT_FOUND)/);
      expect(await w.queue()).toEqual([]);
    }));

  it("withdrawal or a revoked ownership check takes the claim out of the queue and stops new submissions", () =>
    tx(async (c) => {
      const w = await world(c);
      await w.submit([item()]);
      const [q] = await w.queue();
      expect(await one(c, "partner.record_ownership_check($1, $2, 'phone_public_number', 'revoked', 'Restaurant says this person left')", [w.moderator, w.claim])).toBe("revoked");
      expect(await w.queue()).toEqual([]);
      expect((await err(c, "select partner.review_item($1, $2, 'verified')", [w.moderator, q.item_id])).message).toMatch(/PARTNER_CLAIM_NOT_VERIFIED/);

      const w2 = await world(c);
      await w2.submit([item()], 2);
      const stranger = await user(c);
      expect((await err(c, "select partner.withdraw($1, $2)", [stranger, w2.claim])).message).toMatch(/PARTNER_NOT_CLAIMANT/);
      expect(await one(c, "partner.withdraw($1, $2, 'Menu changing')", [w2.rep, w2.claim])).toBe("withdrawn");
      expect(await one(c, "partner.claim_state($1)", [w2.claim])).toBe("withdrawn");
      expect(await w2.queue()).toEqual([]);
      expect((await err(c, "select partner.submit_menu($1, $2, 'v1-2026-11', 'm.csv', $3, null, $4::jsonb)", [w2.rep, w2.claim, sha(3), JSON.stringify([item()])])).message).toMatch(/PARTNER_CLAIM_NOT_VERIFIED/);
      // A later passed check does not undo a withdrawal.
      await one(c, "partner.record_ownership_check($1, $2, 'in_person', 'passed', 'Visited the restaurant')", [w2.moderator, w2.claim]);
      expect(await one(c, "partner.claim_state($1)", [w2.claim])).toBe("withdrawn");
    }));

  it("history is append-only", () =>
    tx(async (c) => {
      const w = await world(c);
      await w.submit([item()]);
      for (const sql of [
        "update partner.claims set role_title = 'x'",
        "delete from partner.ownership_checks",
        "update partner.items set name = 'x'",
        "delete from partner.submissions",
        "update partner.licence_versions set text = 'x'",
      ]) {
        expect((await err(c, `${sql} where true`)).message).toMatch(/permanent/);
      }
    }));

  it("is closed to the Data API: no reads, no writes and no function calls for guests or members", async () => {
    const tables = ["licence_versions", "claims", "ownership_checks", "submissions", "items", "item_reviews", "withdrawals"];
    for (const role of ["anon", "authenticated"]) {
      const c = await pool.connect();
      try {
        await c.query("begin");
        await c.query(`set local role ${role}`);
        for (const t of tables) expect((await err(c, `select 1 from partner.${t}`)).code).toBe("42501");
        expect((await err(c, "select partner.claim_state(gen_random_uuid())")).code).toBe("42501");
        expect((await err(c, "select * from partner.moderation_queue(gen_random_uuid())")).code).toBe("42501");
      } finally {
        await c.query("rollback").catch(() => {});
        c.release();
      }
    }
    const { rows } = await pool.query(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'partner' and c.relkind = 'r' order by 1`,
    );
    expect(rows.map((r) => r.relname)).toEqual([...tables].sort());
    for (const r of rows) expect([r.relrowsecurity, r.relforcerowsecurity]).toEqual([true, true]);
  });

  it("deleting the representative's account removes their claim and everything it holds", async () => {
    const c = await pool.connect();
    let rep = "";
    let moderator = "";
    let cand = "";
    try {
      await c.query("begin");
      const w = await world(c);
      ({ rep, moderator, cand } = w);
      await w.submit([item()]);
      const [q] = await w.queue();
      await one(c, "partner.review_item($1, $2, 'verified')", [w.moderator, q.item_id]);
      await one(c, "partner.withdraw($1, $2)", [w.rep, w.claim]);
      await c.query("commit");
      await c.query("delete from auth.users where id = $1", [rep]);
      const left = (await c.query(
        `select (select count(*) from partner.claims where id = $1)::int claims,
                (select count(*) from partner.submissions where claim_id = $1)::int subs,
                (select count(*) from partner.ownership_checks where claim_id = $1)::int checks,
                (select count(*) from partner.withdrawals where claim_id = $1)::int withdrawals,
                (select count(*) from partner.items where id = $2)::int items,
                (select count(*) from partner.item_reviews where item_id = $2)::int reviews`,
        [w.claim, q.item_id],
      )).rows[0];
      expect(left).toEqual({ claims: 0, subs: 0, checks: 0, withdrawals: 0, items: 0, reviews: 0 });
    } finally {
      await c.query("rollback").catch(() => {});
      await c.query("delete from auth.users where id = any($1::uuid[])", [[rep, moderator].filter(Boolean)]);
      if (cand) {
        const run = (await c.query("select created_run from catalog_import.place_candidates where id = $1", [cand])).rows[0]?.created_run;
        await c.query("delete from catalog_import.place_candidates where id = $1", [cand]).catch(() => {});
        if (run) await c.query("delete from catalog_import.import_runs where id = $1", [run]).catch(() => {});
      }
      c.release();
    }
  });
});

describe("restaurant submissions through the app's functions (signed-in person only)", () => {
  it("a representative sees only their own claims, a member gets no moderator view, and guests can call nothing", async () => {
    const rep = await createTestUser("partner-rep");
    const other = await createTestUser("partner-other");
    const mod = await createTestUser("partner-mod");
    await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher')", [mod]);
    const run = (await pool.query("insert into catalog_import.import_runs (source_key, release, file_sha256, retrieved_at, thresholds, status) values ('boston_food_licenses', 'partner-test', $1, now(), '{}', 'completed') returning id", ["0".repeat(64)])).rows[0].id;
    const cand = (await pool.query("insert into catalog_import.place_candidates (name, street, postcode, lat, lon, category, quality, created_run) values ('Partner Test Kitchen', '1 Sample St', '02116', 42.35, -71.07, 'restaurant', 'corroborated', $1) returning id", [run])).rows[0].id;
    try {
      const target = await asMember(rep, async (c) => (await c.query("select public.partner_claim_target($1) r", [cand])).rows[0].r);
      expect(target).toEqual({ candidateId: cand, name: "Partner Test Kitchen", street: "1 Sample St", postcode: "02116", myClaim: null });
      const claim = await asMember(rep, async (c) => (await c.query("select public.partner_create_claim($1, 'Owner', 'o@kitchen.example.test') r", [cand])).rows[0].r.id, { commit: true });
      await expect(asMember(rep, (c) => c.query("select public.partner_create_claim($1, 'Owner', 'o@kitchen.example.test')", [cand]))).rejects.toThrow(/PARTNER_ALREADY_CLAIMED/);
      const mine = await asMember(rep, async (c) => (await c.query("select public.partner_my_claims() r")).rows[0].r);
      expect(mine).toMatchObject([{ claimId: claim, placeName: "Partner Test Kitchen", state: "pending", dishes: 0 }]);
      expect(await asMember(other, async (c) => (await c.query("select public.partner_my_claims() r")).rows[0].r)).toEqual([]);
      await expect(asMember(other, (c) => c.query("select public.partner_claims_overview()"))).rejects.toThrow(/PARTNER_MODERATOR_REQUIRED/);
      await expect(asMember(rep, (c) => c.query("select public.partner_record_check($1, 'in_person', 'passed', 'I am the owner')", [claim]))).rejects.toThrow(/PARTNER_MODERATOR_REQUIRED/);
      await expect(asMember(other, (c) => c.query("select public.partner_withdraw($1)", [claim]))).rejects.toThrow(/PARTNER_NOT_CLAIMANT/);
      await asMember(mod, (c) => c.query("select public.partner_record_check($1, 'phone_public_number', 'passed', 'Called the public number')", [claim]), { commit: true });
      const sub = await asMember(rep, async (c) => (await c.query("select public.partner_submit_menu($1, 'v1-2026-11', 'm.csv', $2, null, $3::jsonb) r", [claim, sha(7), JSON.stringify([item(), item({ name: "Soup", allergens: null })])])).rows[0].r, { commit: true });
      expect(sub).toMatchObject({ dishes: 2, flagged: 1 });
      await expect(asMember(rep, (c) => c.query("select public.partner_submit_menu($1, 'v1-2026-11', 'm.csv', $2, null, $3::jsonb)", [claim, sha(7), JSON.stringify([item()])]))).rejects.toThrow(/PARTNER_ALREADY_SUBMITTED/);
      await expect(asMember(rep, (c) => c.query("select public.partner_moderation_queue()"))).rejects.toThrow(/PARTNER_MODERATOR_REQUIRED/);
      const queue = await asMember(mod, async (c) => (await c.query("select public.partner_moderation_queue() r")).rows[0].r);
      const ours = queue.filter((q: { placeName: string }) => q.placeName === "Partner Test Kitchen");
      expect(ours.map((q: { name: string }) => q.name).sort()).toEqual(["Lentil bowl", "Soup"]);
      expect(ours[0]).toMatchObject({ claimantEmail: "o@kitchen.example.test", licenceVersion: "v1-2026-11", fileSha256: sha(7) });
      expect(await asMember(mod, async (c) => (await c.query("select public.partner_review_item($1, 'verified') r", [ours[0].itemId])).rows[0].r, { commit: true })).toEqual({ decision: "verified" });
      expect((await asMember(rep, async (c) => (await c.query("select public.partner_my_claims() r")).rows[0].r))[0]).toMatchObject({ state: "verified", dishes: 2, verified: 1, rejected: 0 });
      expect(await asMember(rep, async (c) => (await c.query("select public.partner_licence() r")).rows[0].r)).toMatchObject({ version: "v1-2026-11" });
      // Members still cannot touch the partner tables directly.
      await expect(asMember(rep, (c) => c.query("select * from partner.claims"))).rejects.toThrow(/permission denied/);
      // Guests can call none of the app's partner functions.
      for (const fn of ["partner_my_claims()", "partner_licence()", "partner_claims_overview()", "partner_moderation_queue()"]) {
        await expect(asMember(null, (c) => c.query(`select public.${fn}`))).rejects.toThrow(/permission denied/);
      }
      await expect(asMember(null, (c) => c.query("select public.partner_claim_target($1)", [cand]))).rejects.toThrow(/permission denied/);
    } finally {
      await deleteTestUsers([rep, other, mod]);
      await pool.query("delete from catalog_import.place_candidates where id = $1", [cand]);
      await pool.query("delete from catalog_import.import_runs where id = $1", [run]);
    }
  });
});
