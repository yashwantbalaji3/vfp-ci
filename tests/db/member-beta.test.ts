import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool, clearTestHosts } from "../helpers/db";

// Staged member-visible LOCAL beta (owner decision 22 Nov 2026 15:26 UTC; migration 20261122000600). Each test runs
// inside ONE rolled-back transaction. Names and addresses are invented, never real restaurants.

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

/**
 * A linked researched place with a listing and two complete meals: "Lentil Plate" (menu item and diet label
 * found on the saved page) and "Mystery Bowl" (its menu item was not found by the automatic check).
 */
async function place(c: PoolClient, curator: string) {
  await clearTestHosts(c);
  const today = (await c.query("select (now() at time zone 'America/New_York')::date::text as d")).rows[0].d as string;
  const p = await one(c, "staging.add_place($1, $2, 'back_bay', 2::smallint)", [curator, `Beta Test Kitchen ${randomUUID().slice(0, 6)}`]);
  const site = await one(c, "staging.add_source_page($1, $2, 'restaurant_site', 'Beta Test', now(), 'Facts only')", [curator, `https://example.test/menu-${randomUUID().slice(0, 8)}`]);
  const fact = (dish: string, kind: string, extra: J) =>
    one(c, "staging.submit_fact($1, $2::jsonb)", [curator, JSON.stringify({ placeId: p, dishId: dish, sourcePageId: site, checkedOn: today, kind, ...extra })]);
  const check = (f: string, result: string) =>
    c.query("select staging.record_machine_check($1, $2, $3, 'test', $4, now())", [curator, f, result, result === "not_checked" ? null : "a".repeat(64)]);
  const dishes: Record<string, { id: string; facts: Record<string, string> }> = {};
  for (const label of ["Lentil Plate", "Mystery Bowl"]) {
    const id = (await one(c, "staging.add_dish($1, $2, $3)", [curator, p, label])) as string;
    await c.query("select staging.classify_dish($1, $2, 'complete_meal', null, 'Mains', null, 'source_section', null)", [curator, id]);
    const item = (await fact(id, "menu_item", { value: { listed: true } })) as string;
    const price = (await fact(id, "price", { value: { usd: "14.00" } })) as string;
    const diet = (await fact(id, "dietary_status", { subject: "vegetarian", value: { claim: "vegetarian", status: "yes" } })) as string;
    dishes[label] = { id, facts: { item, price, diet } };
  }
  const L = dishes["Lentil Plate"].facts;
  await check(L.item, "found");
  await check(L.diet, "found");
  await check(L.price, "not_found");
  await check(dishes["Mystery Bowl"].facts.item, "not_found");
  await check(dishes["Mystery Bowl"].facts.diet, "found");
  const run = (await c.query("insert into catalog_import.import_runs (source_key, release, file_sha256, retrieved_at, thresholds, status) values ('overture_places', 'test', $1, now(), '{}', 'completed') returning id", ["0".repeat(64)])).rows[0].id;
  const cand = (await c.query("insert into catalog_import.place_candidates (name, street, postcode, lat, lon, category, quality, created_run) values ('Beta Test Kitchen', '1 Beta St', '02116', 42.35, -71.07, 'restaurant', 'corroborated', $1) returning id", [run])).rows[0].id as string;
  await c.query("insert into staging.catalog_links (staging_place, candidate_id, action, method, actor_id) values ($1, $2, 'link', 'address_match', $3)", [p, cand, curator]);
  const slug = `beta-test-${randomUUID().slice(0, 8)}`;
  await c.query(
    `insert into public.place_listings (candidate_id, slug, name, street, locality, postcode, area, lat, lon, category, identity_status, sources, built_from)
     values ($1, $2, 'Beta Test Kitchen', '1 Beta St', 'Boston', '02116', 'Back Bay / Prudential', 42.35, -71.07, 'Restaurant', 'corroborated', '[{"key":"overture_places","title":"Test"}]', 'test')`,
    [cand, slug]);
  return { place: p as string, slug, dishes };
}
const enrol = (c: PoolClient, p: string) =>
  c.query("insert into staging.member_beta_places (place_id, stage, decision, recorded_by) values ($1, 1, 'Test owner decision text', 'test')", [p]);
// These files test the whole-place mode; the reviewed-meals mode (20261123000200) has its own file.
const setSwitch = (c: PoolClient, on: boolean) => c.query("update staging.member_beta_switch set enabled = $1, meal_mode = 'whole_place'", [on]);
const detail = (c: PoolClient, uid: string | null, slug: string) => as(c, uid, "select public.place_detail($1, true) d", [slug]).then((r) => r[0].d as J | null);

afterAll(async () => {
  await pool.end();
});

