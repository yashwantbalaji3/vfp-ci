import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../helpers/db";
import { assess, build, sample } from "../../scripts/catalog-preview.mjs";

// Private real-catalog preview (docs/32). Every test runs inside one transaction that is rolled back.
// Places below are invented (synthetic names and addresses), never real restaurants.

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

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
async function user(c: PoolClient, role?: string) {
  const id = randomUUID();
  await c.query(
    "insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}', '{}', now(), now())",
    [id, `preview-${id.slice(0, 8)}@example.test`],
  );
  if (role) await c.query("insert into public.role_assignments (user_id, role) values ($1, $2)", [id, role]);
  return id;
}
/** Runs `sql` as a guest (null) or a member, the way the Data API does. */
async function as(c: PoolClient, uid: string | null, sql: string, params: unknown[] = []) {
  await c.query(`set local role ${uid ? "authenticated" : "anon"}`);
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(uid ? { sub: uid, role: "authenticated" } : { role: "anon" })]);
  // On failure the caller rolls back to its savepoint, which also undoes the role change.
  const rows = (await c.query(sql, params)).rows;
  await c.query("reset role");
  return rows;
}
const dir = (c: PoolClient, uid: string | null, p: J = { preview: true, q: "Test Place Lantern" }) =>
  as(c, uid, "select public.place_directory($1::jsonb) d", [JSON.stringify(p)]).then((r) => r[0].d as J);

