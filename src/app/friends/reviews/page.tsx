import { Suspense } from "react";
import Link from "next/link";
import { AppShell, Loading } from "@/components/app-shell";
import { deleteReviewAction } from "@/app/social/actions";
import { Flash, ReviewCard, SignInPrompt, SocialNav } from "@/components/social/bits";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getMyProfile, getMyReviews } from "@/server/social";
import { MealReviews } from "@/components/meal-reviews";
import { FLAGS } from "@/config/flags";
import { getMealReviews } from "@/server/catalog/menu-preview";

export const metadata = { title: "My reviews" };

async function Reviews({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next="/friends/reviews">
        <p>Sign in to see the reviews you&rsquo;ve written.</p>
      </SignInPrompt>
    );
  }
  const [me, reviews, mealReviews] = await Promise.all([getMyProfile(), getMyReviews(), FLAGS.realCatalogPreview ? getMealReviews().catch(() => []) : Promise.resolve([])]);
  return (
    <>
      <SocialNav active="reviews" requests={me.incomingRequests} />
      <Flash sp={sp} />
      <p className="s14 muted">Every review starts private. You decide for each one whether friends or everyone can see it. Restaurants and dishes are rated separately.</p>
      <MealReviews />
      {reviews.length === 0 && mealReviews.length === 0 ? (
        <div className="empty" data-testid="reviews-empty">
          <h2>No reviews yet</h2>
          <p>Open a restaurant or a dish and choose &ldquo;Rate and review&rdquo;. It stays private until you decide to share it.</p>
          <p>
            <Link className="btn primary" href="/discover">
              Find something to review
            </Link>
          </p>
        </div>
      ) : reviews.length === 0 ? null : (
        <ul className="feed" data-testid="my-reviews">
          {reviews.map((r) => (
            <li key={r.reviewId} style={{ listStyle: "none" }}>
              <ul className="feed">
                <ReviewCard review={r} returnTo="/friends/reviews" />
              </ul>
              <div className="inline-forms" style={{ margin: "6px 0 10px" }}>
                {r.target && (
                  <Link className="btn small" href={`/review?kind=${r.target.kind === "venue" ? "venue" : "food"}&id=${r.target.id}&after=/friends/reviews`} aria-label={`Edit your review of ${r.target.name}`}>
                    Edit or change who sees it
                  </Link>
                )}
                <form action={deleteReviewAction}>
                  <input type="hidden" name="return" value="/friends/reviews" />
                  <input type="hidden" name="reviewId" value={r.reviewId} />
                  <button className="btn small danger" type="submit" aria-label={`Delete your review of ${r.target?.name ?? "this"}`}>
                    Delete
                  </button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export default function Page({ searchParams }: { searchParams: Promise<RawParams> }) {
  return (
    <AppShell active="friends" narrow>
      <h1 className="title">My reviews</h1>
      <Suspense fallback={<Loading />}>
        <Reviews searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
