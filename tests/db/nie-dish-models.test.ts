import { readFileSync, readdirSync } from "node:fs";
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../helpers/db";
import { fromSrLegacyCsv, parseCsv } from "../../scripts/lib/usda-normalize.mjs";
import { prepareRelease, writeRelease } from "../../scripts/lib/usda-import-lib.mjs";

// NIE V1 slices N-2 and N-3 (docs/24 3.3-3.4, docs/27 B). Every test runs in ONE rolled-back transaction.
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
const LENTILS_RAW = 172420, LENTILS_COOKED = 172421, TOFU = 172475, RICE_RAW = 168877, RICE_COOKED = 168878;

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
const num = (v: unknown) => (v === null ? null : Number(v));

afterAll(async () => {
  await pool.end();
});

describe("N2-1 dish models: two people, frozen once published, NIE-E kept", () => {
  it("only a curator creates, only a different publisher publishes, and a published model never changes", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const member = await user(c, []);
      expect((await err(c, "select app.nie_create_model($1, $2::jsonb)", [member, JSON.stringify({ label: "x", quantityBasis: "restaurant_verified", servingBasis: "stated", lines: [w.line(TOFU, { grams: 100 })] })])).message).toBe("NIE_ROLE_REQUIRED");
      const m = await w.model({ lines: [w.line(TOFU, { grams: 100 })] }, false);
      expect((await err(c, "select app.nie_publish_model($1, $2)", [w.curator, m])).message).toBe("NIE_ROLE_REQUIRED");
      const both = await user(c, ["curator", "publisher"]);
      const m2 = await one(c, "app.nie_create_model($1, $2::jsonb)", [both, JSON.stringify({ label: "x", quantityBasis: "restaurant_verified", servingBasis: "stated", lines: [w.line(TOFU, { grams: 100 })] })]);
      expect((await err(c, "select app.nie_publish_model($1, $2)", [both, m2])).message).toBe("NIE_SAME_PERSON");
      // A calculation needs a published (reviewed, frozen) model.
      expect((await err(c, "select app.nie_calculate($1)", [m])).message).toBe("NIE_MODEL_NOT_PUBLISHED");
      await c.query("select app.nie_publish_model($1, $2)", [w.publisher, m]);
      expect((await err(c, "update app.nie_model_lines set grams = 200 where model_id = $1", [m])).message).toMatch(/frozen/);
      expect((await err(c, "delete from app.nie_model_lines where model_id = $1", [m])).message).toMatch(/frozen/);
      expect((await err(c, "update app.nie_dish_models set label = 'y' where id = $1", [m])).message).toMatch(/frozen/);
      expect((await err(c, "delete from app.nie_dish_models where id = $1", [m])).message).toMatch(/permanent/);
    });
  });

  it("NIE-E: a model called restaurant-verified cannot hold a typical amount or a typical serving", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const m = await w.model({ lines: [w.line(TOFU, { amountBasis: "typical", grams: 100, gramsLow: 80, gramsHigh: 120 })] }, false);
      expect((await err(c, "select app.nie_publish_model($1, $2)", [w.publisher, m])).message).toBe("NIE_VERIFIED_MODEL_HAS_TYPICAL_AMOUNTS");
      const m2 = await w.model({ servingBasis: "typical", servingFactorLow: 0.9, servingFactorHigh: 1.1, lines: [w.line(TOFU, { grams: 100 })] }, false);
      expect((await err(c, "select app.nie_publish_model($1, $2)", [w.publisher, m2])).message).toBe("NIE_VERIFIED_MODEL_HAS_TYPICAL_AMOUNTS");
      // The database refuses a stated amount with a range, and a typical amount outside its own range.
      expect((await err(c, "select app.nie_create_model($1, $2::jsonb)", [w.curator, JSON.stringify({ label: "x", quantityBasis: "editorial_typical", servingBasis: "stated", lines: [w.line(TOFU, { grams: 100, gramsLow: 90 })] })])).code).toBe("23514");
      expect((await err(c, "select app.nie_create_model($1, $2::jsonb)", [w.curator, JSON.stringify({ label: "x", quantityBasis: "editorial_typical", servingBasis: "stated", lines: [w.line(TOFU, { amountBasis: "typical", grams: 130, gramsLow: 80, gramsHigh: 120 })] })])).code).toBe("23514");
    });
  });
});

