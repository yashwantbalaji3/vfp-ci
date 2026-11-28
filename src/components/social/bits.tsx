import Link from "next/link";
import { reportAction } from "@/app/social/actions";
import { Fresh, FreshTarget } from "@/components/freshness";
import { Icon } from "@/components/icons";
import {
  REPORT_REASONS,
  REPORT_REASON_LABELS,
  targetHref,
  targetKindLabel,
  type Audience,
  type ListSummary,
  type Person,
  type RankingPublication,
  type Review,
  type SocialTarget,
} from "@/contracts/social";
import { formatDate } from "@/lib/format";
import type { RawParams } from "@/lib/search-params";
import { DONE, refusal } from "./messages";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** What just happened, announced politely to screen readers. */
export function Flash({ sp }: { sp: RawParams }) {
  const done = DONE[one(sp.m) ?? ""];
  const refused = one(sp.e);
  if (refused) {
    return (
      <p className="callout stop" role="alert" data-testid="flash-error">
        {refusal(refused)}
        {refused === "PROFILE_REQUIRED" && (
          <>
            {" "}
            <Link href="/friends/profile">Set up your profile</Link>
          </>
        )}
      </p>
    );
  }
  return (
    <p role="status" aria-live="polite" className={done ? "callout calm" : "sr-only"} data-testid="flash">
      {done ?? ""}
    </p>
  );
}

