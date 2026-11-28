import type { PoolClient } from "pg";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../helpers/db";
import { allowlistHosts, exportSnapshots, fetchMenus, importSnapshots, readSnapshots } from "../../scripts/menu-fetch.mjs";
import { importExport } from "../../scripts/menu-export-import.mjs";

// Menu pipeline stage 2 (docs/41): polite fetching, snapshots, local import, reading. Every test runs
// in a transaction that is rolled back. Sites and pages are invented; no network is used.

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

/** A source with an access check and (unless told otherwise) a terms review that permits reading. */
async function source(c: PoolClient, host: string, robots: string, decision = "allowed", note: string | null = null, terms: string | null = "permits") {
  const s = (await c.query("insert into menu_ingest.sources (host, start_url, scope) values ($1, $2, 'brand') returning id", [host, `https://${host}/`])).rows[0].id;
  await c.query(`insert into menu_ingest.access_checks (source_id, robots_url, http_status, robots_text, user_agent, path_checked, decision, note)
                 values ($1, $2, 200, $3, 'VFPMenuCheck/0.1', '/', $4, $5)`, [s, `https://${host}/robots.txt`, robots, decision, note]);
  if (terms) await permission(c, s, terms);
  return s;
}

async function permission(c: PoolClient, sourceId: string, status: string, kind = "terms_review") {
  await c.query(`insert into menu_ingest.access_permissions (source_id, kind, status, evidence, permitted_uses, reviewer)
                 values ($1, $2, $3, 'Test clause', $4, 'Test reviewer')`, [sourceId, kind, status, status === "permits" ? "read menus privately" : null]);
}

const menuPage = `<html><head><script type="application/ld+json">${JSON.stringify({ "@type": "Menu", hasMenuItem: [
  { "@type": "MenuItem", name: "Lentil Soup", suitableForDiet: "https://schema.org/VeganDiet", nutrition: { proteinContent: "12 g" } },
  { "@type": "MenuItem", name: "Grain Bowl" }] })}</script></head><body></body></html>`;

function site(pages: Record<string, { status: number; body?: string; type?: string; location?: string }>) {
  const asked: string[] = [];
  const f = (async (url: string) => {
    asked.push(String(url));
    const p = pages[String(url)];
    if (!p) throw new Error("network down");
    const headers: Record<string, string> = { "content-type": p.type ?? "text/html" };
    if (p.location) headers.location = p.location;
    return new Response(p.status >= 300 && p.status < 400 ? null : p.body ?? "", { status: p.status, headers });
  }) as unknown as typeof fetch;
  return { f, asked };
}

const noSleep = async () => {};

afterAll(async () => {
  await pool.end();
});

