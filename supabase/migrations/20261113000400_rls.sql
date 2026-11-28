-- M1 · Row Level Security. Deny by default: every exposed table has RLS enabled,
-- and only the policies below grant access. Writes to the diary, goals and custom
-- foods go through the checked functions in the next migration, never direct inserts.
-- Spec: docs/12 access-control matrix. Requirement IDs: R-004, R-O02.

do $$
declare t text;
begin
  foreach t in array array[
    'markets', 'venues', 'licenses', 'sources', 'source_records', 'food_items', 'food_revisions',
    'portions', 'nutrient_values', 'dietary_claims', 'allergen_statements', 'ingredient_family_statements',
    'dishes', 'dish_prices', 'recipe_revisions', 'recipe_ingredients', 'recipe_steps', 'venue_facts',
    'profiles_public', 'user_preferences', 'ingredient_exclusions', 'diary_entries', 'diary_snapshots',
    'daily_log_status', 'goal_versions', 'saves', 'meal_plans', 'cook_sessions', 'idempotency_records',
    'outbox_jobs', 'deletion_tombstones', 'assets'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

-- Operational tables: no member or guest access at all (no policies).
revoke all on public.idempotency_records, public.outbox_jobs, public.deletion_tombstones from anon, authenticated;
revoke all on public.audit_events, public.role_assignments from anon;

-- ---------------------------------------------------------------------------
-- Public catalog: readable when approved; editable only by catalog editors and
-- never directly published (publication runs through publish_food_revision()).
-- ---------------------------------------------------------------------------
create policy markets_read on public.markets for select to anon, authenticated using (true);

create policy venues_read on public.venues for select to anon, authenticated
  using (status in ('published', 'temporarily_closed', 'closed') or app.is_catalog_editor());
create policy venues_editor_insert on public.venues for insert to authenticated
  with check (app.is_catalog_editor() and status in ('draft', 'in_review'));
create policy venues_editor_update on public.venues for update to authenticated
  using (app.is_catalog_editor() and status in ('draft', 'in_review'))
  with check (app.is_catalog_editor() and status in ('draft', 'in_review'));

create policy venue_facts_read on public.venue_facts for select to anon, authenticated
  using (exists (select 1 from public.venues v where v.id = venue_id));
create policy venue_facts_editor_write on public.venue_facts for all to authenticated
  using (app.is_catalog_editor()) with check (app.is_catalog_editor());

create policy licenses_read on public.licenses for select to anon, authenticated using (true);
create policy licenses_publisher_write on public.licenses for all to authenticated
  using (app.has_role('publisher')) with check (app.has_role('publisher'));

create policy sources_read on public.sources for select to anon, authenticated
  using (access_scope = 'public' or owner_id = (select auth.uid()) or (access_scope = 'restricted' and app.is_catalog_editor()));
create policy sources_editor_write on public.sources for all to authenticated
  using (app.is_catalog_editor() and access_scope <> 'private')
  with check (app.is_catalog_editor() and access_scope <> 'private' and owner_id is null);

create policy source_records_read on public.source_records for select to anon, authenticated
  using (exists (select 1 from public.sources s where s.id = source_id));
create policy source_records_editor_write on public.source_records for all to authenticated
  using (app.is_catalog_editor() and exists (select 1 from public.sources s where s.id = source_id and s.access_scope <> 'private'))
  with check (app.is_catalog_editor() and exists (select 1 from public.sources s where s.id = source_id and s.access_scope <> 'private'));

create policy food_items_read on public.food_items for select to anon, authenticated
  using (app.can_read_food_item(id));
create policy food_items_editor_insert on public.food_items for insert to authenticated
  with check (app.is_catalog_editor() and visibility = 'public' and status in ('draft', 'in_review'));
create policy food_items_editor_update on public.food_items for update to authenticated
  using (app.is_catalog_editor() and visibility = 'public' and status in ('draft', 'in_review', 'approved'))
  with check (app.is_catalog_editor() and visibility = 'public' and status in ('draft', 'in_review', 'approved'));

create function app.is_public_draft_revision(p_revision_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.food_revisions r
    join public.food_items fi on fi.id = r.food_item_id
    where r.id = p_revision_id and fi.visibility = 'public' and r.published_at is null
  );
$$;
grant execute on function app.is_public_draft_revision(uuid) to authenticated;

create policy food_revisions_read on public.food_revisions for select to anon, authenticated
  using (app.can_read_revision(id));
create policy food_revisions_editor_insert on public.food_revisions for insert to authenticated
  with check (
    app.is_catalog_editor() and published_at is null
    and exists (select 1 from public.food_items fi where fi.id = food_item_id and fi.visibility = 'public')
  );
create policy food_revisions_editor_update on public.food_revisions for update to authenticated
  using (app.is_catalog_editor() and published_at is null)
  with check (app.is_catalog_editor() and published_at is null);

-- Child evidence tables share one pattern: read follows the parent revision;
-- editors may write only on unpublished public revisions.
do $$
declare t text;
begin
  foreach t in array array['portions', 'nutrient_values', 'dietary_claims', 'allergen_statements', 'ingredient_family_statements'] loop
    execute format($f$
      create policy %1$s_read on public.%1$I for select to anon, authenticated
        using (app.can_read_revision(revision_id));
      create policy %1$s_editor_write on public.%1$I for all to authenticated
        using (app.is_catalog_editor() and app.is_public_draft_revision(revision_id))
        with check (app.is_catalog_editor() and app.is_public_draft_revision(revision_id));
    $f$, t);
  end loop;
end $$;

create policy recipe_revisions_read on public.recipe_revisions for select to anon, authenticated
  using (app.can_read_revision(food_revision_id));
create policy recipe_revisions_editor_write on public.recipe_revisions for all to authenticated
  using (app.is_catalog_editor() and app.is_public_draft_revision(food_revision_id))
  with check (app.is_catalog_editor() and app.is_public_draft_revision(food_revision_id));

create policy recipe_ingredients_read on public.recipe_ingredients for select to anon, authenticated
  using (app.can_read_revision(recipe_revision_id));
create policy recipe_ingredients_editor_write on public.recipe_ingredients for all to authenticated
  using (app.is_catalog_editor() and app.is_public_draft_revision(recipe_revision_id))
  with check (app.is_catalog_editor() and app.is_public_draft_revision(recipe_revision_id));

create policy recipe_steps_read on public.recipe_steps for select to anon, authenticated
  using (app.can_read_revision(recipe_revision_id));
create policy recipe_steps_editor_write on public.recipe_steps for all to authenticated
  using (app.is_catalog_editor() and app.is_public_draft_revision(recipe_revision_id))
  with check (app.is_catalog_editor() and app.is_public_draft_revision(recipe_revision_id));

create policy dishes_read on public.dishes for select to anon, authenticated
  using (app.can_read_food_item(food_item_id));
create policy dishes_editor_write on public.dishes for all to authenticated
  using (app.is_catalog_editor()) with check (app.is_catalog_editor());

create policy dish_prices_read on public.dish_prices for select to anon, authenticated
  using (exists (select 1 from public.dishes d where d.food_item_id = dish_id));
create policy dish_prices_editor_write on public.dish_prices for all to authenticated
  using (app.is_catalog_editor()) with check (app.is_catalog_editor());

-- ---------------------------------------------------------------------------
-- Private member data: owner only. Friends, followers, curators and moderators
-- get nothing here (doc 12). Guests get nothing.
-- ---------------------------------------------------------------------------
create policy profiles_owner_all on public.profiles_public for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy preferences_owner_all on public.user_preferences for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy exclusions_owner_all on public.ingredient_exclusions for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

-- Diary, snapshots and goals: read own rows; all writes via checked functions.
create policy diary_entries_owner_read on public.diary_entries for select to authenticated
  using (owner_id = (select auth.uid()));
create policy diary_snapshots_owner_read on public.diary_snapshots for select to authenticated
  using (exists (select 1 from public.diary_entries e where e.id = entry_id and e.owner_id = (select auth.uid())));
create policy goal_versions_owner_read on public.goal_versions for select to authenticated
  using (owner_id = (select auth.uid()));

create policy daily_log_status_owner_all on public.daily_log_status for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

create policy saves_owner_read on public.saves for select to authenticated
  using (owner_id = (select auth.uid()));
create policy saves_owner_insert on public.saves for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and (food_item_id is null or app.can_read_food_item(food_item_id))
    and (venue_id is null or exists (select 1 from public.venues v where v.id = venue_id))
  );
