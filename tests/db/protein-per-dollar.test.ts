import { afterAll, describe, expect, it } from "vitest";
import { asMember, pool } from "../helpers/db";

// Protein per dollar (migration 20261118000800, docs/53). Seeded demo dishes with a dated price:
//   chickpea power bowl 24 g / $13.50 = 1.78 g per $1; paneer tikka 26 g / $15.00 = 1.73;
//   soft tofu stew 22 g / $14.00 = 1.57; masala dosa 9 g / $11.00 = 0.82.

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const BOWL = "00000000-0000-4000-8000-000000000201";
const PANEER = "00000000-0000-4000-8000-000000000801";
const STEW = "00000000-0000-4000-8000-000000001501";
const DOSA = "00000000-0000-4000-8000-000000001701";
const TEMPEH = "00000000-0000-4000-8000-000000001901";

afterAll(async () => {
  await pool.end();
});

const search = (p: J) =>
  asMember(null, async (c) => (await c.query("select public.search_catalog($1::jsonb) as r", [JSON.stringify({ includeDemo: true, kinds: ["dish"], limit: 50, ...p })])).rows[0].r as J);

describe("protein per dollar", () => {
  it("ranks only dishes with a sourced protein per serving and a dated price, highest first", async () => {
    const r = await search({ sort: "protein_per_dollar" });
    expect(r.applied.sort).toBe("protein_per_dollar");
    const ranked = (r.items as J[]).filter((i) => i.proteinPerDollar !== null);
    expect(ranked.map((i) => [i.foodItemId, Number(i.proteinPerDollar)])).toEqual([
      [BOWL, 1.78],
      [PANEER, 1.73],
      [STEW, 1.57],
      [DOSA, 0.82],
    ]);
    expect(ranked[0].price).toMatchObject({ amountMinor: 1350, currency: "USD", servingDescription: "1 bowl" });
    expect(typeof ranked[0].price.checkedAt).toBe("string");
    // Unranked dishes come after every ranked one and are counted.
    const firstUnranked = (r.items as J[]).findIndex((i) => i.proteinPerDollar === null);
    expect(firstUnranked === -1 || firstUnranked >= ranked.length).toBe(true);
    expect(r.counts.notPricedComparable).toBe(r.counts.matches - ranked.length);
    expect(r.counts.notPricedComparable).toBeGreaterThan(0);
  });

  it("an estimated protein figure is never ranked per dollar, even when estimates are shown", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      // The demo tempeh rice bowl has an estimated protein figure; give it a dated price in this transaction only.
      await c.query(
        "insert into public.dish_prices (dish_id, amount_minor, serving_description, checked_at, source_record_id) values ($1, 1200, '1 bowl', now(), '00000000-0000-4000-8000-00000000b201')",
        [TEMPEH],
      );
      await c.query("set local role anon");
      const r = (await c.query("select public.search_catalog($1::jsonb) as r", [JSON.stringify({ includeDemo: true, kinds: ["dish"], limit: 50, evidenceMode: "include_estimates", sort: "protein_per_dollar" })])).rows[0].r as J;
      const tempeh = (r.items as J[]).find((i) => i.foodItemId === TEMPEH);
      expect(tempeh).toBeTruthy();
      expect(tempeh!.protein.method).toBe("estimated");
      expect(tempeh!.protein.perServing).not.toBeNull();
      expect(tempeh!.proteinPerDollar).toBeNull();
      expect(tempeh!.price).toMatchObject({ amountMinor: 1200 });
    } finally {
      await c.query("rollback");
      c.release();
    }
  });

  it("the newest dated price is used", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query(
        "insert into public.dish_prices (dish_id, amount_minor, serving_description, checked_at, source_record_id) values ($1, 1200, '1 bowl', now() + interval '1 minute', '00000000-0000-4000-8000-00000000b201')",
        [BOWL],
      );
      await c.query("set local role anon");
      const r = (await c.query("select public.search_catalog($1::jsonb) as r", [JSON.stringify({ includeDemo: true, kinds: ["dish"], limit: 50, sort: "protein_per_dollar" })])).rows[0].r as J;
      const bowl = (r.items as J[]).find((i) => i.foodItemId === BOWL)!;
      expect(bowl.price.amountMinor).toBe(1200);
      expect(Number(bowl.proteinPerDollar)).toBe(2); // 24 g / $12.00
    } finally {
      await c.query("rollback");
      c.release();
    }
  });

  it("other sorts are unchanged and an unknown sort is refused", async () => {
    const r = await search({ sort: "protein" });
    expect(r.applied.sort).toBe("protein");
    const err = await asMember(null, async (c) => {
      try {
        await c.query("select public.search_catalog('{\"sort\":\"cheapest\"}'::jsonb)");
        return null;
      } catch (e) {
        return (e as { message: string }).message;
      }
    });
    expect(err).toBe("INVALID_SORT");
  });
});
