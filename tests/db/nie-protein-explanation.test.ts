import { readFileSync, readdirSync } from "node:fs";
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../helpers/db";
import { fromSrLegacyCsv, parseCsv } from "../../scripts/lib/usda-normalize.mjs";
import { prepareRelease, writeRelease } from "../../scripts/lib/usda-import-lib.mjs";

// NIE N-4 "How we got this" (docs/27 N-4): public.protein_explanation. Every test runs in ONE rolled-back
// transaction. Same USDA fixture and helpers as tests/db/nie-dish-models.test.ts.
// Reference values are USDA SR Legacy's own (fixture excerpt): per 100 g protein
//   lentils raw 24.63 (172420), lentils cooked 9.02 (172421), tofu firm 17.27 (172475),
//   rice raw 7.13 (168877), rice cooked 2.69 (168878).
// Every expected number below is worked out by hand in the comment next to it.

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

const META = { dataset: "sr_legacy", releaseLabel: "2099-02", fileName: "FoodData_Central_sr_legacy_food_csv_nie2.zip", sha256: "9".repeat(64), sourceUrl: "https://fdc.nal.usda.gov/fdc-datasets/nie2.zip" };
const sr = () => {
  const dir = "tests/fixtures/usda/sr-sample";
  const t = Object.fromEntries(readdirSync(dir).map((f) => [f.replace(/\.csv$/, ""), parseCsv(readFileSync(`${dir}/${f}`, "utf8"))]));
  return prepareRelease(META, fromSrLegacyCsv(t));
};
const LENTILS_RAW = 172420, LENTILS_COOKED = 172421;

async function user(c: PoolClient, roles: string[]) {
  const id = randomUUID();
  await c.query(
    `insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}', '{}', now(), now())`,
    [id, `nie-${id.slice(0, 8)}@example.test`],
  );
  for (const r of roles) await c.query("insert into public.role_assignments (user_id, role) values ($1, $2)", [id, r]);
  return id;
}

async function world(c: PoolClient) {
  const { releaseId } = await writeRelease(c, sr());
  const curator = await user(c, ["curator"]);
  const publisher = await user(c, ["publisher"]);
  const line = (fdcId: number, p: J = {}) => ({ label: `food ${fdcId}`, usdaReleaseId: releaseId, fdcId, usdaState: "cooked", weighedAs: "cooked", amountBasis: "stated", ...p });
  const model = async (p: J, publish = true) => {
    const id = await one(c, "app.nie_create_model($1, $2::jsonb)", [curator, JSON.stringify({ label: "Test dish", quantityBasis: "restaurant_verified", servingBasis: "stated", ...p })]);
    if (publish) await c.query("select app.nie_publish_model($1, $2)", [publisher, id]);
    return id as string;
  };
  const calc = async (modelId: string) => {
    const id = await one(c, "app.nie_calculate($1)", [modelId]);
    return (await c.query("select * from app.nie_calculations where id = $1", [id])).rows[0] as J;
  };
  return { releaseId, curator, publisher, line, model, calc };
}

afterAll(async () => {
  await pool.end();
});

async function dish(c: PoolClient, opts: { publish?: boolean; demo?: boolean } = {}) {
  const item = (await c.query("insert into public.food_items (kind, visibility, status, is_demo) values ('dish', 'public', 'draft', $1) returning id", [opts.demo ?? true])).rows[0].id as string;
  const rev = (await c.query("insert into public.food_revisions (food_item_id, revision_no, name, basis_kind, basis_amount, basis_unit) values ($1, 1, 'Demo explanation bowl', 'serving', 1, 'serving') returning id", [item])).rows[0].id as string;
  await c.query("update public.food_items set current_revision_id = $1 where id = $2", [rev, item]);
  const publish = async () => {
    await c.query("update public.food_revisions set published_at = now() where id = $1", [rev]);
    await c.query("update public.food_items set status = 'published' where id = $1", [item]);
  };
  return { item, rev, publish };
}
const explain = (c: PoolClient, item: string, estimates = false, demo = true) => one(c, "public.protein_explanation($1, $2, $3)", [item, demo, estimates]);

