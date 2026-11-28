import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../helpers/db";
import { fromSrLegacyCsv, parseCsv } from "../../scripts/lib/usda-normalize.mjs";
import { prepareRelease, writeRelease } from "../../scripts/lib/usda-import-lib.mjs";

// USDA protein estimates for drafted complete meals (owner direction 18 Nov 2026 20:56 UTC; migration
// 20261118001600). Typical amounts only, never for a meal with a restaurant protein figure, never
// dietary evidence, previewed with the same arithmetic as recorded calculations, founder-only.
// USDA SR Legacy fixture values per 100 g protein: lentils cooked 9.02 (172421), tofu firm 17.27
// (172475), rice cooked 2.69 (168878).

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
const one = async (c: PoolClient, sql: string, params: unknown[] = []) => (await c.query(`select ${sql} as r`, params)).rows[0].r;
const fails = async (c: PoolClient, sql: string, params: unknown[] = []) => {
  await c.query("savepoint s");
  try {
    await c.query(sql, params);
  } catch (e) {
    await c.query("rollback to savepoint s");
    return (e as { message: string }).message;
  }
  throw new Error(`Expected to fail: ${sql}`);
};
async function as(c: PoolClient, uid: string | null, sql: string, params: unknown[] = []) {
  await c.query(uid ? "set local role authenticated" : "set local role anon");
  if (uid) await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
  const rows = (await c.query(sql, params)).rows;
  await c.query("reset role");
  return rows;
}
async function asFails(c: PoolClient, uid: string | null, sql: string, params: unknown[] = []) {
  await c.query("savepoint s");
  try {
    await as(c, uid, sql, params);
  } catch (e) {
    await c.query("rollback to savepoint s");
    return (e as { message: string }).message;
  }
  throw new Error(`Expected to fail: ${sql}`);
}

const META = { dataset: "sr_legacy", releaseLabel: "2099-05", fileName: "FoodData_Central_sr_legacy_food_csv_est.zip", sha256: "7".repeat(64), sourceUrl: "https://fdc.nal.usda.gov/fdc-datasets/est.zip" };
const sr = () => {
  const dir = "tests/fixtures/usda/sr-sample";
  const t = Object.fromEntries(readdirSync(dir).map((f) => [f.replace(/\.csv$/, ""), parseCsv(readFileSync(`${dir}/${f}`, "utf8"))]));
  return prepareRelease(META, fromSrLegacyCsv(t));
};
const LENTILS = 172421, TOFU = 172475, RICE = 168878;

async function user(c: PoolClient, roles: string[]) {
  const id = randomUUID();
  await c.query(
    `insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}', '{}', now(), now())`,
    [id, `est-${id.slice(0, 8)}@example.test`],
  );
  for (const r of roles) await c.query("insert into public.role_assignments (user_id, role) values ($1, $2)", [id, r]);
  return id;
}

async function world(c: PoolClient) {
  const { releaseId } = await writeRelease(c, sr());
  const curator = await user(c, ["curator"]);
  const founder = await user(c, ["publisher"]);
  await c.query(
    "insert into staging.source_access (host, kind, status, evidence, reviewer, reviewed_at) values ('pilot-est.test', 'owner_decision', 'private_pilot', 'Test evidence', 'Test reviewer', now())",
  );
  const place = await one(c, "staging.add_place($1, 'Estimate Test Place', 'back_bay', 1::smallint)", [curator]);
  const src = await one(c, "staging.add_source_page($1, 'https://pilot-est.test/menu', 'restaurant_site', 'Test', now())", [curator]);
  const today = (await c.query("select (now() at time zone 'America/New_York')::date::text d")).rows[0].d as string;
  const submit = (dishId: string, p: J) =>
    one(c, "staging.submit_fact($1, $2::jsonb)", [curator, JSON.stringify({ placeId: place, dishId, sourcePageId: src, checkedOn: today, confidence: "high", ...p })]);
  const meal = async (label: string, type = "complete_meal", ingredients: string[] | null = ["lentils", "rice"]) => {
    const d = await one(c, "staging.add_dish($1, $2, $3)", [curator, place, label]);
    await c.query("select staging.classify_dish($1, $2, $3, null, 'Mains', null, 'source_section', null)", [curator, d, type]);
    if (ingredients) await submit(d, { kind: "listed_ingredients", value: { items: ingredients } });
    return d as string;
  };
  const line = (fdcId: number, grams: number, low: number, high: number, p: J = {}) => ({
    label: `food ${fdcId}`, usdaReleaseId: releaseId, fdcId, usdaState: "cooked", weighedAs: "cooked", amountBasis: "typical", grams, gramsLow: low, gramsHigh: high, ...p,
  });
  const model = async (lines: J[], p: J = {}) =>
    (await one(c, "app.nie_create_model($1, $2::jsonb)", [curator, JSON.stringify({ label: "Estimate test", quantityBasis: "editorial_typical", servingBasis: "typical", assumptions: "Typical amounts for the test.", lines, ...p })])) as string;
  const link = (dish: string, m: string | null, evidence: string | null = "listed_ingredients", reason: string | null = null, actor = curator) =>
    c.query("select staging.link_dish_estimate($1, $2, $3, $4, $5)", [actor, dish, m, evidence, reason]);
  const review = async () => ((await as(c, founder, "select public.menu_review_place($1) r", [place]))[0].r as J).dishes as J[];
  return { releaseId, curator, founder, place, src, today, submit, meal, line, model, link, review };
}

