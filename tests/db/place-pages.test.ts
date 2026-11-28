import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../helpers/db";

// Real place pages, map/list search and visitor reports (docs/36). Every test runs inside one transaction that is rolled back.
// Places below are invented (synthetic names and addresses), never real restaurants.

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
async function user(c: PoolClient, role?: string) {
  const id = randomUUID();
  await c.query(
    "insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}', '{}', now(), now())",
    [id, `review-${id.slice(0, 8)}@example.test`],
  );
  if (role) await c.query("insert into public.role_assignments (user_id, role) values ($1, $2)", [id, role]);
  return id;
}
/** Runs `sql` as a guest (null) or a member, the way the Data API does. */
async function as(c: PoolClient, uid: string | null, sql: string, params: unknown[] = []) {
  await c.query(`set local role ${uid ? "authenticated" : "anon"}`);
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(uid ? { sub: uid, role: "authenticated" } : { role: "anon" })]);
  const rows = (await c.query(sql, params)).rows;
  await c.query("reset role");
  return rows;
}
/** Like `as`, but expects a refusal and returns it. */
async function refused(c: PoolClient, uid: string | null, sql: string, params: unknown[] = []) {
  await c.query("savepoint s");
  try {
    await as(c, uid, sql, params);
  } catch (e) {
    await c.query("rollback to savepoint s");
    return e as { code: string; message: string };
  }
  throw new Error(`Expected to fail: ${sql}`);
}


const SRC = JSON.stringify([{ key: "overture_places", title: "Test source", attribution: "Test attribution", release: "r1" }]);
const tag = () => randomUUID().slice(0, 8);

async function listing(c: PoolClient, o: J = {}) {
  const cid = randomUUID();
  const slug = `test-place-${tag()}`;
  const id = (await c.query(
    `insert into public.place_listings (candidate_id, slug, name, street, locality, postcode, area, lat, lon, category, identity_status, sources, built_from, visibility)
     values ($1, $2, $3, '1 Sample St', 'Boston', '02116', 'Back Bay / Prudential', $4, $5, 'Restaurant', $6, $7, 'test', $8) returning id`,
    [cid, slug, o.name ?? "Test Place Kestrel", o.lat ?? 42.35, o.lon ?? -71.07, o.identity ?? "corroborated", SRC, o.visibility ?? "preview"])).rows[0].id as string;
  return { id, cid, slug };
}
const dir = async (c: PoolClient, uid: string | null, p: J) => (await as(c, uid, "select public.place_directory($1::jsonb) d", [JSON.stringify(p)]))[0].d as J;
const detail = async (c: PoolClient, uid: string | null, slug: string, preview = true) => (await as(c, uid, "select public.place_detail($1, $2) d", [slug, preview]))[0].d as J | null;
const report = (c: PoolClient, uid: string, id: string, reason: string, note: string | null = null) =>
  as(c, uid, "select public.report_place_problem($1, $2, $3, true) r", [id, reason, note]);

afterAll(async () => {
  await pool.end();
});

describe("map and list search use one rule for what a visitor may see", () => {
  it("map mode returns minimal fields only, up to 500, for the same filters as the list", async () => {
    await tx(async (c) => {
      const founder = await user(c, "publisher");
      const t = tag();
      for (let i = 0; i < 3; i++) await listing(c, { name: `Test Kestrel ${t} ${i}`, lat: 42.35 + i * 0.001 });
      const list = await dir(c, founder, { preview: true, q: `Kestrel ${t}`, limit: 2 });
      const map = await dir(c, founder, { preview: true, q: `Kestrel ${t}`, mode: "map" });
      expect(list.total).toBe(3);
      expect(map.total).toBe(3);
      expect(map.items).toHaveLength(3);
      expect(Object.keys(map.items[0]).sort()).toEqual(["area", "category", "distanceM", "id", "identityBasis", "lat", "lon", "name", "slug", "street"]);
      expect(map.items.map((i: J) => i.id).sort()).toEqual([...list.items.map((i: J) => i.id), (await dir(c, founder, { preview: true, q: `Kestrel ${t}`, limit: 2, offset: 2 })).items[0].id].sort());
      expect((await refused(c, founder, "select public.place_directory($1::jsonb)", [JSON.stringify({ preview: true, limit: 51 })])).message).toBe("INVALID_LIMIT");
      expect((await refused(c, founder, "select public.place_directory($1::jsonb)", [JSON.stringify({ preview: true, mode: "map", limit: 501 })])).message).toBe("INVALID_LIMIT");
    });
  });

  it("a map rectangle and a radius narrow the results; bad shapes are refused", async () => {
    await tx(async (c) => {
      const founder = await user(c, "publisher");
      const t = tag();
      await listing(c, { name: `Test Kestrel ${t} near`, lat: 42.35, lon: -71.07 });
      await listing(c, { name: `Test Kestrel ${t} far`, lat: 42.4, lon: -71.0 });
      const box = await dir(c, founder, { preview: true, q: `Kestrel ${t}`, mode: "map", west: -71.08, south: 42.34, east: -71.06, north: 42.36 });
      expect(box.items.map((i: J) => i.name)).toEqual([`Test Kestrel ${t} near`]);
      const near = await dir(c, founder, { preview: true, q: `Kestrel ${t}`, lat: 42.351, lon: -71.071, radiusM: 805 });
      expect(near.items.map((i: J) => i.name)).toEqual([`Test Kestrel ${t} near`]);
      expect(near.items[0].distanceM).toBeGreaterThan(0);
      for (const bad of [{ west: -71, south: 42.3, east: -71.1, north: 42.4 }, { west: -71 }, { lat: 42.35, lon: -71.07, radiusM: 50 }, { radiusM: 805 }]) {
        expect((await refused(c, founder, "select public.place_directory($1::jsonb)", [JSON.stringify({ preview: true, ...bad })])).message).toMatch(/INVALID_(BOX|RADIUS)/);
      }
    });
  });

  it("guests and members see no preview place in the list, the map or a detail page", async () => {
    await tx(async (c) => {
      const t = tag();
      const l = await listing(c, { name: `Test Kestrel ${t}` });
      const member = await user(c);
      for (const uid of [null, member]) {
        expect((await dir(c, uid, { preview: true, q: `Kestrel ${t}` })).total).toBe(0);
        expect((await dir(c, uid, { preview: true, q: `Kestrel ${t}`, mode: "map" })).total).toBe(0);
        expect(await detail(c, uid, l.slug)).toBeNull();
      }
      const founder = await user(c, "publisher");
      expect(await detail(c, founder, l.slug, false)).toBeNull(); // the app must ask for the preview
      const d = await detail(c, founder, l.slug);
      expect(d).toMatchObject({ name: `Test Kestrel ${t}`, identityBasis: "corroborated", menuStatus: "not_checked", visibility: "preview", reported: false, batch: null });
      expect(d!.sources[0]).toEqual({ title: "Test source", attribution: "Test attribution", release: "r1" });
      expect(JSON.stringify(d)).not.toMatch(/diet|vegan|vegetarian|protein|allergen|dish/i);
    });
  });

  it("the identity basis says 'verified' only after the founder's own decision", async () => {
    await tx(async (c) => {
      const founder = await user(c, "publisher");
      const l = await listing(c, { identity: "verified" });
      expect((await detail(c, founder, l.slug))!.identityBasis).toBe("verified");
      const m = await listing(c);
      expect((await detail(c, founder, m.slug))!.identityBasis).toBe("corroborated");
    });
  });
});

