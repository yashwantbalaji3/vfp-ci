import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../helpers/db";
import { loadStagingAccess } from "../../scripts/research-sources.mjs";

// Research sources must be cleared before their facts count (owner 22:37 UTC 17 Nov; docs/46). Every
// test runs in one transaction that is rolled back. Places, hosts and pages are invented.

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

async function user(c: PoolClient, roles: string[]) {
  const id = randomUUID();
  await c.query(`insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
                 values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}', '{}', now(), now())`, [id, `holds-${id.slice(0, 8)}@example.test`]);
  for (const r of roles) await c.query("insert into public.role_assignments (user_id, role) values ($1, $2)", [id, r]);
  return id;
}
const access = (c: PoolClient, host: string, status: string, kind = "terms_review", reviewedAt = "now()") =>
  c.query(`insert into staging.source_access (host, kind, status, evidence, permitted_uses, reviewer, reviewed_at)
           values ($1, $2, $3, 'Test clause', $4, 'Test reviewer', ${reviewedAt})`, [host, kind, status, status === "permits" ? "tests" : null]);

async function world(c: PoolClient) {
  const curator = await user(c, ["curator"]);
  const publisher = await user(c, ["publisher"]);
  const place = await one(c, "staging.add_place($1, 'Holds Test Place', 'back_bay', 1::smallint)", [curator]);
  const dish = await one(c, "staging.add_dish($1, $2, 'Test bowl')", [curator, place]);
  const page = async (host: string) => one(c, "staging.add_source_page($1, $2, 'restaurant_site', 'Holds Test', now())", [curator, `https://www.${host}/menu`]);
  const today = (await c.query("select (now() at time zone 'America/New_York')::date::text d")).rows[0].d as string;
  const submit = (src: string, p: Record<string, unknown>) =>
    one(c, "staging.submit_fact($1, $2::jsonb)", [curator, JSON.stringify({ placeId: place, sourcePageId: src, checkedOn: today, ...p })]);
  const protein = (src: string) => submit(src, { dishId: dish, kind: "published_nutrition", value: { nutrient: "protein_g", amount: "20", per: "serving" } });
  return { curator, publisher, place, dish, page, submit, protein };
}

afterAll(async () => {
  await pool.end();
});

