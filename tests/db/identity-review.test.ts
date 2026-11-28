import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../helpers/db";

// Founder identity review (docs/33). Every test runs inside one transaction that is rolled back.
// Places below are invented (synthetic names and addresses), never real restaurants.

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const FNS = ["identity_review_summary()", "identity_review_list(text, integer)", "identity_review_item(uuid, text)", "record_identity_review(uuid, text, text, text, text)"];

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

async function addItem(c: PoolClient, o: J = {}) {
  const id = randomUUID();
  await c.query(
    `insert into public.identity_review_items (candidate_id, name, street, postcode, area, lat, lon, queues, sample_seed, evidence, active, sort_key)
     values ($1, $2, '1 Sample St', '02116', 'Back Bay / Prudential', 42.35, -71.07, $3, $4, $5, $6, $7)`,
    [id, o.name ?? "Test Place Lantern", o.queues ?? ["possible_duplicate"], o.seed ?? null, JSON.stringify({ reasons: [], records: [], lookalikes: [] }), o.active ?? true, o.sort ?? "aaa-test"],
  );
  if (o.listing) {
    await c.query(
      `insert into public.place_listings (candidate_id, slug, name, street, locality, postcode, area, lat, lon, category, identity_status, sources, visibility, built_from)
       values ($1, $2, 'Test Place Lantern', '1 Sample St', 'Boston', '02116', 'Back Bay / Prudential', 42.35, -71.07, 'Restaurant', 'corroborated', '[{"key":"overture_places","title":"Test source","attribution":"Test attribution"}]', $3, 'test')`,
      [id, `test-place-${id.slice(0, 8)}`, o.listing],
    );
  }
  return id;
}
const record = (c: PoolClient, uid: string | null, id: string, decision: string, reason: string | null = null, note: string | null = null, queue: string | null = null) =>
  as(c, uid, "select public.record_identity_review($1, $2, $3, $4, $5) r", [id, decision, reason, note, queue]).then((r) => r[0].r as J);
const listingOf = (c: PoolClient, id: string) =>
  c.query("select identity_status, menu_status, visibility from public.place_listings where candidate_id = $1", [id]).then((r) => r.rows[0] as J);

afterAll(async () => {
  await pool.end();
});

describe("identity review is closed to everyone but the founder", () => {
  it("both tables are closed to guests and members, with RLS on", async () => {
    for (const t of ["identity_review_items", "identity_reviews"]) {
      for (const role of ["anon", "authenticated"]) {
        const p = await pool.query("select has_table_privilege($1, $2, 'select') s, has_table_privilege($1, $2, 'insert') i", [role, `public.${t}`]);
        expect(p.rows[0]).toEqual({ s: false, i: false });
      }
      const r = await pool.query("select relrowsecurity from pg_class where oid = $1::regclass", [`public.${t}`]);
      expect(r.rows[0].relrowsecurity).toBe(true);
    }
  });

  it("a guest cannot call any review function", async () => {
    for (const f of FNS) {
      const r = await pool.query("select has_function_privilege('anon', $1, 'execute') g", [`public.${f}`]);
      expect(r.rows[0].g).toBe(false);
    }
  });

  it("a member, a curator, a moderator and an admin without the publisher role get nothing", async () => {
    await tx(async (c) => {
      const id = await addItem(c);
      for (const role of [undefined, "curator", "moderator", "admin"]) {
        const uid = await user(c, role);
        for (const sql of ["select public.identity_review_summary()", "select public.identity_review_list('possible_duplicate', 0)", `select public.identity_review_item('${id}', null)`]) {
          expect((await refused(c, uid, sql)).message).toBe("FOUNDER_ONLY");
        }
        expect((await refused(c, uid, "select public.record_identity_review($1, 'verify_identity')", [id])).message).toBe("FOUNDER_ONLY");
      }
      expect((await c.query("select count(*)::int n from public.identity_reviews where candidate_id = $1", [id])).rows[0].n).toBe(0);
    });
  });

  it("a decision cannot be written straight into the table by anyone without the publisher role", async () => {
    await tx(async (c) => {
      const id = await addItem(c);
      const curator = await user(c, "curator");
      await c.query("savepoint s");
      const e = await c
        .query("insert into public.identity_reviews (candidate_id, decision, queue, decided_by) values ($1, 'verify_identity', 'x', $2)", [id, curator])
        .then(() => null, (x) => x as { message: string });
      await c.query("rollback to savepoint s");
      expect(e?.message).toMatch(/Only the founder/);
    });
  });
});

