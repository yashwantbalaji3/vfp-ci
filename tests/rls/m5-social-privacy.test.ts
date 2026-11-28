import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { IDS, M4 } from "../fixtures/ids";

/**
 * M5 privacy tests through the real Data API (PostgREST + Auth): the surface any
 * browser can call directly, bypassing our pages (docs/12, docs/14 T-SOCIAL).
 *
 * One OWNER has a diary, a goal, an own food, a cook session, a plan and social
 * content at every audience. Six kinds of reader look at it: a FRIEND, a FOLLOWER,
 * a STRANGER, a BLOCKED person, a MODERATOR and a GUEST. For each reader the tests
 * check, table by table and function by function, what comes back. LOCAL stack only.
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const secret = process.env.SUPABASE_SECRET_KEY!;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(url ?? "")) throw new Error("RLS tests run only against the local stack");

const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
const guest = createClient(url, publishable, { auth: { persistSession: false, autoRefreshToken: false } });
type Member = { id: string; client: SupabaseClient; handle: string };
const created: string[] = [];

async function newMember(label: string): Promise<Member> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const password = `pw-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const client = createClient(url, publishable, { auth: { persistSession: false, autoRefreshToken: false } });
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw signIn.error;
  const handle = `${label}_${data.user.id.slice(0, 8)}`;
  const saved = await client.rpc("save_my_profile", { p_handle: handle, p_display_name: label, p_bio: null, p_taste_tags: [], p_discoverable: true, p_show_tastes: false, p_show_diet: false });
  if (saved.error) throw saved.error;
  created.push(data.user.id);
  return { id: data.user.id, client, handle };
}
const ok = async <T>(p: PromiseLike<{ data: T; error: { message: string; code?: string } | null }>): Promise<T> => {
  const { data, error } = await p;
  if (error) throw new Error(`${error.code}: ${error.message}`);
  return data;
};
const DEMO = { p_include_demo: true };
const NONE = { p_diet: "none", p_exclusions: [], p_include_conditional: false };
const TZ = "America/New_York";
const today = new Date().toISOString().slice(0, 10);

let owner: Member, friend: Member, follower: Member, stranger: Member, blocked: Member, moderator: Member;
let readers: [string, SupabaseClient][];
const ids = { privateReview: "", friendsReview: "", publicReview: "", publicList: "", privateList: "", ranking: "" };
const WORDS = { private: "PRIVATE-NOTE-zq1", friends: "FRIENDS-NOTE-zq2", public: "PUBLIC-NOTE-zq3", food: "OWNER-SECRET-BAR-zq4", privateList: "PRIVATE-LIST-zq5", publicList: "PUBLIC-LIST-zq6" };

async function review(m: Member, kind: "venue" | "food", target: string, body: string, audience: "private" | "friends" | "public") {
  const r = await ok(m.client.rpc("save_review", { p_kind: kind, p_target_id: target, p_rating: 4, p_body: body, ...DEMO }));
  if (audience !== "private") await ok(m.client.rpc("set_review_audience", { p_review_id: r.reviewId, p_audience: audience }));
  return r.reviewId as string;
}

beforeAll(async () => {
  [owner, friend, follower, stranger, blocked, moderator] = await Promise.all(["owner", "friend", "follower", "stranger", "blocked", "moderator"].map((l) => newMember(`m5rls-${l}`.replace("-", "_").replace("m5rls_", "m5r_"))));
  await ok(admin.from("role_assignments").insert({ user_id: moderator.id, role: "moderator" }));
  await ok(admin.from("member_standing").upsert({ user_id: owner.id, first_public_approved_at: new Date().toISOString() }));

  // The owner's private life.
  await ok(owner.client.rpc("save_my_diet", { p_diet: "vegan", p_exclusions: ["honey"], p_include_conditional: false }));
  await ok(owner.client.rpc("set_goal", { p_metric: "protein_g_per_day", p_target: 91, p_effective_from: today }));
  await ok(owner.client.rpc("log_new_custom_food", { p_idempotency_key: randomUUID(), p_name: WORDS.food, p_brand: null, p_nutrients: { protein_g: 12 }, p_serving_label: "1 bar", p_serving_grams: 40, p_multiplier: 1, p_context: "home", p_meal_slot: "snack", p_local_date: today, p_timezone: TZ }));
  const cook = await ok(owner.client.rpc("start_cook_session", { p_idempotency_key: randomUUID(), p_food_item_id: M4.recipe(M4.dal), p_servings: 2, p_swaps: {}, p_local_date: today, p_timezone: TZ, ...DEMO }));
  await ok(owner.client.rpc("complete_cook_session", { p_session_id: cook.sessionId, p_local_date: today, p_timezone: TZ }));
  await ok(owner.client.rpc("plan_recipe", { p_food_item_id: M4.recipe(M4.chana), p_date: today, p_servings: 2, p_meal_slot: "dinner", ...DEMO }));
  await ok(owner.client.rpc("save_my_diet", { p_diet: "none", p_exclusions: ["honey"], p_include_conditional: false }));

  // The owner's social content, one at each audience.
  ids.privateReview = await review(owner, "venue", IDS.venueDavis, WORDS.private, "private");
  ids.friendsReview = await review(owner, "venue", IDS.venueAllston, WORDS.friends, "friends");
  ids.publicReview = await review(owner, "venue", IDS.venueHarvard, WORDS.public, "public");
  await ok(owner.client.rpc("set_ranking", { p_venue_ids: [IDS.venueHarvard, IDS.venueDavis] }));
  ids.ranking = (await ok(owner.client.rpc("publish_ranking"))).publicationId;
  ids.privateList = (await ok(owner.client.rpc("save_list", { p_list_id: null, p_title: WORDS.privateList }))).listId;
  await ok(owner.client.rpc("add_to_list", { p_list_id: ids.privateList, p_kind: "venue", p_target_id: IDS.venueDavis, ...DEMO }));
  ids.publicList = (await ok(owner.client.rpc("save_list", { p_list_id: null, p_title: WORDS.publicList }))).listId;
  await ok(owner.client.rpc("add_to_list", { p_list_id: ids.publicList, p_kind: "food", p_target_id: IDS.bowl.item, ...DEMO }));
  await ok(owner.client.rpc("publish_list", { p_list_id: ids.publicList }));

  // Relationships.
  await ok(follower.client.rpc("follow_user", { p_handle: owner.handle, ...DEMO }));
  await ok(friend.client.rpc("request_friend", { p_handle: owner.handle, ...DEMO }));
  await ok(owner.client.rpc("respond_friend", { p_handle: friend.handle, p_accept: true }));
  await ok(blocked.client.rpc("follow_user", { p_handle: owner.handle, ...DEMO }));
  await ok(owner.client.rpc("block_user", { p_handle: blocked.handle }));
  await ok(stranger.client.rpc("report_content", { p_type: "review", p_id: ids.publicReview, p_handle: null, p_reason: "other", ...DEMO }));

  readers = [["friend", friend.client], ["follower", follower.client], ["stranger", stranger.client], ["blocked", blocked.client], ["moderator", moderator.client], ["guest", guest]];
}, 120_000);

afterAll(async () => {
  for (const id of created) await admin.auth.admin.deleteUser(id);
});

const PRIVATE_TABLES = ["diary_entries", "diary_snapshots", "goal_versions", "user_preferences", "ingredient_exclusions", "saves", "meal_plans", "cook_sessions", "daily_log_status"];
const SOCIAL_TABLES = ["reviews", "review_revisions", "ranking_entries", "ranking_publications", "food_lists", "food_list_items", "blocks", "member_standing", "social_action_log"];

describe("no relationship opens the owner's private data (direct table reads)", () => {
  it("the owner really has rows in every private table that matters", async () => {
    for (const t of ["diary_entries", "goal_versions", "user_preferences", "ingredient_exclusions", "meal_plans", "cook_sessions"]) {
      expect(((await ok(owner.client.from(t).select("*"))) ?? []).length, t).toBeGreaterThan(0);
    }
  });

  for (const table of PRIVATE_TABLES) {
    it(`friend, follower, stranger, blocked, moderator and guest get no row of the owner's from ${table}`, async () => {
      for (const [who, client] of readers) {
        const { data } = await client.from(table).select("*");
        const rows = (data ?? []) as Record<string, unknown>[];
        expect(JSON.stringify(rows), `${who} reading ${table}`).not.toContain(owner.id);
        if (who !== "guest") expect(rows, `${who} reading ${table}`).toEqual([]);
      }
    });
  }

  it("nobody else can fetch the owner's own food, its numbers or its private source", async () => {
    const mine = await ok(owner.client.from("food_items").select("id, current_revision_id").eq("kind", "custom"));
    expect(mine).toHaveLength(1);
    const food = (mine ?? [])[0] as { id: string; current_revision_id: string };
    for (const [who, client] of readers) {
      expect((await client.from("food_items").select("id").eq("id", food.id)).data ?? [], who).toEqual([]);
      expect((await client.from("food_revisions").select("id").eq("id", food.current_revision_id)).data ?? [], who).toEqual([]);
      expect((await client.from("nutrient_values").select("value").eq("revision_id", food.current_revision_id)).data ?? [], who).toEqual([]);
      expect((await client.from("sources").select("id").eq("owner_id", owner.id)).data ?? [], who).toEqual([]);
    }
  });

  it("the diary and cooking functions give other readers only their own (empty) data", async () => {
    for (const [who, client] of readers) {
      if (who === "guest") {
        expect((await client.rpc("diary_day", { p_date: today })).error, who).not.toBeNull();
        expect((await client.rpc("export_my_data")).error, who).not.toBeNull();
        continue;
      }
      expect(JSON.stringify(await ok(client.rpc("diary_day", { p_date: today }))), who).not.toContain(WORDS.food);
      expect(JSON.stringify(await ok(client.rpc("my_goals", { p_date: today }))), who).not.toContain("91");
      const exported = JSON.stringify(await ok(client.rpc("export_my_data")));
      for (const word of [WORDS.food, WORDS.private, WORDS.friends, WORDS.privateList, owner.id]) expect(exported, `${who} export`).not.toContain(word);
    }
  });
});

describe("social tables cannot be read around the rules (direct table reads)", () => {
  for (const table of SOCIAL_TABLES) {
    it(`${table}: no reader gets a row belonging to the owner`, async () => {
      for (const [who, client] of readers) {
        const { data } = await client.from(table).select("*");
        const text = JSON.stringify(data ?? []);
        expect(text, `${who} reading ${table}`).not.toContain(owner.id);
        for (const word of Object.values(WORDS)) expect(text, `${who} reading ${table}`).not.toContain(word);
      }
    });
  }

  it("a follow row is readable only by the follower; a friendship only by its two people; a report only by its reporter", async () => {
    expect(await ok(follower.client.from("follows").select("followed_id"))).toEqual([{ followed_id: owner.id }]);
    expect(await ok(owner.client.from("follows").select("*"))).toEqual([]);
    for (const [who, client] of readers) {
      if (who === "follower") continue;
      expect(JSON.stringify((await client.from("follows").select("*")).data ?? []), who).not.toContain(owner.id);
    }
    expect(await ok(friend.client.from("friendships").select("state"))).toEqual([{ state: "accepted" }]);
    for (const m of [follower, stranger, blocked, moderator]) expect(await ok(m.client.from("friendships").select("*"))).toEqual([]);
    expect(await ok(stranger.client.from("reports").select("reason"))).toEqual([{ reason: "other" }]);
    for (const m of [owner, friend, follower, moderator]) expect(await ok(m.client.from("reports").select("*"))).toEqual([]);
    expect((await guest.from("reports").select("*")).data ?? []).toEqual([]);
  });

  it("a profile row is readable directly only by its owner", async () => {
    expect(await ok(owner.client.from("profiles_public").select("handle"))).toEqual([{ handle: owner.handle }]);
    for (const [who, client] of readers) {
      expect(JSON.stringify((await client.from("profiles_public").select("*")).data ?? []), who).not.toContain(owner.handle);
    }
  });

  it("the audit trail is not readable by members, moderators or guests", async () => {
    for (const [who, client] of [...readers, ["owner", owner.client] as [string, SupabaseClient]]) {
      expect((await client.from("audit_events").select("*")).data ?? [], who).toEqual([]);
    }
  });
});

describe("nobody, including the owner, can write the social tables directly", () => {
  const attempts: [string, Record<string, unknown>][] = [
    ["reviews", { author_id: "", venue_id: IDS.venueCentral, rating: 5, audience: "public", publication_state: "visible" }],
    ["follows", { follower_id: "", followed_id: "OWNER" }],
    ["friendships", { requester_id: "", recipient_id: "OWNER", state: "accepted", accepted_at: new Date().toISOString() }],
    ["blocks", { blocker_id: "", blocked_id: "OWNER" }],
    ["ranking_entries", { owner_id: "", venue_id: IDS.venueCentral, position: 1 }],
    ["ranking_publications", { owner_id: "", snapshot: [], publication_state: "visible" }],
    ["food_lists", { owner_id: "", title: "x", visibility: "public", publication_state: "visible", is_editorial: true }],
    ["reports", { reporter_id: "", target_type: "review", target_id: randomUUID(), reason: "spam" }],
    ["member_standing", { user_id: "", first_public_approved_at: new Date().toISOString() }],
    ["role_assignments", { user_id: "", role: "moderator" }],
    ["profiles_public", { user_id: "", handle: `forged_${randomUUID().slice(0, 6)}` }],
  ];
  for (const [table, row] of attempts) {
    it(`${table}: insert, update and delete are refused for a member, a moderator and a guest`, async () => {
      for (const m of [stranger, moderator, owner]) {
        const filled = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v === "" ? m.id : v === "OWNER" ? (m === owner ? stranger.id : owner.id) : v]));
        expect((await m.client.from(table).insert(filled)).error, `${table} insert`).not.toBeNull();
        const upd = await m.client.from(table).update(table === "reviews" ? { audience: "public", publication_state: "visible" } : table === "food_lists" ? { is_editorial: true } : filled).neq(Object.keys(row)[0], randomUUID()).select();
        expect(upd.error !== null || (upd.data ?? []).length === 0, `${table} update`).toBe(true);
        const del = await m.client.from(table).delete().neq(Object.keys(row)[0], randomUUID()).select();
        expect(del.error !== null || (del.data ?? []).length === 0, `${table} delete`).toBe(true);
      }
      expect((await guest.from(table).insert(row)).error, `${table} guest insert`).not.toBeNull();
    });
  }

  it("the owner's content is unchanged after all those attempts", async () => {
    const mine = await ok(owner.client.rpc("my_reviews", DEMO));
    expect(mine.reviews.map((r: { audience: string; state: string }) => `${r.audience}/${r.state}`).sort()).toEqual(["friends/visible", "private/draft", "public/visible"]);
    expect((await ok(owner.client.rpc("my_profile"))).isModerator).toBe(false);
    expect((await ok(stranger.client.rpc("my_profile"))).isModerator).toBe(false);
  });
});

describe("what each reader gets from the functions", () => {
  const visibleWords = async (client: SupabaseClient): Promise<string> => {
    const parts: unknown[] = [];
    for (const v of [IDS.venueDavis, IDS.venueAllston, IDS.venueHarvard]) parts.push((await client.rpc("target_reviews", { p_kind: "venue", p_target_id: v, ...DEMO })).data);
    parts.push((await client.rpc("profile_view", { p_handle: owner.handle, p_view: "matches", ...NONE, ...DEMO })).data);
    parts.push((await client.rpc("social_feed", { p_feed: "following", p_view: "matches", ...NONE, ...DEMO })).data);
    parts.push((await client.rpc("social_feed", { p_feed: "friends", p_view: "matches", ...NONE, ...DEMO })).data);
    parts.push((await client.rpc("social_recommendations", { p_view: "matches", ...NONE, ...DEMO })).data);
    parts.push((await client.rpc("list_view", { p_list_id: ids.privateList, p_view: "matches", ...NONE, ...DEMO })).data);
    parts.push((await client.rpc("list_view", { p_list_id: ids.publicList, p_view: "matches", ...NONE, ...DEMO })).data);
    return JSON.stringify(parts);
  };

  it("the owner sees all of their own content", async () => {
    const text = JSON.stringify([await ok(owner.client.rpc("my_reviews", DEMO)), await ok(owner.client.rpc("my_lists"))]);
    for (const w of [WORDS.private, WORDS.friends, WORDS.public, WORDS.privateList, WORDS.publicList]) expect(text).toContain(w);
  });

  it("a friend sees friends-only and public content, never private", async () => {
    const text = await visibleWords(friend.client);
    expect(text).toContain(WORDS.friends);
    expect(text).toContain(WORDS.public);
    expect(text).toContain(WORDS.publicList);
    expect(text).not.toContain(WORDS.private);
    expect(text).not.toContain(WORDS.privateList);
  });

  for (const who of ["follower", "stranger", "moderator", "guest"] as const) {
    it(`a ${who} sees public content only`, async () => {
      const client = { follower: follower.client, stranger: stranger.client, moderator: moderator.client, guest }[who];
      const text = await visibleWords(client);
      expect(text).toContain(WORDS.public);
      expect(text).toContain(WORDS.publicList);
      for (const w of [WORDS.friends, WORDS.private, WORDS.privateList, WORDS.food]) expect(text, w).not.toContain(w);
    });
  }

  it("a blocked person sees nothing of the owner's, public or not, and gets the same 'not found' as for nobody", async () => {
    const text = await visibleWords(blocked.client);
    for (const w of Object.values(WORDS)) expect(text, w).not.toContain(w);
    expect(text).not.toContain(owner.handle);
    const gone = await blocked.client.rpc("profile_view", { p_handle: owner.handle, p_view: "matches", ...NONE, ...DEMO });
    const never = await blocked.client.rpc("profile_view", { p_handle: "nobody_at_all_here", p_view: "matches", ...NONE, ...DEMO });
    expect([gone.error?.code, gone.error?.message]).toEqual([never.error?.code, never.error?.message]);
    expect(gone.error?.code).toBe("PT404");
    // The block removed the follow, and a new one is refused.
    expect((await blocked.client.rpc("follow_user", { p_handle: owner.handle, ...DEMO })).error?.code).toBe("PT404");
    expect((await blocked.client.rpc("request_friend", { p_handle: owner.handle, ...DEMO })).error?.code).toBe("PT404");
    expect((await blocked.client.rpc("report_content", { p_type: "review", p_id: ids.publicReview, p_handle: null, p_reason: "spam", ...DEMO })).error?.code).toBe("PT404");
    // But the public average still counts the review: an average is not personal to the reader.
    expect((await ok(blocked.client.rpc("target_reviews", { p_kind: "venue", p_target_id: IDS.venueHarvard, ...DEMO }))).summary.count).toBeGreaterThan(0);
  });

  it("only the follower's Following feed and only the friend's Friends feed contain the owner's posts", async () => {
    const feed = async (c: SupabaseClient, f: string) => JSON.stringify(await ok(c.rpc("social_feed", { p_feed: f, p_view: "matches", ...NONE, ...DEMO })));
    expect(await feed(follower.client, "following")).toContain(WORDS.public);
    expect(await feed(follower.client, "friends")).not.toContain(owner.handle);
    expect(await feed(friend.client, "friends")).toContain(WORDS.friends);
    expect(await feed(friend.client, "following")).not.toContain(owner.handle);
    for (const m of [stranger, moderator]) {
      expect(await feed(m.client, "following")).not.toContain(owner.handle);
      expect(await feed(m.client, "friends")).not.toContain(owner.handle);
    }
  });

  it("nobody can read another person's lists of followers, following, friends or blocks", async () => {
    for (const m of [friend, follower, stranger, moderator]) {
      const c = JSON.stringify(await ok(m.client.rpc("my_connections", DEMO)));
      expect(c).not.toContain(blocked.handle); // the owner's block list
      if (m !== follower) expect(c).not.toContain(follower.handle); // the owner's follower list
    }
    const seen = await ok(stranger.client.rpc("profile_view", { p_handle: owner.handle, p_view: "matches", ...NONE, ...DEMO }));
    expect(seen.profile.followerCount).toBe(1);
    expect(JSON.stringify(seen)).not.toContain(follower.handle);
    expect(JSON.stringify(seen)).not.toContain(friend.handle);
    // Diet and exclusions were never switched on, so they are not on the profile.
    expect(seen.profile.diet).toBeNull();
    expect(JSON.stringify(seen)).not.toContain("honey");
  });

  it("no one can change or delete the owner's content through the functions", async () => {
    for (const m of [friend, follower, stranger, moderator]) {
      expect((await m.client.rpc("set_review_audience", { p_review_id: ids.privateReview, p_audience: "public" })).error?.code).toBe("PT404");
      expect((await m.client.rpc("delete_review", { p_review_id: ids.publicReview })).error?.code).toBe("PT404");
      expect((await m.client.rpc("delete_list", { p_list_id: ids.publicList })).error?.code).toBe("PT404");
      expect((await m.client.rpc("set_list_items", { p_list_id: ids.publicList, p_items: [], ...DEMO })).error?.code).toBe("PT404");
      expect((await m.client.rpc("add_to_list", { p_list_id: ids.privateList, p_kind: "venue", p_target_id: IDS.venueCentral, ...DEMO })).error?.code).toBe("PT404");
      expect((await m.client.rpc("unpublish_list", { p_list_id: ids.publicList })).error?.code).toBe("PT404");
    }
  });

  it("a guest can call only the public read functions", async () => {
    const calls: [string, Record<string, unknown>][] = [
      ["my_profile", {}], ["my_connections", DEMO], ["my_reviews", DEMO], ["my_ranking", DEMO], ["my_lists", {}],
      ["follow_user", { p_handle: owner.handle, ...DEMO }], ["request_friend", { p_handle: owner.handle, ...DEMO }], ["block_user", { p_handle: owner.handle }],
      ["save_review", { p_kind: "venue", p_target_id: IDS.venueCentral, p_rating: 5, ...DEMO }], ["set_review_audience", { p_review_id: ids.publicReview, p_audience: "private" }],
      ["publish_ranking", {}], ["save_list", { p_list_id: null, p_title: "x" }], ["publish_list", { p_list_id: ids.privateList }],
      ["social_feed", { p_feed: "following", p_view: "matches", ...NONE, ...DEMO }], ["social_recommendations", { p_view: "matches", ...NONE, ...DEMO }],
      ["find_people", { p_handle: owner.handle, ...DEMO }], ["suggested_people", DEMO],
      ["report_content", { p_type: "review", p_id: ids.publicReview, p_handle: null, p_reason: "spam", ...DEMO }],
      ["moderation_queue", {}], ["moderate", { p_type: "review", p_id: ids.publicReview, p_action: "remove", p_reason: "x" }],
      ["corrections_queue", {}], ["delete_my_account", { p_confirm: "DELETE" }], ["save_my_profile", { p_handle: "guest_x", p_display_name: null, p_bio: null, p_taste_tags: [], p_discoverable: true, p_show_tastes: true, p_show_diet: true }],
    ];
    for (const [fn, args] of calls) expect((await guest.rpc(fn, args)).error, fn).not.toBeNull();
    expect((await guest.rpc("editorial_collections", DEMO)).error).toBeNull();
  });

  it("the internal helper functions are not reachable over the Data API", async () => {
    for (const fn of ["rating_summary", "review_json", "profile_json", "social_rate", "moderation_target", "export_core", "person_json", "is_moderator"]) {
      expect((await stranger.client.rpc(fn, {})).error, fn).not.toBeNull();
      expect((await stranger.client.schema("app" as never).rpc(fn, {})).error, `app.${fn}`).not.toBeNull();
    }
  });
});

describe("moderation through the Data API", () => {
  it("only the moderator opens the queue; it shows the reported text but not the reporter, and nothing private", async () => {
    for (const m of [owner, friend, follower, stranger]) expect((await m.client.rpc("moderation_queue")).error?.code).toBe("PT403");
    const q = await ok(moderator.client.rpc("moderation_queue"));
    const text = JSON.stringify(q);
    expect(text).toContain(WORDS.public);
    expect(text).not.toContain(stranger.handle);
    expect(text).not.toContain(stranger.id);
    for (const w of [WORDS.private, WORDS.friends, WORDS.food, WORDS.privateList]) expect(text, w).not.toContain(w);
  });

  it("a member cannot moderate; the moderator's removal takes the review out of what everyone sees and out of the average", async () => {
    for (const m of [stranger, friend]) {
      expect((await m.client.rpc("moderate", { p_type: "review", p_id: ids.publicReview, p_action: "remove", p_reason: "nope" })).error?.code).toBe("PT403");
      expect((await m.client.rpc("dismiss_reports", { p_report_id: randomUUID() })).error?.code).toBe("PT403");
    }
    const before = (await ok(guest.rpc("target_reviews", { p_kind: "venue", p_target_id: IDS.venueHarvard, ...DEMO }))).summary.count;
    await ok(moderator.client.rpc("moderate", { p_type: "review", p_id: ids.publicReview, p_action: "remove", p_reason: "Test removal" }));
    for (const client of [friend.client, follower.client, stranger.client, guest]) {
      const t = await ok(client.rpc("target_reviews", { p_kind: "venue", p_target_id: IDS.venueHarvard, ...DEMO }));
      expect(JSON.stringify(t)).not.toContain(WORDS.public);
      expect(t.summary.count).toBe(before - 1);
    }
    // The owner cannot simply flip it back to visible.
    expect((await ok(owner.client.rpc("set_review_audience", { p_review_id: ids.publicReview, p_audience: "public" }))).state).toBe("pending");
    expect(JSON.stringify(await ok(guest.rpc("target_reviews", { p_kind: "venue", p_target_id: IDS.venueHarvard, ...DEMO })))).not.toContain(WORDS.public);
  });
});