describe("report a problem", () => {
  it("a guest cannot report; a member cannot report a place they cannot see", async () => {
    await tx(async (c) => {
      const l = await listing(c);
      expect((await pool.query("select has_function_privilege('anon', 'public.report_place_problem(uuid, text, text, boolean)', 'execute') g")).rows[0].g).toBe(false);
      const member = await user(c);
      expect((await refused(c, member, "select public.report_place_problem($1, 'closed', null, true)", [l.id])).message).toBe("NOT_FOUND");
    });
  });

  it("the founder's report is stored once per reason, a note is required for 'other', and the listing does not change", async () => {
    await tx(async (c) => {
      const founder = await user(c, "publisher");
      const l = await listing(c);
      const before = (await c.query("select * from public.place_listings where id = $1", [l.id])).rows[0];
      await report(c, founder, l.id, "closed", "Shuttered last month");
      expect((await refused(c, founder, "select public.report_place_problem($1, 'closed', null, true)", [l.id])).message).toBe("ALREADY_REPORTED");
      expect((await refused(c, founder, "select public.report_place_problem($1, 'other', null, true)", [l.id])).message).toBe("NOTE_REQUIRED");
      expect((await refused(c, founder, "select public.report_place_problem($1, 'publish', null, true)", [l.id])).message).toBe("INVALID_REASON");
      expect((await refused(c, founder, "select public.report_place_problem($1, 'closed', $2, true)", [l.id, "x".repeat(501)])).message).toBe("NOTE_TOO_LONG");
      const after = (await c.query("select * from public.place_listings where id = $1", [l.id])).rows[0];
      expect(after).toEqual(before);
      expect((await detail(c, founder, l.slug))!.reported).toBe(true);
    });
  });

  it("caps reports at 10 a day per person", async () => {
    await tx(async (c) => {
      const founder = await user(c, "publisher");
      for (let i = 0; i < 10; i++) {
        const l = await listing(c);
        await report(c, founder, l.id, "closed");
      }
      const l = await listing(c);
      expect((await refused(c, founder, "select public.report_place_problem($1, 'closed', null, true)", [l.id])).message).toBe("TOO_MANY_REPORTS");
    });
  });

  it("only the founder sees and resolves reports; the reporter is never named; a report is resolved once", async () => {
    await tx(async (c) => {
      const founder = await user(c, "publisher");
      const curator = await user(c, "curator");
      const l = await listing(c);
      const id = ((await report(c, founder, l.id, "wrong_address", "It is next door"))[0].r as J).id;
      expect((await refused(c, curator, "select public.place_reports_queue()")).message).toBe("FOUNDER_ONLY");
      expect((await refused(c, curator, "select public.resolve_place_report($1, 'no_change')", [id])).message).toBe("FOUNDER_ONLY");
      const q = (await as(c, founder, "select public.place_reports_queue() q"))[0].q as J;
      const row = q.items.find((x: J) => x.id === id);
      expect(row).toMatchObject({ reason: "wrong_address", note: "It is next door", resolution: null });
      expect(JSON.stringify(row)).not.toMatch(/reported_?by|email|handle/i);
      await as(c, founder, "select public.resolve_place_report($1, 'no_change', 'Checked the map')", [id]);
      expect((await refused(c, founder, "select public.resolve_place_report($1, 'fixed')", [id])).message).toBe("NOT_FOUND");
      expect((await detail(c, founder, l.slug))!.reported).toBe(false);
      for (const t of ["place_reports"]) {
        for (const role of ["anon", "authenticated"]) {
          const p = await pool.query("select has_table_privilege($1, $2, 'select') s", [role, `public.${t}`]);
          expect(p.rows[0].s).toBe(false);
        }
      }
    });
  });
});
