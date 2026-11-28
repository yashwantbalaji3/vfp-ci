import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../helpers/db";

// Activation readiness item 2 (Yash 17 Nov 05:44 UTC): a real place's identity is never shown as
// individually checked unless the founder checked it, and a place whose menu is unknown never enters a
// strict vegetarian, vegan or protein result. Every test runs in one transaction that is rolled back.
// The places below are invented (synthetic names and addresses), never real restaurants.

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
async function member(c: PoolClient) {
  const id = randomUUID();
  await c.query(
    "insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}', '{}', now(), now())",
    [id, `trust-${id.slice(0, 8)}@example.test`],
  );
  return id;
}
async function as(c: PoolClient, uid: string | null, sql: string, params: unknown[] = []) {
  await c.query(`set local role ${uid ? "authenticated" : "anon"}`);
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(uid ? { sub: uid, role: "authenticated" } : { role: "anon" })]);
  const rows = (await c.query(sql, params)).rows;
  await c.query("reset role");
  return rows;
}
const NAME = "Test Vegan Tofu Protein Lantern";
async function addListing(c: PoolClient, o: J = {}) {
  const l: J = {
    candidate_id: randomUUID(), slug: `test-vegan-${randomUUID().slice(0, 8)}`, name: NAME, street: "1 Sample St", locality: "Boston",
    postcode: "02116", area: "Back Bay / Prudential", lat: 42.35, lon: -71.07, category: "Restaurant", identity_status: "corroborated",
    sources: JSON.stringify([{ key: "overture_places", title: "Test source", attribution: "Test attribution" }]), built_from: "test", ...o,
  };
  const cols = Object.keys(l);
  const r = await c.query(`insert into public.place_listings (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id, slug`, Object.values(l));
  return r.rows[0] as { id: string; slug: string };
}

afterAll(async () => {
  await pool.end();
});

describe("unknown menus never qualify for strict diet or protein results", () => {
  const strict = [
    { q: "Lantern", diet: "vegetarian" },
    { q: "Lantern", diet: "vegan" },
    { q: "Lantern", minProtein: 10 },
    { q: "Lantern", diet: "vegan", minProtein: 10, sort: "protein" },
    { q: "Tofu", diet: "vegan" },
    { diet: "vegan" },
    { minProtein: 20, sort: "protein" },
  ];
  it("even a founder-verified, public listing with a vegan-sounding name is in no dish search or map result", () =>
    tx(async (c) => {
      // The most permissive state possible: switch on, identity verified, listing public.
      await c.query("update app.platform_switches set enabled = true where name = 'real_place_listings'");
      await addListing(c, { identity_status: "verified", visibility: "public" });
      await addListing(c); // and a corroborated preview one
      const uid = await member(c);
      for (const who of [null, uid]) {
        for (const p of strict) {
          for (const fn of ["search_catalog", "search_map"]) {
            const r = (await as(c, who, `select public.${fn}($1::jsonb) r`, [JSON.stringify(p)]))[0].r;
            expect(JSON.stringify(r), `${fn} ${JSON.stringify(p)}`).not.toContain("Lantern");
          }
        }
      }
    }));

  it("place listings hold no dietary, dish or protein data, and menu status can only be 'not checked'", async () => {
    const cols = (await pool.query("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'place_listings'")).rows.map((r: J) => r.column_name);
    expect(cols.join(" ")).not.toMatch(/diet|vegan|vegetarian|protein|dish|food_item|nutri|allergen/);
    const chk = (await pool.query("select pg_get_constraintdef(oid) d from pg_constraint where conrelid = 'public.place_listings'::regclass and pg_get_constraintdef(oid) ilike '%menu_status%'")).rows.map((r: J) => r.d).join(" ");
    expect(chk).toMatch(/not_checked/);
    expect(chk).not.toMatch(/'checked'/);
  });

  it("a listing's category can never carry a dietary word", () =>
    tx(async (c) => {
      for (const category of ["Vegan restaurant", "Vegetarian", "Plant-based café"]) {
        await c.query("savepoint s");
        await expect(addListing(c, { category })).rejects.toMatchObject({ code: "23514" });
        await c.query("rollback to savepoint s");
      }
    }));

  it("no strict-filter or protein function reads place listings", async () => {
    for (const fn of ["search_catalog", "search_map", "protein_compare", "protein_explanation"]) {
      const src = (await pool.query("select string_agg(prosrc, ' ') s from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1", [fn])).rows[0].s as string;
      expect(src, fn).toBeTruthy();
      expect(src, fn).not.toMatch(/place_listings/);
    }
  });
});

describe("corroborated identities are never presented as individually checked", () => {
  it("only a founder-verified listing gets the 'verified' basis", async () => {
    const r = (await pool.query(
      "select app.identity_basis('corroborated', null) a, app.identity_basis('corroborated', gen_random_uuid()) b, app.identity_basis('verified', null) v",
    )).rows[0];
    expect(r).toEqual({ a: "corroborated", b: "corroborated", v: "verified" });
  });

  it("the directory, map and place page say 'corroborated' for a corroborated listing in the private preview", () =>
    tx(async (c) => {
      const l = await addListing(c);
      const uid = await member(c);
      await c.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher')", [uid]);
      const dir = (await as(c, uid, "select public.place_directory($1::jsonb) d", [JSON.stringify({ preview: true, q: "Lantern" })]))[0].d as J;
      const map = (await as(c, uid, "select public.place_directory($1::jsonb) d", [JSON.stringify({ preview: true, mode: "map", q: "Lantern" })]))[0].d as J;
      const page = (await as(c, uid, "select public.place_detail($1, true) d", [l.slug]))[0].d as J;
      for (const [what, blob] of [["directory", dir], ["map", map], ["page", page]] as const) {
        const s = JSON.stringify(blob);
        expect(s, what).toContain("Lantern");
        expect(s, what).not.toMatch(/"identityBasis":"(verified|batch_sampled)"/);
        expect(s, what).toMatch(/"identityBasis":"corroborated"/);
      }
    }));
});
