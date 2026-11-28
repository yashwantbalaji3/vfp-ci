import { readFileSync, readdirSync } from "node:fs";
import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../helpers/db";
import { fromFoundationJson, fromSrLegacyCsv, parseCsv } from "../../scripts/lib/usda-normalize.mjs";
import { prepareRelease, writeRelease } from "../../scripts/lib/usda-import-lib.mjs";

// NIE V1 slice N-1 (docs/24 3.2): USDA reference data in the local database. Every test runs in ONE
// transaction that is rolled back, so nothing stays behind. Fixtures are excerpts of the real files.

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function tx(fn: (c: PoolClient) => Promise<void>) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await fn(c);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
  }
}
const err = async (c: PoolClient, sql: string, params: unknown[] = []) => {
  await c.query("savepoint s");
  try {
    await c.query(sql, params);
  } catch (e) {
    await c.query("rollback to savepoint s");
    return e as { code: string; message: string };
  }
  throw new Error(`Expected to fail: ${sql}`);
};
const one = async (c: PoolClient, sql: string, params: unknown[] = []) => (await c.query(`select ${sql} as r`, params)).rows[0].r;

const META = {
  foundation: { dataset: "foundation", releaseLabel: "2099-01-01", fileName: "FoodData_Central_foundation_food_json_test.zip", sha256: "a".repeat(64), sourceUrl: "https://fdc.nal.usda.gov/fdc-datasets/test.zip" },
  sr: { dataset: "sr_legacy", releaseLabel: "2099-01", fileName: "FoodData_Central_sr_legacy_food_csv_test.zip", sha256: "b".repeat(64), sourceUrl: "https://fdc.nal.usda.gov/fdc-datasets/test-sr.zip" },
};
const foundation = () => prepareRelease(META.foundation, fromFoundationJson(JSON.parse(readFileSync("tests/fixtures/usda/foundation-sample.json", "utf8"))));
const sr = () => {
  const dir = "tests/fixtures/usda/sr-sample";
  const t = Object.fromEntries(readdirSync(dir).map((f) => [f.replace(/\.csv$/, ""), parseCsv(readFileSync(`${dir}/${f}`, "utf8"))]));
  return prepareRelease(META.sr, fromSrLegacyCsv(t));
};

afterAll(async () => {
  await pool.end();
});

