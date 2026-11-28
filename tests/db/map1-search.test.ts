import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { asMember, createTestUser, deleteTestUsers, pgError, pool } from "../helpers/db";
import { IDS } from "../fixtures/ids";

// MAP-1 (APPROVALS A-MAP-1): the map and the list must give the same catalog answer for
// the same filters and area, across dietary filters and confirmed, unknown and excluded
// ingredient states; a pin never stands for a dish whose dietary evidence is unknown or
// contradictory; a member's own layers are theirs alone; a position is never stored.

type Place = { id: string; dishes: { foodItemId: string; eligibility: { status: string } }[]; mine: unknown };
type MapResult = {
  places: Place[];
  truncated: boolean;
  counts: Record<string, number>;
  applied: Record<string, unknown>;
};

let member: string;
let other: string;
let friend: string;
beforeAll(async () => {
  member = await createTestUser("map-member");
  other = await createTestUser("map-other");
  friend = await createTestUser("map-friend");
});
afterAll(async () => {
  await deleteTestUsers([member, other, friend]);
  await pool.end();
});

const BASE = { market: "boston", includeDemo: true };
const DIETS: { diet?: string; exclusions?: string[] }[] = [
  {},
  { diet: "vegan" },
  { diet: "vegetarian" },
  { diet: "vegetarian", exclusions: ["egg"] },
  { diet: "vegetarian", exclusions: ["dairy"] },
  { diet: "vegan", exclusions: ["egg", "dairy", "honey"] },
];
const AREAS: Record<string, unknown>[] = [
  {},
  { lat: 42.3655, lon: -71.104, radiusM: 805 },
  { lat: 42.3655, lon: -71.104, radiusM: 4828 },
  { bbox: { west: -71.13, south: 42.36, east: -71.1, north: 42.38 } },
  { bbox: { west: -71.2, south: 42.3, east: -71.0, north: 42.45 } },
];

async function listDishes(c: PoolClient, p: object): Promise<{ ids: string[]; counts: Record<string, number> }> {
  const ids: string[] = [];
  let offset = 0;
  let counts: Record<string, number> = {};
  for (;;) {
    const { rows } = await c.query("select public.search_catalog($1) as r", [JSON.stringify({ ...p, kinds: ["dish"], limit: 50, offset })]);
    const r = rows[0].r;
    counts = r.counts;
    ids.push(...r.items.map((i: { foodItemId: string }) => i.foodItemId));
    if (r.nextOffset === null) break;
    offset = r.nextOffset;
  }
  return { ids: ids.sort(), counts };
}

async function mapSearch(c: PoolClient, p: object): Promise<MapResult> {
  const { rows } = await c.query("select public.search_map($1) as r", [JSON.stringify(p)]);
  return rows[0].r;
}

const mapDishIds = (m: MapResult) => m.places.flatMap((p) => p.dishes.map((d) => d.foodItemId)).sort();

