-- Invite-only, enforced by the database as well as by the auth hook (26 Nov 2026, docs/98 section 4).
-- The "before user created" auth hook (20261122000800) must be switched on in the hosted dashboard, and Supabase's
-- pricing page (read 26 Nov 2026) does not list that hook among the Free plan's hooks. This BEFORE INSERT trigger on
-- auth.users applies the same rule on every plan: while app.invite_settings is on, a NEW account is refused unless its
-- email has an active invite. It never affects existing accounts, and does nothing while invite-only is off (the default).
-- Rollback: drop trigger invites_guard_new_account on auth.users; drop function app.guard_new_account().

create function app.guard_new_account()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce((select s.enabled from app.invite_settings s where s.id), false)
     and not exists (select 1 from app.invites i where i.email = lower(coalesce(new.email, '')) and i.revoked_at is null) then
    raise exception 'This beta is invite-only.' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function app.guard_new_account() from public, anon, authenticated;

create trigger invites_guard_new_account
  before insert on auth.users
  for each row execute function app.guard_new_account();
