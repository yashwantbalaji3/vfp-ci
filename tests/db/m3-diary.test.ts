import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { asMember, createTestUser, deleteTestUsers, pgError, pool } from "../helpers/db";
import { IDS } from "../fixtures/ids";

// M3 read models and writes (T-DIARY, T-GOALS in docs/14): day and week views,
// repeat, undo, quick custom foods, signed-in dietary filter, export.

let userA: string;
let userB: string;
const TZ = "America/New_York";
const TODAY = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  userA = await createTestUser("m3-a");
  userB = await createTestUser("m3-b");
});
afterAll(async () => {
  await deleteTestUsers([userA, userB]);
  await pool.end();
});

const logTofu = async (c: PoolClient, date: string, opts: { slot?: string; context?: string; multiplier?: string; key?: string } = {}) =>
  (
    await c.query(`select public.log_food_entry($1, $2, $3, $4, null, $5, $6, $7, $8) as r`, [
      opts.key ?? randomUUID(),
      IDS.tofu.rev,
      IDS.tofu.portion150g,
      opts.multiplier ?? "1",
      opts.context ?? "home",
      opts.slot ?? "lunch",
      date,
      TZ,
    ])
  ).rows[0].r as { entryId: string; version: number };

const logOwn = async (c: PoolClient, date: string, name: string, nutrients: Record<string, number | null> = {}, opts: { slot?: string; key?: string; multiplier?: string } = {}) =>
  (
    await c.query(`select public.log_new_custom_food($1, $2, null, $3, null, null, $4, 'home', $5, $6, $7) as r`, [
      opts.key ?? randomUUID(),
      name,
      JSON.stringify(nutrients),
      opts.multiplier ?? "1",
      opts.slot ?? "dinner",
      date,
      TZ,
    ])
  ).rows[0].r as { entryId: string; foodItemId: string; replayed: boolean };

const day = async (c: PoolClient, date: string) => (await c.query("select public.diary_day($1) as r", [date])).rows[0].r;
const week = async (c: PoolClient, start: string) => (await c.query("select public.diary_week($1) as r", [start])).rows[0].r;

describe("day view", () => {
  it("an empty day has no entries and no totals (nothing is reported as zero)", async () => {
    await asMember(userA, async (c) => {
      const d = await day(c, "2026-03-02");
      expect(d.entries).toEqual([]);
      expect(d.totals).toEqual({});
      expect(d.status).toBe("unspecified");
      expect(d.proteinTarget).toBeNull();
    });
  });

  it("sums what is known and counts entries with no value separately", async () => {
    await asMember(userA, async (c) => {
      await logTofu(c, "2026-03-02");
      await logOwn(c, "2026-03-02", "Grandma's stew");
      const d = await day(c, "2026-03-02");
      expect(d.entries).toHaveLength(2);
      expect(Number(d.totals.protein_g.known)).toBe(18);
      expect(d.totals.protein_g.unknownEntries).toBe(1);
      expect(d.totals.protein_g.entryCount).toBe(2);
      const stew = d.entries.find((e: { name: string }) => e.name === "Grandma's stew");
      expect(stew.nutrients.protein_g.value).toBeNull();
      expect(stew.nutrients.energy_kcal.value).toBeNull();
    });
  });

  it("a day made only of meals without nutrition has a null known total, not zero", async () => {
    await asMember(userA, async (c) => {
      await logOwn(c, "2026-03-03", "Street food, no label");
      const d = await day(c, "2026-03-03");
      expect(d.totals.protein_g.known).toBeNull();
      expect(d.totals.protein_g.unknownEntries).toBe(1);
    });
  });

  it("shows carbohydrate, fat and fiber only when the member entered them", async () => {
    await asMember(userA, async (c) => {
      await logOwn(c, "2026-03-04", "Protein bar", { protein_g: 20, carb_g: 22, fat_g: 7 }, { multiplier: "2" });
      const d = await day(c, "2026-03-04");
      expect(Number(d.totals.protein_g.known)).toBe(40);
      expect(Number(d.totals.carb_g.known)).toBe(44);
      expect(Number(d.totals.fat_g.known)).toBe(14);
      expect(d.totals.fiber_g.known).toBeNull();
      expect(d.entries[0].nutrients.protein_g.method).toBe("user_entered");
    });
  });

  it("the protein goal shown is the one in force on that day", async () => {
    await asMember(userA, async (c) => {
      await c.query("select public.set_goal('protein_g_per_day', 80, '2026-03-04')");
      expect((await day(c, "2026-03-03")).proteinTarget).toBeNull();
      expect(Number((await day(c, "2026-03-04")).proteinTarget)).toBe(80);
      const goals = (await c.query("select public.my_goals('2026-03-10') as r")).rows[0].r;
      expect(Number(goals.proteinPerDay.target)).toBe(80);
      expect(goals.homeMealsPerWeek).toBeNull();
    });
  });
});

