import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../helpers/db";
import { BOSTON_AREA_POSTCODES, bostonArea } from "../../scripts/lib/boston-areas.mjs";

// One neighbourhood definition for Boston-area listings (owner directive 27 Nov 2026; migration 20261127000100).
// Every test runs inside one rolled-back transaction. Places are invented, never real restaurants.

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
const listing = (o: Record<string, unknown> = {}) => ({
  candidate_id: randomUUID(), slug: `area-test-${randomUUID().slice(0, 8)}`, name: "Test Place Lantern", street: "1 Sample St", locality: "Boston",
  postcode: "02134", area: null, lat: 42.353, lon: -71.13, category: "Restaurant", identity_status: "corroborated",
  sources: JSON.stringify([{ key: "overture_places", title: "Test source", attribution: "Test attribution" }]), built_from: "test", ...o,
});
async function add(c: PoolClient, o: Record<string, unknown> = {}) {
  const l = listing(o);
  const cols = Object.keys(l);
  const sql = `insert into public.place_listings (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id, area`;
  return (await c.query(sql, Object.values(l))).rows[0] as { id: string; area: string | null };
}

afterAll(async () => {
  await pool.end();
});

describe("Boston neighbourhoods", () => {
  it("the database and the importer's copy give the same answer", async () => {
    const zips = [...BOSTON_AREA_POSTCODES.flatMap(([, z]) => z), "02215", "02115", "02467", "02472", "02459", "02999", "", null];
    const towns = ["Boston", "Brookline", "Brighton", "ALLSTON", "Newton Centre", "Chestnut Hill", "watertown", " ", null];
    const lons = [-71.0942, -71.1007, -71.1219, null];
    const cases = zips.flatMap((z) => towns.flatMap((t) => lons.map((l) => [z, t, l] as const)));
    const rows = (
      await pool.query("select app.boston_area(e.v ->> 'z', e.v ->> 't', (e.v ->> 'l')::float8) a from jsonb_array_elements($1::jsonb) with ordinality as e(v, n) order by e.n", [
        JSON.stringify(cases.map(([z, t, l]) => ({ z, t, l }))),
      ])
    ).rows.map((r) => r.a);
    const differ = cases.filter((x, i) => rows[i] !== bostonArea(x[0], x[1], x[2])).map((x) => JSON.stringify(x));
    expect(rows).toHaveLength(cases.length);
    expect(differ).toEqual([]);
  });

  it("sets the area of every new or moved Boston listing from its address, whatever the importer sent", () =>
    tx(async (c) => {
      expect((await add(c, { postcode: "02134", area: null })).area).toBe("Allston / Brighton");
      expect((await add(c, { postcode: "02446", locality: "Brookline", area: "Back Bay / Prudential" })).area).toBe("Brookline");
      const moved = await add(c, { postcode: "02215", lon: -71.0942, area: null });
      expect(moved.area).toBe("Fenway / Kenmore");
      const after = (await c.query("update public.place_listings set lon = -71.1219 where id = $1 returning area", [moved.id])).rows[0].area;
      expect(after).toBe("Allston / Brighton");
      // A direct write of a different area is put back to the address-based one.
      const forced = (await c.query("update public.place_listings set area = 'Somewhere else' where id = $1 returning area", [moved.id])).rows[0].area;
      expect(forced).toBe("Allston / Brighton");
    }));

  it("is not callable by visitors or members", async () => {
    for (const role of ["anon", "authenticated"]) {
      const c = await pool.connect();
      try {
        await c.query("begin");
        await c.query(`set local role ${role}`);
        await expect(c.query("select app.boston_area('02134', null, null)")).rejects.toThrow(/denied/);
      } finally {
        await c.query("rollback").catch(() => {});
        c.release();
      }
    }
  });
});
