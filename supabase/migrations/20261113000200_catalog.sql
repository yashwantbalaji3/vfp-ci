-- M1 · Unified food catalog, evidence, rights and recipes.
-- Requirement IDs: R-003, R-005, R-D08, R-C07 (data), R-O01.
-- Spec: docs/06, 07, 08. Audit findings A4 (ingredient-family evidence).

-- ---------------------------------------------------------------------------
-- Markets and venues
-- ---------------------------------------------------------------------------
create table public.markets (
  id                uuid primary key default gen_random_uuid(),
  slug              text not null unique check (slug ~ '^[a-z0-9-]{2,60}$'),
  name              text not null check (length(name) between 1 and 120),
  country_code      char(2) not null default 'US',
  default_timezone  text not null,
  coverage_geometry extensions.geography(MultiPolygon, 4326),
  state             text not null default 'planned' check (state in ('planned', 'active', 'retired')),
  created_at        timestamptz not null default now()
);

create table public.venues (
  id           uuid primary key default gen_random_uuid(),
  market_id    uuid not null references public.markets (id),
  slug         text not null check (slug ~ '^[a-z0-9-]{2,120}$'),
  name         text not null check (length(name) between 1 and 200),
  neighborhood text check (neighborhood is null or length(neighborhood) <= 120),
  street       text,
  locality     text,
  region       text,
  postal_code  text,
  location     extensions.geography(Point, 4326),
  timezone     text not null,
  venue_type   text not null check (venue_type in ('restaurant', 'cafe', 'bakery', 'food_truck', 'market_stall', 'other')),
  status       text not null default 'draft' check (status in ('draft', 'in_review', 'published', 'temporarily_closed', 'closed', 'withdrawn')),
  is_demo      boolean not null default false,
  reviewed_at  timestamptz,
  created_at   timestamptz not null default now(),
  unique (market_id, slug)
);
create index venues_location_gix on public.venues using gist (location);
create index venues_market_status_idx on public.venues (market_id, status);

-- ---------------------------------------------------------------------------
-- Licensing and provenance
-- ---------------------------------------------------------------------------
create table public.licenses (
  id              uuid primary key default gen_random_uuid(),
  label           text not null check (length(label) between 1 and 200 and lower(label) <> 'internet'),
  terms_url       text check (terms_url is null or terms_url ~ '^https://'),
  checked_at      timestamptz not null,
  permitted_uses  text[] not null check (permitted_uses <@ array['display', 'store', 'derive', 'distribute']::text[]),
  attribution     text,
  expiry          date,
  approved_by     uuid references auth.users (id) on delete set null
);

create table public.sources (
  id            uuid primary key default gen_random_uuid(),
  publisher     text not null check (length(publisher) between 1 and 200),
  source_type   text not null check (source_type in ('government_dataset', 'operator_statement', 'menu', 'product_label', 'curator_assessment', 'community_report', 'original_recipe', 'synthetic_fixture', 'user_entered')),
  canonical_url text check (canonical_url is null or canonical_url ~ '^https://'),
  license_id    uuid references public.licenses (id),
  access_scope  text not null default 'public' check (access_scope in ('public', 'restricted', 'private')),
  owner_id      uuid references auth.users (id) on delete cascade,
  is_demo       boolean not null default false,
  retrieved_at  timestamptz,
  check (access_scope <> 'private' or owner_id is not null)
);

create table public.source_records (
  id               uuid primary key default gen_random_uuid(),
  source_id        uuid not null references public.sources (id) on delete cascade,
  external_id      text,
  source_version   text,
  observed_at      timestamptz not null,
  content_hash     text,
  evidence_summary text check (evidence_summary is null or length(evidence_summary) <= 2000),
  rights_status    text not null default 'unreviewed' check (rights_status in ('unreviewed', 'cleared', 'restricted', 'denied'))
);
create index source_records_source_idx on public.source_records (source_id);

-- ---------------------------------------------------------------------------
-- Foods and immutable revisions
-- ---------------------------------------------------------------------------
create table public.food_items (
  id                  uuid primary key default gen_random_uuid(),
  kind                text not null check (kind in ('ingredient', 'packaged', 'dish', 'recipe', 'custom')),
  owner_id            uuid references auth.users (id) on delete cascade,
  visibility          text not null check (visibility in ('public', 'private')),
  current_revision_id uuid,
  status              text not null default 'draft' check (status in ('draft', 'in_review', 'approved', 'published', 'stale', 'withdrawn')),
  is_demo             boolean not null default false,
  version             integer not null default 1,
  created_at          timestamptz not null default now(),
  -- Private foods always have an owner; public foods never depend on a private owner.
  check ((visibility = 'private' and owner_id is not null) or (visibility = 'public' and owner_id is null)),
  -- Custom foods are always private (a public contribution is a separate reviewed object).
  check (kind <> 'custom' or visibility = 'private'),
  check (visibility = 'public' or kind = 'custom')
);
create index food_items_owner_idx on public.food_items (owner_id) where owner_id is not null;

