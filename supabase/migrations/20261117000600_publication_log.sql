-- Publication tools (docs/38). Nothing here publishes anything by itself.
--   1. publication_events: an append-only log of every change to the real-place switch and every
--      publish or unpublish run of the local publication commands. A trigger on the switch writes
--      its row, so a change made any other way is logged too.
--   2. Nothing else changes: making a listing public is still refused by app.guard_place_listing unless
--      the switch is on and the place is founder-verified or in a currently approved batch, and
--      place_directory re-checks that on every read.

create table public.publication_events (
  id         bigint generated always as identity primary key,
  action     text not null check (action in ('switch_on', 'switch_off', 'publish', 'unpublish')),
  batch_id   uuid references public.publication_batches (id),
  scope      text not null check (scope in ('switch', 'batch', 'verified', 'all')),
  listings   integer not null default 0 check (listings >= 0),
  run_by     text not null check (length(run_by) between 1 and 200),
  note       text check (length(note) <= 500),
  at         timestamptz not null default now()
);
alter table public.publication_events enable row level security;
revoke all on public.publication_events from public, anon, authenticated;

create function app.guard_publication_event()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'The publication log is permanent' using errcode = 'PT403';
end $$;
revoke all on function app.guard_publication_event() from public, anon, authenticated;
create trigger publication_events_permanent before update or delete on public.publication_events
  for each row execute function app.guard_publication_event();

-- Every change of the real-place switch is logged, whoever makes it. The local command passes its
-- operator name in the setting app.publication_run_by; otherwise the database role is recorded.
create function app.log_place_switch()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.name = 'real_place_listings' and new.enabled is distinct from old.enabled then
    insert into public.publication_events (action, scope, run_by, note)
    values (case when new.enabled then 'switch_on' else 'switch_off' end, 'switch',
            coalesce(nullif(current_setting('app.publication_run_by', true), ''), session_user::text),
            nullif(current_setting('app.publication_note', true), ''));
  end if;
  return new;
end $$;
revoke all on function app.log_place_switch() from public, anon, authenticated;
create trigger platform_switches_log after update on app.platform_switches
  for each row execute function app.log_place_switch();
