-- Independent dietary confirmation records (owner decision 24 Nov 2026 21:20 UTC, decision 2). Founder-only.
--
-- A record keeps one documented answer about one exact dish at one restaurant branch: what was asked, the answer,
-- how it was obtained, when, from whom (role, and optionally a name or title), what it covers and its limits.
-- It is a separate kind of evidence and never changes a menu fact. The four evidence classes stay apart:
--   restaurant-published claims (staging.facts dietary_status), staff-confirmed claims (this table),
--   ingredient-supported classifications (our reading of listed ingredients) and unknown.
-- Nothing here is derived from a restaurant's identity, cuisine, meal name or any inference: a row exists only
-- because the founder entered it. Records are append-only; a mistaken record is withdrawn with a reason, never
-- edited or deleted. A record lapses 120 days after the answer was obtained, or when the dish's menu facts change
-- after the record was made (a new or corrected fact).

create table staging.diet_confirmations (
  id               uuid primary key default gen_random_uuid(),
  place_id         uuid not null references staging.places (id),
  dish_id          uuid not null,
  claim            text not null check (claim in ('vegetarian', 'vegan')),
  answer           text not null check (answer in ('suitable', 'not_suitable', 'unclear')),
  -- What was asked about. At least one topic.
  topics           text[] not null check (cardinality(topics) between 1 and 8
                     and topics <@ array['meat_or_fish_stock', 'fish_sauce', 'egg', 'dairy', 'animal_rennet', 'gelatin', 'honey', 'shared_fryer', 'whole_dish']::text[]),
  -- The answer in the source's own terms, as the founder wrote it down.
  answer_note      text not null check (length(btrim(answer_note)) between 3 and 1000),
  method           text not null check (method in ('printed_in_person', 'staff_in_person', 'staff_phone', 'restaurant_written', 'restaurant_submission', 'other_documented')),
  method_note      text check (method_note is null or length(btrim(method_note)) between 3 and 500),
  source_role      text not null check (length(btrim(source_role)) between 2 and 120),
  -- Optional: a person's name or title. Private to the founder; never shown to members or testers.
  source_identity  text check (source_identity is null or length(btrim(source_identity)) between 2 and 120),
  scope            text not null check (length(btrim(scope)) between 3 and 500),
  limitations      text not null check (length(btrim(limitations)) between 3 and 1000),
  obtained_on      date not null,
  expires_on       date not null,
  recorded_by      uuid not null,
  recorded_at      timestamptz not null default now(),
  -- A fingerprint of the dish's menu facts when the record was made (each fact's id, kind and value). Any new or
  -- corrected fact changes it, and the record lapses.
  menu_fingerprint text not null,
  withdrawn_at     timestamptz,
  withdrawn_by     uuid,
  withdrawn_reason text check (withdrawn_reason is null or length(btrim(withdrawn_reason)) between 3 and 500),
  foreign key (dish_id, place_id) references staging.dishes (id, place_id),
  check (expires_on = obtained_on + 120),
  check (method <> 'other_documented' or method_note is not null),
  check ((withdrawn_at is null) = (withdrawn_by is null) and (withdrawn_at is null) = (withdrawn_reason is null))
);
create index diet_confirmations_dish on staging.diet_confirmations (dish_id);
alter table staging.diet_confirmations enable row level security;
alter table staging.diet_confirmations force row level security;
revoke all on staging.diet_confirmations from public, anon, authenticated;

-- Append-only: no deletes; the only update allowed is a one-time withdrawal.
create function staging.guard_diet_confirmation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'RECORD_IMMUTABLE' using errcode = 'PT409'; end if;
  if old.withdrawn_at is not null then raise exception 'ALREADY_WITHDRAWN' using errcode = 'PT409'; end if;
  if (to_jsonb(new) - array['withdrawn_at', 'withdrawn_by', 'withdrawn_reason']) <> (to_jsonb(old) - array['withdrawn_at', 'withdrawn_by', 'withdrawn_reason']) then
    raise exception 'RECORD_IMMUTABLE' using errcode = 'PT409';
  end if;
  return new;
end $$;
revoke all on function staging.guard_diet_confirmation() from public, anon, authenticated;
create trigger diet_confirmations_guard before update or delete on staging.diet_confirmations
  for each row execute function staging.guard_diet_confirmation();

-- Fingerprint of the dish's menu facts: every fact's id, kind, unknown flag and value. A review decision (status)
-- does not change it; a new fact or a correction (always a new fact) does.
create function staging.dish_menu_fingerprint(p_dish uuid)
returns text language sql stable set search_path = '' as $$
  select md5(coalesce(string_agg(f.id::text || '|' || f.kind || '|' || f.is_unknown::text || '|' || coalesce(f.value::text, ''), ',' order by f.id), ''))
    from staging.facts f where f.dish_id = p_dish;
$$;
revoke all on function staging.dish_menu_fingerprint(uuid) from public, anon, authenticated;

-- Whether a record still counts today: not withdrawn, not expired, menu unchanged since it was recorded.
create function staging.diet_confirmation_state(c staging.diet_confirmations)
returns text language sql stable set search_path = '' as $$
  select case
    when c.withdrawn_at is not null then 'withdrawn'
    when c.expires_on < current_date then 'expired'
    when c.menu_fingerprint <> staging.dish_menu_fingerprint(c.dish_id) then 'menu_changed'
    else 'current' end;
$$;
revoke all on function staging.diet_confirmation_state(staging.diet_confirmations) from public, anon, authenticated;