describe("week view", () => {
  it("returns seven days; days with nothing logged are empty, never zero", async () => {
    await asMember(userA, async (c) => {
      await logTofu(c, "2026-03-09", { slot: "lunch" });
      await logTofu(c, "2026-03-09", { slot: "Lunch", multiplier: "2" });
      await logTofu(c, "2026-03-09", { slot: "dinner", context: "restaurant" });
      await logOwn(c, "2026-03-11", "Soup", {}, { slot: "dinner" });
      await c.query("select public.set_goal('protein_g_per_day', 60, '2026-03-10')");
      await c.query("select public.set_goal('cook_sessions_per_week', 4, '2026-03-09')");
      const w = await week(c, "2026-03-09");
      expect(w.days).toHaveLength(7);
      expect(w.days.map((d: { date: string }) => d.date)).toEqual([
        "2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12", "2026-03-13", "2026-03-14", "2026-03-15",
      ]);
      const [mon, tue, wed] = w.days;
      expect(mon.entryCount).toBe(3);
      expect(Number(mon.proteinKnown)).toBe(72);
      expect(mon.homeMeals).toBe(1); // two home entries in the same meal count once
      expect(mon.proteinTarget).toBeNull(); // goal starts the next day
      expect(tue.entryCount).toBe(0);
      expect(tue.proteinKnown).toBeNull();
      expect(Number(tue.proteinTarget)).toBe(60);
      expect(wed.entryCount).toBe(1);
      expect(wed.proteinKnown).toBeNull();
      expect(wed.proteinUnknownEntries).toBe(1);
      expect(wed.homeMeals).toBe(1);
      expect(Number(w.homeMealsTarget)).toBe(4);
    });
  });

  it("a member's marked day status is returned for that member only", async () => {
    await asMember(userA, async (c) => {
      await c.query("insert into public.daily_log_status (owner_id, local_date, status) values ($1, '2026-03-10', 'partial')", [userA]);
      expect((await week(c, "2026-03-09")).days[1].status).toBe("partial");
      const forged = await pgError(
        c.query("insert into public.daily_log_status (owner_id, local_date, status) values ($1, '2026-03-10', 'complete')", [userB]),
      );
      expect(forged.code).toBe("42501");
    });
  });
});

