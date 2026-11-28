import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool, clearTestHosts } from "../helpers/db";

// Founder review of the meals invited testers may see (owner direction 23 Nov 2026 19:34 UTC item 3; migration
// 20261123000200). Each test runs inside ONE rolled-back transaction. Names and addresses are invented.

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
  // Like every real research source, the restaurant's site is a private-pilot source (founder review = confirm transcription).
  for (const [kind, status, at] of [["terms_review", "unclear", "now() - interval '1 hour'"], ["owner_decision", "private_pilot", "now()"]]) {
    await c.query(`insert into staging.source_access (host, kind, status, evidence, permitted_uses, reviewer, reviewed_at)
                   values ('pilot-tm.test', $1, $2, 'Test evidence', null, 'Test reviewer', ${at})`, [kind, status]);
  }
  const today = (await c.query("select (now() at time zone 'America/New_York')::date::text as d")).rows[0].d as string;
  const p = await one(c, "staging.add_place($1, $2, 'back_bay', 2::smallint)", [curator, `Beta Test Kitchen ${randomUUID().slice(0, 6)}`]);
  const site = await one(c, "staging.add_source_page($1, $2, 'restaurant_site', 'Beta Test', now(), 'Facts only')", [curator, `https://pilot-tm.test/menu-${randomUUID().slice(0, 8)}`]);
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
  await check(L.price, "found");
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
const setSwitch = (c: PoolClient, on: boolean, mode = "reviewed_meals") => c.query("update staging.member_beta_switch set enabled = $1, meal_mode = $2", [on, mode]);
const decide = (c: PoolClient, uid: string, dish: string, decision: string, reason = "Test reason") =>
  as(c, uid, "select public.tester_meal_decide($1, $2, $3) r", [dish, decision, reason]).then((r) => r[0].r as J);
/** The founder's own source review of facts (migration 20261125000300 makes it a condition for testers). */
const review = (c: PoolClient, founder: string, facts: string[]) =>
  as(c, founder, "select public.menu_review_decide($1::jsonb) r", [JSON.stringify(facts.map((factId) => ({ factId, decision: "confirm_transcription" })))]);
const reviewLentil = (c: PoolClient, founder: string, b: { dishes: Record<string, { facts: Record<string, string> }> }) =>
  review(c, founder, Object.values(b.dishes["Lentil Plate"].facts));
const menuDishes = async (c: PoolClient, uid: string, p: string) =>
  ((await as(c, uid, "select public.member_beta_place($1) r", [p]))[0].r as J).dishes.map((d: J) => d.label as string);

afterAll(async () => {
  await pool.end();
});

