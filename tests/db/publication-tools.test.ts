import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../helpers/db";
import { build, publicationStatus, setPlaceSwitch, setPublication } from "../../scripts/catalog-preview.mjs";

// Publication tools (docs/38). Every test runs inside one transaction that is rolled back.
// Places below are invented (synthetic names and addresses), never real restaurants.

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const SRC = JSON.stringify([{ key: "overture_places", title: "Test source", attribution: "Test attribution" }]);

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
    [id, `pub-${id.slice(0, 8)}@example.test`],
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
/**
 * A frozen batch of `n` invented places. The first `sample` are its sample, each checked "identity correct"
 * by the founder (which also makes that place founder-verified); the rest are corroborated only.
 */
async function checkedBatch(c: PoolClient, founder: string, n: number, sample = n) {
  const name = `test-pub-${randomUUID().slice(0, 8)}`;
  const id = (await c.query("insert into public.publication_batches (name, sample_seed, fingerprint, place_count) values ($1, 'test-seed', $2, $3) returning id",
    [name, "0".repeat(64), n])).rows[0].id as string;
  const places: string[] = [];
  for (let i = 0; i < n; i++) {
    const cid = randomUUID();
    places.push(cid);
    await c.query(
      `insert into public.identity_review_items (candidate_id, name, street, postcode, lat, lon, queues, sample_seed, evidence, sort_key)
       values ($1, $2, '1 Sample St', '02116', 42.35, -71.07, $3, 'test-seed', '{}'::jsonb, 'zzz')`, [cid, `Test Pub Place ${i}`, i < sample ? ["sample"] : ["possible_duplicate"]]);
    await c.query(
      `insert into public.place_listings (candidate_id, slug, name, street, locality, postcode, area, lat, lon, category, identity_status, sources, built_from, publication_batch)
       values ($1, $2, $3, '1 Sample St', 'Boston', '02116', null, 42.35, -71.07, 'Restaurant', 'corroborated', $4, 'test', $5)`,
      [cid, `test-pub-${cid.slice(0, 8)}`, `Test Pub Place ${i}`, SRC, id]);
    await c.query("insert into public.publication_batch_places (batch_id, candidate_id, in_sample) values ($1, $2, $3)", [id, cid, i < sample]);
  }
  for (const cid of places.slice(0, sample)) await as(c, founder, "select public.record_identity_review($1, 'verify_identity', null)", [cid]);
  return { id, name, places };
}
const visibility = async (c: PoolClient, ids: string[]) =>
  (await c.query("select visibility from public.place_listings where candidate_id = any($1::uuid[]) order by name", [ids])).rows.map((r: J) => r.visibility);
const guestSees = async (c: PoolClient) =>
  (((await as(c, null, "select public.place_directory($1::jsonb) d", [JSON.stringify({ q: "Test Pub Place", limit: 1 })]))[0].d as J).total) as number;
const events = async (c: PoolClient) => (await c.query("select action, scope, listings, run_by from public.publication_events order by id")).rows;

afterAll(async () => {
  await pool.end();
});

describe("the publication log", () => {
  it("is closed to the app and cannot be changed or deleted", async () => {
    for (const role of ["anon", "authenticated"]) {
      const p = await pool.query("select has_table_privilege($1, 'public.publication_events', 'select') s, has_table_privilege($1, 'public.publication_events', 'insert') i", [role]);
      expect(p.rows[0]).toEqual({ s: false, i: false });
    }
    expect((await pool.query("select relrowsecurity r from pg_class where oid = 'public.publication_events'::regclass")).rows[0].r).toBe(true);
    await tx(async (c) => {
      await c.query("insert into public.publication_events (action, scope, run_by) values ('switch_off', 'switch', 'test')");
      await c.query("savepoint s");
      await expect(c.query("update public.publication_events set run_by = 'someone else'")).rejects.toThrow("The publication log is permanent");
      await c.query("rollback to savepoint s");
      await expect(c.query("delete from public.publication_events")).rejects.toThrow("The publication log is permanent");
    });
  });
});

describe("the real-place switch", () => {
  it("a dry run changes nothing; a confirmed change is logged with who ran it, however it is made", async () => {
    await tx(async (c) => {
      const before = (await events(c)).length;
      expect(await setPlaceSwitch(c, { on: true, by: "Test operator", ownTransaction: false })).toEqual({ changed: true, applied: false });
      expect((await c.query("select enabled from app.platform_switches where name = 'real_place_listings'")).rows[0].enabled).toBe(false);
      expect((await events(c)).length).toBe(before);
      await setPlaceSwitch(c, { on: true, by: "Test operator", note: "launch", confirm: true, ownTransaction: false });
      // Each command is its own transaction; here the test's transaction continues, so clear the name.
      await c.query("select set_config('app.publication_run_by', '', true)");
      await c.query("update app.platform_switches set enabled = false where name = 'real_place_listings'");
      expect((await events(c)).slice(before)).toEqual([
        { action: "switch_on", scope: "switch", listings: 0, run_by: "Test operator" },
        { action: "switch_off", scope: "switch", listings: 0, run_by: "postgres" },
      ]);
    });
  });
  it("needs an operator name", async () => {
    await tx(async (c) => {
      await expect(setPlaceSwitch(c, { on: true, by: "", ownTransaction: false })).rejects.toThrow("--by");
    });
  });
});

