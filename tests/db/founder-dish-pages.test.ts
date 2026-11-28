import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../helpers/db";

// The founder's side-by-side review gets only the page hashes behind each meal (migration 20261127000200); the page
// bodies never enter the database. Each test runs inside one rolled-back transaction.

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
    [id, `pages-${id.slice(0, 8)}@example.test`],
  );
  if (role) await c.query("insert into public.role_assignments (user_id, role) values ($1, $2)", [id, role]);
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

describe("founder dish pages", () => {
  it("is refused to visitors, members and curators", () =>
    tx(async (c) => {
      const call = "select public.founder_dish_pages(array[gen_random_uuid()]) r";
      await expect(as(c, null, call)).rejects.toThrow(/permission denied/);
      await expect(as(c, await user(c), call)).rejects.toThrow(/FOUNDER_ONLY/);
      await expect(as(c, await user(c, "curator"), call)).rejects.toThrow(/FOUNDER_ONLY/);
    }));

  it("gives the founder hashes only, never a page body, and caps the batch", () =>
    tx(async (c) => {
      const f = await user(c, "publisher");
      expect((await as(c, f, "select public.founder_dish_pages(array[gen_random_uuid()]) r"))[0].r).toEqual([]);
      const any = (await c.query("select f.dish_id from staging.facts f join staging.fact_machine_checks mc on mc.fact_id = f.id where mc.page_sha256 is not null and f.dish_id is not null limit 1")).rows[0];
      if (any) {
        const r = (await as(c, f, "select public.founder_dish_pages(array[$1::uuid]) r", [any.dish_id]))[0].r as Record<string, unknown>[];
        expect(r.length).toBeGreaterThan(0);
        for (const row of r) expect(Object.keys(row).sort()).toEqual(["dishId", "savedAt", "sha256", "url"]);
      }
      await expect(as(c, f, "select public.founder_dish_pages(array(select gen_random_uuid() from generate_series(1, 501))) r")).rejects.toThrow(/TOO_MANY/);
    }));
});
