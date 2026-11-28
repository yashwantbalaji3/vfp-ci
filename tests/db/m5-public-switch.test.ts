import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { asMember, createTestUser, deleteTestUsers, pool } from "../helpers/db";
import { IDS, M4 } from "../fixtures/ids";

// The public social switch (docs/17 D-M5-GUEST). While it is off, someone who is not
// signed in gets nothing a member wrote, however they ask the database. With it on they
// get approved public content only. With either setting, nobody but the owner gets the
// diary, goals, cooking sessions, meal plans or own foods.
//
// Each check sets the switch inside its own transaction and rolls it back, so the
// setting other tests rely on never changes.

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const TZ = "America/New_York";
const today = new Date().toISOString().slice(0, 10);
let owner: string;
let reader: string;
let handle: string;
let listId: string;
const run = (uid: string | null, sql: string, params: unknown[] = []) => asMember(uid, (c) => c.query(sql, params), { commit: true });

/** Run `fn` as a guest or a member with the switch set to `on`, then undo everything. */
async function withSwitch<T>(on: boolean, userId: string | null, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("update app.platform_switches set enabled = $1 where name = 'social_public'", [on]);
    if (userId) {
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
    } else {
      await c.query("set local role anon");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
    }
    return await fn(c);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
  }
}
/** Call a function; a refusal comes back as `{ refused: SQLSTATE, message }`. Uses a savepoint so later calls still work. */
async function ask(c: PoolClient, sql: string, params: unknown[] = []): Promise<J> {
  await c.query("savepoint s");
  try {
    const r = (await c.query(`select ${sql} as r`, params)).rows[0].r as J;
    await c.query("release savepoint s");
    return r;
  } catch (e) {
    await c.query("rollback to savepoint s");
    const err = e as { code?: string; message?: string };
    return { refused: err.code, message: err.message };
  }
}

const PRIVATE_TABLES = ["diary_entries", "diary_snapshots", "goal_versions", "user_preferences", "ingredient_exclusions", "saves", "meal_plans", "cook_sessions"];
const PRIVATE_WORDS = ["Switch test protein bar", "protein_g_per_day", "diaryEntries", "cookSessions", "mealPlans"];

beforeAll(async () => {
  owner = await createTestUser("m5-switch-owner");
  reader = await createTestUser("m5-switch-reader");
  handle = `switch_${owner.slice(0, 8)}`;
  // Private data the owner never shares.
  await run(owner, "select public.save_my_diet('vegetarian', array['egg'], false)");
  await run(owner, "select public.set_goal('protein_g_per_day', 80, $1)", [today]);
  await run(owner, "select public.log_food_entry($1, $2, $3, 1, null, 'home', 'lunch', $4, $5)", [randomUUID(), IDS.tofu.rev, IDS.tofu.portion150g, today, TZ]);
  await run(owner, "select public.log_new_custom_food($1, $2, null, $3, '1 bar', 40, 1, 'home', 'snack', $4, $5)", [
    randomUUID(), "Switch test protein bar", JSON.stringify({ protein_g: 12, energy_kcal: 180 }), today, TZ,
  ]);
  const started = await run(owner, "select public.start_cook_session($1, $2, 2, '{}', $3, $4, null, true) as r", [randomUUID(), M4.recipe(M4.dal), today, TZ]);
  await run(owner, "select public.complete_cook_session($1, $2, $3)", [started.rows[0].r.sessionId, today, TZ]);
  await run(owner, "select public.plan_recipe($1, $2, 2, 'dinner', true)", [M4.recipe(M4.chana), today]);
  await pool.query("insert into public.saves (owner_id, venue_id) values ($1, $2)", [owner, IDS.venueCentral]);
  // Public social content, already approved by a moderator.
  await run(owner, "select public.save_my_profile($1, 'Switch Owner', 'Public bio', array['spicy'], true, true, true)", [handle]);
  await pool.query(
    "insert into public.member_standing (user_id, first_public_approved_at) values ($1, now()) on conflict (user_id) do update set first_public_approved_at = now()",
    [owner],
  );
  const review = await run(owner, "select public.save_review('venue', $1, 5, 'Switch test public review', null, null, true) as r", [IDS.venueHarvard]);
  await run(owner, "select public.set_review_audience($1, 'public')", [review.rows[0].r.reviewId]);
  await run(owner, "select public.set_ranking($1)", [[IDS.venueHarvard]]);
  await run(owner, "select public.publish_ranking()");
  const list = await run(owner, "select public.save_list(null, 'Switch test public list', null) as r");
  listId = list.rows[0].r.listId;
  await run(owner, "select public.add_to_list($1, 'venue', $2, null, true)", [listId, IDS.venueHarvard]);
  await run(owner, "select public.publish_list($1)", [listId]);
  await run(reader, "select public.save_my_profile($1, 'Switch Reader', null, '{}', true, false, false)", [`reader_${reader.slice(0, 8)}`]);
});
afterAll(async () => {
  await deleteTestUsers([owner, reader]);
  await pool.end();
});

