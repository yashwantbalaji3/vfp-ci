import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asMember, createTestUser, deleteTestUsers, pgError, pool } from "../helpers/db";
import { IDS, M4 } from "../fixtures/ids";

// M5 Social (T-SOCIAL in docs/14): profiles, following, friendships, blocks, reviews,
// first-post approval, rating summaries, rankings, lists, feeds, recommendations,
// reports, moderation, rate limits and the reader's dietary rule.

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ids: Record<string, string> = {};
const h = (name: string) => `${name}_${ids[name].slice(0, 8)}`;
const call = async (who: string | null, sql: string, params: unknown[] = []): Promise<J> =>
  (await asMember(who ? ids[who] : null, (c) => c.query(`select ${sql} as r`, params), { commit: true })).rows[0].r;
const fail = (who: string | null, sql: string, params: unknown[] = []) => pgError(call(who, sql, params));
const approveStanding = (name: string) =>
  pool.query(
    "insert into public.member_standing (user_id, first_public_approved_at) values ($1, now()) on conflict (user_id) do update set first_public_approved_at = now()",
    [ids[name]],
  );
const review = async (who: string, kind: "venue" | "food", target: string, rating: number, audience: "private" | "friends" | "public", body: string | null = null) => {
  const r = await call(who, "public.save_review($1, $2, $3, $4, null, null, true)", [kind, target, rating, body]);
  if (audience !== "private") return call(who, "public.set_review_audience($1, $2)", [r.reviewId, audience]);
  return r;
};
const VEGAN = ["vegan", [], false] as const;

beforeAll(async () => {
  // Other suites (browser and privacy tests) leave throwaway members behind on the local
  // database. Their reviews would change the averages checked here, so clear them first.
  await pool.query("delete from public.reviews r using auth.users u where u.id = r.author_id and u.email like '%@example.test'");
  for (const name of ["ana", "fred", "wes", "sam", "xena", "mod", "newbie", "quiet"]) {
    ids[name] = await createTestUser(`m5-${name}`);
    if (name !== "quiet") {
      await call(name, "public.save_my_profile($1, $2, null, '{}', true, false, false)", [h(name), name[0].toUpperCase() + name.slice(1)]);
    }
  }
  await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'moderator')", [ids.mod]);
  for (const name of ["ana", "fred", "wes", "sam", "xena"]) await approveStanding(name);
});
afterAll(async () => {
  await deleteTestUsers(Object.values(ids));
  await pool.end();
});

describe("profiles", () => {
  it("a handle must be valid, unused and not look official", async () => {
    expect(await fail("quiet", "public.save_my_profile('No Spaces', null, null, '{}', false, false, false)")).toMatchObject({ code: "PT422", message: "INVALID_HANDLE" });
    expect(await fail("quiet", "public.save_my_profile($1, null, null, '{}', false, false, false)", [h("ana")])).toMatchObject({ code: "PT409", message: "HANDLE_TAKEN" });
    expect(await fail("quiet", "public.save_my_profile('moderator', null, null, '{}', false, false, false)")).toMatchObject({ code: "PT409" });
    expect(await fail(null, "public.save_my_profile('guest_name', null, null, '{}', false, false, false)")).toMatchObject({ code: "42501" });
  });

  it("taste and dietary details stay private until the member switches them on", async () => {
    await asMember(ids.ana, (c) => c.query("select public.save_my_diet('vegan', array['honey'], false)"), { commit: true });
    await call("ana", "public.save_my_profile($1, 'Ana', 'Dosa fan', array['Spicy', 'south indian'], true, false, false)", [h("ana")]);
    let seen = await call("sam", "public.profile_view($1, 'matches', 'none', '{}', false, true)", [h("ana")]);
    expect(seen.profile).toMatchObject({ handle: h("ana"), displayName: "Ana", bio: "Dosa fan", tastes: null, diet: null });
    await call("ana", "public.save_my_profile($1, 'Ana', 'Dosa fan', array['Spicy', 'south indian'], true, true, true)", [h("ana")]);
    seen = await call("sam", "public.profile_view($1, 'matches', 'none', '{}', false, true)", [h("ana")]);
    expect(seen.profile.tastes).toEqual(["south indian", "spicy"]);
    expect(seen.profile.diet).toBe("vegan");
    // Ingredient exclusions can reveal an allergy: they never appear anywhere on a profile.
    expect(JSON.stringify(seen)).not.toContain("honey");
    await call("ana", "public.save_my_profile($1, 'Ana', 'Dosa fan', array['spicy'], true, false, false)", [h("ana")]);
    await asMember(ids.ana, (c) => c.query("select public.save_my_diet('none', '{}', false)"), { commit: true });
  });

  it("a member cannot write the profile or standing tables directly", async () => {
    expect((await pgError(asMember(ids.ana, (c) => c.query("update public.profiles_public set show_diet = true where user_id = $1", [ids.ana])))).code).toBe("42501");
    expect((await pgError(asMember(ids.newbie, (c) => c.query("update public.member_standing set first_public_approved_at = now()")))).code).toBe("42501");
    expect((await pgError(asMember(ids.newbie, (c) => c.query("select * from public.member_standing")))).code).toBe("42501");
  });

  it("search finds only an exact handle of someone who chose to be findable", async () => {
    await call("xena", "public.save_my_profile($1, 'Xena', null, '{}', false, false, false)", [h("xena")]);
    expect((await call("sam", "public.find_people($1, true)", [h("xena")])).results).toEqual([]);
    expect((await call("sam", "public.find_people($1, true)", [h("ana").slice(0, 6)])).results).toEqual([]);
    expect((await call("sam", "public.find_people($1, true)", ["@" + h("ana").toUpperCase()])).results).toEqual([
      { handle: h("ana"), displayName: "Ana", isDemo: false },
    ]);
    expect((await fail(null, "public.find_people('anyone', true)")).code).toBe("42501");
    await call("xena", "public.save_my_profile($1, 'Xena', null, '{}', true, false, false)", [h("xena")]);
  });

  it("a guest can open a public profile but sees no relationship", async () => {
    const seen = await call(null, "public.profile_view($1, 'matches', 'none', '{}', false, true)", [h("ana")]);
    expect(seen.relationship).toBeNull();
    expect(seen.isMe).toBe(false);
    expect((await fail(null, "public.profile_view('nobody_here', 'matches', 'none', '{}', false, true)")).code).toBe("PT404");
  });
});