create function app.diet_confirmation_json(c staging.diet_confirmations)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', c.id, 'placeId', c.place_id, 'dishId', c.dish_id, 'claim', c.claim, 'answer', c.answer, 'topics', to_jsonb(c.topics),
    'answerNote', c.answer_note, 'method', c.method, 'methodNote', c.method_note, 'sourceRole', c.source_role,
    'sourceIdentity', c.source_identity, 'scope', c.scope, 'limitations', c.limitations,
    'obtainedOn', c.obtained_on, 'expiresOn', c.expires_on, 'recordedAt', c.recorded_at,
    'state', staging.diet_confirmation_state(c), 'withdrawnAt', c.withdrawn_at, 'withdrawnReason', c.withdrawn_reason);
$$;
revoke all on function app.diet_confirmation_json(staging.diet_confirmations) from public, anon, authenticated;

create function public.diet_confirmation_record(
  p_dish uuid, p_claim text, p_answer text, p_topics text[], p_answer_note text, p_method text, p_method_note text,
  p_source_role text, p_source_identity text, p_scope text, p_limitations text, p_obtained_on date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  d staging.dishes;
  c staging.diet_confirmations;
begin
  perform app.require_founder();
  select * into d from staging.dishes where id = p_dish;
  if not found then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
  -- Shared input checks, so a bad form gives a plain code instead of a constraint error.
  if p_claim is null or p_claim not in ('vegetarian', 'vegan')
     or p_answer is null or p_answer not in ('suitable', 'not_suitable', 'unclear')
     or p_method is null or p_method not in ('printed_in_person', 'staff_in_person', 'staff_phone', 'restaurant_written', 'restaurant_submission', 'other_documented')
     or p_topics is null or cardinality(p_topics) not between 1 and 8
     or not (p_topics <@ array['meat_or_fish_stock', 'fish_sauce', 'egg', 'dairy', 'animal_rennet', 'gelatin', 'honey', 'shared_fryer', 'whole_dish']::text[])
     or length(btrim(coalesce(p_answer_note, ''))) not between 3 and 1000
     or length(btrim(coalesce(p_source_role, ''))) not between 2 and 120
     or length(btrim(coalesce(p_scope, ''))) not between 3 and 500
     or length(btrim(coalesce(p_limitations, ''))) not between 3 and 1000
     or (nullif(btrim(coalesce(p_source_identity, '')), '') is not null and length(btrim(p_source_identity)) not between 2 and 120)
     or (nullif(btrim(coalesce(p_method_note, '')), '') is not null and length(btrim(p_method_note)) not between 3 and 500)
     or (p_method = 'other_documented' and nullif(btrim(coalesce(p_method_note, '')), '') is null) then
    raise exception 'INVALID_REQUEST' using errcode = 'PT422';
  end if;
  if p_obtained_on is null or p_obtained_on > current_date then raise exception 'OBTAINED_IN_FUTURE' using errcode = 'PT422'; end if;
  if p_obtained_on < current_date - 120 then raise exception 'OBTAINED_TOO_LONG_AGO' using errcode = 'PT422'; end if;
  insert into staging.diet_confirmations (place_id, dish_id, claim, answer, topics, answer_note, method, method_note, source_role,
    source_identity, scope, limitations, obtained_on, expires_on, recorded_by, menu_fingerprint)
  values (d.place_id, d.id, p_claim, p_answer, p_topics, btrim(p_answer_note), p_method, nullif(btrim(coalesce(p_method_note, '')), ''),
    btrim(p_source_role), nullif(btrim(coalesce(p_source_identity, '')), ''), btrim(p_scope), btrim(p_limitations), p_obtained_on,
    p_obtained_on + 120, auth.uid(), staging.dish_menu_fingerprint(d.id))
  returning * into c;
  return app.diet_confirmation_json(c);
end $$;
revoke all on function public.diet_confirmation_record(uuid, text, text, text[], text, text, text, text, text, text, text, date) from public, anon;
grant execute on function public.diet_confirmation_record(uuid, text, text, text[], text, text, text, text, text, text, text, date) to authenticated;

create function public.diet_confirmation_withdraw(p_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c staging.diet_confirmations;
begin
  perform app.require_founder();
  if length(btrim(coalesce(p_reason, ''))) not between 3 and 500 then raise exception 'INVALID_REQUEST' using errcode = 'PT422'; end if;
  update staging.diet_confirmations set withdrawn_at = now(), withdrawn_by = auth.uid(), withdrawn_reason = btrim(p_reason)
   where id = p_id returning * into c;
  if not found then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
  return app.diet_confirmation_json(c);
end $$;
revoke all on function public.diet_confirmation_withdraw(uuid, text) from public, anon;
grant execute on function public.diet_confirmation_withdraw(uuid, text) to authenticated;

-- All records, newest first; optionally one dish's.
create function public.diet_confirmations(p_dish uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_founder();
  return coalesce((select jsonb_agg(app.diet_confirmation_json(c) order by c.recorded_at desc, c.id)
                     from staging.diet_confirmations c where p_dish is null or c.dish_id = p_dish), '[]'::jsonb);
end $$;
revoke all on function public.diet_confirmations(uuid) from public, anon;
grant execute on function public.diet_confirmations(uuid) to authenticated;

-- Rollback: drop public.diet_confirmations, public.diet_confirmation_withdraw, public.diet_confirmation_record,
-- app.diet_confirmation_json, staging.diet_confirmation_state, staging.dish_menu_fingerprint, the trigger and
-- staging.guard_diet_confirmation, then staging.diet_confirmations (export its rows first: they are founder records).
