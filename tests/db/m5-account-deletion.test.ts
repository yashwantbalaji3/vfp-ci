import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { asMember, createTestUser, deleteTestUsers, pgError, pool } from "../helpers/db";
import { IDS, M4 } from "../fixtures/ids";

// M5 step 1: DEF-01 and the account deletion workflow (R-007, docs/12).
// A member with a diary, goals, own foods, cooking, plans, saves, a dietary filter and
// social content deletes their account. Everything they own must go; other members'
// data and the public catalog must not change; only a tombstone and one audit row remain.

const TZ = "America/New_York";
const today = new Date().toISOString().slice(0, 10);
let full: string; // the member who will be deleted
let other: string; // a friend who stays
let third: string; // someone the member blocked
const run = (uid: string | null, sql: string, params: unknown[] = []) => asMember(uid, (c) => c.query(sql, params), { commit: true });

async function ownedRowCounts(uid: string): Promise<Record<string, number>> {
  // Every column anywhere that points at an account, found from the schema itself,
  // so a table added later cannot be forgotten by this test.
  const { rows } = await pool.query(
    `select c.conrelid::regclass::text as tbl, a.attname as col
       from pg_constraint c
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.contype = 'f' and c.confrelid = 'auth.users'::regclass
        and c.connamespace = 'public'::regnamespace`,
  );
  const counts: Record<string, number> = {};
  for (const r of rows) {
    const n = await pool.query(`select count(*)::int as n from ${r.tbl} where ${r.col} = $1`, [uid]);
    counts[`${r.tbl}.${r.col}`] = n.rows[0].n;
  }
  return counts;
}

async function buildFullMember(label: string): Promise<string> {
  const uid = await createTestUser(label);
  const handle = `del_${uid.slice(0, 8)}`;
  await run(uid, "select public.save_my_diet('vegetarian', array['egg'], false)");
  await run(uid, "select public.set_goal('protein_g_per_day', 80, $1)", [today]);
  await run(uid, "select public.log_food_entry($1, $2, $3, 1, null, 'home', 'lunch', $4, $5)", [randomUUID(), IDS.tofu.rev, IDS.tofu.portion150g, today, TZ]);
  // The exact case of DEF-01: an own food with portions and nutrient values.
  await run(uid, "select public.log_new_custom_food($1, $2, null, $3, '1 bar', 40, 1, 'home', 'snack', $4, $5)", [
    randomUUID(), "My protein bar", JSON.stringify({ protein_g: 12, energy_kcal: 180 }), today, TZ,
  ]);
  const started = await run(uid, "select public.start_cook_session($1, $2, 2, '{}', $3, $4, null, true) as r", [randomUUID(), M4.recipe(M4.dal), today, TZ]);
  await run(uid, "select public.complete_cook_session($1, $2, $3)", [started.rows[0].r.sessionId, today, TZ]);
  await run(uid, "select public.plan_recipe($1, $2, 2, 'dinner', true)", [M4.recipe(M4.chana), today]);
  await pool.query("insert into public.saves (owner_id, venue_id) values ($1, $2)", [uid, IDS.venueCentral]);
  await run(uid, "select public.save_my_profile($1, 'Leaving Member', 'About to go', array['spicy'], true, true, true)", [handle]);
  const review = await run(uid, "select public.save_review('venue', $1, 5, 'Great lunch', null, null, true) as r", [IDS.venueCentral]);
  await run(uid, "select public.set_review_audience($1, 'friends')", [review.rows[0].r.reviewId]);
  await run(uid, "select public.save_review('food', $1, 4, null, null, null, true)", [IDS.bowl.item]);
  await run(uid, "select public.set_ranking($1)", [[IDS.venueCentral]]);
  const list = await run(uid, "select public.save_list(null, 'My places', null) as r");
  await run(uid, "select public.add_to_list($1, 'venue', $2, 'go early', true)", [list.rows[0].r.listId, IDS.venueCentral]);
  return uid;
}