describe("N1-1 importing is repeatable and never overwrites", () => {
  it("a demo excerpt and the full file of one release sit side by side; a second full file or excerpt is still refused", async () => {
    await tx(async (c) => {
      // The browser tests load a small excerpt of a release; the full file of the same release must
      // still import afterwards (owner direction 18 Nov 23:20 UTC), and nothing already imported changes.
      const excerpt = sr();
      excerpt.release.fileName = "FoodData_Central_sr_legacy_food_csv_test_demo_excerpt.zip";
      excerpt.release.fileSha256 = "d".repeat(64);
      const a = await writeRelease(c, excerpt);
      expect(a.status).toBe("new");
      const full = await writeRelease(c, sr());
      expect(full.status).toBe("new");
      expect(full.releaseId).not.toBe(a.releaseId);
      expect((await writeRelease(c, sr())).status).toBe("unchanged");
      expect((await writeRelease(c, excerpt)).status).toBe("unchanged");
      const otherFull = sr();
      otherFull.release.fileSha256 = "e".repeat(64);
      expect((await err(c, "select app.usda_begin_release($1::jsonb)", [JSON.stringify(otherFull.release)])).message).toBe("USDA_RELEASE_CONFLICT");
      const otherExcerpt = sr();
      otherExcerpt.release.fileName = excerpt.release.fileName;
      otherExcerpt.release.fileSha256 = "f".repeat(64);
      expect((await err(c, "select app.usda_begin_release($1::jsonb)", [JSON.stringify(otherExcerpt.release)])).message).toBe("USDA_RELEASE_CONFLICT");
      // Only the excerpt counts as one: a file name merely containing "demo" elsewhere is a full file.
      expect(await one(c, "app.usda_is_excerpt($1)", ["FoodData_Central_sr_legacy_food_csv_2018-04_demo_excerpt.zip"])).toBe(true);
      expect(await one(c, "app.usda_is_excerpt($1)", ["FoodData_Central_sr_legacy_food_csv_2018-04.zip"])).toBe(false);
      expect(await one(c, "app.usda_is_excerpt($1)", ["demo_excerptXzip"])).toBe(false);
    });
  });

  it("a release is written once, sealed, and the same file again is 'unchanged'; a different file under the same name is refused", async () => {
    await tx(async (c) => {
      const first = await writeRelease(c, foundation());
      expect(first).toMatchObject({ status: "new", foods: 4 });
      const again = await writeRelease(c, foundation());
      expect(again).toEqual({ status: "unchanged", releaseId: first.releaseId, foods: 4 });
      const rel = (await c.query("select * from app.usda_releases where id = $1", [first.releaseId])).rows[0];
      expect(rel.sealed).toBe(true);
      expect(rel.content_sha256).toBe(foundation().release.contentSha256);
      expect(rel.report.refusedCount).toBe(1);
      // Same release name and importer, different file fingerprint: refused, nothing changed.
      const changed = foundation();
      changed.release.fileSha256 = "c".repeat(64);
      const e = await err(c, "select app.usda_begin_release($1::jsonb)", [JSON.stringify(changed.release)]);
      expect(e.message).toBe("USDA_RELEASE_CONFLICT");
      // The source record says where it came from, under the recorded CC0 licence.
      const src = (await c.query(
        `select s.publisher, s.source_type, s.is_demo, r.rights_status, r.content_hash, l.permitted_uses, l.attribution
           from public.source_records r join public.sources s on s.id = r.source_id join public.licenses l on l.id = s.license_id
          where r.id = $1`, [rel.source_record_id])).rows[0];
      expect(src).toMatchObject({ publisher: "USDA FoodData Central", source_type: "government_dataset", is_demo: false, rights_status: "cleared", content_hash: "a".repeat(64) });
      expect(src.permitted_uses).toEqual(["display", "store", "derive", "distribute"]);
      expect(src.attribution).toMatch(/FoodData Central/);
    });
  });

  it("a release with fewer foods than announced cannot be sealed", async () => {
    await tx(async (c) => {
      const p = foundation();
      const begin = await one(c, "app.usda_begin_release($1::jsonb)", [JSON.stringify(p.release)]);
      await c.query("select app.usda_add_foods($1::uuid, $2::jsonb)", [begin.releaseId, JSON.stringify(p.records.slice(0, 2).map((r: J) => ({ ...r, recordSha256: "d".repeat(64) })))]);
      const e = await err(c, "select app.usda_seal_release($1::uuid)", [begin.releaseId]);
      expect(e.message).toBe("USDA_RELEASE_INCOMPLETE");
    });
  });
});

describe("N1-2 sealed reference data is permanent", () => {
  it("no update, delete, truncate or late addition, even by the database owner", async () => {
    await tx(async (c) => {
      const { releaseId } = await writeRelease(c, sr());
      expect((await err(c, "update app.usda_foods set description = 'x' where release_id = $1", [releaseId])).message).toMatch(/permanent/);
      expect((await err(c, "delete from app.usda_foods where release_id = $1", [releaseId])).message).toMatch(/permanent/);
      expect((await err(c, "update app.usda_releases set food_count = 3 where id = $1", [releaseId])).message).toMatch(/permanent/);
      expect((await err(c, "update app.usda_releases set sealed = false where id = $1", [releaseId])).message).toMatch(/permanent/);
      expect((await err(c, "delete from app.usda_releases where id = $1", [releaseId])).message).toMatch(/permanent/);
      expect((await err(c, "truncate app.usda_foods cascade")).message).toMatch(/permanent/);
      const late = { fdcId: 999999, dataType: "sr_legacy", description: "Late", category: null, ndbNumber: null, publicationDate: null, nutrients: {}, portions: [], recordSha256: "e".repeat(64) };
      expect((await err(c, "select app.usda_add_foods($1::uuid, $2::jsonb)", [releaseId, JSON.stringify([late])])).message).toMatch(/sealed/);
    });
  });

  it("the database itself refuses a wrong unit, a negative value or a portion without grams", async () => {
    await tx(async (c) => {
      const p = sr();
      const { releaseId } = await one(c, "app.usda_begin_release($1::jsonb)", [JSON.stringify(p.release)]);
      const base = { fdcId: 1, dataType: "sr_legacy", description: "Bad", category: null, ndbNumber: null, publicationDate: null, portions: [], recordSha256: "f".repeat(64) };
      for (const nutrients of [
        { protein_g: { value: "5", unit: "mg", usdaNutrientId: 1003 } },
        { protein_g: { value: "-1", unit: "g", usdaNutrientId: 1003 } },
        { protein_g: { value: "0x10", unit: "g", usdaNutrientId: 1003 } },
        { vitamin_c: { value: "5", unit: "mg", usdaNutrientId: 1162 } },
      ]) {
        const e = await err(c, "select app.usda_add_foods($1::uuid, $2::jsonb)", [releaseId, JSON.stringify([{ ...base, nutrients }])]);
        expect(e.code).toBe("23514"); // check constraint
      }
      const e = await err(c, "select app.usda_add_foods($1::uuid, $2::jsonb)", [releaseId, JSON.stringify([{ ...base, nutrients: {}, portions: [{ usdaPortionId: 1, amount: "1", grams: "0" }] }])]);
      expect(e.code).toBe("23514");
    });
  });
});