describe("tester meal review", () => {
  it("is the default mode, and a member sees no meal until the founder includes one", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const member = await user(c);
      const b = await place(c, curator);
      await enrol(c, b.place);
      // A fresh database starts in the reviewed-meals mode (the column default the hosted beta gets).
      expect(await one(c, "(select column_default from information_schema.columns where table_schema = 'staging' and table_name = 'member_beta_switch' and column_name = 'meal_mode')")).toBe("'reviewed_meals'::text");
      await setSwitch(c, true);
      // No meal included: the restaurant is not even listed, and its menu is empty.
      expect(((await as(c, member, "select public.member_beta_index() r"))[0].r as J[]).map((x) => x.placeId)).not.toContain(b.place);
      expect(await menuDishes(c, member, b.place)).toEqual([]);
      expect(await asErr(c, member, "select public.menu_preview_save($1, true)", [b.dishes["Lentil Plate"].id])).toBe("FOUNDER_ONLY");
      // Every evidence check passes, but the founder has not source-reviewed the facts yet: not includable.
      const before = (await one(c, "staging.tester_meal_checks($1)", [b.dishes["Lentil Plate"].id])) as J;
      expect([before.rights, before.stated, before.price, before.reviewed]).toEqual([true, true, true, false]);
      expect(await asErr(c, founder, "select public.tester_meal_decide($1, 'include', 'Too early')", [b.dishes["Lentil Plate"].id])).toBe("CHECKS_FAIL");
      await reviewLentil(c, founder, b);
      expect(((await one(c, "staging.tester_meal_checks($1)", [b.dishes["Lentil Plate"].id])) as J).reviewedDiets).toEqual(["vegetarian"]);
      const r = await decide(c, founder, b.dishes["Lentil Plate"].id, "include", "Clear vegetarian label");
      expect(r.included).toBe(true);
      expect(((await as(c, member, "select public.member_beta_index() r"))[0].r as J[]).map((x) => x.placeId)).toContain(b.place);
      expect(await menuDishes(c, member, b.place)).toEqual(["Lentil Plate"]);
      // Leaving it out hides it again; the record keeps both decisions.
      await decide(c, founder, b.dishes["Lentil Plate"].id, "leave_out", "Changed my mind");
      expect(await menuDishes(c, member, b.place)).toEqual([]);
      expect(Number(await one(c, "(select count(*) from staging.tester_meal_decisions where dish_id = $1)", [b.dishes["Lentil Plate"].id]))).toBe(2);
    }));

  it("refuses to include a meal that fails a check, and refuses anyone but the founder", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const member = await user(c);
      const b = await place(c, curator);
      await enrol(c, b.place);
      await setSwitch(c, true);
      // Mystery Bowl's menu text was not found on the saved page, and its price was never checked.
      const checks = (await one(c, "staging.tester_meal_checks($1)", [b.dishes["Mystery Bowl"].id])) as J;
      expect(checks.rights).toBe(false);
      expect(await asErr(c, founder, "select public.tester_meal_decide($1, 'include', 'Try it')", [b.dishes["Mystery Bowl"].id])).toBe("CHECKS_FAIL");
      expect(await asErr(c, member, "select public.tester_meal_decide($1, 'include', 'Try it')", [b.dishes["Lentil Plate"].id])).toBe("FOUNDER_ONLY");
      expect(await asErr(c, curator, "select public.tester_meal_decide($1, 'include', 'Try it')", [b.dishes["Lentil Plate"].id])).toBe("FOUNDER_ONLY");
      expect(await asErr(c, member, "select public.tester_meal_queue()")).toBe("FOUNDER_ONLY");
      expect(await asErr(c, null, "select public.tester_meal_queue()")).toMatch(/permission denied/);
      expect(await asErr(c, founder, "select public.tester_meal_decide($1, 'include', 'x')", [b.dishes["Lentil Plate"].id])).toBe("BAD_REASON");
      // Members can never read or write the decision record directly.
      expect(await asErr(c, member, "select * from staging.tester_meal_decisions")).toMatch(/permission denied/);
    }));

  it("needs the restaurant enrolled and its own vegetarian or vegan words, and drops a meal whose label later says no", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const member = await user(c);
      const b = await place(c, curator);
      const lentil = b.dishes["Lentil Plate"].id;
      expect(((await one(c, "staging.tester_meal_checks($1)", [lentil])) as J).place).toBe(false);
      expect(await asErr(c, founder, "select public.tester_meal_decide($1, 'include', 'Try it')", [lentil])).toBe("CHECKS_FAIL");
      await enrol(c, b.place);
      await setSwitch(c, true);
      await reviewLentil(c, founder, b);
      await decide(c, founder, lentil, "include");
      expect(await menuDishes(c, member, b.place)).toEqual(["Lentil Plate"]);
      // A later fact from the restaurant saying "not vegetarian" fails the check: the meal drops out by itself.
      const site = (await one(c, "(select source_page_id from staging.facts where dish_id = $1 limit 1)", [lentil])) as string;
      const today = (await c.query("select (now() at time zone 'America/New_York')::date::text as d")).rows[0].d as string;
      await one(c, "staging.submit_fact($1, $2::jsonb)", [curator, JSON.stringify({ placeId: b.place, dishId: lentil, sourcePageId: site, checkedOn: today, kind: "dietary_status", subject: "vegetarian", value: { claim: "vegetarian", status: "no" } })]);
      expect(await one(c, "staging.tester_meal_included($1)", [lentil])).toBe(false);
      expect(await menuDishes(c, member, b.place)).toEqual([]);
    }));

  it("confirms and publishes nothing when a meal is included", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const b = await place(c, curator);
      await enrol(c, b.place);
      await setSwitch(c, false);
      await reviewLentil(c, founder, b);
      const reviewed = Number(await one(c, "(select count(*) from staging.fact_confirmations where fact_id in (select id from staging.facts where place_id = $1))", [b.place]));
      expect(reviewed).toBe(3);
      await decide(c, founder, b.dishes["Lentil Plate"].id, "include");
      // Including adds no confirmation of its own: only the three the founder made above.
      expect(Number(await one(c, "(select count(*) from staging.fact_confirmations where fact_id in (select id from staging.facts where place_id = $1))", [b.place]))).toBe(reviewed);
      expect(Number(await one(c, "(select count(*) from staging.facts where place_id = $1 and status = 'verified')", [b.place]))).toBe(0);
      expect(Number(await one(c, "(select count(*) from public.place_listings where slug = $1 and visibility = 'public')", [b.slug]))).toBe(0);
      // The switch is untouched: still off.
      expect(await one(c, "(select enabled from staging.member_beta_switch)")).toBe(false);
    }));

  it("never hides a found fact the founder has not reviewed yet, so a listed ingredient (a possible warning) still shows", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const member = await user(c);
      const b = await place(c, curator);
      const lentil = b.dishes["Lentil Plate"];
      await enrol(c, b.place);
      await setSwitch(c, true);
      // An ingredient list found on the page but not reviewed by the founder.
      const site = (await one(c, "(select source_page_id from staging.facts where dish_id = $1 limit 1)", [lentil.id])) as string;
      const today = (await c.query("select (now() at time zone 'America/New_York')::date::text as d")).rows[0].d as string;
      const ing = (await one(c, "staging.submit_fact($1, $2::jsonb)", [curator, JSON.stringify({ placeId: b.place, dishId: lentil.id, sourcePageId: site, checkedOn: today, kind: "listed_ingredients", value: { items: ["lentils", "rice"] } })])) as string;
      await c.query("select staging.record_machine_check($1, $2, 'found', 'test', $3, now())", [curator, ing, "a".repeat(64)]);
      await reviewLentil(c, founder, b);
      await decide(c, founder, lentil.id, "include");
      const kinds = async () => {
        const menu = (await as(c, member, "select public.member_beta_place($1) r", [b.place]))[0].r as J;
        return (menu.dishes.find((d: J) => d.label === "Lentil Plate").facts as J[]).map((f) => f.kind).sort();
      };
      // The meal needed the founder's review of its item, price and label; the unreviewed ingredient list still shows.
      expect(await kinds()).toEqual(["dietary_status", "listed_ingredients", "menu_item", "price"]);
      expect(await one(c, "(select count(*)::int from staging.fact_confirmations where fact_id = $1)", [ing])).toBe(0);
    }));

  it("gives the founder a read-only member preview with every gate, refuses anyone else, and writes nothing", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const member = await user(c);
      const b = await place(c, curator);
      const lentil = b.dishes["Lentil Plate"];
      // An ingredient list naming egg, found on the page and never reviewed: the preview must show it, as members would.
      const site = (await one(c, "(select source_page_id from staging.facts where dish_id = $1 limit 1)", [lentil.id])) as string;
      const today = (await c.query("select (now() at time zone 'America/New_York')::date::text as d")).rows[0].d as string;
      const ing = (await one(c, "staging.submit_fact($1, $2::jsonb)", [curator, JSON.stringify({ placeId: b.place, dishId: lentil.id, sourcePageId: site, checkedOn: today, kind: "listed_ingredients", value: { items: ["lentils", "egg"] } })])) as string;
      await c.query("select staging.record_machine_check($1, $2, 'found', 'test', $3, now())", [curator, ing, "a".repeat(64)]);
      const counts = async () => (await c.query("select (select count(*) from staging.fact_confirmations) + (select count(*) from staging.tester_meal_decisions) + (select count(*) from staging.member_beta_places) n")).rows[0].n;
      await setSwitch(c, false);
      const before = await counts();
      const preview = async () => (await as(c, founder, "select public.member_preview_meal($1) r", [lentil.id]))[0].r as J;
      let p = await preview();
      expect(p.gates).toMatchObject({ evidence: true, enrolled: false, reviewed: false, included: false, switchOn: false, visibleNow: false });
      expect((p.place.dishes[0].facts as J[]).map((f) => f.kind).sort()).toEqual(["dietary_status", "listed_ingredients", "menu_item", "price"]);
      expect(JSON.stringify(p.place.dishes[0].facts)).toContain("egg");
      // The meal whose menu item was not found shows no menu item, as for a member.
      const mystery = (await as(c, founder, "select public.member_preview_meal($1) r", [b.dishes["Mystery Bowl"].id]))[0].r as J;
      expect((mystery.place.dishes[0].facts as J[]).map((f) => f.kind)).not.toContain("menu_item");
      expect(await counts()).toBe(before);
      // Every gate passing: enrolled, reviewed, included, switch on. Then a member can see it now.
      await enrol(c, b.place);
      await reviewLentil(c, founder, b);
      await decide(c, founder, lentil.id, "include");
      await setSwitch(c, true);
      p = await preview();
      expect(p.gates).toMatchObject({ evidence: true, enrolled: true, reviewed: true, included: true, switchOn: true, visibleNow: true });
      expect(await asErr(c, member, "select public.member_preview_meal($1)", [lentil.id])).toBe("FOUNDER_ONLY");
      expect(await asErr(c, null, "select public.member_preview_meal($1)", [lentil.id])).toMatch(/permission denied|NOT_SIGNED_IN/);
    }));

  it("keeps the whole-place mode for the local beta when chosen explicitly", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const member = await user(c);
      const b = await place(c, curator);
      await enrol(c, b.place);
      await setSwitch(c, true, "whole_place");
      expect(await menuDishes(c, member, b.place)).toEqual(["Lentil Plate"]);
    }));

  it("caps the tester set at 75 meals", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const b = await place(c, curator);
      await enrol(c, b.place);
      const lentil = b.dishes["Lentil Plate"].id;
      const site = (await one(c, "(select source_page_id from staging.facts where dish_id = $1 limit 1)", [lentil])) as string;
      const today = (await c.query("select (now() at time zone 'America/New_York')::date::text as d")).rows[0].d as string;
      for (let i = 0; i < 75; i++) {
        const d = (await one(c, "staging.add_dish($1, $2, $3)", [curator, b.place, `Copy ${i}`])) as string;
        await c.query("select staging.classify_dish($1, $2, 'complete_meal', null, 'Mains', null, 'source_section', null)", [curator, d]);
        for (const [kind, extra] of [
          ["menu_item", { value: { listed: true } }],
          ["price", { value: { usd: "12.00" } }],
          ["dietary_status", { subject: "vegan", value: { claim: "vegan", status: "yes" } }],
        ] as const) {
          const f = await one(c, "staging.submit_fact($1, $2::jsonb)", [curator, JSON.stringify({ placeId: b.place, dishId: d, sourcePageId: site, checkedOn: today, kind, ...extra })]);
          await c.query("select staging.record_machine_check($1, $2, 'found', 'test', $3, now())", [curator, f, "a".repeat(64)]);
          await review(c, founder, [f as string]);
        }
        await decide(c, founder, d, "include");
      }
      await reviewLentil(c, founder, b);
      expect(await asErr(c, founder, "select public.tester_meal_decide($1, 'include', 'One more')", [lentil])).toBe("LIMIT_REACHED");
      // Leaving one out makes room again.
      await decide(c, founder, (await one(c, "(select id from staging.dishes where place_id = $1 and label = 'Copy 0')", [b.place])) as string, "leave_out");
      expect((await decide(c, founder, lentil, "include")).included).toBe(true);
    }));
});

