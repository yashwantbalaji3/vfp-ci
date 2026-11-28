import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool, clearTestHosts } from "../helpers/db";
import { linkWebsites } from "../../scripts/menu-link.mjs";

// The founder-only private beta on real data (migration 20261119000100, docs/59): the website match
// that ties a researched profile to its catalog place, the founder's index of linked profiles, and the
// founder's private saved meals. Each test runs inside ONE rolled-back transaction. Names, websites and
// addresses are invented, never real restaurants.

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
const err = async (c: PoolClient, sql: string, params: unknown[] = []) => {
  await c.query("savepoint s");
  try {
    await c.query(sql, params);
  } catch (e) {
    await c.query("rollback to savepoint s");
    return e as { code: string; message: string; detail?: string };
  }
  throw new Error(`Expected to fail: ${sql}`);
};
const one = async (c: PoolClient, sql: string, params: unknown[] = []) => (await c.query(`select ${sql} as r`, params)).rows[0].r;
async function user(c: PoolClient, role?: string) {
  const id = randomUUID();
  await c.query(
    `insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}', '{}', now(), now())`,
    [id, `preview-${id.slice(0, 8)}@example.test`],
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
const asErr = async (c: PoolClient, uid: string | null, sql: string, params: unknown[] = []) => {
  await c.query("savepoint s");
  try {
    await as(c, uid, sql, params);
  } catch (e) {
    await c.query("rollback to savepoint s");
    return (e as Error).message;
  }
  throw new Error(`Expected to fail: ${sql}`);
};

/** A researched profile whose facts were read from a page on `host`, with one complete meal. */
async function profile(c: PoolClient, me: string, label: string, host: string) {
  await clearTestHosts(c);
  const place = await one(c, "staging.add_place($1, $2, 'back_bay', 2::smallint)", [me, label]);
  const site = await one(c, "staging.add_source_page($1, $2, 'restaurant_site', 'Preview Test', now(), 'Facts only')", [me, `https://www.${host}/menu`]);
  const today = (await c.query("select (now() at time zone 'America/New_York')::date::text as d")).rows[0].d as string;
  const dish = await one(c, "staging.add_dish($1, $2, 'Lentil Plate')", [me, place]);
  await c.query("select staging.classify_dish($1, $2, 'complete_meal', null, 'Mains', null, 'source_section', null)", [me, dish]);
  await one(c, "staging.submit_fact($1, $2::jsonb)", [me, JSON.stringify({ placeId: place, dishId: dish, sourcePageId: site, checkedOn: today, kind: "price", value: { usd: "14.00" } })]);
  return { place: place as string, dish: dish as string };
}
let n = 0;
/** A catalog candidate whose open-data record names `website`. */
async function candidate(c: PoolClient, name: string, website: string | null, quality = "corroborated") {
  const run = (await c.query("insert into catalog_import.import_runs (source_key, release, file_sha256, retrieved_at, thresholds, status) values ('overture_places', 'test', $1, now(), '{}', 'completed') returning id", ["0".repeat(64)])).rows[0].id;
  const cand = (await c.query("insert into catalog_import.place_candidates (name, street, postcode, lat, lon, category, quality, created_run) values ($1, $2, '02116', 42.35, -71.07, 'restaurant', $3, $4) returning id", [name, `${++n} Preview St`, quality, run])).rows[0].id as string;
  const rec = (await c.query(
    `insert into catalog_import.source_records (source_key, external_id, name, lat, lon, website, record_licence, record_hash, first_run, last_run)
     values ('overture_places', $1, $2, 42.35, -71.07, $3, 'CDLA-Permissive-2.0', $4, $5, $5) returning id`,
    [`preview-${randomUUID()}`, name, website, "1".repeat(64), run])).rows[0].id;
  await c.query("insert into catalog_import.candidate_links (candidate_id, record_id, match_score, match_method) values ($1, $2, 1, 'seed')", [cand, rec]);
  return cand;
}
async function listing(c: PoolClient, cand: string, name: string) {
  const slug = `preview-test-${randomUUID().slice(0, 8)}`;
  await c.query(
    `insert into public.place_listings (candidate_id, slug, name, street, locality, postcode, area, lat, lon, category, identity_status, sources, built_from)
     values ($1, $2, $3, '1 Preview St', 'Boston', '02116', 'Back Bay / Prudential', 42.35, -71.07, 'Restaurant', 'corroborated', '[{"key":"overture_places","title":"Test"}]', 'test')`,
    [cand, slug, name]);
  return slug;
}
const rand = () => randomUUID().slice(0, 8);

afterAll(async () => {
  await pool.end();
});

describe("website match", () => {
  it("links a profile to the one catalog place whose open data names the same website", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const host = `lentil-${rand()}.example.test`;
      const p = await profile(c, curator, "Lentil House Back Bay", host);
      const cand = await candidate(c, "Lentil House", `http://${host}/`);
      const id = await one(c, "staging.link_catalog($1, $2, $3, 'website_match')", [curator, p.place, cand]);
      const row = (await c.query("select method, evidence, note from staging.catalog_links where id = $1", [id])).rows[0];
      expect(row).toMatchObject({ method: "website_match", note: null, evidence: { website: host, candidateName: "Lentil House" } });
    }));

  it("refuses a different website, a shared website, a file host and a different name", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const host = `chain-${rand()}.example.test`;
      const p = await profile(c, curator, "Chain Kitchen", host);
      expect((await err(c, "select staging.link_catalog($1, $2, $3, 'website_match')", [curator, p.place, await candidate(c, "Chain Kitchen", `https://other-${rand()}.example.test`)])).message).toBe("WEBSITE_MISMATCH");
      const a = await candidate(c, "Chain Kitchen", `https://${host}`);
      await candidate(c, "Chain Kitchen", `https://www.${host}/locations/two`);
      const shared = await err(c, "select staging.link_catalog($1, $2, $3, 'website_match')", [curator, p.place, a]);
      expect(shared.message).toBe("WEBSITE_SHARED");
      expect(shared.detail).toContain("2 catalog places");
      // A menu PDF on a shared file host is never evidence of whose website it is.
      const q = await profile(c, curator, "Pdf Kitchen", "images.getbento.com");
      expect((await err(c, "select staging.link_catalog($1, $2, $3, 'website_match')", [curator, q.place, await candidate(c, "Pdf Kitchen", "https://images.getbento.com/x")])).message).toBe("WEBSITE_MISMATCH");
      const h2 = `named-${rand()}.example.test`;
      const r = await profile(c, curator, "Sunrise Noodles", h2);
      expect((await err(c, "select staging.link_catalog($1, $2, $3, 'website_match')", [curator, r.place, await candidate(c, "Moonlight Tacos", `https://${h2}`)])).message).toBe("NAME_MISMATCH");
      // A rejected candidate does not count as sharing the website.
      const h3 = `solo-${rand()}.example.test`;
      const s = await profile(c, curator, "Solo Falafel", h3);
      const good = await candidate(c, "Solo Falafel", `https://${h3}`);
      await candidate(c, "Solo Falafel", `https://${h3}`, "rejected");
      expect(await one(c, "staging.link_catalog($1, $2, $3, 'website_match')", [curator, s.place, good])).toBeTruthy();
    }));

  it("is for the research account or the founder only", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const member = await user(c);
      const host = `roles-${rand()}.example.test`;
      const p = await profile(c, curator, "Roles Bistro Kitchen", host);
      const cand = await candidate(c, "Roles Bistro Kitchen", `https://${host}`);
      expect((await err(c, "select staging.link_catalog($1, $2, $3, 'website_match')", [member, p.place, cand])).code).toBe("PT403");
    }));

  it("link-websites links unique matches and leaves shared websites for a person", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const h1 = `script-${rand()}.example.test`;
      const h2 = `shared-${rand()}.example.test`;
      await profile(c, curator, "Script Dosa", h1);
      await profile(c, curator, "Shared Pita", h2);
      await candidate(c, "Script Dosa", `https://${h1}`);
      await candidate(c, "Shared Pita", `https://${h2}`);
      await candidate(c, "Shared Pita", `https://${h2}`);
      const r = await linkWebsites(c, { actor: curator, dryRun: false, ownTransaction: false });
      expect(r.linked.map((x: J) => x.label)).toContain("Script Dosa");
      expect(r.skipped.find((x: J) => x.label === "Shared Pita")?.why).toMatch(/2 catalog places share this website/);
    }));
});

