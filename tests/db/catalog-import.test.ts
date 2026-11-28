import type { PoolClient } from "pg";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../helpers/db";
import { load, match } from "../../scripts/catalog-import.mjs";

// Bulk identity import (docs/31). Every test runs inside one transaction that is rolled back, so
// nothing stays behind. Rows are invented (synthetic names and addresses), never real places.

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const TABLES = ["sources", "import_runs", "source_records", "record_history", "place_candidates", "candidate_links", "identity_decisions", "identity_samples", "identity_sample_items", "overture_taxonomy"];
const dir = mkdtempSync(join(tmpdir(), "catalog-import-"));

async function tx(fn: (c: PoolClient) => Promise<void>) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    // A local database may already hold a real import; set its runs aside inside this transaction
    // so the count-change and absent checks see this test's own runs and records only.
    await c.query("update catalog_import.import_runs set status = 'refused' where status = 'completed'");
    await c.query("update catalog_import.source_records set present = false where present");
    await fn(c);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
  }
}

const HEAD = "businessname,dbaname,licstatus,address,city,zip,property_id,latitude,longitude,descript,dayphn_cleaned";
const row = (i: number, street = `${10 + i} Sample St`) =>
  `Synthetic Holdings ${i} LLC,Test Place ${["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"][i]},Active,${street},BOSTON,02116,${900 + i},${42.35 + i * 0.002},-71.07,Eating & Drinking,6175550199`;
const csv = (name: string, lines: string[]) => {
  const p = join(dir, name);
  writeFileSync(p, [HEAD, ...lines].join("\n") + "\n");
  return p;
};
const opts = { ownTransaction: false, minRows: 1, asOf: new Date("2026-11-17") };
const history = async (c: PoolClient, run: string) =>
  (await c.query("select change, count(*)::int n from catalog_import.record_history where run_id = $1 group by change order by change", [run])).rows.map((r: J) => `${r.change}:${r.n}`);

afterAll(async () => {
  await pool.end();
});

describe("catalog_import schema is private", () => {
  it("is closed to anon and authenticated, with RLS on every table", async () => {
    for (const role of ["anon", "authenticated"]) {
      const s = await pool.query("select has_schema_privilege($1, 'catalog_import', 'usage') u", [role]);
      expect(s.rows[0].u).toBe(false);
      for (const t of TABLES) {
        const p = await pool.query("select has_table_privilege($1, $2, 'select') s, has_table_privilege($1, $2, 'insert') i", [role, `catalog_import.${t}`]);
        expect(p.rows[0]).toEqual({ s: false, i: false });
      }
    }
    const rls = await pool.query("select relname, relrowsecurity from pg_class where relnamespace = 'catalog_import'::regnamespace and relkind = 'r'");
    expect(rls.rows.map((r: J) => r.relname).sort()).toEqual([...TABLES].sort());
    expect(rls.rows.every((r: J) => r.relrowsecurity)).toBe(true);
  });
  it("is not exposed through the Data API", async () => {
    const cfg = await pool.query("select setting from pg_settings where name = 'pgrst.db_schemas'").catch(() => ({ rows: [] as J[] }));
    for (const r of cfg.rows) expect(String(r.setting)).not.toContain("catalog_import");
  });
  it("nothing outside the schema reads it: no function, view or policy refers to it", async () => {
    const fns = await pool.query("select n.nspname || '.' || p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname <> 'catalog_import' and p.prosrc ilike '%catalog_import%'");
    // The exceptions: linking a researched profile checks the candidate's address and name (docs/40), and a
    // restaurant claim names a candidate, and the claim link, the claimant's list and the moderator's views show its name
    // and street (docs/48).
    // Linking by website (docs/59) reads the website a candidate's open-data record names (staging.candidate_hosts).
    // The founder's researched-menu index reads the open map's vegetarian/vegan category as a place-level hint (docs/64).
    // All live in closed schemas (staging, partner) that visitors and members cannot reach either.
    expect(fns.rows.map((r: J) => r.fn).sort()).toEqual(["partner.claim_target", "partner.claims_overview", "partner.create_claim", "partner.moderation_queue", "partner.my_claims", "public.menu_preview_waiting", "staging.candidate_hosts", "staging.link_catalog", "staging.place_diet_hints"]);
    for (const schema of ["staging", "partner"]) {
      expect((await pool.query("select has_schema_privilege('anon', $1, 'usage') a, has_schema_privilege('authenticated', $1, 'usage') b", [schema])).rows[0]).toEqual({ a: false, b: false });
    }
    const views = await pool.query("select schemaname, viewname from pg_views where schemaname <> 'catalog_import' and definition ilike '%catalog_import%'");
    expect(views.rows).toEqual([]);
    const pol = await pool.query("select tablename from pg_policies where schemaname <> 'catalog_import' and (coalesce(qual, '') || coalesce(with_check, '')) ilike '%catalog_import%'");
    expect(pol.rows).toEqual([]);
  });
  it("stores identity only: no menu, dietary, allergen, nutrition or phone column", async () => {
    const cols = await pool.query("select column_name from information_schema.columns where table_schema = 'catalog_import'");
    const names = cols.rows.map((r: J) => r.column_name).join(" ");
    expect(names).not.toMatch(/diet|vegan|vegetarian|allergen|nutri|protein|menu|dish|phone|applicant|email/);
  });
  it("records each source's licence and permitted use", async () => {
    const s = await pool.query("select key, licence, permitted_use from catalog_import.sources order by key");
    expect(s.rows.map((r: J) => r.key)).toEqual(["boston_food_licenses", "cambridge_food_permits", "overture_places"]);
    expect(s.rows.every((r: J) => r.licence && r.permitted_use)).toBe(true);
  });
});

