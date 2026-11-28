import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { M4 } from "../fixtures/ids";

/**
 * M4 two-user privacy tests through the real Data API (PostgREST + Auth), the
 * surface any browser can call directly, bypassing our pages (docs/12, docs/14).
 * Member A cooks a recipe, plans another and logs what they ate. Member B, a
 * curator and a guest must see and change none of it. Recipes themselves are
 * public. LOCAL stack only.
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

// Plans must be near the present, so the dates follow the clock: today and the Monday-to-Sunday week around it.
const iso = (d: Date) => d.toISOString().slice(0, 10);
const now = new Date();
const DATE = iso(now);
const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7)));
const WEEK = iso(monday);
const WEEK_END = iso(new Date(monday.getTime() + 6 * 86400000));
const TZ = "America/New_York";
let A: Member;
let B: Member;
let curator: Member;
let finished: string; // A's finished and logged session
let open: string; // A's session still in progress
let planId: string;

const start = (m: Member, recipe: number, extra: Record<string, unknown> = {}) =>
  m.client.rpc("start_cook_session", {
    p_idempotency_key: randomUUID(), p_food_item_id: M4.recipe(recipe), p_servings: 2, p_swaps: {}, p_local_date: DATE, p_timezone: TZ, p_include_demo: true, ...extra,
  });

beforeAll(async () => {
  A = await newMember("m4-rls-a");
  B = await newMember("m4-rls-b");
  curator = await newMember("m4-rls-curator");
  const grant = await admin.from("role_assignments").insert({ user_id: curator.id, role: "curator" });
  if (grant.error) throw grant.error;

  const first = await start(A, M4.scramble);
  if (first.error) throw first.error;
  finished = first.data.sessionId;
  const done = await A.client.rpc("complete_cook_session", { p_session_id: finished, p_local_date: DATE, p_timezone: TZ });
  if (done.error) throw done.error;
  const log = await A.client.rpc("log_cook_session", { p_idempotency_key: randomUUID(), p_session_id: finished, p_servings: 1, p_meal_slot: "breakfast", p_local_date: DATE, p_timezone: TZ });
  if (log.error) throw log.error;

  const second = await start(A, M4.dal);
  if (second.error) throw second.error;
  open = second.data.sessionId;
  const progress = await A.client.rpc("save_cook_progress", { p_session_id: open, p_current_step: 2, p_checked_ingredients: [M4.line(M4.dal, 1)] });
  if (progress.error) throw progress.error;

  const plan = await A.client.rpc("plan_recipe", { p_food_item_id: M4.recipe(M4.chana), p_date: DATE, p_servings: 4, p_meal_slot: "dinner", p_include_demo: true });
  if (plan.error) throw plan.error;
  planId = plan.data.planId;
});

afterAll(async () => {
  for (const m of members) await admin.auth.admin.deleteUser(m.id);
});

describe("the owner sees their own cooking", () => {
  it("A's sessions, plan, week and export contain A's data", async () => {
    const cooking = (await A.client.rpc("my_cooking", { p_today: DATE })).data;
    expect(cooking.inProgress.map((s: { sessionId: string }) => s.sessionId)).toEqual([open]);
    expect((await A.client.rpc("my_cook_session", { p_session_id: open })).data.currentStep).toBe(2);
    expect((await A.client.rpc("my_plan", { p_from: WEEK, p_to: WEEK_END })).data).toHaveLength(1);
    const week = (await A.client.rpc("diary_week", { p_start: WEEK })).data;
    const total = (key: string) => week.days.reduce((n: number, d: Record<string, number>) => n + d[key], 0);
    // Cooked and eaten in the same meal: one home-cooked meal, not two. The open session and the plan count toward nothing.
    expect(total("homeMeals")).toBe(1);
    expect(total("cookSessions")).toBe(1);
    expect(total("plannedCount")).toBe(1);
    const exported = (await A.client.rpc("export_my_data")).data;
    expect(exported.cookSessions).toHaveLength(2);
    expect(exported.mealPlans).toHaveLength(1);
  });
});

for (const who of ["another member", "a curator"] as const) {
  describe(`${who} gets nothing of A's cooking or plans`, () => {
    const other = () => (who === "a curator" ? curator : B).client;

    it("read functions return only their own (empty) data", async () => {
      expect((await other().rpc("my_cooking", { p_today: DATE })).data).toMatchObject({ inProgress: [] });
      expect((await other().rpc("my_plan", { p_from: WEEK, p_to: WEEK_END })).data).toEqual([]);
      const week = (await other().rpc("diary_week", { p_start: WEEK })).data;
      expect(week.days.every((d: Record<string, number>) => d.homeMeals === 0 && d.cookSessions === 0 && d.plannedCount === 0 && d.entryCount === 0)).toBe(true);
      const exported = (await other().rpc("export_my_data")).data;
      expect(exported.cookSessions).toEqual([]);
      expect(exported.mealPlans).toEqual([]);
      expect(JSON.stringify(exported)).not.toContain(finished);
    });

    it("cannot open, move, finish, abandon, decline or log A's sessions (same 'not found' as a missing id)", async () => {
      for (const id of [open, finished, randomUUID()]) {
        const calls: [string, Record<string, unknown>][] = [
          ["my_cook_session", { p_session_id: id }],
          ["save_cook_progress", { p_session_id: id, p_current_step: 5, p_checked_ingredients: [] }],
          ["complete_cook_session", { p_session_id: id, p_local_date: DATE, p_timezone: TZ }],
          ["abandon_cook_session", { p_session_id: id }],
          ["decline_cook_log", { p_session_id: id }],
          ["log_cook_session", { p_idempotency_key: randomUUID(), p_session_id: id, p_servings: 1, p_meal_slot: "dinner", p_local_date: DATE, p_timezone: TZ, p_additional: true }],
        ];
        for (const [fn, args] of calls) {
          const { data, error } = await other().rpc(fn, args);
          expect(error?.code, `${fn} ${id === open ? "open" : id === finished ? "finished" : "missing"}`).toBe("PT404");
          expect(data).toBeNull();
        }
      }
      // A is untouched.
      const mine = (await A.client.rpc("my_cook_session", { p_session_id: open })).data;
      expect(mine).toMatchObject({ currentStep: 2, completedAt: null });
      expect((await A.client.rpc("my_cook_session", { p_session_id: finished })).data.entries).toHaveLength(1);
      expect((await other().rpc("diary_day", { p_date: DATE })).data.entries).toEqual([]);
    });

    it("cannot remove A's plan or attach their own cooking to it", async () => {
      expect((await other().rpc("remove_plan", { p_plan_id: planId })).error?.code).toBe("PT404");
      const attach = await start(who === "a curator" ? curator : B, M4.chana, { p_plan_id: planId });
      expect(attach.error?.code).toBe("PT404");
      expect((await A.client.rpc("my_plan", { p_from: WEEK, p_to: WEEK_END })).data).toHaveLength(1);
    });

    it("direct table reads and writes on A's rows return nothing", async () => {
      expect((await other().from("cook_sessions").select("*").eq("owner_id", A.id)).data).toEqual([]);
      expect((await other().from("meal_plans").select("*").eq("owner_id", A.id)).data).toEqual([]);
      expect((await other().from("diary_entries").select("id").eq("cook_session_id", finished)).data).toEqual([]);
      const forgedSession = await other().from("cook_sessions").insert({ owner_id: A.id, recipe_revision_id: M4.rev(M4.dal), local_date: DATE });
      expect(forgedSession.error).not.toBeNull();
      const edit = await other().from("cook_sessions").update({ current_step: 9 }).eq("id", open).select();
      expect(edit.data ?? []).toEqual([]);
      const forgedPlan = await other().from("meal_plans").insert({ owner_id: A.id, planned_date: DATE, food_revision_id: M4.rev(M4.dal), planned_servings: 1 });
      expect(forgedPlan.error).not.toBeNull();
      const wipe = await other().from("meal_plans").delete().eq("id", planId).select();
      expect(wipe.data ?? []).toEqual([]);
      const wipeSession = await other().from("cook_sessions").delete().eq("id", open).select();
      expect(wipeSession.data ?? []).toEqual([]);
      expect((await A.client.rpc("my_cook_session", { p_session_id: open })).data.currentStep).toBe(2);
    });
  });
}

describe("the owner cannot bypass the rules by writing to the table directly", () => {
  it("a member cannot mark their own session complete or insert one without the function", async () => {
    const edit = await A.client.from("cook_sessions").update({ completed_at: new Date().toISOString() }).eq("id", open).select();
    expect(edit.data ?? []).toEqual([]);
    const insert = await A.client.from("cook_sessions").insert({ owner_id: A.id, recipe_revision_id: M4.rev(M4.dal), local_date: DATE });
    expect(insert.error).not.toBeNull();
    expect((await A.client.rpc("my_cook_session", { p_session_id: open })).data.completedAt).toBeNull();
  });
});

describe("a guest", () => {
  it("can read public recipes but none of the cooking functions or tables", async () => {
    const list = await guest.rpc("recipe_list", { p: { includeDemo: true } });
    expect(list.error).toBeNull();
    expect(list.data.items.length).toBeGreaterThanOrEqual(11);
    const detail = await guest.rpc("recipe_detail", { p_food_item_id: M4.recipe(M4.dal), p_servings: null, p_swaps: {}, p_diet: "none", p_exclusions: [], p_include_conditional: false, p_include_demo: true });
    expect(detail.error).toBeNull();
    // Demo recipes never leak when demo content is off.
    expect((await guest.rpc("recipe_list", { p: {} })).data.items).toEqual([]);

    const calls: [string, Record<string, unknown>][] = [
      ["start_cook_session", { p_idempotency_key: randomUUID(), p_food_item_id: M4.recipe(M4.dal), p_servings: 2, p_swaps: {}, p_local_date: DATE, p_timezone: TZ, p_include_demo: true }],
      ["my_cook_session", { p_session_id: open }],
      ["my_cooking", { p_today: DATE }],
      ["save_cook_progress", { p_session_id: open, p_current_step: 1, p_checked_ingredients: [] }],
      ["complete_cook_session", { p_session_id: open, p_local_date: DATE, p_timezone: TZ }],
      ["abandon_cook_session", { p_session_id: open }],
      ["decline_cook_log", { p_session_id: finished }],
      ["log_cook_session", { p_idempotency_key: randomUUID(), p_session_id: finished, p_servings: 1, p_meal_slot: "dinner", p_local_date: DATE, p_timezone: TZ }],
      ["plan_recipe", { p_food_item_id: M4.recipe(M4.dal), p_date: DATE, p_servings: 2, p_include_demo: true }],
      ["remove_plan", { p_plan_id: planId }],
      ["my_plan", { p_from: WEEK, p_to: WEEK_END }],
    ];
    for (const [fn, args] of calls) {
      const { data, error } = await guest.rpc(fn, args);
      expect(error, fn).not.toBeNull();
      expect(data, fn).toBeNull();
    }
    for (const table of ["cook_sessions", "meal_plans"]) {
      const { data } = await guest.from(table).select("*");
      expect(data ?? [], table).toEqual([]);
    }
  });
});

describe("no duplicate logging through the Data API", () => {
  it("ten identical concurrent logs of one cooking session create exactly one diary entry", async () => {
    const s = await start(B, M4.crispyChickpeas);
    const id = s.data.sessionId;
    await B.client.rpc("complete_cook_session", { p_session_id: id, p_local_date: DATE, p_timezone: TZ });
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => B.client.rpc("log_cook_session", { p_idempotency_key: key, p_session_id: id, p_servings: 1, p_meal_slot: "snack", p_local_date: DATE, p_timezone: TZ })),
    );
    expect(results.every((r) => r.error === null)).toBe(true);
    expect(new Set(results.map((r) => r.data.entryId)).size).toBe(1);
    // Ten different keys without saying "this is an extra helping": exactly zero more entries.
    const more = await Promise.all(
      Array.from({ length: 10 }, () => B.client.rpc("log_cook_session", { p_idempotency_key: randomUUID(), p_session_id: id, p_servings: 1, p_meal_slot: "snack", p_local_date: DATE, p_timezone: TZ })),
    );
    expect(more.every((r) => r.error?.message === "ALREADY_LOGGED")).toBe(true);
    expect((await B.client.rpc("diary_day", { p_date: DATE })).data.entries).toHaveLength(1);
    // Finishing the same session ten times at once still counts one home-cooked meal.
    await Promise.all(Array.from({ length: 10 }, () => B.client.rpc("complete_cook_session", { p_session_id: id, p_local_date: DATE, p_timezone: TZ })));
    const week = (await B.client.rpc("diary_week", { p_start: WEEK })).data;
    expect(week.days.reduce((n: number, d: { homeMeals: number }) => n + d.homeMeals, 0)).toBe(1);
  });
});