describe("following and friendships are separate", () => {
  it("following needs a profile, is one-way and shows in the public counts", async () => {
    expect(await fail("quiet", "public.follow_user($1, true)", [h("ana")])).toMatchObject({ code: "PT409", message: "PROFILE_REQUIRED" });
    expect(await fail("wes", "public.follow_user($1, true)", [h("wes")])).toMatchObject({ code: "PT422" });
    await call("wes", "public.follow_user($1, true)", [h("ana")]);
    await call("wes", "public.follow_user($1, true)", [h("ana")]); // repeating changes nothing
    const seen = await call("sam", "public.profile_view($1, 'matches', 'none', '{}', false, true)", [h("ana")]);
    expect(seen.profile).toMatchObject({ followerCount: 1, followingCount: 0 });
    const wes = await call("wes", "public.profile_view($1, 'matches', 'none', '{}', false, true)", [h("ana")]);
    expect(wes.relationship).toMatchObject({ following: true, followsMe: false, friendship: "none" });
  });

  it("the lists of followers and following are visible only to their owner", async () => {
    expect((await call("ana", "public.my_connections(true)")).followers).toEqual([{ handle: h("wes"), displayName: "Wes", isDemo: false }]);
    expect((await call("wes", "public.my_connections(true)")).following.map((p: J) => p.handle)).toEqual([h("ana")]);
    const stranger = await call("sam", "public.profile_view($1, 'matches', 'none', '{}', false, true)", [h("ana")]);
    expect(JSON.stringify(stranger)).not.toContain(h("wes"));
    // No one but the two people in a follow can read the row.
    const rows = await asMember(ids.sam, (c) => c.query("select * from public.follows"));
    expect(rows.rows).toEqual([]);
    const own = await asMember(ids.ana, (c) => c.query("select * from public.follows"));
    expect(own.rows).toEqual([]); // even the followed person reads followers through my_connections only
  });

  it("a friend request goes only to someone findable or who follows me, and must be accepted", async () => {
    await call("xena", "public.save_my_profile($1, 'Xena', null, '{}', false, false, false)", [h("xena")]);
    expect(await fail("sam", "public.request_friend($1, true)", [h("xena")])).toMatchObject({ code: "PT403", message: "REQUEST_NOT_ALLOWED" });
    await call("xena", "public.save_my_profile($1, 'Xena', null, '{}', true, false, false)", [h("xena")]);

    expect(await call("fred", "public.request_friend($1, true)", [h("ana")])).toEqual({ friendship: "outgoing" });
    expect(await call("fred", "public.request_friend($1, true)", [h("ana")])).toEqual({ friendship: "outgoing" });
    expect((await call("ana", "public.my_profile()")).incomingRequests).toBe(1);
    expect((await call("ana", "public.my_connections(true)")).incoming.map((p: J) => p.handle)).toEqual([h("fred")]);
    // Not friends yet: nothing friends-only is unlocked by a pending request.
    expect((await pool.query("select app.are_friends($1, $2) as f", [ids.ana, ids.fred])).rows[0].f).toBe(false);
    expect(await call("ana", "public.respond_friend($1, true)", [h("fred")])).toEqual({ friendship: "friends" });
    expect((await call("fred", "public.my_connections(true)")).friends.map((p: J) => p.handle)).toEqual([h("ana")]);
    // Friendship does not create a follow, and a follow does not create a friendship.
    expect((await call("fred", "public.my_connections(true)")).following).toEqual([]);
    expect((await call("wes", "public.my_connections(true)")).friends).toEqual([]);
  });

  it("requests can be declined or cancelled, and asking back accepts", async () => {
    await call("sam", "public.request_friend($1, true)", [h("wes")]);
    expect(await call("wes", "public.respond_friend($1, false)", [h("sam")])).toEqual({ friendship: "none" });
    await call("sam", "public.request_friend($1, true)", [h("wes")]);
    await call("sam", "public.remove_friend($1)", [h("wes")]); // cancel my own request
    expect((await call("wes", "public.my_connections(true)")).incoming).toEqual([]);
    expect((await fail("wes", "public.respond_friend($1, true)", [h("sam")])).code).toBe("PT404");
    // The person who received a request cannot use "remove" to make it vanish silently as accepted.
    await call("sam", "public.request_friend($1, true)", [h("wes")]);
    expect(await call("wes", "public.request_friend($1, true)", [h("sam")])).toEqual({ friendship: "friends" });
    await call("wes", "public.remove_friend($1)", [h("sam")]);
    expect((await call("sam", "public.my_connections(true)")).friends).toEqual([]);
  });
});

