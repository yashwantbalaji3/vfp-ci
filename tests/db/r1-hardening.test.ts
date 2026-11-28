import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { asMember, createTestUser, deleteTestUsers, pgError, pool } from "../helpers/db";
import { IDS } from "../fixtures/ids";

// R1 hardening (docs/14 PH-01 and PH-03; plans/2026-11-14-integration-readiness-audit.md):
//   - only the application server can record a rate-limit hit;
//   - old private leftovers are removed on a schedule, with no member action;
//   - table privileges match the row rules, and nothing more;
//   - a missing profile or list can be recognised before the page starts.
// Everything that changes shared settings runs in a transaction that is rolled back.

/** The fixed LOCAL key whose digest supabase/seed.sql registers. Never used when hosted. */
const KEY = "local-development-only-rate-limit-key-0000";
const TZ = "America/New_York";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
let member: string;

beforeAll(async () => {
  member = await createTestUser("r1");
  await pool.query("delete from public.rate_limit_windows where bucket like 'r1test:%'");
});
afterAll(async () => {
  await pool.query("delete from public.rate_limit_windows where bucket like 'r1test:%'");
  await deleteTestUsers([member]);
  await pool.end();
});

/** One connection as the database owner, always rolled back. */
async function asOwner<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    return await fn(c);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
  }
}
const become = async (c: PoolClient, userId: string | null) => {
  await c.query(userId ? "set local role authenticated" : "set local role anon");
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(userId ? { sub: userId, role: "authenticated" } : { role: "anon" })]);
};

describe("PH-01: only the application server can record a rate-limit hit", () => {
  const hit = (who: string | null, proof: string | null, bucket: string, limit = 3) =>
    asMember(who, async (c) => (await c.query("select public.rate_limit_hit($1, $2, $3, 3600) as ok", [proof, bucket, limit])).rows[0].ok as boolean, { commit: true });

  it("refuses a guest or a member who calls the counter without the server's proof", async () => {
    const bucket = `r1test:${randomUUID()}`;
    for (const who of [null, member]) {
      for (const proof of [null, "", "guess", "x".repeat(40), KEY.toUpperCase()]) {
        const err = await pgError(hit(who, proof, bucket));
        expect(err, `${who ? "member" : "guest"} with ${JSON.stringify(proof)}`).toMatchObject({ code: "PT403", message: "NOT_ALLOWED" });
      }
    }
    // Nothing was counted by the refused calls.
    expect((await pool.query("select count(*)::int as n from public.rate_limit_windows where bucket = $1", [bucket])).rows[0].n).toBe(0);
  });

  it("no longer has the old form of the counter that needed no proof", async () => {
    const err = await pgError(asMember(null, (c) => c.query("select public.rate_limit_hit('r1test:abcdefgh', 3, 60)")));
    expect(err.code).toBe("42883"); // function does not exist
  });

  it("counts for the server, refuses the hit after the limit, and leaves another bucket alone", async () => {
    const a = `r1test:${randomUUID()}`;
    const b = `r1test:${randomUUID()}`;
    expect([await hit(null, KEY, a), await hit(null, KEY, a), await hit(member, KEY, a), await hit(null, KEY, a)]).toEqual([true, true, true, false]);
    expect(await hit(null, KEY, b)).toBe(true);
    expect((await pgError(hit(null, KEY, "x"))).code).toBe("PT422");
  });

  it("refuses every hit when no key is registered, so an unconfigured database fails closed", async () => {
    await asOwner(async (c) => {
      await c.query("delete from app.server_keys");
      await become(c, null);
      const err = await pgError(c.query("select public.rate_limit_hit($1, $2, 3, 60)", [KEY, `r1test:${randomUUID()}`]));
      expect(err.code).toBe("PT403");
    });
  });

  it("stores only a one-way digest of the key, which neither guests nor members can read or change", async () => {
    const rows = (await pool.query("select purpose, encode(digest, 'hex') as digest from app.server_keys")).rows;
    expect(rows).toEqual([{ purpose: "rate_limit", digest: sha(KEY) }]);
    for (const who of [null, member]) {
      expect((await pgError(asMember(who, (c) => c.query("select * from app.server_keys")))).code).toBe("42501");
      expect((await pgError(asMember(who, (c) => c.query("select app.register_server_key('rate_limit', $1)", [sha("attacker-key-attacker-key-attacker-key")])))).code).toBe("42501");
      expect((await pgError(asMember(who, (c) => c.query("select * from public.rate_limit_windows")))).code).toBe("42501");
    }
  });

  it("lets the key be rotated without downtime: old and new both work, and a third pushes out the oldest", async () => {
    await asOwner(async (c) => {
      const next = "next-rate-limit-key-next-rate-limit-key-01";
      const third = "third-rate-limit-key-third-rate-limit-key-1";
      await c.query("update app.server_keys set added_at = now() - interval '2 hours'");
      await c.query("select app.register_server_key('rate_limit', $1)", [sha(next)]);
      const ok = async (proof: string) => {
        await c.query("savepoint s");
        await become(c, null);
        try {
          return (await c.query("select public.rate_limit_hit($1, $2, 5, 60) as ok", [proof, `r1test:${randomUUID()}`])).rows[0].ok as boolean;
        } catch {
          return false;
        } finally {
          await c.query("rollback to savepoint s");
        }
      };
      expect([await ok(KEY), await ok(next)]).toEqual([true, true]);
      await c.query("update app.server_keys set added_at = now() - interval '1 hour' where digest = decode($1, 'hex')", [sha(next)]);
      await c.query("select app.register_server_key('rate_limit', $1)", [sha(third)]);
      expect([await ok(KEY), await ok(next), await ok(third)]).toEqual([false, true, true]);
      expect((await pgError(c.query("select app.register_server_key('rate_limit', 'not-a-digest')"))).code).toBe("PT422");
    });
  });

  it("keeps no network address: a bucket is a scope and a keyed hash, nothing else", async () => {
    const cols = (await pool.query("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'rate_limit_windows' order by 1")).rows.map((r) => r.column_name);
    expect(cols).toEqual(["bucket", "hits", "window_start"]);
    const odd = await pool.query("select bucket from public.rate_limit_windows where bucket !~ '^[a-z0-9_]+:[a-z0-9-]{8,60}$' limit 5");
    expect(odd.rows).toEqual([]);
  });
});

