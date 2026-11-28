-- Log a USDA FoodData Central food straight into the diary (owner approval 18 Nov 02:27 UTC, item 7).
--
-- What this adds:
--   1. public.usda_food_search(q, limit): signed-in members search the sealed USDA reference releases
--      (Foundation Foods and SR Legacy, public domain / CC0). Meat, poultry and fish categories are left
--      out of the results. Nothing here says a food is vegetarian or vegan: USDA does not check that.
--   2. public.usda_diary_food(release, fdc_id): makes (once per member, then reuses) a private copy of
--      that USDA food, so the existing log form, portions, grams and diary snapshots work unchanged.
--      The copy is an owner-only food (kind 'custom', visibility 'private'): no other member sees it.
--      Its values are USDA's per 100 g, each with method 'published' and the USDA release's source
--      record. A nutrient USDA does not give stays unknown (null with a reason), never zero.
--   3. app.usda_member_foods links each copy to its USDA release and FDC ID. Closed to the Data API.
--   4. loggable_food gains 'usda' (null for every other food), so the log page can say where the
--      numbers come from; my_custom_foods ("Your own foods") leaves the USDA copies out.
--
-- No existing table changes; existing functions keep every field and meaning.

create table app.usda_member_foods (
  owner_id     uuid not null references auth.users (id) on delete cascade,
  release_id   uuid not null,
  fdc_id       integer not null,
  food_item_id uuid not null unique references public.food_items (id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (owner_id, release_id, fdc_id),
  foreign key (release_id, fdc_id) references app.usda_foods (release_id, fdc_id)
);
alter table app.usda_member_foods enable row level security;
revoke all on app.usda_member_foods from public, anon, authenticated;

-- USDA food groups that are meat, poultry or fish. Left out of search only: this is not a dietary claim
-- about anything that remains (a soup in another group can still contain chicken).
create function app.usda_hidden_category(p_category text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_category, '') in (
    'Beef Products', 'Pork Products', 'Poultry Products', 'Finfish and Shellfish Products',
    'Lamb, Veal, and Game Products', 'Sausages and Luncheon Meats');
$$;

create function public.usda_food_search(p_q text, p_limit integer default 12)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_words text[];
  v_limit integer := least(greatest(coalesce(p_limit, 12), 1), 25);
begin
  if auth.uid() is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  v_words := array(select w from regexp_split_to_table(lower(left(coalesce(p_q, ''), 120)), '[^a-z0-9]+') w where length(w) >= 2 limit 6);
  if cardinality(v_words) = 0 then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'releaseId', x.release_id, 'fdcId', x.fdc_id, 'dataType', x.data_type, 'releaseLabel', x.release_label,
             'description', x.description, 'category', x.category,
             'proteinPer100g', (x.nutrients -> 'protein_g' ->> 'value')::numeric,
             'energyPer100g', (x.nutrients -> 'energy_kcal' ->> 'value')::numeric,
             'portionCount', jsonb_array_length(x.portions))
           order by x.rank, length(x.description), x.description)
      from (
        select f.*, r.release_label,
               case when lower(f.description) like v_words[1] || '%' then 0 else 1 end as rank
          from (
            -- One row per FDC ID: the most recently imported sealed release that has it.
            select distinct on (uf.fdc_id) uf.*
              from app.usda_foods uf
              join app.usda_releases ur on ur.id = uf.release_id and ur.sealed
             where not app.usda_hidden_category(uf.category)
               and not exists (select 1 from unnest(v_words) w where lower(uf.description) not like '%' || w || '%')
             order by uf.fdc_id, ur.imported_at desc
          ) f
          join app.usda_releases r on r.id = f.release_id
         order by rank, length(f.description), f.description
         limit v_limit
      ) x), '[]'::jsonb);
end;
$$;

