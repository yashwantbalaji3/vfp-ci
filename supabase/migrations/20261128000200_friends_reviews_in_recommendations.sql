-- Friends-only reviews in recommendations (owner approval 28 Nov 2026 02:27 UTC, decision 3).
--
-- Until now, recommendations used only PUBLIC reviews by people the viewer follows. The owner approved letting
-- FRIENDS-ONLY reviews count too, but only in recommendations shown to that author's accepted friends, with the same
-- audience rule on every path, and never in anything public.
--
-- One source for both paths that show recommendations (Friends page `social_recommendations` and the map's
-- "Rated highly by" via `app.followed_picks`). A review counts for viewer V when:
--   * it is visible, rated 4 or 5, not V's own, V has not reviewed the same place or dish, and
--     app.profile_ok(V, author) holds (blocks, hidden profiles, demo rule, guests); and
--   * audience 'public' and V follows the author, or
--     audience 'friends' and app.are_friends(V, author) (accepted friendship, checked at read time, so ending the
--     friendship or blocking removes it at once).
-- Public results are unchanged: rating summaries, public feeds, profiles and search still read public reviews only,
-- and anonymous viewers get nothing (both functions need a signed-in member).
--
-- Each reason now carries the review's audience, so the page can say "friends only".
--
-- Rollback: re-create app.followed_picks and public.social_recommendations from
-- 20261115000600_map1_search_and_map.sql and 20261114000400_m5_social.sql (same signatures), then drop
-- app.recommendation_picks. No data changes.

create function app.recommendation_picks(p_uid uuid, p_include_demo boolean)
returns table (venue_id uuid, food_item_id uuid, n bigint, latest timestamptz, reasons jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select r.venue_id, r.food_item_id, count(*), max(r.published_at),
         jsonb_agg(jsonb_build_object('person', app.person_json(r.author_id), 'rating', r.rating, 'audience', r.audience)
                   order by r.rating desc, r.published_at desc)
    from public.reviews r
   where p_uid is not null
     and r.author_id <> p_uid
     and r.publication_state = 'visible' and r.rating >= 4
     and app.profile_ok(p_uid, r.author_id, p_include_demo)
     and ((r.audience = 'public' and exists (select 1 from public.follows f where f.follower_id = p_uid and f.followed_id = r.author_id))
          or (r.audience = 'friends' and app.are_friends(p_uid, r.author_id)))
     and not exists (select 1 from public.reviews mine
                      where mine.author_id = p_uid and (mine.venue_id = r.venue_id or mine.food_item_id = r.food_item_id))
   group by r.venue_id, r.food_item_id;
$$;
revoke all on function app.recommendation_picks(uuid, boolean) from public, anon, authenticated;

create or replace function app.followed_picks(p_uid uuid, p_include_demo boolean)
returns table (venue_id uuid, food_item_id uuid, reasons jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select p.venue_id, p.food_item_id, p.reasons from app.recommendation_picks(p_uid, p_include_demo) p;
$$;
revoke all on function app.followed_picks(uuid, boolean) from public, anon, authenticated;

create or replace function public.social_recommendations(
  p_view text default 'matches', p_diet text default 'none', p_exclusions text[] default '{}',
  p_include_conditional boolean default false, p_include_demo boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_member();
  v_result jsonb;
begin
  perform app.check_view(p_view);
  with ok as (
    select f.followed_id as id from public.follows f
     where f.follower_id = v_uid and app.profile_ok(v_uid, f.followed_id, p_include_demo)
  ), picks as (
    select * from app.recommendation_picks(v_uid, p_include_demo)
  ), shaped as (
    select p.*, app.social_target(p.venue_id, p.food_item_id, p_diet, p_exclusions, p_include_conditional, p_include_demo) as target from picks p
  ), g as (select s.*, app.social_diet_group(s.target) as grp from shaped s)
  select jsonb_build_object(
    'venues', coalesce((select jsonb_agg(jsonb_build_object('target', x.target, 'reasons', x.reasons, 'count', x.n) order by x.n desc, x.latest desc)
                          from (select * from g where g.venue_id is not null and g.grp = 'match' and p_view = 'matches'
                                 order by g.n desc, g.latest desc limit 12) x), '[]'::jsonb),
    'dishes', coalesce((select jsonb_agg(jsonb_build_object('target', x.target, 'reasons', x.reasons, 'count', x.n) order by x.n desc, x.latest desc)
                          from (select * from g where g.food_item_id is not null
                                  and g.grp = case when p_view = 'matches' then 'match' else 'unsure' end
                                 order by g.n desc, g.latest desc limit 12) x), '[]'::jsonb),
    'needsConfirmationCount', (select count(*) from g where g.grp = 'unsure'),
    'followingCount', (select count(*) from ok))
    into v_result;
  return v_result;
end;
$$;
