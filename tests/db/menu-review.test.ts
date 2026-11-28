import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../helpers/db";

// Real-menu drafts and the founder's batch review (migration 20261118001200, docs/58). Every test runs
// in one transaction that is rolled back. Places, hosts and dishes are invented.

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
async function fails(c: PoolClient, sql: string, params: unknown[] = []) {
  await c.query("savepoint s");
  try {
    await c.query(sql, params);
  } catch (e) {
    await c.query("rollback to savepoint s");
    return (e as { message: string }).message;
  }
  throw new Error(`Expected to fail: ${sql}`);
}
async function user(c: PoolClient, roles: string[]) {
  const id = randomUUID();
  await c.query(
    `insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}', '{}', now(), now())`,
    [id, `menurev-${id.slice(0, 8)}@example.test`],
  );
  for (const r of roles) await c.query("insert into public.role_assignments (user_id, role) values ($1, $2)", [id, r]);
  return id;
}
/** Run one statement as a signed-in member (or a visitor with null), inside the open transaction. */
async function as(c: PoolClient, uid: string | null, sql: string, params: unknown[] = []) {
  await c.query(uid ? "set local role authenticated" : "set local role anon");
  if (uid) await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
  // On an error the transaction is aborted; asFails rolls back to its savepoint, which also undoes the role.
  const rows = (await c.query(sql, params)).rows;
  await c.query("reset role");
  return rows;
}
async function asFails(c: PoolClient, uid: string | null, sql: string, params: unknown[] = []) {
  await c.query("savepoint s");
  try {
    await as(c, uid, sql, params);
  } catch (e) {
    await c.query("rollback to savepoint s");
    return (e as { message: string }).message;
  }
  throw new Error(`Expected to fail: ${sql}`);
}

async function world(c: PoolClient) {
  const curator = await user(c, ["curator"]);
  const founder = await user(c, ["publisher"]);
  await c.query(
    `insert into staging.source_access (host, kind, status, evidence, permitted_uses, reviewer, reviewed_at)
     values ('cleared-menurev.test', 'terms_review', 'permits', 'Test clause', 'tests', 'Test reviewer', now())`,
  );
  const place = await one(c, "staging.add_place($1, 'Menu Review Test Place', 'kendall_square', 1::smallint)", [curator]);
  const bowl = await one(c, "staging.add_dish($1, $2, 'Test chickpea bowl')", [curator, place]);
  const wrap = await one(c, "staging.add_dish($1, $2, 'Test falafel wrap')", [curator, place]);
  const cleared = await one(c, "staging.add_source_page($1, 'https://cleared-menurev.test/menu', 'restaurant_site', 'Test', now())", [curator]);
  const pending = await one(c, "staging.add_source_page($1, 'https://pending-menurev.test/menu', 'restaurant_site', 'Test', now())", [curator]);
  const today = (await c.query("select (now() at time zone 'America/New_York')::date::text d")).rows[0].d as string;
  const submit = (actor: string, src: string, dish: string, p: Record<string, unknown>) =>
    one(c, "staging.submit_fact($1, $2::jsonb)", [actor, JSON.stringify({ placeId: place, dishId: dish, sourcePageId: src, checkedOn: today, ...p })]);
  return { curator, founder, place, bowl, wrap, cleared, pending, today, submit };
}

afterAll(async () => {
  await pool.end();
});

