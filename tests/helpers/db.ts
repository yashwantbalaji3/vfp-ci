import { Pool, type PoolClient } from "pg";
import { randomUUID } from "node:crypto";

/**
 * Direct database access for integration tests against the LOCAL Supabase stack only.
 * Member-scoped queries switch to the `authenticated` role with JWT claims, exactly
 * as the Data API does, so Row Level Security and grants apply.
 */
const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
if (!/@(127\.0\.0\.1|localhost):/.test(url)) {
  throw new Error("Database tests run only against a local database.");
}

export const pool = new Pool({ connectionString: url, max: 6 });

export async function createTestUser(label = "member"): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}', '{}', now(), now())`,
    [id, `${label}-${id.slice(0, 8)}@example.test`],
  );
  return id;
}

export async function deleteTestUsers(ids: string[]) {
  if (!ids.length) return;
  // Since the DEF-01 fix (M5) a member is removed by deleting the account row alone;
  // everything they own goes with it. No clean-up beforehand is needed or done here.
  await pool.query("delete from auth.users where id = any($1::uuid[])", [ids]);
}

/** Run `fn` as a member (or as a guest when userId is null) inside a transaction. */
export async function asMember<T>(
  userId: string | null,
  fn: (c: PoolClient) => Promise<T>,
  opts: { commit?: boolean } = {},
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    if (userId) {
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: userId, role: "authenticated" }),
      ]);
    } else {
      await c.query("set local role anon");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
    }
    const result = await fn(c);
    await c.query(opts.commit ? "commit" : "rollback");
    return result;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Extract the SQLSTATE and message of a failed query. */
export async function pgError(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { code: err.code ?? "", message: err.message ?? "" };
  }
  throw new Error("Expected the query to fail, but it succeeded");
}

/**
 * Research-source clearance (docs/46): a staged fact can be verified or published only when its
 * source host is cleared. Tests that verify facts from invented test hosts record a permit for them
 * inside their own (rolled-back) transaction.
 */
export async function clearTestHosts(c: PoolClient, hosts: string[] = ["example.test", "news.example.test"]) {
  for (const host of hosts) {
    await c.query(`insert into staging.source_access (host, kind, status, evidence, permitted_uses, reviewer)
                   values ($1, 'written_permission', 'permits', 'Invented test host', 'tests only', 'Test fixture')`, [host]);
  }
}

/**
 * Removes test place listings and the identity-only venues linked to them (docs/49), with any saves, reviews,
 * rankings and list entries a test made on those venues. `where` is a condition on place_listings `l`.
 */
export async function deleteTestListings(where: string, params: unknown[]) {
  const venues = (await pool.query(`select venue_id from public.place_listings l where (${where}) and venue_id is not null`, params)).rows.map(
    (r: { venue_id: string }) => r.venue_id,
  );
  for (const t of ["food_list_items", "ranking_entries", "reviews", "saves"]) {
    await pool.query(`delete from public.${t} where venue_id = any($1::uuid[])`, [venues]);
  }
  await pool.query(`delete from public.place_listings l where ${where}`, params);
  await pool.query("delete from public.venues where id = any($1::uuid[])", [venues]);
}
