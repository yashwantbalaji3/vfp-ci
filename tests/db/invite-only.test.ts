import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../helpers/db";

// Invite-only sign-up (migration 20261122000800, docs/72 section 5). Each test runs inside one rolled-back transaction.
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
const hook = async (c: PoolClient, email: string) =>
  (await c.query("select public.hook_before_user_created($1::jsonb) r", [JSON.stringify({ user: { email } })])).rows[0].r as Record<string, unknown>;

afterAll(async () => {
  await pool.end();
});

describe("invite-only sign-up hook", () => {
  it("allows everyone while it is off (the default)", () =>
    tx(async (c) => {
      await c.query("update app.invite_settings set enabled = false");
      expect(await hook(c, "anyone@example.test")).toEqual({});
    }));
  it("when on, allows only an active invite, case-insensitively, and refuses a revoked one", () =>
    tx(async (c) => {
      await c.query("update app.invite_settings set enabled = true");
      await c.query("insert into app.invites (email, added_by, adult_confirmed) values ('friend@example.test', 'test', true), ('gone@example.test', 'test', true), ('unconfirmed@example.test', 'test', false)");
      await c.query("update app.invites set revoked_at = now() where email = 'gone@example.test'");
      expect(await hook(c, "Friend@Example.test")).toEqual({});
      expect(await hook(c, "stranger@example.test")).toEqual({ error: { http_code: 403, message: "This beta is invite-only." } });
      expect(await hook(c, "gone@example.test")).toMatchObject({ error: { http_code: 403 } });
      // Adults only (20261126000200): an invite the owner did not confirm as an adult does not count.
      expect(await hook(c, "unconfirmed@example.test")).toMatchObject({ error: { http_code: 403 } });
    }));
  it("is out of reach of members and visitors", () =>
    tx(async (c) => {
      for (const role of ["anon", "authenticated"]) {
        await c.query("savepoint s");
        await c.query(`set local role ${role}`);
        await expect(c.query("select public.hook_before_user_created('{}'::jsonb)")).rejects.toThrow(/permission denied/);
        await c.query("rollback to savepoint s");
        await c.query("savepoint s2");
        await c.query(`set local role ${role}`);
        await expect(c.query("select * from app.invites")).rejects.toThrow(/permission denied/);
        await c.query("rollback to savepoint s2");
      }
    }));
  it("is also enforced by the database for any new account, on any plan (20261126000100)", () =>
    tx(async (c) => {
      const add = (email: string) =>
        c.query(
          `insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
           values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $1, '{}', '{}', now(), now())`,
          [email],
        );
      await c.query("update app.invite_settings set enabled = false");
      await c.query("savepoint off");
      await add("open-door@example.test");
      await c.query("update app.invite_settings set enabled = true");
      await c.query("insert into app.invites (email, added_by, adult_confirmed) values ('guest@example.test', 'test', true), ('gone2@example.test', 'test', true), ('unconfirmed2@example.test', 'test', false)");
      await c.query("update app.invites set revoked_at = now() where email = 'gone2@example.test'");
      await add("Guest@Example.test");
      for (const email of ["stranger2@example.test", "gone2@example.test", "unconfirmed2@example.test"]) {
        await c.query("savepoint s");
        await expect(add(email)).rejects.toThrow(/invite-only/);
        await c.query("rollback to savepoint s");
      }
      // Existing accounts are untouched: updating one still works while invite-only is on.
      await c.query("update auth.users set updated_at = now() where email = 'open-door@example.test'");
    }));
  it("removes a member's invite when their account is deleted (20261123000400)", () =>
    tx(async (c) => {
      await c.query("update app.invite_settings set enabled = false");
      const id = (
        await c.query(
          `insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
           values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'Leaving@Example.test', '{}', '{}', now(), now()) returning id`,
        )
      ).rows[0].id as string;
      await c.query("insert into app.invites (email, added_by) values ('leaving@example.test', 'test'), ('staying@example.test', 'test')");
      await c.query("delete from auth.users where id = $1", [id]);
      expect((await c.query("select email from app.invites where email in ('leaving@example.test', 'staying@example.test')")).rows.map((r) => r.email)).toEqual(["staying@example.test"]);
    }));
});
