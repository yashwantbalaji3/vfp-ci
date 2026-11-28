import { afterAll, describe, expect, it } from "vitest";
import pg, { type PoolClient } from "pg";

// Private confirmation of Tier B facts (owner approval 18 Nov 2026 19:19 UTC; migration
// 20261118001400). Confirming a transcription is private: it never verifies, clears or publishes.

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
});
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function tx(fn: (c: PoolClient) => Promise<void>) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await fn(c);
  } finally {
    await c.query("rollback");
    c.release();
  }
}
const one = async (c: PoolClient, sql: string, params: unknown[] = []) =>
  (await c.query(`select ${sql} as r`, params)).rows[0].r;
async function user(c: PoolClient, roles: string[]) {
  const id = (
    await c.query(
      "insert into auth.users (id, email) values (gen_random_uuid(), 'pc-' || gen_random_uuid() || '@example.test') returning id",
    )
  ).rows[0].id;
  for (const r of roles)
    await c.query(
      "insert into public.role_assignments (user_id, role) values ($1, $2)",
      [id, r],
    );
  return id as string;
}
async function as(
  c: PoolClient,
  uid: string | null,
  sql: string,
  params: unknown[] = [],
) {
  await c.query(uid ? "set local role authenticated" : "set local role anon");
  if (uid)
    await c.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: uid, role: "authenticated" }),
    ]);
  const rows = (await c.query(sql, params)).rows;
  await c.query("reset role");
  return rows;
}
async function asFails(
  c: PoolClient,
  uid: string | null,
  sql: string,
  params: unknown[] = [],
) {
  await c.query("savepoint s");
  try {
    await as(c, uid, sql, params);
  } catch (e) {
    await c.query("rollback to savepoint s");
    return (e as { message: string }).message;
  }
  throw new Error(`Expected to fail: ${sql}`);
}
const access = (
  c: PoolClient,
  host: string,
  kind: string,
  status: string,
  at = "now()",
) =>
  c.query(
    `insert into staging.source_access (host, kind, status, evidence, permitted_uses, reviewer, reviewed_at)
           values ($1, $2, $3, 'Test evidence', ${status === "permits" ? "'tests'" : "null"}, 'Test reviewer', ${at})`,
    [host, kind, status],
  );

async function world(c: PoolClient) {
  const curator = await user(c, ["curator"]);
  const founder = await user(c, ["publisher"]);
  await access(
    c,
    "pilot-pc.test",
    "terms_review",
    "unclear",
    "now() - interval '1 hour'",
  );
  await access(c, "pilot-pc.test", "owner_decision", "private_pilot");
  await access(c, "cleared-pc.test", "terms_review", "permits");
  const place = await one(
    c,
    "staging.add_place($1, 'Private Confirm Test Place', 'west_cambridge', 1::smallint)",
    [curator],
  );
  const bowl = await one(c, "staging.add_dish($1, $2, 'Test tofu bowl')", [
    curator,
    place,
  ]);
  const pilot = await one(
    c,
    "staging.add_source_page($1, 'https://www.pilot-pc.test/menu', 'restaurant_site', 'Test', now())",
    [curator],
  );
  const cleared = await one(
    c,
    "staging.add_source_page($1, 'https://cleared-pc.test/menu', 'restaurant_site', 'Test', now())",
    [curator],
  );
  const pending = await one(
    c,
    "staging.add_source_page($1, 'https://pending-pc.test/menu', 'restaurant_site', 'Test', now())",
    [curator],
  );
  const today = (
    await c.query(
      "select (now() at time zone 'America/New_York')::date::text d",
    )
  ).rows[0].d as string;
  const submit = (actor: string, src: string, p: Record<string, unknown>) =>
    one(c, "staging.submit_fact($1, $2::jsonb)", [
      actor,
      JSON.stringify({
        placeId: place,
        dishId: bowl,
        sourcePageId: src,
        checkedOn: today,
        ...p,
      }),
    ]);
  return { curator, founder, place, bowl, pilot, cleared, pending, submit };
}
const factOf = async (
  c: PoolClient,
  founder: string,
  place: string,
  factId: string,
) => {
  const [{ r }] = await as(
    c,
    founder,
    "select public.menu_review_place($1) r",
    [place],
  );
  return (r as J).dishes
    .flatMap((d: J) => d.facts)
    .find((f: J) => f.factId === factId) as J;
};

afterAll(async () => {
  await pool.end();
});