const listing = (o: J = {}) => ({
  candidate_id: randomUUID(), slug: `test-place-${randomUUID().slice(0, 8)}`, name: "Test Place Lantern", street: "1 Sample St", locality: "Boston",
  postcode: "02116", area: "Back Bay / Prudential", lat: 42.35, lon: -71.07, category: "Restaurant", identity_status: "corroborated",
  sources: JSON.stringify([{ key: "overture_places", title: "Test source", attribution: "Test attribution" }]), built_from: "test", ...o,
});
async function addListing(c: PoolClient, o: J = {}) {
  const l = listing(o);
  const cols = Object.keys(l);
  return (await c.query(`insert into public.place_listings (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, Object.values(l))).rows[0].id as string;
}

afterAll(async () => {
  await pool.end();
});

describe("place listings are private until the owner's launch decision", () => {
  it("the table is closed to guests and members; RLS is on", async () => {
    for (const role of ["anon", "authenticated"]) {
      const p = await pool.query("select has_table_privilege($1, 'public.place_listings', 'select') s, has_table_privilege($1, 'public.place_listings', 'insert') i", [role]);
      expect(p.rows[0]).toEqual({ s: false, i: false });
    }
    const r = await pool.query("select relrowsecurity from pg_class where oid = 'public.place_listings'::regclass");
    expect(r.rows[0].relrowsecurity).toBe(true);
  });

  it("has no dietary, menu, dish, allergen or nutrition field; menu status is only 'not checked'", async () => {
    const cols = (await pool.query("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'place_listings'")).rows.map((r: J) => r.column_name);
    expect(cols.join(" ")).not.toMatch(/diet|vegan|vegetarian|allergen|nutri|protein|dish|price|phone|email/);
    await tx(async (c) => {
      expect((await err(c, "insert into public.place_listings (candidate_id, slug, name, street, postcode, lat, lon, category, identity_status, sources, built_from, menu_status) values (gen_random_uuid(), 'x-1', 'X', '1 A St', '02116', 42.35, -71.07, 'Restaurant', 'corroborated', '[{}]', 't', 'checked')")).code).toBe("23514");
    });
  });

  it("the founder sees preview listings; guests, members and curators see nothing", () =>
    tx(async (c) => {
      const founder = await user(c, "publisher");
      const curator = await user(c, "curator");
      const member = await user(c);
      const id = await addListing(c);
      const f = await dir(c, founder);
      expect(f.preview).toBe(true);
      expect(f.items.map((i: J) => i.id)).toContain(id);
      const item = f.items.find((i: J) => i.id === id);
      expect(item).toMatchObject({ menuStatus: "not_checked", identityStatus: "corroborated", visibility: "preview", sources: [{ title: "Test source", attribution: "Test attribution" }] });
      expect(Object.keys(item).join(" ")).not.toMatch(/diet|vegan|protein|eligib/i);
      for (const who of [null, member, curator]) {
        const d = await dir(c, who);
        expect(d.preview).toBe(false);
        expect(d.items.map((i: J) => i.id)).not.toContain(id);
      }
      // The founder without asking for the preview sees only public listings.
      expect((await dir(c, founder, { q: "Test Place Lantern" })).items.map((i: J) => i.id)).not.toContain(id);
    }));

  it("withdrawn listings are not shown to anyone", () =>
    tx(async (c) => {
      const founder = await user(c, "publisher");
      const id = await addListing(c, { visibility: "withdrawn" });
      expect((await dir(c, founder)).items.map((i: J) => i.id)).not.toContain(id);
    }));

  it("making a listing public is refused while the lock is off, and for an unverified place even with it on", () =>
    tx(async (c) => {
      const id = await addListing(c);
      expect(await c.query("select enabled from app.platform_switches where name = 'real_place_listings'").then((r) => r.rows[0].enabled)).toBe(false);
      expect((await err(c, "update public.place_listings set visibility = 'public', identity_status = 'verified' where id = $1", [id])).message).toMatch(/locked/);
      await c.query("update app.platform_switches set enabled = true where name = 'real_place_listings'");
      expect((await err(c, "update public.place_listings set visibility = 'public' where id = $1", [id])).message).toMatch(/founder-verified/);
      // Only with both (here inside a rolled-back transaction) does a guest see it.
      await c.query("update public.place_listings set visibility = 'public', identity_status = 'verified' where id = $1", [id]);
      expect((await dir(c, null, { q: "Test Place Lantern" })).items.map((i: J) => i.id)).toContain(id);
    }));

  it("no guest, member or founder can turn the lock on or write listings", () =>
    tx(async (c) => {
      const founder = await user(c, "publisher");
      for (const who of [null, founder]) {
        await c.query("savepoint s");
        const e = await as(c, who, "update app.platform_switches set enabled = true where name = 'real_place_listings'").then(() => null, (x: { code: string }) => x.code);
        await c.query("rollback to savepoint s");
        expect(e).toBe("42501");
        await c.query("savepoint s");
        const w = await as(c, who, "insert into public.place_listings (candidate_id) values (gen_random_uuid())").then(() => null, (x: { code: string }) => x.code);
        await c.query("rollback to savepoint s");
        expect(w).toBe("42501");
      }
    }));

  it("only the directory, place pages, the place link and the founder's reviews read the listings: no dish search, filter, Protein Explorer, diary or map function refers to them", async () => {
    const fns = await pool.query("select n.nspname || '.' || p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'app') and p.prosrc ilike '%place_listings%' order by 1");
    // The founder's identity review (docs/33) reads a listing's status and records identity decisions on it; it is identity only.
    // Batch review (docs/35) names the real_place_listings switch in two functions; place pages and reports
    // (docs/36) read one listing at a time. The place link (docs/49) reads a listing's identity and visibility so
    // saves, reviews, lists and rankings follow it. None of them reads dishes. The founder-only preview index
    // (docs/59) names the linked listing of each researched place, for the founder only, and returns no menu facts.
    expect(fns.rows.map((r: J) => r.fn)).toEqual([
      "app.guard_place_listing",
      "app.listing_may_be_public",
      "app.log_place_switch", // names the real_place_listings switch; reads no listing
      "app.preview_meal_ok", // docs/60: may the founder list or review this real meal? Not callable by visitors or members
      "app.ranking_entries_json",
      "app.social_target",
      "app.visible_listing_for_venue",
      "public.batch_review_summary",
      "public.community_queue", // 20261124000300: founder-only; names the place a member's suggestion is about, no menu facts
      "public.community_submit", // 20261124000300: checks a suggestion's place exists; stores only its id
      "public.identity_review_item",
      "public.log_real_meal", // docs/63: founder-only; names the restaurant of a logged real meal for its private source record
      "public.member_beta_index", // 20261122000600: the staged local member beta's index; BETA_OFF unless the switch is on, enrolled places only
      "public.menu_preview_index",
      "public.menu_preview_waiting", // 20261122000700: founder-only; names linked restaurants still waiting for the identity check
      "public.my_saves",
      "public.place_detail",
      "public.place_directory",
      "public.place_link_venue",
      "public.place_reports_queue",
      "public.place_venue",
      "public.record_identity_review",
      "public.report_place_problem",
    ]);
    const views = await pool.query("select viewname from pg_views where definition ilike '%place_listings%'");
    expect(views.rows).toEqual([]);
  });

  it("listings never enter dish search or its counts", () =>
    tx(async (c) => {
      const before = (await as(c, null, "select public.search_catalog('{\"q\":\"Lantern\"}'::jsonb) r"))[0].r;
      await addListing(c);
      const after = (await as(c, null, "select public.search_catalog('{\"q\":\"Lantern\"}'::jsonb) r"))[0].r;
      expect(after.counts).toEqual(before.counts);
    }));
});

describe("identity decisions and samples are the founder's, and permanent", () => {
  async function candidate(c: PoolClient, o: J = {}) {
    const run = (await c.query("insert into catalog_import.import_runs (source_key, release, file_sha256, retrieved_at, thresholds, status) values ('boston_food_licenses', 'test', $1, now(), '{}', 'completed') returning id", ["0".repeat(64)])).rows[0].id;
    const cand = (await c.query("insert into catalog_import.place_candidates (name, street, postcode, lat, lon, category, quality, created_run) values ($1, '1 Sample St', '02116', 42.35, -71.07, 'restaurant', $2, $3) returning id", [o.name ?? "Test Place Lantern", o.quality ?? "corroborated", run])).rows[0].id;
    for (const [k, n] of [["overture_places", o.name ?? "Test Place Lantern"], ["boston_food_licenses", (o.name ?? "Test Place Lantern").toUpperCase()]]) {
      const rec = (await c.query(
        "insert into catalog_import.source_records (source_key, external_id, name, street, postcode, lat, lon, category, record_licence, record_hash, first_run, last_run) values ($1, $2, $3, '1 Sample St', '02116', 42.35, -71.07, 'restaurant', 'test', $4, $5, $5) returning id",
        [k, randomUUID(), n, "0".repeat(64), run])).rows[0].id;
      await c.query("insert into catalog_import.candidate_links (candidate_id, record_id, match_score, match_method) values ($1, $2, 1, 'seed')", [cand, rec]);
    }
    return cand as string;
  }

  it("only the publisher records a decision; decisions cannot be changed or removed", () =>
    tx(async (c) => {
      const cand = await candidate(c);
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      expect((await err(c, "insert into catalog_import.identity_decisions (candidate_id, decision, decided_by) values ($1, 'verify_identity', $2)", [cand, curator])).code).toBe("PT403");
      await c.query("insert into catalog_import.identity_decisions (candidate_id, decision, decided_by) values ($1, 'verify_identity', $2)", [cand, founder]);
      expect((await err(c, "update catalog_import.identity_decisions set decision = 'reject' where candidate_id = $1", [cand])).code).toBe("PT403");
      expect((await err(c, "delete from catalog_import.identity_decisions where candidate_id = $1", [cand])).code).toBe("PT403");
    }));

  it("assess and build: corroborated places enter the preview as 'corroborated', founder-verified as 'verified', look-alikes and rejected places stay out", () =>
    tx(async (c) => {
      // Set any real local import aside inside this transaction.
      await c.query("update catalog_import.place_candidates set quality = 'rejected'");
      const ok = await candidate(c, { name: "Test Place Alpha" });
      const verified = await candidate(c, { name: "Test Place Bravo" });
      const school = await candidate(c, { name: "Test Elementary School Cafeteria" });
      const single = await candidate(c, { name: "Test Place Charlie", quality: "single_source" });
      const rejected = await candidate(c, { name: "Test Place Delta" });
      const founder = await user(c, "publisher");
      await c.query("insert into catalog_import.identity_decisions (candidate_id, decision, decided_by) values ($1, 'verify_identity', $3), ($2, 'reject', $3)", [verified, rejected, founder]);

      const a = await assess(c, { ownTransaction: false });
      expect(a.preview).toBe(2);
      const tiers = new Map((await c.query("select id, preview_tier, preview_reasons from catalog_import.place_candidates where id = any($1::uuid[])", [[ok, verified, school, single, rejected]])).rows.map((r: J) => [r.id, r]));
      expect(tiers.get(school)).toMatchObject({ preview_tier: "exception", preview_reasons: ["possibly_not_public"] });
      expect(tiers.get(single)!.preview_tier).toBe("exception");
      expect(tiers.get(rejected)!.preview_tier).toBe("excluded");

      const b = await build(c, { ownTransaction: false });
      expect(b.preview).toBe(2);
      // One source and nothing else in doubt: a private directory listing marked single_source (owner decision 24 Nov
      // 2026 17:59 UTC, Option A), which the database refuses to make public.
      expect(b.singleSource).toBe(1);
      const rows = (await c.query("select candidate_id, identity_status, visibility, menu_status, sources from public.place_listings where candidate_id = any($1::uuid[]) order by name", [[ok, verified, school, single, rejected]])).rows;
      expect(rows.map((r: J) => [r.candidate_id, r.identity_status, r.visibility, r.menu_status])).toEqual([
        [ok, "corroborated", "preview", "not_checked"],
        [verified, "verified", "preview", "not_checked"],
        [single, "single_source", "preview", "not_checked"],
      ]);
      // Refused twice over: by the publication guard, and (with every trigger set aside) by the table's own check.
      expect((await err(c, "update public.place_listings set visibility = 'public' where candidate_id = $1", [single])).code).toBe("PT403");
      await c.query("set local session_replication_role = replica");
      expect((await err(c, "update public.place_listings set visibility = 'public' where candidate_id = $1", [single])).code).toBe("23514");
      await c.query("set local session_replication_role = origin");
      expect(rows[0].sources.map((s: J) => s.key)).toEqual(["boston_food_licenses", "overture_places"]);

      // The founder later rejects a place: the next build withdraws it, never deletes it.
      await c.query("insert into catalog_import.identity_decisions (candidate_id, decision, decided_by) values ($1, 'reject', $2)", [ok, founder]);
      await assess(c, { ownTransaction: false });
      const again = await build(c, { ownTransaction: false });
      expect(again.withdrawn).toBeGreaterThanOrEqual(1);
      expect((await c.query("select visibility from public.place_listings where candidate_id = $1", [ok])).rows[0].visibility).toBe("withdrawn");
    }));

  it("a sample result is recorded once, by the founder", () =>
    tx(async (c) => {
      await c.query("update catalog_import.place_candidates set quality = 'rejected'");
      const cand = await candidate(c, { name: "Test Place Echo" });
      await assess(c, { ownTransaction: false });
      const s = await sample(c, { size: 5, seed: "test", ownTransaction: false });
      expect(s.picked).toBe(1);
      expect(s.sheet).toContain("Test Place Echo");
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const set = "update catalog_import.identity_sample_items set outcome = $3, checked_by = $4, checked_at = now() where sample_id = $1 and candidate_id = $2";
      expect((await err(c, set, [s.id, cand, "correct", curator])).code).toBe("PT403");
      await c.query(set, [s.id, cand, "correct", founder]);
      expect((await err(c, set, [s.id, cand, "closed", founder])).code).toBe("PT403");
    }));

  it("drawing the same sample again reuses it, keeps its results, and a wrong count is refused", () =>
    tx(async (c) => {
      await c.query("update catalog_import.place_candidates set quality = 'rejected'");
      const cand = await candidate(c, { name: "Test Place Foxtrot" });
      await assess(c, { ownTransaction: false });
      const first = await sample(c, { size: 5, seed: "test-reuse", ownTransaction: false });
      const founder = await user(c, "publisher");
      await c.query("update catalog_import.identity_sample_items set outcome = 'correct', checked_by = $3, checked_at = now() where sample_id = $1 and candidate_id = $2", [first.id, cand, founder]);
      const again = await sample(c, { size: 5, seed: "test-reuse", expect: 1, ownTransaction: false });
      expect(again).toMatchObject({ id: first.id, reused: true, fingerprint: first.fingerprint });
      expect((await c.query("select count(*)::int n from catalog_import.identity_samples where seed = 'test-reuse'")).rows[0].n).toBe(1);
      expect((await c.query("select outcome from catalog_import.identity_sample_items where sample_id = $1", [first.id])).rows[0].outcome).toBe("correct");
      await c.query("savepoint s");
      await expect(sample(c, { size: 5, seed: "test-other", expect: 2, ownTransaction: false })).rejects.toThrow(/not the expected 2/);
      await c.query("rollback to savepoint s");
      expect((await c.query("select count(*)::int n from catalog_import.identity_samples where seed = 'test-other'")).rows[0].n).toBe(0);
    }));
});