describe("E1 an estimated range explains itself, and stays hidden until asked for", () => {
  it("hidden: no number, range or ingredients; shown: range, confidence, every ingredient and the USDA release", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const d = await dish(c);
      const calcId = await one(c, "app.nie_calculate($1)", [await w.model({ quantityBasis: "editorial_typical", assumptions: "Typical recipe: one ladle of cooked lentils.", lines: [w.line(LENTILS_COOKED, { label: "Cooked lentils", amountBasis: "typical", grams: 150, gramsLow: 120, gramsHigh: 180 })] })]);
      await c.query("select app.nie_apply_to_revision($1, $2, $3)", [w.curator, calcId, d.rev]);
      await d.publish();

      const hidden = await explain(c, d.item, false);
      expect(hidden).toMatchObject({ state: "estimate_hidden", value: null, low: null, high: null, confidence: null, calculation: null, source: null });

      const e = await explain(c, d.item, true);
      // 150 g x 9.02/100 = 13.53; 120 g = 10.824; 180 g = 16.236; 16.236/10.824 = 1.5 -> medium.
      expect(e).toMatchObject({ state: "estimated_range", value: 13.53, low: 10.824, high: 16.236, confidence: "medium" });
      expect(e.assumptions).toMatch(/not a statistical confidence interval; not a restaurant figure/);
      expect(e.source).toMatchObject({ publisher: "Nutrition engine calculation" });
      expect(e.calculation).toMatchObject({ quantityBasis: "editorial_typical", servingBasis: "stated", modelAssumptions: "Typical recipe: one ladle of cooked lentils.", engineVersion: "nie-v1-calc-1" });
      expect(e.calculation.inputsSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(e.calculation.lines).toEqual([
        expect.objectContaining({ label: "Cooked lentils", fdcId: LENTILS_COOKED, usdaDataset: "sr_legacy", usdaRelease: "2099-02", usdaState: "cooked", weighedAs: "cooked", amountBasis: "typical", grams: 150, gramsLow: 120, gramsHigh: 180, proteinG: 13.53, lowG: 10.824, highG: 16.236, yieldFactor: null }),
      ]);
      expect(e.calculation.lines[0].usdaDescription).toMatch(/lentils/i);
      expect(e.calculation.references).toEqual([expect.objectContaining({ dataset: "sr_legacy", release: "2099-02", sourceUrl: META.sourceUrl })]);
    });
  });
});

describe("E2 a calculated figure shows raw vs cooked conversion openly", () => {
  it("cooked lentils weighed against the raw USDA value carry the yield factor and its source", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const d = await dish(c);
      const y = { yieldFactor: 2.5, yieldSource: "Test fixture: 1 g dry lentils gives 2.5 g cooked" };
      const calcId = await one(c, "app.nie_calculate($1)", [await w.model({ lines: [w.line(LENTILS_RAW, { usdaState: "raw", weighedAs: "cooked", grams: 250, ...y })] })]);
      await c.query("select app.nie_apply_to_revision($1, $2, $3)", [w.curator, calcId, d.rev]);
      await d.publish();
      // 250 g cooked / 2.5 = 100 g raw x 24.63/100 = 24.63.
      const e = await explain(c, d.item);
      expect(e).toMatchObject({ state: "calculated", value: 24.63, low: null, high: null, confidence: null });
      expect(e.calculation.quantityBasis).toBe("restaurant_verified");
      expect(e.calculation.lines[0]).toMatchObject({ usdaState: "raw", weighedAs: "cooked", grams: 250, yieldFactor: 2.5, yieldSource: y.yieldSource, proteinG: 24.63 });
    });
  });
});

describe("E3 restaurant figures, unknowns and visibility", () => {
  it("a restaurant-published figure says so and has no calculation; a missing figure is unknown, never 0", async () => {
    await tx(async (c) => {
      const d = await dish(c);
      const src = (await c.query("insert into public.sources (publisher, source_type, is_demo, access_scope) values ('Demo restaurant', 'menu', true, 'public') returning id")).rows[0].id;
      const rec = (await c.query("insert into public.source_records (source_id, observed_at, rights_status) values ($1, now(), 'cleared') returning id", [src])).rows[0].id;
      await c.query("insert into public.nutrient_values (revision_id, nutrient_code, value, method, source_record_id) values ($1, 'protein_g', 20, 'published', $2)", [d.rev, rec]);
      const blank = await dish(c);
      await d.publish();
      await blank.publish();
      expect(await explain(c, d.item)).toMatchObject({ state: "restaurant_published", value: 20, calculation: null, source: { publisher: "Demo restaurant" } });
      expect(await explain(c, blank.item)).toMatchObject({ state: "unknown", value: null, missingReason: "not_provided", source: null, calculation: null });
    });
  });

  it("drafts are not found, demo items only when demo content is on, and guests may call it", async () => {
    await tx(async (c) => {
      const draft = await dish(c);
      expect((await err(c, "select public.protein_explanation($1, true, false)", [draft.item])).message).toBe("FOOD_NOT_FOUND");
      const d = await dish(c);
      await d.publish();
      expect((await err(c, "select public.protein_explanation($1, false, false)", [d.item])).message).toBe("FOOD_NOT_FOUND");
      for (const role of ["anon", "authenticated"]) expect(await one(c, "has_function_privilege($1, 'public.protein_explanation(uuid, boolean, boolean)', 'execute')", [role])).toBe(true);
      await c.query("set local role anon");
      expect((await explain(c, d.item)).state).toBe("unknown");
    });
  });
});