describe("founder-only preview index and saved meals", () => {
  it("lists linked profiles for the founder only", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const member = await user(c);
      const host = `index-${rand()}.example.test`;
      const p = await profile(c, curator, "Index Thali", host);
      const cand = await candidate(c, "Index Thali", `https://${host}`);
      const slug = await listing(c, cand, "Index Thali");
      await c.query("select staging.link_catalog($1, $2, $3, 'website_match')", [curator, p.place, cand]);
      const idx = (await as(c, founder, "select public.menu_preview_index() r"))[0].r as J[];
      expect(idx.find((e) => e.slug === slug)).toMatchObject({ placeId: p.place, name: "Index Thali", linkMethod: "website_match" });
      // The index carries no menu facts at all.
      expect(JSON.stringify(idx.find((e) => e.slug === slug))).not.toMatch(/14\.00|Lentil/);
      expect(await asErr(c, member, "select public.menu_preview_index()")).toMatch("FOUNDER_ONLY");
      expect(await asErr(c, null, "select public.menu_preview_index()")).toMatch(/permission denied/);
    }));

  it("keeps the founder's saved meals private to the founder", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const member = await user(c);
      const p = await profile(c, curator, "Saves Kitchen Thai", `saves-${rand()}.example.test`);
      await as(c, founder, "select public.menu_preview_save($1, true)", [p.dish]);
      await as(c, founder, "select public.menu_preview_save($1, true)", [p.dish]);
      expect((await as(c, founder, "select public.menu_preview_saved() r"))[0].r).toEqual([p.dish]);
      await as(c, founder, "select public.menu_preview_save($1, false)", [p.dish]);
      expect((await as(c, founder, "select public.menu_preview_saved() r"))[0].r).toEqual([]);
      expect(await asErr(c, member, "select public.menu_preview_save($1, true)", [p.dish])).toMatch("FOUNDER_ONLY");
      expect(await asErr(c, member, "select public.menu_preview_saved()")).toMatch("FOUNDER_ONLY");
      expect(await asErr(c, null, "select public.menu_preview_save($1, true)", [p.dish])).toMatch(/permission denied/);
      for (const uid of [founder, member, null]) expect(await asErr(c, uid, "select * from staging.preview_saves")).toMatch(/permission denied/);
      expect(await asErr(c, founder, "select public.menu_preview_save($1, true)", [randomUUID()])).toMatch("NOT_FOUND");
    }));
});