// Founder review edge cases (owner overnight directive 26 Nov 2026 06:48 UTC, part 4). Same fixtures; each test rolls back.
describe("founder review edge cases", () => {
  it("partial review: reviewing the menu item and price but not the diet label leaves the meal unreviewed and not includable", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const b = await place(c, curator);
      await enrol(c, b.place);
      const L = b.dishes["Lentil Plate"];
      await review(c, founder, [L.facts.item, L.facts.price]);
      const checks = (await one(c, "staging.tester_meal_checks($1)", [L.id])) as J;
      expect(checks.reviewed).toBe(false);
      expect(await asErr(c, founder, "select public.tester_meal_decide($1, 'include', 'Test reason')", [L.id])).toMatch(/CHECKS_FAIL/);
      await review(c, founder, [L.facts.diet]);
      expect(((await one(c, "staging.tester_meal_checks($1)", [L.id])) as J).reviewed).toBe(true);
    }));

  it("repeated action: a second source review of the same fact is refused and records nothing more; the database backs this with a unique key", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const b = await place(c, curator);
      const f = b.dishes["Lentil Plate"].facts.item;
      await review(c, founder, [f]);
      expect(await asErr(c, founder, "select public.menu_review_decide($1::jsonb)", [JSON.stringify([{ factId: f, decision: "confirm_transcription" }])])).toMatch(/ALREADY_REVIEWED/);
      expect(await one(c, "(select count(*)::int from staging.fact_confirmations where fact_id = $1)", [f])).toBe(1);
      // Two simultaneous clicks: the function locks the fact row, and the unique (fact, level) key refuses a second row.
      await c.query("savepoint u");
      await expect(c.query("insert into staging.fact_confirmations (fact_id, level, confirmed_by) values ($1, 'transcription', $2)", [f, founder])).rejects.toThrow(/duplicate key/);
      await c.query("rollback to savepoint u");
    }));

  it("negative review: a rejected price stays rejected with its note, and the meal can no longer be included", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const b = await place(c, curator);
      await enrol(c, b.place);
      const L = b.dishes["Lentil Plate"];
      await as(c, founder, "select public.menu_review_decide($1::jsonb)", [JSON.stringify([{ factId: L.facts.price, decision: "reject", note: "Price differs from the saved page" }])]);
      const row = (await c.query("select status, review_note from staging.facts where id = $1", [L.facts.price])).rows[0];
      expect(row).toEqual({ status: "rejected", review_note: "Price differs from the saved page" });
      await review(c, founder, [L.facts.item, L.facts.diet]);
      expect(await asErr(c, founder, "select public.tester_meal_decide($1, 'include', 'Test reason')", [L.id])).toMatch(/CHECKS_FAIL/);
    }));

  it("changed source: a newer saved copy that no longer shows the label drops an included meal, and keeps the earlier review as written", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const b = await place(c, curator);
      await enrol(c, b.place);
      const L = b.dishes["Lentil Plate"];
      await reviewLentil(c, founder, b);
      await decide(c, founder, L.id, "include");
      expect(await one(c, "staging.tester_meal_included($1)", [L.id])).toBe(true);
      // The page changed: a new automatic comparison on a different saved copy no longer finds the diet label.
      await c.query("select staging.record_machine_check($1, $2, 'not_found', 'test: page changed', $3, now() + interval '1 minute')", [curator, L.facts.diet, "b".repeat(64)]);
      expect(await one(c, "staging.tester_meal_included($1)", [L.id])).toBe(false);
      expect(await one(c, "(select count(*)::int from staging.fact_confirmations where fact_id = $1)", [L.facts.diet])).toBe(1);
    }));

  it("a source review never says more than the source: no verified diet, no verified nutrition, no egg-free claim", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const b = await place(c, curator);
      await reviewLentil(c, founder, b);
      for (const f of Object.values(b.dishes["Lentil Plate"].facts)) {
        const s = (await c.query("select status, (public.menu_review_fact_json(x, $2) -> 'statuses') st from staging.facts x where id = $1", [f, founder])).rows[0];
        expect(s.status).toBe("submitted");
        expect(s.st).toMatchObject({ transcriptionConfirmed: true, dietaryVerified: false, nutritionVerified: false, publicationApproved: false });
      }
      // The only diet label is "vegetarian": nothing anywhere says vegan or egg-free.
      expect(await one(c, "(select count(*)::int from staging.facts where place_id = $1 and kind = 'dietary_status' and subject <> 'vegetarian')", [b.place])).toBe(0);
    }));

  it("only the founder can write a review note or read the tester queue; members, curators and guests are refused", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const member = await user(c);
      const b = await place(c, curator);
      const L = b.dishes["Lentil Plate"].id;
      for (const uid of [member, curator])
        expect(await asErr(c, uid, "select public.meal_review_note_add($1, 'needs_evidence', 'Test note')", [L])).toMatch(/FOUNDER_ONLY/);
      expect(await asErr(c, null, "select public.meal_review_note_add($1, 'needs_evidence', 'Test note')", [L])).toMatch(/permission denied|NOT_SIGNED_IN|PT401/i);
      for (const uid of [member, curator]) expect(await asErr(c, uid, "select public.tester_meal_queue()")).toMatch(/FOUNDER_ONLY/);
      expect(await asErr(c, null, "select public.tester_meal_queue()")).toMatch(/permission denied/i);
    }));

  it("no decision publishes anything or turns anything on", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const member = await user(c);
      const b = await place(c, curator);
      await enrol(c, b.place);
      const before = (await c.query(`select (select count(*) from public.place_listings where visibility = 'public') pub, (select count(*) from public.catalog_changes) changes,
                                            (select jsonb_agg(enabled order by name) from app.platform_switches) sw, (select enabled from staging.member_beta_switch) beta`)).rows[0];
      await reviewLentil(c, founder, b);
      await decide(c, founder, b.dishes["Lentil Plate"].id, "include");
      await as(c, founder, "select public.meal_review_note_add($1, 'cleared', 'Test note')", [b.dishes["Mystery Bowl"].id]);
      const after = (await c.query(`select (select count(*) from public.place_listings where visibility = 'public') pub, (select count(*) from public.catalog_changes) changes,
                                           (select jsonb_agg(enabled order by name) from app.platform_switches) sw, (select enabled from staging.member_beta_switch) beta`)).rows[0];
      expect(after).toEqual(before);
      // With the member beta off (as it is), a member sees no meal at all.
      expect(await asErr(c, member, "select public.member_beta_place($1)", [b.place])).toBeTruthy();
    }));
});