describe("fetching", () => {
  it("needs an approved allowlist unless told to use every allowed site", async () => {
    const dir = mkdtempSync(join(tmpdir(), "allow-"));
    const file = join(dir, "a.json");
    writeFileSync(file, JSON.stringify({ approved: false, chains: [{ chain: "X", hosts: ["www.x.test"] }] }));
    expect(allowlistHosts(file)).toBeNull();
    writeFileSync(file, JSON.stringify({ approved: true, chains: [{ chain: "X", hosts: ["www.x.test", "x.test"] }] }));
    expect([...(allowlistHosts(file) as Set<string>)]).toEqual(["x.test"]);
    await tx(async (c) => {
      await expect(fetchMenus(c, { hosts: null })).rejects.toThrow("No approved allowlist");
    });
    // The real phase 1 file: exactly the 46 hosts the owner approved on 17 Nov 19:20 UTC.
    const phase1 = JSON.parse(readFileSync("scripts/menu-allowlist-phase1.json", "utf8"));
    expect(phase1.chains.flatMap((x: J) => x.hosts)).toHaveLength(46);
    expect(phase1.approved).toBe(true);
  });

  it("follows menu links on the same site, honours robots.txt per page, pauses between requests, and keeps snapshots once", () =>
    tx(async (c) => {
      await source(c, "chain.test", "User-agent: *\nDisallow: /secret-menu\nCrawl-delay: 7\n", "allowed", "Crawl-delay 7s");
      const { f, asked } = site({
        "https://chain.test/": { status: 200, body: '<a href="/menu">Menu</a><a href="/secret-menu">Secret menu</a><a href="https://other.test/menu">Menu elsewhere</a><a href="/about">About</a>' },
        "https://chain.test/menu": { status: 200, body: menuPage },
      });
      const pauses: number[] = [];
      const r = await fetchMenus(c, { hosts: new Set(["chain.test"]), fetchImpl: f, sleep: async (ms: number) => { pauses.push(ms); } });
      expect(r).toEqual([{ host: "chain.test", fetched: 2, saved: 2, skipped: ["/secret-menu: user-agent *: Disallow: /secret-menu"], stopped: null }]);
      expect(asked).toEqual(["https://chain.test/", "https://chain.test/menu"]);
      expect(pauses).toEqual([7000]);
      const again = await fetchMenus(c, { hosts: new Set(["chain.test"]), fetchImpl: f, sleep: noSleep });
      expect(again[0].saved).toBe(0);
      const snaps = (await c.query("select url, fetched_via, bytes, sha256 from menu_ingest.snapshots n join menu_ingest.sources s on s.id = n.source_id where s.host = 'chain.test' order by url")).rows;
      expect(snaps.map((x: J) => [x.url, x.fetched_via])).toEqual([["https://chain.test/", "cloud"], ["https://chain.test/menu", "cloud"]]);
    }));

  it("a site outside the allowlist is never asked; a refusal stops that site only; redirects to other sites are not followed", () =>
    tx(async (c) => {
      await source(c, "listed.test", "");
      await source(c, "refuses.test", "");
      await source(c, "moves.test", "");
      await source(c, "unlisted.test", "");
      const { f, asked } = site({
        "https://refuses.test/": { status: 403 },
        "https://moves.test/": { status: 301, location: "https://elsewhere.test/" },
        "https://listed.test/": { status: 200, body: "<p>hello</p>" },
      });
      const r = await fetchMenus(c, { hosts: new Set(["listed.test", "refuses.test", "moves.test"]), fetchImpl: f, sleep: noSleep });
      const by = Object.fromEntries(r.map((x: J) => [x.host, x.stopped]));
      expect(by).toEqual({ "listed.test": null, "refuses.test": "HTTP 403", "moves.test": "Redirects to another site (elsewhere.test); not followed" });
      expect(asked.some((u) => u.includes("unlisted") || u.includes("elsewhere"))).toBe(false);
    }));

  it("never fetches a site whose latest check is not 'allowed'", () =>
    tx(async (c) => {
      await source(c, "blocked.test", "User-agent: *\nDisallow: /\n", "disallowed");
      const { f, asked } = site({});
      expect(await fetchMenus(c, { anyAllowed: true, fetchImpl: f, sleep: noSleep })).toEqual(expect.not.arrayContaining([expect.objectContaining({ host: "blocked.test" })]));
      expect(asked.filter((u) => u.includes("blocked.test"))).toEqual([]);
    }));

  it("never fetches a site whose terms are not reviewed, unclear or prohibit it, even when robots.txt allows it", () =>
    tx(async (c) => {
      await source(c, "noterms.test", "", "allowed", null, null);
      await source(c, "unclear.test", "", "allowed", null, "unclear");
      await source(c, "forbids.test", "", "allowed", null, "prohibits");
      const { f, asked } = site({});
      await fetchMenus(c, { anyAllowed: true, fetchImpl: f, sleep: noSleep });
      expect(asked.filter((u) => /noterms|unclear|forbids/.test(u))).toEqual([]);
    }));
});

