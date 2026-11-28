-- NIE V1 slices N-2 and N-3: dish models and calculation records (docs/24 3.3-3.4, docs/27 B;
-- approvals A-NIE-V1 and A-NIE-V1-B). Internal `app` schema: closed to visitors and members.
--
--   1. app.nie_settings: the thresholds, as settings (NIE-A 25 % disagreement, NIE-B 2x range width,
--      confidence bands). Changing a setting changes future calculations only; each record keeps
--      the settings it used.
--   2. app.nie_dish_models + app.nie_model_lines: the ingredients of one dish serving, each linked to
--      a SEALED USDA food, with how the amount is known (stated by the restaurant, measured by us, or
--      a typical editorial assumption with a low and high amount), whether it was weighed raw or
--      cooked, the preparation, a yield factor with its source when raw and cooked differ, and
--      named substitutions. The model says whether its quantities are restaurant-verified or an
--      editorial typical recipe (NIE-E). Entered by a curator, published by a DIFFERENT publisher,
--      then frozen.
--   3. app.nie_calculate(model): one permanent calculation record with the state (calculated,
--      estimated or unknown), central value, scenario bounds (not statistical confidence
--      intervals), confidence, reason, engine version and a fingerprint of every input. The same
--      inputs always give the same record.
--   4. app.nie_compare_published: a restaurant figure always wins; a gap over the threshold is
--      flagged for a person, never averaged.
--   5. app.nie_apply_to_revision: writes the result into the ONE canonical nutrition record
--      (public.nutrient_values) of an unpublished dish revision, so dish pages, Protein Explorer
--      and diary snapshots all read the same figure. Published revisions stay frozen (existing rule).
--
-- Rules from the owner (22:26 and 23:21 UTC): estimates are opt-in; never shown as exact or
-- verified; typical recipes never yield a "calculated" (verified-quantity) figure; unknown when the
-- evidence is thin.

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
create table app.nie_settings (
  key        text primary key check (key in ('disagreement_threshold', 'max_range_ratio', 'confidence_high_ratio', 'confidence_medium_ratio')),
  value      numeric not null check (value > 0),
  note       text not null,
  changed_at timestamptz not null default now()
);
alter table app.nie_settings enable row level security;
insert into app.nie_settings (key, value, note) values
  ('disagreement_threshold', 0.25, 'NIE-A: a calculated figure more than 25 % away from the restaurant''s published figure goes to a person'),
  ('max_range_ratio', 2.0, 'NIE-B: an estimate whose high end is more than 2 times its low end is too wide: unknown'),
  ('confidence_high_ratio', 1.25, 'Estimate confidence "high" when high/low is at most this'),
  ('confidence_medium_ratio', 1.5, 'Estimate confidence "medium" when high/low is at most this; otherwise "low"');
-- The two owner-approved thresholds may be tuned but stay in a sane band.
alter table app.nie_settings add constraint nie_settings_band check (
  (key <> 'disagreement_threshold' or value between 0.05 and 1) and
  (key <> 'max_range_ratio' or value between 1.05 and 10) and
  (key not like 'confidence_%' or value between 1 and 10));

create function app.nie_setting(p_key text)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$ select value from app.nie_settings where key = p_key; $$;

-- ---------------------------------------------------------------------------
-- Dish models
-- ---------------------------------------------------------------------------
create table app.nie_dish_models (
  id                    uuid primary key default gen_random_uuid(),
  label                 text not null check (length(label) between 1 and 200),
  -- NIE-E: restaurant_verified = quantities supplied by the restaurant or measured by us;
  -- editorial_typical = our documented typical recipe. Only the first can ever be "calculated".
  quantity_basis        text not null check (quantity_basis in ('restaurant_verified', 'editorial_typical')),
  -- The serving the lines describe. Typical servings carry a low and high factor (e.g. 0.9 and 1.2).
  serving_basis         text not null check (serving_basis in ('stated', 'measured', 'typical')),
  serving_factor_low    numeric not null default 1 check (serving_factor_low > 0),
  serving_factor_high   numeric not null default 1 check (serving_factor_high > 0),
  assumptions           text check (assumptions is null or length(assumptions) <= 2000),
  status                text not null default 'draft' check (status in ('draft', 'published')),
  author_id             uuid not null,
  created_at            timestamptz not null default now(),
  reviewer_id           uuid,
  published_at          timestamptz,
  check (serving_factor_low <= 1 and serving_factor_high >= 1),
  check (serving_basis = 'typical' or (serving_factor_low = 1 and serving_factor_high = 1)),
  check (reviewer_id is null or reviewer_id <> author_id),
  check ((status = 'published') = (reviewer_id is not null and published_at is not null))
);

