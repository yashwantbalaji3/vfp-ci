import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { asMember, createTestUser, deleteTestUsers, pgError, pool } from "../helpers/db";
import { demoRelease } from "../../scripts/lib/nie-demo-dishes.mjs";

// Change or remove a food of your own (migration 20261118001000, docs/56). A change is a new revision;
// diary entries already logged keep their snapshot. Removing only takes the food off the list.

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let owner: string;
let other: string;
const TZ = "America/New_York";

beforeAll(async () => {
  owner = await createTestUser("own-a");
  other = await createTestUser("own-b");
});
afterAll(async () => {
  await deleteTestUsers([owner, other]);
  await pool.end();
});

const logOwn = async (c: PoolClient, name: string, nutrients: Record<string, number>, date = "2026-05-04") =>
  (
    await c.query(`select public.log_new_custom_food($1, $2, null, $3, '1 bowl', 300, 1, 'home', 'dinner', $4, $5) as r`, [
      randomUUID(),
      name,
      JSON.stringify(nutrients),
      date,
      TZ,
    ])
  ).rows[0].r as { entryId: string; foodItemId: string };
const detail = async (c: PoolClient, id: string) => (await c.query("select public.my_custom_food($1) as r", [id])).rows[0].r as J;
const change = (c: PoolClient, id: string, rev: string, name: string, nutrients: Record<string, number | null>, label: string | null = "1 bowl", grams: number | null = 300) =>
  c.query("select public.update_custom_food($1, $2, $3, null, $4, $5, $6) as r", [id, rev, name, JSON.stringify(nutrients), label, grams]);
const day = async (c: PoolClient, date: string) => (await c.query("select public.diary_day($1) as r", [date])).rows[0].r as J;
/** A refused call inside a longer transaction: rolled back to a savepoint so the transaction can go on. */
async function refused(c: PoolClient, sql: string, args: unknown[]) {
  await c.query("savepoint s");
  const err = await pgError(c.query(sql, args));
  await c.query("rollback to savepoint s");
  return err.message;
}
const mine = async (c: PoolClient) => (await c.query("select public.my_custom_foods() as r")).rows[0].r as J[];

