import { afterAll, describe, expect, it } from "vitest";
import pg, { type PoolClient } from "pg";

// Dish structure and nutrition bases (owner direction 18 Nov 2026 19:19 UTC; migration
// 20261118001500). Parts of a build-your-own meal are never meals; ranges stay ranges; only a single
// published figure can be verified; everything stays private to the founder's screens.

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
});
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function tx(fn: (c: PoolClient) => Promise<void>) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await fn(c);
  } finally {
    await c.query("rollback");
    c.release();
  }
}
const one = async (c: PoolClient, sql: string, params: unknown[] = []) =>
  (await c.query(`select ${sql} as r`, params)).rows[0].r;
async function user(c: PoolClient, roles: string[]) {
  const id = (
    await c.query(
      "insert into auth.users (id, email) values (gen_random_uuid(), 'ds-' || gen_random_uuid() || '@example.test') returning id",
    )
  ).rows[0].id;
  for (const r of roles)
    await c.query(
      "insert into public.role_assignments (user_id, role) values ($1, $2)",
      [id, r],
    );
  return id as string;
}
async function as(
  c: PoolClient,
  uid: string | null,
  sql: string,
  params: unknown[] = [],
) {
  await c.query(uid ? "set local role authenticated" : "set local role anon");
  if (uid)
    await c.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: uid, role: "authenticated" }),
    ]);
  const rows = (await c.query(sql, params)).rows;
  await c.query("reset role");
  return rows;
}
async function asFails(
  c: PoolClient,
  uid: string | null,
  sql: string,
  params: unknown[] = [],
) {
  await c.query("savepoint s");
  try {
    await as(c, uid, sql, params);
  } catch (e) {
    await c.query("rollback to savepoint s");
    return (e as { message: string }).message;
  }
  throw new Error(`Expected to fail: ${sql}`);
}
const access = (
  c: PoolClient,
  host: string,
  kind: string,
  status: string,
  at = "now()",
) =>
  c.query(
    `insert into staging.source_access (host, kind, status, evidence, permitted_uses, reviewer, reviewed_at)
           values ($1, $2, $3, 'Test evidence', ${status === "permits" ? "'tests'" : "null"}, 'Test reviewer', ${at})`,
    [host, kind, status],
  );

async function world(c: PoolClient) {
  const curator = await user(c, ["curator"]);
  const founder = await user(c, ["publisher"]);
  await access(c, "pilot-ds.test", "owner_decision", "private_pilot");
  await access(c, "cleared-ds.test", "terms_review", "permits");
  const place = await one(c, "staging.add_place($1, 'Dish Structure Test Place', 'back_bay', 1::smallint)", [curator]);
  const dish = (label: string) => one(c, "staging.add_dish($1, $2, $3)", [curator, place, label]);
  const pilot = await one(c, "staging.add_source_page($1, 'https://pilot-ds.test/menu', 'restaurant_site', 'Test', now())", [curator]);
  const cleared = await one(c, "staging.add_source_page($1, 'https://cleared-ds.test/menu', 'restaurant_site', 'Test', now())", [curator]);
  const today = (await c.query("select (now() at time zone 'America/New_York')::date::text d")).rows[0].d as string;
  const submit = (dishId: string, src: string, p: Record<string, unknown>) =>
    one(c, "staging.submit_fact($1, $2::jsonb)", [curator, JSON.stringify({ placeId: place, dishId, sourcePageId: src, checkedOn: today, ...p })]);
  const classify = (d: string, type: string, parent: string | null = null) =>
    one(c, "staging.classify_dish($1, $2, $3, $4, 'Bowls', null, 'source_section', null)", [curator, d, type, parent]);
  return { curator, founder, place, dish, pilot, cleared, today, submit, classify };
}
const fails = async (c: PoolClient, sql: string, params: unknown[]) => {
  await c.query("savepoint s");
  try {
    await c.query(sql, params);
  } catch (e) {
    await c.query("rollback to savepoint s");
    return (e as { message: string }).message;
  }
  throw new Error(`Expected to fail: ${sql}`);
};
const review = async (c: PoolClient, founder: string, place: string) =>
  ((await as(c, founder, "select public.menu_review_place($1) r", [place]))[0].r as J).dishes as J[];

