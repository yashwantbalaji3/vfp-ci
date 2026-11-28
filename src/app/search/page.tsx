import { MealsNotOpen } from "@/components/meals-not-open";
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { SignInPrompt } from "@/components/social/bits";
import { DietFilterNav, DietScope, MealCard, MealListSkeleton, Monogram, MoreFromPlaces, UnverifiedBanner } from "@/components/menu-preview";
import { readExpand, spreadByPlace, withExpanded } from "@/contracts/meal-variety";
import { FLAGS } from "@/config/flags";
import { searchPreview } from "@/contracts/preview-search";
import { dietTabCounts } from "@/contracts/meal-eligibility";
import { hasDietChoice, describeDietChoice } from "@/domain/dietary/labels";
import { readMealLens } from "@/server/catalog/meal-lens";
import { hrefWith, type RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getBuilders, getPreviewAudience, getPreviewPlaces } from "@/server/catalog/menu-preview";

/**
 * One search across the founder's real restaurants and drafted meals (docs/61). Founder-only, like every real-menu
 * screen: a visitor is asked to sign in and any other account gets "not found". Every result is an unverified
 * draft. The person's saved diet applies by default, also to a typed or shared address (docs/63).
 */
export const metadata = { title: "Search real menus (unverified preview)", robots: { index: false, follow: false } };
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