describe("repeat a meal", () => {
  it("creates a separate entry on the new day and leaves the original alone", async () => {
    await asMember(userA, async (c) => {
      const first = await logTofu(c, "2026-04-01", { slot: "breakfast" });
      const r = (await c.query("select public.repeat_diary_entry($1, $2, '2026-04-02', $3) as r", [randomUUID(), first.entryId, TZ])).rows[0].r;
      expect(r.basis).toBe("current");
      expect(r.entryId).not.toBe(first.entryId);
      const d1 = await day(c, "2026-04-01");
      const d2 = await day(c, "2026-04-02");
      expect(d1.entries).toHaveLength(1);
      expect(d2.entries).toHaveLength(1);
      expect(d2.entries[0].mealSlot).toBe("breakfast");
      expect(Number(d2.totals.protein_g.known)).toBe(18);
    });
  });

  it("is idempotent: the same key returns the same entry; a different request with that key is refused", async () => {
    await asMember(userA, async (c) => {
      const first = await logTofu(c, "2026-04-03");
      const key = randomUUID();
      const a = (await c.query("select public.repeat_diary_entry($1, $2, '2026-04-04', $3) as r", [key, first.entryId, TZ])).rows[0].r;
      const b = (await c.query("select public.repeat_diary_entry($1, $2, '2026-04-04', $3) as r", [key, first.entryId, TZ])).rows[0].r;
      expect(b.entryId).toBe(a.entryId);
      expect(b.replayed).toBe(true);
      expect((await day(c, "2026-04-04")).entries).toHaveLength(1);
      await c.query("savepoint s");
      const clash = await pgError(c.query("select public.repeat_diary_entry($1, $2, '2026-04-05', $3)", [key, first.entryId, TZ]));
      expect(clash.code).toBe("PT409");
      await c.query("rollback to savepoint s");
    });
  });

  it("uses the food's updated information when the catalog changed, and keeps the old entry's numbers", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      const member = async () => {
        await c.query("set local role authenticated");
        await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userA, role: "authenticated" })]);
      };
      await member();
      const first = (
        await c.query(`select public.log_food_entry($1, $2, $3, 1, null, 'restaurant', 'lunch', '2026-04-06', $4) as r`, [
          randomUUID(), IDS.bowl.rev, IDS.bowl.portionServing, TZ,
        ])
      ).rows[0].r;
      const label = (await c.query("select label from public.portions where id = $1", [IDS.bowl.portionServing])).rows[0].label;
      await c.query("reset role");
      const rev2 = randomUUID();
      await c.query(
        `insert into public.food_revisions (id, food_item_id, revision_no, name, basis_kind, basis_amount, basis_unit)
         values ($1, $2, 2, 'Demo chickpea power bowl', 'serving', 1, 'serving')`,
        [rev2, IDS.bowl.item],
      );
      await c.query(`insert into public.nutrient_values (revision_id, nutrient_code, value, method, source_record_id) values ($1, 'protein_g', 30, 'published', $2)`, [rev2, IDS.sourceRecord]);
      await c.query(`insert into public.portions (revision_id, label, amount, unit, source_record_id) values ($1, $2, 1, 'serving', $3)`, [rev2, label, IDS.sourceRecord]);
      await c.query("update public.food_revisions set published_at = now() where id = $1", [rev2]);
      await c.query("update public.food_items set current_revision_id = $1 where id = $2", [rev2, IDS.bowl.item]);
      await member();
      const r = (await c.query("select public.repeat_diary_entry($1, $2, '2026-04-07', $3) as r", [randomUUID(), first.entryId, TZ])).rows[0].r;
      expect(r.basis).toBe("updated");
      const before = (await c.query("select public.diary_day('2026-04-06') as r")).rows[0].r;
      const after = (await c.query("select public.diary_day('2026-04-07') as r")).rows[0].r;
      expect(Number(before.totals.protein_g.known)).toBe(24);
      expect(Number(after.totals.protein_g.known)).toBe(30);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });

  it("another member cannot repeat, restore or see the entry", async () => {
    const entry = await asMember(userA, (c) => logTofu(c, "2026-04-08"), { commit: true });
    await asMember(userB, async (c) => {
      await c.query("savepoint s");
      expect((await pgError(c.query("select public.repeat_diary_entry($1, $2, '2026-04-09', $3)", [randomUUID(), entry.entryId, TZ]))).code).toBe("PT404");
      await c.query("rollback to savepoint s");
      expect((await pgError(c.query("select public.restore_diary_entry($1)", [entry.entryId]))).code).toBe("PT404");
      await c.query("rollback to savepoint s");
      expect((await day(c, "2026-04-08")).entries).toEqual([]);
      expect((await week(c, "2026-04-06")).days.every((d: { entryCount: number }) => d.entryCount === 0)).toBe(true);
      expect((await c.query("select public.recent_foods() as r")).rows[0].r).toEqual([]);
      expect((await c.query("select public.export_my_data() as r")).rows[0].r.diaryEntries).toEqual([]);
    });
  });
});

