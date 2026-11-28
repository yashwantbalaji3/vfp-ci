import { Suspense } from "react";
import Link from "next/link";
import { AppShell, Loading } from "@/components/app-shell";
import { rankingAction } from "@/app/social/actions";
import { Flash, RankingCard, SignInPrompt, SocialNav, StateBadge } from "@/components/social/bits";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getMyProfile, getMyRanking } from "@/server/social";

export const metadata = { title: "My ranking" };

function Op({ venueId, op, label, name, disabled = false }: { venueId: string; op: string; label: string; name: string; disabled?: boolean }) {
  return (
    <form action={rankingAction}>
      <input type="hidden" name="return" value="/friends/ranking" />
      <input type="hidden" name="venueId" value={venueId} />
      <button className="btn small" type="submit" name="op" value={op} disabled={disabled} aria-label={`${label}: ${name}`}>
        {label}
      </button>
    </form>
  );
}

async function Ranking({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next="/friends/ranking">
        <p>Sign in to keep a personal ranking of restaurants.</p>
      </SignInPrompt>
    );
  }
  const [me, r] = await Promise.all([getMyProfile(), getMyRanking()]);
  const pub = r.publication;
  const same = pub ? pub.entries.map((e) => e.venueId).join() === r.entries.map((e) => e.venueId).join() : false;
  return (
    <>
      <SocialNav active="ranking" requests={me.incomingRequests} />
      <Flash sp={sp} />
      <p className="s14 muted">
        Put the restaurants you&rsquo;ve reviewed in your own order. The order is private. Publishing shares a fixed copy of it; it never shares star ratings, and it never uses your diary to guess where you&rsquo;ve been.
      </p>
      <h2 className="h-sec">Your order (private)</h2>
      {r.entries.length === 0 ? (
        <div className="empty" data-testid="ranking-empty">
          <p>{r.unranked.length > 0 ? "Nothing ranked yet. Add restaurants from the list below." : "You can rank a restaurant once you've reviewed it. A private review is enough."}</p>
          {r.unranked.length === 0 && (
            <p>
              <Link className="btn primary" href="/discover">
                Find a restaurant to review
              </Link>
            </p>
          )}
        </div>
      ) : (
        <ol className="order" data-testid="ranking">
          {r.entries.map((e, i) => (
            <li key={e.venueId}>
              <span className="pos">{i + 1}</span>
              <span className="name">
                <Link href={`/venues/${e.venueId}`}>{e.name}</Link>
                {e.neighborhood && <span className="muted s14" style={{ fontWeight: 400 }}> · {e.neighborhood}</span>}
              </span>
              <span className="acts">
                <Op venueId={e.venueId} op="up" label="Move up" name={e.name} disabled={i === 0} />
                <Op venueId={e.venueId} op="down" label="Move down" name={e.name} disabled={i === r.entries.length - 1} />
                <Op venueId={e.venueId} op="remove" label="Remove" name={e.name} />
              </span>
            </li>
          ))}
        </ol>
      )}
      {r.unranked.length > 0 && (
        <>
          <h2 className="h-sec">Reviewed but not ranked</h2>
          <ul className="mine-list" data-testid="unranked">
            {r.unranked.map((v) => (
              <li key={v.venueId}>
                <div>
                  <strong>{v.name}</strong>
                  {v.neighborhood && <span className="s14 muted">{v.neighborhood}</span>}
                </div>
                <Op venueId={v.venueId} op="add" label="Add to ranking" name={v.name} />
              </li>
            ))}
          </ul>
        </>
      )}

      <h2 className="h-sec">Published copy</h2>
      {pub ? (
        <div data-testid="ranking-publication">
          <p>
            <StateBadge audience="public" state={pub.state} />
            {pub.state === "visible" && !same && <span className="s14 muted"> · Your private order has changed since. Publish again to update the public copy.</span>}
          </p>
          <RankingCard ranking={pub} heading={false} />
        </div>
      ) : (
        <p className="muted" data-testid="ranking-unpublished">
          Not published. Only you can see your order.
        </p>
      )}
      <div className="inline-forms" style={{ marginTop: 12 }}>
        <form action={rankingAction}>
          <input type="hidden" name="return" value="/friends/ranking" />
          <button className="btn primary" type="submit" name="op" value="publish" disabled={r.entries.length === 0}>
            {pub ? "Publish the current order" : "Publish this order"}
          </button>
        </form>
        {pub && pub.state !== "removed" && (
          <form action={rankingAction}>
            <input type="hidden" name="return" value="/friends/ranking" />
            <button className="btn" type="submit" name="op" value="withdraw">
              Withdraw the published copy
            </button>
          </form>
        )}
      </div>
      {!me.firstPublicApproved && <p className="s13 muted">Your first public post is checked by a moderator before anyone else can see it.</p>}
    </>
  );
}

export default function Page({ searchParams }: { searchParams: Promise<RawParams> }) {
  return (
    <AppShell active="friends" narrow>
      <h1 className="title">My restaurant ranking</h1>
      <Suspense fallback={<Loading />}>
        <Ranking searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