async function Results({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next="/search">
        <p>Restaurant meals are in a small private test for now. Sign in if you are taking part.</p>
      </SignInPrompt>
    );
  }
  const places = await getPreviewPlaces();
  if (!places) return <MealsNotOpen />;
  const q = (first(sp.q) ?? "").slice(0, 120);
  const lens = await readMealLens(sp);
  const chosen = hasDietChoice(lens.choice);
  const builders = q.trim() ? (await Promise.all(places.map(async (p) => (await getBuilders(p.placeId).catch(() => [])).map((builder) => ({ builder, place: p }))))).flat() : [];
  const hit = searchPreview(places, q, lens.choice, lens.view, builders);
  const here = hrefWith("/search", sp, {});
  const unchecked = (await getPreviewAudience().catch(() => null)) === "member_beta" ? "No person has checked them yet." : "All are drafts, not confirmed by you.";
  // Each restaurant's strongest matches first (docs/64), the rest one tap away.
  const expand = readExpand(sp.more);
  const spread = spreadByPlace(hit.meals, { expand, protein: (m) => m.protein.low });
  // Suggestions come only from the data itself: the cuisines the restaurants' open data names.
  const cuisines = [...new Set(places.flatMap((p) => p.cuisines.filter((c) => c.basis !== "dataset_alternate").map((c) => c.cuisine)))].sort().slice(0, 8);

  return (
    <>
      <form action="/search" method="get" role="search" className="searchbar" style={{ marginBottom: 12 }}>
        <label htmlFor="sq" className="sr-only">
          Search real meals and restaurants
        </label>
        <input id="sq" name="q" type="search" defaultValue={q} placeholder="Meal, restaurant, cuisine or area" maxLength={120} enterKeyHint="search" data-testid="search-q" />
        {!lens.saved && lens.choice.diet !== "none" && <input type="hidden" name="diet" value={lens.choice.diet} />}
        {lens.view !== "mine" && <input type="hidden" name="fit" value={lens.view} />}
        <button className="btn primary" type="submit">
          Search
        </button>
      </form>
      <UnverifiedBanner />
      {!q.trim() ? (
        <div className="empty" data-testid="search-start">
          <h2>Search {places.length} researched restaurants</h2>
          <p>Try a dish, a restaurant or an area. Or start from a cuisine:</p>
          <nav className="chips" aria-label="Cuisines">
            {cuisines.map((c) => (
              <Link key={c} className="chip" href={`/search?q=${encodeURIComponent(c)}`}>
                {c}
              </Link>
            ))}
          </nav>
        </div>
      ) : (
        <>
          <div data-testid="search-diet" style={{ margin: "12px 0" }}>
            {!lens.saved && (
              <DietFilterNav current={lens.choice.diet === "none" ? "any" : lens.choice.diet} href={(d) => hrefWith("/search", sp, { diet: d === "any" ? undefined : d, fit: undefined })} counts={dietTabCounts(hit.allMeals)} />
            )}
            <DietScope choice={lens.choice} saved={lens.saved} view={lens.view} counts={hit.counts} href={(v) => hrefWith("/search", sp, { fit: v === "mine" ? undefined : v })} />
          </div>
          <p className="s13 muted" style={{ marginTop: 0 }}>
            {chosen
              ? `A meal fits only when the restaurant's own words cover your diet and nothing it lists is something you leave out. ${unchecked}`
              : `Diet labels are the restaurant's own words. ${unchecked}`}
          </p>
          {hit.places.length > 0 && (
            <section aria-labelledby="sr-places-h" data-testid="search-places">
              <h2 className="h-sec" id="sr-places-h">
                Restaurants ({hit.places.length})
              </h2>
              <ul className="cards">
                {hit.places.map((p) => (
                  <li key={p.slug} className="rcard" data-testid="search-place">
                    <Monogram name={p.name} />
                    <div className="body">
                      <h3>
                        <Link href={`/places/${p.slug}`}>{p.name}</Link>
                      </h3>
                      <p className="meta">{[p.area, p.cuisines.filter((c) => c.basis !== "dataset_alternate").map((c) => c.cuisine).join(", ")].filter(Boolean).join(" · ")}</p>
                      <p className="meta">
                        {p.meals.filter((m) => !m.excluded).length} meals · {p.street}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {hit.builders.length > 0 && (
            <section aria-labelledby="sr-build-h" data-testid="search-builders" style={{ marginTop: 16 }}>
              <h2 className="h-sec" id="sr-build-h">
                Build your own ({hit.builders.length})
              </h2>
              <ul className="cards">
                {hit.builders.map(({ builder, place, parts }) => (
                  <li key={builder.dishId} className="rcard" data-testid="search-builder">
                    <span className="mono" aria-hidden="true">
                      +
                    </span>
                    <div className="body">
                      <h3>
                        <Link href={`/meals/${builder.dishId}?from=${encodeURIComponent(here)}`}>{builder.label}</Link>
                      </h3>
                      <p className="meta">
                        {place.name} · {builder.parts.length} choices
                      </p>
                      {parts.length > 0 && <p className="meta">Includes: {parts.slice(0, 4).join(", ")}</p>}
                      <p className="s13 muted" style={{ margin: "2px 0 0" }}>
                        Its diet and total depend on what you pick.
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section aria-labelledby="sr-meals-h" data-testid="search-meals" style={{ marginTop: 16 }}>
            <h2 className="h-sec" id="sr-meals-h">
              Meals ({hit.meals.length}){chosen ? ` · ${lens.view === "all" ? "all diets" : lens.view === "check" ? "need confirmation" : `fit ${describeDietChoice(lens.choice).toLowerCase()}`}` : ""}
            </h2>
            {hit.meals.length > 0 ? (
              <>
                <ul className="cards">
                  {spread.shown.map((m) => (
                    <MealCard key={m.dishId} m={m} placeName={m.place.name} placeSlug={m.place.slug} from={here} fit={m.fit} />
                  ))}
                </ul>
                <MoreFromPlaces
                  held={spread.held}
                  total={spread.total}
                  expanded={expand === "all" && new Set(hit.meals.map((m) => m.place.slug)).size > 1}
                  href={(slug) => hrefWith("/search", sp, { more: withExpanded(expand, slug) })}
                  allHref={hrefWith("/search", sp, { more: "all" })}
                  lessHref={hrefWith("/search", sp, { more: undefined })}
                />
              </>
            ) : (
              <div className="empty" data-testid="search-none">
                <p>
                  {hit.counts.all > 0
                    ? `No meal matching “${q}” ${lens.view === "check" ? "needs confirmation" : `fits ${describeDietChoice(lens.choice).toLowerCase()}`}. ${hit.counts.all} ${hit.counts.all === 1 ? "meal matches" : "meals match"} the words${hit.counts.check ? `; ${hit.counts.check} need confirmation` : ""}.`
                    : `No meal matches “${q}”. Try fewer or different words.`}
                </p>
                <p className="row">
                  {hit.counts.check > 0 && lens.view !== "check" && (
                    <Link className="btn" href={hrefWith("/search", sp, { fit: "check" })} data-testid="search-open-check">
                      See {hit.counts.check} that need confirmation
                    </Link>
                  )}
                  {hit.counts.all > hit.meals.length && lens.view !== "all" && (
                    <Link className="btn" href={hrefWith("/search", sp, { fit: "all" })} data-testid="search-open-all">
                      Show all {hit.counts.all}, including ones that don&rsquo;t fit
                    </Link>
                  )}
                  <Link className="btn" href="/protein/meals">
                    Browse all meals by protein
                  </Link>
                </p>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}

export default function SearchPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  if (!FLAGS.realCatalogPreview) notFound();
  return (
    <AppShell active="discover" realPlaces>
      <p className="eyebrow">Boston area</p>
      <h1 className="title">Search real menus</h1>
      <Suspense fallback={<MealListSkeleton rows={4} />}>
        <Results searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
