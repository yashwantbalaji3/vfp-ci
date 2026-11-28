import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool, clearTestHosts } from "../helpers/db";
import { linkMatches, suggestions } from "../../scripts/menu-link.mjs";

// Researched profiles tied to real catalog places (migration 20261117000800, docs/40). Each test runs
// inside ONE rolled-back transaction. Labels, names and addresses are invented, never real restaurants.

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
const one = async (c: PoolClient, sql: string, params: unknown[] = []) => (await c.query(`select ${sql} as r`, params)).rows[0].r;
async function user(c: PoolClient, role?: string) {
  const id = randomUUID();
  await c.query(
    `insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}', '{}', now(), now())`,
    [id, `links-${id.slice(0, 8)}@example.test`],
  );
  if (role) await c.query("insert into public.role_assignments (user_id, role) values ($1, $2)", [id, role]);
  return id;
}
async function as(c: PoolClient, uid: string | null, sql: string, params: unknown[] = []) {
  await c.query(`set local role ${uid ? "authenticated" : "anon"}`);
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(uid ? { sub: uid, role: "authenticated" } : { role: "anon" })]);
  const rows = (await c.query(sql, params)).rows;
  await c.query("reset role");
  return rows;
}

/** A staged profile with an address fact, plus one dish with a dietary statement and a protein figure. */
async function profile(c: PoolClient, me: string, street = "12 Linkable St", postcode = "02116") {
  await clearTestHosts(c);
  const place = await one(c, "staging.add_place($1, $2, 'back_bay', 2::smallint)", [me, `Links test ${randomUUID().slice(0, 6)}`]);
  const site = await one(c, "staging.add_source_page($1, $2, 'restaurant_site', 'Links Test Kitchen', now(), 'Facts only')", [me, `https://example.test/${randomUUID()}`]);
  const today = (await c.query("select (now() at time zone 'America/New_York')::date::text as d")).rows[0].d as string;
  const dish = await one(c, "staging.add_dish($1, $2, 'Secret Lentil Bowl')", [me, place]);
  for (const f of [
    { kind: "address", value: { street, postcode } },
    { kind: "dietary_status", dishId: dish, subject: "vegan", value: { claim: "vegan", status: "yes", label: "VGN-SECRET-LABEL" } },
    { kind: "published_nutrition", dishId: dish, subject: "protein_g", value: { nutrient: "protein_g", amount: "23", per: "serving" } },
  ]) await one(c, "staging.submit_fact($1, $2::jsonb)", [me, JSON.stringify({ placeId: place, sourcePageId: site, checkedOn: today, ...f })]);
  return place as string;
}
async function candidate(c: PoolClient, street = "12 Linkable St", postcode = "02116") {
  const run = (await c.query("insert into catalog_import.import_runs (source_key, release, file_sha256, retrieved_at, thresholds, status) values ('boston_food_licenses', 'test', $1, now(), '{}', 'completed') returning id", ["0".repeat(64)])).rows[0].id;
  return (await c.query("insert into catalog_import.place_candidates (name, street, postcode, lat, lon, category, quality, created_run) values ('Links Test Kitchen', $1, $2, 42.35, -71.07, 'restaurant', 'corroborated', $3) returning id", [street, postcode, run])).rows[0].id as string;
}
async function listing(c: PoolClient, cand: string) {
  const slug = `links-test-${randomUUID().slice(0, 8)}`;
  await c.query(
    `insert into public.place_listings (candidate_id, slug, name, street, locality, postcode, area, lat, lon, category, identity_status, sources, built_from)
     values ($1, $2, 'Links Test Kitchen', '12 Linkable St', 'Boston', '02116', 'Back Bay / Prudential', 42.35, -71.07, 'Restaurant', 'corroborated', '[{"key":"overture_places","title":"Test"}]', 'test')`,
    [cand, slug]);
  return slug;
}

afterAll(async () => {
  await pool.end();
});