create function public.usda_diary_food(p_release_id uuid, p_fdc_id integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  f app.usda_foods;
  rel app.usda_releases;
  v_existing uuid;
  v_item uuid := gen_random_uuid();
  v_rev uuid := gen_random_uuid();
  d record;
  pp jsonb;
  v_label text;
begin
  if v_owner is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  select * into rel from app.usda_releases where id = p_release_id and sealed;
  if found then
    select * into f from app.usda_foods where release_id = p_release_id and fdc_id = p_fdc_id;
  end if;
  if rel.id is null or f.fdc_id is null then
    raise exception 'FOOD_NOT_FOUND' using errcode = 'PT404';
  end if;

  -- One copy per member and USDA food, even when the button is pressed twice at once.
  perform pg_advisory_xact_lock(hashtextextended(v_owner::text || p_release_id::text || p_fdc_id::text, 0));
  select food_item_id into v_existing from app.usda_member_foods
   where owner_id = v_owner and release_id = p_release_id and fdc_id = p_fdc_id;
  if v_existing is not null then
    return jsonb_build_object('foodItemId', v_existing, 'created', false);
  end if;
  if (select count(*) from public.food_items where kind = 'custom' and owner_id = v_owner) >= 1000 then
    raise exception 'CUSTOM_FOOD_LIMIT' using errcode = 'PT429';
  end if;

  insert into public.food_items (id, kind, owner_id, visibility, status)
  values (v_item, 'custom', v_owner, 'private', 'published');
  insert into public.food_revisions (id, food_item_id, revision_no, name, description, basis_kind, basis_amount, basis_unit)
  values (v_rev, v_item, 1, left(f.description, 200),
          format('USDA FoodData Central, %s release %s, FDC ID %s.%s',
                 case f.data_type when 'foundation' then 'Foundation Foods' else 'SR Legacy' end, rel.release_label, f.fdc_id,
                 coalesce(' Food group: ' || f.category || '.', '')),
          'mass', 100, 'g');

  for d in select code from public.nutrient_definitions loop
    if f.nutrients ? d.code then
      insert into public.nutrient_values (revision_id, nutrient_code, value, source_record_id, method)
      values (v_rev, d.code, (f.nutrients -> d.code ->> 'value')::numeric, rel.source_record_id, 'published');
    else
      insert into public.nutrient_values (revision_id, nutrient_code, value, source_record_id, method, missing_reason)
      values (v_rev, d.code, null, rel.source_record_id, 'unknown', 'not_provided');
    end if;
  end loop;

  -- USDA's household measures, each with its gram weight. A label USDA repeats is kept once.
  for pp in select * from jsonb_array_elements(f.portions) loop
    v_label := left(trim(regexp_replace(concat_ws(' ', pp ->> 'amount',
                 nullif(pp ->> 'unit', 'undetermined'), pp ->> 'modifier', pp ->> 'description'), '\s+', ' ', 'g')), 100);
    if v_label = '' or v_label = (pp ->> 'amount') then v_label := (pp ->> 'amount') || ' portion'; end if;
    v_label := v_label || ' (' || trim_scale((pp ->> 'grams')::numeric)::text || ' g)';
    insert into public.portions (revision_id, label, amount, unit, grams, source_record_id)
    values (v_rev, v_label, (pp ->> 'amount')::numeric, 'usda_portion', (pp ->> 'grams')::numeric, rel.source_record_id)
    on conflict (revision_id, label) do nothing;
  end loop;

  update public.food_revisions set published_at = now() where id = v_rev;
  update public.food_items set current_revision_id = v_rev where id = v_item;
  insert into app.usda_member_foods (owner_id, release_id, fdc_id, food_item_id)
  values (v_owner, p_release_id, p_fdc_id, v_item);

  return jsonb_build_object('foodItemId', v_item, 'created', true);
end;
$$;

-- loggable_food: add 'usda' (null unless the food is a member's USDA copy). my_custom_foods: leave the
-- USDA copies out of "Your own foods". Patched from the current definitions; fails if the text moved.
do $mig$
declare
  d text;
  before text;
begin
  d := pg_get_functiondef('public.loggable_food(uuid, boolean)'::regprocedure);
  before := d;
  d := replace(d,
    $x$'isDemo', fi.is_demo,$x$,
    $x$'isDemo', fi.is_demo,
    'usda', (select jsonb_build_object('fdcId', l.fdc_id, 'dataType', uf.data_type, 'releaseLabel', ur.release_label, 'category', uf.category)
               from app.usda_member_foods l
               join app.usda_foods uf on uf.release_id = l.release_id and uf.fdc_id = l.fdc_id
               join app.usda_releases ur on ur.id = l.release_id
              where l.food_item_id = fi.id and l.owner_id = v_owner),$x$);
  if d = before then raise exception 'loggable_food: isDemo text not found'; end if;
  execute d;

  d := pg_get_functiondef('public.my_custom_foods()'::regprocedure);
  before := d;
  d := replace(d,
    $x$where fi.kind = 'custom' and fi.owner_id = auth.uid() and auth.uid() is not null$x$,
    $x$where fi.kind = 'custom' and fi.owner_id = auth.uid() and auth.uid() is not null
     and not exists (select 1 from app.usda_member_foods l where l.food_item_id = fi.id)$x$);
  if d = before then raise exception 'my_custom_foods: where text not found'; end if;
  execute d;
end;
$mig$;

revoke execute on function app.usda_hidden_category(text) from public, anon, authenticated;
revoke execute on function public.usda_food_search(text, integer), public.usda_diary_food(uuid, integer) from public, anon;
grant execute on function public.usda_food_search(text, integer), public.usda_diary_food(uuid, integer) to authenticated;