create table app.nie_model_lines (
  model_id        uuid not null references app.nie_dish_models (id),
  line_no         smallint not null check (line_no between 1 and 60),
  label           text not null check (length(label) between 1 and 200),
  usda_release_id uuid not null references app.usda_releases (id),
  fdc_id          integer not null,
  usda_state      text not null check (usda_state in ('raw', 'cooked', 'as_sold')),
  weighed_as      text not null check (weighed_as in ('raw', 'cooked', 'as_sold')),
  preparation     text check (preparation is null or length(preparation) <= 200),
  amount_basis    text not null check (amount_basis in ('stated', 'measured', 'typical')),
  grams           numeric not null check (grams > 0),
  grams_low       numeric not null check (grams_low > 0),
  grams_high      numeric not null check (grams_high > 0),
  -- Cooked weight divided by raw weight, e.g. 2.5 for lentils that weigh 2.5 g cooked per 1 g dry.
  yield_factor    numeric check (yield_factor is null or yield_factor > 0),
  yield_source    text check (yield_source is null or length(yield_source) between 3 and 500),
  -- [{label, usdaReleaseId, fdcId, usdaState, yieldFactor?, yieldSource?}]: each widens the range.
  substitutes     jsonb not null default '[]'::jsonb check (jsonb_typeof(substitutes) = 'array'),
  primary key (model_id, line_no),
  foreign key (usda_release_id, fdc_id) references app.usda_foods (release_id, fdc_id),
  check (grams_low <= grams and grams <= grams_high),
  check (amount_basis = 'typical' or (grams_low = grams and grams_high = grams)),
  check ((yield_factor is null) = (yield_source is null)),
  check (weighed_as = usda_state or (weighed_as in ('raw', 'cooked') and usda_state in ('raw', 'cooked'))),
  -- NIE-E: a restaurant-verified model cannot quietly hold a typical amount... (enforced at publish)
  check (amount_basis <> 'typical' or grams_high > 0)
);

do $$
declare t text;
begin
  foreach t in array array['nie_dish_models', 'nie_model_lines'] loop
    execute format('alter table app.%I enable row level security', t);
  end loop;
end $$;

-- Lines change only while their model is a draft; a published model never changes or disappears.
create function app.nie_guard_model()
returns trigger
language plpgsql
set search_path = ''
as $$
declare v_status text;
begin
  if tg_table_name = 'nie_dish_models' then
    if tg_op = 'DELETE' then
      raise exception 'A dish model is permanent once created; leave drafts unpublished instead' using errcode = 'P0001';
    end if;
    if old.status = 'published' then
      raise exception 'A published dish model is frozen' using errcode = 'P0001';
    end if;
    return new;
  end if;
  select status into v_status from app.nie_dish_models
   where id = case when tg_op = 'DELETE' then old.model_id else new.model_id end;
  if v_status = 'published' then
    raise exception 'A published dish model is frozen' using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger nie_models_guard before update or delete on app.nie_dish_models for each row execute function app.nie_guard_model();
create trigger nie_lines_guard before insert or update or delete on app.nie_model_lines for each row execute function app.nie_guard_model();

create function app.nie_require_role(p_actor uuid, p_role text)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_actor is null or not exists (select 1 from public.role_assignments where user_id = p_actor and role = p_role) then
    raise exception 'NIE_ROLE_REQUIRED' using errcode = 'PT403', detail = p_role;
  end if;
end;
$$;

