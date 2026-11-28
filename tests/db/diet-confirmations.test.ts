import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool, clearTestHosts } from "../helpers/db";

// Founder-only independent dietary confirmation records (owner decision 24 Nov 2026 21:20 UTC, decision 2; migration
// 20261124000900). Each test runs inside ONE rolled-back transaction. Names and addresses are invented.

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
    [id, `dc-${id.slice(0, 8)}@example.test`],
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

/** A researched place with one dish that has a menu item fact and no diet statement. */
async function dish(c: PoolClient, curator: string) {
  await clearTestHosts(c);
  const today = (await c.query("select (now() at time zone 'America/New_York')::date::text as d")).rows[0].d as string;
  const p = await one(c, "staging.add_place($1, $2, 'back_bay', 2::smallint)", [curator, `Confirm Test Kitchen ${randomUUID().slice(0, 6)}`]);
  const site = await one(c, "staging.add_source_page($1, $2, 'restaurant_site', 'Confirm Test', now(), 'Facts only')", [curator, `https://example.test/menu-${randomUUID().slice(0, 8)}`]);
  const id = (await one(c, "staging.add_dish($1, $2, $3)", [curator, p, "Chana Masala"])) as string;
  await c.query("select staging.classify_dish($1, $2, 'complete_meal', null, 'Mains', null, 'source_section', null)", [curator, id]);
  await one(c, "staging.submit_fact($1, $2::jsonb)", [curator, JSON.stringify({ placeId: p, dishId: id, sourcePageId: site, checkedOn: today, kind: "menu_item", value: { listed: true } })]);
  return { place: p as string, dish: id, site: site as string, today };
}
const RECORD = "select public.diet_confirmation_record($1, $2, $3, $4::text[], $5, $6, $7, $8, $9, $10, $11, $12::date) r";
const args = (d: string, o: Partial<Record<string, unknown>> = {}) => {
  const v = {
    claim: "vegetarian", answer: "suitable", topics: ["meat_or_fish_stock", "whole_dish"], note: "Vegetable stock only, no meat or fish",
    method: "staff_in_person", methodNote: null, role: "Shift manager", identity: "A. Example", scope: "This dish as listed, at this branch",
    limits: "Verbal answer; not an allergen statement", on: new Date().toISOString().slice(0, 10), ...o,
  };
  return [d, v.claim, v.answer, v.topics, v.note, v.method, v.methodNote, v.role, v.identity, v.scope, v.limits, v.on];
};
const list = async (c: PoolClient, uid: string, d?: string) => (await as(c, uid, "select public.diet_confirmations($1) r", [d ?? null]))[0].r as J[];

afterAll(async () => {
  await pool.end();
});