describe("N3-1 calculated figures from verified quantities, exactly", () => {
  it("verified amounts give a calculated figure with no range: 150 g cooked lentils + 100 g tofu = 30.8 g", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const r = await w.calc(await w.model({ lines: [w.line(LENTILS_COOKED, { grams: 150 }), w.line(TOFU, { grams: 100, usdaState: "raw", weighedAs: "raw" })] }));
      // 9.02 x 1.5 = 13.53; 17.27 x 1 = 17.27; total 30.80
      expect(r).toMatchObject({ state: "calculated", low: null, high: null, confidence: null, reason: null, engine_version: "nie-v1-calc-1" });
      expect(num(r.central)).toBe(30.8);
      expect(r.lines.map((l: J) => Number(l.proteinG))).toEqual([13.53, 17.27]);
      expect(r.inputs_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(r.inputs.releases[0].contentSha256).toBe(sr().release.contentSha256); // traceable to the exact USDA release
    });
  });

  it("serving conversions use USDA's own portion weights: half a cup of cooked lentils is 99 g = 8.9298 g", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const grams = await one(c, "app.usda_portion_grams($1, $2, 90596, 0.5)", [w.releaseId, LENTILS_COOKED]); // 198 g per cup
      const r = await w.calc(await w.model({ lines: [w.line(LENTILS_COOKED, { grams: Number(grams) })] }));
      expect(num(r.central)).toBeCloseTo(8.9298, 10); // 9.02 x 99 / 100
    });
  });
});

describe("N3-2 raw and cooked are never mixed", () => {
  it("cooked weight against a raw USDA food goes through the stated yield factor, and the reverse", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const y = { yieldFactor: 2.5, yieldSource: "Test fixture: 1 g dry lentils gives 2.5 g cooked" };
      // 250 g cooked, USDA raw: raw weight 250 / 2.5 = 100 g, protein 24.63 x 1 = 24.63
      const a = await w.calc(await w.model({ lines: [w.line(LENTILS_RAW, { usdaState: "raw", weighedAs: "cooked", grams: 250, ...y })] }));
      expect(num(a.central)).toBe(24.63);
      // 100 g raw, USDA cooked: cooked weight 100 x 2.5 = 250 g, protein 9.02 x 2.5 = 22.55
      const b = await w.calc(await w.model({ lines: [w.line(LENTILS_COOKED, { usdaState: "cooked", weighedAs: "raw", grams: 100, ...y })] }));
      expect(num(b.central)).toBe(22.55);
      // Without a conversion the answer is unknown, never the raw value applied to a cooked weight.
      const c3 = await w.calc(await w.model({ lines: [w.line(RICE_RAW, { usdaState: "raw", weighedAs: "cooked", grams: 158 })] }));
      expect(c3).toMatchObject({ state: "unknown", central: null, reason: "missing_yield_factor" });
      // Same state needs no factor: 158 g cooked rice (1 cup) = 2.69 x 1.58 = 4.2502
      const d = await w.calc(await w.model({ lines: [w.line(RICE_COOKED, { grams: 158 })] }));
      expect(num(d.central)).toBeCloseTo(4.2502, 10);
      // A yield factor without its source is refused by the database.
      expect((await err(c, "select app.nie_create_model($1, $2::jsonb)", [w.curator, JSON.stringify({ label: "x", quantityBasis: "restaurant_verified", servingBasis: "stated", lines: [w.line(LENTILS_RAW, { usdaState: "raw", weighedAs: "cooked", grams: 250, yieldFactor: 2.5 })] })])).code).toBe("23514");
    });
  });
});

