-- Eating out in the week plan (owner direction 22 Nov 2026 06:25 UTC: "complete real-data weekly meal planning";
-- docs/68). The founder can put a real restaurant meal from the private preview on a day of their week plan,
-- next to planned recipes. Like preview saves (20261119000100), the rows live in the private staging schema and
-- every function refuses anyone but the founder. A plan is only an intention: nothing here touches the diary,
-- goals or totals, and a planned meal is never logged on the founder's behalf.

create table staging.preview_meal_plans (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  dish_id      uuid not null references staging.dishes (id),
  planned_date date not null,
  meal_slot    text check (meal_slot is null or meal_slot in ('breakfast', 'lunch', 'dinner', 'snack')),
  created_at   timestamptz not null default now()
);
create index preview_meal_plans_user_date on staging.preview_meal_plans (user_id, planned_date);
alter table staging.preview_meal_plans enable row level security;
alter table staging.preview_meal_plans force row level security;
revoke all on staging.preview_meal_plans from public, anon, authenticated;
create policy preview_meal_plans_owner on staging.preview_meal_plans for all to postgres using (true) with check (true);

create function public.menu_preview_plan(p_dish uuid, p_date date, p_slot text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform app.require_founder();
  -- Only a meal the preview itself shows (a complete or build-your-own meal at a linked place).
  if not app.preview_meal_ok(p_dish) then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
  if p_date is null or p_date < current_date - 7 or p_date > current_date + 62 then raise exception 'INVALID_DATE' using errcode = '22023'; end if;
  if p_slot is not null and p_slot not in ('breakfast', 'lunch', 'dinner', 'snack') then raise exception 'INVALID_SLOT' using errcode = '22023'; end if;
  if (select count(*) from staging.preview_meal_plans where user_id = auth.uid() and planned_date = p_date) >= 12 then
    raise exception 'TOO_MANY' using errcode = '22023';
  end if;
  insert into staging.preview_meal_plans (user_id, dish_id, planned_date, meal_slot)
  values (auth.uid(), p_dish, p_date, p_slot) returning id into v_id;
  return jsonb_build_object('planId', v_id);
end;
$$;
revoke all on function public.menu_preview_plan(uuid, date, text) from public, anon;
grant execute on function public.menu_preview_plan(uuid, date, text) to authenticated;

create function public.menu_preview_unplan(p_plan uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.require_founder();
  delete from staging.preview_meal_plans where id = p_plan and user_id = auth.uid();
  if not found then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
  return jsonb_build_object('planId', p_plan, 'removed', true);
end;
$$;
revoke all on function public.menu_preview_unplan(uuid) from public, anon;
grant execute on function public.menu_preview_unplan(uuid) to authenticated;

create function public.menu_preview_plans(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_founder();
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then raise exception 'INVALID_RANGE' using errcode = '22023'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('planId', x.id, 'dishId', x.dish_id, 'date', x.planned_date, 'mealSlot', x.meal_slot)
                     order by x.planned_date, x.created_at)
      from staging.preview_meal_plans x
     where x.user_id = auth.uid() and x.planned_date between p_from and p_to), '[]'::jsonb);
end;
$$;
revoke all on function public.menu_preview_plans(date, date) from public, anon;
grant execute on function public.menu_preview_plans(date, date) to authenticated;

-- Rollback: drop the three functions and staging.preview_meal_plans (the founder's planned restaurant meals only).
