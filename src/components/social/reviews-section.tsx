import Link from "next/link";
import { FLAGS } from "@/config/flags";
import type { RatingSummary, TargetKind } from "@/contracts/social";
import { formatAmount } from "@/lib/format";
import { getCurrentMember } from "@/server/auth/session";
import { getTargetReviews } from "@/server/social";
import { ReviewCard } from "./bits";

/** "4.3 average from 6 public ratings". Under five ratings it says so (R-S05). */
export function SummaryLine({ summary, what }: { summary: RatingSummary; what: string }) {
  if (summary.count === 0 || summary.average === null) {
    return (
      <p className="muted" data-testid="rating-summary" style={{ margin: 0 }}>
        No public ratings for this {what} yet.
      </p>
    );
  }
  return (
    <div data-testid="rating-summary">
      <p className="summary-box" style={{ margin: 0 }}>
        <span className="avg">{formatAmount(summary.average)}</span>
        <span>
          out of 5, the average of {summary.count} public {summary.count === 1 ? "rating" : "ratings"}
        </span>
      </p>
      {summary.early && (
        <p className="s14 muted" style={{ margin: "4px 0 0" }}>
          <strong>Early ratings.</strong> Fewer than five people have rated this {what}, so the average can change a lot.
        </p>
      )}
    </div>
  );
}

/**
 * Ratings and reviews of ONE restaurant or ONE dish. A restaurant's rating never
 * includes its dishes' ratings, and a dish's never includes the restaurant's.
 * Only approved public ratings count toward the average.
 */
export async function ReviewsSection({ kind, id, returnTo, recipe = false }: { kind: TargetKind; id: string; returnTo: string; recipe?: boolean }) {
  const member = await getCurrentMember();
  let data;
  try {
    data = await getTargetReviews(kind, id);
  } catch {
    return null;
  }
  const what = kind === "venue" ? "restaurant" : recipe ? "recipe" : "dish";
  const writeHref = `/review?kind=${kind}&id=${id}`;
  const showOthers = Boolean(member) || FLAGS.socialPublicEnabled;
  return (
    <section aria-labelledby="reviews-h" data-testid="reviews-section">
      <h2 className="h-sec" id="reviews-h">
        {kind === "venue" ? "Restaurant ratings and reviews" : recipe ? "Recipe ratings and reviews" : "Dish ratings and reviews"}
      </h2>
      <p className="s14 muted" style={{ marginTop: 0 }}>
        {kind === "venue"
          ? "These rate the restaurant as a whole. Each dish has its own separate ratings on its own page."
          : recipe
            ? "These rate this recipe as written, from people who cooked it. Your swaps and notes stay yours."
            : "These rate this dish only. The restaurant has its own separate ratings on its page."}
      </p>
      <div className="panel" style={{ marginTop: 8 }}>
        <SummaryLine summary={data.summary} what={what} />
      </div>
      {data.mine ? (
        <>
          <h3 className="h-sec" style={{ fontSize: 16, marginTop: 16 }}>
            Your review
          </h3>
          <ul className="feed">
            <ReviewCard review={data.mine} returnTo={returnTo} showTarget={false} />
          </ul>
          <p>
            <Link className="btn" href={writeHref} data-testid="edit-review">
              Edit your review or change who sees it
            </Link>
          </p>
        </>
      ) : (
        <p>
          <Link className="btn primary" href={member ? writeHref : `/login?next=${encodeURIComponent(writeHref)}`} data-testid="write-review">
            Rate and review this {what}
          </Link>
          {!member && <span className="s13 muted" style={{ display: "block", marginTop: 4 }}>Reviewing needs an account. A new review is private until you choose to share it.</span>}
        </p>
      )}
      {showOthers ? (
        data.reviews.length > 0 ? (
          <ul className="feed" aria-label={`Reviews of this ${what}`}>
            {data.reviews.map((r) => (
              <ReviewCard key={r.reviewId} review={r} returnTo={returnTo} showTarget={false} canReport={Boolean(member)} />
            ))}
          </ul>
        ) : (
          <p className="muted">{data.mine ? "No one else has shared a review here yet." : `No one has shared a review of this ${what} yet. Yours could be the first.`}</p>
        )
      ) : (
        data.summary.count > 0 && (
          <p className="muted">
            <Link className="link" href={`/login?next=${encodeURIComponent(returnTo)}`}>
              Sign in
            </Link>{" "}
            to read what people wrote.
          </p>
        )
      )}
    </section>
  );
}