// Real meals on the founder's lists and in private reviews (migration 20261119000200, docs/60).
async function linkedMeal(c: PoolClient, curator: string, name: string) {
  const host = `${name.toLowerCase().replace(/[^a-z]/g, "")}-${rand()}.example.test`;
  const p = await profile(c, curator, name, host);
  const cand = await candidate(c, name, `https://${host}`);
  await listing(c, cand, name);
  await c.query("select staging.link_catalog($1, $2, $3, 'website_match')", [curator, p.place, cand]);
  return p;
}
async function foodList(c: PoolClient, owner: string, title: string) {
  return (await c.query("insert into public.food_lists (owner_id, title) values ($1, $2) returning id", [owner, title])).rows[0].id as string;
}

describe("real meals on lists and in private reviews", () => {
  it("puts a linked meal on the founder's own list, and only there", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const member = await user(c);
      const p = await linkedMeal(c, curator, "Listed Lentils");
      const mine = await foodList(c, founder, "Lunch spots");
      const theirs = await foodList(c, member, "Someone else's list");
      await as(c, founder, "select public.menu_preview_list_set($1, $2, true)", [mine, p.dish]);
      await as(c, founder, "select public.menu_preview_list_set($1, $2, true)", [mine, p.dish]); // twice is still once
      expect((await as(c, founder, "select public.menu_preview_list_entries($1) r", [mine]))[0].r).toMatchObject([{ dishId: p.dish }]);
      expect((await as(c, founder, "select public.menu_preview_meal_lists($1) r", [p.dish]))[0].r).toEqual([{ listId: mine, title: "Lunch spots" }]);
      // Never on someone else's list, and nothing to read there.
      expect(await asErr(c, founder, "select public.menu_preview_list_set($1, $2, true)", [theirs, p.dish])).toMatch("NOT_FOUND");
      expect((await as(c, founder, "select public.menu_preview_list_entries($1) r", [theirs]))[0].r).toEqual([]);
      // The list's public tables never point at the drafted dish, even once the list is published.
      await c.query("update public.food_lists set visibility = 'public', publication_state = 'visible', published_at = now() where id = $1", [mine]);
      const leaked = await c.query("select count(*)::int n from public.food_list_items where list_id = $1", [mine]);
      expect(leaked.rows[0].n).toBe(0);
      await as(c, founder, "select public.menu_preview_list_set($1, $2, false)", [mine, p.dish]);
      expect((await as(c, founder, "select public.menu_preview_list_entries($1) r", [mine]))[0].r).toEqual([]);
      // Members and visitors can do none of it.
      const m = await foodList(c, member, "Member list");
      expect(await asErr(c, member, "select public.menu_preview_list_set($1, $2, true)", [m, p.dish])).toMatch("FOUNDER_ONLY");
      expect(await asErr(c, member, "select public.menu_preview_list_entries($1)", [m])).toMatch("FOUNDER_ONLY");
      expect(await asErr(c, member, "select public.menu_preview_meal_lists($1)", [p.dish])).toMatch("FOUNDER_ONLY");
      expect(await asErr(c, null, "select public.menu_preview_list_entries($1)", [m])).toMatch(/permission denied/);
      for (const uid of [founder, member, null]) expect(await asErr(c, uid, "select * from staging.preview_list_entries")).toMatch(/permission denied/);
    }));

  it("refuses a dish that is not a linked meal: unlinked, not a meal, or unknown", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const list = await foodList(c, founder, "Tries");
      const unlinked = await profile(c, curator, "Unlinked Dosa", `unlinked-${rand()}.example.test`);
      const linked = await linkedMeal(c, curator, "Side Dish Place");
      const side = await one(c, "staging.add_dish($1, $2, 'Side of Rice')", [curator, linked.place]);
      await c.query("select staging.classify_dish($1, $2, 'side', null, 'Sides', null, 'source_section', null)", [curator, side]);
      for (const dish of [unlinked.dish, side, randomUUID()]) {
        expect(await asErr(c, founder, "select public.menu_preview_list_set($1, $2, true)", [list, dish])).toMatch("NOT_FOUND");
        expect(await asErr(c, founder, "select public.menu_preview_review_set($1, 4)", [dish])).toMatch("NOT_FOUND");
      }
    }));

  it("keeps meal reviews private to the founder, versioned and validated", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const member = await user(c);
      const p = await linkedMeal(c, curator, "Reviewed Bowl");
      expect((await as(c, founder, "select public.menu_preview_review_set($1, 4, '  Filling  ', null) r", [p.dish]))[0].r).toMatchObject({ rating: 4, version: 1 });
      expect((await as(c, founder, "select public.menu_preview_review_set($1, 5) r", [p.dish]))[0].r).toMatchObject({ rating: 5, version: 2 });
      expect((await as(c, founder, "select public.menu_preview_reviews() r"))[0].r).toMatchObject([{ dishId: p.dish, rating: 5, body: null, version: 2 }]);
      expect(await asErr(c, founder, "select public.menu_preview_review_set($1, 6)", [p.dish])).toMatch("INVALID_RATING");
      expect(await asErr(c, founder, "select public.menu_preview_review_set($1, 3, $2)", [p.dish, "x".repeat(2001)])).toMatch("TEXT_TOO_LONG");
      expect(await asErr(c, founder, "select public.menu_preview_review_set($1, 3, null, '1999-01-01')", [p.dish])).toMatch("INVALID_DATE");
      // Not in any public review table, feed or rating.
      expect((await c.query("select count(*)::int n from public.reviews where author_id = $1", [founder])).rows[0].n).toBe(0);
      expect(await asErr(c, member, "select public.menu_preview_reviews()")).toMatch("FOUNDER_ONLY");
      expect(await asErr(c, member, "select public.menu_preview_review_set($1, 4)", [p.dish])).toMatch("FOUNDER_ONLY");
      expect(await asErr(c, null, "select public.menu_preview_reviews()")).toMatch(/permission denied/);
      for (const uid of [founder, member, null]) expect(await asErr(c, uid, "select * from staging.preview_reviews")).toMatch(/permission denied/);
      await as(c, founder, "select public.menu_preview_review_delete($1)", [p.dish]);
      expect((await as(c, founder, "select public.menu_preview_reviews() r"))[0].r).toEqual([]);
    }));
});

