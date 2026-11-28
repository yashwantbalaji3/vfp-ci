import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../helpers/db";

// Directory filters (docs/36 section "Filters"): forgiving search, kind of place, founder-checked identity.
// Identity only. Every test runs in one transaction that is rolled back; places are invented.

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
    [id, `dir-${id.slice(0, 8)}@example.test`],
  );
  if (role) await c.query("insert into public.role_assignments (user_id, role) values ($1, $2)", [id, role]);
  return id;
}
async function as(c: PoolClient, uid: string | null, sql: string, params: unknown[] = []) {
  await c.query(`set local role ${uid ? "authenticated" : "anon"}`);
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(uid ? { sub: uid, role: "authenticated" } : { role: "anon" })]);
  const rows = (await c.query(sql, params)).rows;
  await c.query("reset role");
  return rows;
}
const SRC = JSON.stringify([{ key: "overture_places", title: "Test source", attribution: "Test attribution", release: "r1" }]);
async function listing(c: PoolClient, name: string, category = "Restaurant", identity = "corroborated", street = "1 Sample St") {
  await c.query(
    `insert into public.place_listings (candidate_id, slug, name, street, locality, postcode, area, lat, lon, category, identity_status, sources, built_from, visibility)
     values ($1, $2, $3, $4, 'Boston', '02116', 'Back Bay / Prudential', 42.35, -71.07, $5, $6, $7, 'test', 'preview')`,
    [randomUUID(), `dir-test-${randomUUID().slice(0, 8)}`, name, street, category, identity, SRC],
  );
}
const dir = async (c: PoolClient, uid: string | null, p: J) => (await as(c, uid, "select public.place_directory($1::jsonb) d", [JSON.stringify(p)]))[0].d as J;
const names = (d: J) => d.items.map((i: J) => i.name).sort();

afterAll(async () => {
  await pool.end();
});

describe("directory filters", () => {
  it("search ignores case, accents, apostrophes and punctuation", () =>
    tx(async (c) => {
      const founder = await user(c, "publisher");
      const t = randomUUID().slice(0, 6);
      await listing(c, `Felipe's Taqueria ${t}`);
      await listing(c, `Café Zoë-${t}`, "Café");
      await listing(c, `Plain Diner ${t}`, "Restaurant", "corroborated", "22 O’Brien Hwy");
      for (const q of [`felipes taqueria ${t}`, `FELIPE’S ${t}`.replace(` ${t}`, ""), `Felipe's Taqueria ${t}`]) {
        expect(names(await dir(c, founder, { preview: true, q }))).toContain(`Felipe's Taqueria ${t}`);
      }
      expect(names(await dir(c, founder, { preview: true, q: `cafe zoe ${t}` }))).toEqual([`Café Zoë-${t}`]);
      expect(names(await dir(c, founder, { preview: true, q: `obrien hwy` }))).toContain(`Plain Diner ${t}`);
      // A query of only punctuation is no filter at all, never an error.
      const all = await dir(c, founder, { preview: true });
      expect((await dir(c, founder, { preview: true, q: "'%_" })).total).toBe(all.total);
      expect((await c.query("select app.search_key($1) k", ["  Zoë’s  Café & Bar!! "])).rows[0].k).toBe("zoes cafe bar");
    }));

  it("filters by kind of place and by founder-checked identity, and counts both", () =>
    tx(async (c) => {
      const founder = await user(c, "publisher");
      const t = randomUUID().slice(0, 6);
      await listing(c, `Kind Test ${t} one`, "Café", "verified");
      await listing(c, `Kind Test ${t} two`, "Café");
      await listing(c, `Kind Test ${t} three`, "Food truck");
      const q = `Kind Test ${t}`;
      expect(names(await dir(c, founder, { preview: true, q, kind: "Café" }))).toEqual([`Kind Test ${t} one`, `Kind Test ${t} two`]);
      expect(names(await dir(c, founder, { preview: true, q, checked: true }))).toEqual([`Kind Test ${t} one`]);
      expect(names(await dir(c, founder, { preview: true, q, kind: "Food truck", checked: true }))).toEqual([]);
      const map = await dir(c, founder, { preview: true, q, kind: "Café", mode: "map" });
      expect(map.items.map((i: J) => i.name).sort()).toEqual([`Kind Test ${t} one`, `Kind Test ${t} two`]);
      const d = await dir(c, founder, { preview: true });
      const kinds = Object.fromEntries(d.kinds.map((k: J) => [k.kind, k.count]));
      expect(kinds["Café"]).toBeGreaterThanOrEqual(2);
      expect(kinds["Food truck"]).toBeGreaterThanOrEqual(1);
      expect(d.checked).toBeGreaterThanOrEqual(1);
    }));

  it("guests and members still see nothing from the preview, whatever the filters", () =>
    tx(async (c) => {
      const member = await user(c);
      const t = randomUUID().slice(0, 6);
      await listing(c, `Hidden Test ${t}`, "Café", "verified");
      for (const uid of [null, member]) {
        const d = await dir(c, uid, { preview: true, q: `Hidden Test ${t}`, kind: "Café", checked: true });
        expect(d.items).toEqual([]);
        expect(d.total).toBe(0);
        expect(d.preview).toBe(false);
      }
    }));
});
