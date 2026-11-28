import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../helpers/db";

// "Download my data" covers everything a member owns (owner decision 5, 26 Nov 2026; migration 20261126000300).
// Each test runs inside ONE rolled-back transaction.

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function tx(fn: (c: PoolClient) => Promise<void>) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("update app.invite_settings set enabled = false");
    await fn(c);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
  }
}
async function user(c: PoolClient) {
  const id = randomUUID();
  await c.query(
    `insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}', '{}', now(), now())`,
    [id, `export-${id.slice(0, 8)}@example.test`],
  );
  return id;
}
async function exportAs(c: PoolClient, uid: string | null): Promise<J> {
  await c.query(`set local role ${uid ? "authenticated" : "anon"}`);
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(uid ? { sub: uid, role: "authenticated" } : { role: "anon" })]);
  try {
    return (await c.query("select public.export_my_data() r")).rows[0].r as J;
  } finally {
    await c.query("reset role");
  }
}

afterAll(async () => {
  await pool.end();
});

describe("download my data", () => {
  it("includes the member's saves, feedback, suggestions, corrections and reports, and nothing of anyone else's", () =>
    tx(async (c) => {
      const a = await user(c);
      const b = await user(c);
      const recipe = (await c.query("select id from public.food_items where kind = 'recipe' and status = 'published' order by id limit 1")).rows[0].id as string;
      for (const [uid, word] of [[a, "A-only"], [b, "B-only"]] as const) {
        await c.query("insert into public.saves (owner_id, food_item_id) values ($1, $2)", [uid, recipe]);
        await c.query("insert into public.beta_feedback (user_id, form, answers) values ($1, 'note', $2)", [uid, JSON.stringify({ text: `note ${word}` })]);
        await c.query("insert into public.corrections (reporter_id, food_item_id, field, proposed_value) values ($1, $2, 'other', $3)", [uid, recipe, `fix ${word}`]);
      }
      await c.query("insert into public.member_agreements (user_id, adult_confirmed_at, legal_version, legal_accepted_at) values ($1, now(), 'v-test', now())", [a]);
      const mine = await exportAs(c, a);
      expect(mine.agreement).toMatchObject({ legalVersion: "v-test" });
      expect(mine.saves).toHaveLength(1);
      expect(mine.saves[0]).toMatchObject({ kind: "recipe" });
      expect(mine.saves[0].name).toEqual(expect.any(String));
      expect(mine.feedback).toEqual([expect.objectContaining({ form: "note", answers: { text: "note A-only" } })]);
      expect(mine.corrections).toEqual([expect.objectContaining({ field: "other", proposedValue: "fix A-only", state: "open" })]);
      expect(mine.suggestions).toEqual([]);
      expect(mine.placeReports).toEqual([]);
      expect(mine.mealPreview).toEqual({ saves: [], reviews: [], listEntries: [], plans: [] });
      // The earlier sections are still there.
      for (const k of ["diaryEntries", "goals", "customFoods", "social"]) expect(mine).toHaveProperty(k);
      expect(JSON.stringify(mine)).not.toContain("B-only");
    }));

  it("is refused to visitors, and the inner export is not callable by members", () =>
    tx(async (c) => {
      const a = await user(c);
      await c.query("savepoint s");
      await c.query("set local role anon");
      await expect(c.query("select public.export_my_data()")).rejects.toThrow(/permission denied/);
      await c.query("rollback to savepoint s");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: a, role: "authenticated" })]);
      await c.query("savepoint s2");
      await expect(c.query("select app.export_with_social()")).rejects.toThrow(/permission denied/);
      await c.query("rollback to savepoint s2");
      await c.query("reset role");
    }));
});
