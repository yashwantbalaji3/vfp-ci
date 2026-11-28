import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool, clearTestHosts } from "../helpers/db";

// Pilot staging for real restaurants (approval A-STAGING-1, plan docs/27 A). Every test runs inside
// ONE transaction that is rolled back, so no staged record (and no test account) stays behind.
// Places and pages below are invented test labels, not real restaurants.

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
const err = async (c: PoolClient, sql: string, params: unknown[] = []) => {
  await c.query("savepoint s");
  try {
    await c.query(sql, params);
  } catch (e) {
    await c.query("rollback to savepoint s");
    return e as { code: string; message: string };
  }
  throw new Error(`Expected to fail: ${sql}`);
};
const one = async (c: PoolClient, sql: string, params: unknown[] = []) => (await c.query(`select ${sql} as r`, params)).rows[0].r;

async function user(c: PoolClient, roles: string[]) {
  const id = randomUUID();
  await c.query(
    `insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}', '{}', now(), now())`,
    [id, `staging-${id.slice(0, 8)}@example.test`],
  );
  for (const r of roles) await c.query("insert into public.role_assignments (user_id, role) values ($1, $2)", [id, r]);
  return id;
}

/** A curator, a publisher, a member with no role, one place, one dish and two pages (restaurant, news). */
async function world(c: PoolClient) {
  await clearTestHosts(c);
  const curator = await user(c, ["curator"]);
  const publisher = await user(c, ["publisher"]);
  const both = await user(c, ["curator", "publisher"]);
  const member = await user(c, []);
  const place = await one(c, "staging.add_place($1, 'Test Place One', 'central_square', 1::smallint)", [curator]);
  const dish = await one(c, "staging.add_dish($1, $2, 'Test lentil bowl')", [curator, place]);
  const own = await one(c, "staging.add_source_page($1, 'https://example.test/menu', 'restaurant_site', 'Test Place One', now())", [curator]);
  const news = await one(c, "staging.add_source_page($1, 'https://news.example.test/a', 'news', 'Test News', now())", [curator]);
  const today = (await c.query("select (now() at time zone 'America/New_York')::date::text as d")).rows[0].d as string;
  const submit = (actor: string, p: J) => one(c, "staging.submit_fact($1, $2::jsonb)", [actor, JSON.stringify({ placeId: place, sourcePageId: own, checkedOn: today, ...p })]);
  const review = (actor: string, fact: string, decision = "verify") => one(c, "staging.review_fact($1, $2, $3)", [actor, fact, decision]);
  return { curator, publisher, both, member, place, dish, own, news, today, submit, review };
}
const vegan = (status: "yes" | "no") => ({ kind: "dietary_status", value: { claim: "vegan", status } });

afterAll(async () => {
  await pool.end();
});

describe("S1 two people: one enters, a different one checks", () => {
  it("only curators enter, only publishers check, and never the same person", async () => {
    await tx(async (c) => {
      const w = await world(c);
      // A member with no role cannot enter anything.
      expect((await err(c, "select staging.add_place($1, 'X', 'central_square', 1::smallint)", [w.member])).message).toBe("STAGING_ROLE_REQUIRED");
      expect((await err(c, "select staging.submit_fact($1, $2::jsonb)", [w.member, JSON.stringify({ placeId: w.place, dishId: w.dish, sourcePageId: w.own, checkedOn: w.today, ...vegan("yes") })])).message).toBe("STAGING_ROLE_REQUIRED");
      const f = await w.submit(w.both, { dishId: w.dish, ...vegan("yes") });
      // The person who entered it cannot check it, even holding the publisher role.
      expect((await err(c, "select staging.review_fact($1, $2, 'verify')", [w.both, f])).message).toBe("STAGING_SAME_PERSON");
      // A curator without the publisher role cannot check.
      expect((await err(c, "select staging.review_fact($1, $2, 'verify')", [w.curator, f])).message).toBe("STAGING_ROLE_REQUIRED");
      expect(await w.review(w.publisher, f)).toBe("verified");
      expect((await err(c, "select staging.review_fact($1, $2, 'reject')", [w.publisher, f])).message).toBe("STAGING_ALREADY_REVIEWED");
      const row = (await c.query("select entered_by, reviewer_id, reviewed_at, status from staging.facts where id = $1", [f])).rows[0];
      expect(row).toMatchObject({ entered_by: w.both, reviewer_id: w.publisher, status: "verified" });
      expect(row.reviewed_at).toBeInstanceOf(Date);
      // The database itself refuses a fact checked by the person who entered it.
      const e = await err(c, "update staging.facts set reviewer_id = entered_by where id = $1", [f]);
      expect(["23514", "P0001"]).toContain(e.code);
    });
  });
});

