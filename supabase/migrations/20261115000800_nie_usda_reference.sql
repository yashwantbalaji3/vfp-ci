-- NIE V1 slice N-1: USDA FoodData Central reference data (docs/24 section 3.2; approval A-NIE-V1).
--
-- What this adds (no existing table or function changes):
--   1. app.usda_releases: one row per imported USDA file, with its fingerprint (SHA-256 of the file),
--      the fingerprint of what we read from it, the importer version and a source record.
--   2. app.usda_foods: one row per USDA food in a release: description, category, the six nutrients
--      per 100 g as exact decimals (each with its USDA nutrient number) and USDA's portion weights.
--   3. Writing only through app.usda_begin_release / app.usda_add_foods / app.usda_seal_release,
--      run by the local import script (scripts/usda-import.mjs). Once sealed, a release and its foods
--      can never change or be deleted, so an old calculation can always be repeated exactly.
--   4. Reading helpers for later slices: a nutrient per 100 g, an amount for a number of grams, and
--      the grams of a USDA portion. Missing stays null, never zero.
--
-- Not visible to visitors or members: the `app` schema is not in the Data API, and every table and
-- function here is closed to anon and authenticated. Nothing here publishes a catalog food: turning
-- a reference food into a catalog ingredient will go through the two-person review (slice N-2).
-- Licence (checked 15 Nov 2026 at fdc.nal.usda.gov/help): public domain, CC0 1.0; citation requested.

-- True when every nutrient is one of the six, in its expected unit, with a plain non-negative decimal.
create function app.usda_nutrients_valid(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p) = 'object' and not exists (
    select 1 from jsonb_each(p) e
     where e.key not in ('protein_g', 'fat_g', 'carb_g', 'fiber_g', 'sodium_mg', 'energy_kcal')
        or jsonb_typeof(e.value) <> 'object'
        or coalesce(e.value ->> 'value', '') !~ '^[0-9]+(\.[0-9]+)?$'
        or e.value ->> 'unit' is distinct from case e.key when 'sodium_mg' then 'mg' when 'energy_kcal' then 'kcal' else 'g' end
        or jsonb_typeof(e.value -> 'usdaNutrientId') <> 'number');
$$;

-- True when every portion has a positive amount and a positive gram weight.
create function app.usda_portions_valid(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p) = 'array' and not exists (
    select 1 from jsonb_array_elements(p) x
     where jsonb_typeof(x -> 'usdaPortionId') <> 'number'
        or coalesce(x ->> 'grams', '') !~ '^[0-9]+(\.[0-9]+)?$' or (x ->> 'grams')::numeric <= 0
        or coalesce(x ->> 'amount', '') !~ '^[0-9]+(\.[0-9]+)?$' or (x ->> 'amount')::numeric <= 0);
$$;

create table app.usda_releases (
  id                uuid primary key default gen_random_uuid(),
  dataset           text not null check (dataset in ('foundation', 'sr_legacy')),
  release_label     text not null check (release_label ~ '^[0-9]{4}-[0-9]{2}(-[0-9]{2})?$'),
  file_name         text not null check (file_name ~ '^FoodData_Central_[A-Za-z0-9_.-]+\.zip$'),
  file_sha256       text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  source_url        text not null check (source_url ~ '^https://fdc\.nal\.usda\.gov/fdc-datasets/'),
  importer_version  text not null check (length(importer_version) between 1 and 40),
  food_count        integer not null check (food_count > 0),
  content_sha256    text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  report            jsonb not null default '{}'::jsonb,
  source_record_id  uuid not null references public.source_records (id),
  sealed            boolean not null default false,
  imported_at       timestamptz not null default now(),
  unique (dataset, release_label, importer_version)
);

create table app.usda_foods (
  release_id        uuid not null references app.usda_releases (id),
  fdc_id            integer not null check (fdc_id > 0),
  data_type         text not null check (data_type in ('foundation', 'sr_legacy')),
  description       text not null check (length(description) between 1 and 500),
  category          text,
  ndb_number        text,
  publication_date  date,
  -- {"protein_g": {"value": "9.02", "unit": "g", "usdaNutrientId": 1003, "derivation": "NC"}, ...}
  -- Only nutrients USDA gives in the expected unit are present; anything else is absent (unknown).
  nutrients         jsonb not null check (app.usda_nutrients_valid(nutrients)),
  -- [{"usdaPortionId": 81549, "amount": "1", "unit": "cup", "modifier": null, "description": null, "grams": "198"}]
  portions          jsonb not null check (app.usda_portions_valid(portions)),
  record_sha256     text not null check (record_sha256 ~ '^[0-9a-f]{64}$'),
  primary key (release_id, fdc_id)
);

