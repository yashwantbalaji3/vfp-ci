-- ============================================================================
-- M5 step 1 · DEF-01 and the account deletion workflow (R-007, docs/12).
--
-- DEF-01: deleting a member who owned a custom food failed. The member's source
-- record was removed (via sources) before the food's portions and nutrient values
-- (via food_items), and those rows still pointed at it. Both groups of rows are
-- removed in the same deletion, so the two checks now run at the end of the
-- transaction, when everything the member owned is gone. A row that would really
-- be left pointing at a missing source record is still refused.
-- ============================================================================
alter table public.portions
  alter constraint portions_source_record_id_fkey deferrable initially deferred;
alter table public.nutrient_values
  alter constraint nutrient_values_source_record_id_fkey deferrable initially deferred;

-- ---------------------------------------------------------------------------
-- delete_my_account: the signed-in member deletes their own account.
--   * Requires a sign-in within the last 10 minutes (R-007 "reauthenticated")
--     and the typed word DELETE.
--   * Removes the account row; every private and social table that belongs to the
--     member is removed with it by foreign keys (diary, snapshots, goals, own
--     foods, cook sessions, plans, saves, preferences, profile, follows,
--     friendships, blocks, reviews, rankings, lists, reports they filed).
--   * Keeps only: a tombstone holding a one-way hash of the account id (so a
--     restored backup can be cleaned again, docs/12) and one audit row without
--     the member's id. Earlier audit rows lose their link to the member.
--   * Public catalog content is untouched.
-- ---------------------------------------------------------------------------
create function public.delete_my_account(p_confirm text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_last timestamptz;
  v_ref text;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  if p_confirm is distinct from 'DELETE' then
    raise exception 'CONFIRMATION_REQUIRED' using errcode = 'PT422';
  end if;
  select u.last_sign_in_at into v_last from auth.users u where u.id = v_uid;
  if not found then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  if v_last is null or v_last < now() - interval '10 minutes' then
    raise exception 'REAUTH_REQUIRED' using errcode = 'PT403';
  end if;
  -- The last admin cannot remove themselves and leave the service without one.
  if exists (select 1 from public.role_assignments ra where ra.user_id = v_uid and ra.role = 'admin')
     and not exists (select 1 from public.role_assignments ra where ra.user_id <> v_uid and ra.role = 'admin') then
    raise exception 'LAST_ADMIN' using errcode = 'PT409';
  end if;

  v_ref := encode(extensions.digest(v_uid::text, 'sha256'), 'hex');
  insert into public.deletion_tombstones (subject_ref, requested_at, completed_at, backup_expiry)
  values (v_ref, now(), now(), now() + interval '30 days')
  on conflict (subject_ref) do update set completed_at = excluded.completed_at, backup_expiry = excluded.backup_expiry;

  delete from auth.users u where u.id = v_uid;

  insert into public.audit_events (actor_id, action, entity_type, entity_id, reason)
  values (null, 'account.deleted', 'account', null, 'Deleted by the member');
  return jsonb_build_object('deleted', true);
end;
$$;
revoke execute on function public.delete_my_account(text) from public, anon;
grant execute on function public.delete_my_account(text) to authenticated;
