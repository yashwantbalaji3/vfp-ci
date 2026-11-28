import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asMember, createTestUser, deleteTestUsers, pgError, pool } from "../helpers/db";
import { demoRelease } from "../../scripts/lib/nie-demo-dishes.mjs";

// Logging a USDA FoodData Central food straight into the diary (migration 20261118000700). The USDA
// release is the 23-food SR Legacy excerpt in tests/fixtures/usda/sr-boston-demo (real USDA values).
// Lentils, mature seeds, cooked, boiled, without salt (FDC 172421): 9.02 g protein and 116 kcal per
// 100 g; USDA portions 1 cup = 198 g and 1 tbsp = 12.3 g.

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const LENTILS = 172421;
const TZ = "America/New_York";
let releaseId: string;
let userA: string;
let userB: string;

beforeAll(async () => {
  const c = await pool.connect();
  try {
    releaseId = await demoRelease(c, { allowExcerpt: true });
  } finally {
    c.release();
  }
  userA = await createTestUser("usda-a");
  userB = await createTestUser("usda-b");
});
afterAll(async () => {
  await deleteTestUsers([userA, userB]);
  await pool.end();
});

const search = async (c: PoolClient, q: string) => (await c.query("select public.usda_food_search($1, 12) as r", [q])).rows[0].r as J[];
const choose = async (c: PoolClient, fdc = LENTILS, rel = releaseId) =>
  (await c.query("select public.usda_diary_food($1, $2) as r", [rel, fdc])).rows[0].r as { foodItemId: string; created: boolean };
const loggable = async (c: PoolClient, id: string) => (await c.query("select public.loggable_food($1) as r", [id])).rows[0].r as J;

describe("USDA search", () => {
  it("guests cannot search or copy USDA foods", async () => {
    // One failing query per transaction: an error ends the transaction.
    await asMember(null, async (c) => {
      expect((await pgError(c.query("select public.usda_food_search('lentils')"))).code).toBe("42501");
    });
    await asMember(null, async (c) => {
      expect((await pgError(c.query("select public.usda_diary_food($1, $2)", [releaseId, LENTILS]))).code).toBe("42501");
    });
  });

  it("a member finds a food by every word, with USDA's protein per 100 g", async () => {
    await asMember(userA, async (c) => {
      const hits = await search(c, "lentils cooked");
      const lentils = hits.find((h) => h.fdcId === LENTILS);
      expect(lentils).toMatchObject({ releaseId, dataType: "sr_legacy", description: "Lentils, mature seeds, cooked, boiled, without salt", proteinPer100g: 9.02, energyPer100g: 116 });
      expect(hits.every((h) => /lentil/i.test(h.description) && /cooked/i.test(h.description))).toBe(true);
      expect(await search(c, "x")).toEqual([]);
      expect(await search(c, "zzzz no such food")).toEqual([]);
    });
  });

  it("meat, poultry and fish groups are left out of search", async () => {
    const r = await pool.query(
      "select app.usda_hidden_category('Beef Products') a, app.usda_hidden_category('Poultry Products') b, app.usda_hidden_category('Finfish and Shellfish Products') c, app.usda_hidden_category('Legumes and Legume Products') d, app.usda_hidden_category(null) e",
    );
    expect(r.rows[0]).toEqual({ a: true, b: true, c: true, d: false, e: false });
  });
});

describe("choosing and logging a USDA food", () => {
  it("makes one private copy per member, logs it with USDA's values and source, and keeps it out of 'Your own foods'", async () => {
    const first = await asMember(userA, (c) => choose(c), { commit: true });
    expect(first.created).toBe(true);
    await asMember(userA, async (c) => {
      const again = await choose(c);
      expect(again).toEqual({ foodItemId: first.foodItemId, created: false });

      const food = await loggable(c, first.foodItemId);
      expect(food).toMatchObject({ kind: "custom", isOwn: true, name: "Lentils, mature seeds, cooked, boiled, without salt", gramsSupported: true });
      expect(food.basis).toEqual({ kind: "mass", amount: 100, unit: "g" });
      expect(food.usda).toEqual({ fdcId: LENTILS, dataType: "sr_legacy", releaseLabel: "2018-04", category: "Legumes and Legume Products" });
      const cup = food.portions.find((p: J) => p.label === "1 cup (198 g)");
      expect(cup).toBeTruthy();
      expect(food.portions.map((p: J) => p.label)).toContain("1 tbsp (12.3 g)");

      const logged = (
        await c.query("select public.log_food_entry($1, $2, $3, 1, null, 'home', 'lunch', $4, $5) as r", [randomUUID(), food.revisionId, cup.id, "2026-11-18", TZ])
      ).rows[0].r as J;
      const day = (await c.query("select public.diary_day('2026-11-18') as r")).rows[0].r as J;
      const entry = day.entries.find((e: J) => e.entryId === logged.entryId);
      expect(entry).toBeTruthy();
      expect(Number(entry.nutrients.protein_g.value)).toBeCloseTo(17.8596, 4); // 9.02 x 1.98
      expect(entry.nutrients.protein_g.method).toBe("published");

      const own = (await c.query("select public.my_custom_foods() as r")).rows[0].r as J[];
      expect(own.some((f) => f.foodItemId === first.foodItemId)).toBe(false);
    });

    // The values cite the USDA release's own source record, never "Entered by member".
    const src = await pool.query(
      `select distinct nv.method, nv.source_record_id = ur.source_record_id as usda_source, s.publisher
         from public.food_items fi
         join public.nutrient_values nv on nv.revision_id = fi.current_revision_id
         join app.usda_releases ur on ur.id = $2
         join public.source_records sr on sr.id = nv.source_record_id
         join public.sources s on s.id = sr.source_id
        where fi.id = $1 and nv.value is not null`,
      [first.foodItemId, releaseId],
    );
    expect(src.rows).toEqual([{ method: "published", usda_source: true, publisher: "USDA FoodData Central" }]);
  });

  it("another member never sees the first member's copy and gets a copy of their own", async () => {
    const a = await asMember(userA, (c) => choose(c));
    await asMember(userB, async (c) => {
      expect((await pgError(c.query("select public.loggable_food($1)", [a.foodItemId]))).message).toBe("FOOD_NOT_FOUND");
    });
    await asMember(userB, async (c) => {
      const b = await choose(c);
      expect(b.created).toBe(true);
      expect(b.foodItemId).not.toBe(a.foodItemId);
    });
  });

  it("an unknown food or an unsealed release is refused", async () => {
    await asMember(userA, async (c) => {
      expect((await pgError(choose(c, 999999999))).message).toBe("FOOD_NOT_FOUND");
    });
    await asMember(userA, async (c) => {
      expect((await pgError(choose(c, LENTILS, randomUUID()))).message).toBe("FOOD_NOT_FOUND");
    });
  });

  it("members cannot read the link table directly", async () => {
    await asMember(userA, async (c) => {
      expect((await pgError(c.query("select * from app.usda_member_foods"))).code).toBe("42501");
    });
  });
});
