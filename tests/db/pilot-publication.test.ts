import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool, clearTestHosts } from "../helpers/db";

// Pilot publication pipeline (owner direction 2026-11-16 07:55 UTC, item 4; docs/29).
// Verified staged facts become a DRAFT public place and dishes; a different publisher approves them in
// the existing editor review; the real-data lock refuses approval while it is off.
// Every test runs in ONE rolled-back transaction with invented test places: nothing is left behind,
// and the real switch is only ever turned on inside a test transaction.

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
    await c.query(/^\s*(update|delete|insert)\b/i.test(sql) ? sql : `select ${sql}`, params);
  } catch (e) {
    await c.query("rollback to savepoint e");
    return e as { message: string; code?: string };
  }
  await c.query("release savepoint e");
  throw new Error(`expected ${sql} to fail`);
}

async function user(c: PoolClient, roles: string[], label: string) {
  const id = randomUUID();
  await c.query(
    `insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}', '{}', now(), now())`,
    [id, `${label}-${id.slice(0, 8)}@example.test`],
  );
  for (const r of roles) await c.query("insert into public.role_assignments (user_id, role) values ($1, $2)", [id, r]);
  return id;
}

/** Act as a signed-in member for one call, then return to the database owner. */
async function as<T>(c: PoolClient, uid: string | null, fn: () => Promise<T>): Promise<T> {
  await c.query(uid ? "set local role authenticated" : "set local role anon");
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(uid ? { sub: uid, role: "authenticated" } : { role: "anon" })]);
  try {
    return await fn();
  } finally {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
  }
}
const review = (c: PoolClient, uid: string, change: string) =>
  as(c, uid, () => one(c, "public.editor_review_change($1, 'approve', 'Checked against the restaurant page', true, true)", [change]));
const reviewErr = (c: PoolClient, uid: string, change: string) =>
  as(c, uid, () => err(c, "public.editor_review_change($1, 'approve', 'Checked against the restaurant page', true, true)", [change]));

async function world(c: PoolClient) {
  await clearTestHosts(c);
  const researcher = await user(c, ["curator"], "researcher");
  const founder = await user(c, ["publisher"], "founder");
  const label = `Pilot Test Kitchen ${randomUUID().slice(0, 6)}`;
  const place = await one(c, "staging.add_place($1, $2, 'harvard_square', 1::smallint)", [researcher, `${label} (Harvard Square)`]);
  const bowl = await one(c, "staging.add_dish($1, $2, 'Test lentil bowl')", [researcher, place]);
  const wrap = await one(c, "staging.add_dish($1, $2, 'Test unconfirmed wrap')", [researcher, place]);
  const site = await one(c, "staging.add_source_page($1, 'https://example.test/menu', 'restaurant_site', 'Pilot Test Kitchen', now(), 'Facts only')", [researcher]);
  const guide = await one(c, "staging.add_source_page($1, 'https://example.test/nutrition.pdf', 'restaurant_nutrition_guide', 'Pilot Test Kitchen', now(), 'Facts only')", [researcher]);
  const news = await one(c, "staging.add_source_page($1, 'https://news.example.test/a', 'news', 'Test News', now())", [researcher]);
  const today = (await c.query("select (now() at time zone 'America/New_York')::date::text as d")).rows[0].d as string;
  const submit = (p: J) => one(c, "staging.submit_fact($1, $2::jsonb)", [researcher, JSON.stringify({ placeId: place, sourcePageId: site, checkedOn: today, ...p })]);
  const verify = (fact: string) => one(c, "staging.review_fact($1, $2, 'verify')", [founder, fact]);
  const f: Record<string, string> = {};
  f.address = await submit({ kind: "address", value: { street: "1 Test St", postcode: "02138" } });
  f.status = await submit({ kind: "operating_status", value: { status: "operating" } });
  f.hours = await submit({ kind: "weekly_hours", value: { periods: [{ days: "Mon-Sat", open: "08:00", close: "22:00" }, { days: "Sun", open: "09:00", close: "01:00" }] } });
  f.bowlMenu = await submit({ dishId: bowl, kind: "menu_item", value: { listed: true } });
  f.bowlVegan = await submit({ dishId: bowl, kind: "dietary_status", subject: "vegan", value: { claim: "vegan", status: "yes" } });
  f.bowlEgg = await submit({ dishId: bowl, kind: "dietary_status", subject: "egg_free", value: { claim: "egg_free", status: "yes" } });
  f.bowlVegetarianUnknown = await submit({ dishId: bowl, kind: "dietary_status", subject: "vegetarian", unknownReason: "Not stated on the page" });
  f.bowlProtein = await submit({ dishId: bowl, kind: "published_nutrition", value: { nutrient: "protein_g", amount: "31", per: "serving" }, sourcePageId: guide });
  f.bowlFat = await submit({ dishId: bowl, kind: "published_nutrition", value: { nutrient: "fat_g", amount: "12", per: "100g" }, sourcePageId: guide });
  f.bowlAllergen = await submit({ dishId: bowl, kind: "allergen_statement", value: { statement: "may_contain", allergens: ["tree_nuts", "sesame", "lavender"] } });
  f.bowlContains = await submit({ dishId: bowl, kind: "allergen_statement", value: { statement: "contains", allergens: ["soy"] } });
  f.bowlPrice = await submit({ dishId: bowl, kind: "price", value: { usd: "14.50" } });
  f.bowlServing = await submit({ dishId: bowl, kind: "serving_size", unknownReason: "No weight given" });
  f.newsHours = await submit({ kind: "menu_item", dishId: wrap, value: { listed: true }, sourcePageId: news });
  f.wrapVegan = await submit({ dishId: wrap, kind: "dietary_status", subject: "vegan", value: { claim: "vegan", status: "yes" } });
  // Everything verified except: the wrap's vegan fact stays submitted, and the wrap's only menu
  // listing is on a news page (not the restaurant's own), so the wrap cannot be published.
  for (const k of Object.keys(f)) if (k !== "wrapVegan") await verify(f[k]);
  return { researcher, founder, place, bowl, wrap, label, f, today, submit, verify, site };
}