describe("PH-03 and the other scheduled clean-ups", () => {
  const logTofu = async (c: PoolClient, date: string) =>
    (await c.query("select public.log_food_entry($1, $2, $3, 1, null, 'home', 'lunch', $4, $5) as r", [randomUUID(), IDS.tofu.rev, IDS.tofu.portion150g, date, TZ])).rows[0].r as { entryId: string };

  it("erases a removed diary entry and its snapshots with no member action, and keeps everything else", async () => {
    await asOwner(async (c) => {
      await become(c, member);
      const old = await logTofu(c, "2026-06-01");
      const recent = await logTofu(c, "2026-06-01");
      const live = await logTofu(c, "2026-06-01");
      await c.query("select public.delete_diary_entry($1, 1)", [old.entryId]);
      await c.query("select public.delete_diary_entry($1, 1)", [recent.entryId]);
      await c.query("reset role");
      await c.query("update public.diary_entries set deleted_at = now() - interval '16 minutes' where id = $1", [old.entryId]);
      const left = async () => (await c.query("select id from public.diary_entries where id = any($1::uuid[]) order by created_at, id", [[old.entryId, recent.entryId, live.entryId]])).rows.map((r) => r.id).sort();
      const snaps = async (id: string) => (await c.query("select count(*)::int as n from public.diary_snapshots where entry_id = $1", [id])).rows[0].n as number;
      expect(await snaps(old.entryId)).toBeGreaterThan(0);

      // The scheduler's own call: nobody is signed in.
      const first = (await c.query("select app.run_maintenance() as r")).rows[0].r;
      expect(first.diaryEntries).toBe(1);
      expect(await left()).toEqual([recent.entryId, live.entryId].sort());
      expect(await snaps(old.entryId)).toBe(0);

      // Move the clock: 24 hours later the second removed entry is gone too. The live entry never is.
      const later = (await c.query("select app.run_maintenance(now() + interval '24 hours') as r")).rows[0].r;
      expect(later.diaryEntries).toBe(1);
      expect(await left()).toEqual([live.entryId]);
      expect(await snaps(recent.entryId)).toBe(0);
      expect(await snaps(live.entryId)).toBeGreaterThan(0);
    });
  });

  it("removes expired request records, ended deletion markers and old counters, and keeps current ones", async () => {
    await asOwner(async (c) => {
      const keep = randomUUID();
      const drop = randomUUID();
      await c.query(
        `insert into public.idempotency_records (owner_id, operation, key, request_hash, expires_at) values
           ($1, 'r1.test', $2, 'h', now() + interval '1 hour'), ($1, 'r1.test', $3, 'h', now() - interval '1 minute')`,
        [member, keep, drop],
      );
      await c.query(
        `insert into public.deletion_tombstones (subject_ref, requested_at, completed_at, backup_expiry) values
           ('r1-ended', now() - interval '40 days', now() - interval '40 days', now() - interval '1 day'),
           ('r1-current', now(), now(), now() + interval '30 days'),
           ('r1-unfinished', now() - interval '40 days', null, now() - interval '1 day')`,
      );
      await c.query(
        `insert into public.social_action_log (user_id, action, at) values ($1, 'r1_old', now() - interval '3 days'), ($1, 'r1_new', now())`,
        [member],
      );
      const r = (await c.query("select app.run_maintenance() as r")).rows[0].r;
      expect(r.idempotencyRecords).toBeGreaterThanOrEqual(1);
      expect((await c.query("select key from public.idempotency_records where operation = 'r1.test'")).rows.map((x) => x.key)).toEqual([keep]);
      expect((await c.query("select subject_ref from public.deletion_tombstones where subject_ref like 'r1-%' order by 1")).rows.map((x) => x.subject_ref)).toEqual(["r1-current", "r1-unfinished"]);
      expect((await c.query("select action from public.social_action_log where user_id = $1", [member])).rows.map((x) => x.action)).toEqual(["r1_new"]);
    });
  });

  it("removes sign-in audit records older than 30 days and keeps newer ones (20261126000400)", async () => {
    await asOwner(async (c) => {
      await c.query(
        `insert into auth.audit_log_entries (instance_id, id, payload, created_at, ip_address)
         values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), '{"r1":"old"}', now() - interval '31 days', '192.0.2.1'),
                ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), '{"r1":"new"}', now() - interval '29 days', '192.0.2.1')`,
      );
      const r = (await c.query("select app.run_maintenance() as r")).rows[0].r;
      expect(r.authAudit).toBeGreaterThanOrEqual(1);
      expect((await c.query("select payload->>'r1' k from auth.audit_log_entries where ip_address = '192.0.2.1'")).rows.map((x) => x.k)).toEqual(["new"]);
      expect((await c.query("select count(*)::int n from auth.audit_log_entries where created_at < now() - interval '30 days'")).rows[0].n).toBe(0);
    });
  });

  it("keeps the counter table small: 10,000 old buckets are gone after one run and current ones remain", async () => {
    await asOwner(async (c) => {
      await c.query(
        `insert into public.rate_limit_windows (bucket, window_start, hits)
         select 'r1load:old-' || lpad(g::text, 8, '0'), now() - interval '3 days', 1 from generate_series(1, 10000) g`,
      );
      await c.query(
        `insert into public.rate_limit_windows (bucket, window_start, hits)
         select 'r1load:now-' || lpad(g::text, 8, '0'), now(), 1 from generate_series(1, 50) g`,
      );
      const r = (await c.query("select app.run_maintenance() as r")).rows[0].r;
      expect(r.rateWindows).toBeGreaterThanOrEqual(10000);
      expect((await c.query("select count(*)::int as n from public.rate_limit_windows where bucket like 'r1load:%'")).rows[0].n).toBe(50);
      // Agreed size: nothing older than two days is ever left.
      expect((await c.query("select count(*)::int as n from public.rate_limit_windows where window_start < now() - interval '2 days'")).rows[0].n).toBe(0);
    });
  });

  it("writes down each run as counts only, and is scheduled every 15 minutes", async () => {
    await asOwner(async (c) => {
      await c.query("select app.run_maintenance()");
      const run = (await c.query("select removed from app.maintenance_runs order by id desc limit 1")).rows[0].removed;
      expect(Object.keys(run).sort()).toEqual(["authAudit", "deletionMarkers", "diaryEntries", "idempotencyRecords", "rateWindows", "socialActions"]);
      for (const v of Object.values(run)) expect(typeof v).toBe("number");
    });
    const job = (await pool.query("select schedule, command, active from cron.job where jobname = 'vfp-maintenance'")).rows;
    expect(job).toEqual([{ schedule: "*/15 * * * *", command: "select app.run_maintenance()", active: true }]);
  });

  it("cannot be run or read by a guest or a member", async () => {
    for (const who of [null, member]) {
      expect((await pgError(asMember(who, (c) => c.query("select app.run_maintenance()")))).code).toBe("42501");
      expect((await pgError(asMember(who, (c) => c.query("select * from app.maintenance_runs")))).code).toBe("42501");
    }
  });
});

