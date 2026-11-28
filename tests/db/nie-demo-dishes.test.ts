import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../helpers/db";
import { DISHES, demoRelease, loadDemoDishes } from "../../scripts/lib/nie-demo-dishes.mjs";

// NIE N-5 (docs/24 section 4): ten synthetic Boston-style demo dishes through the engine end to end,
// the 25 % comparison with a restaurant's own figure (NIE-A), and the speed target (300 ms per call).
// Every expected number is worked out by hand in scripts/lib/nie-demo-dishes.mjs beside the dish.
// Each test runs in ONE rolled-back transaction.

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
async function err(c: PoolClient, sql: string, params: unknown[] = []) {
  await c.query("savepoint e");
  try {
    await c.query(sql, params);
  } catch (e) {
    await c.query("rollback to savepoint e");
    return e as { message: string };
  }
  throw new Error(`expected to fail: ${sql}`);
}
async function user(c: PoolClient, roles: string[]) {
  const id = randomUUID();
  await c.query(
    `insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}', '{}', now(), now())`,
    [id, `n5-${id.slice(0, 8)}@example.test`],
  );
  for (const r of roles) await c.query("insert into public.role_assignments (user_id, role) values ($1, $2)", [id, r]);
  return id;
}
async function as<T>(c: PoolClient, uid: string | null, fn: () => Promise<T>): Promise<T> {
  await c.query(uid ? "set local role authenticated" : "set local role anon");
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(uid ? { sub: uid, role: "authenticated" } : { role: "anon" })]);
  try {
    return await fn();
  } finally {
    await c.query("reset role");
  }
}
async function world(c: PoolClient) {
  const curator = await user(c, ["curator"]);
  const publisher = await user(c, ["publisher"]);
  const releaseId = await demoRelease(c, { allowExcerpt: true });
  const loaded = await loadDemoDishes(c, { curator, publisher, releaseId });
  return { curator, publisher, releaseId, loaded };
}
const close = (a: unknown, b: number) => expect(Math.abs(Number(a) - b)).toBeLessThan(0.000001);

afterAll(async () => {
  await pool.end();
});

describe("N5-1 ten demo dishes, each figure as worked out by hand", () => {
  it("calculated, estimated, unknown and restaurant-published dishes come out exactly, and stay apart", async () => {
    await tx(async (c) => {
      const w = await world(c);
      expect(w.loaded).toHaveLength(10);
      expect(new Set(DISHES.map((d) => d.expect.state))).toEqual(new Set(["calculated", "estimated_range", "unknown", "restaurant_published"]));
      for (const d of DISHES) {
        const e = await as(c, null, () => one(c, "public.protein_explanation($1, true, true)", [d.id]));
        expect(e.state, d.name).toBe(d.expect.state);
        if (d.expect.value === null) expect(e.value, d.name).toBeNull();
        else close(e.value, d.expect.value);
        if (d.expect.state === "estimated_range") {
          close(e.low, d.expect.low!);
          close(e.high, d.expect.high!);
          expect(e.confidence, d.name).toBe(d.expect.confidence);
        } else {
          expect(e.low, d.name).toBeNull();
          expect(e.high, d.name).toBeNull();
        }
        if (d.expect.state === "calculated") {
          expect(e.calculation.quantityBasis).toBe("restaurant_verified");
          expect(e.calculation.lines.length).toBe(d.model.lines.length);
          expect(e.calculation.references[0].dataset).toBe("sr_legacy");
        }
        if (d.expect.state === "restaurant_published") expect(e.calculation, d.name).toBeNull(); // our calculation never replaces theirs
      }
      // Estimates are hidden unless the visitor asks: no number, range or ingredient line leaks.
      for (const d of DISHES.filter((x) => x.expect.state === "estimated_range")) {
        const hidden = await as(c, null, () => one(c, "public.protein_explanation($1, true, false)", [d.id]));
        expect(hidden).toMatchObject({ state: "estimate_hidden", value: null, low: null, high: null, calculation: null });
      }
      // Every demo dish is marked as demo, and none is visible without demo data switched on.
      expect(await one(c, "(select bool_and(is_demo) from public.food_items where id = any($1::uuid[]))", [DISHES.map((d) => d.id)])).toBe(true);
      expect((await as(c, null, () => err(c, "select public.protein_explanation($1, false, true)", [DISHES[0].id]))).message).toBe("FOOD_NOT_FOUND");
    });
  });

  it("the same inputs give the same record; loading again adds nothing", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const again = await loadDemoDishes(c, { curator: w.curator, publisher: w.publisher, releaseId: w.releaseId });
      expect(again.every((x: J) => x.skipped)).toBe(true);
      const calcs = await one(c, "(select count(*)::int from app.nie_calculations where id = any($1::uuid[]))", [w.loaded.map((x: J) => x.calculationId)]);
      expect(calcs).toBe(10);
    });
  });
});

