import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool, clearTestHosts } from "../helpers/db";

// Real meals in the staged local member beta: logging, lists and reviews (owner directive 23 Nov 2026 02:04 UTC,
// section 6; migration 20261123000100). Each test runs inside ONE rolled-back transaction. Names and addresses are
// invented, never real restaurants. The place helper is the one in member-beta.test.ts.

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

const LOG = "select public.log_real_meal($1, $2, $3, $4, 1, 'lunch', $5::date, 'America/New_York', null) r";
const today = async (c: PoolClient) => (await c.query("select (now() at time zone 'America/New_York')::date::text as d")).rows[0].d as string;
/** Two printed figures on the member-visible meal: protein (found on the saved page) and energy (not found). */
async function figures(c: PoolClient, curator: string, b: Awaited<ReturnType<typeof place>> & { checkedOn: string }) {
  const dish = b.dishes["Lentil Plate"].id;
  const f = (await c.query("select place_id, source_page_id from staging.facts where id = $1", [b.dishes["Lentil Plate"].facts.item])).rows[0];
  const fact = (subject: string, amount: string) =>
    one(c, "staging.submit_fact($1, $2::jsonb)", [curator, JSON.stringify({ placeId: f.place_id, dishId: dish, sourcePageId: f.source_page_id, checkedOn: b.checkedOn, kind: "published_nutrition", subject, value: { amount, per: "serving" } })]);
  const protein = (await fact("protein_g", "31")) as string;
  const energy = (await fact("energy_kcal", "640")) as string;
  await c.query("select staging.record_machine_check($1, $2, 'found', 'test', $3, now())", [curator, protein, "a".repeat(64)]);
  await c.query("select staging.record_machine_check($1, $2, 'not_found', 'test', $3, now())", [curator, energy, "a".repeat(64)]);
  return dish;
}
const attribution = async (c: PoolClient, foodItemId: string) =>
  (await c.query("select a.attribution from public.food_items i join public.custom_food_attributions a on a.revision_id = i.current_revision_id where i.id = $1", [foodItemId])).rows[0].attribution as J;

afterAll(async () => {
  await pool.end();
});

