import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { IDS } from "../fixtures/ids";

/**
 * M3 two-user privacy tests through the real Data API (PostgREST + Auth), the
 * surface any browser can call directly, bypassing our pages (docs/12, docs/14).
 * Member A keeps a diary, goals, a day note, a saved dietary filter and a food of
 * their own. Member B, a curator and a guest must get none of it. LOCAL stack only.
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

const DATE = "2026-10-05"; // a Monday
const TZ = "America/New_York";
const SECRET_NAME = "A's private midnight snack";
let A: Member;
let B: Member;
let curator: Member;
let entryId: string;
let customEntryId: string;
let customItemId: string;

beforeAll(async () => {
  A = await newMember("m3-rls-a");
  B = await newMember("m3-rls-b");
  curator = await newMember("m3-rls-curator");
  const grant = await admin.from("role_assignments").insert({ user_id: curator.id, role: "curator" });
  if (grant.error) throw grant.error;

  const log = await A.client.rpc("log_food_entry", {
    p_idempotency_key: randomUUID(), p_food_revision_id: IDS.tofu.rev, p_portion_id: IDS.tofu.portion150g, p_multiplier: 1, p_grams: null,
    p_context: "home", p_meal_slot: "lunch", p_local_date: DATE, p_timezone: TZ,
  });
  if (log.error) throw log.error;
  entryId = log.data.entryId;

  const own = await A.client.rpc("log_new_custom_food", {
    p_idempotency_key: randomUUID(), p_name: SECRET_NAME, p_brand: null, p_nutrients: { protein_g: 31 }, p_serving_label: null, p_serving_grams: null,
    p_multiplier: 1, p_context: "home", p_meal_slot: "snack", p_local_date: DATE, p_timezone: TZ,
  });
  if (own.error) throw own.error;
  customEntryId = own.data.entryId;
  customItemId = own.data.foodItemId;

  for (const call of [
    A.client.rpc("set_goal", { p_metric: "protein_g_per_day", p_target: 77, p_effective_from: DATE }),
    A.client.rpc("set_goal", { p_metric: "cook_sessions_per_week", p_target: 6, p_effective_from: DATE }),
    A.client.rpc("save_my_diet", { p_diet: "vegan", p_exclusions: ["honey"], p_include_conditional: false }),
    A.client.from("daily_log_status").upsert({ owner_id: A.id, local_date: DATE, status: "complete" }),
  ]) {
    const { error } = await call;
    if (error) throw error;
  }
});

afterAll(async () => {
  for (const m of members) await admin.auth.admin.deleteUser(m.id);
});

describe("the owner sees their own diary", () => {
  it("A's day, week, goals, recent foods, own foods, saved filter and export all contain A's data", async () => {
    const day = (await A.client.rpc("diary_day", { p_date: DATE })).data;
    expect(day.entries).toHaveLength(2);
    expect(day.totals.protein_g.known).toBe(49);
    expect(day.proteinTarget).toBe(77);
    expect(day.status).toBe("complete");
    const week = (await A.client.rpc("diary_week", { p_start: DATE })).data;
    expect(week.days[0].entryCount).toBe(2);
    expect(week.days[0].homeMeals).toBe(2);
    expect(week.homeMealsTarget).toBe(6);
    expect((await A.client.rpc("my_goals", { p_date: DATE })).data.proteinPerDay.target).toBe(77);
    expect((await A.client.rpc("my_custom_foods")).data.map((f: { name: string }) => f.name)).toContain(SECRET_NAME);
    expect((await A.client.rpc("my_diet")).data).toEqual({ diet: "vegan", exclusions: ["honey"], includeConditional: false });
    const exported = (await A.client.rpc("export_my_data")).data;
    expect(exported.diaryEntries).toHaveLength(2);
    expect(exported.customFoods).toHaveLength(1);
    expect(exported.goals).toHaveLength(2);
  });
});

for (const who of ["another member", "a curator"] as const) {
  describe(`${who} gets nothing of A's diary, goals or foods`, () => {
    const other = () => (who === "a curator" ? curator : B).client;

    it("read functions return only their own (empty) data", async () => {
      const day = (await other().rpc("diary_day", { p_date: DATE })).data;
      expect(day.entries).toEqual([]);
      expect(day.totals).toEqual({});
      expect(day.proteinTarget).toBeNull();
      expect(day.status).toBe("unspecified");
      const week = (await other().rpc("diary_week", { p_start: DATE })).data;
      expect(week.days.every((d: { entryCount: number; proteinKnown: number | null }) => d.entryCount === 0 && d.proteinKnown === null)).toBe(true);
      expect(week.homeMealsTarget).toBeNull();
      expect((await other().rpc("my_goals", { p_date: DATE })).data).toEqual({ proteinPerDay: null, homeMealsPerWeek: null });
      expect((await other().rpc("recent_foods")).data).toEqual([]);
      expect((await other().rpc("my_custom_foods")).data).toEqual([]);
      expect((await other().rpc("my_diet")).data).toBeNull();
      const exported = (await other().rpc("export_my_data")).data;
      expect(JSON.stringify(exported)).not.toContain(SECRET_NAME);
      expect(exported.diaryEntries).toEqual([]);
      expect(exported.customFoods).toEqual([]);
      expect(exported.goals).toEqual([]);
    });

    it("cannot repeat, edit, delete or restore A's entries (same 'not found' as a missing id)", async () => {
      const repeat = await other().rpc("repeat_diary_entry", { p_idempotency_key: randomUUID(), p_entry_id: entryId, p_local_date: DATE, p_timezone: TZ });
      expect(repeat.error?.code).toBe("PT404");
      const edit = await other().rpc("update_diary_entry", { p_entry_id: entryId, p_expected_version: 1, p_portion_id: IDS.tofu.portion150g, p_multiplier: 5, p_grams: null });
      expect(edit.error?.code).toBe("PT404");
      const del = await other().rpc("delete_diary_entry", { p_entry_id: customEntryId, p_expected_version: 1 });
      expect(del.error?.code).toBe("PT404");
      const restore = await other().rpc("restore_diary_entry", { p_entry_id: entryId });
      expect(restore.error?.code).toBe("PT404");
      // And A's data is untouched.
      const day = (await A.client.rpc("diary_day", { p_date: DATE })).data;
      expect(day.entries).toHaveLength(2);
      expect(day.entries.every((e: { version: number }) => e.version === 1)).toBe(true);
    });

    it("cannot open or log A's own food", async () => {
      expect((await other().rpc("loggable_food", { p_food_item_id: customItemId, p_include_demo: true })).error?.code).toBe("PT404");
      expect((await other().from("food_items").select("id").eq("id", customItemId)).data).toEqual([]);
      expect((await other().from("food_revisions").select("name").eq("food_item_id", customItemId)).data).toEqual([]);
    });

    it("direct table reads and writes on A's rows return nothing", async () => {
      for (const [table, column] of [
        ["diary_entries", "owner_id"],
        ["goal_versions", "owner_id"],
        ["daily_log_status", "owner_id"],
        ["user_preferences", "user_id"],
        ["ingredient_exclusions", "owner_id"],
      ] as const) {
        expect((await other().from(table).select("*").eq(column, A.id)).data, table).toEqual([]);
      }
      expect((await other().from("diary_snapshots").select("id").eq("entry_id", entryId)).data).toEqual([]);
      const forgedNote = await other().from("daily_log_status").upsert({ owner_id: A.id, local_date: DATE, status: "partial" });
      expect(forgedNote.error).not.toBeNull();
      const forgedPref = await other().from("user_preferences").update({ diet: "none" }).eq("user_id", A.id).select();
      expect(forgedPref.data ?? []).toEqual([]);
      const wipe = await other().from("diary_entries").delete().eq("id", entryId).select();
      expect(wipe.data ?? []).toEqual([]);
      expect((await A.client.rpc("my_diet")).data.diet).toBe("vegan");
      expect((await A.client.rpc("diary_day", { p_date: DATE })).data.status).toBe("complete");
    });
  });
}

describe("a guest can use none of it", () => {
  it("every diary and goals function is refused", async () => {
    const calls: [string, Record<string, unknown>][] = [
      ["diary_day", { p_date: DATE }],
      ["diary_week", { p_start: DATE }],
      ["my_goals", { p_date: DATE }],
      ["recent_foods", {}],
      ["my_custom_foods", {}],
      ["my_diet", {}],
      ["save_my_diet", { p_diet: "vegan", p_exclusions: [], p_include_conditional: false }],
      ["export_my_data", {}],
      ["loggable_food", { p_food_item_id: IDS.tofu.item, p_include_demo: true }],
      ["restore_diary_entry", { p_entry_id: entryId }],
      ["repeat_diary_entry", { p_idempotency_key: randomUUID(), p_entry_id: entryId, p_local_date: DATE, p_timezone: TZ }],
      ["log_new_custom_food", { p_idempotency_key: randomUUID(), p_name: "x", p_brand: null, p_nutrients: {}, p_serving_label: null, p_serving_grams: null, p_multiplier: 1, p_context: "home", p_meal_slot: "lunch", p_local_date: DATE, p_timezone: TZ }],
      ["set_goal", { p_metric: "protein_g_per_day", p_target: 50, p_effective_from: DATE }],
    ];
    for (const [fn, args] of calls) {
      const { data, error } = await guest.rpc(fn, args);
      expect(error, fn).not.toBeNull();
      expect(data, fn).toBeNull();
    }
    for (const table of ["diary_entries", "diary_snapshots", "goal_versions", "daily_log_status", "user_preferences", "ingredient_exclusions"]) {
      const { data } = await guest.from(table).select("*");
      expect(data ?? [], table).toEqual([]);
    }
  });
});

describe("idempotent logging through the Data API", () => {
  it("ten identical concurrent submits create exactly one entry", async () => {
    const key = randomUUID();
    const args = {
      p_idempotency_key: key, p_food_revision_id: IDS.tofu.rev, p_portion_id: IDS.tofu.portion150g, p_multiplier: 1, p_grams: null,
      p_context: "home", p_meal_slot: "dinner", p_local_date: "2026-10-06", p_timezone: TZ,
    };
    const results = await Promise.all(Array.from({ length: 10 }, () => B.client.rpc("log_food_entry", args)));
    const ids = new Set(results.filter((r) => !r.error).map((r) => r.data.entryId));
    expect(ids.size).toBe(1);
    expect((await B.client.rpc("diary_day", { p_date: "2026-10-06" })).data.entries).toHaveLength(1);
  });
});