describe("map and list give the same answer (R-MAP-01, R-MAP-06; T-MAP 1, 2)", () => {
  it("for every dietary filter, both views and five areas (whole market, two circles, two rectangles)", async () => {
    await asMember(null, async (c) => {
      let compared = 0;
      for (const diet of DIETS) {
        for (const area of AREAS) {
          for (const view of ["matches", "needs_confirmation"]) {
            const p = { ...BASE, ...diet, ...area, view };
            const list = await listDishes(c, p);
            const map = await mapSearch(c, p);
            const label = JSON.stringify(p);
            expect(mapDishIds(map), label).toEqual(list.ids);
            expect(map.counts.dishesMatches, label).toBe(list.counts.matches);
            expect(map.counts.dishesNeedsConfirmation, label).toBe(list.counts.needsConfirmation);
            expect(map.counts.hidden, label).toBe(list.counts.hidden);
            compared++;
          }
        }
      }
      expect(compared).toBe(DIETS.length * AREAS.length * 2);
    });
  });

  it("a pin in the matches view never stands for an unknown or excluded dish; those live only in their own group", async () => {
    await asMember(null, async (c) => {
      const p = { ...BASE, diet: "vegetarian", exclusions: ["egg"] };
      const matches = await mapSearch(c, { ...p, view: "matches" });
      const needs = await mapSearch(c, { ...p, view: "needs_confirmation" });
      const statuses = matches.places.flatMap((pl) => pl.dishes.map((d) => d.eligibility.status));
      expect(statuses.length).toBeGreaterThan(0);
      expect(statuses.every((s) => s === "eligible" || s === "conditional")).toBe(true);
      expect(needs.places.flatMap((pl) => pl.dishes.map((d) => d.eligibility.status)).every((s) => s === "needs_confirmation")).toBe(true);
      const all = [...mapDishIds(matches), ...mapDishIds(needs)];
      // Egg noodles contain egg: never on any map, in any group. The burger's binder is unknown: only "needs confirmation".
      const eggNoodlesItem = (await c.query("select food_item_id from public.food_revisions where id = $1", [IDS.eggNoodles.rev])).rows[0]?.food_item_id;
      const burgerItem = (await c.query("select food_item_id from public.food_revisions where id = $1", [IDS.veggieBurger.rev])).rows[0]?.food_item_id;
      if (eggNoodlesItem) expect(all).not.toContain(eggNoodlesItem);
      if (burgerItem) {
        expect(mapDishIds(matches)).not.toContain(burgerItem);
      }
      expect(matches.counts.hidden).toBeGreaterThan(0);
    });
  });

  it("a disputed claim and a 'needs review' flag move a dish off the matches map at once", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica");
      const before = await mapSearch(c, { ...BASE, diet: "vegetarian", view: "matches" });
      const [first] = before.places[0].dishes;
      const rev = (await c.query("select current_revision_id from public.food_items where id = $1", [first.foodItemId])).rows[0].current_revision_id;
      await c.query("update public.dietary_claims set conflict_state = 'disputed' where revision_id = $1", [rev]);
      const after = await mapSearch(c, { ...BASE, diet: "vegetarian", view: "matches" });
      expect(mapDishIds(after)).not.toContain(first.foodItemId);
      const needs = await mapSearch(c, { ...BASE, diet: "vegetarian", view: "needs_confirmation" });
      expect(mapDishIds(needs)).toContain(first.foodItemId);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});

describe("map search input and limits (T-MAP 6, 15 database part)", () => {
  it("refuses a bad area, a point with a rectangle, other kinds of food and too many places", async () => {
    const bad: object[] = [
      { bbox: { west: -71.0, south: 42.3, east: -71.1, north: 42.4 } },
      { bbox: { west: -74, south: 42.3, east: -71, north: 42.4 } },
      { bbox: "everywhere" },
      { bbox: { west: -71.1, south: 42.3, east: -71.0, north: 42.4 }, lat: 42.36, lon: -71.05 },
      { lat: 42.36 },
      { lat: 42.36, lon: -71.05, radiusM: 60000 },
    ];
    for (const p of bad) {
      const e = await pgError(asMember(null, (c) => mapSearch(c, { ...BASE, ...p })));
      expect(e.message, JSON.stringify(p)).toMatch(/^INVALID_(AREA|LOCATION)$/);
    }
    expect((await pgError(asMember(null, (c) => mapSearch(c, { ...BASE, kinds: ["recipe"] })))).message).toBe("INVALID_KIND");
    expect((await pgError(asMember(null, (c) => mapSearch(c, { ...BASE, limitPlaces: 500 })))).message).toBe("INVALID_LIMIT");
    expect((await pgError(asMember(null, (c) => mapSearch(c, { ...BASE, view: "everything" })))).message).toBe("INVALID_VIEW");
  });

  it("says when there are more places than it returns", async () => {
    await asMember(null, async (c) => {
      const m = await mapSearch(c, { ...BASE, limitPlaces: 2 });
      expect(m.places).toHaveLength(2);
      expect(m.truncated).toBe(true);
      expect(m.counts.places).toBeGreaterThan(2);
    });
  });

  it("demo places stay off a map that does not ask for demo content (R-MAP-13)", async () => {
    await asMember(null, async (c) => {
      const m = await mapSearch(c, { market: "boston" });
      expect(m.places).toEqual([]);
    });
  });
});

describe("a member's own layers (R-MAP-10; T-MAP 9, 10)", () => {
  it("saved places and lists are the member's own; guests get nothing; friends' picks follow the M5 rules", async () => {
    const venue = "00000000-0000-4000-8000-00000000c001";
    await pool.query("insert into public.saves (owner_id, venue_id) values ($1, $2)", [member, venue]);
    const list = await pool.query(
      "insert into public.food_lists (owner_id, title, visibility) values ($1, 'Map test list', 'private') returning id",
      [member],
    );
    await pool.query("insert into public.food_list_items (list_id, venue_id, position) values ($1, $2, 1)", [list.rows[0].id, venue]);
    // A followed person with an approved public 5-star review of the same place.
    await pool.query("insert into public.profiles_public (user_id, handle, display_name) values ($1, $2, 'Map friend')", [friend, `mapfriend_${friend.slice(0, 6)}`]);
    await pool.query("insert into public.member_standing (user_id, first_public_approved_at) values ($1, now()) on conflict (user_id) do update set first_public_approved_at = now()", [friend]);
    await pool.query(
      "insert into public.reviews (author_id, venue_id, rating, body, audience, publication_state, published_at) values ($1, $2, 5, 'Map test review', 'public', 'visible', now())",
      [friend, venue],
    );
    await pool.query("insert into public.follows (follower_id, followed_id) values ($1, $2)", [member, friend]);

    const mine = await asMember(member, async (c) => (await mapSearch(c, BASE)).places.find((p) => p.id === venue));
    expect(mine?.mine).toMatchObject({ saved: true, lists: [{ title: "Map test list" }] });
    const picks = (mine?.mine as { recommendedBy: { person: { handle: string }; rating: number }[] }).recommendedBy;
    expect(picks).toEqual([{ person: expect.objectContaining({ handle: `mapfriend_${friend.slice(0, 6)}` }), rating: 5, audience: "public" }]);
    // Same answer as the friends' recommendations screen.
    const social = await asMember(member, async (c) =>
      (await c.query("select public.social_recommendations('matches', 'none', '{}', false, true) as r")).rows[0].r,
    );
    expect(social.venues.map((v: { target: { id: string } }) => v.target.id)).toContain(venue);

    const theirs = await asMember(other, async (c) => (await mapSearch(c, BASE)).places.find((p) => p.id === venue));
    expect(theirs?.mine).toEqual({ saved: false, lists: [], recommendedBy: null });
    const guest = await asMember(null, async (c) => (await mapSearch(c, BASE)).places.find((p) => p.id === venue));
    expect(guest?.mine).toBeNull();
  });
});

describe("approximate place centres (M-4) and location privacy", () => {
  it("lists Boston-area neighbourhoods, cities and ZIP codes, all marked approximate; the table itself is closed", async () => {
    const areas = await asMember(null, async (c) => (await c.query("select public.map_areas('boston') as r")).rows[0].r);
    expect(areas.length).toBeGreaterThanOrEqual(60);
    expect(areas.every((a: { approximate: boolean }) => a.approximate)).toBe(true);
    expect(areas.map((a: { name: string }) => a.name)).toEqual(expect.arrayContaining(["Allston", "Boston", "02134", "Davis Square"]));
    expect((await pgError(asMember(null, (c) => c.query("select * from public.geo_areas")))).code).toBe("42501");
    expect((await pgError(asMember(member, (c) => c.query("select * from public.geo_areas")))).code).toBe("42501");
  });

  it("a searched position is written nowhere in the database", async () => {
    const lat = 42.35217;
    const lon = -71.06483;
    await asMember(member, (c) => mapSearch(c, { ...BASE, lat, lon, radiusM: 805, diet: "vegan" }), { commit: true });
    await asMember(null, (c) => mapSearch(c, { ...BASE, lat, lon, radiusM: 805 }), { commit: true });
    // Every table in the application schemas, read as text, must not contain the position.
    const { rows: tables } = await pool.query(
      `select format('%I.%I', n.nspname, c.relname) as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'r' and n.nspname in ('public', 'app', 'auth')`,
    );
    const hits: string[] = [];
    for (const { t } of tables) {
      const { rows } = await pool.query(`select count(*)::int as n from ${t} x where x::text like '%42.352%' or x::text like '%71.0648%'`);
      if (rows[0].n > 0) hits.push(t);
    }
    expect(hits).toEqual([]);
  });
});
