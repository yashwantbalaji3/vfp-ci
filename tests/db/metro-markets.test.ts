// Owner directive 24 Nov 2026 07:19 UTC, part 5: six metropolitan markets in one architecture, about 25 miles each.
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../helpers/db";

afterAll(async () => {
  await pool.end();
});

const covers = async (slug: string, lon: number, lat: number) =>
  (
    await pool.query(
      `select extensions.st_covers(coverage_geometry, extensions.st_setsrid(extensions.st_makepoint($2, $3), 4326)::extensions.geography) ok
         from public.markets where slug = $1`,
      [slug, lon, lat],
    )
  ).rows[0]?.ok as boolean;

describe("six metropolitan markets", () => {
  it("has Boston, New York City, Chicago, Los Angeles, San Francisco and Dallas, each with a centre and a 25-mile area", async () => {
    const { rows } = await pool.query(
      `select slug, radius_m, center is not null has_center, round(extensions.st_area(coverage_geometry) / 1e6) km2 from public.markets
        where slug in ('boston', 'new-york', 'chicago', 'los-angeles', 'san-francisco', 'dallas') order by slug`,
    );
    expect(rows.map((r) => r.slug)).toEqual(["boston", "chicago", "dallas", "los-angeles", "new-york", "san-francisco"]);
    for (const r of rows) {
      expect(r.radius_m).toBe(40234);
      expect(r.has_center).toBe(true);
      // pi x 40.234 km squared is about 5085 km2; the circle is drawn with straight segments.
      expect(Number(r.km2)).toBeGreaterThan(4950);
      expect(Number(r.km2)).toBeLessThan(5100);
    }
  });
  it("places nearby towns in their own market and no other", async () => {
    expect(await covers("boston", -71.119, 42.3736)).toBe(true); // Cambridge
    expect(await covers("new-york", -73.9442, 40.6782)).toBe(true); // Brooklyn
    expect(await covers("chicago", -87.6877, 42.0451)).toBe(true); // Evanston
    expect(await covers("los-angeles", -118.4912, 34.0195)).toBe(true); // Santa Monica
    expect(await covers("san-francisco", -122.2711, 37.8044)).toBe(true); // Oakland
    expect(await covers("dallas", -97.1081, 32.7357)).toBe(true); // Arlington
    expect(await covers("boston", -73.9442, 40.6782)).toBe(false);
    expect(await covers("dallas", -95.3698, 29.7604)).toBe(false); // Houston is not in the Dallas area
  });
  it("adds no venue outside Boston and changes no market's state", async () => {
    const { rows } = await pool.query(
      `select m.slug, m.state, count(v.id)::int venues from public.markets m left join public.venues v on v.market_id = m.id
        where m.slug <> 'boston' group by m.slug, m.state`,
    );
    for (const r of rows) {
      expect(r.state).toBe("planned");
      expect(r.venues).toBe(0);
    }
  });
});
