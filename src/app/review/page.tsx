import { Suspense } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppShell, Loading } from "@/components/app-shell";
import { saveReviewAction } from "@/app/social/actions";
import { Flash, StateBadge } from "@/components/social/bits";
import { Icon } from "@/components/icons";
import { idSchema } from "@/contracts/catalog";
import { targetHref, targetKindSchema } from "@/contracts/social";
import { safeReturnPath } from "@/lib/format";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { SocialError, getMyProfile, getTargetReviews } from "@/server/social";

export const metadata = { title: "Rate and review" };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const RATINGS = [
  { n: 1, word: "Poor" },
  { n: 2, word: "Fair" },
  { n: 3, word: "Good" },
  { n: 4, word: "Very good" },
  { n: 5, word: "Excellent" },
];

async function ReviewForm({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const kind = targetKindSchema.safeParse(one(sp.kind));
  const id = idSchema.safeParse(one(sp.id));
  if (!kind.success || !id.success) notFound();
  const here = `/review?kind=${kind.data}&id=${id.data}`;
  const member = await getCurrentMember();
  if (!member) redirect(`/login?next=${encodeURIComponent(here)}`);
  let data, me;
  try {
    [data, me] = await Promise.all([getTargetReviews(kind.data, id.data), getMyProfile()]);
  } catch (e) {
    if (e instanceof SocialError && e.status === 404) notFound();
    throw e;
  }
  const t = data.target;
  if (t.kind !== "venue" && t.kind !== "dish" && t.kind !== "recipe") notFound();
  const mine = data.mine;
  const after = safeReturnPath(one(sp.after), targetHref(t));
  const hasProfile = Boolean(me.profile);
  const current = mine?.audience ?? "private";
  const firstCheck = !me.firstPublicApproved;
  return (
    <>
      <Link className="link-btn" href={after}>
        <Icon name="back" />
        Back
      </Link>
      <p className="eyebrow">{t.kind === "venue" ? "Restaurant review" : t.kind === "recipe" ? "Recipe review" : "Dish review"}</p>
      <h1 className="title" data-testid="review-target">
        {t.name}
      </h1>
      <p className="muted" style={{ marginTop: 0 }}>
        {t.kind === "venue"
          ? "You're rating the restaurant as a whole. Dishes are rated separately on their own pages."
          : t.kind === "recipe"
            ? "You're rating this recipe as written. It helps to say what you cooked and any swaps you made."
            : `You're rating this dish only${t.venueName ? `, not ${t.venueName} as a whole` : ""}.`}
      </p>
      <Flash sp={sp} />
      {mine && (
        <p>
          Right now: <StateBadge audience={mine.audience} state={mine.state} />
        </p>
      )}
      {mine?.state === "removed" && (
        <p className="callout stop">A moderator removed this review. You can edit it and share it again; it will be checked before anyone else sees it.</p>
      )}
      <form action={saveReviewAction} className="panel stack" data-testid="review-form">
        <input type="hidden" name="return" value={`${here}${one(sp.after) ? `&after=${encodeURIComponent(after)}` : ""}`} />
        <input type="hidden" name="after" value={after} />
        <input type="hidden" name="kind" value={kind.data} />
        <input type="hidden" name="targetId" value={id.data} />
        {mine && <input type="hidden" name="expectedVersion" value={mine.version} />}
        <fieldset>
          <legend>Your rating</legend>
          <div className="rating-pick">
            {RATINGS.map((r) => (
              <label key={r.n}>
                <input type="radio" name="rating" value={r.n} defaultChecked={mine?.rating === r.n} required />
                <span className="num">{r.n}</span>
                <span>{r.word}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div>
          <label htmlFor="rv-body">What would you tell a friend? (optional)</label>
          <textarea id="rv-body" name="body" defaultValue={mine?.body ?? ""} maxLength={2000} rows={5} aria-describedby="rv-body-hint" />
          <p className="s13 muted" id="rv-body-hint" style={{ margin: "4px 0 0" }}>
            Up to 2,000 characters. {t.kind === "recipe" ? "Describe your own cooking" : "Describe your own visit"}. Don&rsquo;t state that something is safe for an allergy.
          </p>
        </div>
        <div>
          <label htmlFor="rv-date">{t.kind === "recipe" ? "When did you cook it? (optional)" : "When did you go? (optional)"}</label>
          <input id="rv-date" type="date" name="visitDate" defaultValue={mine?.visitDate ?? ""} style={{ minHeight: 44, font: "inherit", padding: "8px 12px", border: "1px solid var(--control-border)", borderRadius: 8, width: "100%" }} />
        </div>
        <fieldset>
          <legend>Who can see this review?</legend>
          <label className="check">
            <input type="radio" name="audience" value="private" defaultChecked={current === "private"} />
            <span>
              Only me
              <span className="hint">A private note. It counts toward no rating and nobody else can read it.</span>
            </span>
          </label>
          <label className="check">
            <input type="radio" name="audience" value="friends" defaultChecked={current === "friends"} disabled={!hasProfile} />
            <span>
              My friends
              <span className="hint">Only people you are friends with. Not followers, and not the public rating.</span>
            </span>
          </label>
          <label className="check">
            <input type="radio" name="audience" value="public" defaultChecked={current === "public"} disabled={!hasProfile} />
            <span>
              Everyone
              <span className="hint">
                Shown with your name and handle, and counted in the public rating.
                {firstCheck ? " Because this would be your first public post, a moderator checks it before it appears." : ""}
              </span>
            </span>
          </label>
          {!hasProfile && (
            <p className="callout calm" style={{ marginTop: 8 }}>
              To share with friends or everyone, first <Link href="/friends/profile">set up your profile</Link>. You can save a private review now.
            </p>
          )}
        </fieldset>
        <p className="s14 muted" style={{ margin: 0 }}>
          Only the rating, your words and the visit date are shared. Nothing from your diary, goals or nutrition totals is ever attached to a review.
        </p>
        <button className="btn primary" type="submit">
          Save review
        </button>
      </form>
    </>
  );
}

export default function Page({ searchParams }: { searchParams: Promise<RawParams> }) {
  return (
    <AppShell active="friends" narrow>
      <Suspense fallback={<Loading />}>
        <ReviewForm searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
