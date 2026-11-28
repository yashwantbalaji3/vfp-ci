-- Research sources must be cleared before their facts count (owner direction 17 Nov 2026 22:37 UTC).
--
--   * staging.source_access: one append-only entry per reading of a website's terms, or per written
--     permission or licence, by exact host name. Same meaning as menu_ingest.access_permissions.
--   * A staged fact is "cleared" only when the latest entry for its source page's host permits our
--     use (not expired; a terms reading older than 180 days no longer counts). No entry, "unclear" or
--     "unreadable" means "pending"; "prohibits" means "prohibited". Anything uncertain fails closed.
--   * Held facts (pending or prohibited) stay out of the founder's review queue, cannot be verified
--     and cannot be published. New facts from a prohibited source are refused.
--   * Content from a prohibited source can be removed with staging.remove_source_content(): its
--     facts and source pages are deleted and a staging.removals row keeps counts and fingerprints.
--     Places, dishes and the permanent event log stay (no content is in them).

create table staging.source_access (
  id              bigint generated always as identity primary key,
  host            text not null check (host ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  kind            text not null check (kind in ('terms_review', 'written_permission', 'licence', 'api_terms')),
  status          text not null check (status in ('permits', 'prohibits', 'unclear', 'unreadable')),
  document_url    text check (document_url ~ '^https?://' and length(document_url) <= 2000),
  evidence        text not null check (length(evidence) between 3 and 2000),
  permitted_uses  text check (length(permitted_uses) <= 1000),
  reviewer        text not null check (length(reviewer) between 2 and 200),
  reviewed_at     timestamptz not null default now(),
  expires_at      timestamptz,
  recorded_at     timestamptz not null default now(),
  check (status <> 'permits' or permitted_uses is not null)
);
create index staging_source_access_host on staging.source_access (host, reviewed_at desc, id desc);

create table staging.removals (
  id            bigint generated always as identity primary key,
  host          text not null,
  removed_at    timestamptz not null default now(),
  reason        text not null check (length(reason) between 3 and 1000),
  authority     text not null check (length(authority) between 3 and 500),
  facts         int not null check (facts >= 0),
  source_pages  int not null check (source_pages >= 0),
  url_sha256    text[] not null default '{}'
);

do $$
declare t text;
begin
  foreach t in array array['source_access', 'removals'] loop
    execute format('alter table staging.%I enable row level security', t);
    execute format('alter table staging.%I force row level security', t);
    execute format('revoke all on staging.%I from public, anon, authenticated', t);
    execute format('create policy %I on staging.%I for all to postgres using (true) with check (true)', t || '_owner', t);
    execute format('create trigger %I before update or delete on staging.%I for each row execute function staging.guard_append_only()', t || '_append_only', t);
    execute format('create trigger %I before truncate on staging.%I for each statement execute function staging.guard_no_truncate()', t || '_no_truncate', t);
  end loop;
end $$;

/** The exact host of a web address, lower case, without a leading "www.". */
create function staging.url_host(p_url text)
returns text
language sql
immutable
set search_path = ''
as $$ select regexp_replace(lower(substring(p_url from '^[a-zA-Z]+://([^/:?#]+)')), '^www\.', ''); $$;

/** cleared | pending | prohibited, from the latest registry entry for the address's host. */
create function staging.source_access_state(p_url text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when x.status is null then 'pending'
              when x.status = 'prohibits' then 'prohibited'
              when x.status = 'permits' and (x.expires_at is null or x.expires_at > now())
                   and not (x.kind = 'terms_review' and x.reviewed_at < now() - interval '180 days') then 'cleared'
              else 'pending' end
    from (select 1) one
    left join lateral (select a.* from staging.source_access a where a.host = staging.url_host(p_url)
                        order by a.reviewed_at desc, a.id desc limit 1) x on true;
$$;

-- New facts from a prohibited source are refused; a held fact can be rejected but never verified.
create function staging.guard_fact_source()
returns trigger
language plpgsql
set search_path = ''
as $$
declare v_url text;
begin
  select url into v_url from staging.source_pages where id = new.source_page_id;
  if tg_op = 'INSERT' and staging.source_access_state(v_url) = 'prohibited' then
    raise exception 'STAGING_SOURCE_PROHIBITED' using errcode = 'PT422';
  end if;
  if tg_op = 'UPDATE' and new.status = 'verified' and old.status <> 'verified' and staging.source_access_state(v_url) <> 'cleared' then
    raise exception 'STAGING_SOURCE_NOT_CLEARED' using errcode = 'PT422';
  end if;
  return new;
end;
$$;
create trigger facts_source_access before insert or update on staging.facts for each row execute function staging.guard_fact_source();

-- A publication may use only facts from cleared sources (checked again at preparation time).
create function staging.guard_publication_sources()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from staging.facts f join staging.source_pages s on s.id = f.source_page_id
              where f.place_id = new.place_id and f.status = 'verified' and staging.source_access_state(s.url) <> 'cleared') then
    raise exception 'PLACE_SOURCES_NOT_CLEARED' using errcode = 'PT422';
  end if;
  return new;
end;
$$;
create trigger publications_source_access before insert on staging.publications for each row execute function staging.guard_publication_sources();

-- The founder's queue lists only facts from cleared sources. Same columns as before.
create or replace function staging.review_queue()
returns table (
  fact_id          uuid,
  place_id         uuid,
  place_label      text,
  area             text,
  shortlist_priority smallint,
  dish_id          uuid,
  dish_label       text,
  kind             text,
  subject          text,
  value            jsonb,
  is_unknown       boolean,
  unknown_reason   text,
  nutrition_state  text,
  source_url       text,
  source_kind      text,
  source_publisher text,
  source_retrieved_at timestamptz,
  source_terms_note text,
  checked_on       date,
  entered_by       uuid,
  entered_by_email text,
  entered_at       timestamptz,
  replaces_value   jsonb,
  replaces_unknown boolean,
  current_verified jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select f.id, p.id, p.label, p.area, p.shortlist_priority, d.id, d.label, f.kind, f.subject, f.value, f.is_unknown, f.unknown_reason,
         case when f.kind = 'published_nutrition' then case when f.is_unknown then 'unknown' else 'restaurant_published' end end,
         s.url, s.page_kind, s.publisher, s.retrieved_at, s.terms_note, f.checked_on,
         f.entered_by, u.email::text, f.entered_at,
         o.value, o.is_unknown,
         (select jsonb_agg(jsonb_build_object('value', v.value, 'unknown', v.is_unknown, 'reviewedAt', v.reviewed_at) order by v.reviewed_at desc)
            from staging.facts v
           where v.place_id = f.place_id and v.dish_id is not distinct from f.dish_id and v.kind = f.kind
             and v.subject is not distinct from f.subject and v.status = 'verified')
    from staging.facts f
    join staging.places p on p.id = f.place_id
    left join staging.dishes d on d.id = f.dish_id
    join staging.source_pages s on s.id = f.source_page_id
    left join auth.users u on u.id = f.entered_by
    left join staging.facts o on o.id = f.replaces_fact_id
   where f.status = 'submitted' and staging.source_access_state(s.url) = 'cleared'
   order by p.shortlist_priority, p.label, d.label nulls first, f.kind, f.subject nulls first, f.entered_at;
$$;

/** Facts held back because their source is not cleared, counted by place, host and state. */
create function staging.held_sources()
returns table (place_id uuid, place_label text, host text, state text, facts bigint, protein_facts bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.label, staging.url_host(s.url), staging.source_access_state(s.url), count(*),
         count(*) filter (where f.kind = 'published_nutrition' and f.subject = 'protein_g' and not f.is_unknown)
    from staging.facts f join staging.places p on p.id = f.place_id join staging.source_pages s on s.id = f.source_page_id
   where f.status in ('submitted', 'verified') and staging.source_access_state(s.url) <> 'cleared'
   group by 1, 2, 3, 4 order by 2, 3;
$$;

-- Deleting staged facts and source pages is allowed only inside remove_source_content().
create or replace function staging.guard_no_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and current_setting('staging.removal', true) = 'on' and tg_table_name in ('facts', 'source_pages') then
    return old;
  end if;
  raise exception 'Staged records are permanent history and cannot be deleted' using errcode = 'P0001';
end;
$$;

/** Remove every staged fact and source page from one prohibited host; keep counts and fingerprints. */
create function staging.remove_source_content(p_host text, p_reason text, p_authority text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare v_pages uuid[]; v_shas text[]; v_facts int; v_id bigint;
begin
  if staging.source_access_state('https://' || p_host || '/') <> 'prohibited' then
    raise exception 'STAGING_REMOVAL_NEEDS_PROHIBITION' using errcode = 'PT422',
      detail = 'Only content from a host whose latest registry entry prohibits our use is removed; anything else is held, not deleted.';
  end if;
  select coalesce(array_agg(id order by id), '{}'), coalesce(array_agg(encode(sha256(convert_to(url, 'UTF8')), 'hex') order by id), '{}')
    into v_pages, v_shas from staging.source_pages where staging.url_host(url) = p_host;
  select count(*) into v_facts from staging.facts where source_page_id = any (v_pages);
  perform set_config('staging.removal', 'on', true);
  -- Facts that replace one another go together: children first.
  delete from staging.facts where source_page_id = any (v_pages) and replaces_fact_id is not null;
  delete from staging.facts where source_page_id = any (v_pages);
  delete from staging.source_pages where id = any (v_pages);
  perform set_config('staging.removal', 'off', true);
  insert into staging.removals (host, reason, authority, facts, source_pages, url_sha256)
  values (p_host, p_reason, p_authority, v_facts, cardinality(v_pages), v_shas) returning id into v_id;
  return v_id;
end;
$$;

do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'staging' loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
end $$;