describe("drafting menu facts", () => {
  it("keeps listed ingredients and the drafter's confidence; the confidence never changes", () =>
    tx(async (c) => {
      const w = await world(c);
      const id = await w.submit(w.curator, w.cleared, w.bowl, { kind: "listed_ingredients", value: { items: ["chickpeas", "tahini", "rice"] }, confidence: "high" });
      const row = (await c.query("select kind, value, confidence, status from staging.facts where id = $1", [id])).rows[0];
      expect(row).toEqual({ kind: "listed_ingredients", value: { items: ["chickpeas", "tahini", "rice"] }, confidence: "high", status: "submitted" });
      expect(await fails(c, "update staging.facts set confidence = 'low' where id = $1", [id])).toMatch(/permanent/);
    }));

  it("refuses ingredient lists of the wrong shape and confidence words it does not know", () =>
    tx(async (c) => {
      const w = await world(c);
      for (const value of [{ items: [] }, { items: [""] }, { items: [3] }, { items: "chickpeas" }, { items: Array(41).fill("x") }, { items: ["x".repeat(81)] }]) {
        await c.query("savepoint s");
        await expect(w.submit(w.curator, w.cleared, w.bowl, { kind: "listed_ingredients", value })).rejects.toThrow();
        await c.query("rollback to savepoint s");
      }
      await c.query("savepoint s");
      await expect(w.submit(w.curator, w.cleared, w.bowl, { kind: "price", value: { usd: "12.50" }, confidence: "certain" })).rejects.toThrow();
      await c.query("rollback to savepoint s");
    }));

  it("accepts the cohort's areas beyond the two Cambridge squares", () =>
    tx(async (c) => {
      const curator = await user(c, ["curator"]);
      for (const area of ["kendall_square", "inman_square", "porter_square", "mission_hill", "west_cambridge", "allston_brighton", "seaport", "east_boston"]) {
        const id = await one(c, "staging.add_place($1, $2, $3, 2::smallint)", [curator, `Area Test ${area}`, area]);
        const city = (await c.query("select city from staging.places where id = $1", [id])).rows[0].city;
        expect(city).toBe(["mission_hill", "allston_brighton", "seaport", "east_boston"].includes(area) ? "Boston" : "Cambridge");
      }
    }));
});

