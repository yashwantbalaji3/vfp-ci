import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pool, clearTestHosts } from "../helpers/db";

// Pilot staging in Boston neighbourhoods (A-ROADMAP-1116 item 3). Each test runs inside ONE rolled-back
// transaction. Place labels are invented test labels, not real restaurants.

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

async function curator(c: PoolClient) {
  await clearTestHosts(c);
  const id = randomUUID();
  await c.query(
    `insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}', '{}', now(), now())`,
    [id, `areas-${id.slice(0, 8)}@example.test`],
  );
  await c.query("insert into public.role_assignments (user_id, role) values ($1, 'curator')", [id]);
  return id;
}

describe("Boston areas in pilot staging", () => {
  it("each area belongs to one city, and the city follows from the area", async () => {
    await tx(async (c) => {
      const me = await curator(c);
      const cases: [string, string][] = [
        ["central_square", "Cambridge"], ["harvard_square", "Cambridge"],
        ["back_bay", "Boston"], ["fenway_kenmore", "Boston"], ["south_end", "Boston"], ["downtown", "Boston"],
        ["chinatown", "Boston"], ["beacon_hill", "Boston"], ["longwood", "Boston"],
      ];
      for (const [area, city] of cases) {
        const id = await one(c, "staging.add_place($1, $2, $3, 2::smallint)", [me, `Areas test ${area}`, area]);
        expect(await one(c, "(select city from staging.places where id = $1)", [id]), area).toBe(city);
      }
    });
  });

  it("an unknown area is refused in plain words, and a place cannot claim the wrong city", async () => {
    await tx(async (c) => {
      const me = await curator(c);
      expect((await err(c, "select staging.add_place($1, 'Areas test X', 'allston', 1::smallint)", [me])).message).toBe("STAGING_AREA_UNKNOWN");
      expect((await err(c, "insert into staging.places (label, area, city, shortlist_priority, created_by) values ('Areas test Y', 'back_bay', 'Cambridge', 1, $1)", [me])).code).toBe("23514");
      expect((await err(c, "insert into staging.places (label, area, shortlist_priority, created_by) values ('Areas test Z', 'south_end', 1, $1)", [me])).code).toBe("23514"); // the old default city
      const id = await one(c, "staging.add_place($1, 'Areas test W', 'back_bay', 1::smallint)", [me]);
      expect((await err(c, "update staging.places set city = 'Cambridge' where id = $1", [id])).code).toBeDefined();
    });
  });

  it("only a curator can add a place, and guests cannot call the new area function", async () => {
    await tx(async (c) => {
      const member = randomUUID();
      await c.query(
        `insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
         values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}', '{}', now(), now())`,
        [member, `areas-m-${member.slice(0, 8)}@example.test`],
      );
      expect((await err(c, "select staging.add_place($1, 'Areas test V', 'back_bay', 1::smallint)", [member])).message).toBe("STAGING_ROLE_REQUIRED");
      for (const role of ["anon", "authenticated"]) {
        expect(await one(c, "has_function_privilege($1, 'staging.area_city(text)', 'execute')", [role])).toBe(false);
      }
    });
  });

  it("a verified Boston place becomes a DRAFT venue in Boston with its neighbourhood, visible to nobody", async () => {
    await tx(async (c) => {
      const me = await curator(c);
      const founder = randomUUID();
      await c.query(
        `insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
         values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}', '{}', now(), now())`,
        [founder, `areas-f-${founder.slice(0, 8)}@example.test`],
      );
      await c.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher')", [founder]);
      const place = await one(c, "staging.add_place($1, 'Areas Test Kitchen (Back Bay)', 'back_bay', 1::smallint)", [me]);
      const site = await one(c, "staging.add_source_page($1, 'https://example.test/bb', 'restaurant_site', 'Areas Test Kitchen', now(), 'Facts only')", [me]);
      const today = (await c.query("select (now() at time zone 'America/New_York')::date::text as d")).rows[0].d as string;
      for (const fact of [
        { kind: "address", value: { street: "1 Test St", postcode: "02116" } },
        { kind: "operating_status", value: { status: "operating" } },
      ]) {
        const id = await one(c, "staging.submit_fact($1, $2::jsonb)", [me, JSON.stringify({ placeId: place, sourcePageId: site, checkedOn: today, ...fact })]);
        await one(c, "staging.review_fact($1, $2, 'verify')", [founder, id]);
      }
      const pub = await one(c, "staging.prepare_publication($1, $2)", [me, place]);
      const v = (await c.query("select locality, neighborhood, status, is_demo from public.venues where id = ($1::jsonb ->> 'venueId')::uuid", [JSON.stringify(pub)])).rows[0];
      expect(v).toEqual({ locality: "Boston", neighborhood: "Back Bay", status: "draft", is_demo: false });
      expect(await one(c, "app.pilot_publication_enabled()")).toBe(false); // the real-data lock stays off
    });
  });
});