// "Log this meal" keeps where a real meal's figures came from (migration 20261120000100, docs/63).
async function withFigures(c: PoolClient, curator: string, name: string, protein: Record<string, unknown> | null, kcal: string | null = "790") {
  const p = await linkedMeal(c, curator, name);
  const site = (await c.query("select source_page_id from staging.facts where dish_id = $1 limit 1", [p.dish])).rows[0].source_page_id;
  const today = (await c.query("select (now() at time zone 'America/New_York')::date::text as d")).rows[0].d as string;
  const fact = (kind: string, value: unknown) => one(c, "staging.submit_fact($1, $2::jsonb)", [curator, JSON.stringify({ placeId: p.place, dishId: p.dish, sourcePageId: site, checkedOn: today, kind, subject: (value as J).nutrient, value })]);
  if (protein) await fact("published_nutrition", { nutrient: "protein_g", ...protein });
  if (kcal) await fact("published_nutrition", { nutrient: "energy_kcal", per: "serving", amount: kcal });
  return { ...p, today };
}
const LOG = "select public.log_real_meal($1, $2, $3, $4, 1, 'lunch', $5::date, 'America/New_York', $6::jsonb) r";
const entry = async (c: PoolClient, uid: string, date: string) => ((await as(c, uid, "select public.diary_day($1::date) r", [date]))[0].r as J).entries as J[];