describe("member local beta: log, list and review real meals", () => {
  it("lets a member log a beta meal while the switch is on, recording only figures a member may see", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const member = await user(c);
      const b = { ...(await place(c, curator)), checkedOn: await today(c) };
      const dish = await figures(c, curator, b);
      await enrol(c, b.place);
      await setSwitch(c, false);
      expect(await asErr(c, member, LOG, [randomUUID(), dish, 31, 640, b.checkedOn])).toBe("FOUNDER_ONLY");
      await setSwitch(c, true);
      const r = (await as(c, member, LOG, [randomUUID(), dish, 31, 640, b.checkedOn]))[0].r as J;
      const mine = await attribution(c, r.foodItemId);
      expect(mine.protein.method).toBe("published"); // the protein figure was found on the saved page
      expect(mine.protein.sourceAmount).toBe(31);
      expect(mine.energy.method).toBe("user_entered"); // the energy figure was not: the member never saw it
      expect(mine.energy.sourceAmount).toBeNull();
      expect(mine.status).toBe("unverified_draft");
      // The founder logging the same meal sees both printed figures, as before.
      const f = (await as(c, founder, LOG, [randomUUID(), dish, 31, 640, b.checkedOn]))[0].r as J;
      expect((await attribution(c, f.foodItemId)).energy.method).toBe("published");
      // A repeated submit returns the first entry; nobody else can read the member's entry.
      const key = randomUUID();
      const first = (await as(c, member, LOG, [key, dish, 31, 640, b.checkedOn]))[0].r as J;
      const again = (await as(c, member, LOG, [key, dish, 31, 640, b.checkedOn]))[0].r as J;
      expect(again.entryId).toBe(first.entryId);
      expect(again.replayed).toBe(true);
      const other = await user(c);
      expect(await as(c, other, "select id from public.diary_entries where id = $1", [first.entryId])).toEqual([]);
    }));

  it("refuses a meal the member may not see: an unenrolled place, or a dish the page check did not find", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const member = await user(c);
      const b = await place(c, curator);
      const other = await place(c, curator);
      await enrol(c, b.place);
      await setSwitch(c, true);
      const d = await today(c);
      expect(await asErr(c, member, LOG, [randomUUID(), other.dishes["Lentil Plate"].id, null, null, d])).toBe("FOUNDER_ONLY");
      expect(await asErr(c, member, LOG, [randomUUID(), b.dishes["Mystery Bowl"].id, null, null, d])).toBe("FOUNDER_ONLY");
      expect(await asErr(c, member, "select public.menu_preview_review_set($1, 4)", [b.dishes["Mystery Bowl"].id])).toBe("FOUNDER_ONLY");
      expect(await asErr(c, null, "select public.menu_preview_review_set($1, 4)", [b.dishes["Lentil Plate"].id])).toMatch(/permission denied/);
      expect(await asErr(c, null, LOG, [randomUUID(), b.dishes["Lentil Plate"].id, null, null, d])).toMatch(/permission denied/);
    }));

  it("keeps a member's list entries and reviews of beta meals private, and hides them while the switch is off", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const a = await user(c);
      const z = await user(c);
      const b = await place(c, curator);
      const dish = b.dishes["Lentil Plate"].id;
      await enrol(c, b.place);
      await setSwitch(c, true);
      const list = (await c.query("insert into public.food_lists (owner_id, title, visibility, publication_state) values ($1, 'Beta lunches', 'public', 'visible') returning id", [a])).rows[0].id as string;
      const publicBefore = (await c.query("select (select count(*) from public.food_list_items)::int li, (select count(*) from public.reviews)::int rv")).rows[0];
      await as(c, a, "select public.menu_preview_list_set($1, $2, true)", [list, dish]);
      await as(c, a, "select public.menu_preview_review_set($1, 5, 'Filling and good', null)", [dish]);
      const entries = (await as(c, a, "select public.menu_preview_list_entries($1) r", [list]))[0].r as J[];
      expect(entries.map((e) => e.dishId)).toEqual([dish]);
      expect(((await as(c, a, "select public.menu_preview_meal_lists($1) r", [dish]))[0].r as J[]).map((l) => l.listId)).toEqual([list]);
      expect(((await as(c, a, "select public.menu_preview_reviews() r"))[0].r as J[]).map((r) => [r.dishId, r.rating])).toEqual([[dish, 5]]);
      // Another member sees none of it, even on a published list; nothing reached a public table.
      expect((await as(c, z, "select public.menu_preview_list_entries($1) r", [list]))[0].r).toEqual([]);
      expect((await as(c, z, "select public.menu_preview_reviews() r"))[0].r).toEqual([]);
      expect(await asErr(c, z, "select public.menu_preview_list_set($1, $2, true)", [list, dish])).toBe("NOT_FOUND");
      const publicAfter = (await c.query("select (select count(*) from public.food_list_items)::int li, (select count(*) from public.reviews)::int rv")).rows[0];
      expect(publicAfter).toEqual(publicBefore);
      // Switch off: hidden, not deleted; switch on again: back.
      await setSwitch(c, false);
      expect(await asErr(c, a, "select public.menu_preview_reviews()")).toBe("FOUNDER_ONLY");
      expect(await asErr(c, a, "select public.menu_preview_list_entries($1)", [list])).toBe("FOUNDER_ONLY");
      expect(await asErr(c, a, "select public.menu_preview_review_set($1, 3)", [dish])).toBe("FOUNDER_ONLY");
      expect((await c.query("select count(*)::int n from staging.preview_reviews where user_id = $1", [a])).rows[0].n).toBe(1);
      await setSwitch(c, true);
      expect(((await as(c, a, "select public.menu_preview_reviews() r"))[0].r as J[]).length).toBe(1);
      // A member can delete their own review and take the meal off their list.
      await as(c, a, "select public.menu_preview_review_delete($1)", [dish]);
      await as(c, a, "select public.menu_preview_list_set($1, $2, false)", [list, dish]);
      expect((await as(c, a, "select public.menu_preview_reviews() r"))[0].r).toEqual([]);
      expect((await as(c, a, "select public.menu_preview_list_entries($1) r", [list]))[0].r).toEqual([]);
    }));
});