describe("links are private, permanent and only by address or by the founder", () => {
  it("the table is closed to guests and members, with RLS on", async () => {
    for (const role of ["anon", "authenticated"]) {
      const p = await pool.query("select has_table_privilege($1, 'staging.catalog_links', 'select') s, has_schema_privilege($1, 'staging', 'usage') u", [role]);
      expect(p.rows[0]).toEqual({ s: false, u: false });
    }
    expect((await pool.query("select relrowsecurity, relforcerowsecurity from pg_class where oid = 'staging.catalog_links'::regclass")).rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("a curator links by matching address; a mismatch, a plain member or a second link is refused", () =>
    tx(async (c) => {
      const cur = await user(c, "curator");
      const place = await profile(c, cur);
      const same = await candidate(c);
      const other = await candidate(c, "14 Linkable St");
      const otherStreet = await candidate(c, "12 Different St");
      expect((await err(c, "select staging.link_catalog($1, $2, $3, 'address_match')", [cur, place, other])).message).toBe("ADDRESS_MISMATCH");
      expect((await err(c, "select staging.link_catalog($1, $2, $3, 'address_match')", [cur, place, otherStreet])).message).toBe("ADDRESS_MISMATCH");
      expect(await one(c, "staging.address_key('254 Newbury', '02116') = staging.address_key('254 Newbury St', '02116-3301')")).toBe(true);
      expect(await one(c, "staging.address_key('No number St', '02116')")).toBeNull();
      // Same address, different business (a food court or office tower): refused.
      const run = (await c.query("select created_run from catalog_import.place_candidates where id = $1", [same])).rows[0].created_run;
      const diner = (await c.query("insert into catalog_import.place_candidates (name, street, postcode, lat, lon, category, quality, created_run) values ('Other Diner', '12 Linkable St', '02116', 42.35, -71.07, 'restaurant', 'corroborated', $1) returning id", [run])).rows[0].id;
      expect((await err(c, "select staging.link_catalog($1, $2, $3, 'address_match')", [cur, place, diner])).message).toBe("NAME_MISMATCH");
      expect(await one(c, "staging.names_share_word('Tatte Bakery & Cafe (Summer Street)', 'CAVA')")).toBe(false);
      expect(await one(c, "staging.names_share_word('Tatte Bakery & Cafe (Back Bay)', 'Flour Bakery and Cafe')")).toBe(false);
      expect(await one(c, "staging.names_share_word('Chipotle (Financial District)', 'Chipotle Mexican Grill')")).toBe(true);
      expect((await err(c, "select staging.link_catalog($1, $2, $3, 'address_match')", [await user(c), place, same])).code).toBe("PT403");
      await c.query("select staging.link_catalog($1, $2, $3, 'address_match')", [cur, place, same]);
      expect((await err(c, "select staging.link_catalog($1, $2, $3, 'address_match')", [cur, place, same])).message).toBe("PROFILE_ALREADY_LINKED");
      const second = await profile(c, cur);
      expect((await err(c, "select staging.link_catalog($1, $2, $3, 'address_match')", [cur, second, same])).message).toBe("PLACE_ALREADY_LINKED");
      const row = (await c.query("select method, evidence from staging.catalog_links where staging_place = $1", [place])).rows[0];
      expect(row.method).toBe("address_match");
      expect(row.evidence).toMatchObject({ stagedStreet: "12 Linkable St", candidateStreet: "12 Linkable St" });
    }));

  it("only the founder links by judgement, with a note; links are never changed or removed, unlinking adds a row", () =>
    tx(async (c) => {
      const cur = await user(c, "curator");
      const founder = await user(c, "publisher");
      const place = await profile(c, cur);
      const elsewhere = await candidate(c, "99 Other Rd", "02118");
      expect((await err(c, "select staging.link_catalog($1, $2, $3, 'person', 'same owner told us')", [cur, place, elsewhere])).code).toBe("PT403");
      expect((await err(c, "select staging.link_catalog($1, $2, $3, 'person')", [founder, place, elsewhere])).message).toBe("LINK_NOTE_REQUIRED");
      await c.query("select staging.link_catalog($1, $2, $3, 'person', 'Moved: the new address is on its own site')", [founder, place, elsewhere]);
      expect((await err(c, "update staging.catalog_links set note = 'x' where staging_place = $1", [place])).code).toBe("P0001");
      expect((await err(c, "delete from staging.catalog_links where staging_place = $1", [place])).code).toBe("P0001");
      expect((await err(c, "select staging.unlink_catalog($1, $2, 'wrong place')", [cur, place])).code).toBe("PT403");
      await c.query("select staging.unlink_catalog($1, $2, 'Wrong place after all')", [founder, place]);
      expect((await c.query("select count(*)::int n from staging.live_catalog_links where staging_place = $1", [place])).rows[0].n).toBe(0);
      expect((await c.query("select array_agg(action order by id) a from staging.catalog_links where staging_place = $1", [place])).rows[0].a).toEqual(["link", "unlink"]);
      expect((await c.query("select array_agg(action order by id) a from staging.events where place_id = $1 and action like '%catalog'", [place])).rows[0].a).toEqual(["link_catalog", "unlink_catalog"]);
    }));
});

describe("a link reaches no visitor", () => {
  it("no public or app function or view reads links, and linking changes nothing a visitor reads", () =>
    tx(async (c) => {
      const fns = await c.query("select n.nspname || '.' || p.proname fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'app') and (p.prosrc ilike '%catalog_links%' or p.prosrc ilike '%live_catalog%')");
      // The one exception is the founder-only preview index (docs/59); it refuses everyone but the founder
      // first (checked in pilot-staging.test.ts) and returns no menu facts.
      // docs/60 adds app.preview_meal_ok, which no visitor or member can call (checked in pilot-staging.test.ts):
      // it only answers whether a founder may list or review a dish.
      // docs/63 adds public.log_real_meal: founder-only (checked in pilot-staging.test.ts); it reads the link only to name
      // the restaurant in the founder's own private source record.
      // 20261123000200 adds public.tester_meal_queue: founder-only (app.require_founder first, checked in
      // pilot-staging.test.ts); it lists meals at linked restaurants with their checks for the founder's review.
      // 20261124000800: public.place_directory checks enrolment through links only to skip rows app.place_visible
      // would refuse; it returns listing fields only (the visitor results are checked below and in docs/87).
      expect(fns.rows.map((r: { fn: string }) => r.fn).sort()).toEqual(["app.preview_meal_ok", "public.community_submit", "public.log_real_meal", "public.member_beta_index", "public.menu_preview_index", "public.menu_preview_waiting", "public.place_directory", "public.tester_meal_queue"]);
      const views = await c.query("select schemaname || '.' || viewname v from pg_views where schemaname <> 'staging' and definition ilike '%catalog_links%'");
      expect(views.rows).toEqual([]);
      const cur = await user(c, "curator");
      const place = await profile(c, cur);
      const cand = await candidate(c);
      const slug = await listing(c, cand);
      const before = (await as(c, await user(c, "publisher"), "select public.place_detail($1, true) d", [slug]))[0].d;
      await c.query("select staging.link_catalog($1, $2, $3, 'address_match')", [cur, place, cand]);
      const after = (await as(c, await user(c, "publisher"), "select public.place_detail($1, true) d", [slug]))[0].d as J;
      expect({ ...after, updatedAt: null }).toEqual({ ...before, updatedAt: null });
      expect(JSON.stringify(after)).not.toMatch(/VGN-SECRET-LABEL|Secret Lentil/);
      expect((await c.query("select menu_status, visibility from public.place_listings where slug = $1", [slug])).rows[0]).toEqual({ menu_status: "not_checked", visibility: "preview" });
    }));
});

describe("menu-link script", () => {
  it("suggests by address; link-matches is a dry run until confirmed and leaves ambiguous profiles to a person", () =>
    tx(async (c) => {
      const cur = await user(c, "curator");
      const single = await profile(c, cur, "31 Onlyone Ave", "02115");
      const twin = await profile(c, cur, "40 Twin Way", "02118");
      const nothing = await profile(c, cur, "77 Nowhere Pl", "02110");
      const target = await candidate(c, "31 Onlyone Ave", "02115");
      await candidate(c, "40 Twin Way", "02118");
      await candidate(c, "40 Twin Way", "02118");
      const s = await suggestions(c);
      expect(s.find((x: J) => x.profile_id === single).matches.map((m: J) => m.id)).toEqual([target]);

      const dry = await linkMatches(c, { actor: cur, dryRun: true, ownTransaction: false });
      expect(dry.linked.map((l: J) => l.label)).toContain(s.find((x: J) => x.profile_id === single).label);
      expect((await c.query("select count(*)::int n from staging.catalog_links where staging_place = any($1::uuid[])", [[single, twin, nothing]])).rows[0].n).toBe(0);

      const done = await linkMatches(c, { actor: cur, dryRun: false, ownTransaction: false });
      const why = Object.fromEntries(done.skipped.map((x: J) => [x.label, x.why]));
      expect(why[s.find((x: J) => x.profile_id === twin).label]).toBe("2 catalog places with a matching name at this address");
      expect(why[s.find((x: J) => x.profile_id === nothing).label]).toBe("no catalog place at this address");
      expect((await c.query("select candidate_id from staging.live_catalog_links where staging_place = $1", [single])).rows[0].candidate_id).toBe(target);
    }));
});