create table public.food_revisions (
  id                uuid primary key default gen_random_uuid(),
  food_item_id      uuid not null references public.food_items (id) on delete cascade,
  revision_no       integer not null check (revision_no > 0),
  name              text not null check (length(name) between 1 and 200),
  description       text check (description is null or length(description) <= 4000),
  preparation_state text check (preparation_state is null or preparation_state in ('raw', 'cooked', 'dried', 'canned', 'prepared', 'as_sold')),
  brand             text check (brand is null or length(brand) <= 200),
  gtin              text check (gtin is null or gtin ~ '^[0-9]{8,14}$'),
  basis_kind        text not null check (basis_kind in ('mass', 'volume', 'serving')),
  basis_amount      numeric not null check (basis_amount > 0),
  basis_unit        text not null,
  created_at        timestamptz not null default now(),
  published_at      timestamptz,
  unique (food_item_id, revision_no),
  unique (id, food_item_id),
  check (
    (basis_kind = 'mass' and basis_unit = 'g') or
    (basis_kind = 'volume' and basis_unit = 'ml') or
    (basis_kind = 'serving' and basis_unit = 'serving')
  )
);
create index food_revisions_name_trgm on public.food_revisions using gin (name extensions.gin_trgm_ops);
create index food_revisions_fts on public.food_revisions using gin (to_tsvector('english', name || ' ' || coalesce(description, '')));

-- current_revision_id must be a revision of the SAME item (composite FK).
alter table public.food_items
  add constraint food_items_current_revision_fk
  foreign key (current_revision_id, id) references public.food_revisions (id, food_item_id)
  deferrable initially deferred;

create table public.portions (
  id               uuid primary key default gen_random_uuid(),
  revision_id      uuid not null references public.food_revisions (id) on delete cascade,
  label            text not null check (length(label) between 1 and 120),
  amount           numeric not null check (amount > 0),
  unit             text not null check (length(unit) between 1 and 40),
  grams            numeric check (grams is null or grams > 0),
  milliliters      numeric check (milliliters is null or milliliters > 0),
  source_record_id uuid references public.source_records (id),
  unique (revision_id, label)
);

create table public.nutrient_values (
  revision_id      uuid not null references public.food_revisions (id) on delete cascade,
  nutrient_code    text not null references public.nutrient_definitions (code),
  value            numeric check (value is null or value >= 0),
  lower_value      numeric check (lower_value is null or lower_value >= 0),
  upper_value      numeric check (upper_value is null or upper_value >= 0),
  source_record_id uuid references public.source_records (id),
  method           text not null check (method in ('published', 'calculated', 'estimated', 'user_entered', 'unknown')),
  missing_reason   text check (missing_reason in ('not_provided', 'unavailable_conversion', 'incomplete_recipe', 'source_conflict', 'not_applicable')),
  assumptions      text check (assumptions is null or length(assumptions) <= 1000),
  primary key (revision_id, nutrient_code),
  -- Unknown is null WITH a reason; a reported value never carries a missing reason.
  check ((value is null) = (missing_reason is not null)),
  check ((value is null) or method <> 'unknown'),
  check (lower_value is null or upper_value is null or lower_value <= upper_value),
  -- Bounds are scenario ranges for estimates only.
  check ((lower_value is null and upper_value is null) or method = 'estimated'),
  -- Published/calculated/estimated values cite a specific source record.
  check (value is null or method = 'user_entered' or source_record_id is not null)
);

create table public.dietary_claims (
  id               uuid primary key default gen_random_uuid(),
  revision_id      uuid not null references public.food_revisions (id) on delete cascade,
  diet             text not null check (diet in ('vegetarian', 'vegan')),
  outcome          text not null check (outcome in ('compatible', 'incompatible', 'unknown', 'conditional')),
  evidence_tier    text not null check (evidence_tier in ('documented', 'curator_assessment', 'community_report', 'unknown')),
  source_record_id uuid references public.source_records (id),
  modifications    text check (modifications is null or length(modifications) <= 1000),
  checked_at       timestamptz not null,
  expires_at       timestamptz,
  conflict_state   text not null default 'none' check (conflict_state in ('none', 'disputed')),
  unique (revision_id, diet),
  check (outcome <> 'conditional' or modifications is not null),
  check (evidence_tier = 'unknown' or source_record_id is not null)
);

