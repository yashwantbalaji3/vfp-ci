-- CAT-3 / MENU-1: tie a researched restaurant profile (pilot staging) to its real catalog place.
--
-- Owner direction 17 Nov 2026 16:13 UTC: progress menu ingestion and dish-level dietary and protein
-- verification in parallel with the real directory; keep every unverified fact private, keep the
-- publication lock, publish nothing.
--
--   * A link says "this staged profile is that catalog place". It copies nothing and publishes
--     nothing: no dish, dietary statement, price or nutrient moves anywhere.
--   * Links are permanent history. Unlinking adds a row; nothing is updated or deleted.
--   * An automatic link needs the staged address fact (not rejected or replaced) to share the house
--     number, street name and ZIP code with the catalog place, and the two names to share a
--     distinctive word. Any other link is the founder's own, with a note.
--   * At most one live link per staged profile and per catalog place.
--   * Nothing outside the closed staging schema reads a link: no public or app function, view or
--     policy. The founder sees links through the local `scripts/menu-link.mjs` report.
--   * staging.link_catalog reads catalog_import.place_candidates (also closed) to check the address
--     and name. That is the only function outside catalog_import that reads it.

create table staging.catalog_links (
  id             bigint generated always as identity primary key,
  staging_place  uuid not null references staging.places (id),
  candidate_id   uuid not null references catalog_import.place_candidates (id),
  action         text not null check (action in ('link', 'unlink')),
  method         text check (method in ('address_match', 'person')),
  evidence       jsonb not null default '{}'::jsonb,
  note           text check (note is null or length(note) between 3 and 500),
  actor_id       uuid not null,
  at             timestamptz not null default now(),
  check ((action = 'link') = (method is not null)),
  check (action = 'link' and method = 'address_match' or note is not null)
);
create index staging_catalog_links_place on staging.catalog_links (staging_place, at desc, id desc);
create index staging_catalog_links_candidate on staging.catalog_links (candidate_id, at desc, id desc);
alter table staging.catalog_links enable row level security;
alter table staging.catalog_links force row level security;
revoke all on staging.catalog_links from public, anon, authenticated;
create policy catalog_links_owner on staging.catalog_links for all to postgres using (true) with check (true);
create trigger catalog_links_append_only before update or delete on staging.catalog_links
  for each row execute function staging.guard_append_only();

alter table staging.events drop constraint events_action_check;
alter table staging.events add constraint events_action_check
  check (action in ('add_place', 'add_dish', 'add_source_page', 'submit_fact', 'verify_fact', 'reject_fact', 'replace_fact',
                    'set_place_status', 'prepare_publication', 'link_catalog', 'unlink_catalog'));

-- The live link of each staged profile: its latest row, when that row is a link.
create view staging.live_catalog_links with (security_invoker = true) as
  select l.staging_place, l.candidate_id, l.method, l.at, l.actor_id
    from (select distinct on (staging_place) * from staging.catalog_links order by staging_place, at desc, id desc) l
   where l.action = 'link';
revoke all on staging.live_catalog_links from public, anon, authenticated;

-- House number, first word of the street name and five-digit ZIP, the way the address match compares
-- them ("22 Eliot St" + "02138" -> "22|eliot|02138"). Two places on different streets with the same
-- number and ZIP never match; spellings that differ ("Mass Ave" and "Massachusetts Ave") are left to a person.
create function staging.address_key(p_street text, p_postcode text)
returns text language sql immutable set search_path = '' as $$
  select case when m is null or z is null then null else lower(m[1]) || '|' || lower(m[2]) || '|' || z end
    from (select regexp_match(coalesce(p_street, ''), '^\s*([0-9]+[A-Za-z]?)(?:-[0-9]+)?\s+([A-Za-z]+)') m,
                 substring(coalesce(p_postcode, '') from '^([0-9]{5})') z) x;
$$;