describe("S2 every fact keeps its source, check date, status and reviewer", () => {
  it("refuses a fact without a source page or with a future or impossible check date", async () => {
    await tx(async (c) => {
      const w = await world(c);
      expect((await err(c, "select staging.submit_fact($1, $2::jsonb)", [w.curator, JSON.stringify({ placeId: w.place, kind: "operating_status", value: { status: "operating" }, checkedOn: w.today })])).message).toBe("STAGING_SOURCE_REQUIRED");
      expect((await err(c, "select staging.submit_fact($1, $2::jsonb)", [w.curator, JSON.stringify({ placeId: w.place, sourcePageId: w.own, kind: "operating_status", value: { status: "operating" }, checkedOn: "2999-01-01" })])).message).toBe("STAGING_BAD_CHECK_DATE");
      expect((await err(c, "select staging.submit_fact($1, $2::jsonb)", [w.curator, JSON.stringify({ placeId: w.place, sourcePageId: w.own, kind: "operating_status", value: { status: "operating" }, checkedOn: "2020-01-01" })])).message).toBe("STAGING_BAD_CHECK_DATE");
      expect((await err(c, "select staging.add_source_page($1, 'http://example.test/x', 'restaurant_site', 'X', now())", [w.curator])).code).toBe("23514");
      expect((await err(c, "select staging.add_source_page($1, 'https://example.test/y', 'restaurant_site', 'X', now() + interval '2 days')", [w.curator])).message).toBe("STAGING_FUTURE_DATE");
    });
  });

  it("a vegan yes or a published nutrition figure must come from the restaurant's own page", async () => {
    await tx(async (c) => {
      const w = await world(c);
      expect((await err(c, "select staging.submit_fact($1, $2::jsonb)", [w.curator, JSON.stringify({ placeId: w.place, dishId: w.dish, sourcePageId: w.news, checkedOn: w.today, ...vegan("yes") })])).message).toBe("STAGING_NEEDS_RESTAURANT_SOURCE");
      expect((await err(c, "select staging.submit_fact($1, $2::jsonb)", [w.curator, JSON.stringify({ placeId: w.place, dishId: w.dish, sourcePageId: w.news, checkedOn: w.today, kind: "published_nutrition", value: { nutrient: "protein_g", amount: "21", per: "serving" } })])).message).toBe("STAGING_NEEDS_RESTAURANT_SOURCE");
      const ok = await w.submit(w.curator, { dishId: w.dish, kind: "published_nutrition", value: { nutrient: "protein_g", amount: "21", per: "serving" } });
      const row = (await c.query("select f.subject, f.value, f.checked_on::text, s.url, s.page_kind from staging.facts f join staging.source_pages s on s.id = f.source_page_id where f.id = $1", [ok])).rows[0];
      expect(row).toEqual({ subject: "protein_g", value: { nutrient: "protein_g", amount: "21", per: "serving" }, checked_on: w.today, url: "https://example.test/menu", page_kind: "restaurant_site" });
    });
  });

  it("values must have the right shape; dish facts need a dish of the same place; unknown needs a reason", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const bad = async (p: J) => (await err(c, "select staging.submit_fact($1, $2::jsonb)", [w.curator, JSON.stringify({ placeId: w.place, sourcePageId: w.own, checkedOn: w.today, ...p })])).code;
      expect(await bad({ dishId: w.dish, kind: "dietary_status", value: { claim: "vegan", status: "probably" } })).toBe("23514");
      expect(await bad({ dishId: w.dish, kind: "published_nutrition", value: { nutrient: "protein_g", amount: "-3", per: "serving" } })).toBe("23514");
      expect(await bad({ dishId: w.dish, kind: "price", value: { usd: "free" } })).toBe("23514");
      expect(await bad({ dishId: w.dish, kind: "serving_size", value: { grams: "0" } })).toBe("23514");
      expect(await bad({ kind: "dietary_status", value: { claim: "vegan", status: "yes" } })).toBe("23514"); // no dish
      expect(await bad({ dishId: w.dish, kind: "address", value: { street: "1 Test St", postcode: "02139" } })).toBe("23514"); // place fact on a dish
      expect(await bad({ dishId: w.dish, kind: "dietary_status", subject: "vegan" })).toBe("23514"); // unknown without reason
      const other = await one(c, "staging.add_place($1, 'Test Place Two', 'harvard_square', 2::smallint)", [w.curator]);
      const e = await err(c, "select staging.submit_fact($1, $2::jsonb)", [w.curator, JSON.stringify({ placeId: other, dishId: w.dish, sourcePageId: w.own, checkedOn: w.today, ...vegan("no") })]);
      expect(e.code).toBe("23503");
    });
  });
});

