import { FLAGS } from "@/config/flags";
import { Suspense } from "react";
import Link from "next/link";
import { AppShell, Loading } from "@/components/app-shell";
import { DietChip } from "@/components/diet-chip";
import { relationshipAction } from "@/app/social/actions";
import { DietNote, Flash, ListCard, PersonRow, PrivacyPromise, RankingCard, ReviewCard, SignInPrompt, SocialNav, TargetLine } from "@/components/social/bits";
import type { Recommendation } from "@/contracts/social";
import { hasDietChoice } from "@/domain/dietary/labels";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { readDietPreference } from "@/server/catalog/diet";
import { getEditorialCollections, getFeed, getMyProfile, getRecommendations, getSuggestedPeople } from "@/server/social";
import { limitNotice } from "@/components/too-many-requests";
import { pageLimit } from "@/server/page-limit";

export const metadata = { title: "Friends & Lists" };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

async function Collections() {
  let collections;
  try {
    collections = await getEditorialCollections();
  } catch {
    return null;
  }
  if (collections.length === 0) return null;
  return (
    <section aria-labelledby="collections-h" data-testid="collections">
      <h2 className="h-sec" id="collections-h">
        Editorial collections
      </h2>
      <p className="s14 muted" style={{ marginTop: 0 }}>
        Put together by our team, not by other members. Your dietary filter applies when you open one.
      </p>
      <ul className="feed">
        {collections.map((c) => (
          <ListCard key={c.listId} list={c} />
        ))}
      </ul>
    </section>
  );
}

function Why({ rec }: { rec: Recommendation }) {
  return (
    <li className="post" data-testid="recommendation">
      <TargetLine target={rec.target} />
      <ul className="reasons">
        {rec.reasons.map((r) => (
          <li key={r.person.handle}>
            <Link className="link" href={`/u/${r.person.handle}`}>
              {r.person.displayName}
            </Link>{" "}
            rated this {r.rating} out of 5{r.audience === "friends" ? " (shared with friends only)" : ""}
            {r.person.isDemo ? " (demo account)" : ""}
          </li>
        ))}
      </ul>
      <div className="foot">
        <DietNote target={rec.target} />
      </div>
    </li>
  );
}

