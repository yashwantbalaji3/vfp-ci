import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../helpers/db";
import { assess, build, cuisineStatus, refreshCuisines } from "../../scripts/catalog-preview.mjs";
import { loadTaxonomy } from "../../scripts/catalog-import.mjs";

// Cuisine of real places from Overture Maps' own categories (CAT-CUISINE, docs/49). Every test runs inside one
// transaction that is rolled back. Places below are invented (synthetic names and addresses), never real restaurants.

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
async function user(c: PoolClient, role?: string) {
  const id = randomUUID();
  await c.query(
    "insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}', '{}', now(), now())",
    [id, `cuisine-${id.slice(0, 8)}@example.test`],
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
const dir = async (c: PoolClient, uid: string, p: J) => (await as(c, uid, "select public.place_directory($1::jsonb) d", [JSON.stringify({ preview: true, ...p })]))[0].d as J;
const SRC = JSON.stringify([{ key: "overture_places", title: "Test source", attribution: "Test attribution", release: "r1" }]);
async function listing(c: PoolClient, name: string, cuisines: J[]) {
  const slug = `cuisine-place-${randomUUID().slice(0, 8)}`;
  await c.query(
    `insert into public.place_listings (candidate_id, slug, name, street, locality, postcode, area, lat, lon, category, identity_status, sources, built_from, visibility, cuisines)
     values (gen_random_uuid(), $1, $2, '3 Sample Row', 'Boston', '02116', 'Back Bay / Prudential', 42.35, -71.07, 'Restaurant', 'corroborated', $3, 'test', 'preview', $4)`,
    [slug, name, SRC, JSON.stringify(cuisines)]);
  return slug;
}

afterAll(async () => {
  await pool.end();
});

describe("cuisine filter and counts", () => {
  it("filters on Overture's main category; 'possibly' only when asked; counts never include 'possibly'", async () => {
    await tx(async (c) => {
      const founder = await user(c, "publisher");
      const t = randomUUID().slice(0, 8);
      await listing(c, `Cuisine Wren ${t} A`, [{ cuisine: "Thai", basis: "dataset_primary", category: "thai_restaurant" }]);
      await listing(c, `Cuisine Wren ${t} B`, [{ cuisine: "Thai", basis: "dataset_alternate", category: "thai_restaurant" }]);
      await listing(c, `Cuisine Wren ${t} C`, []);
      const sure = await dir(c, founder, { q: `Wren ${t}`, cuisine: "Thai" });
      expect(sure.items.map((i: J) => i.name)).toEqual([`Cuisine Wren ${t} A`]);
      expect(sure.items[0].cuisines).toEqual([{ cuisine: "Thai", basis: "dataset_primary" }]);
      const maybe = await dir(c, founder, { q: `Wren ${t}`, cuisine: "Thai", possible: true });
      expect(maybe.items.map((i: J) => i.name).sort()).toEqual([`Cuisine Wren ${t} A`, `Cuisine Wren ${t} B`]);
      const all = await dir(c, founder, { q: `Wren ${t}` });
      expect(all.total).toBe(3);
      const thai = all.cuisines.find((x: J) => x.cuisine === "Thai");
      const sourced = (await c.query(`select count(*)::int n from public.place_listings where visibility = 'preview' and cuisines @> '[{"cuisine": "Thai", "basis": "dataset_primary"}]'`)).rows[0].n;
      expect(thai.count).toBe(sourced); // B ("possibly Thai") is not counted
      // Map items keep their minimal fields.
      const map = await dir(c, founder, { q: `Wren ${t}`, mode: "map" });
      expect(Object.keys(map.items[0])).not.toContain("cuisines");
    });
  });

  it("the place page gets the cuisine with its Overture category", async () => {
    await tx(async (c) => {
      const founder = await user(c, "publisher");
      const slug = await listing(c, "Cuisine Wren Detail", [{ cuisine: "Ethiopian", basis: "dataset_primary", category: "ethiopian_restaurant" }]);
      const d = (await as(c, founder, "select public.place_detail($1, true) d", [slug]))[0].d as J;
      expect(d.cuisines).toEqual([{ cuisine: "Ethiopian", basis: "dataset_primary", category: "ethiopian_restaurant" }]);
      expect(d.menuStatus).toBe("not_checked");
    });
  });

  it("refuses an over-long cuisine and keeps the taxonomy table closed", async () => {
    await tx(async (c) => {
      const founder = await user(c, "publisher");
      await c.query("savepoint s");
      await expect(as(c, founder, "select public.place_directory($1::jsonb)", [JSON.stringify({ preview: true, cuisine: "x".repeat(41) })])).rejects.toThrow(/QUERY_TOO_LONG/);
      await c.query("rollback to savepoint s");
      for (const role of ["anon", "authenticated"]) {
        expect((await pool.query("select has_table_privilege($1, 'catalog_import.overture_taxonomy', 'select') s", [role])).rows[0].s).toBe(false);
      }
    });
  });
});

describe("the build writes cuisine from the loaded taxonomy only", () => {
  it("primary → sourced, generic → none, diet word → none; nothing else on the listing changes meaning", async () => {
    await tx(async (c) => {
      await c.query("update catalog_import.place_candidates set quality = 'rejected'");
      const run = (await c.query("insert into catalog_import.import_runs (source_key, release, file_sha256, retrieved_at, thresholds, status) values ('overture_places', 'test', $1, now(), '{}', 'completed') returning id", ["0".repeat(64)])).rows[0].id;
      const made: Record<string, { cand: string; ext: string }> = {};
      for (const name of ["Cuisine Test Indian", "Cuisine Test Generic", "Cuisine Test Veg"]) {
        const cand = (await c.query("insert into catalog_import.place_candidates (name, street, postcode, lat, lon, category, quality, created_run) values ($1, '5 Sample St', '02116', 42.35, -71.07, 'restaurant', 'corroborated', $2) returning id", [name, run])).rows[0].id;
        const ext = randomUUID();
        for (const [k, id] of [["overture_places", ext], ["boston_food_licenses", randomUUID()]]) {
          const rec = (await c.query(
            "insert into catalog_import.source_records (source_key, external_id, name, street, postcode, lat, lon, category, record_licence, record_hash, first_run, last_run) values ($1, $2, $3, '5 Sample St', '02116', 42.35, -71.07, 'restaurant', 'test', $4, $5, $5) returning id",
            [k, id, name, "0".repeat(64), run])).rows[0].id;
          await c.query("insert into catalog_import.candidate_links (candidate_id, record_id, match_score, match_method) values ($1, $2, 1, 'seed')", [cand, rec]);
        }
        made[name] = { cand, ext };
      }
      const out = await loadTaxonomy(c, [
        { id: made["Cuisine Test Indian"].ext, primary: "indian_restaurant", alternates: "" },
        { id: made["Cuisine Test Generic"].ext, primary: "restaurant", alternates: "" },
        { id: made["Cuisine Test Veg"].ext, primary: "vegetarian_restaurant", alternates: "vegan_restaurant" },
      ], { release: "test", ownTransaction: false });
      expect(out.records).toBe(3);
      await assess(c, { ownTransaction: false });
      await build(c, { ownTransaction: false });
      const rows = new Map((await c.query("select candidate_id, cuisines, menu_status from public.place_listings where candidate_id = any($1::uuid[])", [Object.values(made).map((m) => m.cand)])).rows.map((r: J) => [r.candidate_id, r]));
      expect(rows.get(made["Cuisine Test Indian"].cand)!.cuisines).toEqual([{ cuisine: "Indian", basis: "dataset_primary", category: "indian_restaurant" }]);
      expect(rows.get(made["Cuisine Test Generic"].cand)!.cuisines).toEqual([]);
      expect(rows.get(made["Cuisine Test Veg"].cand)!.cuisines).toEqual([]);
      for (const r of rows.values()) expect(r.menu_status).toBe("not_checked");
    });
  });
});

// The owner's Mac (20 Nov, read-only check): the catalog was imported on 17 Nov, before cuisine data existed; the
// taxonomy table stayed empty and every listing had no cuisine, with nothing saying so (docs/64).
describe("a catalog loaded before cuisine data existed", () => {
  it("is reported, refuses to blank cuisines, and fills them in place once the taxonomy is loaded", async () => {
    await tx(async (c) => {
      const t = randomUUID().slice(0, 8);
      const slug = await listing(c, `Cuisine Heron ${t}`, []);
      const id = (await c.query("select id, candidate_id from public.place_listings where slug = $1", [slug])).rows[0];
      const run = (await c.query("insert into catalog_import.import_runs (source_key, release, file_sha256, retrieved_at, thresholds, status) values ('overture_places', 'test', $1, now(), '{}', 'completed') returning id", ["1".repeat(64)])).rows[0].id;
      const rec = (await c.query(
        `insert into catalog_import.source_records (source_key, external_id, name, street, postcode, lat, lon, category, record_licence, record_hash, first_run, last_run)
         values ('overture_places', $1, 'Cuisine Heron', '3 Sample Row', '02116', 42.35, -71.07, 'greek_restaurant', 'test', $3, $2, $2) returning id`, [`ovt-${t}`, run, "2".repeat(64)])).rows[0];
      await c.query("insert into catalog_import.place_candidates (id, name, lat, lon, quality, created_run) values ($1, 'Cuisine Heron', 42.35, -71.07, 'single_source', $2)", [id.candidate_id, run]);
      await c.query("insert into catalog_import.candidate_links (candidate_id, record_id, match_score, match_method) values ($1, $2, 1, 'seed')", [id.candidate_id, rec.id]);
      const before = (await c.query("select name, visibility, identity_status, sources, slug from public.place_listings where id = $1", [id.id])).rows[0];
      await c.query("delete from catalog_import.overture_taxonomy");
      const missing = await cuisineStatus(c);
      expect(missing.taxonomyRows).toBe(0);
      expect(missing.next).toMatch(/Cuisine data is not loaded/);
      await expect(refreshCuisines(c, { ownTransaction: false })).rejects.toThrow(/Cuisine data is not loaded/);
      await loadTaxonomy(c, [{ id: `ovt-${t}`, primary: "greek_restaurant", alternates: "" }], { release: "test", ownTransaction: false });
      const r = await refreshCuisines(c, { ownTransaction: false });
      expect(r.withCuisine).toBe(1);
      const after = (await c.query("select name, visibility, identity_status, sources, slug, cuisines from public.place_listings where id = $1", [id.id])).rows[0];
      expect(after.cuisines).toEqual([{ cuisine: "Greek", basis: "dataset_primary", category: "greek_restaurant" }]);
      expect({ ...after, cuisines: undefined }).toEqual({ ...before, cuisines: undefined }); // nothing else on the listing changed
      expect((await refreshCuisines(c, { ownTransaction: false })).changed).toBe(0); // running it again changes nothing
    });
  });
});

describe("place-level vegetarian/vegan hints (docs/64)", () => {
  it("come from the closed taxonomy with their basis, are never stored on a listing, and only the founder's index carries them", async () => {
    await tx(async (c) => {
      const t = randomUUID().slice(0, 8);
      const run = (await c.query("insert into catalog_import.import_runs (source_key, release, file_sha256, retrieved_at, thresholds, status) values ('overture_places', 'test', $1, now(), '{}', 'completed') returning id", ["3".repeat(64)])).rows[0].id;
      const cand = (await c.query("insert into catalog_import.place_candidates (name, lat, lon, quality, created_run) values ('Hint Plover', 42.35, -71.07, 'single_source', $1) returning id", [run])).rows[0].id;
      const rec = (await c.query(
        `insert into catalog_import.source_records (source_key, external_id, name, street, postcode, lat, lon, category, record_licence, record_hash, first_run, last_run)
         values ('overture_places', $1, 'Hint Plover', '4 Sample Row', '02116', 42.35, -71.07, 'vegan_restaurant', 'test', $3, $2, $2) returning id`, [`ovt-h-${t}`, run, "4".repeat(64)])).rows[0].id;
      await c.query("insert into catalog_import.candidate_links (candidate_id, record_id, match_score, match_method) values ($1, $2, 1, 'seed')", [cand, rec]);
      await loadTaxonomy(c, [{ id: `ovt-h-${t}`, primary: "vegan_restaurant", alternates: "vegetarian_restaurant|cafe|vegan_restaurant" }], { release: "test", ownTransaction: false });
      const hints = (await c.query("select staging.place_diet_hints($1) h", [cand])).rows[0].h;
      expect(hints).toEqual([
        { hint: "vegan", basis: "dataset_primary", category: "vegan_restaurant" },
        { hint: "vegetarian", basis: "dataset_alternate", category: "vegetarian_restaurant" },
      ]);
      expect((await c.query("select staging.place_diet_hints(gen_random_uuid()) h")).rows[0].h).toEqual([]);
      for (const role of ["anon", "authenticated"]) {
        expect((await pool.query("select has_function_privilege($1, 'staging.place_diet_hints(uuid)', 'execute') s", [role])).rows[0].s).toBe(false);
      }
      const member = await user(c);
      await c.query("savepoint s");
      await expect(as(c, member, "select public.menu_preview_index()")).rejects.toThrow();
      await c.query("rollback to savepoint s");
    });
  });
});

