-- Real meals in the founder's lists and reviews (owner direction 19 Nov 2026 04:27 UTC, item 3; docs/60).
-- "Implement the missing integration so that a real meal can be saved, added to a list, reviewed and revisited
-- consistently across the platform, without mixing private preview data with public/demo data."
--
-- A real meal is still a drafted staging dish: unverified, private and founder-only. So, like the saves in
-- 20261119000100, the founder's list entries and reviews of real meals stay in the staging area:
--   * no public table points at a drafted dish, so no public query, feed, ranking, friend view or export can
--     ever show one;
--   * every function starts with app.require_founder() and acts only on the caller's own rows and lists;
--   * a list keeps its own audience. A meal entry on a list is shown to the list's owner only, even on a list
--     they published, and the owner is told so on the list page;
--   * a meal review is always private: there is no audience to choose while the meal is unverified.
-- When a meal is ever published (a separate, founder-approved step), these rows can be moved to the public
-- tables; nothing here does that.

-- The dish must exist and be a meal (complete or build-your-own) at a researched place the founder's preview
-- shows: linked to a catalog place and not drafted from demo pages.
create function app.preview_meal_ok(p_dish uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from staging.dishes d
      join staging.live_catalog_links l on l.staging_place = d.place_id
      join lateral (select s.dish_type from staging.dish_structure s where s.dish_id = d.id order by s.created_at desc, s.id desc limit 1) s on true
      join public.place_listings pl on pl.candidate_id = l.candidate_id
     where d.id = p_dish and s.dish_type in ('complete_meal', 'customizable_meal')
       -- The same places as public.menu_preview_index: never one drafted from demo pages.
       and not exists (select 1 from staging.facts f join staging.source_pages sp on sp.id = f.source_page_id
                        where f.place_id = d.place_id and sp.is_demo));
$$;
revoke all on function app.preview_meal_ok(uuid) from public, anon, authenticated;

create table staging.preview_list_entries (
  list_id  uuid not null references public.food_lists (id) on delete cascade,
  user_id  uuid not null references auth.users (id) on delete cascade,
  dish_id  uuid not null references staging.dishes (id),
  added_at timestamptz not null default now(),
  primary key (list_id, dish_id)
);
alter table staging.preview_list_entries enable row level security;
alter table staging.preview_list_entries force row level security;
revoke all on staging.preview_list_entries from public, anon, authenticated;
create policy preview_list_entries_definer on staging.preview_list_entries for all to postgres using (true) with check (true);

create table staging.preview_reviews (
  user_id    uuid not null references auth.users (id) on delete cascade,
  dish_id    uuid not null references staging.dishes (id),
  rating     smallint not null check (rating between 1 and 5),
  body       text check (body is null or length(body) between 1 and 2000),
  visit_date date,
  version    integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, dish_id)
);
alter table staging.preview_reviews enable row level security;
alter table staging.preview_reviews force row level security;
revoke all on staging.preview_reviews from public, anon, authenticated;
create policy preview_reviews_definer on staging.preview_reviews for all to postgres using (true) with check (true);