describe("table privileges match the row rules and nothing more", () => {
  type Grant = { table_name: string; grantee: string; privilege_type: string };
  const grants = async () =>
    (
      await pool.query(
        `select table_name, grantee, privilege_type from information_schema.role_table_grants
          where table_schema = 'public' and grantee in ('anon', 'authenticated') order by 1, 2, 3`,
      )
    ).rows as Grant[];
  const rules = async () =>
    (await pool.query("select tablename, cmd, roles::text[] as roles from pg_policies where schemaname = 'public'")).rows as { tablename: string; cmd: string; roles: string[] }[];

  it("gives a signed-out caller no privilege on any private table", async () => {
    const g = (await grants()).filter((x) => x.grantee === "anon");
    const privateTables = [
      "diary_entries", "diary_snapshots", "daily_log_status", "goal_versions", "user_preferences", "ingredient_exclusions",
      "cook_sessions", "meal_plans", "saves", "corrections", "profiles_public", "reviews", "review_revisions", "food_lists",
      "food_list_items", "ranking_entries", "ranking_publications", "follows", "friendships", "blocks", "reports",
      "member_standing", "social_action_log", "role_assignments", "audit_events", "idempotency_records", "outbox_jobs",
      "deletion_tombstones", "rate_limit_windows",
    ];
    expect(g.filter((x) => privateTables.includes(x.table_name))).toEqual([]);
    // And the database agrees when asked directly, table by table.
    const direct = await pool.query(
      `select t from unnest($1::text[]) t
        where has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('anon', 'public.' || t, 'insert')
           or has_table_privilege('anon', 'public.' || t, 'update') or has_table_privilege('anon', 'public.' || t, 'delete')
           or has_table_privilege('anon', 'public.' || t, 'truncate')`,
      [privateTables],
    );
    expect(direct.rows).toEqual([]);
  });

  it("lets a signed-out caller only read, and only tables that have a public reading rule", async () => {
    const g = (await grants()).filter((x) => x.grantee === "anon");
    expect([...new Set(g.map((x) => x.privilege_type))]).toEqual(["SELECT"]);
    const readable = new Set((await rules()).filter((r) => r.roles.includes("anon") && ["SELECT", "ALL"].includes(r.cmd)).map((r) => r.tablename));
    expect(g.filter((x) => !readable.has(x.table_name))).toEqual([]);
  });

  it("gives a member no privilege without a matching rule, and nobody TRUNCATE, TRIGGER or REFERENCES", async () => {
    const all = await grants();
    expect(all.filter((x) => ["TRUNCATE", "TRIGGER", "REFERENCES"].includes(x.privilege_type))).toEqual([]);
    const allowed = new Set<string>();
    for (const r of await rules()) {
      for (const role of r.roles) for (const cmd of r.cmd === "ALL" ? ["SELECT", "INSERT", "UPDATE", "DELETE"] : [r.cmd]) allowed.add(`${r.tablename}|${role}|${cmd}`);
    }
    expect(all.filter((x) => !allowed.has(`${x.table_name}|${x.grantee}|${x.privilege_type}`))).toEqual([]);
  });

  it("starts every new table closed", async () => {
    await asOwner(async (c) => {
      await c.query("create table public.r1_probe (id integer)");
      const r = await c.query(
        `select has_table_privilege('anon', 'public.r1_probe', 'select') as anon_read, has_table_privilege('authenticated', 'public.r1_probe', 'select') as member_read,
                has_table_privilege('authenticated', 'public.r1_probe', 'insert') as member_write`,
      );
      expect(r.rows[0]).toEqual({ anon_read: false, member_read: false, member_write: false });
    });
  });
});