describe("S3 history is permanent; corrections replace, never overwrite", () => {
  it("no edit, delete or truncate of facts, places, dishes, pages or history, even by the database owner", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const f = await w.submit(w.curator, { kind: "operating_status", value: { status: "operating" } });
      for (const sql of [
        "update staging.facts set value = '{\"status\":\"closed\"}' where id = $1",
        "delete from staging.facts where id = $1",
      ]) expect((await err(c, sql, [f])).message).toMatch(/permanent/);
      expect((await err(c, "update staging.places set label = 'Renamed' where id = $1", [w.place])).message).toMatch(/permanent/);
      expect((await err(c, "delete from staging.places where id = $1", [w.place])).message).toMatch(/permanent/);
      expect((await err(c, "update staging.dishes set label = 'Renamed' where id = $1", [w.dish])).message).toMatch(/permanent/);
      expect((await err(c, "update staging.source_pages set url = 'https://other.test' where id = $1", [w.own])).message).toMatch(/permanent/);
      expect((await err(c, "delete from staging.events")).message).toMatch(/permanent/);
      for (const t of ["facts", "places", "dishes", "source_pages", "events"]) {
        expect((await err(c, `truncate staging.${t} cascade`)).message, t).toMatch(/permanent/);
      }
    });
  });

  it("a correction is a new fact; once checked it replaces the old one, which stays in the record", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const old = await w.submit(w.curator, { kind: "operating_status", value: { status: "operating" } });
      await w.review(w.publisher, old);
      // Only a verified fact of the same kind and place can be replaced.
      const other = await w.submit(w.curator, { kind: "address", value: { street: "1 Test St", postcode: "02139" } });
      expect((await err(c, "select staging.submit_fact($1, $2::jsonb)", [w.curator, JSON.stringify({ placeId: w.place, sourcePageId: w.own, checkedOn: w.today, kind: "operating_status", value: { status: "closed" }, replacesFactId: other })])).message).toBe("STAGING_BAD_REPLACEMENT");
      const next = await w.submit(w.curator, { kind: "operating_status", value: { status: "temporarily_closed" }, replacesFactId: old });
      expect((await c.query("select status from staging.facts where id = $1", [old])).rows[0].status).toBe("verified"); // unchanged until checked
      await w.review(w.publisher, next);
      const rows = (await c.query("select id, status, value from staging.facts where id = any($1::uuid[]) order by entered_at", [[old, next]])).rows;
      expect(rows.map((r) => r.status).sort()).toEqual(["replaced", "verified"]);
      expect(rows.find((r) => r.id === old).value).toEqual({ status: "operating" });
      const events = (await c.query("select action from staging.events where place_id = $1 order by id", [w.place])).rows.map((r) => r.action);
      expect(events).toEqual(["add_place", "add_dish", "submit_fact", "verify_fact", "submit_fact", "submit_fact", "verify_fact", "replace_fact"]);
    });
  });
});