-- Put a real meal on one of your own lists, or take it off.
create function public.menu_preview_list_set(p_list uuid, p_dish uuid, p_on boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_founder();
  if not exists (select 1 from public.food_lists f where f.id = p_list and f.owner_id = auth.uid() and f.publication_state <> 'removed') then
    raise exception 'NOT_FOUND' using errcode = 'PT404';
  end if;
  if p_on then
    if not app.preview_meal_ok(p_dish) then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
    perform app.social_rate(auth.uid(), 'list_write', 60, interval '1 hour');
    insert into staging.preview_list_entries (list_id, user_id, dish_id) values (p_list, auth.uid(), p_dish) on conflict do nothing;
  else
    delete from staging.preview_list_entries where list_id = p_list and dish_id = p_dish and user_id = auth.uid();
  end if;
  return jsonb_build_object('listId', p_list, 'dishId', p_dish, 'on', p_on);
end $$;
revoke all on function public.menu_preview_list_set(uuid, uuid, boolean) from public, anon;
grant execute on function public.menu_preview_list_set(uuid, uuid, boolean) to authenticated;

-- The real meals on one of your own lists (empty for a list that is not yours).
create function public.menu_preview_list_entries(p_list uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_founder();
  return coalesce((
    select jsonb_agg(jsonb_build_object('dishId', e.dish_id, 'addedAt', e.added_at) order by e.added_at, e.dish_id)
      from staging.preview_list_entries e
      join public.food_lists f on f.id = e.list_id and f.owner_id = auth.uid()
     where e.list_id = p_list and e.user_id = auth.uid()), '[]'::jsonb);
end $$;
revoke all on function public.menu_preview_list_entries(uuid) from public, anon;
grant execute on function public.menu_preview_list_entries(uuid) to authenticated;

-- Which of your lists hold this meal.
create function public.menu_preview_meal_lists(p_dish uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_founder();
  return coalesce((
    select jsonb_agg(jsonb_build_object('listId', f.id, 'title', f.title) order by f.title, f.id)
      from staging.preview_list_entries e
      join public.food_lists f on f.id = e.list_id and f.owner_id = auth.uid()
     where e.dish_id = p_dish and e.user_id = auth.uid()), '[]'::jsonb);
end $$;
revoke all on function public.menu_preview_meal_lists(uuid) from public, anon;
grant execute on function public.menu_preview_meal_lists(uuid) to authenticated;

-- Rate and review a real meal. Always private; the same limits as other reviews.
create function public.menu_preview_review_set(p_dish uuid, p_rating integer, p_body text default null, p_visit_date date default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_body text := nullif(btrim(coalesce(p_body, '')), ''); v_row staging.preview_reviews;
begin
  perform app.require_founder();
  if not app.preview_meal_ok(p_dish) then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
  if p_rating is null or p_rating not between 1 and 5 then raise exception 'INVALID_RATING' using errcode = 'PT422'; end if;
  if length(coalesce(v_body, '')) > 2000 then raise exception 'TEXT_TOO_LONG' using errcode = 'PT422'; end if;
  if p_visit_date is not null and (p_visit_date > current_date + 1 or p_visit_date < date '2000-01-01') then
    raise exception 'INVALID_DATE' using errcode = 'PT422';
  end if;
  perform app.social_rate(auth.uid(), 'review_write', 30, interval '1 hour');
  insert into staging.preview_reviews (user_id, dish_id, rating, body, visit_date)
  values (auth.uid(), p_dish, p_rating, v_body, p_visit_date)
  on conflict (user_id, dish_id) do update
    set rating = excluded.rating, body = excluded.body, visit_date = excluded.visit_date,
        version = staging.preview_reviews.version + 1, updated_at = now()
  returning * into v_row;
  return jsonb_build_object('dishId', v_row.dish_id, 'rating', v_row.rating, 'version', v_row.version);
end $$;
revoke all on function public.menu_preview_review_set(uuid, integer, text, date) from public, anon;
grant execute on function public.menu_preview_review_set(uuid, integer, text, date) to authenticated;

create function public.menu_preview_review_delete(p_dish uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_founder();
  delete from staging.preview_reviews where user_id = auth.uid() and dish_id = p_dish;
  return jsonb_build_object('dishId', p_dish, 'deleted', true);
end $$;
revoke all on function public.menu_preview_review_delete(uuid) from public, anon;
grant execute on function public.menu_preview_review_delete(uuid) to authenticated;

-- Your own reviews of real meals, newest first.
create function public.menu_preview_reviews()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_founder();
  return coalesce((
    select jsonb_agg(jsonb_build_object('dishId', r.dish_id, 'rating', r.rating, 'body', r.body, 'visitDate', r.visit_date,
                                        'version', r.version, 'updatedAt', r.updated_at) order by r.updated_at desc, r.dish_id)
      from staging.preview_reviews r where r.user_id = auth.uid()), '[]'::jsonb);
end $$;
revoke all on function public.menu_preview_reviews() from public, anon;
grant execute on function public.menu_preview_reviews() to authenticated;

-- Rollback (local database, no reset): export the founder's rows if wanted, then drop the functions
-- public.menu_preview_reviews, menu_preview_review_delete, menu_preview_review_set, menu_preview_meal_lists,
-- menu_preview_list_entries, menu_preview_list_set and app.preview_meal_ok, then the tables
-- staging.preview_reviews and staging.preview_list_entries. Nothing outside the staging area changes.