describe("N3-3 estimated ranges: scenario bounds with a confidence level, or unknown", () => {
  it("a typical amount gives an estimate with bounds and a confidence level", async () => {
    await tx(async (c) => {
      const w = await world(c);
      // 120-180 g cooked lentils, typical 150: 10.824 - 13.53 - 16.236; high/low = 1.5 -> medium
      const r = await w.calc(await w.model({ quantityBasis: "editorial_typical", lines: [w.line(LENTILS_COOKED, { amountBasis: "typical", grams: 150, gramsLow: 120, gramsHigh: 180 })] }));
      expect(r).toMatchObject({ state: "estimated", confidence: "medium" });
      expect([num(r.low), num(r.central), num(r.high)]).toEqual([10.824, 13.53, 16.236]);
    });
  });

  it("a typical serving size widens the range: factors 0.9 and 1.2 on 13.53 g give 12.177-16.236 g", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const r = await w.calc(await w.model({ quantityBasis: "editorial_typical", servingBasis: "typical", servingFactorLow: 0.9, servingFactorHigh: 1.2, lines: [w.line(LENTILS_COOKED, { grams: 150 })] }));
      expect(r).toMatchObject({ state: "estimated", confidence: "medium" }); // 16.236 / 12.177 = 1.333
      expect([num(r.low), num(r.central), num(r.high)]).toEqual([12.177, 13.53, 16.236]);
    });
  });

  it("a named substitution makes even a restaurant-verified model an estimate covering both options", async () => {
    await tx(async (c) => {
      const w = await world(c);
      // 100 g tofu (17.27) or 100 g cooked lentils (9.02): range 9.02 - 17.27, central 17.27; 1.915 -> low
      const r = await w.calc(await w.model({ lines: [w.line(TOFU, { usdaState: "raw", weighedAs: "raw", grams: 100, substitutes: [{ label: "lentils", usdaReleaseId: w.releaseId, fdcId: LENTILS_COOKED, usdaState: "raw" }] })] }));
      expect(r).toMatchObject({ state: "estimated", confidence: "low" });
      expect([num(r.low), num(r.central), num(r.high)]).toEqual([9.02, 17.27, 17.27]);
      // A substitution whose USDA food does not exist makes the whole answer unknown.
      const u = await w.calc(await w.model({ lines: [w.line(TOFU, { usdaState: "raw", weighedAs: "raw", grams: 100, substitutes: [{ label: "missing", usdaReleaseId: w.releaseId, fdcId: 1, usdaState: "raw" }] })] }));
      expect(u).toMatchObject({ state: "unknown", reason: "missing_reference_value", central: null, low: null, high: null });
    });
  });

  it("NIE-B: high/low exactly 2 is allowed; above 2 is unknown; the limit is a setting", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const typ = (lo: number, hi: number) => w.model({ quantityBasis: "editorial_typical", lines: [w.line(LENTILS_COOKED, { amountBasis: "typical", grams: 100, gramsLow: lo, gramsHigh: hi })] });
      expect(await w.calc(await typ(60, 120))).toMatchObject({ state: "estimated", confidence: "low" }); // ratio 2.0
      const wide = await typ(50, 120); // ratio 2.4
      expect(await w.calc(wide)).toMatchObject({ state: "unknown", reason: "range_too_wide", central: null });
      expect(await w.calc(await typ(60, 120.006))).toMatchObject({ state: "unknown", reason: "range_too_wide" }); // 2.0001
      await c.query("update app.nie_settings set value = 3 where key = 'max_range_ratio'");
      const again = await w.calc(wide);
      expect(again).toMatchObject({ state: "estimated", confidence: "low" });
      // The earlier record stays as it was; each record keeps the settings it used.
      const both = (await c.query("select state, inputs -> 'settings' ->> 'max_range_ratio' as limit from app.nie_calculations where model_id = $1 order by computed_at, state desc", [wide])).rows;
      expect(both).toEqual([{ state: "unknown", limit: "2.0" }, { state: "estimated", limit: "3" }]);
      expect((await err(c, "update app.nie_settings set value = 50 where key = 'max_range_ratio'")).code).toBe("23514");
    });
  });

  it("confidence bands follow their settings: 1.25 high, 1.5 medium, above low", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const typ = (lo: number, hi: number) => w.model({ quantityBasis: "editorial_typical", lines: [w.line(LENTILS_COOKED, { amountBasis: "typical", grams: 100, gramsLow: lo, gramsHigh: hi })] });
      expect((await w.calc(await typ(100, 125))).confidence).toBe("high"); // 1.25
      expect((await w.calc(await typ(100, 126))).confidence).toBe("medium"); // 1.26
      expect((await w.calc(await typ(100, 150))).confidence).toBe("medium"); // 1.5
      expect((await w.calc(await typ(100, 151))).confidence).toBe("low"); // 1.51
    });
  });
});