describe("reviews: audience, first-post approval and separate summaries", () => {
  it("a new review is a private draft nobody else can see", async () => {
    const r = await review("ana", "venue", IDS.venueDavis, 5, "private", "Private note about noodles");
    expect(r).toMatchObject({ audience: "private", state: "draft", version: 1 });
    for (const who of ["fred", "wes", "sam", null]) {
      const t = await call(who, "public.target_reviews('venue', $1, true)", [IDS.venueDavis]);
      expect(t.reviews).toEqual([]);
      expect(t.summary).toEqual({ count: 0, average: null, early: true });
    }
    expect((await call("ana", "public.target_reviews('venue', $1, true)", [IDS.venueDavis])).mine).toMatchObject({ rating: 5, audience: "private" });
  });

  it("a friends-only review reaches accepted friends and nobody else, and never counts publicly", async () => {
    const r = await review("ana", "venue", IDS.venueDavis, 5, "friends", "Friends only: the back room is quiet");
    expect(r).toMatchObject({ audience: "friends", state: "visible" });
    const asFriend = await call("fred", "public.target_reviews('venue', $1, true)", [IDS.venueDavis]);
    expect(asFriend.reviews.map((x: J) => x.body)).toEqual(["Friends only: the back room is quiet"]);
    for (const who of ["wes", "sam", null]) {
      expect((await call(who, "public.target_reviews('venue', $1, true)", [IDS.venueDavis])).reviews, String(who)).toEqual([]);
    }
    expect(asFriend.summary.count).toBe(0);
    // On the profile: the friend sees it, the follower does not.
    expect((await call("fred", "public.profile_view($1, 'matches', 'none', '{}', false, true)", [h("ana")])).reviews).toHaveLength(1);
    expect((await call("wes", "public.profile_view($1, 'matches', 'none', '{}', false, true)", [h("ana")])).reviews).toEqual([]);
  });

  it("a member cannot change audience, state or rating by writing the table", async () => {
    expect((await pgError(asMember(ids.ana, (c) => c.query("update public.reviews set audience = 'public', publication_state = 'visible'")))).code).toBe("42501");
    expect((await pgError(asMember(ids.ana, (c) => c.query("insert into public.reviews (author_id, venue_id, rating) values ($1, $2, 5)", [ids.ana, IDS.venueCentral])))).code).toBe("42501");
  });

  it("a new account's first public post waits for a moderator and counts nowhere meanwhile", async () => {
    const first = await review("newbie", "venue", IDS.venueCentral, 1, "public", "First post");
    expect(first).toMatchObject({ audience: "public", state: "pending" });
    const second = await review("newbie", "food", IDS.bowl.item, 2, "public", "Second post");
    expect(second.state).toBe("pending");
    for (const who of ["sam", null]) {
      const t = await call(who, "public.target_reviews('venue', $1, true)", [IDS.venueCentral]);
      expect(t.reviews).toEqual([]);
      expect(t.summary.count).toBe(0);
    }
    // Switching to private and back does not skip the check.
    await call("newbie", "public.set_review_audience($1, 'private')", [first.reviewId]);
    expect((await call("newbie", "public.set_review_audience($1, 'public')", [first.reviewId])).state).toBe("pending");
    // The author still sees their own post, marked as waiting.
    expect((await call("newbie", "public.target_reviews('venue', $1, true)", [IDS.venueCentral])).mine.state).toBe("pending");
  });

  it("approving one post publishes that post only; later posts appear at once", async () => {
    const queue = await call("mod", "public.moderation_queue()");
    const mine = queue.pending.filter((p: J) => p.author.handle === h("newbie"));
    expect(mine).toHaveLength(2);
    expect(mine.every((p: J) => p.firstPost)).toBe(true);
    const firstId = mine.find((p: J) => p.body === "First post").id;
    const secondId = mine.find((p: J) => p.body === "Second post").id;
    expect(await call("mod", "public.moderate('review', $1, 'approve', null)", [firstId])).toMatchObject({ state: "visible" });

    const venue = await call("sam", "public.target_reviews('venue', $1, true)", [IDS.venueCentral]);
    expect(venue.summary).toEqual({ count: 1, average: 1, early: true });
    // The other waiting post is NOT published by that approval.
    const dish = await call("sam", "public.target_reviews('food', $1, true)", [IDS.bowl.item]);
    expect(dish.reviews).toEqual([]);
    expect(dish.summary.count).toBe(0);
    expect((await pool.query("select publication_state from public.reviews where id = $1", [secondId])).rows[0].publication_state).toBe("pending");
    // A NEW public post by the now-approved member is visible immediately.
    expect((await review("newbie", "venue", IDS.venueBackBay, 4, "public")).state).toBe("visible");
    await call("mod", "public.moderate('review', $1, 'approve', null)", [secondId]);
  });

  it("restaurant ratings and dish ratings are summarised separately, to one decimal", async () => {
    await review("ana", "venue", IDS.venueCentral, 5, "public");
    await review("sam", "venue", IDS.venueCentral, 4, "public");
    await review("ana", "food", IDS.bowl.item, 5, "public");
    const venue = await call(null, "public.target_reviews('venue', $1, true)", [IDS.venueCentral]);
    expect(venue.summary).toEqual({ count: 3, average: 3.3, early: true }); // 1, 5, 4
    const dish = await call(null, "public.target_reviews('food', $1, true)", [IDS.bowl.item]);
    expect(dish.summary).toEqual({ count: 2, average: 3.5, early: true }); // 2, 5
    for (const who of ["fred", "wes"]) await review(who, "venue", IDS.venueCentral, 4, "public");
    expect((await call(null, "public.target_reviews('venue', $1, true)", [IDS.venueCentral])).summary).toEqual({ count: 5, average: 3.6, early: false });
  });

  it("one review per person per place; editing keeps history and checks the version", async () => {
    const again = await call("sam", "public.save_review('venue', $1, 2, 'Changed my mind', null, null, true)", [IDS.venueCentral]);
    expect(again.version).toBeGreaterThan(1);
    expect((await call(null, "public.target_reviews('venue', $1, true)", [IDS.venueCentral])).summary).toEqual({ count: 5, average: 3.2, early: false });
    expect((await fail("sam", "public.save_review('venue', $1, 3, null, null, 1, true)", [IDS.venueCentral])).code).toBe("PT409");
    const hist = await pool.query("select count(*)::int as n from public.review_revisions where review_id = $1", [again.reviewId]);
    expect(hist.rows[0].n).toBe(again.version);
    const shown = (await call("ana", "public.target_reviews('venue', $1, true)", [IDS.venueCentral])).reviews.find((x: J) => x.author.handle === h("sam"));
    expect(shown).toMatchObject({ edited: true, body: "Changed my mind" });
  });

  it("invalid ratings, dates and targets are refused; own foods cannot be reviewed", async () => {
    expect((await fail("sam", "public.save_review('venue', $1, 6, null, null, null, true)", [IDS.venueDavis])).code).toBe("PT422");
    expect((await fail("sam", "public.save_review('venue', $1, 0, null, null, null, true)", [IDS.venueDavis])).code).toBe("PT422");
    expect((await fail("sam", "public.save_review('venue', $1, 4, null, '2999-01-01', null, true)", [IDS.venueDavis])).code).toBe("PT422");
    expect((await fail("sam", "public.save_review('venue', $1, 4, null, null, null, true)", [IDS.bowl.item])).code).toBe("PT404");
    expect((await fail("sam", "public.save_review('food', $1, 4, null, null, null, true)", [IDS.tofu.item])).code).toBe("PT404"); // a raw ingredient
    expect((await fail("sam", "public.save_review('venue', $1, 4, null, null, null, false)", [IDS.venueDavis])).code).toBe("PT404"); // demo off
    const own = await asMember(ids.sam, (c) => c.query("select public.create_custom_food('Sam bar', null, 'mass', 100, $1, '[]', null) as r", [JSON.stringify({ protein_g: 10 })]), { commit: true });
    const ownId = own.rows[0].r.foodItemId ?? own.rows[0].r.food_item_id;
    expect(ownId).toBeTruthy();
    expect((await fail("sam", "public.save_review('food', $1, 4, null, null, null, true)", [ownId])).code).toBe("PT404");
  });

  it("a published recipe can be rated and reviewed, with the usual audiences (migration 20261122000500)", async () => {
    const recipe = M4.recipe(1);
    const r = await review("wes", "food", recipe, 4, "friends", "Cooked it twice; more lemon next time");
    expect(r).toBeTruthy();
    const mine = await call("wes", "public.target_reviews('food', $1, true)", [recipe]);
    expect(mine.target).toMatchObject({ kind: "recipe", id: recipe });
    expect(mine.mine).toMatchObject({ rating: 4, audience: "friends" });
    // A stranger never sees a friends-only review; the public average counts public reviews only.
    const stranger = await call("xena", "public.target_reviews('food', $1, true)", [recipe]);
    expect(JSON.stringify(stranger)).not.toContain("more lemon");
    expect(stranger.summary.count).toBe(0);
    await call("wes", "public.delete_review($1)", [mine.mine.reviewId]);
  });

  it("text is stored as plain text with control characters removed", async () => {
    const r = await call("sam", "public.save_review('venue', $1, 3, $2, null, null, true)", [IDS.venueDavis, "  <script>alert(1)</script>\u0007 hi\u0000  ".replace("\u0000", "")]);
    const row = await pool.query("select body from public.reviews where id = $1", [r.reviewId]);
    expect(row.rows[0].body).toBe("<script>alert(1)</script> hi");
    expect(await fail("sam", "public.save_review('venue', $1, 3, $2, null, null, true)", [IDS.venueDavis, "x".repeat(2001)])).toMatchObject({ code: "PT422", message: "TEXT_TOO_LONG" });
    await call("sam", "public.delete_review($1)", [r.reviewId]);
  });
});

