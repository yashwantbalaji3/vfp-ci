import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../helpers/db";

// Tester feedback (owner direction 23 Nov 2026 19:34 UTC item 4; migration 20261123000300). Each test runs
// inside ONE rolled-back transaction.

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
const one = async (c: PoolClient, sql: string, params: unknown[] = []) => (await c.query(`select ${sql} as r`, params)).rows[0].r;
async function user(c: PoolClient, role?: string) {
  const id = randomUUID();
  await c.query(
    `insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}', '{}', now(), now())`,
    [id, `beta-${id.slice(0, 8)}@example.test`],
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
const asErr = async (c: PoolClient, uid: string | null, sql: string, params: unknown[] = []) => {
  await c.query("savepoint s");
  try {
    await as(c, uid, sql, params);
  } catch (e) {
    await c.query("rollback to savepoint s");
    return (e as Error).message;
  }
  throw new Error(`Expected to fail: ${sql}`);
};
const week = { used: "a_few_times", labels: "matched", trust: 4, recommend: 5, missing: "More Chinatown places" };
const send = (c: PoolClient, uid: string, form: string, a: J) => as(c, uid, "select public.beta_feedback_send($1, $2::jsonb) r", [form, JSON.stringify(a)]).then((r) => r[0].r as J);

afterAll(async () => {
  await pool.end();
});

describe("tester feedback", () => {
  it("saves a member's answers, refuses a second weekly answer within 6 days, and accepts notes", () =>
    tx(async (c) => {
      const m = await user(c);
      const r = await send(c, m, "week", week);
      expect(r.testerCode).toMatch(/^[0-9a-f]{6}$/);
      expect(await asErr(c, m, "select public.beta_feedback_send('week', $1::jsonb)", [JSON.stringify(week)])).toBe("ALREADY_SENT");
      await send(c, m, "note", { text: "The map was slow", page: "/places" });
      const mine = await as(c, m, "select form from public.beta_feedback order by created_at");
      expect(mine.map((x) => x.form)).toEqual(["week", "note"]);
    }));

  it("refuses answers outside the fixed choices, extra fields and visitors", () =>
    tx(async (c) => {
      const m = await user(c);
      expect(await asErr(c, m, "select public.beta_feedback_send('week', $1::jsonb)", [JSON.stringify({ ...week, trust: 9 })])).toBe("INVALID_FEEDBACK");
      expect(await asErr(c, m, "select public.beta_feedback_send('week', $1::jsonb)", [JSON.stringify({ ...week, weight: "70kg" })])).toBe("INVALID_FEEDBACK");
      expect(await asErr(c, m, "select public.beta_feedback_send('note', $1::jsonb)", [JSON.stringify({ text: "x".repeat(501) })])).toBe("INVALID_FEEDBACK");
      expect(await asErr(c, m, "select public.beta_feedback_send('survey', $1::jsonb)", [JSON.stringify({ text: "hello" })])).toBe("INVALID_FEEDBACK");
      expect(await asErr(c, null, "select public.beta_feedback_send('note', $1::jsonb)", [JSON.stringify({ text: "hello" })])).toMatch(/permission denied/);
      // Members cannot write the table directly, so the limits always hold.
      expect(await asErr(c, m, "insert into public.beta_feedback (user_id, form, answers) values ($1, 'note', '{\"text\":\"direct\"}')", [m])).toMatch(/permission denied/);
    }));

  it("keeps each member's feedback private, and shows the founder tester codes, never emails", () =>
    tx(async (c) => {
      const a = await user(c);
      const b = await user(c);
      const founder = await user(c, "publisher");
      await send(c, a, "note", { text: "Private note from A" });
      expect(await as(c, b, "select * from public.beta_feedback")).toEqual([]);
      expect(await as(c, b, "delete from public.beta_feedback returning id")).toEqual([]);
      expect(await asErr(c, b, "select public.beta_feedback_all()")).toBe("FOUNDER_ONLY");
      const all = (await as(c, founder, "select public.beta_feedback_all() r"))[0].r as J[];
      const mineA = all.filter((x) => x.answers.text === "Private note from A");
      expect(mineA).toHaveLength(1);
      expect(JSON.stringify(mineA[0])).not.toMatch(/@example\.test|user_?id/i);
      expect(mineA[0].tester).toBe((await as(c, a, "select public.beta_my_tester_code() r"))[0].r);
    }));

  it("lets a member delete their own feedback, and removes it with their account", () =>
    tx(async (c) => {
      const m = await user(c);
      const r = await send(c, m, "note", { text: "Delete me later" });
      expect((await as(c, m, "delete from public.beta_feedback where id = $1 returning id", [r.id])).length).toBe(1);
      await send(c, m, "note", { text: "Still here" });
      await c.query("delete from auth.users where id = $1", [m]);
      expect(Number(await one(c, "(select count(*) from public.beta_feedback where user_id = $1)", [m]))).toBe(0);
    }));
});