async function publicSnapshot(c: PoolClient) {
  const r: J = {};
  r.search = await one(c, "public.search_catalog($1::jsonb)", [JSON.stringify({ includeDemo: true, limit: 50 })]);
  r.searchVegan = await one(c, "public.search_catalog($1::jsonb)", [JSON.stringify({ includeDemo: true, limit: 50, diet: "vegan" })]);
  r.map = await one(c, "public.search_map($1::jsonb)", [JSON.stringify({ includeDemo: true })]);
  r.filters = await one(c, "public.catalog_filter_options('boston', true)");
  r.counts = (await c.query(`select (select count(*) from public.venues where status <> 'draft')::int v,
      (select count(*) from public.food_items where status = 'published')::int f,
      (select count(*) from public.food_revisions where published_at is not null)::int fr`)).rows[0];
  return JSON.stringify(r);
}

const lock = (c: PoolClient, on: boolean) => c.query("update app.platform_switches set enabled = $1 where name = 'pilot_publication'", [on]);

afterAll(async () => {
  await pool.end();
});

describe("P1 a publication is built from verified facts only", () => {
  it("the bowl carries its verified facts; unverified, unknown and non-restaurant facts are left out with reasons", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const pub = await one(c, "staging.prepare_publication($1, $2)", [w.researcher, w.place]);
      expect(pub.place.name).toBe(w.label);
      expect(pub.place.hours).toBe(true);
      const dishes = pub.changes.filter((x: J) => x.kind === "dish");
      expect(dishes.map((d: J) => d.name)).toEqual(["Test lentil bowl"]);
      const d = dishes[0];
      expect(d.dietary).toEqual({ vegan: "yes", egg_free: "yes", vegetarian: "unknown" });
      expect(d.nutrition).toEqual({ protein_g: 31 });
      expect(d.priceCents).toBe(1450);
      expect(d.servingGrams).toBeNull();
      expect(d.factIds).not.toContain(w.f.bowlVegetarianUnknown);
      const reasons = pub.leftOut.map((x: J) => x.reason);
      expect(reasons).toContain("not_confirmed_on_menu"); // the wrap
      expect(reasons).toContain("per_100g_needs_serving_weight"); // fat per 100 g, no serving weight
      expect(reasons).toContain("allergen_word_not_in_catalog"); // "lavender" is not guessed
      expect(pub.changes.flatMap((x: J) => x.factIds)).not.toContain(w.f.wrapVegan);
      expect(pub.changes.flatMap((x: J) => x.factIds)).not.toContain(w.f.newsHours);

      // What was written: draft rows only, real (not demo), unknown stays null.
      const v = (await c.query("select status, is_demo, name, neighborhood, street, postal_code, locality from public.venues where id = $1", [pub.venueId])).rows[0];
      expect(v).toEqual({ status: "draft", is_demo: false, name: w.label, neighborhood: "Harvard Square", street: "1 Test St", postal_code: "02138", locality: "Cambridge" });
      const item = (await c.query("select status, is_demo from public.food_items where id = $1", [d.foodItemId])).rows[0];
      expect(item).toEqual({ status: "draft", is_demo: false });
      const nv = (await c.query(`select nutrient_code, value::float, method from public.nutrient_values nv join public.food_revisions r on r.id = nv.revision_id
                                 where r.food_item_id = $1 order by 1`, [d.foodItemId])).rows;
      expect(nv).toEqual([{ nutrient_code: "protein_g", value: 31, method: "published" }]);
      const claims = (await c.query(`select diet, outcome, evidence_tier from public.dietary_claims dc join public.food_revisions r on r.id = dc.revision_id where r.food_item_id = $1`, [d.foodItemId])).rows;
      expect(claims).toEqual([{ diet: "vegan", outcome: "compatible", evidence_tier: "documented" }]);
      const allergens = (await c.query(`select allergen, presence, cross_contact from public.allergen_statements a join public.food_revisions r on r.id = a.revision_id
                                        where r.food_item_id = $1 order by 1`, [d.foodItemId])).rows;
      expect(allergens).toEqual([
        { allergen: "sesame", presence: "unknown", cross_contact: "reported" },
        { allergen: "soy", presence: "present", cross_contact: "unknown" },
        { allergen: "tree_nut", presence: "unknown", cross_contact: "reported" },
      ]);
      const egg = (await c.query(`select presence from public.ingredient_family_statements s join public.food_revisions r on r.id = s.revision_id where r.food_item_id = $1 and family = 'egg'`, [d.foodItemId])).rows;
      expect(egg).toEqual([{ presence: "absent_by_statement" }]);
      const changes = (await c.query("select kind, state, author_id from public.catalog_changes where id = any($1::uuid[]) order by kind", [pub.changes.map((x: J) => x.changeId)])).rows;
      expect(changes).toEqual([
        { kind: "food", state: "submitted", author_id: w.researcher },
        { kind: "venue", state: "submitted", author_id: w.researcher },
      ]);
      // The record is permanent, with a fingerprint of what was prepared.
      const rec = (await c.query("select content_sha256 from staging.publications where id = $1", [pub.publicationId])).rows[0];
      expect(rec.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it("a place without a verified address or operating status cannot be prepared; a second preparation is refused", async () => {
    await tx(async (c) => {
      const researcher = await user(c, ["curator"], "r");
      const place = await one(c, "staging.add_place($1, 'Pilot Empty Test (Harvard Square)', 'harvard_square', 2::smallint)", [researcher]);
      const e = await err(c, "staging.prepare_publication($1, $2)", [researcher, place]);
      expect(e.message).toBe("PLACE_NOT_READY");
      const w = await world(c);
      await one(c, "staging.prepare_publication($1, $2)", [w.researcher, w.place]);
      expect((await err(c, "staging.prepare_publication($1, $2)", [w.researcher, w.place])).message).toBe("PUBLICATION_EXISTS");
      // Only a curator prepares.
      expect((await err(c, "staging.prepare_publication($1, $2)", [w.founder, w.place])).message).toMatch(/STAGING_ROLE|role/i);
    });
  });
});

describe("P2 preparing publishes nothing", () => {
  it("public search, map, filters and counts are identical, and the drafts cannot be opened by a visitor", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const before = await publicSnapshot(c);
      const pub = await one(c, "staging.prepare_publication($1, $2)", [w.researcher, w.place]);
      expect(await publicSnapshot(c)).toBe(before);
      const food = pub.changes.find((x: J) => x.kind === "dish").foodItemId;
      expect((await as(c, null, () => err(c, "public.food_detail($1, true, true)", [food]))).message).toBe("FOOD_NOT_FOUND");
      expect((await as(c, null, () => err(c, "public.venue_detail($1, true)", [pub.venueId]))).message).toMatch(/NOT_FOUND/);
      expect((await as(c, null, () => err(c, "public.protein_explanation($1, true, true)", [food]))).message).toBe("FOOD_NOT_FOUND");
    });
  });
});

