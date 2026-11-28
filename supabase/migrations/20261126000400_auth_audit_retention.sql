-- Retention of sign-in records (owner decision 4, 26 Nov 2026 19:36 UTC: routine logs no more than 30 days; never
-- claim a period the system cannot enforce). The sign-in service writes one row per sign-in event to
-- auth.audit_log_entries, including the network address, and never removes them. The scheduled maintenance now
-- removes rows older than 30 days. If the hosted service does not allow this (insufficient privilege), the rest of the
-- maintenance still runs and the run records "authAudit": "not permitted", so the gap is visible instead of silent.
-- Rollback: re-create app.run_maintenance(timestamptz) from 20261115000100 (removes only the new step).

create or replace function app.run_maintenance(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_diary integer;
  v_idem integer;
  v_tomb integer;
  v_social integer;
  v_rate integer;
  v_auth jsonb;
  v_n integer;
  v_result jsonb;
begin
  delete from public.diary_entries where deleted_at < p_now - interval '15 minutes';
  get diagnostics v_diary = row_count;
  delete from public.idempotency_records where expires_at < p_now;
  get diagnostics v_idem = row_count;
  delete from public.deletion_tombstones where completed_at is not null and backup_expiry < p_now;
  get diagnostics v_tomb = row_count;
  delete from public.social_action_log where at < p_now - interval '2 days';
  get diagnostics v_social = row_count;
  delete from public.rate_limit_windows where window_start < p_now - interval '2 days';
  get diagnostics v_rate = row_count;
  begin
    delete from auth.audit_log_entries where created_at < p_now - interval '30 days';
    get diagnostics v_n = row_count;
    v_auth := to_jsonb(v_n);
  exception when insufficient_privilege or undefined_table then
    v_auth := to_jsonb('not permitted'::text);
  end;
  delete from app.maintenance_runs where ran_at < p_now - interval '90 days';
  -- Counts only: never an owner, an entry or a bucket.
  v_result := jsonb_build_object(
    'diaryEntries', v_diary, 'idempotencyRecords', v_idem, 'deletionMarkers', v_tomb,
    'socialActions', v_social, 'rateWindows', v_rate, 'authAudit', v_auth);
  insert into app.maintenance_runs (ran_at, removed) values (p_now, v_result);
  return v_result;
end;
$$;
revoke execute on function app.run_maintenance(timestamptz) from public, anon, authenticated;