create policy saves_owner_delete on public.saves for delete to authenticated
  using (owner_id = (select auth.uid()));

create policy meal_plans_owner_read on public.meal_plans for select to authenticated
  using (owner_id = (select auth.uid()));
create policy meal_plans_owner_insert on public.meal_plans for insert to authenticated
  with check (owner_id = (select auth.uid()) and app.can_read_revision(food_revision_id));
create policy meal_plans_owner_update on public.meal_plans for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()) and app.can_read_revision(food_revision_id));
create policy meal_plans_owner_delete on public.meal_plans for delete to authenticated
  using (owner_id = (select auth.uid()));

create policy cook_sessions_owner_read on public.cook_sessions for select to authenticated
  using (owner_id = (select auth.uid()));

-- Private uploads: owner reads; inserts are private only (no client-side escalation to public).
create policy assets_owner_read on public.assets for select to authenticated
  using (owner_id = (select auth.uid()));
create policy assets_owner_insert on public.assets for insert to authenticated
  with check (owner_id = (select auth.uid()) and visibility = 'private' and rights_record_id is null);
create policy assets_owner_delete on public.assets for delete to authenticated
  using (owner_id = (select auth.uid()));
create policy assets_public_read on public.assets for select to anon, authenticated
  using (visibility = 'public' and moderation_state = 'approved');
