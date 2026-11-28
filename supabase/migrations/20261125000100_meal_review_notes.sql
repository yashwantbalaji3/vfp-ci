-- Founder review queue: meal-level outcomes (owner directive 25 Nov 2026 04:01 UTC, section 4.1).
--
-- Fact decisions keep using public.menu_review_decide (one recorded decision per fact: confirm the transcription,
-- verify where the source is cleared, or reject). This adds the two outcomes that are about a whole meal rather
-- than one fact:
--   needs_evidence           the evidence on file is not enough to decide; the note says what is missing.
--   restaurant_confirmation  only the restaurant can settle it; the note is the question to ask (in person or, with
--                            separate approval, in writing). Nothing here contacts anyone.
-- A note never changes a fact, a dish, a tester decision or a publication state. Append-only: a later note on the same
-- meal supersedes an earlier one for display ('cleared' ends an open flag), and every note is kept. Founder-only.
--
-- Rollback: drop public.meal_review_notes, public.meal_review_note_add, the guard trigger and function, then
-- staging.meal_review_notes (export its rows first: they are the founder's notes).

create table staging.meal_review_notes (
  id          bigint generated always as identity primary key,
  dish_id     uuid not null references staging.dishes (id),
  outcome     text not null check (outcome in ('needs_evidence', 'restaurant_confirmation', 'cleared')),
  note        text not null check (length(btrim(note)) between 3 and 1000),
  recorded_by uuid not null,
  recorded_at timestamptz not null default clock_timestamp()
);
create index meal_review_notes_dish on staging.meal_review_notes (dish_id, recorded_at desc);
alter table staging.meal_review_notes enable row level security;
alter table staging.meal_review_notes force row level security;
revoke all on staging.meal_review_notes from public, anon, authenticated;

create function staging.guard_meal_review_note()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'RECORD_IMMUTABLE' using errcode = 'PT409';
end $$;
revoke all on function staging.guard_meal_review_note() from public, anon, authenticated;
create trigger meal_review_notes_guard before update or delete on staging.meal_review_notes
  for each row execute function staging.guard_meal_review_note();

create function public.meal_review_note_add(p_dish uuid, p_outcome text, p_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare n staging.meal_review_notes;
begin
  perform app.require_founder();
  if p_outcome is null or p_outcome not in ('needs_evidence', 'restaurant_confirmation', 'cleared')
     or length(btrim(coalesce(p_note, ''))) not between 3 and 1000 then
    raise exception 'INVALID_REQUEST' using errcode = 'PT422';
  end if;
  if not exists (select 1 from staging.dishes where id = p_dish) then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
  insert into staging.meal_review_notes (dish_id, outcome, note, recorded_by) values (p_dish, p_outcome, btrim(p_note), auth.uid())
  returning * into n;
  return jsonb_build_object('id', n.id, 'dishId', n.dish_id, 'outcome', n.outcome, 'note', n.note, 'recordedAt', n.recorded_at);
end $$;
revoke all on function public.meal_review_note_add(uuid, text, text) from public, anon;
grant execute on function public.meal_review_note_add(uuid, text, text) to authenticated;

-- Every note, newest first (the page shows the latest per meal and the history beneath it).
create function public.meal_review_notes()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_founder();
  return coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'dishId', n.dish_id, 'outcome', n.outcome, 'note', n.note, 'recordedAt', n.recorded_at)
                                    order by n.recorded_at desc, n.id desc)
                     from staging.meal_review_notes n), '[]'::jsonb);
end $$;
revoke all on function public.meal_review_notes() from public, anon;
grant execute on function public.meal_review_notes() to authenticated;