describe("demo members never count toward real ratings", () => {
  it("a demo member's review is left out unless demo content is switched on", async () => {
    const before = (await pool.query("select app.rating_summary($1, null, false) as s", [IDS.venueCentral])).rows[0].s;
    await pool.query("update public.member_standing set is_demo = true where user_id = $1", [ids.wes]);
    const off = (await pool.query("select app.rating_summary($1, null, false) as s", [IDS.venueCentral])).rows[0].s;
    const on = (await pool.query("select app.rating_summary($1, null, true) as s", [IDS.venueCentral])).rows[0].s;
    expect(off.count).toBe(before.count - 1);
    expect(on.count).toBe(before.count);
    expect((await fail("sam", "public.profile_view($1, 'matches', 'none', '{}', false, false)", [h("wes")])).code).toBe("PT404");
    expect((await call("sam", "public.profile_view($1, 'matches', 'none', '{}', false, true)", [h("wes")])).profile.isDemo).toBe(true);
    await pool.query("update public.member_standing set is_demo = false where user_id = $1", [ids.wes]);
  });
});

describe("feeds, recommendations and the reader's dietary rule", () => {
  beforeAll(async () => {
    // Ana (followed by Wes, friend of Fred) reviews three dishes publicly:
    // bowl = vegan confirmed, mushroom toast = not confirmed vegan, egg noodles = contains egg.
    await review("ana", "food", IDS.mushroomToastItem, 5, "public", "Toast");
    await review("ana", "food", IDS.eggNoodlesItem, 5, "public", "Noodles");
    await review("ana", "food", IDS.papayaSaladItem, 4, "friends", "Salad for friends");
  });

  it("Following shows only public posts from people I follow", async () => {
    const f = await call("wes", "public.social_feed('following', 'matches', 'none', '{}', false, null, 50, true)");
    expect(f.items.length).toBeGreaterThan(0);
    expect(f.items.every((i: J) => i.item.author?.handle === h("ana") || i.item.owner?.handle === h("ana"))).toBe(true);
    expect(f.items.filter((i: J) => i.type === "review").every((i: J) => i.item.audience === "public")).toBe(true);
    expect(JSON.stringify(f)).not.toContain("Salad for friends");
    expect(JSON.stringify(f)).not.toContain("Friends only");
    // Someone who follows nobody gets an empty feed, not other people's posts.
    expect((await call("sam", "public.social_feed('following', 'matches', 'none', '{}', false, null, 50, true)")).items).toEqual([]);
  });

  it("Friends shows friends-only and public posts from accepted friends, and is a different feed", async () => {
    const f = await call("fred", "public.social_feed('friends', 'matches', 'none', '{}', false, null, 50, true)");
    const bodies = f.items.map((i: J) => i.item.body);
    expect(bodies).toContain("Salad for friends");
    expect(bodies).toContain("Toast");
    expect(f.items.every((i: J) => i.type === "review" && i.item.author.handle === h("ana"))).toBe(true);
    // Fred does not follow Ana, so his Following feed is empty; Wes is not a friend, so his Friends feed is empty.
    expect((await call("fred", "public.social_feed('following', 'matches', 'none', '{}', false, null, 50, true)")).items).toEqual([]);
    expect((await call("wes", "public.social_feed('friends', 'matches', 'none', '{}', false, null, 50, true)")).items).toEqual([]);
    expect((await fail("wes", "public.social_feed('everyone', 'matches', 'none', '{}', false, null, 50, true)")).code).toBe("PT422");
    expect((await fail(null, "public.social_feed('following', 'matches', 'none', '{}', false, null, 50, true)")).code).toBe("42501");
  });

  it("a vegan reader sees confirmed matches, unknown only in the opt-in view, and never 'contains'", async () => {
    const matches = await call("wes", "public.social_feed('following', 'matches', $1, $2, $3, null, 50, true)", [...VEGAN]);
    const names = matches.items.filter((i: J) => i.type === "review").map((i: J) => i.item.target.name);
    expect(names).toContain("Demo chickpea power bowl");
    expect(names).not.toContain("Demo mushroom toast");
    expect(names).not.toContain("Demo egg noodle stir-fry");
    expect(matches.needsConfirmationCount).toBe(1);
    const unsure = await call("wes", "public.social_feed('following', 'needs_confirmation', $1, $2, $3, null, 50, true)", [...VEGAN]);
    expect(unsure.items.map((i: J) => i.item.target.name)).toEqual(["Demo mushroom toast"]);
    expect(unsure.items[0].item.target.eligibility.status).toBe("needs_confirmation");
    expect(JSON.stringify([matches, unsure])).not.toContain("Demo egg noodle stir-fry");
    // An explicit ingredient exclusion works the same way without a diet.
    const noEgg = await call("wes", "public.social_feed('following', 'matches', 'none', array['egg'], false, null, 50, true)");
    expect(JSON.stringify(noEgg)).not.toContain("Demo egg noodle stir-fry");
  });

  it("the same rule applies on a profile and in the Friends feed", async () => {
    const p = await call("wes", "public.profile_view($1, 'matches', $2, $3, $4, true)", [h("ana"), ...VEGAN]);
    const names = p.reviews.map((r: J) => r.target.name);
    expect(names).not.toContain("Demo egg noodle stir-fry");
    expect(names).not.toContain("Demo mushroom toast");
    expect(p.needsConfirmationCount).toBe(1);
    const fr = await call("fred", "public.social_feed('friends', 'matches', 'vegetarian', '{}', false, null, 50, true)");
    expect(JSON.stringify(fr)).not.toContain("Salad for friends"); // papaya salad contains fish sauce
  });

  it("recommendations name who rated what, use 4 and 5 only, and follow the dietary rule", async () => {
    const r = await call("wes", "public.social_recommendations('matches', 'none', '{}', false, true)");
    expect(r.followingCount).toBe(1);
    const dish = r.dishes.find((d: J) => d.target.name === "Demo mushroom toast");
    expect(dish.reasons).toEqual([{ person: { handle: h("ana"), displayName: "Ana", isDemo: false }, rating: 5, audience: "public" }]);
    // Wes already reviewed Demo Central Kitchen himself, so it is not recommended back to him.
    expect(r.venues.map((v: J) => v.target.name)).not.toContain("Demo Central Kitchen");
    // Wes follows Ana but is not her friend: her friends-only rating never reaches him.
    expect(JSON.stringify(r)).not.toContain("Demo green papaya salad");
    const vegan = await call("wes", "public.social_recommendations('matches', $1, $2, $3, true)", [...VEGAN]);
    const names = vegan.dishes.map((d: J) => d.target.name);
    expect(names).not.toContain("Demo mushroom toast");
    expect(names).not.toContain("Demo egg noodle stir-fry");
    expect(vegan.needsConfirmationCount).toBe(1);
    const unsure = await call("wes", "public.social_recommendations('needs_confirmation', $1, $2, $3, true)", [...VEGAN]);
    expect(unsure.dishes.map((d: J) => d.target.name)).toEqual(["Demo mushroom toast"]);
    expect(unsure.venues).toEqual([]);
    // Nobody followed, nothing invented.
    expect(await call("sam", "public.social_recommendations('matches', 'none', '{}', false, true)")).toMatchObject({ venues: [], dishes: [], followingCount: 0 });
  });

  it("a friends-only rating recommends only to accepted friends, and stops when the friendship ends", async () => {
    // Owner decision 28 Nov 2026: friends-only reviews count in recommendations shown to the author's friends only.
    const fred = await call("fred", "public.social_recommendations('matches', 'none', '{}', false, true)");
    const salad = fred.dishes.find((d: J) => d.target.name === "Demo green papaya salad");
    expect(salad.reasons).toEqual([{ person: { handle: h("ana"), displayName: "Ana", isDemo: false }, rating: 4, audience: "friends" }]);
    // Fred is a friend but does not follow Ana, so her public ratings are not his recommendations.
    expect(JSON.stringify(fred)).not.toContain("Demo mushroom toast");
    // The reader's dietary rule still applies (the salad contains fish sauce).
    expect(JSON.stringify(await call("fred", "public.social_recommendations('matches', 'vegetarian', '{}', false, true)"))).not.toContain("Demo green papaya salad");
    // Not for anyone else, signed in or not, and never on a public path.
    for (const who of ["wes", "sam", "xena"]) expect(JSON.stringify(await call(who, "public.social_recommendations('matches', 'none', '{}', false, true)"))).not.toContain("Demo green papaya salad");
    expect((await fail(null, "public.social_recommendations('matches', 'none', '{}', false, true)")).code).toBe("42501");
    const summary = await call(null, "public.target_reviews('food', $1, true)", [IDS.papayaSaladItem]);
    expect(JSON.stringify(summary)).not.toContain("Salad for friends");
    expect(summary.summary?.count ?? 0).toBe(0);
    // Ending the friendship removes it at once; restoring it brings it back.
    await call("ana", "public.remove_friend($1)", [h("fred")]);
    expect(JSON.stringify(await call("fred", "public.social_recommendations('matches', 'none', '{}', false, true)"))).not.toContain("Demo green papaya salad");
    await call("fred", "public.request_friend($1, true)", [h("ana")]);
    await call("ana", "public.respond_friend($1, true)", [h("fred")]);
    expect(JSON.stringify(await call("fred", "public.social_recommendations('matches', 'none', '{}', false, true)"))).toContain("Demo green papaya salad");
  });

  it("a low rating is not a recommendation", async () => {
    await review("ana", "venue", IDS.venueAllston, 2, "public");
    const r = await call("wes", "public.social_recommendations('matches', 'none', '{}', false, true)");
    expect(r.venues.map((v: J) => v.target.name)).not.toContain("Demo Allston Dosa Corner");
  });
});

