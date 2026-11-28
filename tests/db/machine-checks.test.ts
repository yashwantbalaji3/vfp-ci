import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../helpers/db";

// Automatic comparison of drafted facts with the saved source page (owner direction 18 Nov 2026
// 23:20 UTC; migration 20261118001700). A machine check is recorded by the research account, is
// append-only, never confirms anything, and the founder's screen shows it as automatic. A confirmation
// records whether it rested on the founder's own comparison or an accepted automatic one.

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
const fails = async (c: PoolClient, sql: string, params: unknown[] = []) => {
  await c.query("savepoint s");
  try {
    await c.query(sql, params);
  } catch (e) {
    await c.query("rollback to savepoint s");
    return (e as { message: string }).message;
  }
  throw new Error(`Expected to fail: ${sql}`);
};
async function as(c: PoolClient, uid: string | null, sql: string, params: unknown[] = []) {
  await c.query(uid ? "set local role authenticated" : "set local role anon");
  if (uid) await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
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
async function user(c: PoolClient, roles: string[]) {
  const id = randomUUID();
  await c.query(
    `insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}', '{}', now(), now())`,
    [id, `mc-${id.slice(0, 8)}@example.test`],
  );
  for (const r of roles) await c.query("insert into public.role_assignments (user_id, role) values ($1, $2)", [id, r]);
  return id;
}
const SHA = "a".repeat(64);

async function world(c: PoolClient) {
  const curator = await user(c, ["curator"]);
  const founder = await user(c, ["publisher"]);
  await c.query(
    "insert into staging.source_access (host, kind, status, evidence, reviewer, reviewed_at) values ('pilot-mc.test', 'owner_decision', 'private_pilot', 'Test evidence', 'Test reviewer', now())",
  );
  const place = await one(c, "staging.add_place($1, 'Machine Check Place', 'back_bay', 1::smallint)", [curator]);
  const src = await one(c, "staging.add_source_page($1, 'https://pilot-mc.test/menu', 'restaurant_site', 'Test', now())", [curator]);
  const today = (await c.query("select (now() at time zone 'America/New_York')::date::text d")).rows[0].d as string;
  const dish = await one(c, "staging.add_dish($1, $2, 'Lentil plate')", [curator, place]);
  await c.query("select staging.classify_dish($1, $2, 'complete_meal', null, 'Mains', null, 'source_section', null)", [curator, dish]);
  const price = (await one(c, "staging.submit_fact($1, $2::jsonb)", [curator, JSON.stringify({ placeId: place, dishId: dish, sourcePageId: src, checkedOn: today, confidence: "high", kind: "price", value: { usd: "14.95" } })])) as string;
  const check = (fact: string, result: string, actor = curator) =>
    c.query("select staging.record_machine_check($1, $2, $3, $4, $5, now())", [actor, fact, result, `Test: ${result}`, result === "not_checked" ? null : SHA]);
  const review = async () => ((await as(c, founder, "select public.menu_review_place($1) r", [place]))[0].r as J).dishes[0].facts as J[];
  const decide = (decisions: J[]) => as(c, founder, "select public.menu_review_decide($1::jsonb) r", [JSON.stringify(decisions)]);
  return { curator, founder, place, src, dish, price, check, review, decide };
}

afterAll(async () => {
  await pool.end();
});

describe("the six publication states (owner decision D1)", () => {
  it("keeps every state separate: an automatic comparison and a private confirmation never imply review, rights or publication", () =>
    tx(async (c) => {
      const w = await world(c);
      const none = { extracted: true, autoCompared: "not_checked", independentlyReviewed: false, founderConfirmed: false, rightsEligible: false, published: false };
      expect((await w.review())[0].ladder).toEqual(none);
      await w.check(w.price, "found");
      expect((await w.review())[0].ladder).toEqual({ ...none, autoCompared: "found" });
      await w.decide([{ factId: w.price, decision: "confirm_transcription", note: "Basis: founder compared with the source." }]);
      // A private-pilot source: confirmed by the founder, but not reviewed by a second person, not cleared, not published.
      expect((await w.review())[0].ladder).toEqual({ ...none, autoCompared: "found", founderConfirmed: true });
      await w.check(w.price, "not_found");
      expect((await w.review())[0].ladder.autoCompared).toBe("not_found");
    }));
});

describe("automatic source comparison", () => {
  it("shows the latest automatic check to the founder and changes no status", () =>
    tx(async (c) => {
      const w = await world(c);
      expect((await w.review())[0].machineCheck).toBeNull();
      await w.check(w.price, "not_found");
      await w.check(w.price, "found");
      const [f] = await w.review();
      expect(f.machineCheck).toMatchObject({ result: "found", detail: "Test: found" });
      expect(f.machineCheck.pageSavedAt).toBeTruthy();
      expect(f.status).toBe("submitted");
      expect(f.statuses.transcriptionConfirmed).toBe(false);
      expect(f.confirmationBasis).toBeNull();
      expect((await c.query("select count(*)::int n from staging.fact_confirmations where fact_id = $1", [w.price])).rows[0].n).toBe(0);
    }));

  it("records what a confirmation rested on, and never calls an accepted automatic comparison the founder's own", () =>
    tx(async (c) => {
      const w = await world(c);
      await w.check(w.price, "found");
      await w.decide([{ factId: w.price, decision: "confirm_transcription", note: "Basis: automatic comparison accepted by the founder; not compared by hand." }]);
      expect((await w.review())[0]).toMatchObject({ confirmationBasis: "automatic_comparison", statuses: { transcriptionConfirmed: true, publicationApproved: false } });
      const other = (await one(c, "staging.submit_fact($1, $2::jsonb)", [w.curator, JSON.stringify({ placeId: w.place, dishId: w.dish, sourcePageId: w.src, checkedOn: (await c.query("select (now() at time zone 'America/New_York')::date::text d")).rows[0].d, confidence: "high", kind: "menu_item", value: { listed: true } })])) as string;
      await w.decide([{ factId: other, decision: "confirm_transcription", note: "Basis: founder compared with the source." }]);
      const byId = Object.fromEntries((await w.review()).map((f) => [f.factId, f]));
      expect(byId[other].confirmationBasis).toBe("founder");
    }));

  it("is recorded only by the research account, only while the fact waits, and only with a page fingerprint", () =>
    tx(async (c) => {
      const w = await world(c);
      expect(await fails(c, "select staging.record_machine_check($1, $2, 'found', 'x', $3, now())", [w.founder, w.price, SHA])).toMatch(/role|curator|FORBIDDEN|PT403/i);
      expect(await fails(c, "select staging.record_machine_check($1, $2, 'found', 'x', null, now())", [w.curator, w.price])).toMatch(/check/i);
      expect(await fails(c, "select staging.record_machine_check($1, $2, 'maybe', 'x', $3, now())", [w.curator, w.price, SHA])).toMatch(/check/i);
      expect(await fails(c, "select staging.record_machine_check($1, $2, 'found', 'x', $3, now())", [w.curator, randomUUID(), SHA])).toMatch("NOT_FOUND");
      await w.check(w.price, "not_checked");
      await w.decide([{ factId: w.price, decision: "confirm_transcription" }]);
      // A confirmed fact still waits for its other statuses, so it may still be compared; a rejected one may not.
      const rejected = (await one(c, "staging.submit_fact($1, $2::jsonb)", [w.curator, JSON.stringify({ placeId: w.place, dishId: w.dish, sourcePageId: w.src, checkedOn: (await c.query("select (now() at time zone 'America/New_York')::date::text d")).rows[0].d, confidence: "high", kind: "menu_item", value: { listed: true } })])) as string;
      await w.decide([{ factId: rejected, decision: "reject" }]);
      expect(await fails(c, "select staging.record_machine_check($1, $2, 'found', 'x', $3, now())", [w.curator, rejected, SHA])).toMatch("STAGING_FACT_DECIDED");
    }));

  it("is append-only and invisible to signed-in people and visitors", () =>
    tx(async (c) => {
      const w = await world(c);
      await w.check(w.price, "found");
      expect(await fails(c, "update staging.fact_machine_checks set result = 'not_found' where fact_id = $1", [w.price])).toMatch("APPEND_ONLY");
      expect(await fails(c, "delete from staging.fact_machine_checks where fact_id = $1", [w.price])).toMatch("APPEND_ONLY");
      const member = await user(c, []);
      for (const uid of [w.founder, member, null]) {
        expect(await asFails(c, uid, "select * from staging.fact_machine_checks")).toMatch(/permission denied/);
        expect(await asFails(c, uid, "select staging.current_machine_check($1)", [w.price])).toMatch(/permission denied/);
        expect(await asFails(c, uid, "select staging.record_machine_check($1, $2, 'found', 'x', $3, now())", [w.curator, w.price, SHA])).toMatch(/permission denied/);
      }
      expect(await asFails(c, member, "select public.menu_review_place($1)", [w.place])).toMatch("FOUNDER_ONLY");
      expect(await asFails(c, null, "select public.menu_review_fact_json(f, $2) from staging.facts f where f.id = $1", [w.price, w.founder])).toMatch(/permission denied/);
    }));
});