describe("the switch is off unless someone turns it on", () => {
  it("a database built from the migrations alone has the switch off", async () => {
    // The local seed turns it on for testing; the migration itself must not.
    const { rows } = await pool.query(
      "select pg_get_expr(d.adbin, d.adrelid) as def from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum where d.adrelid = 'app.platform_switches'::regclass and a.attname = 'enabled'",
    );
    expect(rows[0].def).toBe("false");
  });

  it("members and guests can neither read nor change the switch", async () => {
    for (const who of [null, reader]) {
      await withSwitch(false, who, async (c) => {
        expect((await ask(c, "(select enabled from app.platform_switches limit 1)")).refused, String(who)).toBe("42501");
        await c.query("savepoint w");
        const write = await c.query("update app.platform_switches set enabled = true").then(() => "allowed", (e: { code?: string }) => e.code);
        await c.query("rollback to savepoint w");
        expect(write, String(who)).toBe("42501");
        expect((await ask(c, "app.guest_may_read(null)")).refused, String(who)).toBe("42501");
      });
    }
  });
});

describe("switch off: a signed-out visitor gets nothing a member wrote", () => {
  it("profile, list and collections are refused or empty, and review texts and names are withheld", async () => {
    await withSwitch(false, null, async (c) => {
      expect(await ask(c, "public.profile_view($1, 'matches', 'none', '{}', false, true)", [handle])).toMatchObject({ refused: "PT404", message: "PROFILE_NOT_FOUND" });
      expect(await ask(c, "public.profile_view('demo_maya', 'matches', 'none', '{}', false, true)")).toMatchObject({ refused: "PT404" });
      expect(await ask(c, "public.list_view($1, 'matches', 'none', '{}', false, true)", [listId])).toMatchObject({ refused: "PT404", message: "LIST_NOT_FOUND" });
      expect((await ask(c, "public.editorial_collections(true)")).collections).toEqual([]);
      const t = await ask(c, "public.target_reviews('venue', $1, true)", [IDS.venueHarvard]);
      expect(t.reviews).toEqual([]);
      expect(t.mine).toBeNull();
      expect(JSON.stringify(t)).not.toContain("Switch test public review");
      expect(JSON.stringify(t)).not.toContain(handle);
      // Only the number of public ratings and their average remain: no names, no text.
      expect(t.summary.count).toBeGreaterThan(0);
    });
  });

  it("everything that needs an account is still refused to a guest", async () => {
    await withSwitch(false, null, async (c) => {
      for (const sql of [
        "public.my_profile()", "public.my_reviews(true)", "public.my_lists()", "public.my_ranking(true)", "public.my_connections(true)",
        "public.social_feed('following')", "public.social_recommendations()", "public.suggested_people(true)", "public.moderation_queue()",
        "public.export_my_data()",
      ]) {
        expect((await ask(c, sql)).refused, sql).toMatch(/^(42501|PT401)$/);
      }
    });
  });

  it("a signed-in member is not affected by the switch", async () => {
    await withSwitch(false, reader, async (c) => {
      const p = await ask(c, "public.profile_view($1, 'matches', 'none', '{}', false, true)", [handle]);
      expect(p.profile.handle).toBe(handle);
      expect(p.reviews.map((r: J) => r.body)).toContain("Switch test public review");
      expect((await ask(c, "public.list_view($1, 'matches', 'none', '{}', false, true)", [listId])).title).toBe("Switch test public list");
      expect((await ask(c, "public.target_reviews('venue', $1, true)", [IDS.venueHarvard])).reviews.map((r: J) => r.body)).toContain("Switch test public review");
    });
  });
});

