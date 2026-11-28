-- SCALE-2: the following and friends feeds were slow (about 0.3 s for a member following 10 people
-- with 400 posts) because the full card for EVERY candidate post was built before the newest 20
-- were picked. Building a card calls app.review_json, a security-definer function that cannot be
-- inlined, so its inner queries were planned again for each of the 400 posts.
--
-- Now the feed works out only what it needs to choose and count posts (the post's target, exactly as
-- app.social_target gives it, and the diet group from app.social_diet_group), picks the page, and
-- builds full cards for those posts only. Same signature, same grants, same answers: tests compare
-- every combination with the previous definition (tests/db/scale2-feed.test.ts).
create or replace function public.social_feed(
  p_feed text,
  p_view text default 'matches',
  p_diet text default 'none',
  p_exclusions text[] default '{}',
  p_include_conditional boolean default false,
  p_before timestamptz default null,
  p_limit integer default 20,
  p_include_demo boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_member();
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_items jsonb;
  v_unsure integer;
begin
  perform app.check_view(p_view);
  if p_feed not in ('following', 'friends') then
    raise exception 'INVALID_FEED' using errcode = 'PT422';
  end if;
  with ok as (
    select f.followed_id as id from public.follows f
     where p_feed = 'following' and f.follower_id = v_uid and app.profile_ok(v_uid, f.followed_id, p_include_demo)
    union all
    select o.id from public.friendships f
     cross join lateral (select case when f.requester_id = v_uid then f.recipient_id else f.requester_id end as id) o
     where p_feed = 'friends' and f.state = 'accepted' and v_uid in (f.requester_id, f.recipient_id)
       and app.profile_ok(v_uid, o.id, p_include_demo)
  ), cand as (
    select 'review'::text as type, r.published_at as at, r.id as ref,
           app.social_diet_group(app.social_target(r.venue_id, r.food_item_id, p_diet, p_exclusions, p_include_conditional, p_include_demo)) as grp
      from public.reviews r join ok on ok.id = r.author_id
     where r.publication_state = 'visible'
       and (r.audience = 'public' or (p_feed = 'friends' and r.audience = 'friends'))
    union all
    select 'list', l.published_at, l.id, 'match'
      from public.food_lists l join ok on ok.id = l.owner_id
     where p_feed = 'following' and l.visibility = 'public' and l.publication_state = 'visible'
    union all
    select 'ranking', rp.published_at, rp.owner_id, 'match'
      from public.ranking_publications rp join ok on ok.id = rp.owner_id
     where p_feed = 'following' and rp.publication_state = 'visible' and rp.withdrawn_at is null
  ), page as (
    select c.type, c.at, c.ref from cand c
     where c.grp = case when p_view = 'matches' then 'match' else 'unsure' end
       and (p_before is null or c.at < p_before)
     order by c.at desc limit v_limit
  )
  select coalesce((
           select jsonb_agg(jsonb_build_object('type', p.type, 'at', p.at, 'item',
                    case p.type
                      when 'review' then (select app.review_json(r, v_uid, p_diet, p_exclusions, p_include_conditional, p_include_demo)
                                            from public.reviews r where r.id = p.ref)
                      when 'list' then (select app.list_json(l, v_uid, false, p_diet, p_exclusions, p_include_conditional, p_include_demo)
                                          from public.food_lists l where l.id = p.ref)
                      else app.public_ranking_json(p.ref, v_uid, p_include_demo)
                    end) order by p.at desc)
             from page p), '[]'::jsonb),
         (select count(*) from cand c where c.grp = 'unsure')
    into v_items, v_unsure;
  return jsonb_build_object(
    'feed', p_feed, 'items', v_items, 'needsConfirmationCount', v_unsure,
    'nextBefore', case when jsonb_array_length(v_items) = v_limit then v_items -> (v_limit - 1) -> 'at' end);
end;
$$;