describe("load by market area (docs/84)", () => {
  it("a New York run keeps only places within 25 miles of New York and never marks Boston records absent", () =>
    tx(async (c) => {
      const b = await load(c, "boston_food_licenses", csv("bos.csv", [0, 1, 2].map((i) => row(i))), { ...opts, release: "test-bos" });
      expect(b.counts).toMatchObject({ area: "boston-core", added: 3 });
      // The same file format with New York positions (Brooklyn and Manhattan), plus one Boston row that must be skipped.
      const nyc = (i: number, lat: number, lon: number) => `Synthetic NY ${i} LLC,NY Place ${i},Active,${i} Test Ave,NEW YORK,10001,${700 + i},${lat},${lon},Eating & Drinking,`;
      const n = await load(c, "boston_food_licenses", csv("nyc.csv", [nyc(1, 40.6782, -73.9442), nyc(2, 40.7484, -73.9857), row(5)]), { ...opts, release: "test-nyc", area: "new-york" });
      expect(n.counts).toMatchObject({ area: "new-york", records: 2, added: 2, absent: 0 });
      expect(n.counts.skipped).toMatchObject({ outside_area: 1 });
      const boston = await c.query("select count(*)::int n from catalog_import.source_records where name like 'Test Place %' and present");
      expect(boston.rows[0].n).toBe(3);
      // A second Boston run compares with the earlier Boston run, not with New York's.
      const b2 = await load(c, "boston_food_licenses", csv("bos2.csv", [0, 1, 2].map((i) => row(i))), { ...opts, release: "test-bos2" });
      expect(b2.refusal).toBeNull();
      expect(b2.counts).toMatchObject({ area: "boston-core", unchanged: 3, absent: 0 });
      expect((await c.query("select count(*)::int n from catalog_import.source_records where name like 'NY Place %' and present")).rows[0].n).toBe(2);
    }));
});

