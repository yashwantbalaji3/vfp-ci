import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { IDS } from "../fixtures/ids";

/**
 * R2 access tests through the real Data API (PostgREST + Auth), the surface any
 * browser can call directly, bypassing our pages (docs/14 PH-02 test 7).
 *
 * A GUEST, a MEMBER, a CURATOR, a PUBLISHER and a MODERATOR each try the editor
 * and moderator tables and functions. Everything a test creates is removed again.
 * LOCAL stack only.
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const secret = process.env.SUPABASE_SECRET_KEY!;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(url ?? "")) throw new Error("RLS tests run only against the local stack");

const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
const guest = createClient(url, publishable, { auth: { persistSession: false, autoRefreshToken: false } });
type Member = { id: string; client: SupabaseClient; handle: string };
const created: string[] = [];
const madeFoods: string[] = [];

async function newMember(label: string, roles: string[] = []): Promise<Member> {
  const email = `r2-${label}-${randomUUID().slice(0, 8)}@example.test`;
  const password = `pw-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const client = createClient(url, publishable, { auth: { persistSession: false, autoRefreshToken: false } });
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw signIn.error;
  const handle = `${label}_${data.user.id.slice(0, 8)}`;
  const saved = await client.rpc("save_my_profile", { p_handle: handle, p_display_name: label, p_bio: null, p_taste_tags: [], p_discoverable: true, p_show_tastes: false, p_show_diet: false });
  if (saved.error) throw saved.error;
  for (const role of roles) {
    const r = await admin.from("role_assignments").insert({ user_id: data.user.id, role });
    if (r.error) throw r.error;
  }
  created.push(data.user.id);
  return { id: data.user.id, client, handle };
}
const ok = async <T>(p: PromiseLike<{ data: T; error: { message: string; code?: string } | null }>): Promise<T> => {
  const { data, error } = await p;
  if (error) throw new Error(`${error.code}: ${error.message}`);
  return data;
};

let member: Member, curator: Member, publisher: Member, moderator: Member;
let changeId = "";
const SOURCE = { publisher: "The cook (invented for a test)", sourceType: "operator_statement", observedOn: new Date().toISOString().slice(0, 10), summary: "Invented statement." };

beforeAll(async () => {
  [member, curator, publisher, moderator] = await Promise.all([
    newMember("member"),
    newMember("curator", ["curator"]),
    newMember("publisher", ["publisher"]),
    newMember("moderator", ["moderator"]),
  ]);
  const made = await ok(curator.client.rpc("editor_new_food", { p: { kind: "dish", name: `R2 access test dish ${randomUUID().slice(0, 6)}`, venueId: IDS.venueCentral } }));
  changeId = made.changeId;
  await ok(curator.client.rpc("editor_save_change", { p_change_id: changeId, p_patch: { summary: "R2 access test", source: SOURCE, dietary: [{ diet: "vegetarian", outcome: "compatible" }] } }));
  await ok(curator.client.rpc("editor_submit_change", { p_change_id: changeId }));
  const row = await ok(admin.from("catalog_changes").select("food_item_id").eq("id", changeId).single());
  madeFoods.push(row!.food_item_id);
}, 60_000);

afterAll(async () => {
  if (madeFoods.length) await admin.from("food_items").delete().in("id", madeFoods);
  await admin.from("catalog_changes").delete().eq("id", changeId);
  for (const id of created) await admin.auth.admin.deleteUser(id);
});

describe("editor and moderator tables are closed to the Data API", () => {
  it.each(["catalog_changes", "review_flags"])("%s: nobody can read or write it directly, not even staff", async (table) => {
    for (const [who, client] of [["guest", guest], ["member", member.client], ["curator", curator.client], ["publisher", publisher.client], ["moderator", moderator.client]] as const) {
      const read = await client.from(table).select("*");
      expect(read.error, `${who} read ${table}`).not.toBeNull();
      expect(read.data).toBeNull();
      const write = await client.from(table).insert({ kind: "food" });
      expect(write.error, `${who} insert ${table}`).not.toBeNull();
      const del = await client.from(table).delete().neq("id", randomUUID());
      expect(del.error, `${who} delete ${table}`).not.toBeNull();
    }
  });

  it("a member cannot give themselves a role or lift a suspension", async () => {
    for (const client of [member.client, curator.client]) {
      const r = await client.from("role_assignments").insert({ user_id: member.id, role: "publisher" });
      expect(r.error).not.toBeNull();
      // Nor write their own standing (approval, suspension) in any direction.
      await client.from("member_standing").upsert({ user_id: member.id, first_public_approved_at: new Date().toISOString(), suspended_at: null });
    }
    const standing = await ok(admin.from("member_standing").select("first_public_approved_at").eq("user_id", member.id));
    expect((standing ?? []).filter((r) => r.first_public_approved_at !== null)).toEqual([]);
    const roles = await ok(admin.from("role_assignments").select("role").eq("user_id", member.id));
    expect(roles).toEqual([]);
  });
});

describe("catalog tables cannot be written directly, even by staff (R2 fix-up)", () => {
  // Every catalog edit goes through the checked functions, so one person alone cannot
  // change a published place, dish, price, source or correction behind the second person's back.
  const writes: [string, (c: SupabaseClient) => PromiseLike<{ error: unknown }>][] = [
    ["venue_facts insert", (c) => c.from("venue_facts").insert({ venue_id: IDS.venueCentral, field: "hours", typed_value: { text: "x" }, source_record_id: IDS.sourceRecord, checked_at: new Date().toISOString() })],
    ["venue_facts delete", (c) => c.from("venue_facts").delete().eq("venue_id", IDS.venueCentral)],
    ["venues update", (c) => c.from("venues").update({ name: "Intruder" }).eq("id", IDS.venueCentral)],
    ["dishes update", (c) => c.from("dishes").update({ menu_section: "Intruder" }).eq("food_item_id", IDS.dosa.item)],
    ["dish_prices insert", (c) => c.from("dish_prices").insert({ dish_id: IDS.dosa.item, amount_minor: 1, checked_at: new Date().toISOString(), source_record_id: IDS.sourceRecord })],
    ["source_records update", (c) => c.from("source_records").update({ rights_status: "cleared" }).eq("id", IDS.sourceRecord)],
    ["sources update", (c) => c.from("sources").update({ publisher: "Intruder" }).neq("id", randomUUID())],
    ["corrections update", (c) => c.from("corrections").update({ state: "accepted" }).neq("id", randomUUID())],
    ["food_revisions insert", (c) => c.from("food_revisions").insert({ food_item_id: IDS.dosa.item, revision_no: 99, name: "Intruder", basis_kind: "serving", basis_amount: 1, basis_unit: "serving" })],
    ["dietary_claims delete", (c) => c.from("dietary_claims").delete().neq("id", randomUUID())],
    ["venue_revisions read", (c) => c.from("venue_revisions").select("*")],
  ];
  it.each(writes)("%s is refused for a curator and a publisher", async (_label, run) => {
    for (const client of [curator.client, publisher.client]) {
      const r = await run(client);
      expect(r.error).not.toBeNull();
    }
  });
  it("the place history is readable by editors only, through the checked function", async () => {
    const h = await ok(curator.client.rpc("venue_history", { p_venue_id: IDS.venueCentral }));
    expect(h).toMatchObject({ current: { name: expect.any(String) }, revisions: expect.any(Array) });
    for (const client of [guest, member.client, moderator.client]) {
      expect((await client.rpc("venue_history", { p_venue_id: IDS.venueCentral })).error).not.toBeNull();
    }
  });
});

describe("editor functions check the role every time", () => {
  const editorCalls: [string, Record<string, unknown>][] = [
    ["editor_desk", {}],
    ["editor_items", { p_query: "tofu" }],
    ["editor_new_food", { p: { kind: "recipe", name: "Intruder" } }],
    ["editor_start_change", { p_food_item_id: IDS.bowl.item, p_correction_id: null }],
    ["editor_start_venue_change", { p_venue_id: IDS.venueCentral, p_correction_id: null }],
    ["editor_flag_needs_review", { p_food_item_id: IDS.bowl.item, p_reason: "Intruder", p_correction_id: null }],
  ];
  it.each(editorCalls)("%s is refused for a guest, a member and a moderator", async (fn, args) => {
    for (const [who, client] of [["guest", guest], ["member", member.client], ["moderator", moderator.client]] as const) {
      const r = await client.rpc(fn, args);
      expect(r.error, `${who} ${fn}`).not.toBeNull();
      expect(r.data).toBeNull();
    }
  });

  it("nobody outside the editors can read, change, submit or decide someone's change", async () => {
    for (const [who, client] of [["guest", guest], ["member", member.client], ["moderator", moderator.client]] as const) {
      for (const [fn, args] of [
        ["editor_change", { p_change_id: changeId }],
        ["editor_save_change", { p_change_id: changeId, p_patch: { summary: "Intruder was here" } }],
        ["editor_withdraw_change", { p_change_id: changeId }],
        ["editor_review_change", { p_change_id: changeId, p_decision: "approve", p_note: null, p_source_checked: true, p_rights_ok: true }],
      ] as const) {
        const r = await client.rpc(fn, args);
        expect(r.error, `${who} ${fn}`).not.toBeNull();
      }
    }
    const row = await ok(admin.from("catalog_changes").select("state, summary").eq("id", changeId).single());
    expect(row).toEqual({ state: "submitted", summary: "R2 access test" });
  });

  it("the person who entered a change cannot approve it, and a curator without the publisher role cannot approve anyone's", async () => {
    const approve = { p_change_id: changeId, p_decision: "approve", p_note: null, p_source_checked: true, p_rights_ok: true };
    const own = await curator.client.rpc("editor_review_change", approve);
    expect(own.error).not.toBeNull();
    // Even holding both roles, the author is refused: a second person is always needed.
    await admin.from("role_assignments").insert({ user_id: curator.id, role: "publisher" });
    const both = await curator.client.rpc("editor_review_change", approve);
    expect(both.error?.message).toBe("SECOND_PERSON_REQUIRED");
    await admin.from("role_assignments").delete().eq("user_id", curator.id).eq("role", "publisher");
    const item = await ok(admin.from("food_items").select("status").eq("id", madeFoods[0]).single());
    expect(item!.status).not.toBe("published");
    // The old direct publish function is closed the same way.
    const rev = await ok(admin.from("catalog_changes").select("draft_revision_id").eq("id", changeId).single());
    const direct = await curator.client.rpc("publish_food_revision", { p_revision_id: rev!.draft_revision_id, p_reason: "skip the check" });
    expect(direct.error).not.toBeNull();
    // The publisher must tick both checks.
    const unticked = await publisher.client.rpc("editor_review_change", { ...approve, p_source_checked: false });
    expect(unticked.error?.message).toBe("CHECKS_REQUIRED");
  });

  it("the unpublished draft is invisible to guests and members through every catalog read", async () => {
    for (const client of [guest, member.client]) {
      const detail = await client.rpc("food_detail", { p_food_item_id: madeFoods[0], p_include_demo: true, p_include_estimates: false });
      expect(detail.error).not.toBeNull();
      const rows = await ok(client.from("food_items").select("id").eq("id", madeFoods[0]));
      expect(rows).toEqual([]);
      const marks = await ok(client.rpc("freshness_marks", { p_food_item_ids: [madeFoods[0]], p_venue_ids: [], p_include_demo: true }));
      expect(marks.foods).toEqual({});
    }
  });
});

describe("moderator functions", () => {
  it("member history and suspension are for moderators only, and a moderator cannot suspend staff", async () => {
    for (const [who, client] of [["guest", guest], ["member", member.client], ["curator", curator.client], ["publisher", publisher.client]] as const) {
      const h = await client.rpc("member_history", { p_handle: member.handle });
      expect(h.error, `${who} member_history`).not.toBeNull();
      const s = await client.rpc("set_member_suspension", { p_handle: member.handle, p_suspend: true, p_reason: "Intruder" });
      expect(s.error, `${who} set_member_suspension`).not.toBeNull();
    }
    const staff = await moderator.client.rpc("set_member_suspension", { p_handle: curator.handle, p_suspend: true, p_reason: "Not allowed" });
    expect(staff.error).not.toBeNull();
    const history = await ok(moderator.client.rpc("member_history", { p_handle: member.handle }));
    expect(history.handle).toBe(member.handle);
    expect(JSON.stringify(history)).not.toMatch(/example\.test|diary|goal/i);
    const standing = await ok(admin.from("member_standing").select("suspended_at").in("user_id", [member.id, curator.id]));
    expect((standing ?? []).every((s) => s.suspended_at === null)).toBe(true);
  });

  it("staff alerts say nothing to a guest or a member, and only each role's own counts to staff", async () => {
    for (const client of [guest, member.client]) {
      const a = await client.rpc("staff_alerts");
      expect(a.error ?? a.data?.isStaff === false ? "closed" : a.data).toBe("closed");
    }
    const c = await ok(curator.client.rpc("staff_alerts"));
    expect(c.isEditor).toBe(true);
    expect(c.isModerator).toBe(false);
    expect(c.openReports ?? null).toBeNull();
    const m = await ok(moderator.client.rpc("staff_alerts"));
    expect(m.isModerator).toBe(true);
    expect(m.awaitingCheck ?? null).toBeNull();
  });
});
