import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../helpers/db";

// Real places in saves, ratings, lists and rankings (PLACE-LINK, docs/49). Every test runs inside one transaction
// that is rolled back. Places below are invented (synthetic names and addresses), never real restaurants.

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
    [id, `link-${id.slice(0, 8)}@example.test`],
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
  const slug = `link-place-${tag()}`;
  const id = (await c.query(
    `insert into public.place_listings (candidate_id, slug, name, street, locality, postcode, area, lat, lon, category, identity_status, sources, built_from, visibility)
     values (gen_random_uuid(), $1, $2, '7 Sample Way', 'Boston', '02118', 'South End', 42.341, -71.073, $3, $4, $5, 'test', 'preview') returning id`,
    [slug, o.name ?? `Link Kestrel ${tag()}`, o.category ?? "Café", o.identity ?? "corroborated", SRC])).rows[0].id as string;
  return { id, slug };
}
const link = async (c: PoolClient, uid: string, id: string) => (await as(c, uid, "select public.place_link_venue($1, true) v", [id]))[0].v as string;
/** Makes a listing public the only allowed way: the lock on, a founder-verified identity. */
async function makePublic(c: PoolClient, id: string) {
  await c.query("update app.platform_switches set enabled = true where name = 'real_place_listings'");
  await c.query("update public.place_listings set identity_status = 'verified', visibility = 'public' where id = $1", [id]);
}

afterAll(async () => {
  await pool.end();
});

describe("a real place gets one app place record, identity only", () => {
  it("the founder's first visit makes a draft, non-demo venue with the listing's identity, once", async () => {
    await tx(async (c) => {
      const founder = await user(c, "publisher");
      const l = await listing(c, { name: "Link Kestrel Café" });
      const v = await link(c, founder, l.id);
      expect(await link(c, founder, l.id)).toBe(v);
      const row = (await c.query("select name, street, postal_code, neighborhood, venue_type, status, is_demo, cuisines, price_band from public.venues where id = $1", [v])).rows[0];
      expect(row).toMatchObject({ name: "Link Kestrel Café", street: "7 Sample Way", postal_code: "02118", neighborhood: "South End", venue_type: "cafe", status: "draft", is_demo: false, price_band: null });
      expect(row.cuisines ?? []).toEqual([]);
      const after = (await c.query("select venue_id, menu_status, visibility from public.place_listings where id = $1", [l.id])).rows[0];
      expect(after).toEqual({ venue_id: v, menu_status: "not_checked", visibility: "preview" });
      // No dish, diet or nutrition comes with it.
      expect((await c.query("select count(*)::int n from public.dishes where venue_id = $1", [v])).rows[0].n).toBe(0);
    });
  });

  it("a member cannot link a preview place, a guest cannot call the function at all", async () => {
    await tx(async (c) => {
      const l = await listing(c);
      const member = await user(c);
      expect((await refused(c, member, "select public.place_link_venue($1, true)", [l.id])).message).toBe("NOT_FOUND");
      expect((await pool.query("select has_function_privilege('anon', 'public.place_link_venue(uuid, boolean)', 'execute') g")).rows[0].g).toBe(false);
      // The founder must ask for the preview, as for the place page.
      const founder = await user(c, "publisher");
      expect((await refused(c, founder, "select public.place_link_venue($1, false)", [l.id])).message).toBe("NOT_FOUND");
    });
  });

  it("a place keeps its venue; a rebuilt name or address flows to the venue", async () => {
    await tx(async (c) => {
      const founder = await user(c, "publisher");
      const l = await listing(c);
      const v = await link(c, founder, l.id);
      await c.query("update public.place_listings set name = 'Renamed Kestrel', street = '9 Sample Way' where id = $1", [l.id]);
      expect((await c.query("select name, street from public.venues where id = $1", [v])).rows[0]).toEqual({ name: "Renamed Kestrel", street: "9 Sample Way" });
      await c.query("savepoint k");
      await expect(c.query("update public.place_listings set venue_id = null where id = $1", [l.id])).rejects.toThrow(/keeps its venue/);
      await c.query("rollback to savepoint k");
    });
  });

  it("the linked venue never appears where published venues do", async () => {
    await tx(async (c) => {
      const founder = await user(c, "publisher");
      const l = await listing(c);
      const v = await link(c, founder, l.id);
      // The old venue page answers "not found" for it (the app then sends the visitor to the place page).
      await c.query("savepoint d");
      let detail: unknown = "refused";
      try {
        detail = (await as(c, founder, "select public.venue_detail($1, true) d", [v]))[0].d;
      } catch {
        await c.query("rollback to savepoint d");
      }
      expect(detail === null || detail === "refused").toBe(true);
      expect((await as(c, founder, "select public.place_slug_for_venue($1) s", [v]))[0].s).toBe(l.slug);
    });
  });
});

