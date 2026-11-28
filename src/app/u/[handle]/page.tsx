import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell, Loading } from "@/components/app-shell";
import { DietChip } from "@/components/diet-chip";
import { relationshipAction } from "@/app/social/actions";
import { Avatar, Flash, ListCard, RankingCard, ReportForm, ReviewCard, SignInPrompt } from "@/components/social/bits";
import { Icon } from "@/components/icons";
import { FLAGS } from "@/config/flags";
import { handleSchema } from "@/contracts/social";
import { describeDietChoice, hasDietChoice } from "@/domain/dietary/labels";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { readDietPreference } from "@/server/catalog/diet";
import { SocialError, getMyProfile, getProfile } from "@/server/social";
import { limitNotice } from "@/components/too-many-requests";
import { pageLimit } from "@/server/page-limit";

export const metadata = { title: "Profile" };
type Props = { params: Promise<{ handle: string }>; searchParams: Promise<RawParams> };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function Rel({ handle, here, op, label, primary = false }: { handle: string; here: string; op: string; label: string; primary?: boolean }) {
  return (
    <form action={relationshipAction}>
      <input type="hidden" name="return" value={here} />
      <input type="hidden" name="handle" value={handle} />
      <button className={`btn ${primary ? "primary" : ""}`} type="submit" name="op" value={op} data-testid={`rel-${op}`}>
        {label}
      </button>
    </form>
  );
}