describe("P3 the real-data lock", () => {
  it("while the switch is off (the default) a publisher's approval is refused and nothing changes", async () => {
    await tx(async (c) => {
      expect(await one(c, "(select enabled from app.platform_switches where name = 'pilot_publication')")).toBe(false);
      const w = await world(c);
      const pub = await one(c, "staging.prepare_publication($1, $2)", [w.researcher, w.place]);
      const venueChange = pub.changes.find((x: J) => x.kind === "venue").changeId;
      expect((await reviewErr(c, w.founder, venueChange)).message).toBe("PUBLICATION_LOCKED");
      expect(await one(c, "(select state from public.catalog_changes where id = $1)", [venueChange])).toBe("submitted");
      expect(await one(c, "(select status from public.venues where id = $1)", [pub.venueId])).toBe("draft");
      const st = await one(c, "staging.publication_status($1)", [pub.publicationId]);
      expect(st.locked).toBe(true);
    });
  });

  it("no member, guest or editor can turn the switch on or reach the staging functions", async () => {
    await tx(async (c) => {
      const w = await world(c);
      for (const uid of [null, w.founder, w.researcher]) {
        const e = await as(c, uid, () => err(c, "update app.platform_switches set enabled = true where name = 'pilot_publication'"));
        expect(e.message).toMatch(/permission denied/);
        expect((await as(c, uid, () => err(c, "staging.prepare_publication($1, $2)", [w.researcher, w.place]))).message).toMatch(/permission denied/);
        expect((await as(c, uid, () => err(c, "count(*) from staging.publications"))).message).toMatch(/permission denied/);
      }
    });
  });
});