create table public.allergen_statements (
  id               uuid primary key default gen_random_uuid(),
  revision_id      uuid not null references public.food_revisions (id) on delete cascade,
  allergen         text not null check (allergen in ('milk', 'egg', 'peanut', 'tree_nut', 'soy', 'wheat', 'sesame', 'fish', 'shellfish', 'mustard', 'celery', 'lupin', 'sulfite', 'gluten')),
  presence         text not null check (presence in ('present', 'absent_by_statement', 'unknown')),
  cross_contact    text not null default 'unknown' check (cross_contact in ('unknown', 'reported')),
  source_record_id uuid references public.source_records (id),
  checked_at       timestamptz not null,
  unique (revision_id, allergen)
);

-- Audit finding A4: evidence for explicit ingredient exclusions.
create table public.ingredient_family_statements (
  id               uuid primary key default gen_random_uuid(),
  revision_id      uuid not null references public.food_revisions (id) on delete cascade,
  family           text not null references public.ingredient_families (code),
  presence         text not null check (presence in ('present', 'absent_by_statement', 'unknown')),
  source_record_id uuid references public.source_records (id),
  detail           text check (detail is null or length(detail) <= 500),
  checked_at       timestamptz not null,
  expires_at       timestamptz,
  unique (revision_id, family),
  check (presence = 'unknown' or source_record_id is not null)
);

-- ---------------------------------------------------------------------------
-- Dishes, prices and recipes
-- ---------------------------------------------------------------------------
create table public.dishes (
  food_item_id        uuid primary key references public.food_items (id) on delete cascade,
  venue_id            uuid not null references public.venues (id),
  menu_section        text check (menu_section is null or length(menu_section) <= 120),
  availability_status text not null default 'available' check (availability_status in ('available', 'seasonal', 'retired'))
);
create index dishes_venue_idx on public.dishes (venue_id);

create table public.dish_prices (
  id                  uuid primary key default gen_random_uuid(),
  dish_id             uuid not null references public.dishes (food_item_id) on delete cascade,
  amount_minor        integer not null check (amount_minor > 0),
  currency            char(3) not null default 'USD' check (currency = 'USD'),
  serving_description text,
  checked_at          timestamptz not null,
  source_record_id    uuid not null references public.source_records (id)
);

create table public.recipe_revisions (
  food_revision_id uuid primary key references public.food_revisions (id) on delete cascade,
  yield_servings   numeric not null check (yield_servings > 0),
  cooked_yield_g   numeric check (cooked_yield_g is null or cooked_yield_g > 0),
  prep_minutes     integer check (prep_minutes is null or prep_minutes >= 0),
  cook_minutes     integer check (cook_minutes is null or cook_minutes >= 0),
  equipment        text[] not null default '{}',
  rights_record_id uuid references public.source_records (id),
  trial_cooked_at  timestamptz
);

create table public.recipe_ingredients (
  id                     uuid primary key default gen_random_uuid(),
  recipe_revision_id     uuid not null references public.recipe_revisions (food_revision_id) on delete cascade,
  ingredient_revision_id uuid not null references public.food_revisions (id),
  position               integer not null check (position > 0),
  quantity               numeric not null check (quantity > 0),
  unit                   text not null,
  grams                  numeric check (grams is null or grams > 0),
  optional               boolean not null default false,
  included_by_default    boolean not null default true,
  substitution_group     text,
  unique (recipe_revision_id, position),
  check (ingredient_revision_id <> recipe_revision_id)
);

create table public.recipe_steps (
  id                 uuid primary key default gen_random_uuid(),
  recipe_revision_id uuid not null references public.recipe_revisions (food_revision_id) on delete cascade,
  ordinal            integer not null check (ordinal > 0),
  instruction        text not null check (length(instruction) between 1 and 2000),
  timer_seconds      integer check (timer_seconds is null or timer_seconds > 0),
  unique (recipe_revision_id, ordinal)
);

create table public.venue_facts (
  id               uuid primary key default gen_random_uuid(),
  venue_id         uuid not null references public.venues (id) on delete cascade,
  field            text not null check (field in ('hours', 'price_band', 'phone', 'website', 'status_note')),
  typed_value      jsonb not null,
  source_record_id uuid not null references public.source_records (id),
  valid_from       date,
  checked_at       timestamptz not null,
  expires_at       timestamptz
);

-- ---------------------------------------------------------------------------
-- Immutability and visibility guards
-- ---------------------------------------------------------------------------