describe("source clearance", () => {
  it("states: no entry, unclear, unreadable and stale or expired permits are pending; prohibits is prohibited", () =>
    tx(async (c) => {
      const st = (u: string) => one(c, "staging.source_access_state($1)", [u]);
      expect(await st("https://www.a-holds.test/x")).toBe("pending");
      await access(c, "a-holds.test", "unclear");
      expect(await st("https://a-holds.test/")).toBe("pending");
      await access(c, "a-holds.test", "permits");
      expect(await st("https://WWW.A-HOLDS.TEST/menu")).toBe("cleared");
      expect(await st("https://sub.a-holds.test/")).toBe("pending"); // exact host only
      await access(c, "b-holds.test", "permits", "terms_review", "now() - interval '200 days'");
      expect(await st("https://b-holds.test/")).toBe("pending");
      await c.query(`insert into staging.source_access (host, kind, status, evidence, permitted_uses, reviewer, expires_at)
                     values ('c-holds.test', 'licence', 'permits', 'Licence', 'x', 'Test', now() - interval '1 day')`);
      expect(await st("https://c-holds.test/")).toBe("pending");
      await access(c, "a-holds.test", "prohibits");
      expect(await st("https://a-holds.test/")).toBe("prohibited");
      expect((await err(c, "update staging.source_access set status = 'permits'")).message).toMatch(/permanent/);
      expect((await err(c, "insert into staging.source_access (host, kind, status, evidence, reviewer) values ('d-holds.test', 'terms_review', 'permits', 'x y z', 'T')")).message).toMatch(/check/);
    }));

  it("held facts stay out of the founder's queue and cannot be verified; rejecting them is allowed", () =>
    tx(async (c) => {
      const w = await world(c);
      const pending = await w.page("pending-holds.test");
      const fact = await w.protein(pending);
      const queued = async () => (await c.query("select fact_id from staging.review_queue()")).rows.map((r) => r.fact_id);
      expect(await queued()).not.toContain(fact);
      expect((await err(c, "select staging.review_fact($1, $2, 'verify')", [w.publisher, fact])).message).toMatch(/STAGING_SOURCE_NOT_CLEARED/);
      const held = (await c.query("select host, state, facts::int, protein_facts::int from staging.held_sources() where place_id = $1", [w.place])).rows;
      expect(held).toEqual([{ host: "pending-holds.test", state: "pending", facts: 1, protein_facts: 1 }]);
      // Once a written permission is recorded, the same fact enters the queue and may be verified.
      await access(c, "pending-holds.test", "permits", "written_permission");
      expect(await queued()).toContain(fact);
      expect(await one(c, "staging.review_fact($1, $2, 'verify')", [w.publisher, fact])).toBe("verified");
      const other = await w.protein(await w.page("other-holds.test"));
      expect(await one(c, "staging.review_fact($1, $2, 'reject')", [w.publisher, other])).toBe("rejected");
    }));

  // The check date is a Boston date (submit_fact compares it with New York time), so this test uses the
  // database's New York date; a UTC date fails between 8 PM and midnight Eastern.
  it("new facts from a prohibited source are refused", () =>
    tx(async (c) => {
      const w = await world(c);
      await access(c, "banned-holds.test", "prohibits");
      const src = await w.page("banned-holds.test");
      expect((await err(c, "select staging.submit_fact($1, $2::jsonb)", [w.curator, JSON.stringify({ placeId: w.place, sourcePageId: src, checkedOn: (await c.query("select (now() at time zone 'America/New_York')::date::text d")).rows[0].d, kind: "address", value: { street: "1 Test St", postcode: "02116" } })])).message).toMatch(/STAGING_SOURCE_PROHIBITED/);
    }));

  it("a place with a verified fact from a source that is no longer cleared cannot be published", () =>
    tx(async (c) => {
      const w = await world(c);
      await access(c, "later-holds.test", "permits", "written_permission");
      const src = await w.page("later-holds.test");
      for (const p of [{ kind: "address", value: { street: "5 Holds St", postcode: "02116" } }, { kind: "operating_status", value: { status: "operating" } }]) {
        await one(c, "staging.review_fact($1, $2, 'verify')", [w.publisher, await w.submit(src, p)]);
      }
      await access(c, "later-holds.test", "prohibits", "terms_review");
      expect((await err(c, "select staging.prepare_publication($1, $2)", [w.curator, w.place])).message).toMatch(/PLACE_SOURCES_NOT_CLEARED/);
    }));

  it("removal deletes only a prohibited host's facts and pages, keeps the place, dish and event log, and records fingerprints", () =>
    tx(async (c) => {
      const w = await world(c);
      const gone = await w.page("gone-holds.test");
      const kept = await w.page("kept-holds.test");
      await w.protein(gone);
      await w.submit(gone, { kind: "address", value: { street: "7 Holds St", postcode: "02116" } });
      const keptFact = await w.protein(kept);
      expect((await err(c, "select staging.remove_source_content('gone-holds.test', 'x', 'y')")).message).toMatch(/STAGING_REMOVAL_NEEDS_PROHIBITION/);
      await access(c, "gone-holds.test", "prohibits");
      const id = await one(c, "staging.remove_source_content('gone-holds.test', 'Terms prohibit our use', 'Owner decision')");
      const audit = (await c.query("select host, facts, source_pages, url_sha256 from staging.removals where id = $1", [id])).rows[0];
      expect(audit).toMatchObject({ host: "gone-holds.test", facts: 2, source_pages: 1 });
      expect(audit.url_sha256).toEqual([(await c.query("select encode(sha256(convert_to('https://www.gone-holds.test/menu', 'UTF8')), 'hex') h")).rows[0].h]);
      expect((await c.query("select count(*)::int n from staging.source_pages where id = $1", [gone])).rows[0].n).toBe(0);
      expect((await c.query("select id from staging.facts where place_id = $1", [w.place])).rows.map((r) => r.id)).toEqual([keptFact]);
      expect((await c.query("select count(*)::int n from staging.dishes where id = $1", [w.dish])).rows[0].n).toBe(1);
      expect((await c.query("select count(*)::int n from staging.events where place_id = $1 and action = 'submit_fact'", [w.place])).rows[0].n).toBe(3);
      // Outside a removal, staged history stays permanent.
      expect((await err(c, "delete from staging.facts where id = $1", [keptFact])).message).toMatch(/permanent/);
      expect((await c.query("select current_setting('staging.removal', true) v")).rows[0].v).toBe("off");
    }));

  it("the registry file loads once per entry, www and bare names as one host", () =>
    tx(async (c) => {
      const registry = { reviews: [{ hosts: ["www.file-holds.test", "file-holds.test"], kind: "terms_review", status: "unclear", evidence: "No terms found", reviewer: "Test", reviewedAt: "2026-11-17T00:00:00Z" }] };
      expect(await loadStagingAccess(c, registry)).toBe(1);
      expect(await loadStagingAccess(c, registry)).toBe(0);
      expect((await c.query("select host, status from staging.source_access where host = 'file-holds.test'")).rows).toEqual([{ host: "file-holds.test", status: "unclear" }]);
    }));

  it("the new tables and functions are closed to visitors and members", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const t of ["source_access", "removals"]) {
        expect((await pool.query("select has_table_privilege($1, $2, 'select') s", [role, `staging.${t}`])).rows[0].s).toBe(false);
      }
      for (const f of ["staging.remove_source_content(text, text, text)", "staging.held_sources()", "staging.source_access_state(text)"]) {
        expect((await pool.query("select has_function_privilege($1, $2, 'execute') e", [role, f])).rows[0].e).toBe(false);
      }
    }
  });
});