describe("delete and undo", () => {
  it("a deleted entry leaves the totals at once and can be brought back within the window", async () => {
    await asMember(userA, async (c) => {
      const e = await logTofu(c, "2026-05-01");
      await c.query("select public.delete_diary_entry($1, $2)", [e.entryId, 1]);
      expect((await day(c, "2026-05-01")).entries).toEqual([]);
      const back = (await c.query("select public.restore_diary_entry($1) as r", [e.entryId])).rows[0].r;
      expect(back.restored).toBe(true);
      const d = await day(c, "2026-05-01");
      expect(d.entries).toHaveLength(1);
      expect(d.entries[0].version).toBe(3);
    });
  });

  it("after the undo window the entry cannot be restored and is erased by the next delete", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      const member = async () => {
        await c.query("set local role authenticated");
        await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userA, role: "authenticated" })]);
      };
      await member();
      const old = await logTofu(c, "2026-05-02");
      const recent = await logTofu(c, "2026-05-02");
      await c.query("select public.delete_diary_entry($1, 1)", [old.entryId]);
      await c.query("reset role");
      await c.query("update public.diary_entries set deleted_at = now() - interval '16 minutes' where id = $1", [old.entryId]);
      await member();
      await c.query("savepoint s");
      expect((await pgError(c.query("select public.restore_diary_entry($1)", [old.entryId]))).code).toBe("PT409");
      await c.query("rollback to savepoint s");
      await c.query("select public.delete_diary_entry($1, 1)", [recent.entryId]);
      await c.query("reset role");
      const left = await c.query("select id from public.diary_entries where id = any($1::uuid[])", [[old.entryId, recent.entryId]]);
      expect(left.rows.map((r) => r.id)).toEqual([recent.entryId]);
      const snaps = await c.query("select count(*)::int as n from public.diary_snapshots where entry_id = $1", [old.entryId]);
      expect(snaps.rows[0].n).toBe(0);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});

describe("your own foods", () => {
  it("a meal can be recorded with only a name; a double submit creates one food and one entry", async () => {
    await asMember(userA, async (c) => {
      const key = randomUUID();
      const a = await logOwn(c, "2026-05-03", "Potluck plate", {}, { key });
      const b = await logOwn(c, "2026-05-03", "Potluck plate", {}, { key });
      expect(b.entryId).toBe(a.entryId);
      expect(b.replayed).toBe(true);
      const mine = (await c.query("select public.my_custom_foods() as r")).rows[0].r;
      expect(mine.filter((f: { name: string }) => f.name === "Potluck plate")).toHaveLength(1);
      expect(mine[0].proteinG).toBeNull();
      expect((await day(c, "2026-05-03")).entries).toHaveLength(1);
    });
  });

  it("can be logged again through the normal log form data, and only by its owner", async () => {
    const own = await asMember(userA, (c) => logOwn(c, TODAY, "Overnight oats", { protein_g: 15, energy_kcal: 320 }), { commit: true });
    await asMember(userA, async (c) => {
      const f = (await c.query("select public.loggable_food($1) as r", [own.foodItemId])).rows[0].r;
      expect(f.isOwn).toBe(true);
      expect(f.portions).toHaveLength(1);
      expect(Number(f.portions[0].nutrients.protein_g.value)).toBe(15);
      expect(f.portions[0].nutrients.fiber_g.value).toBeNull();
      const recent = (await c.query("select public.recent_foods() as r")).rows[0].r;
      expect(recent.some((x: { name: string }) => x.name === "Overnight oats")).toBe(true);
    });
    await asMember(userB, async (c) => {
      expect((await pgError(c.query("select public.loggable_food($1)", [own.foodItemId]))).code).toBe("PT404");
    });
    await asMember(userB, async (c) => {
      expect((await c.query("select public.my_custom_foods() as r")).rows[0].r).toEqual([]);
    });
  });

  it("rejects an empty name, a negative value and a nonpositive amount", async () => {
    for (const [name, nutrients, multiplier] of [
      ["", {}, "1"],
      ["Bar", { protein_g: -1 }, "1"],
      ["Bar", {}, "0"],
    ] as const) {
      await asMember(userA, async (c) => {
        const err = await pgError(logOwn(c, "2026-05-05", name, nutrients, { multiplier }));
        expect(err.code).toBe("PT422");
      });
    }
  });

  it("the log form shows what each portion of a catalog food contributes", async () => {
    await asMember(userA, async (c) => {
      const f = (await c.query("select public.loggable_food($1, true) as r", [IDS.tofu.item])).rows[0].r;
      expect(f.gramsSupported).toBe(true);
      const p = f.portions.find((x: { id: string }) => x.id === IDS.tofu.portion150g);
      expect(Number(p.nutrients.protein_g.value)).toBe(18);
      // Demo foods stay hidden unless demo content is allowed.
      expect((await pgError(c.query("select public.loggable_food($1, false)", [IDS.tofu.item]))).code).toBe("PT404");
    });
  });
});