afterAll(async () => {
  await pool.end();
});

describe("dish structure", () => {
  it("records a build-your-own meal with its parts and options, newest classification wins, history kept", () =>
    tx(async (c) => {
      const w = await world(c);
      const bowl = await w.dish("Build your own bowl");
      const rice = await w.dish("Brown rice");
      const tofu = await w.dish("Tofu");
      await w.classify(bowl, "customizable_meal");
      await w.classify(rice, "component");
      await w.classify(rice, "base", bowl);
      await w.classify(tofu, "protein", bowl);
      await one(c, "staging.add_dish_option($1, $2, 'add', 'Extra tofu', $3, $4::date, $5, '3.00')", [w.curator, bowl, w.pilot, w.today, tofu]);
      const dishes = await review(c, w.founder, w.place);
      const byLabel = Object.fromEntries(dishes.map((d) => [d.label, d]));
      expect(byLabel["Build your own bowl"].structure).toMatchObject({ type: "customizable_meal", parentDishId: null, section: "Bowls", basis: "source_section" });
      expect(byLabel["Build your own bowl"].options).toEqual([
        { kind: "add", label: "Extra tofu", componentDishId: tofu, priceDeltaUsd: "3.00", sourceId: w.pilot },
      ]);
      expect(byLabel["Brown rice"].structure).toMatchObject({ type: "base", parentDishId: bowl });
      expect((await c.query("select count(*)::int n from staging.dish_structure where dish_id = $1", [rice])).rows[0].n).toBe(2);
      expect((await c.query("select count(*)::int n from staging.events where action in ('classify_dish', 'add_dish_option') and place_id = $1", [w.place])).rows[0].n).toBe(5);
    }));

  it("refuses a meal inside a meal, a part under a non-customizable dish, and reclassifying a meal that has parts", () =>
    tx(async (c) => {
      const w = await world(c);
      const bowl = await w.dish("Bowl A");
      const plate = await w.dish("Plate B");
      const part = await w.dish("Part C");
      await w.classify(bowl, "customizable_meal");
      await w.classify(plate, "complete_meal");
      await w.classify(part, "component", bowl);
      expect(await fails(c, "select staging.classify_dish($1, $2, 'complete_meal', $3)", [w.curator, plate, bowl])).toMatch(/check/);
      expect(await fails(c, "select staging.classify_dish($1, $2, 'component', $3)", [w.curator, part, plate])).toMatch("STAGING_PARENT_NOT_CUSTOMIZABLE");
      expect(await fails(c, "select staging.classify_dish($1, $2, 'side')", [w.curator, bowl])).toMatch("STAGING_HAS_PARTS");
      expect(await fails(c, "select staging.classify_dish($1, $2, 'side')", [w.founder, part])).toMatch(/STAGING_|role|curator/i);
      expect(await fails(c, "update staging.dish_structure set dish_type = 'side' where dish_id = $1", [part])).toMatch("APPEND_ONLY");
      expect(await fails(c, "delete from staging.dish_structure where dish_id = $1", [part])).toMatch("APPEND_ONLY");
    }));

  it("keeps the new tables unreadable to signed-in people and visitors", () =>
    tx(async (c) => {
      const w = await world(c);
      for (const t of ["staging.dish_structure", "staging.dish_options"]) {
        expect(await asFails(c, w.founder, `select * from ${t}`)).toMatch(/permission denied/);
        expect(await asFails(c, null, `select * from ${t}`)).toMatch(/permission denied/);
      }
      for (const fn of ["staging.classify_dish($1, $1, 'side')", "staging.current_structure($1)"]) {
        expect(await asFails(c, w.founder, `select ${fn}`, [w.place])).toMatch(/permission denied/);
      }
    }));
});

