import Link from "next/link";
import { FLAGS } from "@/config/flags";
import { getMealReviews, getPreviewMealIndex } from "@/server/catalog/menu-preview";
import { day } from "./menu-preview";

/**
 * The founder's own private reviews of real meals (docs/60). Reviews of unverified meals are always private:
 * they can't be shared, count toward no rating and never appear in a feed. Nothing for anyone else.
 */
export async function MealReviews() {
  if (!FLAGS.realCatalogPreview) return null;
  const reviews = await getMealReviews();
  if (!reviews.length) return null;
  const index = await getPreviewMealIndex().catch(() => null);
  if (!index) return null;
  return (
    <section aria-labelledby="meal-reviews-h" data-testid="meal-reviews" style={{ marginBottom: 16 }}>
      <h2 className="h-sec" id="meal-reviews-h">
        Meals at real restaurants ({reviews.length})
      </h2>
      <p className="preview-bar" role="note">
        <span>
          <span className="pill">Unverified preview</span> Private to you. These meals aren&rsquo;t verified yet, so their reviews can&rsquo;t be shared.
        </span>
      </p>
      <ul className="mine-list">
        {reviews.map((r) => {
          const x = index.get(r.dishId);
          const label = x?.meal?.label ?? x?.builder?.label ?? "A meal no longer in the preview";
          return (
            <li key={r.dishId} data-testid="meal-review-row">
              <div>
                {x ? (
                  <Link href={`/meals/${r.dishId}?from=%2Ffriends%2Freviews`}>
                    <strong>{label}</strong>
                  </Link>
                ) : (
                  <strong>{label}</strong>
                )}
                <span className="s14 muted">
                  {x ? `${x.place.name} · ` : ""}
                  {r.rating} of 5{r.visitDate ? ` · visited ${day(r.visitDate)}` : ""}
                </span>
                {r.body && <span className="s14" style={{ whiteSpace: "pre-line" }}>{r.body}</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