describe("N5-2 a restaurant's own figure against our calculation (NIE-A, 25 %)", () => {
  it("a gap under 25 % is recorded but needs no one; over 25 % goes to a person; the restaurant's figure is shown either way", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const wrap = w.loaded.find((x: J) => x.name === "Demo egg, spinach and feta wrap")!.check;
      const tofu = w.loaded.find((x: J) => x.name === "Demo tofu scramble")!.check;
      expect(wrap.needsReview).toBe(false);
      close(wrap.relativeGap, 1.791 / 22);
      expect(Number(wrap.shown)).toBe(22);
      expect(tofu.needsReview).toBe(true);
      close(tofu.relativeGap, 8.763 / 18);
      expect(Number(tofu.shown)).toBe(18);

      const desk = await as(c, w.curator, () => one(c, "public.editor_nutrition_checks()"));
      expect(desk.map((x: J) => x.name)).toEqual(["Demo tofu scramble"]);
      expect(desk[0]).toMatchObject({ published: 18, threshold: 0.25 });
      close(desk[0].calculated, 26.763);

      // Closed by a different person with a reason; the shown figure does not change.
      expect((await err(c, "select app.nie_resolve_check($1, $2, 'restaurant_figure_stands', 'Checked the menu')", [w.curator, tofu.checkId])).message).toMatch(/NIE_ROLE|role/i);
      expect((await err(c, "select app.nie_resolve_check($1, $2, 'restaurant_figure_stands', 'x')", [w.publisher, tofu.checkId])).message).toBe("REASON_REQUIRED");
      await c.query("select app.nie_resolve_check($1, $2, 'restaurant_figure_stands', 'Demo: the menu figure is for a smaller serving')", [w.publisher, tofu.checkId]);
      expect(await as(c, w.curator, () => one(c, "public.editor_nutrition_checks()"))).toEqual([]);
      const e = await as(c, null, () => one(c, "public.protein_explanation($1, true, true)", ["00000000-0000-4000-8000-0000000e5010"]));
      expect(e).toMatchObject({ state: "restaurant_published", value: 18 });
      expect((await err(c, "select app.nie_resolve_check($1, $2, 'model_corrected', 'Again')", [w.publisher, tofu.checkId])).message).toBe("NIE_NOTHING_TO_RESOLVE");
      // The comparison record is permanent.
      expect((await err(c, "update app.nie_published_checks set published_value = 30 where id = $1", [tofu.checkId])).message).toMatch(/permanent/);
      expect((await err(c, "delete from app.nie_published_checks where id = $1", [wrap.checkId])).message).toMatch(/permanent/);
    });
  });

  it("guests and ordinary members cannot read the comparisons; a dish without a restaurant figure cannot be compared", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const member = await user(c, []);
      expect((await as(c, null, () => err(c, "select public.editor_nutrition_checks()"))).message).toMatch(/permission denied|FORBIDDEN|SIGN_IN/);
      expect((await as(c, member, () => err(c, "select public.editor_nutrition_checks()"))).message).toBe("FORBIDDEN");
      const calc = w.loaded.find((x: J) => x.name === "Demo chickpea and quinoa bowl")!.calculationId;
      expect((await err(c, "select app.nie_check_published($1, $2, $3)", [w.curator, DISHES[0].id, calc])).message).toBe("NIE_NO_PUBLISHED_FIGURE");
      for (const role of ["anon", "authenticated"]) {
        expect(await one(c, "has_function_privilege($1, 'app.nie_check_published(uuid, uuid, uuid)', 'execute')", [role])).toBe(false);
        expect(await one(c, "has_table_privilege($1, 'app.nie_published_checks', 'select')", [role])).toBe(false);
      }
    });
  });
});

describe("N5-3 speed (target: every call under 300 ms)", () => {
  it("dish page, protein explanation and filtered search stay fast with the demo dishes loaded", async () => {
    await tx(async (c) => {
      await world(c);
      const time = async (sql: string, params: unknown[]) => {
        const runs: number[] = [];
        for (let i = 0; i < 7; i++) {
          const t = performance.now();
          await as(c, null, () => c.query(sql, params));
          runs.push(performance.now() - t);
        }
        return Math.max(...runs.slice(1)); // first run warms the cache
      };
      for (const d of DISHES) {
        expect(await time("select public.protein_explanation($1, true, true)", [d.id]), d.name).toBeLessThan(300);
        expect(await time("select public.food_detail($1, true, true)", [d.id]), d.name).toBeLessThan(300);
      }
      expect(await time("select public.search_catalog($1::jsonb)", [JSON.stringify({ includeDemo: true, q: "Demo", limit: 50 })])).toBeLessThan(300);
    });
  });
});
