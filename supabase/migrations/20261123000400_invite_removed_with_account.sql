-- When a member deletes their account, their entry on the invite list goes too (privacy notice draft, 23 Nov 2026:
-- "your email address is removed from the invite list"). Before this, app.invites kept the address after deletion.
-- An AFTER DELETE trigger on auth.users, so it also covers an account the founder removes from the dashboard.
-- Rollback: drop trigger invites_forget_deleted_account on auth.users; drop function app.forget_invite().

create function app.forget_invite()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.email is not null then
    delete from app.invites where email = lower(old.email);
  end if;
  return old;
end;
$$;
revoke all on function app.forget_invite() from public, anon, authenticated;

create trigger invites_forget_deleted_account
  after delete on auth.users
  for each row execute function app.forget_invite();