describe("load: runs, history and absent records", () => {
  it("records added, changed, unchanged, absent and returned; never deletes; never stores the phone", () =>
    tx(async (c) => {
      const all = [0, 1, 2, 3, 4, 5].map((i) => row(i));
      const r1 = await load(c, "boston_food_licenses", csv("r1.csv", all), { ...opts, release: "test-1" });
      expect(r1.refusal).toBeNull();
      expect(r1.counts).toMatchObject({ input_rows: 6, records: 6, added: 6 });
      expect(await history(c, r1.run)).toEqual(["added:6"]);

      // Release 2: Charlie gone, Bravo moved next door.
      const r2 = await load(c, "boston_food_licenses", csv("r2.csv", [row(0), row(1, "99 Sample St"), row(3), row(4), row(5)]), { ...opts, release: "test-2" });
      expect(r2.counts).toMatchObject({ records: 5, added: 0, changed: 1, unchanged: 4, absent: 1 });
      const charlie = await c.query("select present, last_run from catalog_import.source_records where name = 'Test Place Charlie'");
      expect(charlie.rows).toEqual([{ present: false, last_run: r2.run }]);

      // Release 3: Charlie is back.
      const r3 = await load(c, "boston_food_licenses", csv("r3.csv", all), { ...opts, release: "test-3" });
      expect(r3.counts).toMatchObject({ returned: 1, changed: 1, unchanged: 4, absent: 0 });
      expect(await history(c, r3.run)).toEqual(["changed:1", "returned:1"]);

      const n = await c.query("select count(*)::int n from catalog_import.source_records where source_key = 'boston_food_licenses' and name like 'Test Place %'");
      expect(n.rows[0].n).toBe(6);
      const dump = await c.query("select row_to_json(r)::text t from catalog_import.source_records r where name like 'Test Place %'");
      expect(dump.rows.map((r: J) => r.t).join()).not.toContain("6175550199");
      const runs = await c.query("select release, status, file_sha256 from catalog_import.import_runs where release like 'test-%' order by release");
      expect(runs.rows.map((r: J) => r.status)).toEqual(["completed", "completed", "completed"]);
      expect(new Set(runs.rows.map((r: J) => r.file_sha256)).size).toBe(2); // r1 and r3 are the same file
    }));

  it("a refused run writes no records, only the refusal", () =>
    tx(async (c) => {
      const out = await load(c, "boston_food_licenses", csv("short.csv", [row(0)]), { ownTransaction: false, release: "test-short" });
      expect(out.refusal).toMatch(/Only 1 usable records/);
      const run = await c.query("select status, refusal from catalog_import.import_runs where id = $1", [out.run]);
      expect(run.rows[0].status).toBe("refused");
      const n = await c.query("select count(*)::int n from catalog_import.source_records where first_run = $1", [out.run]);
      expect(n.rows[0].n).toBe(0);
    }));

  it("a dry run with its own transaction leaves nothing behind", async () => {
    const c = await pool.connect();
    try {
      const before = (await c.query("select count(*)::int n from catalog_import.import_runs")).rows[0].n;
      const out = await load(c, "boston_food_licenses", csv("dry.csv", [row(0), row(1)]), { minRows: 1, release: "test-dry", dryRun: true });
      expect(out.dryRun).toBe(true);
      expect((await c.query("select count(*)::int n from catalog_import.import_runs")).rows[0].n).toBe(before);
    } finally {
      c.release();
    }
  });
});

describe("match", () => {
  it("creates single-source candidates and is idempotent", () =>
    tx(async (c) => {
      await load(c, "boston_food_licenses", csv("m.csv", [0, 1, 2, 3, 4, 5].map((i) => row(i))), { ...opts, release: "test-m" });
      const first = await match(c, { ownTransaction: false });
      expect(first.stats.new_candidates).toBe(6);
      const q = await c.query(
        "select c.quality from catalog_import.place_candidates c join catalog_import.candidate_links l on l.candidate_id = c.id join catalog_import.source_records r on r.id = l.record_id where r.name like 'Test Place %'",
      );
      expect(q.rows.map((r: J) => r.quality)).toEqual(Array(6).fill("single_source"));
      const again = await match(c, { ownTransaction: false });
      expect(again.stats).toMatchObject({ new_candidates: 0, auto_linked: 0 });
    }));

  it("a candidate a person rejected stays rejected", () =>
    tx(async (c) => {
      await load(c, "boston_food_licenses", csv("rj.csv", [0, 1, 2].map((i) => row(i))), { ...opts, release: "test-rj" });
      await match(c, { ownTransaction: false });
      const id = (await c.query("select l.candidate_id from catalog_import.candidate_links l join catalog_import.source_records r on r.id = l.record_id where r.name = 'Test Place Alpha'")).rows[0].candidate_id;
      await c.query("update catalog_import.place_candidates set quality = 'rejected' where id = $1", [id]);
      await match(c, { ownTransaction: false });
      expect((await c.query("select quality from catalog_import.place_candidates where id = $1", [id])).rows[0].quality).toBe("rejected");
    }));
});
