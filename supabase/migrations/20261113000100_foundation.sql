-- M1 · Foundation: extensions, private helper schema, roles, audit, reference data.
-- Requirement IDs: R-004 (private by default), R-O02 (roles and audit).
-- Spec: docs/06-unified-data-model.md, docs/12-security-and-privacy.md.

create extension if not exists postgis with schema extensions;
create extension if not exists btree_gist with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- `app` holds internal helpers. It is NOT exposed through the Data API
-- (only `public` and `graphql_public` are), so nothing here is callable over HTTP.
create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to anon, authenticated, service_role;

-- New functions must not be executable by everyone by default.
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon;
alter default privileges in schema app revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Roles: protected store, never editable profile metadata (doc 12).
-- ---------------------------------------------------------------------------
create table public.role_assignments (
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       text not null check (role in ('curator', 'publisher', 'moderator', 'admin')),
  granted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);
alter table public.role_assignments enable row level security;

create function app.has_role(p_role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.role_assignments ra
    where ra.user_id = auth.uid() and ra.role = p_role
  );
$$;
grant execute on function app.has_role(text) to anon, authenticated;

-- Members may see only their own role rows; nobody writes through the API.
create policy role_assignments_select_own on public.role_assignments
  for select to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Audit trail for privileged writes. Append-only; no diary text or secrets.
-- ---------------------------------------------------------------------------
create table public.audit_events (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references auth.users (id) on delete set null,
  action      text not null check (length(action) between 1 and 80),
  entity_type text not null check (length(entity_type) between 1 and 80),
  entity_id   uuid,
  occurred_at timestamptz not null default now(),
  reason      text check (reason is null or length(reason) <= 500),
  request_id  text check (request_id is null or length(request_id) <= 100)
);
alter table public.audit_events enable row level security;
create index audit_events_entity_idx on public.audit_events (entity_type, entity_id);

create policy audit_events_admin_read on public.audit_events
  for select to authenticated using (app.has_role('admin'));

create function app.audit(p_action text, p_entity_type text, p_entity_id uuid, p_reason text default null)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_events (actor_id, action, entity_type, entity_id, reason)
  values (auth.uid(), p_action, p_entity_type, p_entity_id, p_reason);
$$;
revoke execute on function app.audit(text, text, uuid, text) from public, anon, authenticated;

-- Block UPDATE/DELETE on audit rows even for privileged sessions that bypass RLS.
create function app.reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Table % is append-only', tg_table_name using errcode = 'PT403';
end;
$$;
create trigger audit_events_append_only
  before update or delete on public.audit_events
  for each row execute function app.reject_mutation();

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------
create table public.nutrient_definitions (
  code           text primary key check (code ~ '^[a-z_]+$'),
  name           text not null,
  canonical_unit text not null check (canonical_unit in ('kcal', 'g', 'mg')),
  display_order  smallint not null
);
alter table public.nutrient_definitions enable row level security;
create policy nutrient_definitions_read on public.nutrient_definitions
  for select to anon, authenticated using (true);

insert into public.nutrient_definitions (code, name, canonical_unit, display_order) values
  ('energy_kcal', 'Energy', 'kcal', 1),
  ('protein_g', 'Protein', 'g', 2),
  ('carb_g', 'Carbohydrate', 'g', 3),
  ('fat_g', 'Fat', 'g', 4),
  ('fiber_g', 'Fiber', 'g', 5),
  ('sodium_mg', 'Sodium', 'mg', 6);

-- Ingredient families used for explicit exclusions (docs 06, 08, 18; R-D08, R-C07).
create table public.ingredient_families (
  code          text primary key check (code ~ '^[a-z_]+$'),
  label         text not null,
  description   text not null,
  -- Families a vegetarian policy forbids (animal-flesh derivatives).
  non_vegetarian boolean not null,
  -- Families a vegan policy forbids (every animal-derived family).
  non_vegan     boolean not null
);
alter table public.ingredient_families enable row level security;
create policy ingredient_families_read on public.ingredient_families
  for select to anon, authenticated using (true);

insert into public.ingredient_families (code, label, description, non_vegetarian, non_vegan) values
  ('egg', 'Eggs', 'Whole egg, egg white or yolk, egg noodles, egg wash, egg-based mayonnaise and egg binders', false, true),
  ('dairy', 'Dairy', 'Milk, butter, ghee, cream, cheese, paneer, yogurt, whey and casein', false, true),
  ('honey', 'Honey', 'Honey and honey-based ingredients', false, true),
  ('gelatin', 'Gelatin', 'Gelatin from animal sources', true, true),
  ('animal_stock', 'Animal stock', 'Meat, poultry or fish stock and broth', true, true),
  ('fish_sauce', 'Fish sauce', 'Fish sauce, anchovy and shrimp paste', true, true),
  ('animal_rennet', 'Animal rennet', 'Animal-derived rennet used in some cheeses', true, true);
