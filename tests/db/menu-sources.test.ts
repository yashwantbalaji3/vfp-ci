import type { PoolClient } from "pg";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../helpers/db";
import { checkAccess, discover, loadPermissions, recordPermission, removeSourceContent, seedAllowlistSources } from "../../scripts/menu-sources.mjs";

// Menu pipeline step 1: sources and access checks (docs/41). Every test runs in a transaction that
// is rolled back. Places, websites and robots files are invented; no network is used.

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const TEST_HOSTS = ["open.test", "closed.test", "down.test", "noclaude.test", "norobots.test", "zz-test.yelp.com"];
// Stage 1 tables plus the stage 2 snapshot tables (MENU-3); every one closed and RLS forced.
const STAGE1 = ["excluded_hosts", "sources", "source_places", "access_checks"];
const TABLES = [...STAGE1, "snapshots", "read_runs", "items", "access_permissions", "removals"];

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

/** Synthetic catalog places with websites, all in the preview tier. */
async function seed(c: PoolClient, sites: [string, string][]) {
  const src = (await c.query("select key from catalog_import.sources order by key limit 1")).rows[0]?.key;
  const run = (await c.query(`insert into catalog_import.import_runs (source_key, release, file_sha256, retrieved_at, thresholds, status)
                               values ($1, 'test', repeat('a', 64), now(), '{}', 'completed') returning id`, [src])).rows[0].id;
  // Only this test's places count: set any real preview aside inside the transaction.
  await c.query("update catalog_import.place_candidates set preview_tier = 'exception' where preview_tier = 'preview'");
  const ids: string[] = [];
  for (const [i, [name, website]] of sites.entries()) {
    const rec = (await c.query(`insert into catalog_import.source_records (source_key, external_id, name, street, postcode, lat, lon, website, record_licence, record_hash, first_run, last_run)
                                 values ($1, $2, $3, $4, '02199', 42.35, -71.08, $5, 'test', repeat('b', 64), $6, $6) returning id`, [src, `menu-test-${i}`, name, `${i + 1} Test St`, website, run])).rows[0].id;
    const cand = (await c.query(`insert into catalog_import.place_candidates (name, street, postcode, lat, lon, category, quality, flags, created_run, preview_tier)
                                  values ($1, $2, '02199', 42.35, -71.08, 'restaurant', 'corroborated', '{}', $3, 'preview') returning id`, [name, `${i + 1} Test St`, run])).rows[0].id;
    await c.query("insert into catalog_import.candidate_links (candidate_id, record_id, match_score, match_method) values ($1, $2, 1, 'seed')", [cand, rec]);
    ids.push(cand);
  }
  return ids;
}

const fakeFetch = (answers: Record<string, { status: number; body: string } | "fail">) =>
  (async (url: string | URL) => {
    const a = answers[String(url)];
    if (!a || a === "fail") throw new Error("network down");
    return new Response(a.body, { status: a.status });
  }) as unknown as typeof fetch;

afterAll(async () => {
  await pool.end();
});