describe("personal ranking", () => {
  it("only reviewed restaurants can be ranked, and the order is private until published", async () => {
    expect((await fail("ana", "public.set_ranking($1)", [[IDS.venueHarvard]])).message).toBe("NOT_REVIEWED");
    expect((await fail("ana", "public.set_ranking($1)", [[IDS.venueCentral, IDS.venueCentral]])).code).toBe("PT422");
    await call("ana", "public.set_ranking($1)", [[IDS.venueDavis, IDS.venueCentral, IDS.venueAllston]]);
    const mine = await call("ana", "public.my_ranking(true)");
    expect(mine.entries.map((e: J) => e.name)).toEqual(["Demo Davis Noodle Bar", "Demo Central Kitchen", "Demo Allston Dosa Corner"]);
    expect(mine.publication).toBeNull();
    expect((await call("wes", "public.profile_view($1, 'matches', 'none', '{}', false, true)", [h("ana")])).ranking).toBeNull();
    expect((await asMember(ids.wes, (c) => c.query("select * from public.ranking_entries"))).rows).toEqual([]);
  });

  it("publishing shares a fixed copy with no star ratings; later private changes do not alter it", async () => {
    expect((await call("ana", "public.publish_ranking()")).state).toBe("visible");
    await call("ana", "public.set_ranking($1)", [[IDS.venueCentral, IDS.venueDavis]]);
    const seen = (await call(null, "public.profile_view($1, 'matches', 'none', '{}', false, true)", [h("ana")])).ranking;
    expect(seen.entries.map((e: J) => e.name)).toEqual(["Demo Davis Noodle Bar", "Demo Central Kitchen", "Demo Allston Dosa Corner"]);
    expect(JSON.stringify(seen)).not.toContain("rating");
    await call("ana", "public.withdraw_ranking()");
    expect((await call(null, "public.profile_view($1, 'matches', 'none', '{}', false, true)", [h("ana")])).ranking).toBeNull();
  });

  it("a new account's ranking waits for approval; deleting a review removes that restaurant from the order", async () => {
    await call("quiet", "public.save_my_profile($1, 'Quiet', null, '{}', true, false, false)", [h("quiet")]);
    await review("quiet", "venue", IDS.venueCentral, 3, "private");
    const second = await review("quiet", "venue", IDS.venueDavis, 3, "private");
    await call("quiet", "public.set_ranking($1)", [[IDS.venueCentral, IDS.venueDavis]]);
    expect((await call("quiet", "public.publish_ranking()")).state).toBe("pending");
    expect((await call("sam", "public.profile_view($1, 'matches', 'none', '{}', false, true)", [h("quiet")])).ranking).toBeNull();
    expect((await call("quiet", "public.my_ranking(true)")).publication.state).toBe("pending");
    await call("quiet", "public.delete_review($1)", [second.reviewId]);
    const order = await call("quiet", "public.my_ranking(true)");
    expect(order.entries.map((e: J) => [e.position, e.name])).toEqual([[1, "Demo Central Kitchen"]]);
    await call("quiet", "public.withdraw_ranking()");
  });
});

