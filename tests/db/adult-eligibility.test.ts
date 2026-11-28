import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../helpers/db";

// Adults-only invited beta (owner decision 2, 26 Nov 2026; migration 20261126000200). Each test runs inside ONE
// rolled-back transaction.

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function tx(fn: (c: PoolClient) => Promise<void>) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("update app.invite_settings set enabled = false");
    await fn(c);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
  }
}
async function user(c: PoolClient) {
  const id = randomUUID();
  await c.query(
    `insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}', '{}', now(), now())`,
    [id, `adult-${id.slice(0, 8)}@example.test`],
  );
  return id;
}
async function as(c: PoolClient, uid: string | null, sql: string, params: unknown[] = []) {
  await c.query("savepoint a");
  await c.query(`set local role ${uid ? "authenticated" : "anon"}`);
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(uid ? { sub: uid, role: "authenticated" } : { role: "anon" })]);
  try {
    const rows = (await c.query(sql, params)).rows;
    await c.query("reset role");
    await c.query("release savepoint a");
    return rows;
  } catch (e) {
    await c.query("rollback to savepoint a");
    throw e;
  }
}

afterAll(async () => {
  await pool.end();
});

describe("adults-only beta eligibility", () => {
  it("starts unconfirmed, records the member's own confirmation and version, and asks again for a new version", () =>
    tx(async (c) => {
      const a = await user(c);
      const b = await user(c);
      const first = (await as(c, a, "select public.my_beta_eligibility() r"))[0].r as J;
      expect(first).toEqual({ adultConfirmedAt: null, legalVersion: null, legalAcceptedAt: null });
      const done = (await as(c, a, "select public.confirm_beta_eligibility(true, 'v1') r"))[0].r as J;
      expect(done.adultConfirmedAt).not.toBeNull();
      expect(done.legalVersion).toBe("v1");
      // A later version replaces the agreed version; the first adult confirmation time is kept.
      const again = (await as(c, a, "select public.confirm_beta_eligibility(true, 'v2') r"))[0].r as J;
      expect(again.legalVersion).toBe("v2");
      expect(again.adultConfirmedAt).toBe(done.adultConfirmedAt);
      // One member's answer never affects another's.
      expect(((await as(c, b, "select public.my_beta_eligibility() r"))[0].r as J).adultConfirmedAt).toBeNull();
    }));

  it("refuses a 'no' or missing answer, and visitors", async () =>
    tx(async (c) => {
      const a = await user(c);
      await expect(as(c, a, "select public.confirm_beta_eligibility(false, 'v1')")).rejects.toThrow(/ADULT_REQUIRED/);
      await expect(as(c, a, "select public.confirm_beta_eligibility(null, 'v1')")).rejects.toThrow(/ADULT_REQUIRED/);
      await expect(as(c, a, "select public.confirm_beta_eligibility(true, '')")).rejects.toThrow(/VERSION_REQUIRED/);
      await expect(as(c, null, "select public.confirm_beta_eligibility(true, 'v1')")).rejects.toThrow(/permission denied/);
      await expect(as(c, null, "select public.my_beta_eligibility()")).rejects.toThrow(/permission denied/);
      // Members cannot read or write the record directly (only through the two functions), and the confirmation
      // never creates a preferences row, so the first-run diet question still appears.
      for (const sql of [
        "select * from public.member_agreements",
        "insert into public.member_agreements (user_id, adult_confirmed_at, legal_version, legal_accepted_at) values (auth.uid(), now(), 'v9', now())",
      ])
        await expect(as(c, a, sql)).rejects.toThrow(/permission denied/);
      await as(c, a, "select public.confirm_beta_eligibility(true, 'v1')");
      expect((await c.query("select count(*)::int n from public.user_preferences where user_id = $1", [a])).rows[0].n).toBe(0);
    }));

  it("while invite-only is on, counts only invites the owner confirmed as adults", () =>
    tx(async (c) => {
      await c.query("update app.invite_settings set enabled = true");
      await c.query("insert into app.invites (email, added_by, adult_confirmed) values ('grown@example.test', 'test', true), ('unsure@example.test', 'test', false)");
      const add = (email: string) =>
        c.query(
          `insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
           values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $1, '{}', '{}', now(), now())`,
          [email],
        );
      await add("grown@example.test");
      await c.query("savepoint s");
      await expect(add("unsure@example.test")).rejects.toThrow(/invite-only/);
      await c.query("rollback to savepoint s");
    }));
});
