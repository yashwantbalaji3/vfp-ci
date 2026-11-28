import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { IDS } from "../fixtures/ids";

/**
 * MAP-1 through the real Data API (docs/14 T-MAP 13 and 14): what a browser calling the
 * database directly can and cannot reach. LOCAL stack only.
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const secret = process.env.SUPABASE_SECRET_KEY!;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(url ?? "")) throw new Error("RLS tests run only against the local stack");

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(url, secret, opts);
const guest = createClient(url, publishable, opts);
type Member = { id: string; client: SupabaseClient };
const made: string[] = [];
async function newMember(label: string): Promise<Member> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const password = `pw-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  made.push(data.user.id);
  const client = createClient(url, publishable, opts);
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw signIn.error;
  return { id: data.user.id, client };
}

type Place = { id: string; mine: { saved: boolean; lists: { id: string; title: string }[] } | null };
const market = { market: "boston", includeDemo: true };
let A: Member;
let B: Member;

beforeAll(async () => {
  A = await newMember("map-a");
  B = await newMember("map-b");
  const save = await A.client.from("saves").insert({ owner_id: A.id, venue_id: IDS.venueCentral });
  if (save.error) throw save.error;
});
afterAll(async () => {
  for (const id of made) await admin.auth.admin.deleteUser(id);
});

describe("map search through the Data API", () => {
  it("guests can search the public catalog but get no personal layer", async () => {
    const { data, error } = await guest.rpc("search_map", { p: market });
    expect(error).toBeNull();
    expect((data.places as Place[]).length).toBeGreaterThan(0);
    expect((data.places as Place[]).every((p) => p.mine === null)).toBe(true);
  });

  it("a member sees only their own saved places; another member sees none of them", async () => {
    const a = (await A.client.rpc("search_map", { p: market })).data.places as Place[];
    const b = (await B.client.rpc("search_map", { p: market })).data.places as Place[];
    expect(a.find((p) => p.id === IDS.venueCentral)?.mine?.saved).toBe(true);
    expect(b.find((p) => p.id === IDS.venueCentral)?.mine?.saved).toBe(false);
    expect(b.every((p) => p.mine && !p.mine.saved && p.mine.lists.length === 0)).toBe(true);
  });

  it("refuses bad areas with the documented codes", async () => {
    const bad = await guest.rpc("search_map", { p: { ...market, bbox: { west: -75, south: 40, east: -70, north: 43 } } });
    expect(bad.error?.message).toMatch(/INVALID_AREA/);
    const both = await guest.rpc("search_map", { p: { ...market, lat: 42.36, lon: -71.1, radiusM: 805, bbox: { west: -71.2, south: 42.3, east: -71.0, north: 42.4 } } });
    expect(both.error?.message).toMatch(/INVALID_AREA/);
  });

  it("area names are readable through map_areas only; the table itself is closed", async () => {
    const { data, error } = await guest.rpc("map_areas", { p_market: "boston" });
    expect(error).toBeNull();
    expect((data as { approximate: boolean }[]).every((a) => a.approximate)).toBe(true);
    for (const client of [guest, A.client]) {
      const read = await client.from("geo_areas").select("*");
      expect(read.data ?? []).toEqual([]);
      expect((await client.from("geo_areas").insert({ slug: "x", market_slug: "boston", kind: "zip", name: "x" })).error).not.toBeNull();
    }
  });

  // (That no position is written to any table is checked by a full table scan in tests/db/map1-search.test.ts.)
  it("the internal helpers cannot be called directly", async () => {
    for (const [fn, args] of [
      ["eligibility_many", { p_revision_ids: [IDS.bowl.rev], p_diet: "vegan", p_exclusions: [] }],
      ["catalog_candidates", { p: market }],
      ["followed_picks", { p_uid: A.id, p_include_demo: true }],
    ] as const) {
      const res = await A.client.rpc(fn, args);
      expect(res.error, fn).not.toBeNull();
    }
  });
});