describe("saves and ratings follow the listing's visibility", () => {
  it("the founder saves and rates a preview place; a member can neither see nor touch it", async () => {
    await tx(async (c) => {
      const founder = await user(c, "publisher");
      const member = await user(c);
      const l = await listing(c);
      const v = await link(c, founder, l.id);
      await as(c, founder, "insert into public.saves (owner_id, venue_id) values ($1, $2)", [founder, v]);
      const saves = (await as(c, founder, "select public.my_saves(false) s"))[0].s as J;
      expect(saves.places).toEqual([expect.objectContaining({ venueId: v, slug: l.slug, menuStatus: "not_checked" })]);
      expect(saves.venues).toEqual([]);
      await as(c, founder, "select public.save_review('venue', $1, 4, 'Friendly counter', null, null, false)", [v]);
      const reviews = (await as(c, founder, "select public.target_reviews('venue', $1, false) r", [v]))[0].r as J;
      expect(reviews.target).toMatchObject({ kind: "venue", id: v, placeSlug: l.slug, isDemo: false });
      expect(reviews.mine).toMatchObject({ rating: 4 });

      expect((await refused(c, member, "insert into public.saves (owner_id, venue_id) values ($1, $2)", [member, v])).code).toBe("42501");
      expect((await refused(c, member, "select public.save_review('venue', $1, 5, null, null, null, false)", [v])).message).toBe("TARGET_NOT_FOUND");
      expect((await refused(c, member, "select public.target_reviews('venue', $1, false)", [v])).message).toBe("TARGET_NOT_FOUND");
      expect(await as(c, member, "select id from public.venues where id = $1", [v])).toEqual([]);
      expect(await as(c, null, "select id from public.venues where id = $1", [v])).toEqual([]);
      expect((await as(c, member, "select public.place_slug_for_venue($1) s", [v]))[0].s).toBeNull();
    });
  });

  it("once a place is public, a member saves, rates and lists it; a guest can find its record", async () => {
    await tx(async (c) => {
      const founder = await user(c, "publisher");
      const member = await user(c);
      const l = await listing(c);
      await makePublic(c, l.id);
      const v = (await as(c, member, "select public.place_link_venue($1, false) v", [l.id]))[0].v as string;
      await as(c, member, "insert into public.saves (owner_id, venue_id) values ($1, $2)", [member, v]);
      await as(c, member, "select public.save_review('venue', $1, 5, null, null, null, false)", [v]);
      const list = ((await as(c, member, "select public.save_list(null, 'Weeknight places') r"))[0].r as J).listId as string;
      await as(c, member, "select public.add_to_list($1, 'venue', $2, null, false)", [list, v]);
      expect((await as(c, member, "select count(*)::int n from public.food_list_items where list_id = $1 and venue_id = $2", [list, v]))[0].n).toBe(1);
      expect((await as(c, null, "select public.place_venue($1, false) v", [l.slug]))[0].v).toBe(v);
      expect((await as(c, founder, "select public.place_slug_for_venue($1) s", [v]))[0].s).toBe(l.slug);
    });
  });

  it("withdrawing a place hides its saves, ratings and ranking entries everywhere, without deleting them", async () => {
    await tx(async (c) => {
      const founder = await user(c, "publisher");
      const l = await listing(c);
      const v = await link(c, founder, l.id);
      await as(c, founder, "insert into public.saves (owner_id, venue_id) values ($1, $2)", [founder, v]);
      await as(c, founder, "select public.save_review('venue', $1, 3, null, null, null, false)", [v]);
      await as(c, founder, "select public.save_my_profile($1, 'Link Founder', null, '{}', true, false, false)", [`link_${founder.slice(0, 8)}`]);
      await as(c, founder, "select public.set_ranking($1::uuid[])", [[v]]);
      await as(c, founder, "select public.publish_ranking()");
      const before = (await as(c, founder, "select public.my_ranking(false) r"))[0].r as J;
      expect(before.publication.entries).toEqual([expect.objectContaining({ venueId: v, placeSlug: l.slug })]);

      await c.query("update public.place_listings set visibility = 'withdrawn' where id = $1", [l.id]);
      expect(((await as(c, founder, "select public.my_saves(false) s"))[0].s as J).places).toEqual([]);
      expect((await refused(c, founder, "select public.target_reviews('venue', $1, false)", [v])).message).toBe("TARGET_NOT_FOUND");
      expect(((await as(c, founder, "select public.my_ranking(false) r"))[0].r as J).publication.entries).toEqual([]);
      expect((await c.query("select count(*)::int n from public.reviews where venue_id = $1", [v])).rows[0].n).toBe(1);
      expect((await c.query("select count(*)::int n from public.saves where venue_id = $1", [v])).rows[0].n).toBe(1);
    });
  });

  it("demo and editorial venues keep their old rule", async () => {
    await tx(async (c) => {
      const demo = (await c.query("select id from public.venues where is_demo and status = 'published' limit 1")).rows[0]?.id as string | undefined;
      if (!demo) return; // a database without demo rows has nothing to compare
      const t = (await c.query("select app.social_target($1, null, 'none', '{}', false, true) t", [demo])).rows[0].t as J;
      expect(t).toMatchObject({ kind: "venue", id: demo, isDemo: true });
      expect(t.placeSlug).toBeUndefined();
      expect((await c.query("select app.social_target($1, null, 'none', '{}', false, false) t", [demo])).rows[0].t).toBeNull();
    });
  });
});