describe("nutrition bases", () => {
  it("accepts single values, ranges and restaurant estimates, and refuses malformed ranges", () =>
    tx(async (c) => {
      const w = await world(c);
      const d = await w.dish("Range bowl");
      await w.submit(d, w.pilot, { kind: "published_nutrition", subject: "protein_g", value: { nutrient: "protein_g", low: "12", high: "18", per: "serving", basis: "published_range" }, confidence: "high" });
      await w.submit(d, w.pilot, { kind: "published_nutrition", subject: "energy_kcal", value: { nutrient: "energy_kcal", amount: "640", per: "serving", basis: "restaurant_estimate" }, confidence: "medium" });
      await w.submit(d, w.pilot, { kind: "published_nutrition", subject: "fat_g", value: { nutrient: "fat_g", amount: "9", per: "serving", portion: "3 oz" }, confidence: "high" });
      for (const bad of [
        { nutrient: "carb_g", low: "18", high: "12", per: "serving", basis: "published_range" },
        { nutrient: "carb_g", amount: "15", low: "12", high: "18", per: "serving", basis: "published_range" },
        { nutrient: "carb_g", per: "serving", basis: "restaurant_estimate" },
        { nutrient: "carb_g", amount: "15", per: "serving", basis: "usda_estimate" },
        { nutrient: "carb_g", amount: "15", per: "serving", portion: "x".repeat(41) },
      ])
        expect(await fails(c, "select staging.submit_fact($1, $2::jsonb)", [w.curator, JSON.stringify({ placeId: w.place, dishId: d, sourcePageId: w.pilot, checkedOn: w.today, kind: "published_nutrition", subject: "carb_g", value: bad })])).toMatch(/STAGING_|check|invalid/i);
    }));

  it("only a single published value from a cleared source can be verified; a range or estimate can be matched privately", () =>
    tx(async (c) => {
      const w = await world(c);
      const d = await w.dish("Cleared bowl");
      const single = await w.submit(d, w.cleared, { kind: "published_nutrition", subject: "protein_g", value: { nutrient: "protein_g", amount: "21", per: "serving" }, confidence: "high" });
      const range = await w.submit(d, w.cleared, { kind: "published_nutrition", subject: "fiber_g", value: { nutrient: "fiber_g", low: "4", high: "7", per: "serving", basis: "published_range" }, confidence: "high" });
      const pilotDish = await w.dish("Pilot bowl");
      const est = await w.submit(pilotDish, w.pilot, { kind: "published_nutrition", subject: "protein_g", value: { nutrient: "protein_g", amount: "9", per: "serving", basis: "restaurant_estimate" }, confidence: "medium" });
      const facts = (await review(c, w.founder, w.place)).flatMap((x) => x.facts as J[]);
      const of = (id: string) => facts.find((f) => f.factId === id)!;
      expect(of(single)).toMatchObject({ confirmAs: "verify", canConfirm: true });
      expect(of(range)).toMatchObject({ confirmAs: null, canConfirm: false, canReject: true });
      expect(of(est)).toMatchObject({ confirmAs: "transcription", canConfirm: true });
      expect(await asFails(c, w.founder, "select public.menu_review_decide($1::jsonb)", [JSON.stringify([{ factId: range, decision: "verify" }])])).toMatch("STAGING_NOT_A_SINGLE_PUBLISHED_VALUE");
      const [{ r }] = await as(c, w.founder, "select public.menu_review_decide($1::jsonb) r", [
        JSON.stringify([{ factId: single, decision: "verify" }, { factId: est, decision: "confirm_transcription" }]),
      ]);
      expect(r).toEqual({ verified: 1, rejected: 0, transcribed: 1 });
      expect((await c.query("select status from staging.facts where id = $1", [est])).rows[0].status).toBe("submitted");
      expect((await c.query("select count(*)::int n from staging.publications where place_id = $1", [w.place])).rows[0].n).toBe(0);
    }));
});