describe("AUD-D3: a missing profile or list can be recognised before the page starts", () => {
  const exists = (who: string | null, kind: string, ref: string) =>
    asMember(who, async (c) => (await c.query("select public.social_page_exists($1, $2, true) as ok", [kind, ref])).rows[0].ok as boolean);
  let handle: string;
  let publicList: string | undefined;
  beforeAll(async () => {
    handle = "demo_maya"; // invented profile from supabase/seed.sql
    publicList = (await pool.query("select id from public.food_lists where visibility = 'public' and publication_state = 'visible' limit 1")).rows[0]?.id;
  });

  it("says yes for a profile a member may see and no for one that does not exist", async () => {
    expect(await exists(member, "profile", handle)).toBe(true);
    expect(await exists(member, "profile", "nobody_here_at_all")).toBe(false);
    expect(await exists(member, "profile", "")).toBe(false);
  });

  it("says no for a list that does not exist, a malformed id, or an unknown kind", async () => {
    expect(await exists(member, "list", randomUUID())).toBe(false);
    expect(await exists(member, "list", "not-an-id'; drop table x; --")).toBe(false);
    expect(await exists(member, "diary", randomUUID())).toBe(false);
    if (publicList) expect(await exists(member, "list", publicList)).toBe(true);
  });

  it("gives a signed-out caller the same no as a missing page while public reading is off", async () => {
    await asOwner(async (c) => {
      await c.query("update app.platform_switches set enabled = false where name = 'social_public'");
      await become(c, null);
      expect((await c.query("select public.social_page_exists('profile', $1, true) as ok", [handle])).rows[0].ok).toBe(false);
      if (publicList) expect((await c.query("select public.social_page_exists('list', $1, true) as ok", [publicList])).rows[0].ok).toBe(false);
    });
  });
});
