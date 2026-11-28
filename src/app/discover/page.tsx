import { Suspense } from "react";
import { HOODS, hoodRank, inHood } from "@/contracts/neighbourhoods";
import { spreadByPlace } from "@/contracts/meal-variety";
import Link from "next/link";
import { AppShell, Loading } from "@/components/app-shell";
import { DietChip } from "@/components/diet-chip";
import { DishCard } from "@/components/dish-card";
import { Icon } from "@/components/icons";
import { DEFAULT_MARKET, MARKETS, type MarketConfig } from "@/config/markets";
import { readMarket } from "@/server/market";
import { describeDietChoice, hasDietChoice, hiddenReasonText } from "@/domain/dietary/labels";
import { priceBand, titleCase } from "@/lib/format";
import { PAGE_SIZE, hrefWith, parseDiscoverParams, type RawParams } from "@/lib/search-params";
import { getFilterOptions, searchCatalog } from "@/server/catalog";
import { readDietPreference } from "@/server/catalog/diet";
import { NearMe } from "./near-me";
import { limitNotice } from "@/components/too-many-requests";
import { pageLimit } from "@/server/page-limit";
import { DietWelcome } from "@/components/diet-welcome";
import { FLAGS } from "@/config/flags";
import { getMapAreas } from "@/server/catalog/map";
import { getCurrentMember } from "@/server/auth/session";
import { streetFile } from "@/server/map-tiles";
import { DiscoverViews } from "./discover-views";
import { getPlaceDirectory } from "@/server/catalog/places";
import { getPreviewPlaces } from "@/server/catalog/menu-preview";
import { MealCard, Monogram, UnverifiedBanner } from "@/components/menu-preview";
import { byProtein } from "@/contracts/menu-preview";
import { applyLens, mealLens } from "@/contracts/meal-eligibility";
import { searchPreview } from "@/contracts/preview-search";
import type { DietPreference } from "@/contracts/catalog";

/**
 * Demo-to-real transition (docs/37). With REAL_DISCOVERY on and demo content off, Discover leads with
 * how many real places this visitor may see and their areas (the database decides: the founder's private preview while the
 * real-place lock is off). They are identity only, so they stay out of the dish results and filters.
 */
/**
 * The founder-only private beta on real data (docs/59): real restaurants' drafted meals, highest protein
 * first, that fit the founder's saved diet by the shared check (docs/63). Nothing for anyone else.
 */
