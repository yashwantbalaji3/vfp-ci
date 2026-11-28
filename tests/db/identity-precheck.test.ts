import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pool } from "../helpers/db";

// Automatic identity pre-check in the founder's review (docs/51). Every test runs inside one rolled-back
// transaction. Places below are invented (synthetic names and addresses), never real restaurants.

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
    [id, `precheck-${id.slice(0, 8)}@example.test`],
  );
  if (role) await c.query("insert into public.role_assignments (user_id, role) values ($1, $2)", [id, role]);
  return id;
}
async function as(c: PoolClient, uid: string, sql: string, params: unknown[] = []) {
  await c.query("set local role authenticated");
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
  const rows = (await c.query(sql, params)).rows;
  await c.query("reset role");
  return rows;
}
async function addItem(c: PoolClient, name: string, precheck: J | null) {
  const id = randomUUID();
  const evidence = { reasons: [], records: [], lookalikes: [], ...(precheck ? { precheck } : {}) };
  await c.query(
    `insert into public.identity_review_items (candidate_id, name, street, postcode, area, lat, lon, queues, sample_seed, evidence, active, sort_key)
     values ($1, $2, '1 Sample St', '02116', 'Back Bay / Prudential', 42.35, -71.07, '{sample}', 'precheck-test-seed', $3, true, $2)`,
    [id, name, JSON.stringify(evidence)],
  );
  return id;
}

describe("the automatic pre-check in the founder's review", () => {
  it("the queue list and the summary show the stored pre-check; nothing is decided by it", () =>
    tx(async (c) => {
      await c.query("update public.identity_review_items set active = false"); // only this test's places count
      const founder = await user(c, "publisher");
      const a = await addItem(c, "Test Place Agree", { level: "agree", concerns: [], version: 1 });
      const b = await addItem(c, "Test Place Look", { level: "look", concerns: ["website"], version: 1 });
      await addItem(c, "Test Place Unbuilt", null);
      const [{ s }] = await as(c, founder, "select public.identity_review_summary() s");
      expect(s.sample).toMatchObject({ total: 3, checked: 0, correct: 0, problems: 0, precheckAgree: 1, precheckLook: 1 });
      const [{ l }] = await as(c, founder, "select public.identity_review_list('sample', 0) l");
      const by = new Map(l.items.map((i: J) => [i.name, i]));
      expect((by.get("Test Place Agree") as J).precheck).toEqual({ level: "agree", concerns: [] });
      expect((by.get("Test Place Look") as J).precheck).toEqual({ level: "look", concerns: ["website"] });
      expect((by.get("Test Place Unbuilt") as J).precheck).toBeNull();
      expect(l.items.every((i: J) => i.decision === null)).toBe(true);
      const decided = await c.query("select count(*)::int n from public.identity_reviews where candidate_id = any($1::uuid[])", [[a, b]]);
      expect(decided.rows[0].n).toBe(0);
    }));

  it("places to look at closely come first in the list and as 'next place'; only the order changes (docs/57)", () =>
    tx(async (c) => {
      await c.query("update public.identity_review_items set active = false");
      const founder = await user(c, "publisher");
      // Names set the usual order (sort_key): A, B, C. B and C need a closer look.
      const a = await addItem(c, "Test Place A agree", { level: "agree", concerns: [], version: 1 });
      const b = await addItem(c, "Test Place B look", { level: "look", concerns: ["website"], version: 1 });
      const d = await addItem(c, "Test Place C look", { level: "look", concerns: ["name"], version: 1 });
      const e = await addItem(c, "Test Place D unbuilt", null);
      const [{ l }] = await as(c, founder, "select public.identity_review_list('sample', 0) l");
      expect(l.items.map((i: J) => i.candidateId)).toEqual([b, d, a, e]);
      const [{ i }] = await as(c, founder, "select public.identity_review_item($1, 'sample') i", [a]);
      expect(i.next).toBe(b);
      const [{ i: fromB }] = await as(c, founder, "select public.identity_review_item($1, 'sample') i", [b]);
      expect(fromB.next).toBe(d);
      // "Next" is the first undecided place other than this one, so from C it is B until B is decided.
      const [{ i: fromC }] = await as(c, founder, "select public.identity_review_item($1, 'sample') i", [d]);
      expect(fromC.next).toBe(b);
      // Nothing was decided by reading or ordering.
      const decided = await c.query("select count(*)::int n from public.identity_reviews where candidate_id = any($1::uuid[])", [[a, b, d, e]]);
      expect(decided.rows[0].n).toBe(0);
    }));

  it("a stored level other than agree or look is not shown", () =>
    tx(async (c) => {
      await c.query("update public.identity_review_items set active = false");
      const founder = await user(c, "publisher");
      await addItem(c, "Test Place Odd", { level: "verified", concerns: [] });
      const [{ l }] = await as(c, founder, "select public.identity_review_list('sample', 0) l");
      expect(l.items[0].precheck).toBeNull();
      const [{ s }] = await as(c, founder, "select public.identity_review_summary() s");
      expect(s.sample).toMatchObject({ precheckAgree: 0, precheckLook: 0 });
    }));

  it("members and other staff still cannot read the review, pre-check included", () =>
    tx(async (c) => {
      for (const role of [undefined, "curator", "admin"]) {
        const who = await user(c, role);
        await c.query("savepoint s");
        const e = await as(c, who, "select public.identity_review_list('sample', 0)").then(() => null, (x: { message: string }) => x.message);
        await c.query("rollback to savepoint s");
        expect(e).toMatch(/FOUNDER_ONLY/);
      }
    }));
});