describe("S4 unknown stays unknown and never passes a strict filter", () => {
  it("only a current, checked 'yes' passes; unchecked, unknown, 'no' and nothing at all do not", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const status = () => one(c, "staging.dish_dietary_status($1, 'vegan')", [w.dish]);
      const passes = () => one(c, "staging.passes_strict_filter($1, 'vegan')", [w.dish]);
      expect([await status(), await passes()]).toEqual(["unknown", false]); // no facts
      const unchecked = await w.submit(w.curator, { dishId: w.dish, ...vegan("yes") });
      expect([await status(), await passes()]).toEqual(["unknown", false]); // entered, not yet checked
      await w.review(w.publisher, unchecked, "reject");
      expect([await status(), await passes()]).toEqual(["unknown", false]); // rejected
      const unk = await w.submit(w.curator, { dishId: w.dish, kind: "dietary_status", subject: "vegan", unknownReason: "Menu does not say whether the sauce has honey" });
      await w.review(w.publisher, unk);
      expect([await status(), await passes()]).toEqual(["unknown", false]); // checked, still unknown
      const no = await w.submit(w.curator, { dishId: w.dish, ...vegan("no") });
      await w.review(w.publisher, no);
      expect([await status(), await passes()]).toEqual(["no", false]);
      expect(await one(c, "staging.passes_strict_filter($1, 'egg_free')", [w.dish])).toBe(false); // other claims untouched
      const yes = await w.submit(w.curator, { dishId: w.dish, ...vegan("yes"), replacesFactId: no });
      await w.review(w.publisher, yes);
      expect([await status(), await passes()]).toEqual(["yes", true]);
      // Replaced by a checked "unknown": back to unknown.
      const back = await w.submit(w.curator, { dishId: w.dish, kind: "dietary_status", subject: "vegan", unknownReason: "Recipe changed; not yet re-checked", replacesFactId: yes });
      await w.review(w.publisher, back);
      expect([await status(), await passes()]).toEqual(["unknown", false]);
    });
  });
});