-- p: {label, quantityBasis, servingBasis, servingFactorLow?, servingFactorHigh?, assumptions?,
--     lines: [{label, usdaReleaseId, fdcId, usdaState, weighedAs, preparation?, amountBasis, grams,
--              gramsLow?, gramsHigh?, yieldFactor?, yieldSource?, substitutes?}]}
create function app.nie_create_model(p_actor uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  l jsonb;
  n smallint := 0;
begin
  perform app.nie_require_role(p_actor, 'curator');
  insert into app.nie_dish_models (label, quantity_basis, serving_basis, serving_factor_low, serving_factor_high, assumptions, author_id)
  values (p ->> 'label', p ->> 'quantityBasis', p ->> 'servingBasis',
          coalesce((p ->> 'servingFactorLow')::numeric, 1), coalesce((p ->> 'servingFactorHigh')::numeric, 1), p ->> 'assumptions', p_actor)
  returning id into v_id;
  for l in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
    n := n + 1;
    insert into app.nie_model_lines (model_id, line_no, label, usda_release_id, fdc_id, usda_state, weighed_as, preparation,
                                     amount_basis, grams, grams_low, grams_high, yield_factor, yield_source, substitutes)
    values (v_id, n, l ->> 'label', (l ->> 'usdaReleaseId')::uuid, (l ->> 'fdcId')::integer, l ->> 'usdaState', l ->> 'weighedAs',
            l ->> 'preparation', l ->> 'amountBasis', (l ->> 'grams')::numeric,
            coalesce((l ->> 'gramsLow')::numeric, (l ->> 'grams')::numeric), coalesce((l ->> 'gramsHigh')::numeric, (l ->> 'grams')::numeric),
            (l ->> 'yieldFactor')::numeric, l ->> 'yieldSource', coalesce(l -> 'substitutes', '[]'::jsonb));
  end loop;
  if n = 0 then raise exception 'NIE_MODEL_EMPTY' using errcode = 'PT422'; end if;
  return v_id;
end;
$$;

create function app.nie_publish_model(p_actor uuid, p_model uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare m app.nie_dish_models;
begin
  perform app.nie_require_role(p_actor, 'publisher');
  select * into m from app.nie_dish_models where id = p_model for update;
  if m.id is null then raise exception 'NIE_NOT_FOUND' using errcode = 'PT404'; end if;
  if m.author_id = p_actor then raise exception 'NIE_SAME_PERSON' using errcode = 'PT403'; end if;
  if m.status = 'published' then raise exception 'NIE_ALREADY_PUBLISHED' using errcode = 'PT409'; end if;
  -- NIE-E: a model described as restaurant-verified must not contain typical amounts or a typical serving.
  if m.quantity_basis = 'restaurant_verified' and (m.serving_basis = 'typical'
       or exists (select 1 from app.nie_model_lines where model_id = p_model and amount_basis = 'typical')) then
    raise exception 'NIE_VERIFIED_MODEL_HAS_TYPICAL_AMOUNTS' using errcode = 'PT422';
  end if;
  update app.nie_dish_models set status = 'published', reviewer_id = p_actor, published_at = now() where id = p_model;
end;
$$;

-- ---------------------------------------------------------------------------
-- Calculation records
-- ---------------------------------------------------------------------------
create table app.nie_calculations (
  id             uuid primary key default gen_random_uuid(),
  model_id       uuid not null references app.nie_dish_models (id),
  nutrient_code  text not null check (nutrient_code = 'protein_g'),
  engine_version text not null,
  inputs         jsonb not null,
  inputs_sha256  text not null check (inputs_sha256 ~ '^[0-9a-f]{64}$'),
  state          text not null check (state in ('calculated', 'estimated', 'unknown')),
  central        numeric check (central is null or central >= 0),
  low            numeric check (low is null or low >= 0),
  high           numeric check (high is null or high >= 0),
  confidence     text check (confidence is null or confidence in ('high', 'medium', 'low')),
  reason         text check (reason is null or reason in ('missing_reference_value', 'missing_yield_factor', 'range_too_wide', 'model_not_published')),
  lines          jsonb not null,
  computed_at    timestamptz not null default now(),
  unique (model_id, nutrient_code, inputs_sha256),
  check ((state = 'unknown') = (central is null)),
  check ((state = 'unknown') = (reason is not null)),
  check (state <> 'calculated' or (low is null and high is null and confidence is null)),
  check (state <> 'estimated' or (low is not null and high is not null and low <= central and central <= high and confidence is not null)),
  check (state <> 'unknown' or (low is null and high is null and confidence is null))
);
alter table app.nie_calculations enable row level security;
create function app.nie_calc_permanent()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Calculation records are permanent' using errcode = 'P0001';
end;
$$;
create trigger nie_calculations_permanent before update or delete on app.nie_calculations for each row execute function app.nie_calc_permanent();
create trigger nie_calculations_no_truncate before truncate on app.nie_calculations for each statement execute function app.nie_calc_permanent();

-- Protein in grams for one ingredient at a weighed amount, converting raw<->cooked with the yield
-- factor when the USDA food was measured in the other state. Null when anything is unknown.
create function app.nie_line_amount(p_release uuid, p_fdc integer, p_usda_state text, p_weighed_as text,
                                    p_yield numeric, p_grams numeric)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_weighed_as = p_usda_state then app.usda_amount(p_release, p_fdc, 'protein_g', p_grams)
    when p_yield is null then null
    -- weighed cooked, USDA value is for raw: the raw weight is cooked weight / yield.
    when p_weighed_as = 'cooked' and p_usda_state = 'raw' then app.usda_amount(p_release, p_fdc, 'protein_g', p_grams / p_yield)
    -- weighed raw, USDA value is for cooked: the cooked weight is raw weight x yield.
    when p_weighed_as = 'raw' and p_usda_state = 'cooked' then app.usda_amount(p_release, p_fdc, 'protein_g', p_grams * p_yield)
  end;
$$;

create function app.nie_calculate(p_model uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_engine constant text := 'nie-v1-calc-1';
  m app.nie_dish_models;
  l app.nie_model_lines;
  s jsonb;
  v_inputs jsonb;
  v_sha text;
  v_id uuid;
  v_lines jsonb := '[]'::jsonb;
  v_central numeric := 0;
  v_low numeric := 0;
  v_high numeric := 0;
  v_reason text;
  v_c numeric; v_lo numeric; v_hi numeric; v_alt_lo numeric; v_alt_hi numeric;
  v_any_typical boolean := false;
  v_state text;
  v_conf text;
  v_ratio numeric;
begin
  select * into m from app.nie_dish_models where id = p_model;
  if m.id is null then raise exception 'NIE_NOT_FOUND' using errcode = 'PT404'; end if;
  if m.status <> 'published' then raise exception 'NIE_MODEL_NOT_PUBLISHED' using errcode = 'PT409'; end if;

  -- Every input that can change the answer, in one canonical JSON value.
  v_inputs := jsonb_build_object(
    'engine', c_engine,
    'model', jsonb_build_object('id', m.id, 'quantityBasis', m.quantity_basis, 'servingBasis', m.serving_basis,
                                'servingFactorLow', m.serving_factor_low, 'servingFactorHigh', m.serving_factor_high),
    'lines', (select jsonb_agg(to_jsonb(x) - 'model_id' order by x.line_no) from app.nie_model_lines x where x.model_id = m.id),
    'releases', (select jsonb_agg(distinct jsonb_build_object('id', r.id, 'contentSha256', r.content_sha256))
                   from app.nie_model_lines x join app.usda_releases r on r.id = x.usda_release_id where x.model_id = m.id),
    'settings', (select jsonb_object_agg(key, value) from app.nie_settings));
  v_sha := encode(extensions.digest(v_inputs::text, 'sha256'), 'hex');
  select id into v_id from app.nie_calculations where model_id = m.id and nutrient_code = 'protein_g' and inputs_sha256 = v_sha;
  if v_id is not null then return v_id; end if;

  for l in select * from app.nie_model_lines where model_id = m.id order by line_no loop
    v_any_typical := v_any_typical or l.amount_basis = 'typical';
    v_c  := app.nie_line_amount(l.usda_release_id, l.fdc_id, l.usda_state, l.weighed_as, l.yield_factor, l.grams);
    v_lo := app.nie_line_amount(l.usda_release_id, l.fdc_id, l.usda_state, l.weighed_as, l.yield_factor, l.grams_low);
    v_hi := app.nie_line_amount(l.usda_release_id, l.fdc_id, l.usda_state, l.weighed_as, l.yield_factor, l.grams_high);
    if v_c is null then
      v_reason := case when l.weighed_as <> l.usda_state and l.yield_factor is null then 'missing_yield_factor' else 'missing_reference_value' end;
    end if;
    -- Each named substitution can replace this ingredient: the range covers all of them.
    for s in select * from jsonb_array_elements(l.substitutes) loop
      v_alt_lo := app.nie_line_amount((s ->> 'usdaReleaseId')::uuid, (s ->> 'fdcId')::integer, s ->> 'usdaState', l.weighed_as, (s ->> 'yieldFactor')::numeric, l.grams_low);
      v_alt_hi := app.nie_line_amount((s ->> 'usdaReleaseId')::uuid, (s ->> 'fdcId')::integer, s ->> 'usdaState', l.weighed_as, (s ->> 'yieldFactor')::numeric, l.grams_high);
      if v_alt_lo is null or v_alt_hi is null then
        v_reason := coalesce(v_reason, case when l.weighed_as <> (s ->> 'usdaState') and s ->> 'yieldFactor' is null then 'missing_yield_factor' else 'missing_reference_value' end);
      else
        v_lo := least(v_lo, v_alt_lo);
        v_hi := greatest(v_hi, v_alt_hi);
        v_any_typical := true; -- a possible substitution is an assumption, never a verified quantity
      end if;
    end loop;
    v_lines := v_lines || jsonb_build_object('lineNo', l.line_no, 'label', l.label, 'fdcId', l.fdc_id, 'amountBasis', l.amount_basis,
                                             'grams', l.grams, 'proteinG', v_c, 'lowG', v_lo, 'highG', v_hi);
    v_central := v_central + coalesce(v_c, 0);
    v_low := v_low + coalesce(v_lo, 0);
    v_high := v_high + coalesce(v_hi, 0);
  end loop;

  v_any_typical := v_any_typical or m.serving_basis = 'typical';
  v_low := v_low * m.serving_factor_low;
  v_high := v_high * m.serving_factor_high;

  if v_reason is not null then
    v_state := 'unknown';
  elsif m.quantity_basis = 'restaurant_verified' and not v_any_typical then
    v_state := 'calculated';
  else
    -- NIE-E: anything resting on a typical amount, typical serving or substitution is an estimate.
    v_ratio := case when v_low > 0 then v_high / v_low end;
    if v_ratio is null and v_high > 0 or v_ratio > app.nie_setting('max_range_ratio') then
      v_state := 'unknown'; v_reason := 'range_too_wide';
    else
      v_state := 'estimated';
      v_conf := case when coalesce(v_ratio, 1) <= app.nie_setting('confidence_high_ratio') then 'high'
                     when v_ratio <= app.nie_setting('confidence_medium_ratio') then 'medium' else 'low' end;
    end if;
  end if;

  insert into app.nie_calculations (model_id, nutrient_code, engine_version, inputs, inputs_sha256, state, central, low, high, confidence, reason, lines)
  values (m.id, 'protein_g', c_engine, v_inputs, v_sha, v_state,
          -- trim_scale: keep exact decimals without trailing zeros (13.53, not 13.5300000000000000).
          case when v_state <> 'unknown' then trim_scale(v_central) end,
          case when v_state = 'estimated' then trim_scale(v_low) end,
          case when v_state = 'estimated' then trim_scale(v_high) end,
          v_conf, v_reason, v_lines)
  returning id into v_id;
  return v_id;
end;
$$;

-- A restaurant's published figure always wins. Returns whether our figure is far enough away
-- (strictly more than the threshold, relative to the published figure) to need a person.
create function app.nie_compare_published(p_published numeric, p_calculation uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_published is null or c.central is null then jsonb_build_object('comparable', false)
    when p_published = 0 then jsonb_build_object('comparable', true, 'relativeGap', null, 'needsReview', c.central > 0, 'threshold', app.nie_setting('disagreement_threshold'))
    else jsonb_build_object('comparable', true,
                            'relativeGap', abs(c.central - p_published) / p_published,
                            'needsReview', abs(c.central - p_published) / p_published > app.nie_setting('disagreement_threshold'),
                            'threshold', app.nie_setting('disagreement_threshold'))
  end
  from app.nie_calculations c where c.id = p_calculation;
$$;

-- ---------------------------------------------------------------------------
-- One canonical nutrition record: write a calculation into public.nutrient_values
-- ---------------------------------------------------------------------------
alter table public.nutrient_values
  add column calculation_id uuid references app.nie_calculations (id),
  add column confidence text check (confidence is null or confidence in ('high', 'medium', 'low'));
alter table public.nutrient_values
  add constraint nutrient_values_confidence_estimates check (confidence is null or method = 'estimated'),
  add constraint nutrient_values_calculation_method check (calculation_id is null or method in ('calculated', 'estimated', 'unknown'));

create function app.nie_apply_to_revision(p_actor uuid, p_calculation uuid, p_revision uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c app.nie_calculations;
  m app.nie_dish_models;
  r public.food_revisions;
  v_source uuid;
  v_record uuid;
  v_serving_g numeric;
begin
  perform app.nie_require_role(p_actor, 'curator');
  select * into c from app.nie_calculations where id = p_calculation;
  if c.id is null then raise exception 'NIE_NOT_FOUND' using errcode = 'PT404'; end if;
  select * into m from app.nie_dish_models where id = c.model_id;
  select * into r from public.food_revisions where id = p_revision;
  if r.id is null then raise exception 'NIE_NOT_FOUND' using errcode = 'PT404'; end if;
  -- A model describes one serving: the revision must be per serving.
  if r.basis_kind <> 'serving' or r.basis_amount <> 1 then
    raise exception 'NIE_REVISION_NOT_PER_SERVING' using errcode = 'PT422';
  end if;
  -- A restaurant-published protein figure is never overwritten by our calculation.
  if exists (select 1 from public.nutrient_values where revision_id = p_revision and nutrient_code = 'protein_g' and method = 'published') then
    raise exception 'NIE_PUBLISHED_FIGURE_WINS' using errcode = 'PT409';
  end if;
  select id into v_source from public.sources where publisher = 'Nutrition engine calculation' and source_type = 'curator_assessment' and not is_demo limit 1;
  if v_source is null then
    insert into public.sources (publisher, source_type, access_scope, is_demo)
      values ('Nutrition engine calculation', 'curator_assessment', 'public', false) returning id into v_source;
  end if;
  insert into public.source_records (source_id, external_id, source_version, observed_at, content_hash, evidence_summary, rights_status)
    values (v_source, c.id::text, c.engine_version, c.computed_at, c.inputs_sha256,
            format('Dish model "%s" (%s); USDA FoodData Central reference data', m.label, m.quantity_basis), 'cleared')
    returning id into v_record;
  insert into public.nutrient_values (revision_id, nutrient_code, value, lower_value, upper_value, source_record_id, method, missing_reason, assumptions, calculation_id, confidence)
  values (p_revision, 'protein_g', c.central, c.low, c.high,
          case when c.state <> 'unknown' then v_record end,
          case c.state when 'unknown' then 'unknown' else c.state end,
          case c.state when 'unknown' then case c.reason when 'range_too_wide' then 'source_conflict' else 'incomplete_recipe' end end,
          case c.state when 'estimated' then 'Scenario bounds from a typical recipe, not a statistical confidence interval; not a restaurant figure' end,
          c.id, c.confidence)
  on conflict (revision_id, nutrient_code) do update
    set value = excluded.value, lower_value = excluded.lower_value, upper_value = excluded.upper_value,
        source_record_id = excluded.source_record_id, method = excluded.method, missing_reason = excluded.missing_reason,
        assumptions = excluded.assumptions, calculation_id = excluded.calculation_id, confidence = excluded.confidence;
end;
$$;

do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app' and p.proname like 'nie\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
end $$;
revoke all on app.nie_settings, app.nie_dish_models, app.nie_model_lines, app.nie_calculations from public, anon, authenticated;