describe("export, import and reading", () => {
  it("a local run's snapshots import into the same tables, are checked again, and read into items", () =>
    tx(async (c) => {
      await source(c, "mac.test", "User-agent: *\nDisallow: /private\n");
      await source(c, "other.test", "");
      const { f } = site({ "https://mac.test/": { status: 200, body: menuPage } });
      await fetchMenus(c, { anyAllowed: true, fetchImpl: f, sleep: noSleep });
      const dir = mkdtempSync(join(tmpdir(), "snap-"));
      expect(await exportSnapshots(c, dir)).toBeGreaterThanOrEqual(1);
      // Tamper: one snapshot claims a disallowed path, another an unknown site.
      const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
      const mine = m.snapshots.filter((x: J) => x.url.startsWith("https://mac.test/"));
      m.snapshots = [...mine, { ...mine[0], url: "https://mac.test/private" }, { ...mine[0], url: "https://nowhere.test/" }];
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
      const r = await importSnapshots(c, dir);
      expect(r).toMatchObject({ imported: 0, already: 1 }); // the same page with the same content is kept once
      expect(r.refused.map((x: J) => x.why).sort()).toEqual(["not a known catalog source", "robots.txt does not allow this page"]);
      const via = (await c.query("select fetched_via, count(*)::int n from menu_ingest.snapshots n join menu_ingest.sources s on s.id = n.source_id where s.host = 'mac.test' group by 1 order by 1")).rows;
      expect(via).toEqual([{ fetched_via: "cloud", n: 1 }]);
      const read = await readSnapshots(c);
      expect(read.items).toBeGreaterThanOrEqual(2);
      const items = (await c.query("select name, labels, nutrition, match_key from menu_ingest.items i join menu_ingest.sources s on s.id = i.source_id where s.host = 'mac.test' order by name")).rows;
      expect(items).toEqual([
        { name: "Grain Bowl", labels: [], nutrition: {}, match_key: "grain bowl" },
        { name: "Lentil Soup", labels: ["VeganDiet"], nutrition: { protein_g: { amount: 12, unit: "g", per: "serving" } }, match_key: "lentil soup" },
      ]);
      expect((await readSnapshots(c)).snapshots).toBe(0);
      await c.query("savepoint s");
      await expect(c.query("update menu_ingest.items set name = 'x'")).rejects.toThrow("Menu source history is permanent");
      await c.query("rollback to savepoint s");
    }));

  it("saved pages from a site without a current permission are refused on import and never read", () =>
    tx(async (c) => {
      const id = await source(c, "later.test", "");
      const { f } = site({ "https://later.test/": { status: 200, body: menuPage } });
      await fetchMenus(c, { anyAllowed: true, fetchImpl: f, sleep: noSleep });
      const dir = mkdtempSync(join(tmpdir(), "snap-"));
      await exportSnapshots(c, dir);
      // The terms are re-read and now prohibit it: nothing more is read, and a re-import is refused.
      await permission(c, id, "prohibits");
      expect((await readSnapshots(c)).snapshots).toBe(0);
      const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
      m.snapshots = m.snapshots.filter((x: J) => x.url.startsWith("https://later.test/")).map((x: J) => ({ ...x, url: x.url + "?again" }));
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
      const r = await importSnapshots(c, dir);
      expect(r.imported).toBe(0);
      expect(r.refused.map((x: J) => x.why)).toEqual([expect.stringMatching(/^no current permission for automated reading/)]);
    }));

  it("removing a source deletes its pages, reads and items, keeps fingerprints only, and leaves other sources alone", () =>
    tx(async (c) => {
      const gone = await source(c, "gone.test", "");
      await source(c, "keep.test", "");
      const { f } = site({ "https://gone.test/": { status: 200, body: menuPage }, "https://keep.test/": { status: 200, body: menuPage } });
      await fetchMenus(c, { anyAllowed: true, fetchImpl: f, sleep: noSleep });
      await readSnapshots(c);
      const sha = (await c.query("select sha256 from menu_ingest.snapshots where source_id = $1", [gone])).rows.map((x: J) => x.sha256);
      const id = (await c.query("select menu_ingest.remove_source_content($1, 'Terms prohibit it', 'Owner decision') id", [gone])).rows[0].id;
      const audit = (await c.query("select snapshots, read_runs, items, snapshot_sha256 from menu_ingest.removals where id = $1", [id])).rows[0];
      expect(audit).toEqual({ snapshots: 1, read_runs: 1, items: 2, snapshot_sha256: sha });
      const left = async (h: string) => (await c.query(`select (select count(*) from menu_ingest.snapshots n join menu_ingest.sources s on s.id = n.source_id where s.host = $1)::int snaps,
                                                                (select count(*) from menu_ingest.items i join menu_ingest.sources s on s.id = i.source_id where s.host = $1)::int items`, [h])).rows[0];
      expect(await left("gone.test")).toEqual({ snaps: 0, items: 0 });
      expect(await left("keep.test")).toEqual({ snaps: 1, items: 2 });
      // The removal switch is off again afterwards.
      await expect(c.query("delete from menu_ingest.items")).rejects.toThrow("Menu source history is permanent");
    }));
});