afterAll(async () => {
  await pool.end();
});

describe("USDA estimates for drafted meals", () => {
  it("links a typical-amount model to a complete meal and shows the range, labelled, in the founder's review", () =>
    tx(async (c) => {
      const w = await world(c);
      const d = await w.meal("Lentil stew");
      // lentils 200 g (150 to 250) = 18.04 (13.53 to 22.55); rice 150 g (120 to 180) = 4.035 (3.228 to 4.842)
      const m = await w.model([w.line(LENTILS, 200, 150, 250), w.line(RICE, 150, 120, 180)]);
      await w.link(d, m);
      const row = (await w.review()).find((x) => x.label === "Lentil stew")!;
      expect(row.estimate).toMatchObject({ state: "modelled", modelId: m, evidence: "listed_ingredients", modelStatus: "draft", assumptions: "Typical amounts for the test." });
      expect(row.estimate.lines).toHaveLength(2);
      expect(row.estimate.lines[0]).toMatchObject({ fdcId: LENTILS, grams: 200, gramsLow: 150, gramsHigh: 250, amountBasis: "typical", release: "sr_legacy 2099-05" });
      expect(row.estimate.result).toMatchObject({ state: "estimated", confidence: "low" });
      expect(Number(row.estimate.result.central)).toBeCloseTo(22.075, 3);
      expect(Number(row.estimate.result.low)).toBeCloseTo(16.758, 3);
      expect(Number(row.estimate.result.high)).toBeCloseTo(27.392, 3);
      // No fact was added, and no dietary status came from the estimate.
      expect(row.facts.map((f: J) => f.kind)).toEqual(["listed_ingredients"]);
      expect((await c.query("select count(*)::int n from staging.events where action = 'link_estimate' and place_id = $1", [w.place])).rows[0].n).toBe(1);
    }));

  it("previews a draft with exactly the arithmetic that a recorded calculation uses", () =>
    tx(async (c) => {
      const w = await world(c);
      const m = await w.model([w.line(TOFU, 150, 110, 190, { usdaState: "raw", weighedAs: "raw" }), w.line(RICE, 200, 150, 250)]);
      const preview = (await one(c, "app.nie_protein_math($1)", [m])) as J;
      const other = await user(c, ["publisher"]);
      await c.query("select app.nie_publish_model($1, $2)", [other, m]);
      const calcId = await one(c, "app.nie_calculate($1)", [m]);
      const calc = (await c.query("select * from app.nie_calculations where id = $1", [calcId])).rows[0] as J;
      expect(preview.state).toBe(calc.state);
      for (const k of ["central", "low", "high"]) expect(Number(preview[k])).toBe(Number(calc[k]));
      expect(preview.confidence).toBe(calc.confidence);
      expect(preview.lines).toEqual(calc.lines);
    }));

  it("keeps unknown as unknown, with the reason, and marks too-wide ranges unknown", () =>
    tx(async (c) => {
      const w = await world(c);
      const a = await w.meal("Vegetable curry", "complete_meal", null);
      await w.link(a, null, null, "The menu says only vegetables.");
      const b = await w.meal("Wide bowl");
      await w.link(b, await w.model([w.line(LENTILS, 200, 50, 300)]));
      const rows = Object.fromEntries((await w.review()).map((x) => [x.label, x]));
      expect(rows["Vegetable curry"].estimate).toMatchObject({ state: "unknown", reason: "The menu says only vegetables." });
      expect(rows["Wide bowl"].estimate.result).toMatchObject({ state: "unknown", reason: "range_too_wide", central: null, low: null, high: null });
    }));

  it("refuses parts, meals with the restaurant's own protein, the restaurant's quantities, and missing evidence", () =>
    tx(async (c) => {
      const w = await world(c);
      const m = await w.model([w.line(LENTILS, 200, 150, 250)]);
      const side = await w.meal("Side of lentils", "side");
      expect(await fails(c, "select staging.link_dish_estimate($1, $2, $3, 'listed_ingredients', null)", [w.curator, side, m])).toMatch("STAGING_NOT_A_COMPLETE_MEAL");
      for (const value of [
        { nutrient: "protein_g", amount: "21", per: "serving" },
        { nutrient: "protein_g", low: "12", high: "18", per: "serving", basis: "published_range" },
        { nutrient: "protein_g", amount: "9", per: "serving", basis: "restaurant_estimate" },
      ]) {
        const d = await w.meal(`Published ${value.basis ?? "value"}`);
        await w.submit(d, { kind: "published_nutrition", subject: "protein_g", value });
        expect(await fails(c, "select staging.link_dish_estimate($1, $2, $3, 'listed_ingredients', null)", [w.curator, d, m])).toMatch("STAGING_HAS_RESTAURANT_PROTEIN");
      }
      const d = await w.meal("Plain stew");
      const verified = await one(c, "app.nie_create_model($1, $2::jsonb)", [w.curator, JSON.stringify({ label: "x", quantityBasis: "restaurant_verified", servingBasis: "stated", assumptions: "x", lines: [{ ...w.line(LENTILS, 200, 200, 200), amountBasis: "stated" }] })]);
      expect(await fails(c, "select staging.link_dish_estimate($1, $2, $3, 'listed_ingredients', null)", [w.curator, d, verified])).toMatch("STAGING_ESTIMATE_NOT_TYPICAL");
      const bare = await w.model([w.line(LENTILS, 200, 150, 250)], { assumptions: null });
      expect(await fails(c, "select staging.link_dish_estimate($1, $2, $3, 'listed_ingredients', null)", [w.curator, d, bare])).toMatch("STAGING_ESTIMATE_NEEDS_ASSUMPTIONS");
      expect(await fails(c, "select staging.link_dish_estimate($1, $2, $3, null, null)", [w.curator, d, m])).toMatch("STAGING_ESTIMATE_NEEDS_EVIDENCE");
      const noList = await w.meal("Tofu masala", "complete_meal", null);
      expect(await fails(c, "select staging.link_dish_estimate($1, $2, $3, 'listed_ingredients', null)", [w.curator, noList, m])).toMatch("STAGING_NO_LISTED_INGREDIENTS");
      await c.query("select staging.link_dish_estimate($1, $2, $3, 'dish_name', null)", [w.curator, noList, m]);
      expect(await fails(c, "select staging.link_dish_estimate($1, $2, null, null, '  ')", [w.curator, d])).toMatch("STAGING_UNKNOWN_NEEDS_REASON");
      expect(await fails(c, "select staging.link_dish_estimate($1, $2, $3, 'listed_ingredients', 'both')", [w.curator, d, m])).toMatch("STAGING_MODEL_OR_REASON");
      expect(await fails(c, "select staging.link_dish_estimate($1, $2, $3, 'listed_ingredients', null)", [w.founder, d, m])).toMatch(/role|curator|STAGING_/i);
    }));

  it("is append-only and invisible to signed-in people and visitors", () =>
    tx(async (c) => {
      const w = await world(c);
      const d = await w.meal("Lentil stew");
      await w.link(d, await w.model([w.line(LENTILS, 200, 150, 250)]));
      await w.link(d, null, null, "Replaced: ingredients were misread.");
      expect((await w.review())[0].estimate).toMatchObject({ state: "unknown" });
      expect((await c.query("select count(*)::int n from staging.dish_estimates where dish_id = $1", [d])).rows[0].n).toBe(2);
      expect(await fails(c, "update staging.dish_estimates set unknown_reason = 'x' where dish_id = $1", [d])).toMatch("APPEND_ONLY");
      expect(await fails(c, "delete from staging.dish_estimates where dish_id = $1", [d])).toMatch("APPEND_ONLY");
      const other = await user(c, []);
      for (const uid of [w.founder, other, null]) expect(await asFails(c, uid, "select * from staging.dish_estimates")).toMatch(/permission denied/);
      for (const fn of [
        "staging.link_dish_estimate($1, $1, null, null, 'x')",
        "staging.current_estimate($1)",
        "staging.estimate_json($1)",
        "staging.has_restaurant_protein($1)",
        "app.nie_protein_math($1)",
      ])
        expect(await asFails(c, w.founder, `select ${fn}`, [d])).toMatch(/permission denied/);
      expect(await asFails(c, other, "select public.menu_review_place($1)", [w.place])).toMatch("FOUNDER_ONLY");
      expect(await asFails(c, null, "select public.menu_review_place($1)", [w.place])).toMatch(/permission denied|NOT_SIGNED_IN/);
    }));
});