describe("private confirmation of Tier B facts", () => {
  it("lets the founder confirm a private-pilot transcription, and nothing else changes", () =>
    tx(async (c) => {
      const w = await world(c);
      expect(
        await one(c, "staging.source_access_state('https://pilot-pc.test/x')"),
      ).toBe("private_pilot");
      const price = await w.submit(w.curator, w.pilot, {
        kind: "price",
        value: { usd: "14.95" },
        confidence: "high",
      });
      const before = await factOf(c, w.founder, w.place, price);
      expect(before).toMatchObject({
        access: "private_pilot",
        confirmAs: "transcription",
        canConfirm: true,
      });
      expect(before.statuses).toEqual({
        extracted: true,
        transcriptionConfirmed: false,
        dietaryVerified: false,
        nutritionVerified: false,
        reuseEligible: false,
        publicationApproved: false,
      });

      const [{ r }] = await as(
        c,
        w.founder,
        "select public.menu_review_decide($1::jsonb) r",
        [
          JSON.stringify([
            { factId: price, decision: "confirm_transcription" },
          ]),
        ],
      );
      expect(r).toEqual({ verified: 0, rejected: 0, transcribed: 1 });
      const after = await factOf(c, w.founder, w.place, price);
      expect(after.status).toBe("submitted");
      expect(after).toMatchObject({ confirmAs: null, canConfirm: false });
      expect(after.statuses).toEqual({
        extracted: true,
        transcriptionConfirmed: true,
        dietaryVerified: false,
        nutritionVerified: false,
        reuseEligible: false,
        publicationApproved: false,
      });
      const [{ r: list }] = await as(
        c,
        w.founder,
        "select public.menu_review_places() r",
      );
      expect((list as J[]).find((p) => p.placeId === w.place)).toMatchObject({
        transcribed: 1,
        ready: 0,
        held: 0,
        privatePilot: true,
      });
    }));

  it("can never verify, prepare or publish a private-pilot fact", () =>
    tx(async (c) => {
      const w = await world(c);
      const price = await w.submit(w.curator, w.pilot, {
        kind: "price",
        value: { usd: "14.95" },
      });
      await as(c, w.founder, "select public.menu_review_decide($1::jsonb)", [
        JSON.stringify([{ factId: price, decision: "confirm_transcription" }]),
      ]);
      // A transcription is not a verification: "verify" is still refused for this source.
      const other = await w.submit(w.curator, w.pilot, {
        kind: "menu_item",
        value: { listed: true },
      });
      expect(
        await asFails(
          c,
          w.founder,
          "select public.menu_review_decide($1::jsonb)",
          [JSON.stringify([{ factId: other, decision: "verify" }])],
        ),
      ).toBe("STAGING_SOURCE_NOT_CLEARED");
      // Nothing verified means nothing to publish, and the publication guard still checks sources.
      expect(
        (
          await c.query(
            "select count(*)::int n from staging.facts where place_id = $1 and status = 'verified'",
            [w.place],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await c.query(
            "select count(*)::int n from staging.publications where place_id = $1",
            [w.place],
          )
        ).rows[0].n,
      ).toBe(0);
      // No member, visitor or API role can read confirmations or the staging area.
      for (const who of [null, w.curator]) {
        expect(
          await asFails(c, who, "select * from staging.fact_confirmations"),
        ).toMatch(/permission denied/);
      }
      expect(
        await asFails(c, w.founder, "select * from staging.fact_confirmations"),
      ).toMatch(/permission denied/);
    }));

  it("refuses confirmation from cleared, pending and prohibited sources, by the drafter, and twice", () =>
    tx(async (c) => {
      const w = await world(c);
      const both = await user(c, ["curator", "publisher"]);
      const own = await w.submit(both, w.pilot, {
        kind: "price",
        value: { usd: "1.00" },
      });
      const ok = await w.submit(w.curator, w.pilot, {
        kind: "price",
        value: { usd: "2.00" },
      });
      const fromCleared = await w.submit(w.curator, w.cleared, {
        kind: "price",
        value: { usd: "3.00" },
      });
      const fromPending = await w.submit(w.curator, w.pending, {
        kind: "price",
        value: { usd: "4.00" },
      });
      const decide = (who: string, factId: string) =>
        asFails(c, who, "select public.menu_review_decide($1::jsonb)", [
          JSON.stringify([{ factId, decision: "confirm_transcription" }]),
        ]);
      expect(await decide(both, own)).toBe("STAGING_SAME_PERSON");
      expect(await decide(w.founder, fromCleared)).toBe(
        "STAGING_NOT_PRIVATE_PILOT",
      );
      expect(await decide(w.founder, fromPending)).toBe(
        "STAGING_NOT_PRIVATE_PILOT",
      );
      await as(c, w.founder, "select public.menu_review_decide($1::jsonb)", [
        JSON.stringify([{ factId: ok, decision: "confirm_transcription" }]),
      ]);
      expect(await decide(w.founder, ok)).toBe("STAGING_ALREADY_REVIEWED");
      // A cleared source still verifies the usual way, and that sets the verification statuses.
      expect((await factOf(c, w.founder, w.place, fromCleared)).confirmAs).toBe(
        "verify",
      );
      // A later prohibition ends the pilot for that site.
      await access(
        c,
        "pilot-pc.test",
        "terms_review",
        "prohibits",
        "now() + interval '1 minute'",
      );
      expect(
        await one(c, "staging.source_access_state('https://pilot-pc.test/x')"),
      ).toBe("prohibited");
    }));

  it("keeps confirmations append-only and the registry's owner decisions consistent", () =>
    tx(async (c) => {
      const w = await world(c);
      const price = await w.submit(w.curator, w.pilot, {
        kind: "price",
        value: { usd: "5.00" },
      });
      await as(c, w.founder, "select public.menu_review_decide($1::jsonb)", [
        JSON.stringify([{ factId: price, decision: "confirm_transcription" }]),
      ]);
      await c.query("savepoint a");
      await expect(
        c.query("delete from staging.fact_confirmations where fact_id = $1", [
          price,
        ]),
      ).rejects.toThrow(/APPEND_ONLY/);
      await c.query("rollback to savepoint a");
      await expect(
        access(c, "x-pc.test", "terms_review", "private_pilot"),
      ).rejects.toThrow(/owner_decision/);
      await c.query("rollback to savepoint a");
      await expect(
        access(c, "y-pc.test", "owner_decision", "unclear"),
      ).rejects.toThrow(/owner_decision/);
      await c.query("rollback to savepoint a");
      expect(
        (
          await c.query(
            "select action from staging.events where fact_id = $1 order by id",
            [price],
          )
        ).rows.map((r) => r.action),
      ).toEqual(["submit_fact", "confirm_transcription"]);
    }));
});
