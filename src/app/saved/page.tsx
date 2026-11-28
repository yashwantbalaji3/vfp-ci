import { Suspense } from "react";
import { Fresh } from "@/components/freshness";
import Link from "next/link";
import { AppShell, Loading } from "@/components/app-shell";
import { DietChip } from "@/components/diet-chip";
import { ProteinFigure } from "@/components/labels";
import type { Eligibility } from "@/contracts/catalog";
import { hasDietChoice } from "@/domain/dietary/labels";
import { KIND_LABELS, priceBand } from "@/lib/format";
import { getCurrentMember } from "@/server/auth/session";
import { readDietPreference } from "@/server/catalog/diet";
import { listSaves } from "@/server/member/saves";
import { limitNotice } from "@/components/too-many-requests";
import { pageLimit } from "@/server/page-limit";
import { MealCard, UnverifiedBanner } from "@/components/menu-preview";
import { FLAGS } from "@/config/flags";
import type { Builder } from "@/contracts/meal-builder";
import type { PreviewMeal } from "@/contracts/menu-preview";
import { mealFit } from "@/contracts/meal-eligibility";
import { getPreviewMealIndex, getSavedMeals, type PreviewPlace } from "@/server/catalog/menu-preview";

/**
 * A saved food that no longer fits the member's dietary filter stays on the list, clearly
 * marked (docs/14). "Unknown" is never worded as suitable, and nothing is removed for them.
 */
const MISMATCH: Partial<Record<Eligibility["status"], string>> = {
  excluded: "Does not fit your dietary filter",
  needs_confirmation: "Ingredients need confirmation for your dietary filter",
  conditional: "Fits your dietary filter only with a change. Ask before ordering",
};

export const metadata = { title: "Saved" };

/** The founder's saved real meals (private preview, docs/60); empty for everyone else. */
async function savedPreviewMeals() {
  const none = { meals: [] as { dishId: string; meal: PreviewMeal | null; builder: Builder | null; place: PreviewPlace }[], slugs: new Set<string>() };
  if (!FLAGS.realCatalogPreview) return none;
  const index = await getPreviewMealIndex().catch(() => null);
  if (!index) return none;
  const ids = await getSavedMeals();
  return {
    meals: ids.flatMap((dishId) => (index.has(dishId) ? [{ dishId, ...index.get(dishId)! }] : [])),
    slugs: new Set([...index.values()].map((x) => x.place.slug)),
  };
}

