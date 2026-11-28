-- NIE N-5 (part): when a dish has the restaurant's own protein figure AND our calculation, compare
-- them (NIE-A, owner decision 23:21 UTC: a gap of more than 25 % goes to a person). The restaurant's
-- figure always stays the one shown; nothing is averaged or replaced. Each comparison is a
-- permanent record; a person (not the one who ran the check) closes it with a reason.
--
-- Rollback (local): drop public.editor_nutrition_checks, app.nie_resolve_check, app.nie_check_published
-- and app.nie_published_checks.

create table app.nie_published_checks (
  id               uuid primary key default gen_random_uuid(),
  food_item_id     uuid not null references public.food_items (id) on delete cascade,
  revision_id      uuid not null references public.food_revisions (id) on delete cascade,
  calculation_id   uuid not null references app.nie_calculations (id),
  published_value  numeric not null check (published_value >= 0),
  calculated_value numeric,
  relative_gap     numeric,
  threshold        numeric not null,
  needs_review     boolean not null,
  checked_by       uuid not null,
  checked_at       timestamptz not null default now(),
  resolved_by      uuid,
  resolved_at      timestamptz,
  resolution       text check (resolution is null or resolution in ('restaurant_figure_stands', 'restaurant_figure_corrected', 'model_corrected')),
  resolution_note  text check (resolution_note is null or length(resolution_note) between 3 and 500),
  check ((resolved_at is null) = (resolution is null) and (resolved_at is null) = (resolved_by is null)),
  check (resolved_by is null or resolved_by <> checked_by),
  check (resolution is null or needs_review)
);
create index nie_published_checks_open_idx on app.nie_published_checks (checked_at) where needs_review and resolved_at is null;
alter table app.nie_published_checks enable row level security;
revoke all on app.nie_published_checks from public, anon, authenticated;

-- The record is permanent; only an open check that needs review may be closed, once.
create function app.nie_guard_check()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    -- Removing the dish itself (cascade) takes its checks with it; nothing else deletes one.
    if not exists (select 1 from public.food_items fi where fi.id = old.food_item_id) then return old; end if;
    raise exception 'A protein comparison is permanent' using errcode = 'P0001';
  end if;
  if old.resolved_at is null and new.resolved_at is not null
     and (new.id, new.food_item_id, new.revision_id, new.calculation_id, new.published_value, new.calculated_value,
          new.relative_gap, new.threshold, new.needs_review, new.checked_by, new.checked_at)
         is not distinct from
         (old.id, old.food_item_id, old.revision_id, old.calculation_id, old.published_value, old.calculated_value,
          old.relative_gap, old.threshold, old.needs_review, old.checked_by, old.checked_at) then
    return new;
  end if;
  raise exception 'A protein comparison is permanent' using errcode = 'P0001';
end;
$$;
create trigger nie_published_checks_guard before update or delete on app.nie_published_checks
  for each row execute function app.nie_guard_check();

-- Compare the dish's current restaurant-published protein figure with a calculation (curator).
create function app.nie_check_published(p_actor uuid, p_food_item uuid, p_calculation uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  fi public.food_items;
  nv public.nutrient_values;
  v_cmp jsonb;
  v_id uuid;
begin
  perform app.nie_require_role(p_actor, 'curator');
  select * into fi from public.food_items where id = p_food_item and kind = 'dish' and status = 'published';
  if fi.id is null then raise exception 'NIE_NOT_FOUND' using errcode = 'PT404'; end if;
  select * into nv from public.nutrient_values
   where revision_id = fi.current_revision_id and nutrient_code = 'protein_g' and method = 'published' and value is not null;
  if nv.revision_id is null then raise exception 'NIE_NO_PUBLISHED_FIGURE' using errcode = 'PT409'; end if;
  if not exists (select 1 from app.nie_calculations c where c.id = p_calculation) then raise exception 'NIE_NOT_FOUND' using errcode = 'PT404'; end if;
  v_cmp := app.nie_compare_published(nv.value, p_calculation);
  if not (v_cmp ->> 'comparable')::boolean then raise exception 'NIE_NOT_COMPARABLE' using errcode = 'PT409'; end if;
  insert into app.nie_published_checks (food_item_id, revision_id, calculation_id, published_value, calculated_value, relative_gap, threshold, needs_review, checked_by)
  values (fi.id, fi.current_revision_id, p_calculation, nv.value, (select c.central from app.nie_calculations c where c.id = p_calculation),
          (v_cmp ->> 'relativeGap')::numeric, (v_cmp ->> 'threshold')::numeric, (v_cmp ->> 'needsReview')::boolean, p_actor)
  returning id into v_id;
  return v_cmp || jsonb_build_object('checkId', v_id, 'published', nv.value, 'shown', nv.value);
end;
$$;

-- A different person closes a check that needed review, with a reason. The public figure is not
-- touched here: a corrected figure or model goes through its own two-person change.
create function app.nie_resolve_check(p_actor uuid, p_check uuid, p_resolution text, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare ch app.nie_published_checks;
begin
  perform app.nie_require_role(p_actor, 'publisher');
  select * into ch from app.nie_published_checks where id = p_check for update;
  if ch.id is null then raise exception 'NIE_NOT_FOUND' using errcode = 'PT404'; end if;
  if not ch.needs_review or ch.resolved_at is not null then raise exception 'NIE_NOTHING_TO_RESOLVE' using errcode = 'PT409'; end if;
  if ch.checked_by = p_actor then raise exception 'NIE_SAME_PERSON' using errcode = 'PT403'; end if;
  if p_note is null or length(btrim(p_note)) < 3 then raise exception 'REASON_REQUIRED' using errcode = 'PT422'; end if;
  update app.nie_published_checks set resolved_by = p_actor, resolved_at = now(), resolution = p_resolution, resolution_note = btrim(p_note)
   where id = ch.id;
end;
$$;
revoke all on function app.nie_guard_check(), app.nie_check_published(uuid, uuid, uuid), app.nie_resolve_check(uuid, uuid, text, text)
  from public, anon, authenticated;

-- Staff desk: open comparisons that need a person. Staff only; returns no member data.
create function public.editor_nutrition_checks()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_editor();
  return coalesce((
    select jsonb_agg(jsonb_build_object('checkId', ch.id, 'foodItemId', ch.food_item_id, 'name', r.name,
             'published', ch.published_value, 'calculated', ch.calculated_value, 'relativeGap', round(ch.relative_gap, 4),
             'threshold', ch.threshold, 'checkedAt', ch.checked_at) order by ch.checked_at)
      from app.nie_published_checks ch join public.food_revisions r on r.id = ch.revision_id
     where ch.needs_review and ch.resolved_at is null), '[]'::jsonb);
end;
$$;
revoke all on function public.editor_nutrition_checks() from public, anon;
grant execute on function public.editor_nutrition_checks() to authenticated;