describe("menu_ingest schema is private", () => {
  it("is closed to anon and authenticated, with RLS forced on every table", async () => {
    for (const role of ["anon", "authenticated"]) {
      expect((await pool.query("select has_schema_privilege($1, 'menu_ingest', 'usage') u", [role])).rows[0].u).toBe(false);
      for (const t of [...TABLES, "source_status"]) {
        const p = await pool.query("select has_table_privilege($1, $2, 'select') s, has_table_privilege($1, $2, 'insert') i", [role, `menu_ingest.${t}`]);
        expect(p.rows[0]).toEqual({ s: false, i: false });
      }
    }
    const rls = await pool.query("select relname, relrowsecurity r, relforcerowsecurity f from pg_class where relnamespace = 'menu_ingest'::regnamespace and relkind = 'r'");
    expect(rls.rows.map((r: J) => r.relname).sort()).toEqual([...TABLES].sort());
    expect(rls.rows.every((r: J) => r.r && r.f)).toBe(true);
  });

  it("nothing outside the schema reads it: no function, view or policy refers to it", async () => {
    const fns = await pool.query("select n.nspname || '.' || p.proname fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname <> 'menu_ingest' and p.prosrc ilike '%menu_ingest%'");
    expect(fns.rows).toEqual([]);
    expect((await pool.query("select viewname from pg_views where schemaname <> 'menu_ingest' and definition ilike '%menu_ingest%'")).rows).toEqual([]);
    expect((await pool.query("select tablename from pg_policies where schemaname <> 'menu_ingest' and (coalesce(qual, '') || coalesce(with_check, '')) ilike '%menu_ingest%'")).rows).toEqual([]);
  });

  it("the source and access tables store no menu, dish, dietary, allergen or nutrition column", async () => {
    const cols = (await pool.query("select column_name from information_schema.columns where table_schema = 'menu_ingest' and table_name = any($1)", [[...STAGE1, "source_status"]])).rows.map((r: J) => r.column_name);
    expect(cols.filter((c: string) => /dish|diet|vegan|vegetarian|allergen|protein|nutri|price|ingredient/.test(c))).toEqual([]);
  });
});

describe("discover", () => {
  it("one source per website, chains become one brand source, excluded hosts are marked, and re-running adds nothing", () =>
    tx(async (c) => {
      await seed(c, [
        ["Test Chain One", "https://www.chain.test/locations/1?utm_source=gmb"],
        ["Test Chain Two", "http://chain.test/locations/2"],
        ["Test Bistro", "https://bistro.test/menu"],
        ["Test Diner", "https://zz-test.yelp.com/biz/test-diner"],
        ["Test Bar", "https://user:pw@bar.test/"],
      ]);
      const r1 = await discover(c);
      expect(r1).toMatchObject({ hosts: 3, excluded: 1, newSources: 3, newLinks: 4, unusable: 1 });
      const s = (await c.query("select host, start_url, scope, excluded_by, places, state from menu_ingest.source_status where host in ('bistro.test', 'chain.test', 'zz-test.yelp.com', 'bar.test') order by host")).rows;
      expect(s).toEqual([
        { host: "bistro.test", start_url: "https://bistro.test/menu", scope: "location", excluded_by: null, places: 1, state: "not_checked" },
        { host: "chain.test", start_url: "https://chain.test/", scope: "brand", excluded_by: null, places: 2, state: "not_checked" },
        { host: "zz-test.yelp.com", start_url: "https://zz-test.yelp.com/biz/test-diner", scope: "location", excluded_by: "yelp.com", places: 1, state: "excluded" },
      ]);
      expect(await discover(c)).toMatchObject({ newSources: 0, newLinks: 0 });
    }));
});

describe("approved chain sites", () => {
  it("adds a listed chain's brand site, tied to that chain's places; never an unlisted host; refuses an unapproved list", () =>
    tx(async (c) => {
      await seed(c, [["Chain A", "https://locations.chain-a.test/ma/boston/1"], ["Chain A", "https://locations.chain-a.test/ma/boston/2"], ["Other", "https://other.test/"]]);
      await discover(c);
      const list = { approved: true, chains: [
        { chain: "Chain A", hosts: ["chain-a.test", "www.chain-a.test", "locations.chain-a.test"] },
        { chain: "Nowhere", hosts: ["nowhere.test"] },
      ] };
      await expect(seedAllowlistSources(c, { ...list, approved: false })).rejects.toThrow("not approved");
      expect(await seedAllowlistSources(c, list)).toEqual([
        { chain: "Chain A", added: ["chain-a.test"], places: 2 },
        { chain: "Nowhere", added: [], places: 0 },
      ]);
      const rows = (await c.query(`select s.host, s.scope, count(p.*)::int n from menu_ingest.sources s left join menu_ingest.source_places p on p.source_id = s.id
                                    where s.host in ('chain-a.test', 'nowhere.test') group by 1, 2`)).rows;
      expect(rows).toEqual([{ host: "chain-a.test", scope: "brand", n: 2 }]);
      expect((await seedAllowlistSources(c, list))[0].added).toEqual([]);
    }));
});