describe("lists", () => {
  let listId: string;
  it("a list is private until published and never accepts a member's own food", async () => {
    listId = (await call("ana", "public.save_list(null, 'Weeknight picks', 'Easy dinners')")).listId;
    await call("ana", "public.add_to_list($1, 'food', $2, 'Ask for extra sauce', true)", [listId, IDS.bowl.item]);
    await call("ana", "public.add_to_list($1, 'food', $2, null, true)", [listId, IDS.mushroomToastItem]);
    await call("ana", "public.add_to_list($1, 'food', $2, null, true)", [listId, IDS.eggNoodlesItem]);
    await call("ana", "public.add_to_list($1, 'venue', $2, null, true)", [listId, IDS.venueDavis]);
    expect((await call("ana", "public.add_to_list($1, 'venue', $2, null, true)", [listId, IDS.venueDavis])).added).toBe(false);
    for (const who of ["fred", "wes", null]) expect((await fail(who, "public.list_view($1, 'matches', 'none', '{}', false, true)", [listId])).code).toBe("PT404");
    const own = await asMember(ids.ana, (c) => c.query("select public.create_custom_food('Ana bar', null, 'mass', 100, $1, '[]', null) as r", [JSON.stringify({ protein_g: 10 })]), { commit: true });
    const ownId = own.rows[0].r.foodItemId ?? own.rows[0].r.food_item_id;
    expect((await fail("ana", "public.add_to_list($1, 'food', $2, null, true)", [listId, ownId])).code).toBe("PT404");
    expect((await pgError(pool.query("insert into public.food_list_items (list_id, food_item_id, position) values ($1, $2, 50)", [listId, ownId]))).code).toBe("PT404");
    expect((await fail("wes", "public.add_to_list($1, 'venue', $2, null, true)", [listId, IDS.venueCentral])).code).toBe("PT404");
  });

  it("a published list is readable by anyone, in order, under the reader's dietary rule", async () => {
    expect((await call("ana", "public.publish_list($1)", [listId])).state).toBe("visible");
    const guest = await call(null, "public.list_view($1, 'matches', 'none', '{}', false, true)", [listId]);
    expect(guest.items.map((i: J) => i.target.name)).toEqual(["Demo chickpea power bowl", "Demo mushroom toast", "Demo egg noodle stir-fry", "Demo Davis Noodle Bar"]);
    expect(guest.items[0].note).toBe("Ask for extra sauce");
    const vegan = await call("wes", "public.list_view($1, 'matches', $2, $3, $4, true)", [listId, ...VEGAN]);
    expect(vegan.items.map((i: J) => i.target.name)).toEqual(["Demo chickpea power bowl", "Demo Davis Noodle Bar"]);
    expect(vegan.needsConfirmationCount).toBe(1);
    const unsure = await call("wes", "public.list_view($1, 'needs_confirmation', $2, $3, $4, true)", [listId, ...VEGAN]);
    expect(unsure.items.map((i: J) => i.target.name)).toEqual(["Demo mushroom toast"]);
    expect((await fail("wes", "public.list_view($1, 'manage', 'none', '{}', false, true)", [listId])).code).toBe("PT404");
    expect((await call("ana", "public.list_view($1, 'manage', $2, $3, $4, true)", [listId, ...VEGAN])).items).toHaveLength(4);
  });

  it("items can be reordered and removed by the owner only; unpublishing hides the list again", async () => {
    await call("ana", "public.set_list_items($1, $2, true)", [listId, JSON.stringify([{ kind: "venue", id: IDS.venueDavis }, { kind: "food", id: IDS.bowl.item, note: "Still good" }])]);
    expect((await call(null, "public.list_view($1, 'matches', 'none', '{}', false, true)", [listId])).items.map((i: J) => i.target.name)).toEqual(["Demo Davis Noodle Bar", "Demo chickpea power bowl"]);
    expect((await fail("wes", "public.set_list_items($1, '[]', true)", [listId])).code).toBe("PT404");
    expect((await fail("wes", "public.delete_list($1)", [listId])).code).toBe("PT404");
    await call("ana", "public.unpublish_list($1)", [listId]);
    expect((await fail(null, "public.list_view($1, 'matches', 'none', '{}', false, true)", [listId])).code).toBe("PT404");
    await call("ana", "public.publish_list($1)", [listId]);
  });

  it("only the team can mark a list as an editorial collection, and it is labelled", async () => {
    expect((await fail("ana", "public.set_list_editorial($1, true)", [listId])).code).toBe("PT403");
    await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher')", [ids.ana]);
    expect((await call("ana", "public.set_list_editorial($1, true)", [listId])).isEditorial).toBe(true);
    const shown = await call(null, "public.editorial_collections(true)");
    expect(shown.collections.map((c: J) => [c.title, c.isEditorial])).toContainEqual(["Weeknight picks", true]);
    await call("ana", "public.set_list_editorial($1, false)", [listId]);
    await pool.query("delete from public.role_assignments where user_id = $1", [ids.ana]);
  });

  it("an empty list cannot be published", async () => {
    const empty = (await call("sam", "public.save_list(null, 'Nothing yet', null)")).listId;
    expect((await fail("sam", "public.publish_list($1)", [empty])).message).toBe("EMPTY_LIST");
    expect((await fail("sam", "public.save_list(null, '   ', null)")).message).toBe("TITLE_REQUIRED");
  });
});