describe("S5 staged real records are completely separate from public and demo records", () => {
  it("public search, map, filters, place counts and the demo label are identical before and after staging", async () => {
    await tx(async (c) => {
      const snapshot = async () => {
        const r: J = {};
        r.search = await one(c, "public.search_catalog($1::jsonb)", [JSON.stringify({ includeDemo: true, limit: 50 })]);
        r.searchReal = await one(c, "public.search_catalog($1::jsonb)", [JSON.stringify({ limit: 50 })]);
        r.map = await one(c, "public.search_map($1::jsonb)", [JSON.stringify({ includeDemo: true })]);
        r.filters = await one(c, "public.catalog_filter_options('boston', true)");
        r.counts = (await c.query(`select (select count(*) from public.venues)::int v, (select count(*) from public.venues where not is_demo)::int vr,
            (select count(*) from public.food_items)::int f, (select count(*) from public.food_items where kind <> 'custom' and not is_demo)::int fr,
            (select count(*) from public.sources)::int s, (select count(*) from public.source_records)::int sr`)).rows[0];
        return JSON.stringify(r);
      };
      const before = await snapshot();
      const w = await world(c);
      const f = await w.submit(w.curator, { dishId: w.dish, ...vegan("yes") });
      await w.review(w.publisher, f);
      await w.submit(w.curator, { kind: "address", value: { street: "1 Test St", postcode: "02139" } });
      expect(await snapshot()).toBe(before);
      expect(JSON.parse(before).counts).toMatchObject({ vr: 0, fr: 0 }); // the public catalog is still demo-only
      // A demo record can never be staged.
      expect((await err(c, "insert into staging.places (label, area, shortlist_priority, is_demo, created_by) values ('Demo', 'central_square', 1, true, $1)", [w.curator])).code).toBe("23514");
      expect((await err(c, "insert into staging.source_pages (url, page_kind, publisher, retrieved_at, is_demo, created_by) values ('https://demo.test', 'news', 'Demo', now(), true, $1)", [w.curator])).code).toBe("23514");
    });
  });

  it("no public or app function reads the staging area, except one guard and the founder-only menu review", async () => {
    const { rows } = await pool.query(
      `select n.nspname || '.' || p.proname as fn,
              array(select distinct m[1] from regexp_matches(pg_get_functiondef(p.oid), '(staging\\.[a-z_]+)', 'g') m) as refs
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'app') and p.prokind = 'f' and pg_get_functiondef(p.oid) ~* 'staging\\.'`);
    // Pilot publication (docs/29): the editor's review calls one guard before approving, which can
    // only refuse (lock, changed fact, place not yet public) or mark that change's records as
    // rights-checked. It returns nothing, so no staged value reaches any public answer.
    //
    // Founder menu review (docs/58): four functions read staging for the founder's own review screen.
    // Each one refuses everyone but the founder before reading anything (checked below), so no staged
    // value reaches a visitor or a member; the founder's screen is never public.
    //
    // Founder-only private beta (docs/59): three more, for the founder's preview of linked places and
    // the founder's own saved meals. They too refuse everyone but the founder before reading anything.
    //
    // Real meals in lists and private reviews (docs/60): six more founder-only functions, plus one app-schema
    // helper (app.preview_meal_ok) that no visitor or member can call; it only answers whether a dish may be
    // listed or reviewed and returns no menu fact.
    //
    // Logging a real meal with its source (docs/63): public.log_real_meal is founder-only too, and its
    // helper app.real_meal_figure (which reads the restaurant's drafted figure) is callable by no visitor or member.
    const founderOnly = [
      "public.log_real_meal",
      "public.menu_preview_index",
      "public.menu_preview_list_entries",
      "public.menu_preview_list_set",
      "public.menu_preview_meal_lists",
      "public.menu_preview_plan",
      "public.menu_preview_plans",
      "public.menu_preview_review_delete",
      "public.menu_preview_review_set",
      "public.menu_preview_reviews",
      "public.menu_preview_save",
      "public.menu_preview_saved",
      "public.menu_preview_unplan",
      "public.menu_preview_waiting",
      "public.menu_review_correct",
      "public.menu_review_decide",
      "public.menu_review_place",
      "public.menu_review_places",
      // Tester meal review (owner direction 23 Nov 2026 19:34 UTC item 3, migration 20261123000200): the founder's
      // queue and include/leave-out decision. tests/db/tester-meals.test.ts proves the boundaries.
      "public.tester_meal_decide",
      "public.tester_meal_queue",
      // Dietary confirmation records (owner decision 24 Nov 2026 21:20 UTC, decision 2; migration 20261124000900): the
      // founder records, lists and withdraws documented answers. tests/db/diet-confirmations.test.ts proves the boundaries.
      "public.diet_confirmation_record",
      "public.diet_confirmation_withdraw",
      "public.diet_confirmations",
      // Founder review queue (owner directive 25 Nov 2026 04:01 UTC, migration 20261125000100): meal-level notes.
      "public.meal_review_note_add",
      "public.meal_review_notes",
      // Member preview (owner direction 25 Nov 2026 17:10 UTC, migration 20261125000400): the founder's read-only view
      // of one meal as a member would see it. tests/db/tester-meals.test.ts proves it refuses members and writes nothing.
      "public.member_preview_meal",
      // Side-by-side review (owner directive 27 Nov 2026, migration 20261127000200): page hashes only, never a page body.
      // tests/db/founder-dish-pages.test.ts proves it refuses visitors, members and curators.
      "public.founder_dish_pages",
    ];
    //
    // Staged local member beta (owner decision 22 Nov 2026 15:26 UTC, migration 20261122000600): two functions a
    // signed-in member may call, refusing everything (BETA_OFF / NOT_FOUND) unless the beta switch is on and the place
    // is enrolled, and returning only facts staging.member_fact_ok allows; app.place_visible lets an enrolled place's
    // preview listing be read under the same conditions. tests/db/member-beta.test.ts proves the boundaries.
    // public.place_directory (20261124000800) reads the same enrolment tables only to skip, before app.place_visible,
    // rows that rule would refuse; it returns listing fields only (results identical, docs/87 section 4).
    const memberBeta = ["app.place_visible", "public.member_beta_index", "public.member_beta_place", "public.place_directory"];
    //
    // Community suggestions (owner directive 24 Nov 2026 14:59 UTC, migration 20261124000300): community_submit checks
    // that a suggested dish is on the suggested place's menu and stores only ids; community_queue is founder-only and
    // shows the dish name. tests/db/community-evidence.test.ts proves the boundaries.
    // v2 (20261125000200): app.community_dish_now reads one dish's drafted diet claims, price and whether ingredients
    // are listed, only from community_queue (founder-only); it is not callable by any client role.
    const community = ["app.community_dish_now", "public.community_queue", "public.community_submit"];
    // "Download my data" (owner decision 5, 26 Nov 2026; 20261126000300): export_my_data starts with the sign-in check
    // and reads only the caller's own preview saves, reviews, list entries and plans, with each meal's label.
    // tests/db/export-complete.test.ts proves it returns nothing of anyone else's.
    const ownData = ["public.export_my_data"];
    const sorted = [...rows].sort((a, b) => a.fn.localeCompare(b.fn));
    const cmp = (a: string, b: string) => a.localeCompare(b);
    expect(sorted.map((r) => r.fn)).toEqual(["app.diet_confirmation_json", "app.preview_meal_ok", "app.real_meal_figure", "public.editor_review_change", "public.menu_review_fact_json", ...founderOnly, ...memberBeta, ...community, ...ownData].sort(cmp));
    expect(sorted.find((r) => r.fn === "public.editor_review_change")!.refs).toEqual(["staging.guard_pilot_review"]);
    // The five save and plan functions were reopened to beta members (20261122000600): they start with the sign-in
    // check and refuse anyone who is not the founder unless the dish or the beta passes the member rules; each
    // reads and writes only the caller's own rows (tests/db/member-beta.test.ts).
    // Logging, lists and reviews followed (20261123000100, owner directive 23 Nov 2026 02:04 UTC section 6), under the
    // same rules (tests/db/member-beta-journeys.test.ts).
    const memberOrFounder = [
      "public.menu_preview_plan", "public.menu_preview_plans", "public.menu_preview_save", "public.menu_preview_saved", "public.menu_preview_unplan",
      "public.menu_preview_list_entries", "public.menu_preview_list_set", "public.menu_preview_meal_lists",
      "public.menu_preview_review_delete", "public.menu_preview_review_set", "public.menu_preview_reviews",
    ];
    // log_real_meal: the sign-in check, then the founder-or-member-dish guard before anything is read or replayed.
    {
      const def = (await pool.query("select pg_get_functiondef('public.log_real_meal'::regproc) d")).rows[0].d as string;
      const body = def.slice(def.indexOf("begin"));
      expect(body.split("\n").find((l) => l.trim() !== "" && l.trim() !== "begin")?.trim()).toBe("if v_owner is null then");
      const guard = body.indexOf("if not app.has_role('publisher') and not staging.member_dish_ok(p_dish) then");
      expect(guard).toBeGreaterThan(0);
      expect(guard).toBeLessThan(body.indexOf("public.idempotency_records"));
      expect(body.slice(guard, guard + 200)).toMatch(/FOUNDER_ONLY/);
    }
    for (const fn of memberOrFounder) {
      const def = (await pool.query("select pg_get_functiondef($1::regproc) d", [fn])).rows[0].d as string;
      const body = def.slice(def.indexOf("begin"));
      expect(body.split("\n").find((l) => l.trim() !== "" && l.trim() !== "begin")?.trim(), fn).toBe("if auth.uid() is null then raise exception 'NOT_SIGNED_IN' using errcode = 'PT401'; end if;");
      expect(body, fn).toMatch(/FOUNDER_ONLY/);
    }
    for (const fn of founderOnly.filter((f) => !memberOrFounder.includes(f) && f !== "public.log_real_meal")) {
      const def = (await pool.query("select pg_get_functiondef($1::regproc) d", [fn])).rows[0].d as string;
      const body = def.slice(def.indexOf("begin"));
      expect(body.split("\n").find((l) => l.trim() !== "" && l.trim() !== "begin")?.trim(), fn).toBe("perform app.require_founder();");
    }
    // The shape helper is not callable by visitors or members at all.
    for (const role of ["anon", "authenticated"]) {
      expect((await pool.query("select has_function_privilege($1, 'public.menu_review_fact_json(staging.facts, uuid)', 'execute') ok", [role])).rows[0].ok).toBe(false);
      expect((await pool.query("select has_function_privilege($1, 'app.preview_meal_ok(uuid)', 'execute') ok", [role])).rows[0].ok).toBe(false);
      expect((await pool.query("select has_function_privilege($1, 'app.real_meal_figure(uuid, text)', 'execute') ok", [role])).rows[0].ok).toBe(false);
      expect((await pool.query("select has_function_privilege($1, 'app.diet_confirmation_json(staging.diet_confirmations)', 'execute') ok", [role])).rows[0].ok).toBe(false);
    }
  });
});