describe("switch on: a signed-out visitor gets approved public content only", () => {
  it("the public profile, review, ranking and list are readable", async () => {
    await withSwitch(true, null, async (c) => {
      const p = await ask(c, "public.profile_view($1, 'matches', 'none', '{}', false, true)", [handle]);
      expect(p.profile).toMatchObject({ handle, displayName: "Switch Owner", diet: "vegetarian", tastes: ["spicy"] });
      expect(p.relationship).toBeNull();
      expect(p.reviews.map((r: J) => r.body)).toEqual(["Switch test public review"]);
      expect(p.ranking.entries).toHaveLength(1);
      expect(p.lists.map((l: J) => l.title)).toEqual(["Switch test public list"]);
      expect((await ask(c, "public.list_view($1, 'matches', 'none', '{}', false, true)", [listId])).items).toHaveLength(1);
      expect((await ask(c, "public.editorial_collections(true)")).collections.length).toBeGreaterThan(0);
    });
  });

  it("the member's ingredient exclusions are not shown even with the diet switched on", async () => {
    await withSwitch(true, null, async (c) => {
      const p = JSON.stringify(await ask(c, "public.profile_view($1, 'matches', 'none', '{}', false, true)", [handle]));
      expect(p).not.toMatch(/"egg"|exclusion/i);
    });
  });

  it("content that is private, friends-only, waiting or removed stays hidden from a guest", async () => {
    const quiet = await createTestUser("m5-switch-quiet");
    try {
      const qh = `quiet_${quiet.slice(0, 8)}`;
      await run(quiet, "select public.save_my_profile($1, 'Quiet', null, '{}', true, false, false)", [qh]);
      // First public post of a new member: stays pending. Plus one private and one friends-only review.
      const pending = await run(quiet, "select public.save_review('venue', $1, 2, 'Switch test pending review', null, null, true) as r", [IDS.venueHarvard]);
      await run(quiet, "select public.set_review_audience($1, 'public')", [pending.rows[0].r.reviewId]);
      await run(quiet, "select public.save_review('venue', $1, 1, 'Switch test private review', null, null, true)", [IDS.venueAllston]);
      const friendsOnly = await run(quiet, "select public.save_review('food', $1, 3, 'Switch test friends review', null, null, true) as r", [IDS.dosa.item]);
      await run(quiet, "select public.set_review_audience($1, 'friends')", [friendsOnly.rows[0].r.reviewId]);
      await withSwitch(true, null, async (c) => {
        const all = JSON.stringify([
          await ask(c, "public.profile_view($1, 'matches', 'none', '{}', false, true)", [qh]),
          await ask(c, "public.target_reviews('venue', $1, true)", [IDS.venueHarvard]),
          await ask(c, "public.target_reviews('venue', $1, true)", [IDS.venueAllston]),
          await ask(c, "public.target_reviews('food', $1, true)", [IDS.dosa.item]),
        ]);
        expect(all).not.toMatch(/Switch test (pending|private|friends) review/);
      });
    } finally {
      await deleteTestUsers([quiet]);
    }
  });
});

describe("with the switch on or off, private data stays with its owner", () => {
  for (const on of [false, true]) {
    for (const who of ["guest", "member"] as const) {
      it(`switch ${on ? "on" : "off"}: a ${who} gets no diary, goal, preference, save, plan or cooking row of the owner's`, async () => {
        await withSwitch(on, who === "guest" ? null : reader, async (c) => {
          for (const table of PRIVATE_TABLES) {
            await c.query("savepoint t");
            const rows = await c.query(`select * from public.${table}`).then((r) => r.rows, () => []);
            await c.query("rollback to savepoint t");
            expect(JSON.stringify(rows), table).not.toContain(owner);
          }
          await c.query("savepoint f");
          const foods = await c.query("select id from public.food_items where kind = 'custom'").then((r) => r.rows, () => []);
          await c.query("rollback to savepoint f");
          expect(foods).toEqual([]);
        });
      });

      it(`switch ${on ? "on" : "off"}: nothing a ${who} can read through the social functions mentions the owner's private data`, async () => {
        await withSwitch(on, who === "guest" ? null : reader, async (c) => {
          const seen = JSON.stringify([
            await ask(c, "public.profile_view($1, 'matches', 'none', '{}', false, true)", [handle]),
            await ask(c, "public.profile_view($1, 'needs_confirmation', 'none', '{}', false, true)", [handle]),
            await ask(c, "public.list_view($1, 'matches', 'none', '{}', false, true)", [listId]),
            await ask(c, "public.target_reviews('venue', $1, true)", [IDS.venueHarvard]),
            await ask(c, "public.editorial_collections(true)"),
          ]);
          for (const word of PRIVATE_WORDS) expect(seen, word).not.toContain(word);
          expect(seen).not.toContain(owner);
        });
      });
    }
  }

  it("the owner still has all of it", async () => {
    for (const table of ["diary_entries", "goal_versions", "meal_plans", "cook_sessions"]) {
      const { rows } = await asMember(owner, (c) => c.query(`select * from public.${table}`));
      expect(rows.length, table).toBeGreaterThan(0);
    }
  });
});