describe("authorized menu exports", () => {
  const exportJson = JSON.stringify({ document_date: "2026-11-01", items: [
    { name: "Tofu Bowl", section: "Bowls", labels: ["VG"], legend: { VG: "Vegan" }, price_usd: "12.50", serving: "1 bowl", serving_grams: "450 g",
      nutrition: { protein_g: { amount: 21, unit: "g", per: "serving" }, fat_g: { amount: null, unit: "g" } } },
    { name: "Side Salad", description: "", price_usd: "" }] });

  it("needs a current written permission or licence; a terms review is not enough", () =>
    tx(async (c) => {
      await source(c, "termsonly.test", "");
      const dir = mkdtempSync(join(tmpdir(), "exp-"));
      writeFileSync(join(dir, "menu.json"), exportJson);
      await expect(importExport(c, { host: "termsonly.test", file: join(dir, "menu.json") })).rejects.toThrow("No current written permission or licence");
      await expect(importExport(c, { host: "nobody.test", file: join(dir, "menu.json") })).rejects.toThrow("No source nobody.test");
    }));

  it("stores the export tied to its permission, reads items in the restaurant's words, keeps blanks blank, and only once", () =>
    tx(async (c) => {
      const s = (await c.query("insert into menu_ingest.sources (host, start_url, scope) values ('owner.test', 'https://owner.test/', 'location') returning id")).rows[0].id;
      await permission(c, s, "permits", "written_permission");
      expect((await c.query("select state from menu_ingest.source_status where id = $1", [s])).rows[0].state).toBe("may_import");
      const dir = mkdtempSync(join(tmpdir(), "exp-"));
      writeFileSync(join(dir, "menu.json"), exportJson);
      expect(await importExport(c, { host: "owner.test", file: join(dir, "menu.json") })).toMatchObject({ items: 2, already: false });
      expect(await importExport(c, { host: "owner.test", file: join(dir, "menu.json") })).toEqual({ snapshot: null, items: 0, already: true });
      // The page readers leave an export alone; it has its own reader.
      await readSnapshots(c);
      expect((await c.query("select reader from menu_ingest.read_runs r join menu_ingest.snapshots n on n.id = r.snapshot_id where n.source_id = $1", [s])).rows).toEqual([{ reader: "menu_export@1" }]);
      const snap = (await c.query("select fetched_via, access_check_id, permission_id is not null p, url, fetched_at::date::text d from menu_ingest.snapshots where source_id = $1", [s])).rows;
      expect(snap).toEqual([{ fetched_via: "authorized_export", access_check_id: null, p: true, url: "https://owner.test/authorized-export/menu.json", d: "2026-11-01" }]);
      const items = (await c.query("select name, description, labels, legend, price_usd::text, serving, serving_grams::float g, nutrition from menu_ingest.items where source_id = $1 order by name", [s])).rows;
      expect(items).toEqual([
        { name: "Side Salad", description: null, labels: [], legend: {}, price_usd: null, serving: null, g: null, nutrition: {} },
        { name: "Tofu Bowl", description: null, labels: ["VG"], legend: { VG: "Vegan" }, price_usd: "12.50", serving: "1 bowl", g: 450, nutrition: { protein_g: { amount: 21, unit: "g", per: "serving" } } },
      ]);
      // An export snapshot without a permission is refused by the database itself.
      await expect(c.query(`insert into menu_ingest.snapshots (source_id, url, fetched_at, fetched_via, http_status, content_type, sha256, bytes, body)
                            values ($1, 'https://owner.test/x', now(), 'authorized_export', 200, 'text/csv', repeat('c', 64), 1, 'x')`, [s])).rejects.toThrow("snapshots_basis");
    }));
});

describe("privacy", () => {
  it("the new tables are closed, RLS forced, and nothing outside the schema reads them", async () => {
    for (const t of ["snapshots", "read_runs", "items", "access_permissions", "removals"]) {
      for (const role of ["anon", "authenticated"]) {
        expect((await pool.query("select has_table_privilege($1, $2, 'select') s", [role, `menu_ingest.${t}`])).rows[0].s).toBe(false);
      }
      expect((await pool.query("select relforcerowsecurity f from pg_class where oid = $1::regclass", [`menu_ingest.${t}`])).rows[0].f).toBe(true);
    }
    expect((await pool.query("select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname <> 'menu_ingest' and p.prosrc ilike '%menu_ingest%'")).rows).toEqual([]);
  });
});
