import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { IDS } from "../fixtures/ids";

/**
 * M2 two-user privacy tests through the real Data API: saves (R-D05), corrections
 * (R-D06) and the public catalog functions (R-D01, R-D08). LOCAL stack only.
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const secret = process.env.SUPABASE_SECRET_KEY!;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(url ?? "")) throw new Error("RLS tests run only against the local stack");

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(url, secret, opts);
const guest = createClient(url, publishable, opts);
type Member = { id: string; client: SupabaseClient };
const members: Member[] = [];

async function newMember(label: string): Promise<Member> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const password = `pw-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const client = createClient(url, publishable, opts);
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw signIn.error;
  const m = { id: data.user.id, client };
  members.push(m);
  return m;
}

let A: Member;
let B: Member;
let correctionId: string;
let privateFoodId: string;

beforeAll(async () => {
  A = await newMember("m2-a");
  B = await newMember("m2-b");
  const food = await A.client.from("saves").insert({ owner_id: A.id, food_item_id: IDS.bowl.item });
  if (food.error) throw food.error;
  const venue = await A.client.from("saves").insert({ owner_id: A.id, venue_id: IDS.venueCentral });
  if (venue.error) throw venue.error;
  const corr = await A.client.rpc("submit_correction", {
    p_food_item_id: IDS.bowl.item, p_venue_id: null, p_field: "egg", p_proposed_value: "The dressing has egg in it", p_evidence_note: "Menu on 12 Nov",
  });
  if (corr.error) throw corr.error;
  correctionId = corr.data;
  const custom = await A.client.rpc("create_custom_food", {
    p_name: "A's private shake", p_brand: null, p_basis_kind: "serving", p_basis_amount: 1, p_nutrients: { protein_g: 30 },
  });
  if (custom.error) throw custom.error;
  privateFoodId = custom.data.foodItemId;
});

afterAll(async () => {
  for (const m of members) await admin.auth.admin.deleteUser(m.id);
});

describe("saves are private to their owner", () => {
  it("A sees A's saves, with names, through my_saves", async () => {
    const { data, error } = await A.client.rpc("my_saves", { p_include_demo: true });
    expect(error).toBeNull();
    expect(data.total).toBe(2);
    expect(data.foods.map((f: { name: string }) => f.name)).toEqual(["Demo chickpea power bowl"]);
    expect(data.venues.map((v: { name: string }) => v.name)).toEqual(["Demo Central Kitchen"]);
  });

  it("B and guests see none of A's saves, by table or by function", async () => {
    expect((await B.client.from("saves").select("*")).data).toEqual([]);
    expect((await B.client.from("saves").select("*").eq("owner_id", A.id)).data).toEqual([]);
    expect((await B.client.rpc("my_saves", { p_include_demo: true })).data).toMatchObject({ foods: [], venues: [], total: 0 });
    expect((await guest.from("saves").select("*")).data ?? []).toEqual([]);
    expect((await guest.rpc("my_saves", { p_include_demo: true })).error).not.toBeNull();
  });

  it("B cannot save under A's name, or delete or change A's saves", async () => {
    const forged = await B.client.from("saves").insert({ owner_id: A.id, food_item_id: IDS.paneerItem });
    expect(forged.error).not.toBeNull();
    await B.client.from("saves").delete().eq("owner_id", A.id);
    await B.client.from("saves").update({ owner_id: B.id }).eq("owner_id", A.id);
    expect((await A.client.from("saves").select("id")).data).toHaveLength(2);
  });

  it("B cannot save A's private custom food; the same save twice is refused", async () => {
    expect((await B.client.from("saves").insert({ owner_id: B.id, food_item_id: privateFoodId })).error).not.toBeNull();
    expect((await A.client.from("saves").insert({ owner_id: A.id, food_item_id: IDS.bowl.item })).error?.code).toBe("23505");
  });

  it("without the demo flag, demo saves are counted but not shown", async () => {
    const { data } = await A.client.rpc("my_saves", { p_include_demo: false });
    expect(data).toMatchObject({ foods: [], venues: [], total: 2 });
  });
});

describe("corrections go to a review queue and change nothing public", () => {
  it("the reporter can read their own correction; it starts open", async () => {
    const { data } = await A.client.from("corrections").select("id, state, field, proposed_value").eq("id", correctionId);
    expect(data).toEqual([{ id: correctionId, state: "open", field: "egg", proposed_value: "The dressing has egg in it" }]);
  });

  it("another member and guests cannot read it", async () => {
    expect((await B.client.from("corrections").select("*")).data).toEqual([]);
    expect((await guest.from("corrections").select("*")).data ?? []).toEqual([]);
  });

  it("nobody can insert directly, and guests cannot submit at all", async () => {
    const direct = await A.client.from("corrections").insert({ reporter_id: A.id, food_item_id: IDS.bowl.item, field: "egg", proposed_value: "direct write" });
    expect(direct.error).not.toBeNull();
    const asGuest = await guest.rpc("submit_correction", { p_food_item_id: IDS.bowl.item, p_venue_id: null, p_field: "egg", p_proposed_value: "guest write" });
    expect(asGuest.error).not.toBeNull();
  });

  it("members cannot accept, edit or delete corrections, including their own", async () => {
    await A.client.from("corrections").update({ state: "accepted" }).eq("id", correctionId);
    await B.client.from("corrections").update({ state: "rejected" }).eq("id", correctionId);
    await A.client.from("corrections").delete().eq("id", correctionId);
    const { data } = await admin.from("corrections").select("state, proposed_value").eq("id", correctionId);
    expect(data).toEqual([{ state: "open", proposed_value: "The dressing has egg in it" }]);
  });

  it("the public dish is unchanged by the correction", async () => {
    const { data } = await guest.rpc("search_catalog", { p: { includeDemo: true, q: "chickpea", diet: "vegetarian", exclusions: ["egg"] } });
    const bowl = data.items.filter((i: { name: string }) => i.name === "Demo chickpea power bowl");
    expect(bowl).toHaveLength(1);
    expect(bowl[0].eligibility.status).toBe("eligible");
  });

  it("a correction cannot target a private or unknown item", async () => {
    const priv = await B.client.rpc("submit_correction", { p_food_item_id: privateFoodId, p_venue_id: null, p_field: "name", p_proposed_value: "probing" });
    expect(priv.error?.code).toBe("PT404");
    const none = await B.client.rpc("submit_correction", { p_food_item_id: randomUUID(), p_venue_id: null, p_field: "name", p_proposed_value: "probing" });
    expect(none.error?.code).toBe("PT404");
  });
});

describe("public catalog functions through the Data API", () => {
  it("guests get the strict views: unknown never in matches, contains in neither", async () => {
    const base = { includeDemo: true, kinds: ["dish"], diet: "vegetarian", exclusions: ["egg"], limit: 50 };
    const matches = (await guest.rpc("search_catalog", { p: base })).data;
    const needs = (await guest.rpc("search_catalog", { p: { ...base, view: "needs_confirmation" } })).data;
    const names = (r: { items: { name: string }[] }) => r.items.map((i) => i.name);
    expect(names(matches)).not.toContain("Demo mushroom toast");
    expect(names(needs)).toContain("Demo mushroom toast");
    for (const r of [matches, needs]) {
      expect(names(r)).not.toContain("Demo egg noodles");
      expect(names(r)).not.toContain("Demo tofu bibimbap");
    }
    expect(matches.items.every((i: { eligibility: { status: string } }) => i.eligibility.status === "eligible")).toBe(true);
  });

  it("demo content is absent unless asked for, and private food never appears", async () => {
    expect((await guest.rpc("search_catalog", { p: {} })).data.items).toEqual([]);
    const all = (await B.client.rpc("search_catalog", { p: { includeDemo: true, q: "private shake" } })).data;
    expect(all.items).toEqual([]);
    expect((await B.client.rpc("food_detail", { p_food_item_id: privateFoodId, p_include_demo: true })).error?.code).toBe("PT404");
    expect((await guest.rpc("protein_compare", { p_food_item_ids: [privateFoodId], p_include_demo: true })).data ?? []).toEqual([]);
  });

  it("bad input is refused with a clear code", async () => {
    expect((await guest.rpc("search_catalog", { p: { limit: 500 } })).error?.code).toBe("PT422");
    expect((await guest.rpc("search_catalog", { p: { lat: 42.3 } })).error?.code).toBe("PT422");
    expect((await guest.rpc("protein_compare", { p_food_item_ids: [IDS.bowl.item, IDS.paneerItem, IDS.dalItem, IDS.dosa.item], p_include_demo: true })).error?.code).toBe("PT422");
  });

  it("members cannot read or edit the rate-limit table", async () => {
    // Since R1 (docs/14 PH-01) a guest or member cannot record a hit through the data API at all.
    const args = { p_bucket: `test:${randomUUID()}`, p_limit: 1, p_window_seconds: 60 };
    expect((await guest.rpc("rate_limit_hit", args)).error).not.toBeNull();
    expect((await guest.rpc("rate_limit_hit", { ...args, p_proof: "a-guess-at-the-key-a-guess-at-the-key" })).error?.code).toBe("PT403");
    expect((await A.client.rpc("rate_limit_hit", { ...args, p_proof: "a-guess-at-the-key-a-guess-at-the-key" })).error?.code).toBe("PT403");
    expect((await A.client.from("rate_limit_windows").select("*")).data ?? []).toEqual([]);
    expect((await guest.from("rate_limit_windows").select("*")).data ?? []).toEqual([]);
    await admin.from("rate_limit_windows").delete().like("bucket", "test:%");
  });
});
