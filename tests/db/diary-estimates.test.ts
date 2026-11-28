import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { asMember, createTestUser, deleteTestUsers, pool } from "../helpers/db";
import { IDS } from "../fixtures/ids";

// Diary estimates (migration 20261116000600): a logged estimate keeps its low and high ends in the
// day and week views, and the totals carry the sum at each end. Exact and unknown values are as before.
// Each test runs as the member in a rolled-back transaction.

let member: string;
const TZ = "America/New_York";
let BOWL_PORTION: string; // "1 bowl" of the demo tempeh rice bowl (estimate 24–32 g)
beforeAll(async () => {
  member = await createTestUser("diary-est");
  BOWL_PORTION = (await pool.query("select id from public.portions where revision_id = $1 and label = '1 bowl'", [IDS.tempehBowl.rev])).rows[0].id;
});
afterAll(async () => {
  await deleteTestUsers([member]);
  await pool.end();
});

const log = (c: PoolClient, rev: string, portion: string, multiplier: string, date: string) =>
  c.query("select public.log_food_entry($1, $2, $3, $4, null, 'restaurant', 'lunch', $5, $6) as r", [randomUUID(), rev, portion, multiplier, date, TZ]);
const day = async (c: PoolClient, date: string) => (await c.query("select public.diary_day($1) as r", [date])).rows[0].r;

describe("estimates in the diary", () => {
  it("an estimated dish keeps its range in the entry and in the day's low and high totals", async () => {
    await asMember(member, async (c) => {
      await log(c, IDS.tempehBowl.rev, BOWL_PORTION, "1", "2026-05-04");
      await log(c, IDS.tempehBowl.rev, BOWL_PORTION, "0.5", "2026-05-04");
      await log(c, IDS.tofu.rev, IDS.tofu.portion150g, "1", "2026-05-04");
      const d = await day(c, "2026-05-04");
      // Logged in one transaction, so they share a time: find them by food and amount, not by order.
      type E = { foodItemId: string; quantity: number; nutrients: Record<string, { value: number; method: string; lower: number | null; upper: number | null }> };
      const es = d.entries as E[];
      const bowl = es.find((e) => e.foodItemId === IDS.tempehBowl.item && Number(e.quantity) === 1)!;
      const half = es.find((e) => e.foodItemId === IDS.tempehBowl.item && Number(e.quantity) === 0.5)!;
      const tofu = es.find((e) => e.foodItemId !== IDS.tempehBowl.item)!;
      expect(bowl.nutrients.protein_g).toMatchObject({ method: "estimated", lower: 24, upper: 32 });
      expect(Number(half.nutrients.protein_g.lower)).toBe(12);
      expect(Number(half.nutrients.protein_g.upper)).toBe(16);
      expect(tofu.nutrients.protein_g.method).not.toBe("estimated");
      expect(tofu.nutrients.protein_g.lower).toBeNull();
      const t = d.totals.protein_g;
      const exact = Number(tofu.nutrients.protein_g.value);
      expect(t.estimatedEntries).toBe(2);
      expect(Number(t.low)).toBeCloseTo(24 + 12 + exact, 6);
      expect(Number(t.high)).toBeCloseTo(32 + 16 + exact, 6);
      expect(Number(t.known)).toBeCloseTo(Number(bowl.nutrients.protein_g.value) + Number(half.nutrients.protein_g.value) + exact, 6);
      expect(Number(t.low)).toBeLessThan(Number(t.known));
      expect(Number(t.high)).toBeGreaterThan(Number(t.known));
    });
  });

  it("the week view gives the low end per day; a day without estimates has low equal to known", async () => {
    await asMember(member, async (c) => {
      await log(c, IDS.tempehBowl.rev, BOWL_PORTION, "1", "2026-05-04");
      await log(c, IDS.tofu.rev, IDS.tofu.portion150g, "1", "2026-05-05");
      const w = (await c.query("select public.diary_week('2026-05-04') as r")).rows[0].r;
      const [mon, tue, wed] = w.days;
      expect(Number(mon.proteinLow)).toBe(24);
      expect(Number(mon.proteinKnown)).toBeGreaterThan(24);
      expect(Number(tue.proteinLow)).toBe(Number(tue.proteinKnown));
      expect(wed.proteinLow).toBeNull(); // nothing logged: no value, never zero
      expect(wed.proteinKnown).toBeNull();
    });
  });

  it("unknown stays out of every sum", async () => {
    await asMember(member, async (c) => {
      await c.query("select public.log_new_custom_food($1, 'Mystery soup', null, '{}', null, null, '1', 'home', 'dinner', '2026-05-06', $2)", [randomUUID(), TZ]);
      const t = (await day(c, "2026-05-06")).totals.protein_g;
      expect(t).toMatchObject({ known: null, low: null, high: null, unknownEntries: 1, estimatedEntries: 0 });
    });
  });

  // Migration 20261116000700: the log form and "Logged recently" also carry the estimate's range.
  it("the food to log gives each estimated portion its low and high ends; an exact food has none", async () => {
    await asMember(member, async (c) => {
      const f = (await c.query("select public.loggable_food($1, true) as r", [IDS.tempehBowl.item])).rows[0].r;
      const bowl = f.portions.find((p: { id: string }) => p.id === BOWL_PORTION);
      expect(bowl.nutrients.protein_g).toMatchObject({ method: "estimated", lower: 24, upper: 32 });
      expect(Number(bowl.nutrients.protein_g.value)).toBeGreaterThan(24);
      expect(Number(bowl.nutrients.protein_g.value)).toBeLessThan(32);
      const tofu = (await c.query("select public.loggable_food($1, true) as r", [IDS.tofu.item])).rows[0].r;
      for (const p of tofu.portions) {
        expect(p.nutrients.protein_g.method).not.toBe("estimated");
        expect(p.nutrients.protein_g.lower).toBeNull();
        expect(p.nutrients.protein_g.upper).toBeNull();
      }
    });
  });

  it("'Logged recently' says which protein figures are estimates and gives their range", async () => {
    await asMember(member, async (c) => {
      const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ }); // "Logged recently" covers the last 120 days
      await log(c, IDS.tempehBowl.rev, BOWL_PORTION, "0.5", today);
      await log(c, IDS.tofu.rev, IDS.tofu.portion150g, "1", today);
      const r = (await c.query("select public.recent_foods(12) as r")).rows[0].r as Array<Record<string, unknown>>;
      const bowl = r.find((x) => x.foodItemId === IDS.tempehBowl.item)!;
      const tofu = r.find((x) => x.foodItemId === IDS.tofu.item)!;
      expect(bowl).toMatchObject({ proteinMethod: "estimated", proteinLow: 12, proteinHigh: 16 });
      expect(tofu.proteinMethod).not.toBe("estimated");
      expect(tofu.proteinLow).toBeNull();
      expect(tofu.proteinHigh).toBeNull();
    });
  });
});