describe("changing a food of your own", () => {
  it("saves a new version; the entry already logged keeps its numbers, and the next log uses the new ones", async () => {
    await asMember(owner, async (c) => {
      const { foodItemId } = await logOwn(c, "Dal at home", { protein_g: 12, energy_kcal: 300 });
      const before = await detail(c, foodItemId);
      expect(before).toMatchObject({ name: "Dal at home", revisionNo: 1, editable: true, serving: { label: "1 bowl" }, timesLogged: 1 });
      expect(Number(before.nutrients.protein_g)).toBe(12);
      expect(before.nutrients.fat_g).toBeNull();

      await change(c, foodItemId, before.revisionId, "Red lentil dal", { protein_g: 18, energy_kcal: null, fat_g: 9 });
      const after = await detail(c, foodItemId);
      expect(after).toMatchObject({ name: "Red lentil dal", revisionNo: 2 });
      expect(Number(after.nutrients.protein_g)).toBe(18);
      expect(after.nutrients.energy_kcal).toBeNull(); // cleared box: unknown, never zero
      expect(Number(after.nutrients.fat_g)).toBe(9);

      // The earlier entry is unchanged.
      const d = await day(c, "2026-05-04");
      expect(d.entries.map((e: J) => e.name)).toEqual(["Dal at home"]);
      expect(Number(d.totals.protein_g.known)).toBe(12); // as logged

      // A new log uses the new version.
      const log = await c.query(
        `select public.log_food_entry($1, $2, (select id from public.portions where revision_id = $2), 1, null, 'home', 'lunch', '2026-05-05', $3) as r`,
        [randomUUID(), after.revisionId, TZ],
      );
      expect(log.rows[0].r.entryId).toBeTruthy();
      const d2 = await day(c, "2026-05-05");
      expect(d2.entries.map((e: J) => e.name)).toEqual(["Red lentil dal"]);
      expect(Number(d2.totals.protein_g.known)).toBe(18);
      expect((await mine(c)).find((f) => f.foodItemId === foodItemId)?.name).toBe("Red lentil dal");
    });
  });

  it("a change from an out-of-date form is refused", async () => {
    await asMember(owner, async (c) => {
      const { foodItemId } = await logOwn(c, "Toast", { protein_g: 4 });
      const first = await detail(c, foodItemId);
      await change(c, foodItemId, first.revisionId, "Toast with peanut butter", { protein_g: 11 });
      const err = await pgError(change(c, foodItemId, first.revisionId, "Toast again", { protein_g: 5 }));
      expect(err.message).toBe("VERSION_CONFLICT");
    });
  });

  it("bad input is refused", async () => {
    let id = "";
    let rev = "";
    await asMember(
      owner,
      async (c) => {
        id = (await logOwn(c, "Oats", { protein_g: 6 })).foodItemId;
        rev = (await detail(c, id)).revisionId;
      },
      { commit: true },
    );
    for (const [args, code] of [
      [["", { protein_g: 6 }], "INVALID_NAME"],
      [["Oats", { protein_g: -1 }], "INVALID_NUTRIENT_VALUE"],
      [["Oats", { sodium_mg: 5 }], "UNKNOWN_NUTRIENT"],
      [["Oats", { protein_g: 6 }, "x".repeat(81)], "INVALID_CUSTOM_FOOD"],
    ] as const) {
      const err = await asMember(owner, (c) => pgError(change(c, id, rev, args[0], args[1], (args[2] as string | undefined) ?? "1 bowl")));
      expect(err.message).toBe(code);
    }
  });

  it("nobody else can read, change or remove it, and a guest can't either", async () => {
    let id = "";
    let rev = "";
    await asMember(
      owner,
      async (c) => {
        id = (await logOwn(c, "Private soup", { protein_g: 7 })).foodItemId;
        rev = (await detail(c, id)).revisionId;
      },
      { commit: true },
    );
    expect((await asMember(other, (c) => pgError(detail(c, id)))).message).toBe("FOOD_NOT_FOUND");
    expect((await asMember(other, (c) => pgError(change(c, id, rev, "Mine now", {})))).message).toBe("FOOD_NOT_FOUND");
    expect((await asMember(other, (c) => pgError(c.query("select public.set_custom_food_removed($1, true)", [id])))).message).toBe("FOOD_NOT_FOUND");
    expect((await asMember(null, (c) => pgError(detail(c, id)))).code).toBe("42501");
    expect((await asMember(null, (c) => pgError(change(c, id, rev, "x", {})))).code).toBe("42501");
    // Still exactly as the owner left it.
    expect((await asMember(owner, (c) => detail(c, id))).name).toBe("Private soup");
  });

  it("a catalog food or a USDA copy is not 'your own food' here", async () => {
    await asMember(owner, async (c) => {
      const dish = (await c.query("select id from public.food_items where kind = 'dish' and visibility = 'public' limit 1")).rows[0].id;
      expect(await refused(c, "select public.my_custom_food($1)", [dish])).toBe("FOOD_NOT_FOUND");
    });
    // A private USDA copy (the demo USDA release, as in usda-diary.test.ts).
    const pc = await pool.connect();
    let releaseId: string;
    try {
      releaseId = await demoRelease(pc, { allowExcerpt: true });
    } finally {
      pc.release();
    }
    await asMember(owner, async (c) => {
      const copy = (await c.query("select public.usda_diary_food($1, 172421) as r", [releaseId])).rows[0].r.foodItemId;
      expect(await refused(c, "select public.my_custom_food($1)", [copy])).toBe("FOOD_NOT_FOUND");
      expect(await refused(c, "select public.set_custom_food_removed($1, true)", [copy])).toBe("FOOD_NOT_FOUND");
    });
  });
});

describe("removing a food of your own", () => {
  it("takes it off the list and out of logging, keeps earlier entries and repeat, and can be put back", async () => {
    await asMember(owner, async (c) => {
      const { foodItemId, entryId } = await logOwn(c, "Leftover curry", { protein_g: 15 }, "2026-05-10");
      await c.query("select public.set_custom_food_removed($1, true)", [foodItemId]);
      expect((await mine(c)).map((f) => f.foodItemId)).not.toContain(foodItemId);
      expect(await refused(c, "select public.loggable_food($1)", [foodItemId])).toBe("FOOD_NOT_FOUND");
      expect(await refused(c, "select public.my_custom_food($1)", [foodItemId])).toBe("FOOD_NOT_FOUND");
      // The earlier entry is still there with its numbers, and it can still be repeated from the diary.
      const d = await day(c, "2026-05-10");
      expect(d.entries.map((e: J) => e.name)).toEqual(["Leftover curry"]);
      expect(Number(d.totals.protein_g.known)).toBe(15);
      const again = (await c.query("select public.repeat_diary_entry($1, $2, '2026-05-11', $3) as r", [randomUUID(), entryId, TZ])).rows[0].r;
      expect(again.entryId).toBeTruthy();

      await c.query("select public.set_custom_food_removed($1, false)", [foodItemId]);
      expect((await mine(c)).map((f) => f.foodItemId)).toContain(foodItemId);
      expect((await c.query("select public.loggable_food($1) ->> 'name' as n", [foodItemId])).rows[0].n).toBe("Leftover curry");
    });
  });
});
