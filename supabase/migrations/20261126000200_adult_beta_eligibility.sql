-- Adults only for the invited beta (owner decision 2, 26 Nov 2026 19:36 UTC: "18+ for the initial invited beta ...
-- Verify that the actual registration and invitation experience enforces the approved eligibility rules rather than
-- relying solely on legal text"). Two layers:
--   1. Invitation: an invite counts only when the owner confirmed, when adding it, that the person is an adult
--      (app.invites.adult_confirmed). The auth hook and the database guard both require it while invite-only is on.
--   2. First use: a signed-in member confirms they are 18 or older and agrees to the current Terms and Privacy
--      version before using the app (public.confirm_beta_eligibility). The app sends a member who has not, or who
--      agreed to an older version, to /welcome. The record (public.member_agreements) holds when they confirmed, the
--      version agreed and when, so a later policy change (for example at public launch) asks again.
-- Rollback: restore the two functions from 20261122000800 / 20261126000100; drop functions
-- public.confirm_beta_eligibility(boolean, text) and public.my_beta_eligibility(); drop table public.member_agreements;
-- drop column app.invites.adult_confirmed. No account is removed.

alter table app.invites add column adult_confirmed boolean not null default false;

-- The member's own confirmation, one row per member, written only by confirm_beta_eligibility(). Kept apart from
-- user_preferences, whose row's existence means "has chosen a diet" for the first-run diet question.
create table public.member_agreements (
  user_id            uuid primary key references auth.users (id) on delete cascade,
  adult_confirmed_at timestamptz not null,
  legal_version      text not null check (length(legal_version) between 1 and 40),
  legal_accepted_at  timestamptz not null
);
alter table public.member_agreements enable row level security;
alter table public.member_agreements force row level security;
revoke all on public.member_agreements from public, anon, authenticated;

create or replace function public.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email text := lower(coalesce(event -> 'user' ->> 'email', ''));
begin
  if not coalesce((select s.enabled from app.invite_settings s where s.id), false) then
    return '{}'::jsonb;
  end if;
  if exists (select 1 from app.invites i where i.email = v_email and i.revoked_at is null and i.adult_confirmed) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'This beta is invite-only.'));
end;
$$;

create or replace function app.guard_new_account()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce((select s.enabled from app.invite_settings s where s.id), false)
     and not exists (select 1 from app.invites i
                      where i.email = lower(coalesce(new.email, '')) and i.revoked_at is null and i.adult_confirmed) then
    raise exception 'This beta is invite-only.' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- The member's own answer. p_adult must be true: someone under 18 is not asked to continue (the page offers to delete
-- the account instead). p_version is the Terms and Privacy version shown to them (src/content/legal.ts LEGAL_VERSION).
create function public.confirm_beta_eligibility(p_adult boolean, p_version text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_uid uuid := app.require_member();
begin
  if p_adult is distinct from true then
    raise exception 'ADULT_REQUIRED' using errcode = 'PT422';
  end if;
  if p_version is null or length(p_version) not between 1 and 40 then
    raise exception 'VERSION_REQUIRED' using errcode = 'PT422';
  end if;
  insert into public.member_agreements (user_id, adult_confirmed_at, legal_version, legal_accepted_at)
  values (v_uid, now(), p_version, now())
  on conflict (user_id) do update
    set legal_version = excluded.legal_version, legal_accepted_at = excluded.legal_accepted_at;
  return public.my_beta_eligibility();
end;
$$;

create function public.my_beta_eligibility()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'adultConfirmedAt', a.adult_confirmed_at,
    'legalVersion', a.legal_version,
    'legalAcceptedAt', a.legal_accepted_at)
    from (select auth.uid() as uid) me
    left join public.member_agreements a on a.user_id = me.uid
   where me.uid is not null;
$$;

revoke all on function public.confirm_beta_eligibility(boolean, text), public.my_beta_eligibility() from public, anon;
grant execute on function public.confirm_beta_eligibility(boolean, text), public.my_beta_eligibility() to authenticated;
