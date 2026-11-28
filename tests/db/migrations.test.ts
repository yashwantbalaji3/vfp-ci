import { afterAll, describe, expect, it } from "vitest";
import { createTestUser, deleteTestUsers, pgError, pool } from "../helpers/db";

/**
 * Migration reproducibility: `supabase db reset` rebuilds this database from the
 * migration files alone (run before this suite in CI). These checks confirm the
 * rebuilt schema has the safety properties the specification requires.
 */
afterAll(async () => {
  await pool.end();
});

describe("schema safety after a clean rebuild", () => {
  it("every table in the public schema has Row Level Security enabled", async () => {
    const { rows } = await pool.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity order by 1`,
    );
    expect(rows).toEqual([]);
  });

  it("guests can execute only the documented read functions and the rate-limit counter (MAP-1 adds map_areas and search_map; MAP-2 adds open_now_left_out, venue_hours and venue_hours_statuses; NIE N-4 adds protein_explanation, which explains only published public dishes; CAT-PREVIEW adds place_directory, which returns only public listings to guests, and there are none while the real-place lock is off; docs/36 adds place_detail under the same rule; docs/49 adds place_venue and place_slug_for_venue, which return a venue id or slug only for a listing the caller may see)", async () => {
    const { rows } = await pool.query(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute') order by 1`,
    );
    expect(rows.map((r) => r.proname)).toEqual([
      "catalog_filter_options",
      "catalog_item_exists",
      "check_eligibility",
      "editorial_collections",
      "food_detail",
      "freshness_marks",
      "list_view",
      "map_areas",
      "open_now_left_out",
      "place_detail",
      "place_directory",
      "place_slug_for_venue",
      "place_venue",
      "profile_view",
      "protein_compare",
      "protein_explanation",
      "rate_limit_hit",
      "recipe_detail",
      "recipe_list",
      "search_catalog",
      "search_map",
      "social_page_exists",
      "target_reviews",
      "venue_detail",
      "venue_hours",
      "venue_hours_statuses",
    ]);
  });

  it("audit rows stay append-only, yet deleting a member only clears the actor (R-007)", async () => {
    const id = await createTestUser("audit-actor");
    const { rows } = await pool.query(
      "insert into public.audit_events (actor_id, action, entity_type) values ($1, 'test_action', 'test') returning id",
      [id],
    );
    const eventId = rows[0].id;
    expect((await pgError(pool.query("update public.audit_events set action = 'changed' where id = $1", [eventId]))).code).toBe("PT403");
    expect((await pgError(pool.query("update public.audit_events set actor_id = null, reason = 'x' where id = $1", [eventId]))).code).toBe("PT403");
    expect((await pgError(pool.query("delete from public.audit_events where id = $1", [eventId]))).code).toBe("PT403");
    await deleteTestUsers([id]);
    const after = await pool.query("select actor_id, action from public.audit_events where id = $1", [eventId]);
    expect(after.rows).toEqual([{ actor_id: null, action: "test_action" }]);
  });

  it("every security-definer function pins its search_path", async () => {
    const { rows } = await pool.query(
      `select n.nspname || '.' || p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'app', 'staging', 'partner', 'catalog_import', 'menu_ingest') and p.prosecdef
          and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`,
    );
    expect(rows).toEqual([]);
  });

  // Release audit 23 Nov 2026 (docs/75 item 4): signed-in members can execute the privileged (security-definer)
  // functions in `public`. Each must check who is calling, unless it is one of these deliberate public reads (all
  // also open to guests, pinned elsewhere) or the server-only rate-limit hit (it checks the server's key). A new
  // function without an identity check fails here until someone decides it belongs on this list.
  it("every privileged function a member can call checks the caller, apart from the pinned public reads", async () => {
    const { rows } = await pool.query(
      `select p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef and has_function_privilege('authenticated', p.oid, 'EXECUTE')
          and p.prosrc !~* '(auth\\.uid\\(\\)|app\\.has_role|app\\.require_|app\\.current_user|app\\.is_|app\\.caller)'
        order by 1`,
    );
    expect(rows.map((r) => r.fn)).toEqual([
      "catalog_filter_options", "catalog_item_exists", "check_eligibility", "food_detail", "freshness_marks", "map_areas",
      "open_now_left_out", "partner_licence", "place_detail", "place_slug_for_venue", "place_venue", "protein_compare",
      "protein_explanation", "rate_limit_hit", "recipe_detail", "recipe_list", "search_catalog", "venue_detail", "venue_hours",
      "venue_hours_statuses",
    ]);
  });

  it("the internal `app` schema is not exposed through the Data API", async () => {
    const { rows } = await pool.query(
      `select coalesce(current_setting('pgrst.db_schemas', true), '') as schemas`,
    );
    expect(rows[0].schemas).not.toMatch(/\bapp\b/);
  });

  it("demo seed data is fully marked as demo", async () => {
    const { rows } = await pool.query(
      `select
         (select count(*) from public.food_items where kind <> 'custom' and not is_demo)::int as real_foods,
         (select count(*) from public.venues v where not v.is_demo
            and not exists (select 1 from public.place_listings l where l.venue_id = v.id))::int as real_venues`,
    );
    // No real catalog exists yet; everything public is synthetic and flagged. A real place's identity-only venue
    // (docs/49) is not catalog content: it is never published and follows its listing.
    expect(rows[0]).toEqual({ real_foods: 0, real_venues: 0 });
  });
});