describe("signed-in dietary filter", () => {
  it("nothing saved reads as null; saving stores diet and exclusions together and replaces the old set", async () => {
    await asMember(userB, async (c) => {
      expect((await c.query("select public.my_diet() as r")).rows[0].r).toBeNull();
      await c.query("select public.save_my_diet('vegan', array['honey','egg'], true)");
      const one = (await c.query("select public.my_diet() as r")).rows[0].r;
      expect(one).toEqual({ diet: "vegan", includeConditional: true, exclusions: ["egg", "honey"] });
      await c.query("select public.save_my_diet('vegetarian', array['egg'], false)");
      const two = (await c.query("select public.my_diet() as r")).rows[0].r;
      expect(two).toEqual({ diet: "vegetarian", includeConditional: false, exclusions: ["egg"] });
      await c.query("savepoint s");
      expect((await pgError(c.query("select public.save_my_diet('keto', '{}', false)"))).code).toBe("PT422");
      await c.query("rollback to savepoint s");
      expect((await pgError(c.query("select public.save_my_diet('vegan', array['made_up'], false)"))).code).toBe("PT422");
    });
  });
});

describe("export and guests", () => {
  it("exports only the member's own entries, goals and custom foods", async () => {
    await asMember(userA, async (c) => {
      await logTofu(c, "2026-06-01");
      await c.query("select public.set_goal('protein_g_per_day', 70, '2026-06-01')");
      const x = (await c.query("select public.export_my_data() as r")).rows[0].r;
      expect(x.diaryEntries.some((e: { date: string }) => e.date === "2026-06-01")).toBe(true);
      expect(x.goals.some((g: { target: number }) => Number(g.target) === 70)).toBe(true);
      expect(x.customFoods.some((f: { name: string }) => f.name === "Overnight oats")).toBe(true);
      expect(JSON.stringify(x)).not.toContain(userB);
    });
  });

  it("guests can call none of the diary functions", async () => {
    const calls = [
      "select public.diary_day('2026-06-01')",
      "select public.diary_week('2026-06-01')",
      "select public.my_goals('2026-06-01')",
      "select public.recent_foods()",
      "select public.my_custom_foods()",
      "select public.my_diet()",
      "select public.export_my_data()",
      `select public.loggable_food('${IDS.tofu.item}', true)`,
      `select public.restore_diary_entry('${randomUUID()}')`,
    ];
    for (const sql of calls) {
      await asMember(null, async (c) => {
        expect((await pgError(c.query(sql))).code, sql).toBe("42501");
      });
    }
  });
});