describe("dietary confirmation records", () => {
  it("only the founder can record, list or withdraw; members, testers and anonymous visitors are refused", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const member = await user(c);
      const { dish: d } = await dish(c, curator);
      expect(await asErr(c, member, RECORD, args(d))).toBe("FOUNDER_ONLY");
      expect(await asErr(c, curator, RECORD, args(d))).toBe("FOUNDER_ONLY");
      expect(await asErr(c, null, RECORD, args(d))).toMatch(/permission denied/);
      expect(await asErr(c, member, "select public.diet_confirmations(null)")).toBe("FOUNDER_ONLY");
      const r = (await as(c, founder, RECORD, args(d)))[0].r as J;
      expect(await asErr(c, member, "select public.diet_confirmation_withdraw($1, 'no reason')", [r.id])).toBe("FOUNDER_ONLY");
      // The table itself is closed to every client role.
      expect(await asErr(c, member, "select * from staging.diet_confirmations")).toMatch(/permission denied/);
      expect(await asErr(c, founder, "select * from staging.diet_confirmations")).toMatch(/permission denied/);
    }));

  it("keeps every field the owner listed, with a 120-day lapse date, and changes no menu fact", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const { dish: d, place } = await dish(c, curator);
      const before = (await c.query("select count(*)::int n, max(entered_at) m from staging.facts where dish_id = $1", [d])).rows[0];
      const r = (await as(c, founder, RECORD, args(d)))[0].r as J;
      expect(r).toMatchObject({
        dishId: d, placeId: place, claim: "vegetarian", answer: "suitable", topics: ["meat_or_fish_stock", "whole_dish"], method: "staff_in_person",
        sourceRole: "Shift manager", sourceIdentity: "A. Example", scope: "This dish as listed, at this branch", limitations: "Verbal answer; not an allergen statement", state: "current",
      });
      const days = (await c.query("select ($1::date - $2::date) n", [r.expiresOn, r.obtainedOn])).rows[0].n;
      expect(days).toBe(120);
      const after = (await c.query("select count(*)::int n, max(entered_at) m from staging.facts where dish_id = $1", [d])).rows[0];
      expect(after).toEqual(before);
      expect((await list(c, founder, d)).map((x) => x.id)).toEqual([r.id]);
    }));

  it("refuses bad input with plain codes: unknown claim or method, no topic, future or lapsed dates, missing limits", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const { dish: d } = await dish(c, curator);
      expect(await asErr(c, founder, RECORD, args(d, { claim: "pescatarian" }))).toBe("INVALID_REQUEST");
      expect(await asErr(c, founder, RECORD, args(d, { method: "guessed" }))).toBe("INVALID_REQUEST");
      expect(await asErr(c, founder, RECORD, args(d, { topics: [] }))).toBe("INVALID_REQUEST");
      expect(await asErr(c, founder, RECORD, args(d, { topics: ["cuisine"] }))).toBe("INVALID_REQUEST");
      expect(await asErr(c, founder, RECORD, args(d, { limits: "  " }))).toBe("INVALID_REQUEST");
      expect(await asErr(c, founder, RECORD, args(d, { method: "other_documented" }))).toBe("INVALID_REQUEST");
      expect(await asErr(c, founder, RECORD, args(d, { on: "2999-01-01" }))).toBe("OBTAINED_IN_FUTURE");
      expect(await asErr(c, founder, RECORD, args(d, { on: "2020-01-01" }))).toBe("OBTAINED_TOO_LONG_AGO");
      expect(await asErr(c, founder, RECORD, args(randomUUID()))).toBe("NOT_FOUND");
    }));

  it("is append-only: no edit, no delete, one withdrawal with a reason that is kept", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const { dish: d } = await dish(c, curator);
      const r = (await as(c, founder, RECORD, args(d)))[0].r as J;
      await c.query("savepoint e");
      await expect(c.query("update staging.diet_confirmations set answer = 'not_suitable' where id = $1", [r.id])).rejects.toThrow("RECORD_IMMUTABLE");
      await c.query("rollback to savepoint e");
      await expect(c.query("delete from staging.diet_confirmations where id = $1", [r.id])).rejects.toThrow("RECORD_IMMUTABLE");
      await c.query("rollback to savepoint e");
      expect(await asErr(c, founder, "select public.diet_confirmation_withdraw($1, ' ')", [r.id])).toBe("INVALID_REQUEST");
      const w = (await as(c, founder, "select public.diet_confirmation_withdraw($1, 'Recorded against the wrong dish') r", [r.id]))[0].r as J;
      expect(w).toMatchObject({ state: "withdrawn", withdrawnReason: "Recorded against the wrong dish", answerNote: r.answerNote });
      expect(await asErr(c, founder, "select public.diet_confirmation_withdraw($1, 'again')", [r.id])).toBe("ALREADY_WITHDRAWN");
    }));

  it("lapses when the dish's menu facts change after it was recorded, and after 120 days", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const { dish: d, place, site, today } = await dish(c, curator);
      const r = (await as(c, founder, RECORD, args(d)))[0].r as J;
      expect(r.state).toBe("current");
      await one(c, "staging.submit_fact($1, $2::jsonb)", [curator, JSON.stringify({ placeId: place, dishId: d, sourcePageId: site, checkedOn: today, kind: "price", value: { usd: "15.00" } })]);
      expect((await list(c, founder, d))[0].state).toBe("menu_changed");
      // An old record (bypassing the form's 120-day check, as a stored record ages) reads as expired.
      await c.query("alter table staging.diet_confirmations disable trigger diet_confirmations_guard");
      await c.query("update staging.diet_confirmations set obtained_on = current_date - 121, expires_on = current_date - 1, menu_fingerprint = staging.dish_menu_fingerprint(dish_id) where id = $1", [r.id]);
      await c.query("alter table staging.diet_confirmations enable trigger diet_confirmations_guard");
      expect((await list(c, founder, d))[0].state).toBe("expired");
    }));

  it("never touches what members or testers see: the member beta menu has no record fields", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const { dish: d } = await dish(c, curator);
      await as(c, founder, RECORD, args(d));
      const fns = (await c.query("select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosrc ilike '%diet_confirmations%'")).rows.map((x) => x.proname).sort();
      expect(fns).toEqual(["diet_confirmation_record", "diet_confirmation_withdraw", "diet_confirmations"]);
    }));
});

describe("meal review notes (founder review queue)", () => {
  it("founder-only, append-only, plain codes, and they change no fact", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const member = await user(c);
      const { dish: d } = await dish(c, curator);
      const ADD = "select public.meal_review_note_add($1, $2, $3) r";
      expect(await asErr(c, member, ADD, [d, "needs_evidence", "Ask about stock"])).toBe("FOUNDER_ONLY");
      expect(await asErr(c, null, ADD, [d, "needs_evidence", "Ask about stock"])).toMatch(/permission denied/);
      expect(await asErr(c, founder, ADD, [d, "approve", "x y z"])).toBe("INVALID_REQUEST");
      expect(await asErr(c, founder, ADD, [d, "needs_evidence", " "])).toBe("INVALID_REQUEST");
      expect(await asErr(c, founder, ADD, [randomUUID(), "needs_evidence", "Ask about stock"])).toBe("NOT_FOUND");
      const before = (await c.query("select count(*)::int n from staging.facts where dish_id = $1 and status = 'submitted'", [d])).rows[0].n;
      const n = (await as(c, founder, ADD, [d, "restaurant_confirmation", "Is the stock vegetable?"]))[0].r as J;
      expect(n).toMatchObject({ dishId: d, outcome: "restaurant_confirmation", note: "Is the stock vegetable?" });
      await as(c, founder, ADD, [d, "cleared", "Asked in person; recorded separately"]);
      const list = (await as(c, founder, "select public.meal_review_notes() r"))[0].r as J[];
      expect(list.filter((x) => x.dishId === d).map((x) => x.outcome)).toEqual(["cleared", "restaurant_confirmation"]);
      expect(await asErr(c, member, "select public.meal_review_notes()")).toBe("FOUNDER_ONLY");
      await c.query("savepoint e");
      await expect(c.query("update staging.meal_review_notes set note = 'changed' where id = $1", [n.id])).rejects.toThrow("RECORD_IMMUTABLE");
      await c.query("rollback to savepoint e");
      await expect(c.query("delete from staging.meal_review_notes where id = $1", [n.id])).rejects.toThrow("RECORD_IMMUTABLE");
      await c.query("rollback to savepoint e");
      expect((await c.query("select count(*)::int n from staging.facts where dish_id = $1 and status = 'submitted'", [d])).rows[0].n).toBe(before);
    }));
});
