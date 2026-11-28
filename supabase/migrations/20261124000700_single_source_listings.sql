-- Single-source directory listings (owner decision, 24 Nov 2026 17:59 UTC, Option A, with eight safeguards).
--
-- A place known from one dataset only (Overture), with a full address and Overture's confidence at or above the
-- review line, and no other concern, may now be a PRIVATE directory listing, so the Boston suburbs and the five new
-- markets have a directory. Safeguards enforced here:
--   * identity_status 'single_source' marks it in the data model; app.identity_basis reports 'single_source', so
--     every screen and founder tool says "One source, not cross-checked".
--   * Such a listing can never be public: a check constraint refuses visibility 'public' unless the identity status
--     changes (only the founder's identity verification does that, through the existing build).
--   * Nothing here creates a menu, a dish, a diet, a nutrition figure or a recommendation. Diet words in a dataset
--     category are never a cuisine (scripts/lib/cuisine.mjs) and menu_status stays 'not_checked'.
-- Existing listings are not changed. An index on market_slug keeps each market's directory fast with six loaded.
--
-- Rollback (only while no row has identity_status 'single_source', e.g. after withdrawing and deleting them on a
-- local copy): drop constraint place_listings_single_source_private; restore the two-value identity check;
-- restore app.identity_basis from 20261117000500; drop index place_listings_market.

alter table public.place_listings drop constraint place_listings_identity_status_check;
alter table public.place_listings add constraint place_listings_identity_status_check
  check (identity_status in ('corroborated', 'verified', 'single_source'));
alter table public.place_listings add constraint place_listings_single_source_private
  check (identity_status <> 'single_source' or visibility in ('preview', 'withdrawn'));

create index if not exists place_listings_market on public.place_listings (market_slug, visibility);

create or replace function app.identity_basis(p_identity text, p_batch uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when p_identity = 'verified' then 'verified'
    when p_identity = 'single_source' then 'single_source'
    when p_batch is not null and coalesce((select a.decision = 'approve' and a.decided_at > now() - interval '90 days'
                                             from public.batch_approvals a where a.batch_id = p_batch order by a.decided_at desc, a.id desc limit 1), false)
      then 'batch_sampled'
    else 'corroborated' end;
$$;
revoke all on function app.identity_basis(text, uuid) from public, anon, authenticated;