describe("S6 closed to visitors and members", () => {
  it("guests and members cannot see the schema, read any table or call any function", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const fns = (await c.query(`select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'staging'`)).rows.map((r) => r.sig as string);
      expect(fns.length).toBeGreaterThan(10);
      for (const role of ["anon", "authenticated"]) {
        expect(await one(c, "has_schema_privilege($1, 'staging', 'usage')", [role])).toBe(false);
        for (const sig of fns) expect(await one(c, "has_function_privilege($1, $2, 'execute')", [role, sig]), `${role} ${sig}`).toBe(false);
        for (const t of ["places", "dishes", "source_pages", "facts", "events"]) {
          expect(await one(c, "has_table_privilege($1, $2, 'select,insert,update,delete')", [role, `staging.${t}`]), `${role} ${t}`).toBe(false);
        }
        await c.query(`set local role ${role}`);
        await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: w.publisher, role })]);
        for (const sql of [
          "select count(*) from staging.facts",
          "select count(*) from staging.places",
          "select staging.pilot_overview()",
          `select staging.review_fact('${w.publisher}', gen_random_uuid(), 'verify')`,
        ]) expect((await err(c, sql)).code, `${role}: ${sql}`).toBe("42501");
        await c.query("reset role");
      }
    });
  });

  it("the staging schema is not exposed through the Data API, and every staging table forces row security", async () => {
    const { rows } = await pool.query("select coalesce(current_setting('pgrst.db_schemas', true), '') as schemas");
    expect(rows[0].schemas).not.toMatch(/\bstaging\b/);
    const t = await pool.query(`select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'staging' and c.relkind = 'r' order by 1`);
    expect(t.rows.map((r) => r.relname)).toEqual(["catalog_links", "diet_confirmations", "dish_estimates", "dish_options", "dish_structure", "dishes", "events", "fact_confirmations", "fact_machine_checks", "facts", "meal_review_notes", "member_beta_places", "member_beta_switch", "places", "preview_list_entries", "preview_meal_plans", "preview_reviews", "preview_saves", "publication_changes", "publications", "removals", "source_access", "source_pages", "tester_meal_decisions"]);
    expect(t.rows.every((r) => r.relrowsecurity && r.relforcerowsecurity)).toBe(true);
  });

  it("the owner's overview counts facts by status for each place", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const a = await w.submit(w.curator, { kind: "operating_status", value: { status: "operating" } });
      await w.review(w.publisher, a);
      await w.submit(w.curator, { dishId: w.dish, kind: "dietary_status", subject: "egg_free", unknownReason: "Not stated on the menu" });
      const o = (await c.query("select * from staging.pilot_overview() where place_id = $1", [w.place])).rows[0];
      expect(o).toMatchObject({ label: "Test Place One", area: "central_square", pilot_status: "shortlist", facts_submitted: "1", facts_verified: "1", facts_unknown: "1", dishes: "1" });
      await c.query("select staging.set_place_status($1, $2, 'verifying')", [w.publisher, w.place]);
      expect((await err(c, "select staging.set_place_status($1, $2, 'verifying')", [w.curator, w.place])).message).toBe("STAGING_ROLE_REQUIRED");
    });
  });
});