async function RealMenusPreview({ diet }: { diet: DietPreference }) {
  const places = await getPreviewPlaces().catch(() => null);
  if (!places || places.length === 0) return null;
  const lens = mealLens(diet, undefined, undefined);
  const chosen = hasDietChoice(diet);
  const name = describeDietChoice(diet).toLowerCase();
  const { shown: meals, counts } = applyLens(places.flatMap((p) => p.meals.map((m) => ({ ...m, place: p }))), lens);
  // A few restaurants, not one (docs/64): each restaurant's strongest meal first, a second only to fill the row.
  const ranked = [...meals].sort(byProtein);
  // The same dish at two branches of one restaurant is shown once here (its page lists both branches).
  const seenDish = new Set<string>();
  const distinct = ranked.filter((m) => {
    const key = `${m.label.toLowerCase()}|${m.place.name.replace(/\s*\(.*\)\s*$/, "").toLowerCase()}`;
    if (seenDish.has(key)) return false;
    seenDish.add(key);
    return true;
  });
  const one = spreadByPlace(distinct, { perPlace: 1 }).shown;
  const top = (one.length >= 6 ? one : spreadByPlace(distinct, { perPlace: 2 }).shown).slice(0, 6);
  const withMeals = new Set(meals.map((m) => m.place.slug)).size;
  const hoods = HOODS.map((h) => ({ h, n: meals.filter((m) => inHood(m.place, h)).length })).filter((x) => x.n > 0);
  // Restaurants with researched menus, most fitting meals first, so a person sees the variety at a glance.
  const byPlace = places
    .map((p) => ({ p, n: meals.filter((m) => m.place.slug === p.slug).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.p.name.localeCompare(b.p.name));
  return (
    <>
      <section aria-labelledby="real-menus-h" data-testid="real-menus" className="disc-sec">
        <div className="sec-head">
          <h2 className="h-sec" id="real-menus-h">
            {chosen ? `${titleCase(name)} meals` : "Meals"} in the Boston area
          </h2>
          <Link className="link s14" href="/protein/meals" data-testid="real-menus-meals">
            See all {meals.length}
          </Link>
        </div>
        {hoods.length > 0 && (
          <nav className="chips scroll" aria-label="Meals by neighbourhood" data-testid="real-menus-hoods">
            {hoods.map(({ h, n }) => (
              <Link key={h.key} className="chip" href={`/protein/meals?hood=${h.key}`}>
                Meals in {h.label} <span className="count">{n}</span>
              </Link>
            ))}
          </nav>
        )}
        <UnverifiedBanner>
          <p className="s13" style={{ margin: 0 }} data-testid="real-menus-counts">
            {plural(meals.length, "meal", "meals")} at {plural(withMeals, "restaurant", "restaurants")}
            {chosen ? ` fit ${name} by the restaurant\u2019s own words` : ""}
            {chosen && counts.check > 0 ? `; ${counts.check} more need a check and are kept apart` : ""}.
          </p>
        </UnverifiedBanner>
        {top.length > 0 ? (
          <ul className="cards" data-testid="real-menus-top">
            {top.map((m) => (
              <MealCard key={m.dishId} m={m} placeName={m.place.name} placeSlug={m.place.slug} from="/discover" fit={m.fit} />
            ))}
          </ul>
        ) : (
          <div className="empty">
            <p>No researched restaurant&rsquo;s complete meal fits {name} by its own words. You can still browse every meal.</p>
          </div>
        )}
      </section>
      {byPlace.length > 0 && (
        <section aria-labelledby="menu-places-h" data-testid="menu-places" className="disc-sec">
          <div className="sec-head">
            <h2 className="h-sec" id="menu-places-h">
              Restaurants with researched menus
            </h2>
            <Link className="link s14" href="/places/menus" data-testid="real-menus-places">
              See all {byPlace.length}
            </Link>
          </div>
          <ul className="hstrip" data-testid="menu-places-strip">
            {byPlace.slice(0, 10).map(({ p, n }) => (
              <li key={p.listingId} className="pcard" data-testid="menu-place">
                <Monogram name={p.name} cuisine={p.cuisines.find((c) => c.basis === "dataset_primary")?.cuisine} size={40} />
                <div className="body">
                  <h3>
                    <Link href={`/places/${p.slug}`}>{p.name}</Link>
                  </h3>
                  <p className="meta">{p.street}</p>
                  <p className="meta">{[p.area, p.cuisines.find((c) => c.basis === "dataset_primary")?.cuisine].filter(Boolean).join(" · ")}</p>
                  <span className="dchip ok">
                    {plural(n, "meal", "meals")}
                    {chosen ? ` fit ${name}` : ""}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <nav className="chips scroll" aria-label="More ways to browse real menus" style={{ marginTop: 8 }}>
            <Link className="chip" href="/search" data-testid="real-menus-search">
              Search real menus
            </Link>
            <Link className="chip" href="/places/menus?view=map" data-testid="real-menus-map">
              On a map
            </Link>
          </nav>
        </section>
      )}
    </>
  );
}

/** For the founder, a search on Discover also looks through the real menus first (docs/61). */
async function RealSearchTeaser({ q, diet }: { q: string; diet: DietPreference }) {
  const places = await getPreviewPlaces().catch(() => null);
  if (!places || places.length === 0) return null;
  const hit = searchPreview(places, q, diet, "mine");
  const chosen = hasDietChoice(diet);
  const more = `/search?q=${encodeURIComponent(q)}`;
  return (
    <section aria-labelledby="real-search-h" data-testid="real-search" style={{ marginBottom: 16 }}>
      <h2 className="h-sec" id="real-search-h">
        Real menus: {plural(hit.meals.length, "meal", "meals")} and {plural(hit.places.length, "restaurant", "restaurants")} match
      </h2>
      <p className="s13 muted" style={{ margin: "0 0 8px" }}>
        <span className="pill">Unverified preview</span>{" "}
        {chosen ? `${hit.counts.mine} fit your diet (${describeDietChoice(diet).toLowerCase()}); ${hit.counts.check} need confirmation; ${hit.counts.all - hit.counts.mine - hit.counts.check} don't fit.` : "Diet labels are the restaurant's own words."}
      </p>
      {hit.meals.length > 0 ? (
        <ul className="cards">
          {spreadByPlace(hit.meals, { perPlace: 1 }).shown.slice(0, 3).map((m) => (
            <MealCard key={m.dishId} m={m} placeName={m.place.name} placeSlug={m.place.slug} from={`/discover?q=${encodeURIComponent(q)}`} fit={m.fit} />
          ))}
        </ul>
      ) : null}
      <p style={{ margin: "8px 0 0" }}>
        <Link className="btn" href={more} data-testid="real-search-all">
          {hit.meals.length + hit.places.length > 0 ? "See all real-menu results" : "Search real menus"}
        </Link>
      </p>
    </section>
  );
}

async function RealPlacesFirst() {
  let dir = null;
  try {
    dir = await getPlaceDirectory({ limit: 1 });
  } catch {
    return (
      <p className="callout stop" role="alert" data-testid="real-first-error">
        <strong>We couldn&rsquo;t load restaurants just now.</strong> <Link href="/discover">Try again</Link>
      </p>
    );
  }
  if (dir.total === 0) {
    return (
      <section className="panel" aria-labelledby="real-first-heading" data-testid="real-first">
        <h2 className="h-sec" id="real-first-heading" style={{ marginTop: 0 }}>
          Restaurants and cafés
        </h2>
        <p className="muted" data-testid="real-first-none">
          We&rsquo;re checking real {market.name} restaurants and their menus, and none is listed yet. Meanwhile, try{" "}
          <Link href="/cook">a recipe</Link> or <Link href="/protein">the Protein Explorer</Link>.
        </p>
      </section>
    );
  }
  return (
    <section aria-labelledby="real-first-heading" data-testid="real-first" className="disc-sec directory">
      <h2 className="h-sec" id="real-first-heading">
        {plural(dir.total, "restaurant or café", "restaurants and cafés")} in the directory
      </h2>
      <p className="s14 muted" style={{ margin: "0 0 10px" }} data-testid="real-first-preview">
        Name, address and area from free public datasets. Their menus aren&rsquo;t checked yet, so a place is never called vegetarian or
        vegan from its category.
      </p>
      {dir.areas.length > 0 && (
        <>
          <h3 className="sr-only" id="real-first-areas">
            Browse by area
          </h3>
          <ul className="chips scroll" aria-labelledby="real-first-areas" data-testid="real-first-areas" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {priorityFirst(dir.areas).slice(0, 10).map((a, _, all) => (
              <li key={a.area}>
                <Link className="chip area-chip" href={`/places?area=${encodeURIComponent(a.area)}`}>
                  {shortArea(a.area, all.map((x) => x.area))} <span className="count">{a.count}</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
      <nav className="row" aria-label="All restaurants and cafés" style={{ marginTop: 10 }}>
        <Link className="btn" href="/places" data-testid="real-first-list">
          See all as a list
        </Link>
        <Link className="btn" href="/places?view=map" data-testid="real-first-map">
          See them on a map
        </Link>
      </nav>
    </section>
  );
}

/**
 * The owner's priority neighbourhoods first, in the same order as the meal shortcuts (HOODS), then the other areas
 * by size (owner directive 27 Nov 2026: Boston first; the charter's twelve areas since 28 Nov 2026).
 */
function priorityFirst<T extends { area: string; count: number }>(areas: T[]): T[] {
  return [...areas].sort((a, b) => hoodRank(a.area) - hoodRank(b.area) || b.count - a.count || a.area.localeCompare(b.area));
}

/** "Cambridge (Central, Harvard, Kendall)" is long for a chip; the part before the brackets is enough, the full name stays for screen readers. */
function shortArea(area: string, all: string[] = []) {
  const cut = (a: string) => a.replace(/\s*\(.*\)\s*$/, "").split(" / ")[0];
  // Two areas that would shorten to the same word keep their full names.
  const short = all.filter((a) => cut(a) === cut(area)).length > 1 ? area : cut(area);
  return short === area ? area : (
    <>
      <span aria-hidden="true">{short}</span>
      <span className="sr-only">{area}</span>
    </>
  );
}

/** The founder's way into the private real-place preview (docs/32). Nobody else sees it. */
async function realPlacesPreview(signedIn: boolean): Promise<number | null> {
  if (!FLAGS.realCatalogPreview || !signedIn) return null;
  try {
    const dir = await getPlaceDirectory({ limit: 1 });
    return dir.preview || dir.total > 0 ? dir.total : null;
  } catch {
    return null;
  }
}

export const metadata = { title: "Discover" };
const market = MARKETS[DEFAULT_MARKET] ?? MARKETS.boston;
const SORT_WORDS: Record<string, string> = {
  distance: "Nearest first",
  relevance: "Best text match first, then most recently checked",
  freshness: "Most recently checked first",
  protein: "Most protein first",
};
const plural = (n: number, one: string, many = `${one}es`) => `${n} ${n === 1 ? one : many}`;

async function Results({ searchParams }: { searchParams: Promise<RawParams> }) {
  const refused = limitNotice(await pageLimit());
  if (refused) return refused;
  const chosen = await readMarket();
  if (chosen.discovery === "coming")
    return (
      <>
        <div className="chips">
          <MarketLine m={chosen} />
        </div>
        <ComingMarket m={chosen} />
      </>
    );
  const sp = await searchParams;
  const filters = parseDiscoverParams(sp);
  const diet = await readDietPreference();
  let result, options;
  const [areas, member, street] = FLAGS.mapEnabled ? await Promise.all([getMapAreas(), getCurrentMember(), streetFile()]) : [[], FLAGS.realCatalogPreview || FLAGS.realDiscovery ? await getCurrentMember() : null, null];
  const realPlaces = FLAGS.realDiscovery ? null : await realPlacesPreview(member !== null);
  try {
    [result, options] = await Promise.all([searchCatalog(filters, diet), getFilterOptions()]);
  } catch {
    return (
      <div className="callout stop" role="alert">
        <strong>We couldn&rsquo;t load dishes just now.</strong> Nothing is wrong on your side.{" "}
        <Link href={hrefWith("/discover", sp, {})}>Try again</Link>
      </div>
    );
  }
  const strict = hasDietChoice(diet);
  const inNeeds = filters.view === "needs_confirmation";
  const activeFilters =
    Number(Boolean(filters.neighborhood)) + Number(Boolean(filters.cuisine)) + Number(Boolean(filters.maxPriceBand)) +
    Number(Boolean(filters.minProtein)) + Number(Boolean(filters.venueType)) + Number(filters.includeEstimates) +
    Number(filters.openNow);
  const returnTo = hrefWith("/discover", sp, { offset: null });
  const shownCount = inNeeds ? result.counts.needsConfirmation : result.counts.matches;
  // Real mode with no checked dishes at all: the dish list and its map would only say "0 dishes" under the real
  // meals and places, which reads as a contradiction (docs/62), so the section is left out until there are some.
  const noCheckedDishes = FLAGS.realDiscovery && result.counts.matches + result.counts.needsConfirmation === 0 && !filters.q && activeFilters === 0;

  const listResults = (
    <>
      <h2 className="h-sec" id="results-heading" data-testid="results-heading">
        {inNeeds ? `${plural(shownCount, "dish")} need confirmation` : strict ? `${plural(shownCount, "confirmed match")}` : plural(shownCount, "dish")}
      </h2>
      <p className="s14 muted" style={{ margin: "0 0 12px" }}>
        {strict ? `Filter: ${describeDietChoice(diet)}. ` : ""}
        {SORT_WORDS[result.applied.sort] ?? "Sorted by most recently checked"}.{FLAGS.mapEnabled ? "" : " Map view comes later; this list is the complete result."}
      </p>

      {strict && (
        <nav className="seg" aria-label="Result groups" style={{ marginBottom: 12 }}>
          <Link href={hrefWith("/discover", sp, { view: null, offset: null })} aria-current={!inNeeds ? "true" : undefined}>
            Confirmed ({result.counts.matches})
          </Link>
          <Link href={hrefWith("/discover", sp, { view: "needs_confirmation", offset: null })} aria-current={inNeeds ? "true" : undefined}>
            Needs confirmation ({result.counts.needsConfirmation})
          </Link>
        </nav>
      )}

      {inNeeds && (
        <p className="callout" data-testid="needs-note">
          <strong>Not confirmed.</strong> These dishes have an ingredient nobody has confirmed for your filter. They are not matches.
          Ask the restaurant before ordering.
        </p>
      )}

      {result.items.length > 0 ? (
        <ul className={`cards ${filters.offset === 0 && !inNeeds ? "feature" : ""}`} aria-labelledby="results-heading" style={{ marginTop: 12 }}>
          {result.items.map((item) => (
            <DishCard key={item.foodItemId} item={item} diet={diet} />
          ))}
        </ul>
      ) : (
        <div className="panel" data-testid="empty-state">
          <p style={{ marginTop: 0 }}>
            <strong>
              {FLAGS.realDiscovery && result.counts.matches + result.counts.needsConfirmation === 0 && !filters.q && activeFilters === 0
                ? "No dishes are checked yet."
                : inNeeds ? "Nothing is waiting for confirmation." : strict ? "No confirmed matches for this search." : "No dishes match this search."}
            </strong>
          </p>
          <p className="muted">
            {filters.q || activeFilters > 0 ? "Try fewer filters or a different word. " : ""}
            We only list food in the {market.name} for now, and we never fill gaps with guesses.
          </p>
          {(filters.q || activeFilters > 0) && (
            <Link className="btn" href="/discover">
              Clear search and filters
            </Link>
          )}
        </div>
      )}

      {(filters.offset > 0 || result.nextOffset !== null) && (
        <nav className="row" aria-label="Pages" style={{ marginTop: 16 }}>
          {filters.offset > 0 && (
            <Link className="btn" href={hrefWith("/discover", sp, { offset: Math.max(0, filters.offset - PAGE_SIZE) || null })}>
              Previous
            </Link>
          )}
          {result.nextOffset !== null && (
            <Link className="btn" href={hrefWith("/discover", sp, { offset: result.nextOffset })}>
              More dishes
            </Link>
          )}
        </nav>
      )}

      {strict && !inNeeds && result.counts.needsConfirmation > 0 && (
        <p className="callout" style={{ marginTop: 16 }} data-testid="needs-reveal">
          {plural(result.counts.needsConfirmation, "more dish")} {result.counts.needsConfirmation === 1 ? "has" : "have"} an unconfirmed
          ingredient, so {result.counts.needsConfirmation === 1 ? "it is" : "they are"} kept out of your matches.{" "}
          <Link href={hrefWith("/discover", sp, { view: "needs_confirmation", offset: null })}>Needs confirmation · Show</Link>
        </p>
      )}
      {strict && result.counts.hidden > 0 && (
        <p className="s14 muted" style={{ marginTop: 12 }} data-testid="hidden-note">
          Always hidden for your filter: {result.hiddenReasons.map((r) => hiddenReasonText(r.code, r.family, r.count)).join(", ")}.
        </p>
      )}
      {filters.openNow && result.openNowLeftOut && result.openNowLeftOut.placesNeedConfirmation > 0 && (
        <p className="s14 muted" style={{ marginTop: 12 }} data-testid="open-now-left-out">
          Open now: {plural(result.openNowLeftOut.placesNeedConfirmation, "place")} left out because{" "}
          {result.openNowLeftOut.placesNeedConfirmation === 1 ? "its" : "their"} opening hours need confirmation.
        </p>
      )}
      {filters.minProtein && result.counts.notComparable > 0 && (
        <p className="s14 muted" style={{ marginTop: 12 }}>
          {plural(result.counts.notComparable, "dish")} left out of the protein filter because protein per serving isn&rsquo;t available for{" "}
          {result.counts.notComparable === 1 ? "it" : "them"}.
        </p>
      )}
    </>
  );

  return (
    <>
      <div className="stack">
        <div className="chips">
          <MarketLine m={chosen} />
          <DietChip diet={diet} returnTo={returnTo} />
        </div>
        <form id="discover-filters" action="/discover" method="get" role="search" className="stack">
          <div className="searchbar">
            <label htmlFor="q" className="sr-only">
              Search dishes and places
            </label>
            <input id="q" name="q" type="search" defaultValue={filters.q ?? ""} placeholder="Dish, restaurant or cuisine" maxLength={120} enterKeyHint="search" />
            <button className="btn primary" type="submit">
              Search
            </button>
          </div>
          {/* Real mode with nothing in the checked-dish catalogue: these filters would change nothing on the page, so they wait. */}
          {!noCheckedDishes && (
          <details className="sheet" open={activeFilters > 0}>
            <summary>
              <Icon name="filter" />
              Filters{activeFilters > 0 ? ` (${activeFilters} on)` : ""}
            </summary>
            <div className="sheet-body">
              <div className="field-grid">
                <div>
                  <label htmlFor="hood">Neighbourhood</label>
                  <select id="hood" name="hood" defaultValue={filters.neighborhood ?? ""}>
                    <option value="">All of the {market.name}</option>
                    {options.neighborhoods.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="cuisine">Cuisine</label>
                  <select id="cuisine" name="cuisine" defaultValue={filters.cuisine ?? ""}>
                    <option value="">Any cuisine</option>
                    {options.cuisines.map((c) => (
                      <option key={c} value={c}>
                        {titleCase(c)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="price">Price</label>
                  <select id="price" name="price" defaultValue={filters.maxPriceBand ? String(filters.maxPriceBand) : ""}>
                    <option value="">Any price</option>
                    {[1, 2, 3].map((b) => (
                      <option key={b} value={b}>
                        {priceBand(b)} or less
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="protein">Protein per serving</label>
                  <select id="protein" name="protein" defaultValue={filters.minProtein ? String(filters.minProtein) : ""}>
                    <option value="">Any amount</option>
                    {[10, 15, 20, 25].map((g) => (
                      <option key={g} value={g}>
                        At least {g} g
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="type">Type of place</label>
                  <select id="type" name="type" defaultValue={filters.venueType ?? ""}>
                    <option value="">Any place</option>
                    <option value="restaurant">Restaurant</option>
                    <option value="cafe">Café</option>
                    <option value="bakery">Bakery</option>
                    <option value="food_truck">Food truck</option>
                    <option value="market_stall">Market stall</option>
                  </select>
                </div>
              </div>
              <label className="check">
                <input type="checkbox" name="open" value="1" defaultChecked={filters.openNow} data-testid="open-now" />
                <span>
                  Open now
                  <span className="hint">Only places whose opening hours were checked in the last 60 days and say they are open now.</span>
                </span>
              </label>
              <label className="check">
                <input type="checkbox" name="est" value="1" defaultChecked={filters.includeEstimates} />
                <span>
                  Include estimated nutrition
                  <span className="hint">Off by default. Estimates are always labelled &ldquo;Estimated&rdquo;.</span>
                </span>
              </label>
              <div className="row">
                <button className="btn primary" type="submit">
                  Apply filters
                </button>
                {activeFilters > 0 && (
                  <Link className="link-btn" href={hrefWith("/discover", {}, { q: filters.q })}>
                    Clear filters
                  </Link>
                )}
              </div>
            </div>
          </details>
          )}
        </form>
      </div>
      {/* For the founder, real meals come before the one-time dietary question, so they're on the first screen; the
          question stays on the page until it is answered (docs/61). */}
      {/* P2 (docs/68): the diet question comes before the meals it changes; the areas are one scrolling row. */}
      {!member && <VisitorWelcome />}
      <DietWelcome returnTo={returnTo} />
      {member && FLAGS.realCatalogPreview && filters.q && <RealSearchTeaser q={filters.q} diet={diet} />}
      {member && FLAGS.realCatalogPreview && !filters.q && <RealMenusPreview diet={diet} />}
      {FLAGS.realDiscovery && <RealPlacesFirst />}
      {!FLAGS.realDiscovery && realPlaces !== null && (
        <p className="callout calm" data-testid="real-places-link">
          <Link href="/places">Real Boston-area restaurants and cafés ({realPlaces})</Link>: your private preview. Menus are not checked yet, so these places are not in the dish results or filters below.
        </p>
      )}

      {noCheckedDishes ? null : FLAGS.mapEnabled ? (
        <DiscoverViews
          diet={diet}
          view={filters.view}
          areas={areas}
          signedIn={member !== null}
          marketName={market.name}
          streetUrl={street ? "/map-data/streets" : null}
          filters={{
            q: filters.q,
            view: filters.view,
            neighborhood: filters.neighborhood,
            cuisine: filters.cuisine,
            maxPriceBand: filters.maxPriceBand,
            venueType: filters.venueType,
            minProtein: filters.minProtein,
            includeEstimates: filters.includeEstimates,
            openNow: filters.openNow,
          }}
        >
          {listResults}
        </DiscoverViews>
      ) : (
        <>
          <NearMe marketName={market.name} diet={diet} filters={{
            q: filters.q,
            view: filters.view,
            kinds: "dish",
            cuisine: filters.cuisine,
            maxPriceBand: filters.maxPriceBand,
            venueType: filters.venueType,
            minProtein: filters.minProtein,
            includeEstimates: filters.includeEstimates,
            openNow: filters.openNow,
          }} />
          {listResults}
        </>
      )}
    </>
  );
}

export default function DiscoverPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  return (
    <AppShell active="discover" realPlaces={FLAGS.realDiscovery}>
      <h1 className="title">Find something good to eat</h1>
      <Suspense fallback={<Loading label="Finding dishes…" />}>
        <Results searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}

/**
 * First visit (owner directive 24 Nov 07:19 UTC, part 3.3): what this is, what works without an account and why
 * one helps. Signed-out visitors only; nothing here is about protein goals, which stay optional.
 */
function VisitorWelcome() {
  return (
    <section className="welcome" aria-labelledby="welcome-h" data-testid="visitor-welcome">
      <h2 className="title-sm" id="welcome-h">
        Vegetarian and vegan food, made simpler
      </h2>
      <p className="s14" style={{ margin: "4px 0 10px" }}>
        Food that fits how you eat, honest nutrition if you want it, and a diary that stays private. If something isn&rsquo;t clearly
        stated, we say so instead of guessing.
      </p>
      <ul className="start-tiles">
        <li>
          <Link href="/cook">
            <Icon name="cook" />
            <span>Cook a recipe</span>
          </Link>
        </li>
        <li>
          <Link href="/protein">
            <Icon name="protein" />
            <span>Explore by protein</span>
          </Link>
        </li>
        <li>
          <Link href="/diet?return=%2Fdiscover">
            <Icon name="filter" />
            <span>Set your diet</span>
          </Link>
        </li>
      </ul>
      <p className="s13 muted" style={{ margin: "10px 0" }}>
        No account needed for any of these. A free account lets you save food, keep a diary and share with friends.
      </p>
      <Link className="btn primary" href="/login?next=%2Ftoday" data-testid="welcome-signin">
        Sign in or create an account
      </Link>
    </section>
  );
}

/** Which city Discover is showing, as a chip that changes it (docs/83). */
function MarketLine({ m }: { m: MarketConfig }) {
  return (
    <Link className="chip market-chip" href="/city?return=%2Fdiscover" data-testid="market-line">
      <Icon name="pin" />
      {m.name} ·{" "}
      <span data-testid="market-change">
        Change<span className="sr-only"> city</span>
      </span>
    </Link>
  );
}

/**
 * A city whose restaurant discovery is not open yet: said plainly, with what already works everywhere (docs/83).
 * No Boston restaurant is ever shown under another city's name.
 */
function ComingMarket({ m }: { m: MarketConfig }) {
  return (
    <section className="panel" aria-labelledby="coming-h" data-testid="market-coming">
      <h2 className="title-sm" id="coming-h" style={{ marginTop: 0 }}>
        Restaurants in the {m.name} are coming later
      </h2>
      <p>
        We&rsquo;re starting with Boston so every listing is checked properly. Until {m.city} opens, you can still{" "}
        <Link href="/cook">cook from our vegetarian recipes</Link>, <Link href="/protein">explore food by protein</Link> and keep a private
        food diary.
      </p>
      <p className="s14 muted" style={{ marginBottom: 0 }}>
        <Link href="/city?return=%2Fdiscover">Choose another city</Link>
      </p>
    </section>
  );
}