alter table app.usda_releases enable row level security;
alter table app.usda_foods enable row level security;
revoke all on app.usda_releases from public, anon, authenticated;
revoke all on app.usda_foods from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Permanence: foods are added only to an unsealed release; sealing is one way; nothing is
-- ever changed or deleted afterwards (not even by the database owner through these tables).
-- ---------------------------------------------------------------------------
create function app.guard_usda_release()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'USDA reference releases are permanent' using errcode = 'PT403';
  end if;
  if tg_op = 'UPDATE' then
    -- The only change ever allowed: sealing an unsealed release, nothing else at the same time.
    if old.sealed or not new.sealed
       or (to_jsonb(new) - 'sealed') is distinct from (to_jsonb(old) - 'sealed') then
      raise exception 'USDA reference releases are permanent' using errcode = 'PT403';
    end if;
  end if;
  return new;
end;
$$;
create trigger usda_releases_guard before update or delete on app.usda_releases
  for each row execute function app.guard_usda_release();

create function app.guard_usda_food()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'USDA reference foods are permanent' using errcode = 'PT403';
  end if;
  if (select r.sealed from app.usda_releases r where r.id = new.release_id) then
    raise exception 'USDA reference release is sealed' using errcode = 'PT403';
  end if;
  return new;
end;
$$;
create trigger usda_foods_guard before insert or update or delete on app.usda_foods
  for each row execute function app.guard_usda_food();

create function app.guard_usda_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'USDA reference data is permanent' using errcode = 'PT403';
end;
$$;
create trigger usda_releases_no_truncate before truncate on app.usda_releases
  for each statement execute function app.guard_usda_truncate();
create trigger usda_foods_no_truncate before truncate on app.usda_foods
  for each statement execute function app.guard_usda_truncate();