describe("access checks", () => {
  it("records allowed, disallowed and unreachable; one failure never stops the others; excluded hosts are never asked", () =>
    tx(async (c) => {
      await seed(c, [
        ["Open Cafe", "https://open.test/menu"],
        ["Closed Cafe", "https://closed.test/menu"],
        ["Down Cafe", "https://down.test/"],
        ["Claude Blocked Cafe", "https://noclaude.test/"],
        ["No Robots Cafe", "https://norobots.test/food"],
        ["Yelp Cafe", "https://zz-test.yelp.com/biz/x"],
      ]);
      await discover(c);
      const asked: string[] = [];
      const f = fakeFetch({
        "https://open.test/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /admin\n" },
        "https://closed.test/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /menu\n" },
        "https://down.test/robots.txt": "fail",
        "https://noclaude.test/robots.txt": { status: 200, body: "User-agent: ClaudeBot\nDisallow: /\n" },
        "https://norobots.test/robots.txt": { status: 404, body: "" },
      });
      const r = await checkAccess(c, { hosts: TEST_HOSTS, fetchImpl: (async (u: string, o: RequestInit) => { asked.push(String(u)); return f(u, o); }) as unknown as typeof fetch });
      expect(Object.fromEntries(r.map((x: J) => [x.host, x.decision]))).toEqual({
        "open.test": "allowed", "closed.test": "disallowed", "down.test": "unreachable", "noclaude.test": "disallowed", "norobots.test": "allowed",
      });
      expect(asked.some((u) => u.includes("yelp"))).toBe(false);
      const st = Object.fromEntries((await c.query("select host, state from menu_ingest.source_status where host = any($1)", [[...TEST_HOSTS, "zz-test.yelp.com"]])).rows.map((x: J) => [x.host, x.state]));
      // Robots.txt alone is never enough: until the terms are reviewed, allowed sites wait (fail closed).
      expect(st).toEqual({ "open.test": "terms_needed", "closed.test": "blocked", "down.test": "blocked", "noclaude.test": "blocked", "norobots.test": "terms_needed", "zz-test.yelp.com": "excluded" });
      const row = (await c.query("select a.* from menu_ingest.access_checks a join menu_ingest.sources s on s.id = a.source_id where s.host = 'closed.test'")).rows[0];
      expect(row).toMatchObject({ http_status: 200, path_checked: "/menu", rule: "user-agent *: Disallow: /menu" });
      expect(row.robots_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(row.user_agent).toMatch(/^VFPMenuCheck\//);
      // Checked sources are not asked again until the re-check interval passes.
      expect(await checkAccess(c, { hosts: TEST_HOSTS, fetchImpl: f })).toEqual([]);
    }));

  it("the permission registry decides, fails closed when uncertain, and its history cannot be changed", () =>
    tx(async (c) => {
      await seed(c, [["Terms Cafe", "https://terms.test/"], ["Export Cafe", "https://export.test/"]]);
      await discover(c);
      await checkAccess(c, { hosts: ["terms.test"], fetchImpl: fakeFetch({ "https://terms.test/robots.txt": { status: 200, body: "" } }) });
      const state = async (h: string) => (await c.query("select state from menu_ingest.source_status where host = $1", [h])).rows[0].state;
      const base = { host: "terms.test", evidence: "Quoted clause from the terms", reviewer: "Test reviewer" };
      expect(await state("terms.test")).toBe("terms_needed");
      await expect(recordPermission(c, { ...base, status: "maybe" })).rejects.toThrow("--status must be one of");
      await expect(recordPermission(c, { ...base, status: "permits" })).rejects.toThrow("--uses is required");
      await expect(recordPermission(c, { ...base, status: "permits", evidence: "" })).rejects.toThrow("--evidence is required");
      await expect(recordPermission(c, { ...base, host: "nowhere.test", status: "unclear" })).rejects.toThrow("No source nowhere.test");
      await recordPermission(c, { ...base, status: "unclear", reviewedAt: "2026-11-01T00:00:00Z" });
      expect(await state("terms.test")).toBe("terms_unclear");
      await recordPermission(c, { ...base, status: "permits", uses: "read menus for a private catalog", reviewedAt: "2026-11-02T00:00:00Z" });
      expect(await state("terms.test")).toBe("may_fetch");
      // An old terms review goes stale; an expired permission no longer counts.
      await recordPermission(c, { ...base, status: "permits", uses: "x", reviewedAt: new Date(Date.now() - 200 * 864e5).toISOString() });
      expect(await state("terms.test")).toBe("may_fetch"); // the newer review above is still the latest
      await recordPermission(c, { ...base, kind: "licence", status: "permits", uses: "x", reviewedAt: "2026-11-03T00:00:00Z", expiresAt: "2026-11-04T00:00:00Z" });
      expect(await state("terms.test")).toBe("terms_needed");
      await recordPermission(c, { ...base, status: "prohibits", reviewedAt: "2026-11-05T00:00:00Z" });
      expect(await state("terms.test")).toBe("terms_block");
      // A written permission lets the restaurant's own export in, even with no robots.txt check.
      expect(await state("export.test")).toBe("not_checked");
      await recordPermission(c, { host: "export.test", kind: "written_permission", status: "permits", evidence: "Email from the owner, ref 123", uses: "import our menu export", reviewer: "Test reviewer" });
      expect(await state("export.test")).toBe("may_import");
      // Registry files: unknown hosts are skipped and an identical latest entry is not repeated.
      const dir = mkdtempSync(join(tmpdir(), "perm-"));
      const file = join(dir, "registry.json");
      writeFileSync(file, JSON.stringify({ reviews: [{ hosts: ["www.terms.test", "unknown.test"], kind: "terms_review", status: "unclear", evidence: "Personal use only", reviewer: "Test reviewer", reviewedAt: "2026-11-06T00:00:00Z" }] }));
      expect(await loadPermissions(c, file)).toEqual({ recorded: 1, skipped: ["unknown.test"] });
      expect(await loadPermissions(c, file)).toEqual({ recorded: 0, skipped: ["unknown.test"] });
      expect(await state("terms.test")).toBe("terms_unclear");
      await c.query("savepoint s");
      await expect(c.query("delete from menu_ingest.access_permissions")).rejects.toThrow("Menu source history is permanent");
      await c.query("rollback to savepoint s");
      await expect(c.query("update menu_ingest.access_permissions set status = 'permits'")).rejects.toThrow("Menu source history is permanent");
    }));

  it("removal deletes one source's content only, keeps an audit row, and needs a reason and authority", () =>
    tx(async (c) => {
      await seed(c, [["Gone Cafe", "https://gone.test/"]]);
      await discover(c);
      await expect(removeSourceContent(c, { host: "gone.test", reason: "", authority: "x" })).rejects.toThrow("--reason and --authority are required");
      expect(await removeSourceContent(c, { host: "gone.test", reason: "Terms prohibit automated collection", authority: "Owner decision" })).toEqual({ snapshots: 0, read_runs: 0, items: 0 });
      expect((await c.query("select count(*)::int n from menu_ingest.removals r join menu_ingest.sources s on s.id = r.source_id where s.host = 'gone.test'")).rows[0].n).toBe(1);
      // The removal switch is off again afterwards (deleting with it off is tested in menu-fetch).
      expect((await c.query("select current_setting('menu_ingest.removal', true) v")).rows[0].v).toBe("off");
    }));
});
