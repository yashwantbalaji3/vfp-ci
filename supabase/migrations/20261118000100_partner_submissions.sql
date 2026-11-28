-- Restaurant submissions (owner direction 17 Nov 2026 23:55 UTC, point 2; proposal docs/47).
--
--   * A restaurant representative CLAIMS a place that already exists in the private catalog.
--   * A moderator (the founder, role "publisher") records an OWNERSHIP CHECK done outside the app
--     (email at the restaurant's own domain, postal code, phone call to the public number, in person).
--     Nobody checks their own claim. Until a check passes, nothing from the claim counts.
--   * The representative SUBMITS a menu (an export file or form rows) under a stated LICENCE version.
--     Every dish keeps the restaurant's own words for dietary statements, ingredients, allergens and
--     cross-contact, and nutrition with its unit and basis. Blank stays null, never zero.
--   * Automatic checks only FLAG (never correct). Every item waits in a private MODERATION QUEUE; a
--     moderator verifies or rejects it. A restaurant can never approve its own submission.
--   * Everything is append-only and private: RLS forced, no grants, functions take the acting user.
--     Verifying an item does not publish it; publication stays a separate owner decision.

create schema partner;
revoke all on schema partner from public, anon, authenticated;

create function partner.has_role(p_actor uuid, p_role text)
returns boolean
language sql
stable
set search_path = ''
as $$ select p_actor is not null and exists (select 1 from public.role_assignments r where r.user_id = p_actor and r.role = p_role); $$;

create table partner.licence_versions (
  version     text primary key check (version ~ '^v[0-9]+-[0-9]{4}-[0-9]{2}$'),
  text        text not null check (length(text) between 50 and 5000),
  created_at  timestamptz not null default now()
);
insert into partner.licence_versions (version, text) values ('v1-2026-11',
  'I confirm that I am authorised to act for this restaurant. On behalf of the restaurant I grant the platform a non-exclusive, royalty-free licence to store, review and display the menu facts, nutrition figures, ingredient, allergen and cross-contact statements and dietary statements in this submission, restated where needed, inside its app, and to keep them in its records of what was submitted. The restaurant may withdraw this licence for future use at any time. Nothing is published until the platform reviews it.');

create table partner.claims (
  id            uuid primary key default gen_random_uuid(),
  candidate_id  uuid not null references catalog_import.place_candidates (id),
  claimant      uuid not null references auth.users (id) on delete cascade,
  role_title    text not null check (length(role_title) between 2 and 100),
  contact_email text not null check (contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(contact_email) <= 254),
  created_at    timestamptz not null default now(),
  unique (candidate_id, claimant)
);

create table partner.ownership_checks (
  id          bigint generated always as identity primary key,
  claim_id    uuid not null references partner.claims (id) on delete cascade,
  method      text not null check (method in ('email_at_restaurant_domain', 'postal_code', 'phone_public_number', 'in_person')),
  outcome     text not null check (outcome in ('passed', 'failed', 'revoked')),
  evidence    text not null check (length(evidence) between 5 and 1000),
  checked_by  uuid not null,
  checked_at  timestamptz not null default now()
);

create table partner.submissions (
  id                  uuid primary key default gen_random_uuid(),
  claim_id            uuid not null references partner.claims (id) on delete cascade,
  licence_version     text not null references partner.licence_versions (version),
  licence_accepted_at timestamptz not null,
  file_name           text check (length(file_name) <= 200),
  file_sha256         text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  document_date       date,
  submitted_by        uuid not null,
  submitted_at        timestamptz not null default now(),
  unique (claim_id, file_sha256)
);

create table partner.items (
  id             uuid primary key default gen_random_uuid(),
  submission_id  uuid not null references partner.submissions (id) on delete cascade,
  name           text not null check (length(name) between 1 and 300),
  description    text check (length(description) <= 2000),
  section        text check (length(section) <= 200),
  price_usd      numeric(8, 2) check (price_usd is null or price_usd >= 0),
  serving        text check (length(serving) <= 200),
  serving_grams  numeric check (serving_grams is null or serving_grams > 0),
  ingredients    text check (length(ingredients) <= 4000),
  allergens      text check (length(allergens) <= 1000),
  cross_contact  text check (length(cross_contact) <= 1000),
  -- The restaurant's own dietary statements, in its own words: [{"claim": "vegan", "words": "..."}].
  dietary        jsonb not null default '[]' check (jsonb_typeof(dietary) = 'array'),
  -- {"protein_g": {"amount": 21, "unit": "g", "per": "serving"}}; unknown nutrients are absent, never 0.
  nutrition      jsonb not null default '{}' check (jsonb_typeof(nutrition) = 'object'),
  flags          text[] not null default '{}',
  position       int not null check (position >= 0)
);
create index partner_items_submission on partner.items (submission_id, position);

create table partner.item_reviews (
  id          bigint generated always as identity primary key,
  item_id     uuid not null references partner.items (id) on delete cascade,
  decision    text not null check (decision in ('verified', 'rejected')),
  note        text check (length(note) <= 500),
  reviewer    uuid not null,
  reviewed_at timestamptz not null default now(),
  unique (item_id)
);

create table partner.withdrawals (
  id            bigint generated always as identity primary key,
  claim_id      uuid not null references partner.claims (id) on delete cascade,
  withdrawn_by  uuid not null,
  reason        text check (length(reason) <= 500),
  withdrawn_at  timestamptz not null default now()
);

-- History is permanent with one exception: when the representative deletes their account, the
-- account deletion cascades through everything their claim holds (docs/06, "Versioning, merge and
-- deletion behavior"). A row may go only once the row it belongs to is already gone.
create function partner.guard_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
declare v_old jsonb; v_owner_gone boolean := false;
begin
  if tg_op = 'DELETE' then
    v_old := to_jsonb(old);
    v_owner_gone := case tg_table_name
      when 'claims' then not exists (select 1 from auth.users u where u.id = (v_old ->> 'claimant')::uuid)
      when 'ownership_checks' then not exists (select 1 from partner.claims c where c.id = (v_old ->> 'claim_id')::uuid)
      when 'submissions' then not exists (select 1 from partner.claims c where c.id = (v_old ->> 'claim_id')::uuid)
      when 'withdrawals' then not exists (select 1 from partner.claims c where c.id = (v_old ->> 'claim_id')::uuid)
      when 'items' then not exists (select 1 from partner.submissions s where s.id = (v_old ->> 'submission_id')::uuid)
      when 'item_reviews' then not exists (select 1 from partner.items i where i.id = (v_old ->> 'item_id')::uuid)
      else false end;
    if v_owner_gone then return old; end if;
  end if;
  raise exception 'Partner submission history is permanent' using errcode = 'P0001';
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['licence_versions', 'claims', 'ownership_checks', 'submissions', 'items', 'item_reviews', 'withdrawals'] loop
    execute format('alter table partner.%I enable row level security', t);
    execute format('alter table partner.%I force row level security', t);
    execute format('revoke all on partner.%I from public, anon, authenticated', t);
    execute format('create policy %I on partner.%I for all to postgres using (true) with check (true)', t || '_owner', t);
    execute format('create trigger %I before update or delete on partner.%I for each row execute function partner.guard_append_only()', t || '_append_only', t);
  end loop;
end $$;

/** pending | verified | failed | revoked | withdrawn: from the latest ownership check and any withdrawal. */
create function partner.claim_state(p_claim uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select case when exists (select 1 from partner.withdrawals w where w.claim_id = p_claim) then 'withdrawn'
              when c.outcome is null then 'pending'
              when c.outcome = 'passed' then 'verified'
              else c.outcome end
    from (select 1) one
    left join lateral (select o.outcome from partner.ownership_checks o where o.claim_id = p_claim order by o.checked_at desc, o.id desc limit 1) c on true;
$$;

create function partner.create_claim(p_actor uuid, p_candidate uuid, p_role_title text, p_email text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v uuid;
begin
  if p_actor is null or not exists (select 1 from auth.users where id = p_actor) then raise exception 'PARTNER_SIGN_IN_REQUIRED' using errcode = 'PT401'; end if;
  if not exists (select 1 from catalog_import.place_candidates where id = p_candidate and quality <> 'rejected') then
    raise exception 'PARTNER_PLACE_NOT_FOUND' using errcode = 'PT404';
  end if;
  insert into partner.claims (candidate_id, claimant, role_title, contact_email) values (p_candidate, p_actor, p_role_title, lower(p_email)) returning id into v;
  return v;
end;
$$;

-- Only a moderator records a check, never on their own claim.
create function partner.record_ownership_check(p_actor uuid, p_claim uuid, p_method text, p_outcome text, p_evidence text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare v partner.claims;
begin
  if not partner.has_role(p_actor, 'publisher') then raise exception 'PARTNER_MODERATOR_REQUIRED' using errcode = 'PT403'; end if;
  select * into v from partner.claims where id = p_claim;
  if v.id is null then raise exception 'PARTNER_NOT_FOUND' using errcode = 'PT404'; end if;
  if v.claimant = p_actor then raise exception 'PARTNER_SAME_PERSON' using errcode = 'PT403'; end if;
  insert into partner.ownership_checks (claim_id, method, outcome, evidence, checked_by) values (p_claim, p_method, p_outcome, p_evidence, p_actor);
  return partner.claim_state(p_claim);
end;
$$;

-- Automatic checks: flags only, never corrections.
create function partner.item_flags(p jsonb)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array_remove(array[
    case when exists (select 1 from jsonb_array_elements(coalesce(p -> 'dietary', '[]')) d where d ->> 'claim' = 'vegan')
          and coalesce(p ->> 'ingredients', '') || ' ' || coalesce(p ->> 'description', '') ~* '\m(milk|cheese|butter|cream|yogurt|yoghurt|egg|eggs|honey|ghee|whey|gelatin|fish sauce|anchov|paneer|raita|mayo|mayonnaise|chicken|beef|pork|bacon|shrimp|tuna)\M'
         then 'vegan_statement_with_animal_ingredient_word' end,
    case when exists (select 1 from jsonb_array_elements(coalesce(p -> 'dietary', '[]')) d where d ->> 'claim' = 'vegetarian')
          and coalesce(p ->> 'ingredients', '') || ' ' || coalesce(p ->> 'description', '') ~* '\m(chicken|beef|pork|bacon|ham|turkey|fish|shrimp|tuna|salmon|anchov|gelatin|lard|fish sauce)\M'
         then 'vegetarian_statement_with_meat_or_fish_word' end,
    case when (p -> 'nutrition' -> 'protein_g' ->> 'amount') is not null and (p -> 'nutrition' -> 'energy_kcal' ->> 'amount') is not null
          and (p -> 'nutrition' -> 'protein_g' ->> 'amount')::numeric * 4 > (p -> 'nutrition' -> 'energy_kcal' ->> 'amount')::numeric
         then 'protein_energy_exceeds_calories' end,
    case when p -> 'nutrition' <> '{}'::jsonb and coalesce(p ->> 'serving', p ->> 'serving_grams') is null
          and exists (select 1 from jsonb_each(p -> 'nutrition') n where coalesce(n.value ->> 'per', 'serving') = 'serving')
         then 'nutrition_per_serving_without_serving_size' end,
    case when (p ->> 'allergens') is null then 'no_allergen_statement' end
  ], null);
$$;

create function partner.nutrition_valid(n jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(n) = 'object' and not exists (
    select 1 from jsonb_each(n) e
     where e.key not in ('energy_kcal', 'protein_g', 'carb_g', 'fat_g', 'fiber_g', 'sodium_mg', 'sugar_g')
        or jsonb_typeof(e.value -> 'amount') <> 'number' or (e.value ->> 'amount')::numeric < 0
        or e.value ->> 'unit' is distinct from case when e.key = 'energy_kcal' then 'kcal' when e.key = 'sodium_mg' then 'mg' else 'g' end
        or coalesce(e.value ->> 'per', 'serving') not in ('serving', '100g'));
$$;

-- Only the claimant of a verified claim submits, under the current licence text they accepted.
create function partner.submit_menu(p_actor uuid, p_claim uuid, p_licence text, p_file_name text, p_file_sha256 text, p_document_date date, p_items jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v partner.claims; v_sub uuid; it jsonb; i int := 0; d jsonb;
begin
  select * into v from partner.claims where id = p_claim;
  if v.id is null then raise exception 'PARTNER_NOT_FOUND' using errcode = 'PT404'; end if;
  if v.claimant <> p_actor then raise exception 'PARTNER_NOT_CLAIMANT' using errcode = 'PT403'; end if;
  if partner.claim_state(p_claim) <> 'verified' then raise exception 'PARTNER_CLAIM_NOT_VERIFIED' using errcode = 'PT403'; end if;
  if not exists (select 1 from partner.licence_versions where version = p_licence) then raise exception 'PARTNER_LICENCE_REQUIRED' using errcode = 'PT422'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 500 then
    raise exception 'PARTNER_ITEMS_REQUIRED' using errcode = 'PT422';
  end if;
  insert into partner.submissions (claim_id, licence_version, licence_accepted_at, file_name, file_sha256, document_date, submitted_by)
  values (p_claim, p_licence, now(), p_file_name, p_file_sha256, p_document_date, p_actor) returning id into v_sub;
  for it in select * from jsonb_array_elements(p_items) loop
    if coalesce(trim(it ->> 'name'), '') = '' then raise exception 'PARTNER_ITEM_NAME_REQUIRED' using errcode = 'PT422', detail = i::text; end if;
    if not partner.nutrition_valid(coalesce(it -> 'nutrition', '{}')) then raise exception 'PARTNER_BAD_NUTRITION' using errcode = 'PT422', detail = i::text; end if;
    for d in select * from jsonb_array_elements(coalesce(it -> 'dietary', '[]')) loop
      if d ->> 'claim' not in ('vegan', 'vegetarian') or coalesce(length(trim(d ->> 'words')), 0) not between 1 and 300 then
        raise exception 'PARTNER_BAD_DIETARY' using errcode = 'PT422', detail = i::text;
      end if;
    end loop;
    insert into partner.items (submission_id, name, description, section, price_usd, serving, serving_grams, ingredients, allergens, cross_contact, dietary, nutrition, flags, position)
    values (v_sub, trim(it ->> 'name'), nullif(trim(it ->> 'description'), ''), nullif(trim(it ->> 'section'), ''), (it ->> 'price_usd')::numeric,
            nullif(trim(it ->> 'serving'), ''), (it ->> 'serving_grams')::numeric, nullif(trim(it ->> 'ingredients'), ''), nullif(trim(it ->> 'allergens'), ''),
            nullif(trim(it ->> 'cross_contact'), ''), coalesce(it -> 'dietary', '[]'), coalesce(it -> 'nutrition', '{}'), partner.item_flags(it), i);
    i := i + 1;
  end loop;
  return v_sub;
end;
$$;

-- The private moderation queue: items not yet reviewed, from claims still verified, with provenance.
create function partner.moderation_queue(p_actor uuid)
returns table (item_id uuid, place_name text, place_street text, claimant_email text, ownership jsonb, licence_version text,
               file_name text, file_sha256 text, document_date date, submitted_at timestamptz, name text, section text,
               price_usd numeric, serving text, serving_grams numeric, ingredients text, allergens text, cross_contact text,
               dietary jsonb, nutrition jsonb, flags text[])
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not partner.has_role(p_actor, 'publisher') then raise exception 'PARTNER_MODERATOR_REQUIRED' using errcode = 'PT403'; end if;
  return query
  select i.id, pc.name, pc.street, c.contact_email,
         (select jsonb_build_object('method', o.method, 'evidence', o.evidence, 'checkedAt', o.checked_at) from partner.ownership_checks o
           where o.claim_id = c.id order by o.checked_at desc, o.id desc limit 1),
         s.licence_version, s.file_name, s.file_sha256, s.document_date, s.submitted_at, i.name, i.section, i.price_usd, i.serving, i.serving_grams,
         i.ingredients, i.allergens, i.cross_contact, i.dietary, i.nutrition, i.flags
    from partner.items i join partner.submissions s on s.id = i.submission_id join partner.claims c on c.id = s.claim_id
    join catalog_import.place_candidates pc on pc.id = c.candidate_id
   where not exists (select 1 from partner.item_reviews r where r.item_id = i.id) and partner.claim_state(c.id) = 'verified'
   order by s.submitted_at, i.position;
end;
$$;

-- A moderator verifies or rejects one item. Nobody who claims that place may review it.
create function partner.review_item(p_actor uuid, p_item uuid, p_decision text, p_note text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare v_place uuid; v_claim uuid;
begin
  if not partner.has_role(p_actor, 'publisher') then raise exception 'PARTNER_MODERATOR_REQUIRED' using errcode = 'PT403'; end if;
  select c.candidate_id, c.id into v_place, v_claim from partner.items i join partner.submissions s on s.id = i.submission_id join partner.claims c on c.id = s.claim_id where i.id = p_item;
  if v_place is null then raise exception 'PARTNER_NOT_FOUND' using errcode = 'PT404'; end if;
  if exists (select 1 from partner.claims c where c.candidate_id = v_place and c.claimant = p_actor) then raise exception 'PARTNER_SAME_PERSON' using errcode = 'PT403'; end if;
  if partner.claim_state(v_claim) <> 'verified' then raise exception 'PARTNER_CLAIM_NOT_VERIFIED' using errcode = 'PT409'; end if;
  if p_decision not in ('verified', 'rejected') then raise exception 'PARTNER_BAD_DECISION' using errcode = 'PT422'; end if;
  insert into partner.item_reviews (item_id, decision, note, reviewer) values (p_item, p_decision, p_note, p_actor);
  return p_decision;
exception when unique_violation then
  raise exception 'PARTNER_ALREADY_REVIEWED' using errcode = 'PT409';
end;
$$;

-- The claimant (or a moderator) withdraws the licence for future use; nothing from the claim counts afterwards.
create function partner.withdraw(p_actor uuid, p_claim uuid, p_reason text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare v partner.claims;
begin
  select * into v from partner.claims where id = p_claim;
  if v.id is null then raise exception 'PARTNER_NOT_FOUND' using errcode = 'PT404'; end if;
  if v.claimant <> p_actor and not partner.has_role(p_actor, 'publisher') then raise exception 'PARTNER_NOT_CLAIMANT' using errcode = 'PT403'; end if;
  insert into partner.withdrawals (claim_id, withdrawn_by, reason) values (p_claim, p_actor, p_reason);
  return 'withdrawn';
end;
$$;

do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'partner' loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
end $$;