-- ---------------------------------------------------------------------------
-- Writing (local import script only, as the database owner, in one transaction)
-- ---------------------------------------------------------------------------
-- Starts a release. Returns {"status": "new", "releaseId": ...}, or {"status": "unchanged"} when the
-- same file was already imported by the same importer and gave the same content. The same release
-- and importer with a different file or different content is refused: nothing is overwritten.
create function app.usda_begin_release(p jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  r app.usda_releases;
  v_source uuid;
  v_licence uuid;
  v_record uuid;
begin
  select * into r from app.usda_releases
   where dataset = p ->> 'dataset' and release_label = p ->> 'releaseLabel' and importer_version = p ->> 'importerVersion';
  if found then
    if r.sealed and r.file_sha256 = p ->> 'fileSha256' and r.content_sha256 = p ->> 'contentSha256' and r.food_count = (p ->> 'foodCount')::integer then
      return jsonb_build_object('status', 'unchanged', 'releaseId', r.id);
    end if;
    raise exception 'USDA_RELEASE_CONFLICT' using errcode = 'PT409',
      detail = 'This release was already imported with a different file or different content; nothing was changed.';
  end if;

  -- The USDA source and its licence, created once.
  select s.id into v_source from public.sources s where s.publisher = 'USDA FoodData Central' and s.source_type = 'government_dataset' and not s.is_demo;
  if v_source is null then
    insert into public.licenses (label, terms_url, checked_at, permitted_uses, attribution)
    values ('CC0 1.0 Universal (USDA FoodData Central, public domain)', 'https://fdc.nal.usda.gov/help/', now(),
            array['display', 'store', 'derive', 'distribute'],
            'U.S. Department of Agriculture, Agricultural Research Service, Beltsville Human Nutrition Research Center. FoodData Central. Available from https://fdc.nal.usda.gov/.')
    returning id into v_licence;
    insert into public.sources (publisher, source_type, canonical_url, license_id, access_scope, is_demo, retrieved_at)
    values ('USDA FoodData Central', 'government_dataset', 'https://fdc.nal.usda.gov/', v_licence, 'public', false, now())
    returning id into v_source;
  end if;
  insert into public.source_records (source_id, external_id, source_version, observed_at, content_hash, evidence_summary, rights_status)
  values (v_source, p ->> 'fileName', p ->> 'releaseLabel', now(), p ->> 'fileSha256',
          format('USDA FoodData Central %s release %s, file %s, read by importer %s.', p ->> 'dataset', p ->> 'releaseLabel', p ->> 'fileName', p ->> 'importerVersion'),
          'cleared')
  returning id into v_record;

  insert into app.usda_releases (dataset, release_label, file_name, file_sha256, source_url, importer_version, food_count, content_sha256, report, source_record_id)
  values (p ->> 'dataset', p ->> 'releaseLabel', p ->> 'fileName', p ->> 'fileSha256', p ->> 'sourceUrl', p ->> 'importerVersion',
          (p ->> 'foodCount')::integer, p ->> 'contentSha256', coalesce(p -> 'report', '{}'::jsonb), v_record)
  returning * into r;
  return jsonb_build_object('status', 'new', 'releaseId', r.id);
end;
$$;

-- Adds a batch of normalized foods to an unsealed release.
create function app.usda_add_foods(p_release_id uuid, p_foods jsonb)
returns integer
language sql
set search_path = ''
as $$
  with added as (
    insert into app.usda_foods (release_id, fdc_id, data_type, description, category, ndb_number, publication_date, nutrients, portions, record_sha256)
    select p_release_id, (f ->> 'fdcId')::integer, f ->> 'dataType', f ->> 'description', f ->> 'category', f ->> 'ndbNumber',
           (f ->> 'publicationDate')::date, f -> 'nutrients', f -> 'portions', f ->> 'recordSha256'
      from jsonb_array_elements(p_foods) f
    returning 1)
  select count(*)::integer from added;
$$;

-- Seals a release once every food is in. Refuses if the count differs from the one announced.
create function app.usda_seal_release(p_release_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  r app.usda_releases;
  n integer;
begin
  select * into r from app.usda_releases where id = p_release_id;
  if not found then raise exception 'USDA_RELEASE_NOT_FOUND' using errcode = 'PT404'; end if;
  select count(*) into n from app.usda_foods where release_id = p_release_id;
  if n <> r.food_count then
    raise exception 'USDA_RELEASE_INCOMPLETE' using errcode = 'PT422', detail = format('%s foods announced, %s added', r.food_count, n);
  end if;
  update app.usda_releases set sealed = true where id = p_release_id;
  return jsonb_build_object('status', 'sealed', 'releaseId', p_release_id, 'foods', n);
end;
$$;

-- ---------------------------------------------------------------------------
-- Reading (for later slices; exact decimals; null means unknown)
-- ---------------------------------------------------------------------------
-- A nutrient per 100 g, or null when USDA does not give it (or the release is not sealed).
create function app.usda_per_100g(p_release_id uuid, p_fdc_id integer, p_code text)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select (f.nutrients -> p_code ->> 'value')::numeric
    from app.usda_foods f join app.usda_releases r on r.id = f.release_id and r.sealed
   where f.release_id = p_release_id and f.fdc_id = p_fdc_id;
$$;

-- The amount of a nutrient in a number of grams: value per 100 g x grams / 100. Null when either is unknown.
create function app.usda_amount(p_release_id uuid, p_fdc_id integer, p_code text, p_grams numeric)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select case when p_grams is null or p_grams <= 0 then null
              else app.usda_per_100g(p_release_id, p_fdc_id, p_code) * p_grams / 100 end;
$$;

-- Grams for a quantity of one of USDA's own portions ("2 cups"): portion grams / portion amount x quantity.
-- Null when that portion does not exist for the food; never a general guess such as a density.
create function app.usda_portion_grams(p_release_id uuid, p_fdc_id integer, p_usda_portion_id bigint, p_quantity numeric)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select case when p_quantity is null or p_quantity <= 0 then null
              else (x ->> 'grams')::numeric / (x ->> 'amount')::numeric * p_quantity end
    from app.usda_foods f
    join app.usda_releases r on r.id = f.release_id and r.sealed
    cross join lateral jsonb_array_elements(f.portions) x
   where f.release_id = p_release_id and f.fdc_id = p_fdc_id and (x ->> 'usdaPortionId')::bigint = p_usda_portion_id;
$$;

revoke all on function app.usda_nutrients_valid(jsonb) from public, anon, authenticated;
revoke all on function app.usda_portions_valid(jsonb) from public, anon, authenticated;
revoke all on function app.guard_usda_release() from public, anon, authenticated;
revoke all on function app.guard_usda_food() from public, anon, authenticated;
revoke all on function app.guard_usda_truncate() from public, anon, authenticated;
revoke all on function app.usda_begin_release(jsonb) from public, anon, authenticated;
revoke all on function app.usda_add_foods(uuid, jsonb) from public, anon, authenticated;
revoke all on function app.usda_seal_release(uuid) from public, anon, authenticated;
revoke all on function app.usda_per_100g(uuid, integer, text) from public, anon, authenticated;
revoke all on function app.usda_amount(uuid, integer, text, numeric) from public, anon, authenticated;
revoke all on function app.usda_portion_grams(uuid, integer, bigint, numeric) from public, anon, authenticated;