describe("N3-4 the same inputs always give the same record; records are permanent", () => {
  it("calculating twice returns the same record; the record cannot be edited or deleted", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const m = await w.model({ lines: [w.line(LENTILS_COOKED, { grams: 150 })] });
      const a = await one(c, "app.nie_calculate($1)", [m]);
      expect(await one(c, "app.nie_calculate($1)", [m])).toBe(a);
      expect((await err(c, "update app.nie_calculations set central = 99 where id = $1", [a])).message).toMatch(/permanent/);
      expect((await err(c, "delete from app.nie_calculations where id = $1", [a])).message).toMatch(/permanent/);
    });
  });
});

describe("N3-5 NIE-A: the restaurant's figure wins; a gap over 25 % goes to a person", () => {
  it("exactly 25 % is not flagged, just over is; above and below; the threshold is a setting", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const calcId = await one(c, "app.nie_calculate($1)", [await w.model({ lines: [w.line(LENTILS_COOKED, { grams: 150 }), w.line(TOFU, { usdaState: "raw", weighedAs: "raw", grams: 100 })] })]); // 30.8
      const cmp = async (p: number) => (await one(c, "app.nie_compare_published($1, $2)", [p, calcId])) as J;
      expect(await cmp(24.64)).toMatchObject({ comparable: true, needsReview: false }); // 6.16 / 24.64 = 0.25 exactly
      expect(await cmp(24.4)).toMatchObject({ needsReview: true }); // 6.4 / 24.4 = 0.262
      expect(await cmp(24.9)).toMatchObject({ needsReview: false }); // 5.9 / 24.9 = 0.237
      expect(await cmp(41.0)).toMatchObject({ needsReview: false }); // 10.2 / 41 = 0.2488
      expect(await cmp(41.1)).toMatchObject({ needsReview: true }); // 10.3 / 41.1 = 0.2506
      expect(Number((await cmp(24.64)).relativeGap)).toBe(0.25);
      await c.query("update app.nie_settings set value = 0.30 where key = 'disagreement_threshold'");
      expect(await cmp(24.4)).toMatchObject({ needsReview: false, threshold: 0.30 });
      expect(await one(c, "app.nie_compare_published(null, $1)", [calcId])).toEqual({ comparable: false });
    });
  });
});