describe("the founder decides one place at a time, permanently", () => {
  it("there is no bulk call: every review function takes at most one place and no list", async () => {
    const r = await pool.query(
      `select p.proname, pg_get_function_identity_arguments(p.oid) a from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and (p.proname like 'identity_review%' or p.proname = 'record_identity_review')`,
    );
    expect(r.rows.length).toBe(4);
    for (const row of r.rows) expect(row.a).not.toMatch(/\[\]|jsonb|json\b/);
  });

  it("queue, list and item show the place; 'Identity correct' verifies only that listing, never publishes, never touches the menu", async () => {
    await tx(async (c) => {
      const founder = await user(c, "publisher");
      const q = `test_queue_${randomUUID().slice(0, 8)}`;
      const a = await addItem(c, { queues: ["sample", q], seed: "test-seed", listing: "preview", sort: "aaa-1" });
      const b = await addItem(c, { queues: ["sample", q], seed: "test-seed", listing: "preview", sort: "aaa-2", name: "Test Place Harbour" });
      const before = (await as(c, founder, "select public.identity_review_summary() s"))[0].s as J;
      const list = (await as(c, founder, "select public.identity_review_list($1, 0) l", [q]))[0].l as J;
      expect(list).toMatchObject({ total: 2, decided: 0 });
      expect(list.items.map((i: J) => i.candidateId)).toEqual([a, b]);
      const item = (await as(c, founder, "select public.identity_review_item($1, $2) i", [a, q]))[0].i as J;
      expect(item.history).toEqual([]);
      expect(item.listing).toEqual({ identityStatus: "corroborated", menuStatus: "not_checked", visibility: "preview" });
      expect(item.next).toBe(b);

      await record(c, founder, a, "verify_identity", null, "Checked the street view", "sample");
      expect(await listingOf(c, a)).toEqual({ identity_status: "verified", menu_status: "not_checked", visibility: "preview" });
      expect(await listingOf(c, b)).toEqual({ identity_status: "corroborated", menu_status: "not_checked", visibility: "preview" });

      const after = (await as(c, founder, "select public.identity_review_summary() s"))[0].s as J;
      expect(after.decisions.verified).toBe(before.decisions.verified + 1);
      expect(after.queues.find((x: J) => x.queue === q)).toEqual({ queue: q, total: 2, decided: 1 });
      expect(((await as(c, founder, "select public.identity_review_list($1, 0) l", [q]))[0].l as J).items[0].candidateId).toBe(b); // undecided first
      const again = (await as(c, founder, "select public.identity_review_item($1, 'sample') i", [a]))[0].i as J;
      expect(again.history).toHaveLength(1);
      expect(again.history[0]).toMatchObject({ decision: "verify_identity", note: "Checked the street view", queue: "sample" });
      // The sample decision is tagged with its sample; no other place changed.
      expect((await c.query("select sample_seed from public.identity_reviews where candidate_id = $1", [a])).rows[0].sample_seed).toBe("test-seed");
      expect((await c.query("select count(*)::int n from public.place_listings where visibility = 'public'")).rows[0].n).toBe(0);
    });
  });

  it("reject needs a reason and withdraws the preview listing; a later decision replaces it and both stay in history", async () => {
    await tx(async (c) => {
      const founder = await user(c, "publisher");
      const id = await addItem(c, { listing: "preview" });
      expect((await refused(c, founder, "select public.record_identity_review($1, 'reject')", [id])).message).toBe("REASON_REQUIRED");
      expect((await refused(c, founder, "select public.record_identity_review($1, 'verify_identity', 'closed')", [id])).message).toBe("REASON_REQUIRED");
      expect((await refused(c, founder, "select public.record_identity_review($1, 'publish')", [id])).message).toBe("INVALID_DECISION");
      expect((await refused(c, founder, "select public.record_identity_review($1, 'verify_identity', null, $2)", [id, "x".repeat(1001)])).message).toBe("NOTE_TOO_LONG");
      expect((await refused(c, founder, "select public.record_identity_review($1, 'verify_identity', null, null, 'sample')", [id])).message).toBe("INVALID_QUEUE");

      await record(c, founder, id, "reject", "closed");
      expect((await listingOf(c, id)).visibility).toBe("withdrawn");
      await record(c, founder, id, "needs_more_evidence", null, "Ask about the opening date");
      expect((await listingOf(c, id)).visibility).toBe("withdrawn");
      await record(c, founder, id, "verify_identity");
      expect(await listingOf(c, id)).toEqual({ identity_status: "verified", menu_status: "not_checked", visibility: "preview" });

      const item = (await as(c, founder, "select public.identity_review_item($1) i", [id]))[0].i as J;
      expect(item.history.map((h: J) => h.decision)).toEqual(["verify_identity", "needs_more_evidence", "reject"]);
      expect(item.history[2].reason).toBe("closed");
    });
  });

  it("decisions can never be changed or deleted, even by the database owner", async () => {
    await tx(async (c) => {
      const founder = await user(c, "publisher");
      const id = await addItem(c);
      await record(c, founder, id, "verify_identity");
      for (const sql of ["update public.identity_reviews set decision = 'reject', reason = 'closed' where candidate_id = $1", "delete from public.identity_reviews where candidate_id = $1"]) {
        await c.query("savepoint s");
        const e = await c.query(sql, [id]).then(() => null, (x) => x as { message: string });
        await c.query("rollback to savepoint s");
        expect(e?.message).toBe("Identity decisions are permanent");
      }
    });
  });

  it("a place that left every queue cannot be decided; a public listing is never touched", async () => {
    await tx(async (c) => {
      const founder = await user(c, "publisher");
      const gone = await addItem(c, { active: false });
      expect((await refused(c, founder, "select public.record_identity_review($1, 'verify_identity')", [gone])).message).toBe("NOT_FOUND");
      // A listing withdrawn earlier is not published by a later "Identity correct": it returns to the private preview.
      const back = await addItem(c, { listing: "withdrawn" });
      await record(c, founder, back, "verify_identity");
      expect((await listingOf(c, back)).visibility).toBe("preview");
    });
  });
});
