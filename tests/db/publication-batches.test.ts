import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../helpers/db";

// Sample-reviewed batches (docs/35). Every test runs inside one transaction that is rolled back.
// Places below are invented (synthetic names and addresses), never real restaurants.

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const FNS = ["batch_review_summary()", "record_batch_approval(uuid, text, boolean, text)"];

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
    [id, `review-${id.slice(0, 8)}@example.test`],
  );
  if (role) await c.query("insert into public.role_assignments (user_id, role) values ($1, $2)", [id, role]);
  return id;
}
/** Runs `sql` as a guest (null) or a member, the way the Data API does. */
async function as(c: PoolClient, uid: string | null, sql: string, params: unknown[] = []) {
  await c.query(`set local role ${uid ? "authenticated" : "anon"}`);
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(uid ? { sub: uid, role: "authenticated" } : { role: "anon" })]);
  const rows = (await c.query(sql, params)).rows;
  await c.query("reset role");
  return rows;
}
/** Like `as`, but expects a refusal and returns it. */
async function refused(c: PoolClient, uid: string | null, sql: string, params: unknown[] = []) {
  await c.query("savepoint s");
  try {
    await as(c, uid, sql, params);
  } catch (e) {
    await c.query("rollback to savepoint s");
    return e as { code: string; message: string };
  }
  throw new Error(`Expected to fail: ${sql}`);
}


const SRC = JSON.stringify([{ key: "overture_places", title: "Test source", attribution: "Test attribution" }]);

/** A frozen batch of `n` invented places with listings; the first `sample` are in its sample. */
async function batch(c: PoolClient, n: number, sample: number) {
  const id = (await c.query("insert into public.publication_batches (name, sample_seed, fingerprint, place_count) values ($1, 'test-seed', $2, $3) returning id",
    [`test-batch-${randomUUID().slice(0, 8)}`, "0".repeat(64), n])).rows[0].id as string;
  const places: string[] = [];
  for (let i = 0; i < n; i++) {
    const cid = randomUUID();
    places.push(cid);
    await c.query(
      `insert into public.identity_review_items (candidate_id, name, street, postcode, lat, lon, queues, sample_seed, evidence, sort_key)
       values ($1, $2, '1 Sample St', '02116', 42.35, -71.07, $3, 'test-seed', '{}'::jsonb, 'zzz')`,
      [cid, `Test Batch Place ${i}`, i < sample ? ["sample"] : ["possible_duplicate"]]);
    await c.query(
      `insert into public.place_listings (candidate_id, slug, name, street, locality, postcode, area, lat, lon, category, identity_status, sources, built_from, publication_batch)
       values ($1, $2, $3, '1 Sample St', 'Boston', '02116', null, 42.35, -71.07, 'Restaurant', 'corroborated', $4, 'test', $5)`,
      [cid, `test-batch-${cid.slice(0, 8)}`, `Test Batch Place ${i}`, SRC, id]);
    await c.query("insert into public.publication_batch_places (batch_id, candidate_id, in_sample) values ($1, $2, $3)", [id, cid, i < sample]);
  }
  return { id, places };
}
async function decideAll(c: PoolClient, founder: string, ids: string[], decision = "verify_identity") {
  for (const id of ids) await as(c, founder, "select public.record_identity_review($1, $2, $3)", [id, decision, decision === "reject" ? "closed" : null]);
}
const status = async (c: PoolClient, founder: string, id: string) =>
  ((await as(c, founder, "select public.batch_review_summary() s"))[0].s as J).batches.find((b: J) => b.id === id) as J;
const approve = (c: PoolClient, uid: string, id: string, ack = true) => as(c, uid, "select public.record_batch_approval($1, 'approve', $2, 'test') r", [id, ack]);
async function switchOn(c: PoolClient) {
  await c.query("update app.platform_switches set enabled = true where name = 'real_place_listings'");
}
const publicNames = async (c: PoolClient) =>
  (((await as(c, null, "select public.place_directory($1::jsonb) d", [JSON.stringify({ q: "Test Batch Place", limit: 50 })]))[0].d as J).items as J[]).map((i) => i.name).sort();

afterAll(async () => {
  await pool.end();
});