describe("blocking", () => {
  it("a block ends following and friendship both ways and hides each person from the other", async () => {
    await call("xena", "public.follow_user($1, true)", [h("ana")]);
    await call("ana", "public.follow_user($1, true)", [h("xena")]);
    await call("xena", "public.request_friend($1, true)", [h("ana")]);
    await call("ana", "public.respond_friend($1, true)", [h("xena")]);
    await review("xena", "venue", IDS.venueDavis, 1, "public", "Xena was here");
    expect((await call("xena", "public.social_feed('friends', 'matches', 'none', '{}', false, null, 50, true)")).items.length).toBeGreaterThan(0);

    await call("ana", "public.block_user($1)", [h("xena")]);
    const rel = await pool.query(
      `select (select count(*) from public.follows where (follower_id = $1 and followed_id = $2) or (follower_id = $2 and followed_id = $1))::int as follows,
              (select count(*) from public.friendships where (requester_id = $1 and recipient_id = $2) or (requester_id = $2 and recipient_id = $1))::int as friendships`,
      [ids.ana, ids.xena],
    );
    expect(rel.rows[0]).toEqual({ follows: 0, friendships: 0 });
    // Each gets the same "not found" as for a profile that does not exist.
    expect(await fail("xena", "public.profile_view($1, 'matches', 'none', '{}', false, true)", [h("ana")])).toMatchObject({ code: "PT404", message: "PROFILE_NOT_FOUND" });
    expect((await fail("ana", "public.profile_view($1, 'matches', 'none', '{}', false, true)", [h("xena")])).code).toBe("PT404");
    expect((await fail("xena", "public.follow_user($1, true)", [h("ana")])).code).toBe("PT404");
    expect((await fail("xena", "public.request_friend($1, true)", [h("ana")])).code).toBe("PT404");
    expect((await call("xena", "public.find_people($1, true)", [h("ana")])).results).toEqual([]);
    // Neither sees the other's reviews, feed items or lists.
    expect(JSON.stringify(await call("xena", "public.target_reviews('venue', $1, true)", [IDS.venueCentral]))).not.toContain(h("ana"));
    expect(JSON.stringify(await call("ana", "public.target_reviews('venue', $1, true)", [IDS.venueDavis]))).not.toContain("Xena was here");
    expect((await call("xena", "public.social_feed('friends', 'matches', 'none', '{}', false, null, 50, true)")).items).toEqual([]);
    expect((await call("xena", "public.social_feed('following', 'matches', 'none', '{}', false, null, 50, true)")).items).toEqual([]);
    const lists = await pool.query("select id from public.food_lists where owner_id = $1 and publication_state = 'visible'", [ids.ana]);
    expect((await fail("xena", "public.list_view($1, 'matches', 'none', '{}', false, true)", [lists.rows[0].id])).code).toBe("PT404");
    // The blocked person cannot see who blocked them; the blocker can undo it.
    expect((await call("xena", "public.my_connections(true)")).blocked).toEqual([]);
    expect((await call("ana", "public.my_connections(true)")).blocked.map((p: J) => p.handle)).toEqual([h("xena")]);
    expect((await asMember(ids.xena, (c) => c.query("select * from public.blocks"))).rows).toEqual([]);
  });

  it("unblocking does not bring the old follow or friendship back", async () => {
    await call("ana", "public.unblock_user($1)", [h("xena")]);
    const seen = await call("xena", "public.profile_view($1, 'matches', 'none', '{}', false, true)", [h("ana")]);
    expect(seen.relationship).toMatchObject({ following: false, friendship: "none" });
  });

  it("ending a friendship immediately removes access to friends-only posts", async () => {
    expect(JSON.stringify(await call("fred", "public.target_reviews('venue', $1, true)", [IDS.venueDavis]))).toContain("Friends only");
    await call("ana", "public.remove_friend($1)", [h("fred")]);
    expect(JSON.stringify(await call("fred", "public.target_reviews('venue', $1, true)", [IDS.venueDavis]))).not.toContain("Friends only");
    expect((await call("fred", "public.social_feed('friends', 'matches', 'none', '{}', false, null, 50, true)")).items).toEqual([]);
    await call("fred", "public.request_friend($1, true)", [h("ana")]);
    await call("ana", "public.respond_friend($1, true)", [h("fred")]);
  });
});