async function Profile({ params, searchParams }: Props) {
  const refused = limitNotice(await pageLimit());
  if (refused) return refused;
  const [{ handle: raw }, sp] = await Promise.all([params, searchParams]);
  const handle = handleSchema.safeParse(decodeURIComponent(raw));
  if (!handle.success) notFound();
  const here = `/u/${handle.data}`;
  const member = await getCurrentMember();
  if (!member && !FLAGS.socialPublicEnabled) {
    return (
      <SignInPrompt next={here}>
        <h1 className="title-sm">Sign in to see profiles</h1>
        <p>Profiles and reviews are open to signed-in members for now.</p>
      </SignInPrompt>
    );
  }
  const view = one(sp.view) === "needs_confirmation" ? "needs_confirmation" : "matches";
  const diet = await readDietPreference();
  let data;
  let iHaveProfile = false;
  try {
    data = await getProfile(handle.data, view, diet);
    if (member) iHaveProfile = Boolean((await getMyProfile()).profile);
  } catch (e) {
    if (e instanceof SocialError && e.status === 404) notFound();
    throw e;
  }
  const p = data.profile;
  const rel = data.relationship;
  const strict = hasDietChoice(diet);
  return (
    <>
      <Link className="link-btn" href="/friends">
        <Icon name="back" />
        Friends &amp; Lists
      </Link>
      <header className="profile-head">
        <Avatar person={p} size="lg" />
        <div style={{ minWidth: 0 }}>
          <h1 className="title" data-testid="profile-name">
            {p.displayName}
          </h1>
          <p className="muted" style={{ margin: 0 }}>
            @{p.handle} · joined {p.joined}
          </p>
        </div>
      </header>
      {p.isDemo && (
        <p className="callout" data-testid="demo-profile">
          <strong>Demo account.</strong> This is an invented profile for testing. It is not a real person, and its reviews never count toward real ratings.
        </p>
      )}
      <Flash sp={sp} />
      {p.bio && <p className="lede">{p.bio}</p>}
      <ul className="counts" data-testid="profile-counts">
        <li>
          <strong>{p.followerCount}</strong> {p.followerCount === 1 ? "follower" : "followers"}
        </li>
        <li>
          <strong>{p.followingCount}</strong> following
        </li>
      </ul>
      {(p.tastes?.length || p.diet) && (
        <p className="s14" data-testid="profile-tastes">
          {p.diet && (
            <>
              <strong>Diet:</strong> {describeDietChoice({ diet: p.diet as "vegetarian" | "vegan", exclusions: [] })}
              {p.tastes?.length ? " · " : ""}
            </>
          )}
          {p.tastes?.length ? (
            <>
              <strong>Tastes:</strong> {p.tastes.join(", ")}
            </>
          ) : null}
        </p>
      )}

      {data.isMe ? (
        <p>
          <Link className="btn" href="/friends/profile">
            Edit my profile
          </Link>
          <span className="s13 muted" style={{ display: "block", marginTop: 4 }}>This is what other people see.</span>
        </p>
      ) : rel ? (
        <section aria-label="Your connection" data-testid="relationship">
          {!iHaveProfile && (
            <p className="callout calm">
              To follow or add friends, first <Link href="/friends/profile">set up your profile</Link>.
            </p>
          )}
          <div className="inline-forms">
            {rel.following ? <Rel handle={p.handle} here={here} op="unfollow" label="Following · Unfollow" /> : <Rel handle={p.handle} here={here} op="follow" label="Follow" primary />}
            {rel.friendship === "friends" && <Rel handle={p.handle} here={here} op="unfriend" label="Friends · Remove" />}
            {rel.friendship === "outgoing" && <Rel handle={p.handle} here={here} op="unfriend" label="Friend request sent · Cancel" />}
            {rel.friendship === "incoming" && (
              <>
                <Rel handle={p.handle} here={here} op="accept" label="Accept friend request" primary />
                <Rel handle={p.handle} here={here} op="decline" label="Decline" />
              </>
            )}
            {rel.friendship === "none" && rel.canRequestFriend && <Rel handle={p.handle} here={here} op="request" label="Add friend" />}
          </div>
          <p className="s13 muted" style={{ marginTop: 6 }}>
            {rel.followsMe ? "Follows you. " : ""}
            Following shows you their public posts. Friends also see each other&rsquo;s friends-only posts. Neither ever shows a diary.
            {rel.friendship === "none" && !rel.canRequestFriend ? " This person accepts friend requests only from people they follow." : ""}
          </p>
          <details className="sheet" style={{ marginTop: 8 }}>
            <summary>Block</summary>
            <div className="sheet-body stack">
              <p style={{ margin: 0 }}>You and {p.displayName} will no longer see each other&rsquo;s profile or posts, and any follow or friendship ends. They are not told.</p>
              <Rel handle={p.handle} here={here} op="block" label={`Block ${p.displayName}`} />
            </div>
          </details>
          <div style={{ marginTop: 8 }}>
            <ReportForm type="profile" handle={p.handle} returnTo={here} />
          </div>
        </section>
      ) : null}

      {data.ranking && data.ranking.entries.length > 0 && (
        <section aria-labelledby="rank-h">
          <h2 className="h-sec" id="rank-h">
            Restaurant ranking
          </h2>
          <RankingCard ranking={data.ranking} heading={false} />
          {member && !data.isMe && <div style={{ marginTop: 8 }}><ReportForm type="ranking" id={data.ranking.publicationId} returnTo={here} /></div>}
        </section>
      )}

      {data.lists.length > 0 && (
        <section aria-labelledby="lists-h">
          <h2 className="h-sec" id="lists-h">
            Lists
          </h2>
          <ul className="feed">
            {data.lists.map((l) => (
              <ListCard key={l.listId} list={l} />
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="revs-h">
        <h2 className="h-sec" id="revs-h">
          Reviews
        </h2>
        <div className="row" style={{ marginBottom: 12 }}>
          <DietChip diet={diet} returnTo={here} />
        </div>
        {strict && (
          <nav className="seg" aria-label="Result groups" style={{ marginBottom: 12 }}>
            <Link href={here} aria-current={view === "matches" ? "true" : undefined}>
              Fits your filter
            </Link>
            <Link href={`${here}?view=needs_confirmation`} aria-current={view === "needs_confirmation" ? "true" : undefined}>
              Needs confirmation ({data.needsConfirmationCount})
            </Link>
          </nav>
        )}
        {view === "needs_confirmation" && (
          <p className="callout">
            <strong>Not confirmed.</strong> These dishes are not confirmed to fit your filter. Ask the restaurant before ordering.
          </p>
        )}
        {data.reviews.length > 0 ? (
          <ul className="feed" data-testid="profile-reviews">
            {data.reviews.map((r) => (
              <ReviewCard key={r.reviewId} review={r} returnTo={here} canReport={Boolean(member)} />
            ))}
          </ul>
        ) : (
          <p className="muted" data-testid="profile-no-reviews">
            {view === "needs_confirmation"
              ? "Nothing here is waiting for confirmation."
              : strict
                ? "No reviews here fit your dietary filter."
                : data.isMe
                  ? "You haven't shared any reviews yet."
                  : "Nothing shared with you yet."}
          </p>
        )}
      </section>
    </>
  );
}

export default function Page(props: Props) {
  return (
    <AppShell active="friends" narrow>
      <Suspense fallback={<Loading />}>
        <Profile {...props} />
      </Suspense>
    </AppShell>
  );
}