async function SavedList() {
  const refused = limitNotice(await pageLimit());
  if (refused) return refused;
  const member = await getCurrentMember();
  if (!member) {
    return (
      <div className="panel">
        <p style={{ marginTop: 0 }}>Sign in to keep a private list of dishes and places.</p>
        <Link className="btn primary" href="/login?next=/saved">
          Sign in
        </Link>
      </div>
    );
  }
  const diet = await readDietPreference();
  const [saves, preview] = await Promise.all([listSaves(diet), savedPreviewMeals()]);
  const shown = saves.foods.length + saves.venues.length + saves.places.length;
  const filtered = hasDietChoice(diet);
  const mismatched = filtered ? saves.foods.filter((f) => MISMATCH[f.eligibility.status]).length : 0;
  // Saved real meals stay reachable even when they no longer fit the diet; each says why (docs/63).
  const realMismatch = filtered ? preview.meals.filter((x) => x.meal && mealFit(x.meal.evidence, diet).status !== "eligible").length : 0;
  if (saves.total === 0 && preview.meals.length === 0) {
    return (
      <div className="panel" data-testid="saved-empty">
        <p style={{ marginTop: 0 }}>Nothing saved yet. Press Save on any dish or place to keep it here.</p>
        <Link className="btn primary" href="/discover">
          Find dishes and places
        </Link>
      </div>
    );
  }
  return (
    <>
      <div className="row">
        <DietChip diet={diet} returnTo="/saved" />
      </div>
      {mismatched > 0 && (
        <p className="callout" role="note" data-testid="saved-mismatch-summary">
          {mismatched} saved {mismatched === 1 ? "food does" : "foods do"} not clearly fit your dietary filter. {mismatched === 1 ? "It stays" : "They stay"} here, marked, until you
          remove {mismatched === 1 ? "it" : "them"}.
        </p>
      )}
      {preview.meals.length > 0 && (
        <section aria-labelledby="saved-meals" data-testid="saved-meals">
          <h2 className="h-sec" id="saved-meals">
            Meals at real restaurants
          </h2>
          <UnverifiedBanner />
          {realMismatch > 0 && (
            <p className="callout" role="note" data-testid="saved-meal-mismatch">
              {realMismatch} saved {realMismatch === 1 ? "meal doesn't" : "meals don't"} clearly fit your diet now. {realMismatch === 1 ? "It stays" : "They stay"} here, marked
              with the reason, until you remove {realMismatch === 1 ? "it" : "them"}.
            </p>
          )}
          <ul className="cards">
            {preview.meals.map((x) =>
              x.meal ? (
                <MealCard key={x.dishId} m={x.meal} placeName={x.place.name} placeSlug={x.place.slug} from="/saved" fit={mealFit(x.meal.evidence, diet)} />
              ) : (
                <li key={x.dishId} className="mcard" data-testid="preview-meal">
                  <div className="ptile ok">
                    <span className="v">{x.builder!.parts.length}</span>
                    <span className="u">choices</span>
                    <span className="b">Build your own</span>
                  </div>
                  <div className="body">
                    <h3 data-testid="preview-meal-name">
                      <Link href={`/meals/${x.dishId}?from=%2Fsaved`}>{x.builder!.label}</Link>
                    </h3>
                    <p className="meta">{x.place.name}</p>
                  </div>
                </li>
              ),
            )}
          </ul>
          {preview.meals.filter((x) => x.meal && !x.meal.excluded).length > 1 && (
            <p style={{ margin: "8px 0 0" }}>
              <Link
                className="btn"
                href={`/protein/meals?compare=${preview.meals
                  .filter((x) => x.meal && !x.meal.excluded)
                  .slice(0, 3)
                  .map((x) => x.dishId)
                  .join(",")}#compare`}
                data-testid="saved-meals-compare"
              >
                Compare their protein
              </Link>
            </p>
          )}
        </section>
      )}
      {saves.foods.length > 0 && (
        <>
          <h2 className="h-sec" id="saved-foods">
            Food
          </h2>
          {saves.foods.length > 1 && (
            <p style={{ margin: "0 0 8px" }}>
              <Link className="btn" href={`/protein?compare=${saves.foods.slice(0, 3).map((f) => f.foodItemId).join(",")}`} data-testid="saved-compare">
                Compare protein of {saves.foods.length > 3 ? "the 3 newest" : saves.foods.length === 2 ? "both" : "all 3"}
              </Link>
            </p>
          )}
          <ul className="rank" aria-labelledby="saved-foods">
            {saves.foods.map((f) => (
              <li key={f.saveId} data-testid="saved-food">
                <span aria-hidden="true" />
                <div>
                  <Link className="name link" href={`/foods/${f.foodItemId}`}>
                    {f.name}
                  </Link>
                  <div className="s14 muted">{f.venue ? [f.venue.name, f.venue.neighborhood].filter(Boolean).join(" · ") : KIND_LABELS[f.kind]}</div>
                  <ProteinFigure protein={f.protein} />
                  <Fresh food={f.foodItemId} block />
                  {filtered && MISMATCH[f.eligibility.status] && (
                    <p className="field-error s14" data-testid="saved-mismatch" data-status={f.eligibility.status} style={{ margin: "4px 0 0" }}>
                      <strong>{MISMATCH[f.eligibility.status]}.</strong>
                    </p>
                  )}
                  <div className="row" style={{ marginTop: 6 }}>
                    <Link className="link-btn" href={`/diary/log?food=${f.foodItemId}`} data-testid="saved-log">
                      Log this<span className="sr-only"> ({f.name}) in your diary</span>
                    </Link>
                    <Link className="link-btn" href={`/protein?compare=${f.foodItemId}`}>
                      Compare protein<span className="sr-only"> of {f.name}</span>
                    </Link>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {saves.venues.length > 0 && (
        <>
          <h2 className="h-sec" id="saved-places">
            Places
          </h2>
          <ul className="rank" aria-labelledby="saved-places">
            {saves.venues.map((v) => (
              <li key={v.saveId} data-testid="saved-venue">
                <span aria-hidden="true" />
                <div>
                  <Link className="name link" href={`/venues/${v.id}`}>
                    {v.name}
                  </Link>
                  <div className="s14 muted">{[v.neighborhood, v.locality, priceBand(v.priceBand)].filter(Boolean).join(" · ")}</div>
                  <Fresh venue={v.id} block />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {saves.places.length > 0 && (
        <>
          <h2 className="h-sec" id="saved-real-places">
            Restaurants and cafés
          </h2>
          <ul className="rank" aria-labelledby="saved-real-places">
            {saves.places.map((v) => (
              <li key={v.saveId} data-testid="saved-place">
                <span aria-hidden="true" />
                <div>
                  <Link className="name link" href={`/places/${v.slug}`}>
                    {v.name}
                  </Link>
                  <div className="s14 muted">{[v.category, v.area, v.street].filter(Boolean).join(" · ")}</div>
                  <span className="badge wait s13">{preview.slugs.has(v.slug) ? "Menu: unverified preview" : "Menu not checked yet"}</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {saves.total > shown && (
        <p className="s14 muted">
          {saves.total - shown} saved {saves.total - shown === 1 ? "item is" : "items are"} no longer available and {saves.total - shown === 1 ? "is" : "are"} not shown.
        </p>
      )}
    </>
  );
}

export default function SavedPage() {
  return (
    <AppShell active="saved" narrow>
      <h1 className="title">Saved</h1>
      <p className="muted">Private to you. Friends and followers can never see this list.</p>
      <Suspense fallback={<Loading />}>
        <SavedList />
      </Suspense>
    </AppShell>
  );
}
