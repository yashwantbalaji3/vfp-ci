-- Data quality before the private beta (owner direction 18 Nov 2026 23:20 UTC).
--
-- 1. USDA demo excerpt and full file side by side. The browser tests and the demo dishes load a small
--    excerpt of SR Legacy 2018-04 (file name ending "_demo_excerpt.zip"). The full SR Legacy 2018-04
--    file was then refused as a "release conflict", because one release label could hold only one
--    file. Now a demo excerpt and the full file of the same release are separate releases; two
--    different full files under one label are still refused, and nothing already imported changes.
--    Applying this needs no reset and touches no imported rows.
-- 2. Automatic comparison of drafted facts with the saved copy of their source page. A machine check
--    records whether the drafted value was found on the saved page, with what was searched and the
--    page's fingerprint. It never confirms, verifies or publishes anything; the founder's screens show it
--    as an automatic check, never as the founder's own. A confirmation records whether the founder
--    compared the rows or accepted the automatic comparison.

-- 1. USDA releases.
create function app.usda_is_excerpt(p_file_name text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_file_name, '') like '%\_demo\_excerpt.zip';
$$;
revoke all on function app.usda_is_excerpt(text) from public, anon, authenticated;

alter table app.usda_releases drop constraint usda_releases_dataset_release_label_importer_version_key;
create unique index usda_releases_one_full_file on app.usda_releases (dataset, release_label, importer_version)
  where not app.usda_is_excerpt(file_name);
create unique index usda_releases_one_excerpt on app.usda_releases (dataset, release_label, importer_version)
  where app.usda_is_excerpt(file_name);

-- The same as in 20261115000800, except that the existing release is looked up among releases of the
-- same kind (excerpt or full file).
create or replace function app.usda_begin_release(p jsonb)
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
  -- A demo excerpt and the full file of the same release are kept apart (see the comment above).
  select * into r from app.usda_releases
   where dataset = p ->> 'dataset' and release_label = p ->> 'releaseLabel' and importer_version = p ->> 'importerVersion'
     and app.usda_is_excerpt(file_name) = app.usda_is_excerpt(p ->> 'fileName');
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
revoke all on function app.usda_begin_release(jsonb) from public, anon, authenticated;

-- 2. Automatic source comparison.
create table staging.fact_machine_checks (
  id             bigint generated always as identity primary key,
  fact_id        uuid not null references staging.facts (id),
  check_kind     text not null check (check_kind in ('text_on_saved_page')),
  result         text not null check (result in ('found', 'not_found', 'not_checked')),
  detail         text not null check (length(detail) between 1 and 300),
  page_sha256    text check (page_sha256 is null or page_sha256 ~ '^[0-9a-f]{64}$'),
  page_saved_at  timestamptz,
  checker        text not null default 'automatic' check (checker = 'automatic'),
  created_by     uuid not null,
  created_at     timestamptz not null default clock_timestamp(),
  check (result = 'not_checked' or page_sha256 is not null)
);
create index fact_machine_checks_fact on staging.fact_machine_checks (fact_id, created_at desc, id desc);
alter table staging.fact_machine_checks enable row level security;
alter table staging.fact_machine_checks force row level security;
revoke all on staging.fact_machine_checks from public, anon, authenticated;
create trigger fact_machine_checks_append_only before update or delete on staging.fact_machine_checks
  for each row execute function staging.guard_confirmations_append_only();

create function staging.current_machine_check(p_fact uuid)
returns staging.fact_machine_checks
language sql
stable
set search_path = ''
as $$
  select m.* from staging.fact_machine_checks m where m.fact_id = p_fact order by m.created_at desc, m.id desc limit 1;
$$;
revoke all on function staging.current_machine_check(uuid) from public, anon, authenticated;

-- Recorded by the research account that runs the comparison (curator role), never by the founder's
-- screens. A check on a fact that is no longer waiting is refused, so it cannot rewrite history.
create function staging.record_machine_check(p_actor uuid, p_fact uuid, p_result text, p_detail text,
                                             p_page_sha256 text, p_page_saved_at timestamptz)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_id bigint;
begin
  perform staging.require_role(p_actor, 'curator');
  select status into v_status from staging.facts where id = p_fact;
  if v_status is null then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
  if v_status <> 'submitted' then raise exception 'STAGING_FACT_DECIDED' using errcode = 'PT409'; end if;
  insert into staging.fact_machine_checks (fact_id, check_kind, result, detail, page_sha256, page_saved_at, created_by)
  values (p_fact, 'text_on_saved_page', p_result, left(p_detail, 300), p_page_sha256, p_page_saved_at, p_actor)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function staging.record_machine_check(uuid, uuid, text, text, text, timestamptz) from public, anon, authenticated;

-- The founder's screens show the automatic check and what each confirmation rested on.
create or replace function public.menu_review_fact_json(f staging.facts, p_me uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with s as (
    select staging.source_access_state((select p.url from staging.source_pages p where p.id = f.source_page_id)) as access,
           exists (select 1 from staging.fact_confirmations c where c.fact_id = f.id and c.level = 'transcription') as transcribed,
           staging.single_published_value(f) as single
  )
  select jsonb_build_object(
    'factId', f.id, 'kind', f.kind, 'subject', f.subject, 'value', f.value, 'unknown', f.is_unknown,
    'unknownReason', f.unknown_reason, 'status', f.status, 'confidence', f.confidence,
    'sourceId', f.source_page_id, 'checkedOn', f.checked_on, 'access', s.access,
    'confirmAs', case when f.status <> 'submitted' or f.entered_by = p_me then null
                      when s.access = 'cleared' and s.single then 'verify'
                      when s.access = 'private_pilot' and not s.transcribed then 'transcription' end,
    'canConfirm', f.status = 'submitted' and f.entered_by <> p_me
                  and ((s.access = 'cleared' and s.single) or (s.access = 'private_pilot' and not s.transcribed)),
    'canReject', f.status = 'submitted' and f.entered_by <> p_me,
    'statuses', jsonb_build_object(
      'extracted', true,
      'transcriptionConfirmed', s.transcribed or f.status = 'verified',
      'dietaryVerified', f.status = 'verified' and f.kind in ('dietary_status', 'allergen_statement'),
      'nutritionVerified', f.status = 'verified' and f.kind in ('published_nutrition', 'serving_size'),
      'reuseEligible', s.access = 'cleared',
      'publicationApproved', exists (select 1 from staging.publication_changes pc join public.catalog_changes cc on cc.id = pc.change_id
                                      where f.id = any (pc.fact_ids) and cc.state = 'published')),
    -- What the founder's private confirmation rested on: their own comparison, or the automatic one
    -- that they accepted. Never shown as a comparison by the founder when it was not.
    'confirmationBasis', (select case when c.note like 'Basis: automatic comparison accepted%' then 'automatic_comparison' else 'founder' end
                            from staging.fact_confirmations c where c.fact_id = f.id and c.level = 'transcription'),
    'machineCheck', (select jsonb_build_object('result', mc.result, 'detail', mc.detail, 'pageSavedAt', mc.page_saved_at, 'at', mc.created_at)
                       from staging.current_machine_check(f.id) mc where mc.id is not null))
  from s;
$$;
revoke all on function public.menu_review_fact_json(staging.facts, uuid) from public, anon, authenticated;

-- Rollback: re-run menu_review_fact_json from 20261118001500 and usda_begin_release from 20261115000800;
-- drop staging.record_machine_check, staging.current_machine_check and the fact_machine_checks table.
-- The USDA indexes can only go back to the single unique constraint if no excerpt and full file of the
-- same release are both imported; otherwise leave them.