-- Ownership and visibility of a food never change after creation (no "toggle to public").
create function app.guard_food_item_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.owner_id is distinct from old.owner_id
     or new.visibility is distinct from old.visibility
     or new.kind is distinct from old.kind then
    raise exception 'Food owner, visibility and kind are immutable' using errcode = 'PT403';
  end if;
  return new;
end;
$$;
create trigger food_items_guard before update on public.food_items
  for each row execute function app.guard_food_item_update();

-- Published revisions are immutable; withdrawal changes the item status, not evidence.
create function app.guard_published_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.published_at is not null then
    -- Owners may delete their private custom foods (account deletion, R-007);
    -- diary snapshots keep their own frozen copy of the data.
    -- (During a cascade from food_items the parent row is already gone.)
    if tg_op = 'DELETE' and not exists (
      select 1 from public.food_items fi where fi.id = old.food_item_id and fi.visibility = 'public'
    ) then
      return old;
    end if;
    raise exception 'Published revision % is immutable; create a new revision', old.id using errcode = 'PT403';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger food_revisions_immutable before update or delete on public.food_revisions
  for each row execute function app.guard_published_revision();

-- Children of a published revision are frozen too.
create function app.guard_revision_child()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_rev uuid;
begin
  -- Rows of different tables name their revision column differently.
  v_rev := coalesce(
    to_jsonb(case when tg_op = 'DELETE' then old else new end) ->> 'revision_id',
    to_jsonb(case when tg_op = 'DELETE' then old else new end) ->> 'recipe_revision_id',
    to_jsonb(case when tg_op = 'DELETE' then old else new end) ->> 'food_revision_id'
  )::uuid;
  if exists (
    select 1 from public.food_revisions r
    join public.food_items fi on fi.id = r.food_item_id
    where r.id = v_rev and r.published_at is not null
      and not (tg_op = 'DELETE' and fi.visibility = 'private')
  ) then
    raise exception 'Revision % is published and its evidence is immutable', v_rev using errcode = 'PT403';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger portions_frozen before insert or update or delete on public.portions
  for each row execute function app.guard_revision_child();
create trigger nutrient_values_frozen before insert or update or delete on public.nutrient_values
  for each row execute function app.guard_revision_child();
create trigger dietary_claims_frozen before insert or update or delete on public.dietary_claims
  for each row execute function app.guard_revision_child();
create trigger allergen_statements_frozen before insert or update or delete on public.allergen_statements
  for each row execute function app.guard_revision_child();
create trigger family_statements_frozen before insert or update or delete on public.ingredient_family_statements
  for each row execute function app.guard_revision_child();
create trigger recipe_revisions_frozen before insert or update or delete on public.recipe_revisions
  for each row execute function app.guard_revision_child();
create trigger recipe_ingredients_frozen before insert or update or delete on public.recipe_ingredients
  for each row execute function app.guard_revision_child();
create trigger recipe_steps_frozen before insert or update or delete on public.recipe_steps
  for each row execute function app.guard_revision_child();

-- Note on disputes: a dispute is recorded by publishing a new revision with
-- conflict_state = 'disputed' (or withdrawing the item). Historical evidence is
-- never edited in place, so diary snapshots keep explaining what was shown.

-- ---------------------------------------------------------------------------
-- Visibility helpers (security definer, used by RLS; not exposed over HTTP)
-- ---------------------------------------------------------------------------
create function app.can_read_food_item(p_item_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.food_items fi
    where fi.id = p_item_id
      and (
        (fi.visibility = 'public' and fi.status in ('published', 'stale', 'withdrawn'))
        or (fi.visibility = 'private' and fi.owner_id = auth.uid())
        or (fi.visibility = 'public' and (app.has_role('curator') or app.has_role('publisher')))
      )
  );
$$;

create function app.can_read_revision(p_revision_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.food_revisions r
    join public.food_items fi on fi.id = r.food_item_id
    where r.id = p_revision_id
      and (
        (fi.visibility = 'public' and r.published_at is not null and fi.status in ('published', 'stale', 'withdrawn'))
        or (fi.visibility = 'private' and fi.owner_id = auth.uid())
        or (fi.visibility = 'public' and (app.has_role('curator') or app.has_role('publisher')))
      )
  );
$$;

create function app.is_catalog_editor()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.has_role('curator') or app.has_role('publisher');
$$;

grant execute on function app.can_read_food_item(uuid) to anon, authenticated;
grant execute on function app.can_read_revision(uuid) to anon, authenticated;
grant execute on function app.is_catalog_editor() to anon, authenticated;