describe("logging a real meal with its source", () => {
  it("keeps a printed figure as the restaurant's, with the source, basis and draft status, and is idempotent", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const p = await withFigures(c, curator, "Source Burrito Bar", { per: "serving", amount: "44" });
      const key = randomUUID();
      const first = (await as(c, founder, LOG, [key, p.dish, 44, 790, p.today, null]))[0].r as J;
      const again = (await as(c, founder, LOG, [key, p.dish, 44, 790, p.today, null]))[0].r as J;
      expect(again).toMatchObject({ entryId: first.entryId, replayed: true });
      const day = await entry(c, founder, p.today);
      expect(day).toHaveLength(1);
      expect(day[0]).toMatchObject({ name: "Lentil Plate (Source Burrito Bar)", context: "restaurant", nutrients: { protein_g: { value: 44, method: "published" }, energy_kcal: { value: 790, method: "published" } } });
      expect(day[0].source).toMatchObject({
        kind: "real_meal",
        restaurant: { name: "Source Burrito Bar" },
        dish: { id: p.dish, name: "Lentil Plate" },
        status: "unverified_draft",
        source: { checkedOn: p.today },
        protein: { evidence: "restaurant_published", sourceAmount: 44, logged: 44, method: "published", changedByYou: false, typedByYou: false, per: "serving", unit: "g" },
        servings: 1,
      });
      expect(day[0].source.source.url).toMatch(/^https:\/\/www\.sourceburritobar-/);
      // Nothing about it is public, and nothing in the drafted menu changed.
      expect((await c.query("select visibility from public.food_items where id = $1", [first.foodItemId])).rows[0].visibility).toBe("private");
      expect((await c.query("select count(*)::int n from staging.fact_confirmations f join staging.facts x on x.id = f.fact_id where x.dish_id = $1", [p.dish])).rows[0].n).toBe(0);
    }));

  it("records a changed figure as the person's own, apart from the source, and never turns a range into a number", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const a = await withFigures(c, curator, "Changed Figure Cafe", { per: "serving", amount: "44" });
      await as(c, founder, LOG, [randomUUID(), a.dish, 40, 790, a.today, null]);
      const b = await withFigures(c, curator, "Range Figure Cafe", { basis: "published_range", per: "serving", low: "18", high: "24" }, null);
      await as(c, founder, LOG, [randomUUID(), b.dish, null, null, b.today, null]);
      const d = await withFigures(c, curator, "Usda Figure Cafe", null, null);
      await as(c, founder, LOG, [randomUUID(), d.dish, null, null, d.today, JSON.stringify({ low: 21, high: 42, confidence: "low" })]);
      const day = await entry(c, founder, a.today);
      const by = (n: string) => day.find((e) => e.name.includes(n))!;
      expect(by("Changed Figure").nutrients.protein_g).toMatchObject({ value: 40, method: "user_entered" });
      expect(by("Changed Figure").source.protein).toMatchObject({ sourceAmount: 44, logged: 40, changedByYou: true, method: "user_entered" });
      expect(by("Range Figure").nutrients.protein_g).toMatchObject({ value: null });
      expect(by("Range Figure").source.protein).toMatchObject({ evidence: "restaurant_range", sourceLow: 18, sourceHigh: 24, sourceAmount: null, logged: null });
      expect(by("Usda Figure").nutrients.protein_g).toMatchObject({ value: null });
      expect(by("Usda Figure").source.protein).toMatchObject({ evidence: "usda_estimate", sourceLow: 21, sourceHigh: 42, logged: null });
      // A USDA range never stands in for the restaurant's figure, even when the person types the low end.
      await as(c, founder, LOG, [randomUUID(), d.dish, 21, null, d.today, JSON.stringify({ low: 21, high: 42 })]);
      const typed = (await entry(c, founder, d.today)).filter((e) => e.name.includes("Usda Figure")).find((e) => e.nutrients.protein_g.value === 21)!;
      expect(typed.nutrients.protein_g.method).toBe("user_entered");
      expect(typed.source.protein).toMatchObject({ evidence: "usda_estimate", typedByYou: true });
    }));

  it("is for the founder and preview meals only, and the source copy is private and can't change", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const member = await user(c);
      const p = await withFigures(c, curator, "Private Source Grill", { per: "serving", amount: "30" });
      expect(await asErr(c, member, LOG, [randomUUID(), p.dish, 30, null, p.today, null])).toMatch("FOUNDER_ONLY");
      expect(await asErr(c, null, LOG, [randomUUID(), p.dish, 30, null, p.today, null])).toMatch(/permission denied/);
      const unlinked = await profile(c, curator, "Unlinked Source Diner", `unlinked-${rand()}.example.test`);
      expect(await asErr(c, founder, LOG, [randomUUID(), unlinked.dish, 30, null, p.today, null])).toMatch("NOT_FOUND");
      const r = (await as(c, founder, LOG, [randomUUID(), p.dish, 30, null, p.today, null]))[0].r as J;
      const rev = (await c.query("select current_revision_id id from public.food_items where id = $1", [r.foodItemId])).rows[0].id;
      expect(await as(c, founder, "select count(*)::int n from public.custom_food_attributions")).toEqual([{ n: 1 }]);
      expect(await as(c, member, "select count(*)::int n from public.custom_food_attributions")).toEqual([{ n: 0 }]);
      expect(await asErr(c, null, "select * from public.custom_food_attributions")).toMatch(/permission denied/);
      expect(await asErr(c, founder, "insert into public.custom_food_attributions (revision_id, owner_id, attribution) values ($1, $2, '{}')", [rev, founder])).toMatch(/permission denied/);
      expect((await err(c, "update public.custom_food_attributions set attribution = '{}' where revision_id = $1", [rev])).message).toBe("ATTRIBUTION_IMMUTABLE");
      // Another member's diary never shows it.
      expect(await entry(c, member, p.today)).toEqual([]);
      // An ordinary own food still has no source and reads as before.
      await as(c, founder, "select public.log_new_custom_food($1, 'Toast', null, '{\"protein_g\": 6}'::jsonb, null, null, 1, 'home', 'breakfast', $2::date, 'America/New_York')", [randomUUID(), p.today]);
      const toast = (await entry(c, founder, p.today)).find((e) => e.name === "Toast")!;
      expect(toast.source).toBeNull();
      expect(toast.nutrients.protein_g).toMatchObject({ value: 6, method: "user_entered" });
    }));
});

