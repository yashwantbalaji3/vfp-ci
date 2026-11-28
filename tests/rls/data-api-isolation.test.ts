import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { IDS } from "../fixtures/ids";

/**
 * Two-user privacy tests through the real Data API (PostgREST + Auth + Storage),
 * the same surface any browser could call directly (docs/12, docs/14 "Security
 * negatives that block release"). LOCAL stack only.
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const secret = process.env.SUPABASE_SECRET_KEY!;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(url ?? "")) throw new Error("RLS tests run only against the local stack");

const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
const guest = createClient(url, publishable, { auth: { persistSession: false, autoRefreshToken: false } });

type Member = { id: string; client: SupabaseClient };
const members: Member[] = [];

async function newMember(label: string): Promise<Member> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const password = `pw-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const client = createClient(url, publishable, { auth: { persistSession: false, autoRefreshToken: false } });
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw signIn.error;
  const m = { id: data.user.id, client };
  members.push(m);
  return m;
}

let A: Member;
let B: Member;
let curator: Member;
let entryId: string;
let customRevisionId: string;
let customItemId: string;

beforeAll(async () => {
  A = await newMember("rls-a");
  B = await newMember("rls-b");
  curator = await newMember("rls-curator");
  // Role grants happen only through the protected role table (service role here, admin tooling later).
  const grant = await admin.from("role_assignments").insert({ user_id: curator.id, role: "curator" });
  if (grant.error) throw grant.error;

  const log = await A.client.rpc("log_food_entry", {
    p_idempotency_key: randomUUID(),
    p_food_revision_id: IDS.tofu.rev,
    p_portion_id: IDS.tofu.portion150g,
    p_multiplier: 1,
    p_grams: null,
    p_context: "home",
    p_meal_slot: "lunch",
    p_local_date: "2026-11-13",
    p_timezone: "America/New_York",
  });
  if (log.error) throw log.error;
  entryId = log.data.entryId;

  const custom = await A.client.rpc("create_custom_food", {
    p_name: "A's secret smoothie",
    p_brand: null,
    p_basis_kind: "serving",
    p_basis_amount: 1,
    p_nutrients: { protein_g: 30 },
  });
  if (custom.error) throw custom.error;
  customRevisionId = custom.data.revisionId;
  customItemId = custom.data.foodItemId;

  const goal = await A.client.rpc("set_goal", { p_metric: "protein_g_per_day", p_target: 90, p_effective_from: "2026-11-01" });
  if (goal.error) throw goal.error;
  const pref = await A.client.from("user_preferences").insert({ user_id: A.id, diet: "vegetarian" });
  if (pref.error) throw pref.error;
  const excl = await A.client.from("ingredient_exclusions").insert({ owner_id: A.id, ingredient_family: "egg" });
  if (excl.error) throw excl.error;
});

afterAll(async () => {
  for (const m of members) await admin.auth.admin.deleteUser(m.id);
});

describe("owner can use their own private data", () => {
  it("A reads A's diary entry, snapshot, goal, preferences and custom food", async () => {
    expect((await A.client.from("diary_entries").select("id").eq("id", entryId)).data).toHaveLength(1);
    expect((await A.client.from("diary_snapshots").select("id").eq("entry_id", entryId)).data).toHaveLength(1);
    expect((await A.client.from("goal_versions").select("id")).data).toHaveLength(1);
    expect((await A.client.from("user_preferences").select("diet")).data).toEqual([{ diet: "vegetarian" }]);
    expect((await A.client.from("food_revisions").select("name").eq("id", customRevisionId)).data).toEqual([{ name: "A's secret smoothie" }]);
  });
});

describe("another member (B) gets nothing of A's", () => {
  const privateTables = [
    "diary_entries",
    "diary_snapshots",
    "goal_versions",
    "user_preferences",
    "ingredient_exclusions",
    "saves",
    "meal_plans",
    "cook_sessions",
    "daily_log_status",
    "assets",
    "profiles_public",
  ];
  for (const table of privateTables) {
    it(`B sees zero rows in ${table}`, async () => {
      const { data, error } = await B.client.from(table).select("*");
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });
  }

  it("B cannot fetch A's custom food, its revision, nutrients or private source by id", async () => {
    expect((await B.client.from("food_items").select("id").eq("id", customItemId)).data).toEqual([]);
    expect((await B.client.from("food_revisions").select("id").eq("id", customRevisionId)).data).toEqual([]);
    expect((await B.client.from("nutrient_values").select("value").eq("revision_id", customRevisionId)).data).toEqual([]);
    expect((await B.client.from("sources").select("id").eq("owner_id", A.id)).data).toEqual([]);
  });

  it("B cannot edit, delete or read totals of A's entry through the functions (404, no existence leak)", async () => {
    const upd = await B.client.rpc("update_diary_entry", {
      p_entry_id: entryId, p_expected_version: 1, p_portion_id: IDS.tofu.portion150g, p_multiplier: 3, p_grams: null,
    });
    expect(upd.error?.code).toBe("PT404");
    const del = await B.client.rpc("delete_diary_entry", { p_entry_id: entryId, p_expected_version: 1 });
    expect(del.error?.code).toBe("PT404");
    const totals = await B.client.rpc("diary_day_totals", { p_from: "2026-11-13", p_to: "2026-11-13" });
    expect(totals.data).toEqual([]);
  });

  it("B cannot log A's private custom food", async () => {
    const r = await B.client.rpc("log_food_entry", {
      p_idempotency_key: randomUUID(), p_food_revision_id: customRevisionId, p_portion_id: null, p_multiplier: null,
      p_grams: 100, p_context: "home", p_meal_slot: "lunch", p_local_date: "2026-11-13", p_timezone: "America/New_York",
    });
    expect(r.error?.code).toBe("PT404");
  });

  it("B cannot write rows owned by A or forge an owner", async () => {
    const forgedEntry = await B.client.from("diary_entries").insert({
      owner_id: A.id, context: "home", meal_slot: "x", local_date: "2026-11-13", entry_timezone: "America/New_York",
    });
    expect(forgedEntry.error).not.toBeNull();
    const forgedPref = await B.client.from("ingredient_exclusions").insert({ owner_id: A.id, ingredient_family: "dairy" });
    expect(forgedPref.error).not.toBeNull();
    const del = await B.client.from("ingredient_exclusions").delete().eq("owner_id", A.id).select();
    expect(del.data ?? []).toEqual([]);
    const own = await A.client.from("ingredient_exclusions").select("ingredient_family");
    expect(own.data).toEqual([{ ingredient_family: "egg" }]);
  });

  it("B cannot change A's goals", async () => {
    // set_goal always acts on the caller; there is no parameter that names another member.
    await B.client.rpc("set_goal", { p_metric: "protein_g_per_day", p_target: 10, p_effective_from: "2026-11-01" });
    const aGoals = await A.client.from("goal_versions").select("target");
    expect(aGoals.data).toEqual([{ target: 90 }]);
  });
});

describe("guests", () => {
  it("can read the published catalog", async () => {
    const { data } = await guest.from("food_revisions").select("name").eq("id", IDS.tofu.rev);
    expect(data).toEqual([{ name: "Demo firm tofu" }]);
    const venues = await guest.from("venues").select("id").eq("id", IDS.venueCentral);
    expect(venues.data).toHaveLength(1);
  });

  it("see no private data and cannot call member functions", async () => {
    // Since R1 a guest holds no privilege on private tables: the request is refused outright
    // (previously it was allowed and the row rules returned nothing).
    const diary = await guest.from("diary_entries").select("*");
    expect(diary.data ?? []).toEqual([]);
    expect(diary.error?.code).toBe("42501");
    expect((await guest.from("food_revisions").select("id").eq("id", customRevisionId)).data).toEqual([]);
    const r = await guest.rpc("diary_day_totals", { p_from: "2026-11-13", p_to: "2026-11-13" });
    expect(r.error).not.toBeNull();
  });
});

describe("staff roles get no private access", () => {
  it("a curator cannot read diaries, goals or custom foods", async () => {
    expect((await curator.client.from("diary_entries").select("*")).data).toEqual([]);
    expect((await curator.client.from("diary_snapshots").select("*")).data).toEqual([]);
    expect((await curator.client.from("goal_versions").select("*")).data).toEqual([]);
    expect((await curator.client.from("food_revisions").select("id").eq("id", customRevisionId)).data).toEqual([]);
  });
});

describe("protected operational data", () => {
  it("members cannot read idempotency records, the outbox, tombstones or audit events", async () => {
    for (const t of ["idempotency_records", "outbox_jobs", "deletion_tombstones"]) {
      const r = await A.client.from(t).select("*");
      expect(r.error).not.toBeNull();
    }
    expect((await A.client.from("audit_events").select("*")).data).toEqual([]);
  });

  it("members cannot grant themselves roles or call internal helpers", async () => {
    const r = await A.client.from("role_assignments").insert({ user_id: A.id, role: "admin" });
    expect(r.error).not.toBeNull();
    const pub = await A.client.rpc("publish_food_revision", { p_revision_id: IDS.tofu.rev, p_expected_item_version: 1 });
    expect(pub.error?.code).toBe("PT403");
  });
});

describe("private storage", () => {
  it("A's upload is invisible to B and guests; B cannot write into A's folder", async () => {
    const path = `${A.id}/label-${randomUUID()}.png`;
    const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
    const up = await A.client.storage.from("private-uploads").upload(path, png, { contentType: "image/png" });
    expect(up.error).toBeNull();
    expect((await A.client.storage.from("private-uploads").download(path)).error).toBeNull();
    expect((await B.client.storage.from("private-uploads").download(path)).error).not.toBeNull();
    expect((await guest.storage.from("private-uploads").download(path)).error).not.toBeNull();
    const intrude = await B.client.storage.from("private-uploads").upload(`${A.id}/intrude.png`, png, { contentType: "image/png" });
    expect(intrude.error).not.toBeNull();
    const svg = await A.client.storage.from("private-uploads").upload(`${A.id}/x.svg`, Buffer.from("<svg/>"), { contentType: "image/svg+xml" });
    expect(svg.error).not.toBeNull();
  });
});

describe("internal schema is not reachable over the Data API", () => {
  it("a signed-in member cannot call or read anything in the `app` schema", async () => {
    // Live probe (replaces the weaker config-only check): ask PostgREST for the app schema directly.
    const rpc = await A.client.schema("app").rpc("has_role", { p_role: "curator" });
    expect(rpc.error).not.toBeNull();
    expect(rpc.data).toBeNull();
    const table = await guest.schema("app").from("anything").select("*");
    expect(table.error).not.toBeNull();
    // PostgREST reports an unexposed schema as PGRST106 ("Invalid schema").
    expect([rpc.error?.code, table.error?.code]).toEqual(["PGRST106", "PGRST106"]);
  });

  it("operational tables are not readable by members", async () => {
    for (const t of ["idempotency_records", "outbox_jobs", "deletion_tombstones", "audit_events", "role_assignments"]) {
      const { data, error } = await A.client.from(t).select("*").limit(1);
      expect(error !== null || (data ?? []).length === 0, t).toBe(true);
    }
  });
});