describe("reports and moderation", () => {
  let target: string;
  it("a member can report what they can see, once, and never their own or hidden content", async () => {
    target = (await pool.query("select id from public.reviews where author_id = $1 and venue_id = $2", [ids.sam, IDS.venueCentral])).rows[0].id;
    expect(await call("wes", "public.report_content('review', $1, null, 'spam', 'Looks like an advert', true)", [target])).toEqual({ reported: true });
    await call("wes", "public.report_content('review', $1, null, 'spam', null, true)", [target]);
    await call("fred", "public.report_content('review', $1, null, 'harassment', null, true)", [target]);
    expect((await pool.query("select count(*)::int as n from public.reports where target_id = $1", [target])).rows[0].n).toBe(2);
    expect((await fail("sam", "public.report_content('review', $1, null, 'spam', null, true)", [target])).code).toBe("PT404");
    const hidden = (await pool.query("select id from public.reviews where author_id = $1 and audience = 'friends' limit 1", [ids.ana])).rows[0].id;
    expect((await fail("wes", "public.report_content('review', $1, null, 'spam', null, true)", [hidden])).code).toBe("PT404");
    expect((await fail("wes", "public.report_content('review', $1, null, 'made_up', null, true)", [target])).code).toBe("PT422");
    expect((await fail(null, "public.report_content('review', $1, null, 'spam', null, true)", [target])).code).toBe("42501");
    // A reporter reads only their own reports.
    expect((await asMember(ids.fred, (c) => c.query("select reporter_id from public.reports"))).rows).toEqual([{ reporter_id: ids.fred }]);
    expect((await asMember(ids.sam, (c) => c.query("select * from public.reports"))).rows).toEqual([]);
  });

  it("only a moderator can open the queue or decide; the queue never names the reporter", async () => {
    expect((await fail("wes", "public.moderation_queue()")).code).toBe("PT403");
    expect((await fail("wes", "public.moderate('review', $1, 'remove', 'because')", [target])).code).toBe("PT403");
    expect((await fail(null, "public.moderation_queue()")).code).toBe("42501");
    const q = await call("mod", "public.moderation_queue()");
    const item = q.reports.find((r: J) => r.target?.id === target);
    expect(item).toMatchObject({ reason: "spam", sameTargetCount: 2 });
    expect(item.target).toMatchObject({ type: "review", body: "Changed my mind" });
    expect(JSON.stringify(q)).not.toContain(ids.wes);
    expect(JSON.stringify(q)).not.toContain(h("wes"));
  });

  it("removing needs a reason, hides the post, takes it out of the average and is audited", async () => {
    const before = (await call(null, "public.target_reviews('venue', $1, true)", [IDS.venueCentral])).summary;
    expect((await fail("mod", "public.moderate('review', $1, 'remove', '  ')", [target])).message).toBe("REASON_REQUIRED");
    await call("mod", "public.moderate('review', $1, 'remove', 'Advertising')", [target]);
    const after = await call("wes", "public.target_reviews('venue', $1, true)", [IDS.venueCentral]);
    expect(after.summary.count).toBe(before.count - 1);
    expect(JSON.stringify(after)).not.toContain("Changed my mind");
    expect((await pool.query("select distinct state from public.reports where target_id = $1", [target])).rows).toEqual([{ state: "actioned" }]);
    const audit = await pool.query("select actor_id, action, entity_type, reason from public.audit_events where entity_id = $1", [target]);
    expect(audit.rows).toEqual([{ actor_id: ids.mod, action: "moderation.remove", entity_type: "review", reason: "Advertising" }]);
    expect((await fail("mod", "public.moderate('review', $1, 'remove', 'again')", [target])).code).toBe("PT409");
    // The author sees that it was removed.
    expect((await call("sam", "public.target_reviews('venue', $1, true)", [IDS.venueCentral])).mine.state).toBe("removed");
  });

  it("a removed post that is edited and published again waits for a moderator, even for an approved member", async () => {
    await call("sam", "public.save_review('venue', $1, 4, 'Rewritten politely', null, null, true)", [IDS.venueCentral]);
    expect((await pool.query("select publication_state from public.reviews where id = $1", [target])).rows[0].publication_state).toBe("removed");
    expect((await call("sam", "public.set_review_audience($1, 'public')", [target])).state).toBe("pending");
    expect((await call("sam", "public.set_review_audience($1, 'friends')", [target])).state).toBe("pending");
    await call("sam", "public.set_review_audience($1, 'public')", [target]);
    expect(JSON.stringify(await call("wes", "public.target_reviews('venue', $1, true)", [IDS.venueCentral]))).not.toContain("Rewritten politely");
    await call("mod", "public.moderate('review', $1, 'approve', null)", [target]);
    expect(JSON.stringify(await call("wes", "public.target_reviews('venue', $1, true)", [IDS.venueCentral]))).toContain("Rewritten politely");
  });

  it("a moderator cannot decide on their own content", async () => {
    const own = await review("mod", "venue", IDS.venueCentral, 5, "public");
    expect(own.state).toBe("pending");
    expect(await fail("mod", "public.moderate('review', $1, 'approve', null)", [own.reviewId])).toMatchObject({ code: "PT403", message: "OWN_CONTENT" });
    await call("mod", "public.delete_review($1)", [own.reviewId]);
  });

  it("reports can be dismissed without removing anything", async () => {
    const list = (await pool.query("select id from public.food_lists where owner_id = $1 and publication_state = 'visible'", [ids.ana])).rows[0].id;
    await call("wes", "public.report_content('list', $1, null, 'other', null, true)", [list]);
    const q = await call("mod", "public.moderation_queue()");
    const rep = q.reports.find((r: J) => r.target?.id === list);
    expect(rep.target.title).toBe("Weeknight picks");
    await call("mod", "public.dismiss_reports($1, 'Nothing wrong')", [rep.reportId]);
    expect((await call(null, "public.list_view($1, 'matches', 'none', '{}', false, true)", [list])).title).toBe("Weeknight picks");
    expect((await pool.query("select state from public.reports where target_id = $1", [list])).rows).toEqual([{ state: "dismissed" }]);
  });

  it("hiding a profile hides the person's content everywhere and from the averages; restoring brings it back", async () => {
    await call("wes", "public.report_content('profile', null, $1, 'harassment', null, true)", [h("newbie")]);
    const before = (await call(null, "public.target_reviews('venue', $1, true)", [IDS.venueBackBay])).summary.count;
    await call("mod", "public.moderate('profile', $1, 'remove', 'Abusive profile text')", [ids.newbie]);
    expect((await fail("wes", "public.profile_view($1, 'matches', 'none', '{}', false, true)", [h("newbie")])).code).toBe("PT404");
    const t = await call(null, "public.target_reviews('venue', $1, true)", [IDS.venueBackBay]);
    expect(t.summary.count).toBe(before - 1);
    expect(JSON.stringify(t)).not.toContain(h("newbie"));
    expect((await call("newbie", "public.my_profile()")).profileHidden).toBe(true);
    await call("mod", "public.moderate('profile', $1, 'restore', null)", [ids.newbie]);
    expect((await call(null, "public.target_reviews('venue', $1, true)", [IDS.venueBackBay])).summary.count).toBe(before);
  });

  it("the moderation functions return nothing from anyone's diary, goals, foods, plans or cooking", async () => {
    const q = JSON.stringify(await call("mod", "public.moderation_queue()"));
    for (const word of ["diary", "goal", "nutrient", "snapshot", "cook", "plan", "exclusion"]) expect(q.toLowerCase()).not.toContain(word);
    for (const table of ["diary_entries", "diary_snapshots", "goal_versions", "cook_sessions", "meal_plans", "user_preferences", "ingredient_exclusions"]) {
      expect((await asMember(ids.mod, (c) => c.query(`select * from public.${table}`))).rows, table).toEqual([]);
    }
  });
});

describe("rate limits", () => {
  it("follows, reports, friend requests and publishing are limited per member", async () => {
    const fill = (action: string, n: number) =>
      pool.query("insert into public.social_action_log (user_id, action) select $1, $2 from generate_series(1, $3)", [ids.sam, action, n]);
    await fill("follow", 60);
    expect(await fail("sam", "public.follow_user($1, true)", [h("ana")])).toMatchObject({ code: "PT429", message: "RATE_LIMITED" });
    await fill("report", 10);
    const any = (await pool.query("select id from public.reviews where author_id = $1 and audience = 'public' limit 1", [ids.ana])).rows[0].id;
    expect((await fail("sam", "public.report_content('review', $1, null, 'spam', null, true)", [any])).code).toBe("PT429");
    await fill("friend_request", 20);
    expect((await fail("sam", "public.request_friend($1, true)", [h("xena")])).code).toBe("PT429");
    await fill("publish", 20);
    const mine = (await pool.query("select id from public.reviews where author_id = $1 limit 1", [ids.sam])).rows[0].id;
    expect((await fail("sam", "public.set_review_audience($1, 'public')", [mine])).code).toBe("PT429");
    await fill("search", 30);
    expect((await fail("sam", "public.find_people('someone', true)")).code).toBe("PT429");
    // Making something private again is never blocked by a limit.
    expect((await call("sam", "public.set_review_audience($1, 'private')", [mine])).state).toBe("draft");
    await pool.query("delete from public.social_action_log where user_id = $1", [ids.sam]);
  });
});

describe("data export", () => {
  it("includes the member's own social data and nobody else's", async () => {
    const e = await call("ana", "public.export_my_data()");
    expect(e.social.profile.handle).toBe(h("ana"));
    expect(e.social.reviews.length).toBeGreaterThan(3);
    expect(e.social.lists[0].title).toBe("Weeknight picks");
    expect(e.social.friends).toEqual([h("fred")]);
    expect(e).toHaveProperty("diaryEntries");
    expect(JSON.stringify(e.social)).not.toContain("Xena was here");
  });
});