describe("the confidence calculation and the approved rule", () => {
  it("matches the exact one-sided 95% bounds in docs/34", async () => {
    const r = await pool.query("select k, n, app.binomial_upper_95(k, n)::float b from (values (0,61),(1,61),(2,61),(3,61),(0,120),(2,120),(0,200),(2,125)) v(k, n)");
    expect(r.rows.map((x: J) => x.b)).toEqual([0.0479, 0.0754, 0.0996, 0.1222, 0.0247, 0.0515, 0.0149, 0.0495]);
  });
  it("passes only 0 problems in at least 61, or at most 2 in at least 125, with every place checked", async () => {
    // Founder decision 17 Nov 05:49 UTC: 2 in 120 (5.15%) misses the 5% target, so the larger size is 125 (4.95%).
    const r = await pool.query(`select app.sample_passes(k, n, c) p from (values (0,61,61),(1,61,61),(0,61,60),(2,125,125),(3,125,125),(0,60,60),(1,200,200),(2,120,120),(1,120,120),(2,124,124),(2,125,124)) v(k, n, c)`);
    expect(r.rows.map((x: J) => x.p)).toEqual([true, false, false, true, false, false, true, false, false, false, false]);
  });
});

describe("batch review is the founder's alone", () => {
  it("the tables are closed with RLS on, and a guest cannot call the functions", async () => {
    for (const t of ["publication_batches", "publication_batch_places", "batch_approvals"]) {
      for (const role of ["anon", "authenticated"]) {
        const p = await pool.query("select has_table_privilege($1, $2, 'select') s, has_table_privilege($1, $2, 'insert') i", [role, `public.${t}`]);
        expect(p.rows[0]).toEqual({ s: false, i: false });
      }
      expect((await pool.query("select relrowsecurity r from pg_class where oid = $1::regclass", [`public.${t}`])).rows[0].r).toBe(true);
    }
    for (const f of FNS) expect((await pool.query("select has_function_privilege('anon', $1, 'execute') g", [`public.${f}`])).rows[0].g).toBe(false);
  });

  it("a member, curator, moderator or admin without the publisher role cannot see or approve a batch", async () => {
    await tx(async (c) => {
      const founder = await user(c, "publisher");
      const b = await batch(c, 3, 3);
      await decideAll(c, founder, b.places);
      for (const role of [undefined, "curator", "moderator", "admin"]) {
        const uid = await user(c, role);
        expect((await refused(c, uid, "select public.batch_review_summary()")).message).toBe("FOUNDER_ONLY");
        expect((await refused(c, uid, "select public.record_batch_approval($1, 'approve', true)", [b.id])).message).toBe("FOUNDER_ONLY");
      }
    });
  });
});

describe("gate 1: approving a batch", () => {
  it("is refused until every sampled place is checked and the sample passes; a small sample never passes", async () => {
    await tx(async (c) => {
      const founder = await user(c, "publisher");
      const b = await batch(c, 64, 61);
      expect((await refused(c, founder, "select public.record_batch_approval($1, 'approve', true)", [b.id])).message).toBe("SAMPLE_NOT_PASSED");
      await decideAll(c, founder, b.places.slice(0, 60));
      let s = await status(c, founder, b.id);
      expect(s).toMatchObject({ sampleSize: 61, checked: 60, problems: 0, passes: false, approved: false });
      await decideAll(c, founder, [b.places[60]], "reject");
      s = await status(c, founder, b.id);
      expect(s).toMatchObject({ checked: 61, problems: 1, passes: false, upperBound: 0.0754, excluded: 1 });
      expect((await refused(c, founder, "select public.record_batch_approval($1, 'approve', true)", [b.id])).message).toBe("SAMPLE_NOT_PASSED");
      // A later "identity correct" on that place replaces the problem; the history keeps both.
      await decideAll(c, founder, [b.places[60]]);
      s = await status(c, founder, b.id);
      expect(s).toMatchObject({ checked: 61, problems: 0, passes: true, upperBound: 0.0479 });
    });
  });

  it("needs the founder's acknowledgement, is permanent, and changes no place's identity status", async () => {
    await tx(async (c) => {
      const founder = await user(c, "publisher");
      const b = await batch(c, 63, 61);
      await decideAll(c, founder, b.places.slice(0, 61));
      expect((await refused(c, founder, "select public.record_batch_approval($1, 'approve', false)", [b.id])).message).toBe("ACKNOWLEDGEMENT_REQUIRED");
      await approve(c, founder, b.id);
      expect((await refused(c, founder, "select public.record_batch_approval($1, 'approve', true)", [b.id])).message).toBe("ALREADY_APPROVED");
      const s = await status(c, founder, b.id);
      expect(s).toMatchObject({ approved: true });
      expect(s.history[0]).toMatchObject({ decision: "approve", sampleSize: 61, checked: 61, problems: 0, upperBound: 0.0479, note: "test" });
      // The two places outside the sample are still only corroborated, and nothing is public.
      const ls = (await c.query("select identity_status, visibility from public.place_listings where candidate_id = any($1::uuid[])", [b.places.slice(61)])).rows;
      expect(ls).toEqual([{ identity_status: "corroborated", visibility: "preview" }, { identity_status: "corroborated", visibility: "preview" }]);
      for (const sql of ["update public.batch_approvals set decision = 'withdraw' where batch_id = $1", "delete from public.batch_approvals where batch_id = $1"]) {
        await c.query("savepoint s");
        const e = await c.query(sql, [b.id]).then(() => null, (x) => x as { message: string });
        await c.query("rollback to savepoint s");
        expect(e?.message).toBe("Batch decisions are permanent");
      }
      // A batch with a decision is frozen: no place or sample change.
      await c.query("savepoint s");
      const e = await c.query("update public.publication_batch_places set in_sample = true where batch_id = $1 and candidate_id = $2", [b.id, b.places[62]]).then(() => null, (x) => x as { message: string });
      await c.query("rollback to savepoint s");
      expect(e?.message).toMatch(/cannot change its places or its sample/);
    });
  });
});