// Eating out in the week plan (migration 20261122000400, owner direction 22 Nov 2026).
describe("real meals in the founder's week plan", () => {
  it("plans a preview meal on a day, lists it by date, removes it, and refuses everyone else", () =>
    tx(async (c) => {
      const curator = await user(c, "curator");
      const founder = await user(c, "publisher");
      const member = await user(c);
      const p = await linkedMeal(c, curator, "Planned Pad Thai");
      const today = (await c.query("select current_date::text d")).rows[0].d as string;
      const plan = (await as(c, founder, "select public.menu_preview_plan($1, $2::date, 'lunch') r", [p.dish, today]))[0].r;
      const got = (await as(c, founder, "select public.menu_preview_plans($1::date, $1::date + 6) r", [today]))[0].r;
      expect(got).toEqual([{ planId: plan.planId, dishId: p.dish, date: today, mealSlot: "lunch" }]);
      // A plan logs nothing: the diary is untouched.
      expect((await c.query("select count(*)::int n from public.diary_entries where owner_id = $1", [founder])).rows[0].n).toBe(0);
      // Not a preview meal, a bad slot or a far-off date are refused.
      expect(await asErr(c, founder, "select public.menu_preview_plan($1, $2::date, null)", [randomUUID(), today])).toMatch("NOT_FOUND");
      expect(await asErr(c, founder, "select public.menu_preview_plan($1, $2::date, 'brunch')", [p.dish, today])).toMatch("INVALID_SLOT");
      expect(await asErr(c, founder, "select public.menu_preview_plan($1, $2::date + 400, null)", [p.dish, today])).toMatch("INVALID_DATE");
      // Nobody else can plan, read or remove, and the table is closed to every role.
      expect(await asErr(c, member, "select public.menu_preview_plan($1, $2::date, null)", [p.dish, today])).toMatch("FOUNDER_ONLY");
      expect(await asErr(c, member, "select public.menu_preview_plans($1::date, $1::date)", [today])).toMatch("FOUNDER_ONLY");
      expect(await asErr(c, member, "select public.menu_preview_unplan($1)", [plan.planId])).toMatch("FOUNDER_ONLY");
      expect(await asErr(c, null, "select public.menu_preview_plans($1::date, $1::date)", [today])).toMatch(/permission denied/);
      for (const uid of [founder, member, null]) expect(await asErr(c, uid, "select * from staging.preview_meal_plans")).toMatch(/permission denied/);
      await as(c, founder, "select public.menu_preview_unplan($1)", [plan.planId]);
      expect((await as(c, founder, "select public.menu_preview_plans($1::date, $1::date + 6) r", [today]))[0].r).toEqual([]);
      expect(await asErr(c, founder, "select public.menu_preview_unplan($1)", [plan.planId])).toMatch("NOT_FOUND");
    }));
});