-- Two names share a distinctive word of 4 letters or more ("Chipotle (Back Bay)" and "Chipotle Mexican
-- Grill" do; "Tatte Bakery & Cafe" and "CAVA" do not). Generic words such as cafe or bakery do not count,
-- so two different bakeries at one address never match.
create function staging.names_share_word(p_a text, p_b text)
returns boolean language sql immutable set search_path = '' as $$
  select exists (
    select 1
      from regexp_split_to_table(lower(coalesce(p_a, '')), '[^a-z0-9]+') a(w)
      join regexp_split_to_table(lower(coalesce(p_b, '')), '[^a-z0-9]+') b(w) on a.w = b.w
     where length(a.w) >= 4
       and a.w not in ('cafe', 'caffe', 'coffee', 'bakery', 'restaurant', 'grill', 'kitchen', 'house', 'shop', 'market', 'bistro',
                       'boston', 'cambridge', 'square', 'street', 'avenue', 'center', 'centre', 'plaza', 'park', 'food', 'foods',
                       'company', 'organic', 'pizza', 'taqueria', 'express', 'downtown', 'south', 'north', 'back', 'fenway',
                       'central', 'harvard', 'kendall', 'financial', 'district', 'theatre', 'theater', 'longwood', 'medical',
                       'prudential', 'station', 'crossing', 'government', 'specials'));
$$;

create function staging.link_catalog(p_actor uuid, p_place uuid, p_candidate uuid, p_method text, p_note text default null)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_addr record;
  v_cand record;
  v_id bigint;
begin
  if p_method = 'person' then
    perform staging.require_role(p_actor, 'publisher');
    if p_note is null then raise exception 'LINK_NOTE_REQUIRED' using errcode = 'PT400'; end if;
  elsif p_method = 'address_match' then
    if not (staging.actor_has_role(p_actor, 'curator') or staging.actor_has_role(p_actor, 'publisher')) then
      raise exception 'Only a curator or the publisher may link a profile' using errcode = 'PT403';
    end if;
  else
    raise exception 'LINK_METHOD_UNKNOWN' using errcode = 'PT400', detail = p_method;
  end if;
  if not exists (select 1 from staging.places where id = p_place) then raise exception 'STAGING_PLACE_UNKNOWN' using errcode = 'PT404'; end if;
  select id, name, street, postcode, quality into v_cand from catalog_import.place_candidates where id = p_candidate;
  if not found then raise exception 'CANDIDATE_UNKNOWN' using errcode = 'PT404'; end if;
  if v_cand.quality = 'rejected' then raise exception 'CANDIDATE_REJECTED' using errcode = 'PT409'; end if;
  if exists (select 1 from staging.live_catalog_links where staging_place = p_place) then
    raise exception 'PROFILE_ALREADY_LINKED' using errcode = 'PT409';
  end if;
  if exists (select 1 from staging.live_catalog_links where candidate_id = p_candidate) then
    raise exception 'PLACE_ALREADY_LINKED' using errcode = 'PT409';
  end if;

  select f.id, f.value ->> 'street' as street, f.value ->> 'postcode' as postcode into v_addr
    from staging.facts f
   where f.place_id = p_place and f.kind = 'address' and not f.is_unknown and f.status in ('submitted', 'verified')
   order by f.entered_at desc limit 1;
  if p_method = 'address_match' then
    if v_addr.id is null then raise exception 'NO_ADDRESS_FACT' using errcode = 'PT409'; end if;
    if staging.address_key(v_addr.street, v_addr.postcode) is null
       or staging.address_key(v_addr.street, v_addr.postcode) is distinct from staging.address_key(v_cand.street, v_cand.postcode) then
      raise exception 'ADDRESS_MISMATCH' using errcode = 'PT409',
        detail = format('%s %s vs %s %s', v_addr.street, v_addr.postcode, v_cand.street, v_cand.postcode);
    end if;
    -- Many places share an address (food courts, office towers): the names must agree too.
    if not staging.names_share_word((select label from staging.places where id = p_place), v_cand.name) then
      raise exception 'NAME_MISMATCH' using errcode = 'PT409', detail = v_cand.name;
    end if;
  end if;

  insert into staging.catalog_links (staging_place, candidate_id, action, method, evidence, note, actor_id)
  values (p_place, p_candidate, 'link', p_method,
          jsonb_build_object('addressFact', v_addr.id, 'stagedStreet', v_addr.street, 'stagedPostcode', v_addr.postcode,
                             'candidateName', v_cand.name, 'candidateStreet', v_cand.street, 'candidatePostcode', v_cand.postcode),
          p_note, p_actor)
  returning id into v_id;
  insert into staging.events (actor_id, action, place_id, detail)
  values (p_actor, 'link_catalog', p_place, jsonb_build_object('candidateId', p_candidate, 'method', p_method, 'linkId', v_id));
  return v_id;
end;
$$;

create function staging.unlink_catalog(p_actor uuid, p_place uuid, p_note text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare v_live record; v_id bigint;
begin
  select * into v_live from staging.live_catalog_links where staging_place = p_place;
  if not found then raise exception 'NOT_LINKED' using errcode = 'PT404'; end if;
  if not (staging.actor_has_role(p_actor, 'publisher') or (v_live.actor_id = p_actor and staging.actor_has_role(p_actor, 'curator'))) then
    raise exception 'Only the publisher or the person who linked may unlink' using errcode = 'PT403';
  end if;
  if p_note is null then raise exception 'LINK_NOTE_REQUIRED' using errcode = 'PT400'; end if;
  insert into staging.catalog_links (staging_place, candidate_id, action, note, actor_id)
  values (p_place, v_live.candidate_id, 'unlink', p_note, p_actor) returning id into v_id;
  insert into staging.events (actor_id, action, place_id, detail)
  values (p_actor, 'unlink_catalog', p_place, jsonb_build_object('candidateId', v_live.candidate_id, 'linkId', v_id));
  return v_id;
end;
$$;
revoke all on function staging.address_key(text, text) from public, anon, authenticated;
revoke all on function staging.names_share_word(text, text) from public, anon, authenticated;
revoke all on function staging.link_catalog(uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function staging.unlink_catalog(uuid, uuid, text) from public, anon, authenticated;