async function Hub({ searchParams }: { searchParams: Promise<RawParams> }) {
  const refused = limitNotice(await pageLimit());
  if (refused) return refused;
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) {
    return (
      <>
        <SignInPrompt next="/friends">
          <h2>See what people you trust are eating</h2>
          <p>Follow people for their public reviews, add friends for the posts they share only with friends, keep a personal restaurant ranking, and make lists to share.</p>
        </SignInPrompt>
        <PrivacyPromise />
        {/* Signed-out visitors see social content only when public reading is switched on. */}
        {FLAGS.socialPublicEnabled && <Collections />}
      </>
    );
  }
  const feedKind = one(sp.feed) === "friends" ? "friends" : "following";
  const view = one(sp.view) === "needs_confirmation" ? "needs_confirmation" : "matches";
  const before = one(sp.before);
  const diet = await readDietPreference();
  const strict = hasDietChoice(diet);
  const [me, feed] = await Promise.all([getMyProfile(), getFeed(feedKind, view, diet, before && !Number.isNaN(Date.parse(before)) ? before : undefined)]);
  const [recs, suggested] = feedKind === "following" ? await Promise.all([getRecommendations(view, diet), getSuggestedPeople()]) : [null, []];
  const here = `/friends${feedKind === "friends" ? "?feed=friends" : ""}`;
  const withView = (v: string) => `/friends?${new URLSearchParams({ ...(feedKind === "friends" ? { feed: "friends" } : {}), ...(v === "matches" ? {} : { view: v }) }).toString()}`;
  const olderParams = new URLSearchParams({ ...(feedKind === "friends" ? { feed: "friends" } : {}), ...(view === "matches" ? {} : { view }), ...(feed.nextBefore ? { before: feed.nextBefore } : {}) });
  const older = `/friends?${olderParams.toString()}`;
  const unsure = Math.max(feed.needsConfirmationCount, recs?.needsConfirmationCount ?? 0);

  return (
    <>
      <SocialNav active="feed" requests={me.incomingRequests} />
      <Flash sp={sp} />
      {!me.profile && (
        <div className="callout calm" data-testid="profile-needed">
          <strong>Set up your profile to follow people and share reviews.</strong> You choose a handle and what is shown. Nothing from your diary is ever shown.{" "}
          <Link href="/friends/profile">Set up your profile</Link>
        </div>
      )}
      {me.incomingRequests > 0 && (
        <p className="callout calm">
          You have {me.incomingRequests} friend {me.incomingRequests === 1 ? "request" : "requests"}. <Link href="/friends/people">Review</Link>
        </p>
      )}
      <nav className="seg" aria-label="Which feed" style={{ margin: "12px 0" }}>
        <Link href="/friends" aria-current={feedKind === "following" ? "true" : undefined}>
          Following
        </Link>
        <Link href="/friends?feed=friends" aria-current={feedKind === "friends" ? "true" : undefined}>
          Friends
        </Link>
      </nav>
      <p className="s14 muted" style={{ marginTop: 0 }} data-testid="feed-explainer">
        {feedKind === "following"
          ? "Public reviews, lists and rankings from people you follow. Following never shows you anything private or friends-only."
          : "Reviews your friends shared with friends or with everyone. A friendship exists only after both of you agree."}
      </p>
      <div className="row" style={{ marginBottom: 12 }}>
        <DietChip diet={diet} returnTo={here} />
      </div>
      {strict && (
        <nav className="seg" aria-label="Result groups" style={{ marginBottom: 12 }}>
          <Link href={withView("matches")} aria-current={view === "matches" ? "true" : undefined}>
            Fits your filter
          </Link>
          <Link href={withView("needs_confirmation")} aria-current={view === "needs_confirmation" ? "true" : undefined}>
            Needs confirmation ({unsure})
          </Link>
        </nav>
      )}
      {view === "needs_confirmation" && (
        <p className="callout">
          <strong>Not confirmed.</strong> These dishes are not confirmed to fit your filter. Ask the restaurant before ordering.
        </p>
      )}

      <h2 className="sr-only">{feedKind === "following" ? "Following feed" : "Friends feed"}</h2>
      {feed.items.length > 0 ? (
        <ul className="feed" data-testid="feed">
          {feed.items.map((i) =>
            i.type === "review" ? (
              <ReviewCard key={`r-${i.item.reviewId}`} review={i.item} returnTo={here} canReport />
            ) : i.type === "list" ? (
              <ListCard key={`l-${i.item.listId}`} list={i.item} />
            ) : (
              <li key={`k-${i.item.publicationId}`} style={{ listStyle: "none" }}>
                <RankingCard ranking={i.item} />
              </li>
            ),
          )}
        </ul>
      ) : (
        <div className="empty" data-testid="feed-empty">
          {view === "needs_confirmation" ? (
            <p>Nothing here is waiting for confirmation.</p>
          ) : feedKind === "following" ? (
            (recs?.followingCount ?? 0) === 0 ? (
              <>
                <h3>You&rsquo;re not following anyone yet</h3>
                <p>When you follow someone, their public reviews, lists and rankings appear here. Nothing is shown until then: we don&rsquo;t fill this page with made-up activity.</p>
                <p>
                  <Link className="btn primary" href="/friends/people">
                    Find people by handle
                  </Link>
                </p>
              </>
            ) : (
              <p>{strict ? "Nothing from the people you follow fits your dietary filter yet." : "The people you follow haven't posted anything public yet."}</p>
            )
          ) : (
            <>
              <h3>No posts from friends yet</h3>
              <p>Friends are people who accepted your request, or whose request you accepted. Posts they share with friends appear here.</p>
              <p>
                <Link className="btn primary" href="/friends/people">
                  Find people by handle
                </Link>
              </p>
            </>
          )}
        </div>
      )}
      {feed.nextBefore && (
        <p>
          <Link className="btn" href={older}>
            Older posts
          </Link>
        </p>
      )}

      {recs && (recs.venues.length > 0 || recs.dishes.length > 0) && (
        <section aria-labelledby="recs-h" data-testid="recommendations">
          <h2 className="h-sec" id="recs-h">
            Recommended by people you follow and your friends
          </h2>
          <p className="s14 muted" style={{ marginTop: 0 }}>
            Places and dishes rated 4 or 5 in public by people you follow, or shared with friends only by your friends. Each one says who and why. Friends-only ratings are shown only to friends and never count anywhere public. Nothing else decides this list.
          </p>
          {recs.dishes.length > 0 && (
            <>
              <h3 className="h-sec" style={{ fontSize: 16, marginTop: 12 }}>
                Dishes
              </h3>
              <ul className="feed">
                {recs.dishes.map((r) => (
                  <Why key={r.target.id} rec={r} />
                ))}
              </ul>
            </>
          )}
          {recs.venues.length > 0 && (
            <>
              <h3 className="h-sec" style={{ fontSize: 16, marginTop: 12 }}>
                Restaurants
              </h3>
              <ul className="feed">
                {recs.venues.map((r) => (
                  <Why key={r.target.id} rec={r} />
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {suggested.length > 0 && view === "matches" && (
        <section aria-labelledby="people-h" data-testid="suggested-people">
          <h2 className="h-sec" id="people-h">
            People with public reviews
          </h2>
          <p className="s14 muted" style={{ marginTop: 0 }}>
            Members who chose to be findable and have shared public reviews. Shown newest first, nothing more.
          </p>
          <ul className="mine-list">
            {suggested.map((p) => (
              <li key={p.handle}>
                <div>
                  <PersonRow person={p} note={`${p.publicReviews} public ${p.publicReviews === 1 ? "review" : "reviews"}`} />
                </div>
                {me.profile && (
                  <form action={relationshipAction}>
                    <input type="hidden" name="return" value={here} />
                    <input type="hidden" name="handle" value={p.handle} />
                    <button className="btn small" type="submit" name="op" value="follow" aria-label={`Follow ${p.displayName}`}>
                      Follow
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {view === "matches" && <Collections />}
      <PrivacyPromise />
    </>
  );
}

export default function Page({ searchParams }: { searchParams: Promise<RawParams> }) {
  return (
    <AppShell active="friends" narrow>
      <h1 className="title">Friends &amp; Lists</h1>
      <Suspense fallback={<Loading />}>
        <Hub searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