beforeAll(async () => {
  other = await createTestUser("del-other");
  third = await createTestUser("del-third");
  await run(other, "select public.save_my_profile($1, 'Staying Friend', null, '{}', true, false, false)", [`stay_${other.slice(0, 8)}`]);
  await run(third, "select public.save_my_profile($1, 'Third', null, '{}', true, false, false)", [`third_${third.slice(0, 8)}`]);
  full = await buildFullMember("del-full");
  const h = (id: string, p: string) => `${p}_${id.slice(0, 8)}`;
  await run(full, "select public.follow_user($1, true)", [h(other, "stay")]);
  await run(other, "select public.follow_user($1, true)", [h(full, "del")]);
  await run(full, "select public.request_friend($1, true)", [h(other, "stay")]);
  await run(other, "select public.respond_friend($1, true)", [h(full, "del")]);
  await run(full, "select public.block_user($1)", [h(third, "third")]);
  // The friend has their own diary entry and review, and reports the member's review.
  await run(other, "select public.log_food_entry($1, $2, $3, 1, null, 'home', 'lunch', $4, $5)", [randomUUID(), IDS.tofu.rev, IDS.tofu.portion150g, today, TZ]);
  await run(other, "select public.save_review('venue', $1, 3, 'Fine', null, null, true)", [IDS.venueCentral]);
  const theirs = await pool.query("select id from public.reviews where author_id = $1 and venue_id is not null", [full]);
  await run(other, "select public.report_content('review', $1, null, 'spam', null, true)", [theirs.rows[0].id]);
});

afterAll(async () => {
  await deleteTestUsers([other, third]);
  await pool.end();
});

describe("delete_my_account checks", () => {
  it("a guest cannot call it", async () => {
    expect((await pgError(run(null, "select public.delete_my_account('DELETE')"))).code).toBe("42501");
  });

  it("it needs the typed word DELETE", async () => {
    await pool.query("update auth.users set last_sign_in_at = now() where id = $1", [full]);
    const e = await pgError(run(full, "select public.delete_my_account('delete please')"));
    expect(e).toMatchObject({ code: "PT422", message: "CONFIRMATION_REQUIRED" });
  });

  it("it needs a sign-in within the last 10 minutes", async () => {
    await pool.query("update auth.users set last_sign_in_at = now() - interval '11 minutes' where id = $1", [full]);
    expect(await pgError(run(full, "select public.delete_my_account('DELETE')"))).toMatchObject({ code: "PT403", message: "REAUTH_REQUIRED" });
    await pool.query("update auth.users set last_sign_in_at = null where id = $1", [full]);
    expect(await pgError(run(full, "select public.delete_my_account('DELETE')"))).toMatchObject({ code: "PT403", message: "REAUTH_REQUIRED" });
  });

  it("the only admin cannot delete themselves", async () => {
    const admins = await pool.query("select count(*)::int as n from public.role_assignments where role = 'admin'");
    expect(admins.rows[0].n).toBe(0);
    const admin = await createTestUser("del-admin");
    await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'admin')", [admin]);
    await pool.query("update auth.users set last_sign_in_at = now() where id = $1", [admin]);
    expect(await pgError(run(admin, "select public.delete_my_account('DELETE')"))).toMatchObject({ code: "PT409", message: "LAST_ADMIN" });
    await deleteTestUsers([admin]);
  });
});

