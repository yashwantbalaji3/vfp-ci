import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { clearTestHosts, pool } from "../helpers/db";

// Community evidence (owner directive 24 Nov 2026 14:59 UTC, 2B; migration 20261124000300). Each test runs inside ONE
// rolled-back transaction. A suggestion is a lead: it must never change a fact, a dish, a listing or a publication state.

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
async function user(c: PoolClient, role?: string) {
  const id = randomUUID();
  await c.query(
    `insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}', '{}', now(), now())`,
    [id, `ce-${id.slice(0, 8)}@example.test`],
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
const SUBMIT = "select public.community_submit($1, $2, $3, $4::jsonb, $5) r";
const T = "community-evidence-v1";
const open = (c: PoolClient, on: boolean) => c.query("update app.platform_switches set enabled = $1 where name = 'community_submissions'", [on]);
async function listing(c: PoolClient) {
  // Always its own candidate and listing, for this transaction only, so the test behaves the same on an empty
  // database (CI) and on one loaded with real data.
  const run = (await c.query("insert into catalog_import.import_runs (source_key, release, file_sha256, retrieved_at, thresholds, status) values ('overture_places', 'test', $1, now(), '{}', 'completed') returning id", ["0".repeat(64)])).rows[0].id;
  const cand = (await c.query("insert into catalog_import.place_candidates (name, street, postcode, lat, lon, category, quality, created_run) values ('Test Kitchen', '1 Test St', '02139', 42.37, -71.11, 'restaurant', 'corroborated', $1) returning id", [run])).rows[0].id as string;
  return (
    await c.query(
      `insert into public.place_listings (candidate_id, slug, name, street, locality, postcode, area, lat, lon, category, identity_status, sources, built_from)
       values ($1, 'test-kitchen-ce', 'Test Kitchen', '1 Test St', 'Cambridge', '02139', 'Central Square', 42.37, -71.11, 'Restaurant', 'corroborated', '[{"key":"overture_places","title":"Test"}]', 'test') returning id`,
      [cand],
    )
  ).rows[0].id as string;
}
const dish = { dish: "Tofu banh mi", diet: "vegan", quote: "Vegan", source: "printed_menu", seenOn: "2026-11-20" };

afterAll(async () => {
  await pool.end();
});

describe("community evidence", () => {
  it("is closed to members while the switch is off, but open to the founder for testing; never to visitors", () =>
    tx(async (c) => {
      await open(c, false);
      const m = await user(c);
      const f = await user(c, "publisher");
      const l = await listing(c);
      expect(await asErr(c, m, SUBMIT, ["missing_dish", l, null, JSON.stringify(dish), T])).toContain("NOT_OPEN");
      expect(await asErr(c, null, SUBMIT, ["missing_dish", l, null, JSON.stringify(dish), T])).toMatch(/permission denied|NOT_SIGNED_IN/);
      const r = (await as(c, f, SUBMIT, ["missing_dish", l, null, JSON.stringify(dish), T]))[0].r as J;
      expect(r.status).toBe("submitted");
      expect(r.contributor).toMatch(/^[0-9a-f]{6}$/);
    }));

  it("validates each kind, needs agreement and a place, refuses photos, and limits 10 a day", () =>
    tx(async (c) => {
      await open(c, true);
      const m = await user(c);
      const l = await listing(c);
      expect(await asErr(c, m, SUBMIT, ["missing_dish", l, null, JSON.stringify(dish), "nope"])).toContain("TERMS_NOT_AGREED");
      expect(await asErr(c, m, SUBMIT, ["missing_dish", null, null, JSON.stringify(dish), T])).toContain("PLACE_NEEDED");
      expect(await asErr(c, m, SUBMIT, ["menu_photo", l, null, "{}", T])).toContain("PHOTOS_NOT_YET");
      expect(await asErr(c, m, SUBMIT, ["missing_dish", l, null, JSON.stringify({ dish: "x" }), T])).toContain("INVALID_SUGGESTION");
      expect(await asErr(c, m, SUBMIT, ["diet_info", l, null, JSON.stringify({ diet: "vegan", source: "printed_menu" }), T])).toContain("INVALID_SUGGESTION");
      expect(await asErr(c, m, SUBMIT, ["nutrition_source", l, null, JSON.stringify({ url: "javascript:alert(1)" }), T])).toContain("INVALID_SUGGESTION");
      expect(await asErr(c, m, SUBMIT, ["price", l, null, JSON.stringify({ price: "12.5", source: "printed_menu" }), T])).toContain("INVALID_SUGGESTION");
      expect(await asErr(c, m, SUBMIT, ["missing_dish", l, null, JSON.stringify({ ...dish, extra: "x" }), T])).toContain("INVALID_SUGGESTION");
      await as(c, m, SUBMIT, ["missing_restaurant", null, null, JSON.stringify({ name: "Veggie Corner", website: "https://example.org" }), T]);
      await as(c, m, SUBMIT, ["diet_info", l, null, JSON.stringify({ diet: "egg_free", quote: "No egg in our noodles", source: "asked_staff" }), T]);
      await as(c, m, SUBMIT, ["price", l, null, JSON.stringify({ price: "12.50", source: "printed_menu" }), T]);
      for (let i = 0; i < 7; i++) await as(c, m, SUBMIT, ["missing_dish", l, null, JSON.stringify({ ...dish, dish: `Dish ${i}` }), T]);
      expect(await asErr(c, m, SUBMIT, ["missing_dish", l, null, JSON.stringify(dish), T])).toContain("TOO_MANY");
    }));

  it("lets a member read and withdraw only their own; the queue and reviews are founder-only", () =>
    tx(async (c) => {
      await open(c, true);
      const a = await user(c);
      const b = await user(c);
      const f = await user(c, "publisher");
      const l = await listing(c);
      const id = ((await as(c, a, SUBMIT, ["missing_dish", l, null, JSON.stringify(dish), T]))[0].r as J).id as string;
      expect((await as(c, a, "select id from public.community_submissions")).map((r) => r.id)).toEqual([id]);
      expect(await as(c, b, "select id from public.community_submissions")).toEqual([]);
      expect(await asErr(c, null, "select 1 from public.community_submissions")).toMatch(/permission denied/);
      // No direct writes, even to one's own row.
      expect(await asErr(c, a, "update public.community_submissions set status = 'useful_lead' where id = $1", [id])).toMatch(/permission denied/);
      expect(await asErr(c, a, "insert into public.community_submissions (user_id, kind, listing_id, details, agreed_terms) values (auth.uid(), 'price', $1, '{\"price\":\"1.00\",\"source\":\"other\"}', $2)", [l, T])).toMatch(/permission denied/);
      expect(await asErr(c, b, "select public.community_withdraw($1)", [id])).toContain("NOT_FOUND");
      expect(await asErr(c, a, "select public.community_queue()")).toContain("FOUNDER_ONLY");
      expect(await asErr(c, a, "select public.community_review($1, 'useful_lead', '')", [id])).toContain("FOUNDER_ONLY");
      const q = (await as(c, f, "select public.community_queue() r"))[0].r as J[];
      const item = q.find((x) => x.id === id)!;
      expect(item.contributor).toMatch(/^[0-9a-f]{6}$/);
      expect(JSON.stringify(item)).not.toContain("@example.test");
      expect(item.listing.id).toBe(l);
      await as(c, a, "select public.community_withdraw($1)", [id]);
      expect(((await as(c, f, "select public.community_queue() r"))[0].r as J[]).some((x) => x.id === id)).toBe(false);
    }));

  it("a founder review records the outcome and changes no fact, dish, listing or publication state", () =>
    tx(async (c) => {
      await open(c, true);
      const m = await user(c);
      const f = await user(c, "publisher");
      const l = await listing(c);
      const id = ((await as(c, m, SUBMIT, ["diet_info", l, null, JSON.stringify({ diet: "vegan", quote: "Vegan", source: "printed_menu" }), T]))[0].r as J).id;
      const snap = async () =>
        (
          await c.query(`select (select count(*) from staging.facts) facts, (select count(*) from staging.facts where status = 'verified') verified,
                                (select count(*) from staging.dishes) dishes, (select md5(string_agg(l::text, ',' order by l.id)) from public.place_listings l) listings,
                                (select count(*) from public.place_listings where visibility = 'public') public_listings`)
        ).rows[0];
      const before = await snap();
      await as(c, f, "select public.community_review($1, 'useful_lead', 'Will check the menu')", [id]);
      expect(await snap()).toEqual(before);
      const mine = await as(c, m, "select status, review_note from public.community_submissions where id = $1", [id]);
      expect(mine).toEqual([{ status: "useful_lead", review_note: "Will check the menu" }]);
      expect(await asErr(c, f, "select public.community_review($1, 'verified', '')", [id])).toContain("INVALID_STATUS");
    }));

  it("is removed with the contributor's account", () =>
    tx(async (c) => {
      await open(c, true);
      const m = await user(c);
      const l = await listing(c);
      await as(c, m, SUBMIT, ["missing_dish", l, null, JSON.stringify(dish), T]);
      await c.query("delete from auth.users where id = $1", [m]);
      expect((await c.query("select count(*)::int n from public.community_submissions where user_id = $1", [m])).rows[0].n).toBe(0);
    }));
});

describe("community evidence: duplicates (migration 20261124000600)", () => {
  it("refuses the same open suggestion twice from one person, counts the same suggestion from others, and shows a missing restaurant already listed", () =>
    tx(async (c) => {
      await open(c, true);
      const a = await user(c);
      const b = await user(c);
      const f = await user(c, "publisher");
      const l = await listing(c);
      await as(c, a, SUBMIT, ["missing_dish", l, null, JSON.stringify(dish), T]);
      expect(await asErr(c, a, SUBMIT, ["missing_dish", l, null, JSON.stringify(dish), T])).toContain("ALREADY_SENT");
      // The same missing dish under different words is still the same dish for one person.
      expect(await asErr(c, a, SUBMIT, ["missing_dish", l, null, JSON.stringify({ ...dish, dish: "TOFU Bánh mì", quote: "Vegan!" }), T])).toContain("ALREADY_SENT");
      // Another person may send it: the queue shows it as the same suggestion from one other person.
      await as(c, b, SUBMIT, ["missing_dish", l, null, JSON.stringify({ ...dish, source: "asked_staff" }), T]);
      // A missing restaurant whose name is already a listing.
      const name = (await c.query("select name from public.place_listings where id = $1", [l])).rows[0].name as string;
      await as(c, b, SUBMIT, ["missing_restaurant", null, null, JSON.stringify({ name: name.toUpperCase() }), T]);
      const q = ((await as(c, f, "select public.community_queue() q"))[0].q as J[]);
      const dishes = q.filter((x) => x.kind === "missing_dish");
      expect(dishes.map((x) => x.duplicates)).toEqual([1, 1]);
      const missing = q.find((x) => x.kind === "missing_restaurant")!;
      expect(missing.alreadyListed.map((x: J) => x.name)).toContain(name);
      // Once withdrawn, the person may send it again.
      const mine = (await as(c, a, "select id from public.community_submissions where kind = 'missing_dish'"))[0].id as string;
      await as(c, a, "select public.community_withdraw($1)", [mine]);
      await as(c, a, SUBMIT, ["missing_dish", l, null, JSON.stringify(dish), T]);
    }));
});

// v2 (owner directive 25 Nov 2026 04:01 UTC, 3.2; migration 20261125000200): three more kinds, an append-only review
// history, conflict checks against the drafted facts, and publication eligibility that is always false.
async function linkedDish(c: PoolClient, me: string, l: string, facts: { kind: string; subject?: string; value: J }[]) {
  await clearTestHosts(c);
  const one = async (sql: string, params: unknown[]) => (await c.query(`select ${sql} as r`, params)).rows[0].r as string;
  const place = await one("staging.add_place($1, $2, 'back_bay', 2::smallint)", [me, `CE v2 ${randomUUID().slice(0, 6)}`]);
  const site = await one("staging.add_source_page($1, $2, 'restaurant_site', 'CE Test Kitchen', now(), 'Facts only')", [me, `https://example.test/${randomUUID()}`]);
  const today = (await c.query("select (now() at time zone 'America/New_York')::date::text as d")).rows[0].d as string;
  const d = await one("staging.add_dish($1, $2, 'Tofu banh mi')", [me, place]);
  for (const f of facts) await one("staging.submit_fact($1, $2::jsonb)", [me, JSON.stringify({ placeId: place, sourcePageId: site, checkedOn: today, dishId: d, ...f })]);
  const cand = (await c.query("select candidate_id from public.place_listings where id = $1", [l])).rows[0].candidate_id;
  await c.query("insert into staging.catalog_links (staging_place, candidate_id, action, method, note, actor_id) values ($1, $2, 'link', 'person', 'Linked for this test', $3)", [place, cand, me]);
  return d;
}

describe("community evidence v2 (migration 20261125000200)", () => {
  it("accepts branch corrections, duplicate restaurants and stale menus, each with what it needs", () =>
    tx(async (c) => {
      await open(c, true);
      const m = await user(c);
      const l = await listing(c);
      for (const [kind, d] of [
        ["branch_correction", { field: "closed", right: "Closed since October, sign on the door", source: "other", note: "Walked past" }],
        ["duplicate_restaurant", { right: "Test Kitchen on 1 Test Street, listed twice" }],
        ["stale_menu", { note: "The lunch menu changed in November", source: "printed_menu", seenOn: "2026-11-20" }],
      ] as const)
        expect(((await as(c, m, SUBMIT, [kind, l, null, JSON.stringify(d), T]))[0].r as J).status).toBe("submitted");
      expect(await asErr(c, m, SUBMIT, ["branch_correction", l, null, JSON.stringify({ field: "colour", right: "Blue", source: "other" }), T])).toContain("INVALID_SUGGESTION");
      expect(await asErr(c, m, SUBMIT, ["stale_menu", l, null, JSON.stringify({ note: "Changed" }), T])).toContain("INVALID_SUGGESTION");
      expect(await asErr(c, m, SUBMIT, ["duplicate_restaurant", null, null, JSON.stringify({ right: "Somewhere else" }), T])).toContain("PLACE_NEEDED");
    }));

  it("keeps every status change in an append-only history that only the founder reads", () =>
    tx(async (c) => {
      await open(c, true);
      const m = await user(c);
      const f = await user(c, "publisher");
      const l = await listing(c);
      const id = ((await as(c, m, SUBMIT, ["stale_menu", l, null, JSON.stringify({ note: "New menu since November", source: "printed_menu" }), T]))[0].r as J).id;
      await as(c, f, "select public.community_review($1, 'needs_more', 'Which dishes changed?')", [id]);
      await as(c, f, "select public.community_review($1, 'useful_lead', 'Re-check the site')", [id]);
      const item = ((await as(c, f, "select public.community_queue() q"))[0].q as J[]).find((x) => x.id === id)!;
      expect(item.history.map((e: J) => [e.from, e.to, e.by])).toEqual([[null, "submitted", "contributor"], ["submitted", "needs_more", "founder"], ["needs_more", "useful_lead", "founder"]]);
      expect(item.history[1].note).toBe("Which dishes changed?");
      expect(item.reviewNote).toBe("Re-check the site");
      expect(item.publicationEligible).toBe(false);
      expect(await asErr(c, m, "select * from public.community_review_events")).toMatch(/permission denied/);
      expect(await asErr(c, f, "select * from public.community_review_events")).toMatch(/permission denied/);
      await c.query("savepoint e");
      await expect(c.query("update public.community_review_events set note = 'changed' where submission_id = $1", [id])).rejects.toThrow(/RECORD_IMMUTABLE/);
      await c.query("rollback to savepoint e");
      await expect(c.query("delete from public.community_review_events where submission_id = $1", [id])).rejects.toThrow(/RECORD_IMMUTABLE/);
      await c.query("rollback to savepoint e");
      // Withdrawing is recorded too, and the contributor's account deletion removes the suggestion and its history.
      const id2 = ((await as(c, m, SUBMIT, ["branch_correction", l, null, JSON.stringify({ field: "address", right: "Moved to 3 Test St", source: "other" }), T]))[0].r as J).id;
      await as(c, m, "select public.community_withdraw($1)", [id2]);
      expect((await c.query("select to_status from public.community_review_events where submission_id = $1 order by id", [id2])).rows.map((r) => r.to_status)).toEqual(["submitted", "withdrawn"]);
      await c.query("delete from auth.users where id = $1", [m]);
      expect((await c.query("select count(*)::int n from public.community_review_events where submission_id = any($1::uuid[])", [[id, id2]])).rows[0].n).toBe(0);
    }));

  it("shows the founder where a suggestion disagrees with the drafted facts, and changes none of them", () =>
    tx(async (c) => {
      await open(c, true);
      const m = await user(c);
      const f = await user(c, "publisher");
      const l = await listing(c);
      const d = await linkedDish(c, await user(c, "curator"), l, [
        { kind: "dietary_status", subject: "vegan", value: { claim: "vegan", status: "no" } },
        { kind: "price", value: { usd: "12.00" } },
      ]);
      const before = (await c.query("select md5(string_agg(f::text, ',' order by f.id)) h from staging.facts f where f.dish_id = $1", [d])).rows[0].h;
      await as(c, m, SUBMIT, ["diet_info", l, d, JSON.stringify({ diet: "vegan", quote: "Server said it is vegan", source: "asked_staff" }), T]);
      await as(c, m, SUBMIT, ["price", l, d, JSON.stringify({ price: "13.50", source: "printed_menu" }), T]);
      await as(c, m, SUBMIT, ["ingredients", l, d, JSON.stringify({ ingredients: "tofu, pickled carrot, bread", source: "printed_menu" }), T]);
      const q = (await as(c, f, "select public.community_queue() q"))[0].q as J[];
      const by = (k: string) => q.find((x) => x.kind === k)!;
      expect(by("diet_info").current).toMatchObject({ diet: { vegan: "no" }, price: "12.00", ingredientsListed: false });
      expect(by("diet_info").conflicts).toEqual(["says_vegan_menu_says_no"]);
      expect(by("price").conflicts).toEqual(["price_differs"]);
      expect(by("ingredients").conflicts).toEqual([]);
      expect(q.every((x) => x.publicationEligible === false)).toBe(true);
      for (const x of q) await as(c, f, "select public.community_review($1, 'useful_lead', 'Check at the source')", [x.id]);
      expect((await c.query("select md5(string_agg(f::text, ',' order by f.id)) h from staging.facts f where f.dish_id = $1", [d])).rows[0].h).toBe(before);
    }));
});
