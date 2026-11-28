-- Invite-only sign-up for eventual hosted testing (owner direction 22 Nov 2026 15:26 UTC: launch blocker "invite-only
-- access for eventual hosted testing"; docs/72 section 5). OFF by default, so local use and every test are unchanged.
--
-- When the owner turns it on (scripts/invites.mjs on, or the same row in a hosted database), the auth server's
-- "before user created" hook refuses any NEW account whose email is not on the owner's invite list. Existing
-- accounts keep signing in. Invites are typed in by the owner; nothing is ever sent from here (no automatic
-- invites or emails). The list lives in the private app schema: members can neither read nor change it.

create table app.invite_settings (
  id         boolean primary key default true check (id),
  enabled    boolean not null default false,
  changed_by text,
  changed_at timestamptz
);
insert into app.invite_settings (id, enabled) values (true, false);

create table app.invites (
  email      text primary key check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 254),
  note       text check (note is null or length(note) <= 200),
  added_by   text not null check (length(added_by) between 3 and 120),
  added_at   timestamptz not null default now(),
  revoked_at timestamptz
);
alter table app.invite_settings enable row level security;
alter table app.invites enable row level security;
revoke all on app.invite_settings, app.invites from public, anon, authenticated;

-- The auth hook (Supabase "before user created"). Returns {} to allow, or an error the sign-in page shows.
create function public.hook_before_user_created(event jsonb)
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
  if exists (select 1 from app.invites i where i.email = v_email and i.revoked_at is null) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'This beta is invite-only.'));
end;
$$;
revoke all on function public.hook_before_user_created(jsonb) from public, anon, authenticated;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
grant usage on schema app to supabase_auth_admin;
grant select on app.invite_settings, app.invites to supabase_auth_admin;
create policy invite_settings_auth on app.invite_settings for select to supabase_auth_admin using (true);
create policy invites_auth on app.invites for select to supabase_auth_admin using (true);

-- Rollback: disable the hook in supabase/config.toml (or the hosted dashboard), then drop function
-- public.hook_before_user_created(jsonb), tables app.invites and app.invite_settings. No account is affected.