describe("deleting a member who has a diary, goals, own foods, cooking and social content", () => {
  let before: { venues: number; foods: number; otherEntries: number; otherReviews: number };

  it("the member really owns rows in every area first", async () => {
    const counts = await ownedRowCounts(full);
    for (const key of [
      "diary_entries.owner_id", "goal_versions.owner_id", "food_items.owner_id", "sources.owner_id", "cook_sessions.owner_id",
      "meal_plans.owner_id", "saves.owner_id", "user_preferences.user_id", "ingredient_exclusions.owner_id", "profiles_public.user_id",
      "reviews.author_id", "ranking_entries.owner_id", "food_lists.owner_id", "follows.follower_id", "follows.followed_id",
      "friendships.requester_id", "blocks.blocker_id", "member_standing.user_id",
    ]) {
      expect(counts[key], key).toBeGreaterThan(0);
    }
    const own = await pool.query(
      `select (select count(*) from public.portions po join public.food_revisions r on r.id = po.revision_id join public.food_items fi on fi.id = r.food_item_id where fi.owner_id = $1)::int as portions,
              (select count(*) from public.nutrient_values nv join public.food_revisions r on r.id = nv.revision_id join public.food_items fi on fi.id = r.food_item_id where fi.owner_id = $1)::int as nutrient_values`,
      [full],
    );
    expect(own.rows[0].portions).toBeGreaterThan(0);
    expect(own.rows[0].nutrient_values).toBeGreaterThan(0);
    const b = await pool.query(
      `select (select count(*) from public.venues)::int as venues,
              (select count(*) from public.food_items where owner_id is null)::int as foods,
              (select count(*) from public.diary_entries where owner_id = $1)::int as "otherEntries",
              (select count(*) from public.reviews where author_id = $1)::int as "otherReviews"`,
      [other],
    );
    before = b.rows[0];
  });

  it("the deletion succeeds (DEF-01) and removes every row the member owned", async () => {
    await pool.query("update auth.users set last_sign_in_at = now() where id = $1", [full]);
    const r = await run(full, "select public.delete_my_account('DELETE') as r");
    expect(r.rows[0].r).toEqual({ deleted: true });
    expect((await pool.query("select 1 from auth.users where id = $1", [full])).rowCount).toBe(0);
    const counts = await ownedRowCounts(full);
    expect(Object.entries(counts).filter(([, n]) => n > 0)).toEqual([]);
    // Snapshots and revisions have no account column of their own; check them through their parents.
    const orphans = await pool.query(
      `select (select count(*) from public.diary_snapshots s where not exists (select 1 from public.diary_entries e where e.id = s.entry_id))::int as snapshots,
              (select count(*) from public.review_revisions rr where not exists (select 1 from public.reviews r where r.id = rr.review_id))::int as review_revisions,
              (select count(*) from public.food_list_items i where not exists (select 1 from public.food_lists l where l.id = i.list_id))::int as list_items,
              (select count(*) from public.portions po where not exists (select 1 from public.source_records sr where sr.id = po.source_record_id))::int as portions,
              (select count(*) from public.nutrient_values nv where not exists (select 1 from public.source_records sr where sr.id = nv.source_record_id))::int as nutrient_values`,
    );
    expect(orphans.rows[0]).toEqual({ snapshots: 0, review_revisions: 0, list_items: 0, portions: 0, nutrient_values: 0 });
  });

  it("only a one-way tombstone and one audit row without the member's id remain", async () => {
    const ref = createHash("sha256").update(full).digest("hex");
    const t = await pool.query("select completed_at is not null as done, backup_expiry > now() + interval '29 days' as keeps from public.deletion_tombstones where subject_ref = $1", [ref]);
    expect(t.rows).toEqual([{ done: true, keeps: true }]);
    const everywhere = await pool.query("select count(*)::int as n from public.deletion_tombstones where subject_ref = $1", [full]);
    expect(everywhere.rows[0].n).toBe(0);
    const audit = await pool.query("select actor_id, entity_id from public.audit_events where action = 'account.deleted' order by occurred_at desc limit 1");
    expect(audit.rows[0]).toEqual({ actor_id: null, entity_id: null });
    expect((await pool.query("select count(*)::int as n from public.audit_events where actor_id = $1 or entity_id = $1", [full])).rows[0].n).toBe(0);
  });

  it("other members and the public catalog are untouched", async () => {
    const a = await pool.query(
      `select (select count(*) from public.venues)::int as venues,
              (select count(*) from public.food_items where owner_id is null)::int as foods,
              (select count(*) from public.diary_entries where owner_id = $1)::int as "otherEntries",
              (select count(*) from public.reviews where author_id = $1)::int as "otherReviews"`,
      [other],
    );
    expect(a.rows[0]).toEqual(before);
    const conn = await run(other, "select public.my_connections(true) as r");
    expect(conn.rows[0].r).toMatchObject({ following: [], followers: [], friends: [] });
    // The friend's report about the deleted review stays as a record with nothing to open.
    const queue = await pool.query("select state, target_type from public.reports where reporter_id = $1", [other]);
    expect(queue.rows).toEqual([{ state: "open", target_type: "review" }]);
  });

  it("the old session can do nothing afterwards", async () => {
    expect((await pgError(run(full, "select public.delete_my_account('DELETE')"))).code).toBe("PT401");
    const mine = await run(full, "select public.my_reviews(true) as r");
    expect(mine.rows[0].r).toEqual({ reviews: [] });
  });

  it("a second member with the same kinds of data can also be deleted directly by an operator", async () => {
    const again = await buildFullMember("del-again");
    await deleteTestUsers([again]);
    expect(Object.entries(await ownedRowCounts(again)).filter(([, n]) => n > 0)).toEqual([]);
  });

  it("a row left pointing at a missing source record is still refused", async () => {
    const e = await pgError(pool.query("delete from public.source_records where id = $1", [IDS.sourceRecord]));
    expect(e.code).toBe("23503");
  });
});