describe("P4 with the lock turned on (inside this test only), the two-person editor review publishes", () => {
  it("place first, then dish; the dish appears under the vegan filter with the restaurant's own protein figure", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const pub = await one(c, "staging.prepare_publication($1, $2)", [w.researcher, w.place]);
      const venueChange = pub.changes.find((x: J) => x.kind === "venue").changeId;
      const dish = pub.changes.find((x: J) => x.kind === "dish");
      // D1 ladder: six separate states. Verified from a cleared source, prepared, not yet reviewed or published.
      const ladder = async () => one(c, "(select public.menu_review_fact_json(f, $2) -> 'ladder' from staging.facts f where f.id = $1)", [w.f.address, w.founder]);
      expect(await ladder()).toEqual({ extracted: true, autoCompared: "not_checked", independentlyReviewed: false, founderConfirmed: true, rightsEligible: true, published: false });
      await lock(c, true);

      expect((await reviewErr(c, w.founder, dish.changeId)).message).toBe("VENUE_NOT_PUBLISHED");
      await review(c, w.founder, venueChange);
      // The second person's review published the place: reviewed and published, and still never "auto-compared".
      expect(await ladder()).toEqual({ extracted: true, autoCompared: "not_checked", independentlyReviewed: true, founderConfirmed: true, rightsEligible: true, published: true });
      const v = (await c.query("select status, is_demo from public.venues where id = $1", [pub.venueId])).rows[0];
      expect(v).toEqual({ status: "published", is_demo: false });
      const hours = (await c.query(`select day_of_week, to_char(opens,'HH24:MI') o, to_char(closes,'HH24:MI') cl, closes_next_day n from public.venue_hours_intervals i
                                    join public.venue_hours_sets s on s.id = i.set_id where s.venue_id = $1 and s.state = 'published' order by 1`, [pub.venueId])).rows;
      expect(hours).toHaveLength(7);
      expect(hours[0]).toEqual({ day_of_week: 0, o: "09:00", cl: "01:00", n: true });
      expect(hours[1]).toEqual({ day_of_week: 1, o: "08:00", cl: "22:00", n: false });

      await review(c, w.founder, dish.changeId);
      expect(await one(c, "(select status from public.food_items where id = $1)", [dish.foodItemId])).toBe("published");
      const expl = await as(c, null, () => one(c, "public.protein_explanation($1, false, false)", [dish.foodItemId]));
      expect(expl.state).toBe("restaurant_published");
      expect(Number(expl.value)).toBe(31);
      const vegan = await as(c, null, () => one(c, "public.search_catalog($1::jsonb)", [JSON.stringify({ limit: 50, diet: "vegan", q: "Test lentil bowl" })]));
      expect(JSON.stringify(vegan)).toContain("Test lentil bowl");
      // Every cited record was cleared by the publisher's rights check; the publish gate passed.
      const unreviewed = await one(c, `(select count(*)::int from public.source_records sr where sr.id = any($1::uuid[]) and sr.rights_status <> 'cleared')`, [dish.records]);
      expect(unreviewed).toBe(0);
      const price = await one(c, "(select amount_minor from public.dish_prices where dish_id = $1)", [dish.foodItemId]);
      expect(price).toBe(1450);
    });
  });

  it("the person who prepared it cannot approve it, and a fact replaced after preparation stops the approval", async () => {
    await tx(async (c) => {
      const w = await world(c);
      await c.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher')", [w.researcher]);
      const pub = await one(c, "staging.prepare_publication($1, $2)", [w.researcher, w.place]);
      const venueChange = pub.changes.find((x: J) => x.kind === "venue").changeId;
      await lock(c, true);
      expect((await reviewErr(c, w.researcher, venueChange)).message).toBe("SECOND_PERSON_REQUIRED");
      // The address is corrected and the correction verified: the prepared place is now out of date.
      const fix = await w.submit({ kind: "address", value: { street: "2 Test St", postcode: "02138" }, replacesFactId: w.f.address });
      await w.verify(fix);
      expect((await reviewErr(c, w.founder, venueChange)).message).toBe("STAGED_FACT_CHANGED");
      const st = await one(c, "staging.publication_status($1)", [pub.publicationId]);
      expect(st.changes.find((x: J) => x.kind === "venue").staleFacts).toBe(1);
    });
  });

  it("an unknown vegan status never passes the vegan filter, even once published", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const dish2 = await one(c, "staging.add_dish($1, $2, 'Test mystery stew')", [w.researcher, w.place]);
      await w.verify(await w.submit({ dishId: dish2, kind: "menu_item", value: { listed: true } }));
      await w.verify(await w.submit({ dishId: dish2, kind: "dietary_status", subject: "vegan", unknownReason: "Not stated" }));
      const pub = await one(c, "staging.prepare_publication($1, $2)", [w.researcher, w.place]);
      await lock(c, true);
      await review(c, w.founder, pub.changes.find((x: J) => x.kind === "venue").changeId);
      for (const d of pub.changes.filter((x: J) => x.kind === "dish")) await review(c, w.founder, d.changeId);
      const vegan = await as(c, null, () => one(c, "public.search_catalog($1::jsonb)", [JSON.stringify({ limit: 50, diet: "vegan", q: "Test mystery stew" })]));
      expect(JSON.stringify(vegan)).not.toContain("Test mystery stew");
      const stew = pub.changes.find((x: J) => x.name === "Test mystery stew");
      const expl = await as(c, null, () => one(c, "public.protein_explanation($1, false, false)", [stew.foodItemId]));
      expect(expl.state).toBe("unknown");
      expect(expl.value).toBeNull();
    });
  });
});