describe("N3-6 one canonical record feeds dish pages, Protein Explorer and the diary", () => {
  async function draftDish(c: PoolClient) {
    const item = (await c.query("insert into public.food_items (kind, visibility, status, is_demo) values ('dish', 'public', 'draft', true) returning id")).rows[0].id;
    const rev = (await c.query("insert into public.food_revisions (food_item_id, revision_no, name, basis_kind, basis_amount, basis_unit) values ($1, 1, 'Demo NIE test bowl', 'serving', 1, 'serving') returning id", [item])).rows[0].id;
    await c.query("update public.food_items set current_revision_id = $1 where id = $2", [rev, item]);
    return rev as string;
  }

  it("an estimate is written with its bounds, confidence and calculation link, and stays hidden unless opted in", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const rev = await draftDish(c);
      const calcId = await one(c, "app.nie_calculate($1)", [await w.model({ quantityBasis: "editorial_typical", lines: [w.line(LENTILS_COOKED, { amountBasis: "typical", grams: 150, gramsLow: 120, gramsHigh: 180 })] })]);
      expect((await err(c, "select app.nie_apply_to_revision($1, $2, $3)", [w.publisher, calcId, rev])).message).toBe("NIE_ROLE_REQUIRED");
      await c.query("select app.nie_apply_to_revision($1, $2, $3)", [w.curator, calcId, rev]);
      const nv = (await c.query("select method, value::text, lower_value::text, upper_value::text, confidence, calculation_id, assumptions, source_record_id from public.nutrient_values where revision_id = $1 and nutrient_code = 'protein_g'", [rev])).rows[0];
      expect(nv).toMatchObject({ method: "estimated", value: "13.53", lower_value: "10.824", upper_value: "16.236", confidence: "medium", calculation_id: calcId });
      expect(nv.assumptions).toMatch(/not a statistical confidence interval/);
      const src = (await c.query("select s.publisher, s.source_type, r.external_id, r.content_hash from public.source_records r join public.sources s on s.id = r.source_id where r.id = $1", [nv.source_record_id])).rows[0];
      expect(src).toMatchObject({ publisher: "Nutrition engine calculation", source_type: "curator_assessment", external_id: calcId });
      // The same reader the dish page, Protein Explorer and the diary snapshot use:
      const hidden = await one(c, "app.protein_facts($1, false)", [rev]);
      expect(hidden.method).toBe("estimated");
      expect(hidden).toMatchObject({ basisValue: null, perServing: null, perServingReason: "estimate_hidden" }); // estimates are opt-in
      const shown = await one(c, "app.protein_facts($1, true)", [rev]);
      expect(Number(shown.basisValue)).toBe(13.53);
    });
  });

  it("a calculated figure is written without bounds; an unknown is null with a reason; a published figure is never overwritten", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const rev = await draftDish(c);
      const calcId = await one(c, "app.nie_calculate($1)", [await w.model({ lines: [w.line(LENTILS_COOKED, { grams: 150 })] })]);
      await c.query("select app.nie_apply_to_revision($1, $2, $3)", [w.curator, calcId, rev]);
      expect((await c.query("select method, value::text, lower_value, upper_value, confidence from public.nutrient_values where revision_id = $1 and nutrient_code = 'protein_g'", [rev])).rows[0])
        .toEqual({ method: "calculated", value: "13.53", lower_value: null, upper_value: null, confidence: null });
      const unk = await one(c, "app.nie_calculate($1)", [await w.model({ lines: [w.line(RICE_RAW, { usdaState: "raw", weighedAs: "cooked", grams: 158 })] })]);
      await c.query("select app.nie_apply_to_revision($1, $2, $3)", [w.curator, unk, rev]);
      expect((await c.query("select method, value, missing_reason from public.nutrient_values where revision_id = $1 and nutrient_code = 'protein_g'", [rev])).rows[0])
        .toEqual({ method: "unknown", value: null, missing_reason: "incomplete_recipe" });
      // A restaurant-published figure wins.
      const src = (await c.query("insert into public.sources (publisher, source_type, is_demo) values ('Demo restaurant', 'menu', true) returning id")).rows[0].id;
      const rec = (await c.query("insert into public.source_records (source_id, observed_at, rights_status) values ($1, now(), 'cleared') returning id", [src])).rows[0].id;
      await c.query("update public.nutrient_values set value = 20, missing_reason = null, method = 'published', source_record_id = $2, calculation_id = null where revision_id = $1 and nutrient_code = 'protein_g'", [rev, rec]);
      expect((await err(c, "select app.nie_apply_to_revision($1, $2, $3)", [w.curator, calcId, rev])).message).toBe("NIE_PUBLISHED_FIGURE_WINS");
      // Published revisions stay frozen (existing rule).
      await c.query("delete from public.nutrient_values where revision_id = $1", [rev]);
      await c.query("update public.food_revisions set published_at = now() where id = $1", [rev]);
      expect((await err(c, "select app.nie_apply_to_revision($1, $2, $3)", [w.curator, calcId, rev])).code).toBe("PT403");
    });
  });
});

describe("N3-7 closed to visitors and members", () => {
  it("guests and members cannot read models, calculations or settings, or call any nie function", async () => {
    await tx(async (c) => {
      const fns = (await c.query(`select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname like 'nie\\_%'`)).rows.map((r) => r.sig as string);
      expect(fns.length).toBeGreaterThanOrEqual(8);
      for (const role of ["anon", "authenticated"]) {
        for (const sig of fns) expect(await one(c, "has_function_privilege($1, $2, 'execute')", [role, sig]), `${role} ${sig}`).toBe(false);
        for (const t of ["nie_settings", "nie_dish_models", "nie_model_lines", "nie_calculations"]) {
          expect(await one(c, "has_table_privilege($1, $2, 'select')", [role, `app.${t}`]), `${role} ${t}`).toBe(false);
        }
      }
    });
  });
});