describe("member local beta", () => {
  it("shows nothing to a member while the switch is off, even for an enrolled place", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const member = await user(c);
      const b = await place(c, curator);
      await enrol(c, b.place);
      await setSwitch(c, false);
      expect(await asErr(c, member, "select public.member_beta_index()")).toBe("BETA_OFF");
      expect(await asErr(c, member, "select public.member_beta_place($1)", [b.place])).toBe("NOT_FOUND");
      expect(await detail(c, member, b.slug)).toBeNull();
      expect(await asErr(c, member, "select public.menu_preview_save($1, true)", [b.dishes["Lentil Plate"].id])).toBe("FOUNDER_ONLY");
    }));

  it("never shows anything to a visitor, and an unenrolled place stays founder-only", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const member = await user(c);
      const b = await place(c, curator);
      const other = await place(c, curator);
      await enrol(c, b.place);
      await setSwitch(c, true);
      expect(await asErr(c, null, "select public.member_beta_index()")).toMatch(/permission denied/);
      expect(await asErr(c, null, "select public.member_beta_place($1)", [b.place])).toMatch(/permission denied/);
      expect(await detail(c, null, b.slug)).toBeNull();
      expect(await detail(c, member, other.slug)).toBeNull();
      expect(await asErr(c, member, "select public.member_beta_place($1)", [other.place])).toBe("NOT_FOUND");
      expect(await asErr(c, member, "select public.menu_preview_index()")).toBe("FOUNDER_ONLY");
      expect(await asErr(c, member, "select public.menu_review_place($1)", [b.place])).toBe("FOUNDER_ONLY");
      expect(await asErr(c, member, "select public.menu_preview_save($1, true)", [other.dishes["Lentil Plate"].id])).toBe("FOUNDER_ONLY");
    }));

  it("shows a member only the dishes and facts the automatic page check found, with no confirm actions", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const member = await user(c);
      const b = await place(c, curator);
      await enrol(c, b.place);
      await setSwitch(c, true);
      const idx = (await as(c, member, "select public.member_beta_index() r"))[0].r as J[];
      expect(idx.map((x) => x.placeId)).toContain(b.place);
      expect((await detail(c, member, b.slug))?.visibility).toBe("preview");
      const menu = (await as(c, member, "select public.member_beta_place($1) r", [b.place]))[0].r as J;
      expect(menu.dishes.map((d: J) => d.label)).toEqual(["Lentil Plate"]);
      const facts = menu.dishes[0].facts as J[];
      expect(facts.map((f) => f.kind).sort()).toEqual(["dietary_status", "menu_item"]); // the price was not found on the page
      for (const f of facts) {
        expect(f.canConfirm).toBe(false);
        expect(f.canReject).toBe(false);
        expect(f.ladder.founderConfirmed).toBe(false);
        expect(f.ladder.autoCompared).toBe("found");
      }
      // Nothing was confirmed or published on anyone's behalf.
      expect(Number(await one(c, "(select count(*) from staging.fact_confirmations where fact_id in (select id from staging.facts where place_id = $1))", [b.place]))).toBe(0);
      expect(Number(await one(c, "(select count(*) from public.place_listings where slug = $1 and visibility = 'public')", [b.slug]))).toBe(0);
    }));

  it("lets a member save and plan a beta meal for themselves only, never a hidden one", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const member = await user(c);
      const other = await user(c);
      const b = await place(c, curator);
      await enrol(c, b.place);
      await setSwitch(c, true);
      const lentil = b.dishes["Lentil Plate"].id;
      await as(c, member, "select public.menu_preview_save($1, true)", [lentil]);
      expect((await as(c, member, "select public.menu_preview_saved() r"))[0].r).toEqual([lentil]);
      expect((await as(c, other, "select public.menu_preview_saved() r"))[0].r).toEqual([]);
      expect(await asErr(c, member, "select public.menu_preview_save($1, true)", [b.dishes["Mystery Bowl"].id])).toBe("FOUNDER_ONLY");
      const today = (await c.query("select current_date::text d")).rows[0].d;
      await as(c, member, "select public.menu_preview_plan($1, $2::date, 'lunch')", [lentil, today]);
      expect(((await as(c, member, "select public.menu_preview_plans($1::date, $1::date) r", [today]))[0].r as J[]).map((x) => x.dishId)).toEqual([lentil]);
      expect((await as(c, other, "select public.menu_preview_plans($1::date, $1::date) r", [today]))[0].r).toEqual([]);
      // Turning the beta off hides the saves again without deleting them.
      await setSwitch(c, false);
      expect(await asErr(c, member, "select public.menu_preview_saved()")).toBe("FOUNDER_ONLY");
      expect(Number(await one(c, "(select count(*) from staging.preview_saves where user_id = $1)", [member]))).toBe(1);
    }));

  it("leaves the founder's view unchanged", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const b = await place(c, curator);
      await setSwitch(c, false);
      const menu = (await as(c, founder, "select public.menu_review_place($1) r", [b.place]))[0].r as J;
      expect(menu.dishes.map((d: J) => d.label).sort()).toEqual(["Lentil Plate", "Mystery Bowl"]);
      await as(c, founder, "select public.menu_preview_save($1, true)", [b.dishes["Mystery Bowl"].id]);
    }));
});
