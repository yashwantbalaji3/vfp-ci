-- Tester feedback inside the app (owner direction 23 Nov 2026 19:34 UTC, item 4: "Prepare the invitation and
-- feedback workflow"; docs/78 section 7 and docs/80). Nothing is sent to anyone; no outside form service is used.
--
--   * public.beta_feedback: a member's own answers, as one of two short forms:
--       'week' - the after-a-week questions (did you use it, did labels match the restaurant, anything wrong,
--                what was missing, the trust question and would you recommend it);
--       'note' - a quick note at any time, with the page it was written on.
--     Answers are fixed choices and short text; the form asks for no health details.
--   * A member reads and deletes only their own feedback; it is removed with their account (foreign key).
--   * The founder reads everyone's through public.beta_feedback_all(), which names each person only by a tester
--     code (a short one-way hash of the account id, also shown to the tester), never by email or name.
--   * At most one 'week' answer per member per 6 days and 20 notes per member per day.
-- Rollback: drop the three functions and the table.

create function public.beta_feedback_valid(p_form text, a jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(a) = 'object', false) and case p_form
    when 'week' then
          (a ?& array['used', 'labels', 'trust', 'recommend'])
      and a ->> 'used' in ('most_days', 'a_few_times', 'once', 'not_at_all')
      and a ->> 'labels' in ('matched', 'one_or_more_wrong', 'did_not_check')
      and jsonb_typeof(a -> 'trust') = 'number' and a ->> 'trust' ~ '^[1-5]$'
      and jsonb_typeof(a -> 'recommend') = 'number' and a ->> 'recommend' ~ '^[1-5]$'
      and coalesce(length(a ->> 'wrong'), 0) <= 500
      and coalesce(length(a ->> 'missing'), 0) <= 500
      and (select count(*) from jsonb_object_keys(a) k where k not in ('used', 'labels', 'trust', 'recommend', 'wrong', 'missing')) = 0
    when 'note' then
          a ? 'text' and length(btrim(a ->> 'text')) between 3 and 500
      and coalesce(a ->> 'page', '/') ~ '^/[A-Za-z0-9/_?=&%.-]{0,200}$'
      and (select count(*) from jsonb_object_keys(a) k where k not in ('text', 'page')) = 0
    else false end;
$$;
-- Used by the table's check; writes go through beta_feedback_send (security definer), so nobody else needs it.
revoke all on function public.beta_feedback_valid(text, jsonb) from public, anon, authenticated;

create table public.beta_feedback (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  form       text not null check (form in ('week', 'note')),
  answers    jsonb not null,
  created_at timestamptz not null default now(),
  constraint beta_feedback_answers_valid check (public.beta_feedback_valid(form, answers))
);
create index beta_feedback_user on public.beta_feedback (user_id, created_at desc);
alter table public.beta_feedback enable row level security;
alter table public.beta_feedback force row level security;
revoke all on public.beta_feedback from public, anon, authenticated;
grant select, delete on public.beta_feedback to authenticated;
create policy beta_feedback_own_read on public.beta_feedback for select to authenticated using (user_id = (select auth.uid()));
create policy beta_feedback_own_delete on public.beta_feedback for delete to authenticated using (user_id = (select auth.uid()));
create policy beta_feedback_definer on public.beta_feedback for all to postgres using (true) with check (true);

create function public.beta_tester_code(p_user uuid)
returns text language sql immutable set search_path = '' as $$
  select substr(encode(extensions.digest('vfp-tester:' || p_user::text, 'sha256'), 'hex'), 1, 6);
$$;
revoke all on function public.beta_tester_code(uuid) from public, anon, authenticated;

-- Send one answer. Writes go through here so the limits hold.
create function public.beta_feedback_send(p_form text, p_answers jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if v_uid is null then raise exception 'NOT_SIGNED_IN' using errcode = 'PT401'; end if;
  if p_form not in ('week', 'note') or not public.beta_feedback_valid(p_form, p_answers) then
    raise exception 'INVALID_FEEDBACK' using errcode = 'PT422';
  end if;
  perform pg_advisory_xact_lock(hashtext('beta_feedback:' || v_uid::text));
  if p_form = 'week' and exists (select 1 from public.beta_feedback where user_id = v_uid and form = 'week' and created_at > now() - interval '6 days') then
    raise exception 'ALREADY_SENT' using errcode = 'PT409';
  end if;
  if p_form = 'note' and (select count(*) from public.beta_feedback where user_id = v_uid and form = 'note' and created_at > now() - interval '1 day') >= 20 then
    raise exception 'TOO_MANY' using errcode = 'PT429';
  end if;
  insert into public.beta_feedback (user_id, form, answers) values (v_uid, p_form, p_answers) returning id into v_id;
  return jsonb_build_object('id', v_id, 'form', p_form, 'testerCode', public.beta_tester_code(v_uid));
end;
$$;
revoke all on function public.beta_feedback_send(text, jsonb) from public, anon;
grant execute on function public.beta_feedback_send(text, jsonb) to authenticated;

-- The signed-in member's own tester code, shown on their feedback page.
create function public.beta_my_tester_code()
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'NOT_SIGNED_IN' using errcode = 'PT401'; end if;
  return public.beta_tester_code(auth.uid());
end;
$$;
revoke all on function public.beta_my_tester_code() from public, anon;
grant execute on function public.beta_my_tester_code() to authenticated;

-- Everyone's feedback, for the founder only, by tester code.
create function public.beta_feedback_all()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_founder();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', f.id, 'tester', public.beta_tester_code(f.user_id), 'form', f.form,
                                        'answers', f.answers, 'createdAt', f.created_at) order by f.created_at desc)
      from public.beta_feedback f), '[]'::jsonb);
end;
$$;
revoke all on function public.beta_feedback_all() from public, anon;
grant execute on function public.beta_feedback_all() to authenticated;