describe("gate 2 and what may be public", () => {
  it("nothing from an approved batch is public while the switch is off; making it public is refused", async () => {
    await tx(async (c) => {
      const founder = await user(c, "publisher");
      const b = await batch(c, 62, 61);
      await decideAll(c, founder, b.places.slice(0, 61));
      await approve(c, founder, b.id);
      await c.query("savepoint s");
      const e = await c.query("update public.place_listings set visibility = 'public' where candidate_id = $1", [b.places[61]]).then(() => null, (x) => x as { message: string });
      await c.query("rollback to savepoint s");
      expect(e?.message).toBe("Real place listings are locked");
      expect(await publicNames(c)).toEqual([]);
    });
  });

  it("with both gates, an approved batch's places may be public; a rejected place, a withdrawn approval or the switch turned off hides them at once", async () => {
    await tx(async (c) => {
      const founder = await user(c, "publisher");
      const b = await batch(c, 63, 61);
      await decideAll(c, founder, b.places.slice(0, 61));
      await switchOn(c);
      // Gate 2 alone is not enough.
      await c.query("savepoint s");
      const e = await c.query("update public.place_listings set visibility = 'public' where candidate_id = $1", [b.places[61]]).then(() => null, (x) => x as { message: string });
      await c.query("rollback to savepoint s");
      expect(e?.message).toMatch(/Only a founder-verified place or a place in a currently approved batch/);
      await approve(c, founder, b.id);
      await c.query("update public.place_listings set visibility = 'public' where candidate_id = any($1::uuid[])", [b.places.slice(61)]);
      expect(await publicNames(c)).toEqual(["Test Batch Place 61", "Test Batch Place 62"]);
      // The founder rejects one place: it disappears from public results without any other change.
      await decideAll(c, founder, [b.places[62]], "reject");
      expect(await publicNames(c)).toEqual(["Test Batch Place 61"]);
      // Withdrawing gate 1 hides the whole batch.
      await as(c, founder, "select public.record_batch_approval($1, 'withdraw', false, 'test')", [b.id]);
      expect(await publicNames(c)).toEqual([]);
      await approve(c, founder, b.id);
      expect(await publicNames(c)).toEqual(["Test Batch Place 61"]);
      // Turning gate 2 off hides everything.
      await c.query("update app.platform_switches set enabled = false where name = 'real_place_listings'");
      expect(await publicNames(c)).toEqual([]);
    });
  });

  it("a place outside every approved batch needs the founder's own verification", async () => {
    await tx(async (c) => {
      const founder = await user(c, "publisher");
      const b = await batch(c, 62, 61); // never approved
      await switchOn(c);
      await c.query("savepoint s");
      const e = await c.query("update public.place_listings set visibility = 'public' where candidate_id = $1", [b.places[61]]).then(() => null, (x) => x as { message: string });
      await c.query("rollback to savepoint s");
      expect(e).not.toBeNull();
      await decideAll(c, founder, [b.places[61]]);
      await c.query("update public.place_listings set visibility = 'public' where candidate_id = $1", [b.places[61]]);
      expect(await publicNames(c)).toEqual(["Test Batch Place 61"]);
    });
  });
});