describe("publish and unpublish", () => {
  it("publishes nothing while the switch is off, and from a batch that is not approved only the places the founder checked", async () => {
    await tx(async (c) => {
      const founder = await user(c, "publisher");
      const b = await checkedBatch(c, founder, 3, 1);
      await expect(setPublication(c, { action: "publish", name: b.name, by: "t", confirm: true, ownTransaction: false })).rejects.toThrow("switch is off");
      await c.query("update app.platform_switches set enabled = true where name = 'real_place_listings'");
      expect(await setPublication(c, { action: "publish", name: b.name, by: "t", confirm: true, ownTransaction: false })).toEqual({ listings: 1, applied: true });
      expect(await visibility(c, b.places)).toEqual(["public", "preview", "preview"]);
    });
  });

  it("an approved batch: a dry run changes nothing, then publish shows the places to guests, and unpublish takes them back", async () => {
    await tx(async (c) => {
      const founder = await user(c, "publisher");
      // The approved rule needs at least 61 checked places.
      const b = await checkedBatch(c, founder, 64, 61);
      await as(c, founder, "select public.record_batch_approval($1, 'approve', true, 'test')", [b.id]);
      await c.query("update app.platform_switches set enabled = true where name = 'real_place_listings'");
      const before = (await events(c)).length;
      expect(await setPublication(c, { action: "publish", name: b.name, by: "t", ownTransaction: false })).toEqual({ listings: 64, applied: false });
      expect(await guestSees(c)).toBe(0);
      expect((await events(c)).length).toBe(before);

      expect(await setPublication(c, { action: "publish", name: b.name, by: "Test operator", confirm: true, ownTransaction: false })).toEqual({ listings: 64, applied: true });
      expect(await guestSees(c)).toBe(64);
      const st = await publicationStatus(c, { name: b.name });
      expect(st).toMatchObject({ switchOn: true, public: 64, preview: 0, public_but_hidden: 0 });

      // Withdrawing the approval hides the three places nobody checked, at once, before anyone unpublishes.
      // The 61 the founder checked one by one are founder-verified and stay.
      await as(c, founder, "select public.record_batch_approval($1, 'withdraw', false, 'test')", [b.id]);
      expect(await guestSees(c)).toBe(61);
      expect((await publicationStatus(c, { name: b.name })).public_but_hidden).toBe(3);
      // The switch hides everything.
      await c.query("update app.platform_switches set enabled = false where name = 'real_place_listings'");
      expect(await guestSees(c)).toBe(0);

      expect(await setPublication(c, { action: "unpublish", name: b.name, by: "Test operator", confirm: true, ownTransaction: false })).toEqual({ listings: 64, applied: true });
      expect(new Set(await visibility(c, b.places))).toEqual(new Set(["preview"]));
      expect((await events(c)).slice(before)).toEqual([
        { action: "publish", scope: "batch", listings: 64, run_by: "Test operator" },
        { action: "switch_off", scope: "switch", listings: 0, run_by: "postgres" },
        { action: "unpublish", scope: "batch", listings: 64, run_by: "Test operator" },
      ]);
    });
  });

  it("never publishes everything at once, and asks for exactly one scope", async () => {
    await tx(async (c) => {
      await expect(setPublication(c, { action: "publish", all: true, by: "t", ownTransaction: false })).rejects.toThrow("not offered");
      await expect(setPublication(c, { action: "publish", by: "t", ownTransaction: false })).rejects.toThrow("exactly one");
      await expect(setPublication(c, { action: "unpublish", name: "x", all: true, by: "t", ownTransaction: false })).rejects.toThrow("exactly one");
    });
  });

  it("a public place that no longer passes every check leaves the public list at the next build", async () => {
    await tx(async (c) => {
      const founder = await user(c, "publisher");
      const b = await checkedBatch(c, founder, 61);
      await as(c, founder, "select public.record_batch_approval($1, 'approve', true, 'test')", [b.id]);
      await c.query("update app.platform_switches set enabled = true where name = 'real_place_listings'");
      await setPublication(c, { action: "publish", name: b.name, by: "t", confirm: true, ownTransaction: false });
      // These invented places have no import candidate, so to the build they have left the preview.
      await build(c, { ownTransaction: false });
      expect(new Set(await visibility(c, b.places))).toEqual(new Set(["withdrawn"]));
      expect(await guestSees(c)).toBe(0);
    });
  });
});