describe("N1-3 calculations are exact, and unknown stays unknown", () => {
  it("amounts for grams and USDA portions, with exact decimals", async () => {
    await tx(async (c) => {
      const { releaseId } = await writeRelease(c, sr());
      // Cooked lentils: 9.02 g protein per 100 g (USDA SR Legacy 172421, NDB 16070).
      expect(await one(c, "app.usda_per_100g($1, 172421, 'protein_g')::text", [releaseId])).toBe("9.02");
      expect(Number(await one(c, "app.usda_amount($1, 172421, 'protein_g', 150)", [releaseId]))).toBe(13.53);
      // 1 cup = 198 g, so half a cup is 99 g and holds 8.9298 g protein.
      expect(Number(await one(c, "app.usda_portion_grams($1, 172421, 90596, 0.5)", [releaseId]))).toBe(99);
      const halfCup = await one(c, "app.usda_amount($1, 172421, 'protein_g', app.usda_portion_grams($1, 172421, 90596, 0.5))", [releaseId]);
      expect(Number(halfCup)).toBeCloseTo(8.9298, 10);
      // Tofu: a quarter block is 81 g, so one block is 324 g.
      expect(Number(await one(c, "app.usda_portion_grams($1, 172475, 90684, 1)", [releaseId]))).toBe(324);
      // Unknown in, unknown out: a missing portion, no grams, zero or negative grams, an unknown food.
      expect(await one(c, "app.usda_portion_grams($1, 172421, 123, 1)", [releaseId])).toBeNull();
      expect(await one(c, "app.usda_amount($1, 172421, 'protein_g', null)", [releaseId])).toBeNull();
      expect(await one(c, "app.usda_amount($1, 172421, 'protein_g', 0)", [releaseId])).toBeNull();
      expect(await one(c, "app.usda_amount($1, 1, 'protein_g', 100)", [releaseId])).toBeNull();
    });
  });

  it("a nutrient USDA does not give is null, never zero; a reported zero stays zero", async () => {
    await tx(async (c) => {
      const { releaseId } = await writeRelease(c, foundation());
      expect(await one(c, "app.usda_per_100g($1, 2644283, 'fiber_g')", [releaseId])).toBeNull();
      expect(await one(c, "app.usda_per_100g($1, 2644283, 'sodium_mg')::text", [releaseId])).toBe("0");
      expect(await one(c, "app.usda_per_100g($1, 2727566, 'carb_g')", [releaseId])).toBeNull(); // refused negative value
    });
  });

  it("nothing can be read from a release that is not sealed", async () => {
    await tx(async (c) => {
      const p = sr();
      const { releaseId } = await one(c, "app.usda_begin_release($1::jsonb)", [JSON.stringify(p.release)]);
      await c.query("select app.usda_add_foods($1::uuid, $2::jsonb)", [releaseId, JSON.stringify(p.records.map((r: J) => ({ ...r, recordSha256: "1".repeat(64) })))]);
      expect(await one(c, "app.usda_per_100g($1, 172421, 'protein_g')", [releaseId])).toBeNull();
    });
  });
});

describe("N1-4 reference data is closed to visitors and members", () => {
  it("guests and members cannot read the tables or call the functions", async () => {
    await tx(async (c) => {
      await writeRelease(c, sr());
      for (const role of ["anon", "authenticated"]) {
        await c.query(`set local role ${role}`);
        for (const sql of [
          "select count(*) from app.usda_foods",
          "select count(*) from app.usda_releases",
          "select app.usda_per_100g(gen_random_uuid(), 172421, 'protein_g')",
          "select app.usda_begin_release('{}'::jsonb)",
        ]) {
          expect((await err(c, sql)).code, `${role}: ${sql}`).toBe("42501");
        }
        await c.query("reset role");
      }
    });
  });
});