describe("the founder's batch review", () => {
  it("lists drafted places and shows each row with what can be confirmed", () =>
    tx(async (c) => {
      const w = await world(c);
      await w.submit(w.curator, w.cleared, w.bowl, { kind: "price", value: { usd: "13.95" }, confidence: "high" });
      await w.submit(w.curator, w.cleared, w.bowl, { kind: "dietary_status", subject: "vegan", unknownReason: "The menu does not say" });
      await w.submit(w.curator, w.pending, w.wrap, { kind: "price", value: { usd: "11.00" }, confidence: "medium" });
      const [{ r: list }] = await as(c, w.founder, "select public.menu_review_places() r");
      const mine = (list as J[]).find((p) => p.placeId === w.place);
      expect(mine).toMatchObject({ label: "Menu Review Test Place", city: "Cambridge", dishes: 2, ready: 2, held: 1, confirmed: 0 });

      const [{ r: p }] = await as(c, w.founder, "select public.menu_review_place($1) r", [w.place]);
      const bowl = (p.dishes as J[]).find((d) => d.dishId === w.bowl)!;
      const wrap = (p.dishes as J[]).find((d) => d.dishId === w.wrap)!;
      expect(bowl.facts.map((f: J) => [f.kind, f.canConfirm])).toEqual([
        ["dietary_status", true],
        ["price", true],
      ]);
      expect(bowl.facts.find((f: J) => f.kind === "dietary_status")).toMatchObject({ unknown: true, value: null, unknownReason: "The menu does not say" });
      expect(wrap.facts[0]).toMatchObject({ kind: "price", canConfirm: false, canReject: true, confidence: "medium" });
      expect((p.sources as J[]).map((s) => [s.host, s.access]).sort()).toEqual([
        ["cleared-menurev.test", "cleared"],
        ["pending-menurev.test", "pending"],
      ]);
    }));

  it("confirms and rejects the listed facts in one go; nothing is published", () =>
    tx(async (c) => {
      const w = await world(c);
      const price = await w.submit(w.curator, w.cleared, w.bowl, { kind: "price", value: { usd: "13.95" } });
      const ingredients = await w.submit(w.curator, w.cleared, w.bowl, { kind: "listed_ingredients", value: { items: ["chickpeas"] } });
      const wrong = await w.submit(w.curator, w.cleared, w.wrap, { kind: "price", value: { usd: "99.00" } });
      const foodsBefore = (await c.query("select count(*)::int n from public.food_items")).rows[0].n;
      const [{ r }] = await as(c, w.founder, "select public.menu_review_decide($1::jsonb) r", [
        JSON.stringify([
          { factId: price, decision: "verify" },
          { factId: ingredients, decision: "verify" },
          { factId: wrong, decision: "reject", note: "Price is 9.00 on the page" },
        ]),
      ]);
      expect(r).toEqual({ verified: 2, rejected: 1, transcribed: 0 });
      const rows = (await c.query("select id, status, reviewer_id from staging.facts where id = any($1::uuid[])", [[price, ingredients, wrong]])).rows;
      expect(Object.fromEntries(rows.map((x) => [x.id, x.status]))).toEqual({ [price]: "verified", [ingredients]: "verified", [wrong]: "rejected" });
      expect(rows.every((x) => x.reviewer_id === w.founder)).toBe(true);
      expect((await c.query("select count(*)::int n from public.food_items")).rows[0].n).toBe(foodsBefore);
    }));

  it("is all or nothing: one fact from a source that is not cleared stops the whole batch", () =>
    tx(async (c) => {
      const w = await world(c);
      const ok = await w.submit(w.curator, w.cleared, w.bowl, { kind: "price", value: { usd: "13.95" } });
      const held = await w.submit(w.curator, w.pending, w.wrap, { kind: "price", value: { usd: "11.00" } });
      const msg = await asFails(c, w.founder, "select public.menu_review_decide($1::jsonb)", [
        JSON.stringify([
          { factId: ok, decision: "verify" },
          { factId: held, decision: "verify" },
        ]),
      ]);
      expect(msg).toBe("STAGING_SOURCE_NOT_CLEARED");
      expect((await c.query("select count(*)::int n from staging.facts where id = any($1::uuid[]) and status = 'submitted'", [[ok, held]])).rows[0].n).toBe(2);
    }));

  it("needs an explicit decision for every fact, and never lets anyone confirm their own entry", () =>
    tx(async (c) => {
      const w = await world(c);
      const both = await user(c, ["curator", "publisher"]);
      const own = await w.submit(both, w.cleared, w.bowl, { kind: "price", value: { usd: "13.95" } });
      for (const body of [[], [{ factId: own }], [{ factId: own, decision: "approve" }], "{}", [{ factId: "not-a-uuid", decision: "verify" }]]) {
        expect(await asFails(c, w.founder, "select public.menu_review_decide($1::jsonb)", [JSON.stringify(body)])).toBe("INVALID_BODY");
      }
      expect(await asFails(c, both, "select public.menu_review_decide($1::jsonb)", [JSON.stringify([{ factId: own, decision: "verify" }])])).toBe("STAGING_SAME_PERSON");
      const [{ r: p }] = await as(c, both, "select public.menu_review_place($1) r", [w.place]);
      expect(p.dishes.find((d: J) => d.dishId === w.bowl).facts[0]).toMatchObject({ canConfirm: false, canReject: false });
    }));

  it("a correction sets the draft aside and asks research to redraft; the redraft comes back to the founder", () =>
    tx(async (c) => {
      const w = await world(c);
      const draft = await w.submit(w.curator, w.cleared, w.bowl, { kind: "price", value: { usd: "13.95" } });
      expect(await asFails(c, w.founder, "select public.menu_review_correct($1, $2::jsonb, null)", [draft, JSON.stringify({ usd: "abc" })])).toBe("INVALID_CORRECTION");
      const [{ r }] = await as(c, w.founder, "select public.menu_review_correct($1, $2::jsonb, 'Page says 12.95') r", [draft, JSON.stringify({ usd: "12.95" })]);
      expect(r).toEqual({ factId: draft, status: "correction_requested" });
      expect((await c.query("select status, review_note from staging.facts where id = $1", [draft])).rows[0]).toEqual({ status: "rejected", review_note: "Page says 12.95" });
      const open = (await c.query("select fact_id, corrected, dish_label from staging.open_corrections() where place_id = $1", [w.place])).rows;
      expect(open).toEqual([{ fact_id: draft, corrected: { usd: "12.95" }, dish_label: "Test chickpea bowl" }]);
      const [{ r: p }] = await as(c, w.founder, "select public.menu_review_place($1) r", [w.place]);
      expect(p.dishes.find((d: J) => d.dishId === w.bowl).corrections).toHaveLength(1);

      // Research redrafts from the source; the request closes and the founder checks the redraft.
      const redraft = await w.submit(w.curator, w.cleared, w.bowl, { kind: "price", value: { usd: "12.95" }, confidence: "high" });
      expect((await c.query("select count(*)::int n from staging.open_corrections() where place_id = $1", [w.place])).rows[0].n).toBe(0);
      const [{ r: done }] = await as(c, w.founder, "select public.menu_review_decide($1::jsonb) r", [JSON.stringify([{ factId: redraft, decision: "verify" }])]);
      expect(done).toEqual({ verified: 1, rejected: 0, transcribed: 0 });
      const events = (await c.query("select action from staging.events where fact_id = $1 order by id", [draft])).rows.map((x) => x.action);
      expect(events).toEqual(["submit_fact", "reject_fact", "request_correction"]);
    }));

  it("a dietary correction must keep the claim it is about", () =>
    tx(async (c) => {
      const w = await world(c);
      const draft = await w.submit(w.curator, w.cleared, w.bowl, { kind: "dietary_status", value: { claim: "vegan", status: "yes" } });
      expect(await asFails(c, w.founder, "select public.menu_review_correct($1, $2::jsonb, null)", [draft, JSON.stringify({ claim: "vegetarian", status: "yes" })])).toBe(
        "INVALID_CORRECTION",
      );
    }));

  it("refuses a missing or malformed body, a repeated fact, an oversized correction and a second decision", () =>
    tx(async (c) => {
      const w = await world(c);
      const fact = await w.submit(w.curator, w.cleared, w.bowl, { kind: "price", value: { usd: "13.95" } });
      expect(await asFails(c, w.founder, "select public.menu_review_decide(null)")).toBe("INVALID_BODY");
      for (const body of ["{}", '{"factId":"x"}', "42", "null"]) {
        expect(await asFails(c, w.founder, "select public.menu_review_decide($1::jsonb)", [body])).toBe("INVALID_BODY");
      }
      const many = Array.from({ length: 301 }, () => ({ factId: fact, decision: "verify" }));
      expect(await asFails(c, w.founder, "select public.menu_review_decide($1::jsonb)", [JSON.stringify(many)])).toBe("INVALID_BODY");
      // The same fact twice in one batch: the second decision is refused and the first is undone with it.
      const twice = [{ factId: fact, decision: "verify" }, { factId: fact, decision: "reject" }];
      expect(await asFails(c, w.founder, "select public.menu_review_decide($1::jsonb)", [JSON.stringify(twice)])).toBe("STAGING_ALREADY_REVIEWED");
      expect((await c.query("select status from staging.facts where id = $1", [fact])).rows[0].status).toBe("submitted");
      const big = { usd: "12.95", extra: "x".repeat(2100) };
      expect(await asFails(c, w.founder, "select public.menu_review_correct($1, $2::jsonb, null)", [fact, JSON.stringify(big)])).toBe("INVALID_CORRECTION");
      expect(await asFails(c, w.founder, "select public.menu_review_correct($1, $2::jsonb, $3)", [fact, JSON.stringify({ usd: "12.95" }), "n".repeat(501)])).toBe(
        "INVALID_CORRECTION",
      );
      await as(c, w.founder, "select public.menu_review_decide($1::jsonb)", [JSON.stringify([{ factId: fact, decision: "verify" }])]);
      expect(await asFails(c, w.founder, "select public.menu_review_correct($1, $2::jsonb, null)", [fact, JSON.stringify({ usd: "12.95" })])).toBe(
        "STAGING_ALREADY_REVIEWED",
      );
      expect(await asFails(c, w.founder, "select public.menu_review_place($1)", ["00000000-0000-0000-0000-000000000000"])).toBe("NOT_FOUND");
      // Confirming in staging never publishes: nothing reaches the public catalog.
      expect((await c.query("select count(*)::int n from staging.events where fact_id = $1 and action = 'prepare_publication'", [fact])).rows[0].n).toBe(0);
    }));

  it("members, curators and visitors cannot read or decide anything", () =>
    tx(async (c) => {
      const w = await world(c);
      const fact = await w.submit(w.curator, w.cleared, w.bowl, { kind: "price", value: { usd: "13.95" } });
      for (const who of [await user(c, []), w.curator, await user(c, ["admin"])]) {
        expect(await asFails(c, who, "select public.menu_review_places()")).toBe("FOUNDER_ONLY");
        expect(await asFails(c, who, "select public.menu_review_place($1)", [w.place])).toBe("FOUNDER_ONLY");
        expect(await asFails(c, who, "select public.menu_review_decide($1::jsonb)", [JSON.stringify([{ factId: fact, decision: "verify" }])])).toBe("FOUNDER_ONLY");
        expect(await asFails(c, who, "select public.menu_review_correct($1, $2::jsonb, null)", [fact, JSON.stringify({ usd: "1.00" })])).toBe("FOUNDER_ONLY");
      }
      expect(await asFails(c, null, "select public.menu_review_places()")).toMatch(/permission denied/);
      expect(await asFails(c, w.founder, "select public.menu_review_fact_json(f, $1) from staging.facts f limit 1", [w.founder])).toMatch(/permission denied/);
    }));
});