/** Initials stand in for a photo: profile photos are not part of this release. */
export function Avatar({ person, size = "" }: { person: Pick<Person, "displayName">; size?: "" | "lg" | "sm" }) {
  const words = person.displayName.replace(/\(.*?\)/g, "").trim().split(/\s+/).filter(Boolean);
  const initials = ((words[0]?.[0] ?? "?") + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
  return (
    <span className={`avatar ${size}`} aria-hidden="true">
      {initials}
    </span>
  );
}

export function PersonRow({ person, note }: { person: Person; note?: string }) {
  return (
    <span className="person">
      <Avatar person={person} />
      <span className="who">
        <Link href={`/u/${person.handle}`}>{person.displayName}</Link>
        <span className="handle">
          @{person.handle}
          {person.isDemo ? " · Demo account, not a real person" : ""}
          {note ? ` · ${note}` : ""}
        </span>
      </span>
    </span>
  );
}

export function Stars({ rating }: { rating: number }) {
  return (
    <span className="stars" role="img" aria-label={`Rated ${rating} out of 5`}>
      <span aria-hidden="true">
        {"★".repeat(rating)}
        {"☆".repeat(5 - rating)}
      </span>
      <span className="n" aria-hidden="true">
        {rating} / 5
      </span>
    </span>
  );
}

export const AUDIENCE_WORDS: Record<Audience, string> = { private: "Only you", friends: "Friends only", public: "Public" };

/** For the author's own posts: who can see it and whether it is waiting or removed. */
export function StateBadge({ audience, state }: { audience: Audience | "public" | "private"; state: string }) {
  if (state === "removed") return <span className="badge stop">Removed by a moderator</span>;
  if (state === "pending") return <span className="badge wait">Waiting for a moderator&rsquo;s check · not visible yet</span>;
  if (state === "draft" || audience === "private") return <span className="badge">Only you can see this</span>;
  return <span className="badge ok">{audience === "friends" ? "Shared with friends only" : "Public"}</span>;
}

export function DietNote({ target }: { target: SocialTarget | null }) {
  const status = target?.eligibility?.status;
  if (status === "needs_confirmation") {
    return (
      <span className="conf ask">
        <Icon name="ask" className="" />
        Not confirmed for your filter
      </span>
    );
  }
  if (status === "conditional") {
    return (
      <span className="conf ask">
        <Icon name="ask" className="" />
        Fits only with a change. Ask when ordering
      </span>
    );
  }
  return null;
}

export function TargetLine({ target }: { target: SocialTarget }) {
  return (
    <p className="about">
      <span className="kind">{targetKindLabel(target.kind)}</span>
      <br />
      <Link href={targetHref(target)}>{target.name}</Link>
      {target.venueName && target.venueId && (
        <span className="muted" style={{ fontWeight: 400 }}>
          {" "}
          at <Link href={`/venues/${target.venueId}`}>{target.venueName}</Link>
        </span>
      )}
      {target.kind === "venue" && target.neighborhood && (
        <span className="muted" style={{ fontWeight: 400 }}>
          {" "}
          · {target.neighborhood}
        </span>
      )}
      <FreshTarget target={target} />
    </p>
  );
}

export function ReportForm({ type, id, handle, returnTo }: { type: "review" | "list" | "ranking" | "profile"; id?: string; handle?: string; returnTo: string }) {
  const key = id ?? handle ?? "x";
  return (
    <details className="sheet">
      <summary>Report</summary>
      <form action={reportAction} className="sheet-body stack">
        <input type="hidden" name="return" value={returnTo} />
        <input type="hidden" name="type" value={type} />
        {id && <input type="hidden" name="id" value={id} />}
        {handle && <input type="hidden" name="handle" value={handle} />}
        <div>
          <label htmlFor={`rr-${key}`}>What is wrong?</label>
          <select id={`rr-${key}`} name="reason" defaultValue="spam">
            {REPORT_REASONS.map((r) => (
              <option key={r} value={r}>
                {REPORT_REASON_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`rd-${key}`}>Anything to add? (optional)</label>
          <textarea id={`rd-${key}`} name="details" maxLength={500} rows={2} />
        </div>
        <p className="s13 muted" style={{ margin: 0 }}>
          A moderator reads every report. The person is not told who sent it.
        </p>
        <button className="btn" type="submit">
          Send report
        </button>
      </form>
    </details>
  );
}

/**
 * One review. Text is rendered as plain text by React, so anything a person types
 * (including HTML) shows as the characters they typed and never runs.
 */
export function ReviewCard({ review, returnTo, showTarget = true, canReport = false }: { review: Review; returnTo: string; showTarget?: boolean; canReport?: boolean }) {
  return (
    <li className="post" data-testid="review">
      <div className="head">
        {review.author ? <PersonRow person={review.author} /> : <span className="muted">You</span>}
        <Stars rating={review.rating} />
      </div>
      {showTarget && review.target && <TargetLine target={review.target} />}
      {review.body && <p className="text">{review.body}</p>}
      <div className="foot">
        {review.isMine && <StateBadge audience={review.audience} state={review.state} />}
        {!review.isMine && review.audience === "friends" && <span className="badge">Shared with friends only</span>}
        <DietNote target={review.target} />
        {review.visitDate && <span>Visited {formatDate(review.visitDate)}</span>}
        {review.publishedAt && <span>Posted {formatDate(review.publishedAt)}</span>}
        {review.edited && <span>Edited</span>}
        {review.target?.isDemo && <span>Demo place</span>}
      </div>
      {canReport && !review.isMine && <ReportForm type="review" id={review.reviewId} returnTo={returnTo} />}
    </li>
  );
}

export function ListCard({ list, href }: { list: ListSummary; href?: string }) {
  return (
    <li className="post" data-testid="list-card">
      <p className="kind" style={{ margin: 0 }}>
        {list.isEditorial ? "Editorial collection · chosen by our team" : "List"}
      </p>
      <p className="about" style={{ marginTop: 2 }}>
        <Link href={href ?? `/lists/${list.listId}`}>{list.title}</Link>
      </p>
      {list.description && <p className="text s14">{list.description}</p>}
      <div className="foot">
        <span>
          {list.itemCount} {list.itemCount === 1 ? "item" : "items"}
        </span>
        {list.owner && !list.isMine && <span>by {list.owner.displayName}</span>}
        {list.owner?.isDemo && <span>Demo content</span>}
        {list.isMine && <StateBadge audience={list.visibility} state={list.state} />}
      </div>
    </li>
  );
}

export function RankingCard({ ranking, heading = true }: { ranking: RankingPublication; heading?: boolean }) {
  return (
    <div className="post" data-testid="ranking-card">
      {heading && ranking.owner && (
        <div className="head">
          <PersonRow person={ranking.owner} />
          <span className="badge">Restaurant ranking</span>
        </div>
      )}
      <ol className="order" style={{ marginTop: heading ? 8 : 0 }}>
        {ranking.entries.map((e, i) => (
          <li key={e.venueId}>
            <span className="pos">{i + 1}</span>
            <span className="name">
              <Link href={`/venues/${e.venueId}`}>{e.name}</Link>
              {e.neighborhood && <span className="muted s14" style={{ fontWeight: 400 }}> · {e.neighborhood}</span>}
              <Fresh venue={e.venueId} />
            </span>
          </li>
        ))}
      </ol>
      <p className="s13 muted" style={{ margin: "8px 0 0" }}>
        A personal order, published {formatDate(ranking.publishedAt)}. It is not a star rating.
      </p>
    </div>
  );
}

export const SOCIAL_SECTIONS = [
  { key: "feed", href: "/friends", label: "Feed" },
  { key: "people", href: "/friends/people", label: "People" },
  { key: "reviews", href: "/friends/reviews", label: "Reviews" },
  { key: "ranking", href: "/friends/ranking", label: "Ranking" },
  { key: "lists", href: "/friends/lists", label: "Lists" },
  { key: "profile", href: "/friends/profile", label: "Profile" },
] as const;
export type SocialSection = (typeof SOCIAL_SECTIONS)[number]["key"];

export function SocialNav({ active, requests = 0 }: { active: SocialSection; requests?: number }) {
  return (
    <nav className="subnav chips scroll" aria-label="Friends and lists">
      {SOCIAL_SECTIONS.map((s) => (
        <Link key={s.key} className="chip" href={s.href} aria-current={s.key === active ? "true" : undefined}>
          {s.label}
          {s.key === "people" && requests > 0 ? ` (${requests} new)` : ""}
        </Link>
      ))}
    </nav>
  );
}

export function SignInPrompt({ next, children }: { next: string; children: React.ReactNode }) {
  return (
    <div className="empty" data-testid="social-signin">
      {children}
      <p>
        <Link className="btn primary" href={`/login?next=${encodeURIComponent(next)}`}>
          Sign in
        </Link>
      </p>
    </div>
  );
}

export function PrivacyPromise() {
  return (
    <p className="s14 muted">
      Your diary, goals, own foods, meal plans and cooking are never shared here. Friends and followers see only what you choose to post.
    </p>
  );
}