describe("P5 permanence and the hours reader", () => {
  it("publication records cannot be changed or deleted", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const pub = await one(c, "staging.prepare_publication($1, $2)", [w.researcher, w.place]);
      expect((await err(c, "update staging.publications set content = '{}' where id = $1", [pub.publicationId])).message).toMatch(/permanent/);
      expect((await err(c, "delete from staging.publication_changes where publication_id = $1", [pub.publicationId])).message).toMatch(/permanent/);
    });
  });

  it("reads day ranges, wrap-around ranges, lists and past-midnight closes; anything else gives nothing", async () => {
    await tx(async (c) => {
      const w = async (p: J) => one(c, "staging.weekly_from_periods($1::jsonb)", [JSON.stringify({ periods: p })]);
      expect((await w([{ days: "Fri-Mon", open: "10:00", close: "02:00" }])).weekly.map((x: J) => [x.day, x.closesNextDay])).toEqual([[5, true], [6, true], [0, true], [1, true]]);
      expect((await w([{ days: "Tue, Thu", open: "11:30", close: "15:00" }])).weekly.map((x: J) => x.day)).toEqual([2, 4]);
      expect(await w([{ days: "Someday", open: "10:00", close: "12:00" }])).toBeNull();
      expect(await w([{ days: "Mon", open: "late", close: "12:00" }])).toBeNull();
      expect(await one(c, "staging.weekly_from_periods('{}'::jsonb)")).toBeNull();
    });
  });
});
