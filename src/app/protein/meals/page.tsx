import { MealsNotOpen } from "@/components/meals-not-open";
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { Icon } from "@/components/icons";
import { Flash, SignInPrompt } from "@/components/social/bits";
import { DietFilterNav, DietScope, MealCard, MealListSkeleton, MoreFromPlaces, UnverifiedBanner } from "@/components/menu-preview";
import { readExpand, spreadByPlace, withExpanded } from "@/contracts/meal-variety";
import { HOODS, WITHIN, hoodByKey, inHood, metersBetween, miles, withinByKey } from "@/contracts/neighbourhoods";
import { applyLens, dietTabCounts, type MealFit } from "@/contracts/meal-eligibility";
import { describeDietChoice, hasDietChoice } from "@/domain/dietary/labels";
import { readMealLens } from "@/server/catalog/meal-lens";
import { FLAGS } from "@/config/flags";
import { PROTEIN_BASIS_WORDS, byProtein, proteinPer100kcal, type PreviewMeal } from "@/contracts/menu-preview";
import { hrefWith, type RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getPreviewPlaces, getSavedMeals, type PreviewPlace } from "@/server/catalog/menu-preview";
import { saveMealAction } from "./actions";

export const metadata = { title: "Restaurant meals (unverified preview)", robots: { index: false, follow: false } };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SORTS = { protein: "Protein, highest first", price: "Price, lowest first", name: "Name", near: "Nearest to the neighbourhood centre" } as const;
type Sort = keyof typeof SORTS;
const BASES = { serving: "Per serving", "100kcal": "Per 100 kcal" } as const;
type Basis = keyof typeof BASES;
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

type Row = PreviewMeal & { place: PreviewPlace };

/** The figure on the chosen basis: per 100 kcal only where the restaurant prints calories for that serving. */
function onBasis(m: PreviewMeal, basis: Basis): { low: number; high: number } | null {
  if (basis === "100kcal") return proteinPer100kcal(m);
  return m.protein.low === null || m.protein.high === null ? null : { low: m.protein.low, high: m.protein.high };
}

function Compare({ rows, basis, sp }: { rows: Row[]; basis: Basis; sp: RawParams }) {
  const scale = Math.max(1, ...rows.map((r) => onBasis(r, basis)?.high ?? 0));
  const pct = (n: number) => `${Math.max(0, Math.min(100, (n / scale) * 100)).toFixed(1)}%`;
  return (
    <section className="compare" id="compare" aria-labelledby="mcmp-h" data-testid="meal-compare">
      <h2 className="h-sec" id="mcmp-h" style={{ marginTop: 0 }}>
        Comparing {rows.length} of up to 3 meals
      </h2>
      <h3 className="s14" style={{ margin: "0 0 6px" }} id="mcmp-bars">
        Protein {BASES[basis].toLowerCase()}
      </h3>
      <ul className="cmp-bars" aria-labelledby="mcmp-bars">
        {rows.map((r) => {
          const v = onBasis(r, basis);
          const range = v && v.low !== v.high;
          return (
            <li key={r.dishId} data-testid="meal-compare-bar" data-basis={r.protein.basis}>
              <div className="cmp-bar-label">
                <span className="cmp-bar-name">
                  <Link href={`/meals/${r.dishId}?from=${encodeURIComponent(hrefWith("/protein/meals", sp, { m: undefined, e: undefined }))}`}>{r.label}</Link>{" "}
                  <span className="muted">({r.place.name})</span>
                </span>
                <span className={`cmp-bar-value ${v ? "" : "none"}`}>
                  {v
                    ? `${range ? `${fmt(v.low)}–${fmt(v.high)}` : fmt(v.low)} g · ${PROTEIN_BASIS_WORDS[r.protein.basis]}`
                    : basis === "100kcal"
                      ? r.protein.basis === "usda_range"
                        ? "Not per 100 kcal: a USDA estimate is not mixed with the restaurant's calories"
                        : "Calories or protein not printed"
                      : "Protein unknown"}
                </span>
              </div>
              {v && (
                <div className="cmp-track" aria-hidden="true">
                  {range ? (
                    <>
                      <span className="cmp-range" style={{ left: pct(v.low), width: `calc(${pct(v.high)} - ${pct(v.low)})` }} />
                      <span className="cmp-dot" style={{ left: pct((v.low + v.high) / 2) }} />
                    </>
                  ) : (
                    <span className="cmp-fill" style={{ width: pct(v.low) }} />
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="s14 muted">
        A range is drawn as a band with a dot at its middle. A USDA range is an estimate from typical amounts, not the restaurant&rsquo;s figure.
      </p>
      <nav className="seg" aria-label="Compare protein">
        {(Object.keys(BASES) as Basis[]).map((b) => (
          <Link key={b} href={hrefWith("/protein/meals", sp, { basis: b === "serving" ? undefined : b, m: undefined, e: undefined })} aria-current={basis === b ? "true" : undefined}>
            {BASES[b]}
          </Link>
        ))}
      </nav>
      <p style={{ marginTop: 8 }}>
        <Link href={hrefWith("/protein/meals", sp, { compare: undefined, m: undefined, e: undefined })} data-testid="meal-compare-clear">
          Clear comparison
        </Link>
      </p>
    </section>
  );
}

async function Meals({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next="/protein/meals">
        <p>Restaurant meals are in a small private test for now. Sign in if you are taking part.</p>
      </SignInPrompt>
    );
  }
  const [places, saved] = await Promise.all([getPreviewPlaces(), getSavedMeals()]);
  if (!places) return <MealsNotOpen />;

  const lens = await readMealLens(sp);
  const chosen = hasDietChoice(lens.choice);
  const tmp = !lens.saved && lens.choice.diet !== "none" ? lens.choice.diet : null;
  const sort: Sort = (first(sp.sort) as Sort) in SORTS ? (first(sp.sort) as Sort) : "protein";
  const basis: Basis = first(sp.basis) === "100kcal" ? "100kcal" : "serving";
  const area = first(sp.area) || "";
  const cuisine = first(sp.cuisine) || "";
  const placeSlug = first(sp.place) || "";
  const hood = hoodByKey(first(sp.hood));
  const within = hood ? withinByKey(first(sp.within)) : null;
  const away = (r: Row) => (hood ? metersBetween(r.place, hood) : null);
  const onlySaved = first(sp.saved) === "true";
  const minRaw = Number(first(sp.min));
  const min = Number.isFinite(minRaw) && minRaw > 0 && minRaw <= 200 ? minRaw : null;
  const compareIds = (first(sp.compare) ?? "").split(",").filter((x) => UUID.test(x)).slice(0, 3);
  const savedSet = new Set(saved);
  const filtersOn = [area, cuisine, placeSlug, within, onlySaved, min !== null, sort !== "protein", basis !== "serving"].filter(Boolean).length;

  const all: Row[] = places.flatMap((p) => p.meals.map((m) => ({ ...m, place: p })));
  const discoverable = all.filter((r) => !r.excluded);
  const base = discoverable.filter(
    (r) =>
      (!area || r.place.area === area) &&
      // A neighbourhood alone means places in it; with a distance, places that close to its centre, whatever their area label.
      (!hood || (within ? metersBetween(r.place, hood) <= within.meters : inHood(r.place, hood))) &&
      (!cuisine || r.place.cuisines.some((c) => c.cuisine === cuisine)) &&
      (!placeSlug || r.place.slug === placeSlug) &&
      (!onlySaved || savedSet.has(r.dishId)),
  );
  const { shown, counts } = applyLens(base, lens);
  // Neighbourhood chip counts follow the diet the person chose, so a chip never promises meals that will not show.
  const inDiet = applyLens(discoverable, lens).shown;
  let rows: (Row & { fit: MealFit })[] = shown;
  if (min !== null) rows = rows.filter((r) => (onBasis(r, "serving")?.low ?? -1) >= min);
  rows.sort(
    sort === "near" && hood
      ? (a, b) => metersBetween(a.place, hood) - metersBetween(b.place, hood) || byProtein(a, b)
      : sort === "price"
      ? (a, b) => (a.priceUsd === null ? 1 : b.priceUsd === null ? -1 : Number(a.priceUsd) - Number(b.priceUsd)) || a.label.localeCompare(b.label)
      : sort === "name"
        ? (a, b) => a.label.localeCompare(b.label)
        : basis === "100kcal"
          ? (a, b) => {
              const x = proteinPer100kcal(a)?.low ?? null;
              const y = proteinPer100kcal(b)?.low ?? null;
              return x === null && y === null ? byProtein(a, b) : x === null ? 1 : y === null ? -1 : y - x;
            }
          : byProtein,
  );
  // Each restaurant's strongest meals first (docs/64); a restaurant filter shows that menu in full.
  const expand = placeSlug ? "all" : readExpand(sp.more);
  const spread = spreadByPlace(rows, { expand, protein: (r) => onBasis(r, "serving")?.low ?? null });
  const comparing = compareIds.map((id) => all.find((r) => r.dishId === id)).filter((r): r is Row => Boolean(r));
  const areas = [...new Set(places.map((p) => p.area).filter((a): a is string => Boolean(a)))].sort();
  const cuisines = [...new Set(places.flatMap((p) => p.cuisines.map((c) => c.cuisine)))].sort();
  const here = hrefWith("/protein/meals", sp, { m: undefined, e: undefined });
  const left = all.length - discoverable.length;

  return (
    <>
      <UnverifiedBanner>
        <p className="s14" style={{ margin: "6px 0 0" }}>
          {all.length} complete meals from {places.length} real Boston-area restaurants.
          {left > 0 && (
            <>
              {" "}
              {left} {left === 1 ? "meal is" : "meals are"} left out because {left === 1 ? "it names" : "they name"} meat with no vegetarian claim;{" "}
              {left === 1 ? "it stays" : "they stay"} on {left === 1 ? "its" : "their"} restaurant&rsquo;s page.
            </>
          )}
        </p>
      </UnverifiedBanner>
      <Flash sp={{ m: sp.m, e: sp.e }} />
      {comparing.length > 0 && <Compare rows={comparing} basis={basis} sp={sp} />}
      {!lens.saved && <DietFilterNav current={lens.choice.diet === "none" ? "any" : lens.choice.diet} href={(d) => hrefWith("/protein/meals", sp, { diet: d === "any" ? undefined : d, fit: undefined, m: undefined, e: undefined })} counts={dietTabCounts(base)} />}
      <DietScope choice={lens.choice} saved={lens.saved} view={lens.view} counts={counts} href={(v) => hrefWith("/protein/meals", sp, { fit: v === "mine" ? undefined : v, m: undefined, e: undefined })} />
      <nav className="chips scroll" aria-label="Neighbourhood" data-testid="meal-hoods">
        <Link className="chip" href={hrefWith("/protein/meals", sp, { hood: undefined, within: undefined, sort: sort === "near" ? undefined : sort, more: undefined, m: undefined, e: undefined })} aria-current={!hood ? "true" : undefined}>
          All Boston-area
        </Link>
        {HOODS.map((h) => ({ h, n: inDiet.filter((r) => inHood(r.place, h)).length }))
          .filter(({ h, n }) => n > 0 || hood?.key === h.key)
          .map(({ h, n }) => (
            <Link key={h.key} className="chip" data-hood={h.key} href={hrefWith("/protein/meals", sp, { hood: h.key, more: undefined, m: undefined, e: undefined })} aria-current={hood?.key === h.key ? "true" : undefined}>
              {h.label} <span className="count">{n}</span>
            </Link>
          ))}
      </nav>
      {hood && (
        <>
          <p className="s13 muted" style={{ margin: "0 0 4px" }} id="mwithin-h">
            Distance from {hood.centre}, in a straight line:
          </p>
          <nav className="chips scroll" aria-labelledby="mwithin-h" data-testid="meal-within">
            {WITHIN.map((w) => (
              <Link key={w.key} className="chip" href={hrefWith("/protein/meals", sp, { within: within?.key === w.key ? undefined : w.key, more: undefined, m: undefined, e: undefined })} aria-current={within?.key === w.key ? "true" : undefined}>
                {w.label}
              </Link>
            ))}
            <Link className="chip" href={hrefWith("/protein/meals", sp, { sort: sort === "near" ? undefined : "near", m: undefined, e: undefined })} aria-current={sort === "near" ? "true" : undefined}>
              Nearest first
            </Link>
          </nav>
        </>
      )}
      <nav className="chips scroll" aria-label="Quick filters" data-testid="meal-quick">
        {[20, 30].map((g) => (
          <Link key={g} className="chip" href={hrefWith("/protein/meals", sp, { min: min === g ? undefined : String(g), m: undefined, e: undefined })} aria-current={min === g ? "true" : undefined}>
            {g} g+ protein
          </Link>
        ))}
        <Link className="chip" href={hrefWith("/protein/meals", sp, { saved: onlySaved ? undefined : "true", m: undefined, e: undefined })} aria-current={onlySaved ? "true" : undefined}>
          Saved <span className="count">{saved.length}</span>
        </Link>
        <Link className="chip" href={hrefWith("/protein/meals", sp, { sort: sort === "price" ? undefined : "price", m: undefined, e: undefined })} aria-current={sort === "price" ? "true" : undefined}>
          Cheapest first
        </Link>
      </nav>
      <p className="s13 muted" style={{ margin: "0 0 6px" }}>
        Vegan and vegetarian mean the restaurant&rsquo;s own menu says so. A meal whose diet the menu doesn&rsquo;t state is never counted as vegetarian or vegan
        {chosen ? ", and a meal that lists something you leave out never fits your diet" : ""}.
      </p>
      <form action="/protein/meals" method="get" className="stack" style={{ margin: "8px 0" }} data-testid="meal-filters">
        {tmp && <input type="hidden" name="diet" value={tmp} />}
        {lens.view !== "mine" && <input type="hidden" name="fit" value={lens.view} />}
        {compareIds.length > 0 && <input type="hidden" name="compare" value={compareIds.join(",")} />}
        {hood && <input type="hidden" name="hood" value={hood.key} />}
        {within && <input type="hidden" name="within" value={within.key} />}
        {/* On a phone the filters fold away so the first meals show without scrolling, as on the places list. */}
        <details className="sheet" open={filtersOn > 0} data-testid="meal-filter-sheet">
          <summary>
            <Icon name="filter" />
            Filters and sorting{filtersOn > 0 ? ` (${filtersOn} on)` : ""}
          </summary>
          <div className="sheet-body stack">
        <div className="field-grid">
          <div>
            <label htmlFor="marea">Area</label>
            <select id="marea" name="area" defaultValue={area}>
              <option value="">All areas</option>
              {areas.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="mcuisine">Cuisine or style</label>
            <select id="mcuisine" name="cuisine" defaultValue={cuisine} data-testid="meal-cuisine">
              <option value="">All cuisines</option>
              {cuisines.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="mplace">Restaurant</label>
            <select id="mplace" name="place" defaultValue={placeSlug}>
              <option value="">All {places.length} restaurants</option>
              {places.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="msort">Sort by</label>
            <select id="msort" name="sort" defaultValue={sort} data-testid="meal-sort">
              {(Object.keys(SORTS) as Sort[]).filter((s) => s !== "near" || hood).map((s) => (
                <option key={s} value={s}>
                  {SORTS[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="mbasis">Protein</label>
            <select id="mbasis" name="basis" defaultValue={basis}>
              {(Object.keys(BASES) as Basis[]).map((b) => (
                <option key={b} value={b}>
                  {BASES[b]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="mmin">At least (g protein per serving)</label>
            <input id="mmin" name="min" type="number" inputMode="numeric" min={1} max={200} defaultValue={min ?? ""} data-testid="meal-min" />
          </div>
        </div>
        <label style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 44 }}>
          <input type="checkbox" name="saved" value="true" defaultChecked={onlySaved} /> Only meals I saved ({saved.length})
        </label>
        <p style={{ margin: 0 }}>
          <button className="btn" type="submit" data-testid="meal-apply">
            Apply
          </button>{" "}
          <Link href="/protein/meals">Clear all</Link>
        </p>
          </div>
        </details>
      </form>
      <p className="s14 muted">
        Cuisine comes from Overture Maps&rsquo; category for each restaurant, not checked by us. &ldquo;At least&rdquo; uses the low end of a range and leaves out unknown protein.
        {basis === "100kcal" && " Per 100 kcal is only shown where the restaurant prints both protein and calories for the same serving."}
      </p>
      <h2 className="h-sec" data-testid="meal-count">
        {rows.length} {rows.length === 1 ? "meal" : "meals"}
        {hood ? ` ${within ? `within ${within.label} of ${hood.centre}` : `in ${hood.label}`}` : ""}
      </h2>
      {rows.length === 0 ? (
        <div className="empty" data-testid="meal-none">
          <h3>No meal matches</h3>
          <p>
            {min !== null ? `No ${chosen ? `${describeDietChoice(lens.choice).toLowerCase()} ` : ""}meal here prints or estimates at least ${min} g of protein. ` : ""}
            {onlySaved && saved.length === 0 ? "You haven't saved any meals yet. " : ""}Try another diet, {hood ? "neighbourhood, distance" : "area"} or cuisine{min !== null ? ", or a lower minimum" : ""}.
          </p>
          <p>
            {min !== null && (
              <>
                <Link className="btn" href={hrefWith("/protein/meals", sp, { min: undefined, m: undefined, e: undefined })}>
                  Remove the minimum
                </Link>{" "}
              </>
            )}
            <Link className="btn" href="/protein/meals">
              Clear all filters
            </Link>
          </p>
        </div>
      ) : (
        <ul className="cards">
          {spread.shown.map((r) => {
            const inCompare = compareIds.includes(r.dishId);
            const next = inCompare ? compareIds.filter((x) => x !== r.dishId) : [...compareIds, r.dishId].slice(-3);
            const isSaved = savedSet.has(r.dishId);
            return (
              <MealCard
                key={r.dishId}
                m={r}
                fit={r.fit}
                placeName={r.place.name}
                placeSlug={r.place.slug}
                distance={hood ? `${miles(away(r)!)} from ${hood.centre}` : undefined}
                from={here}
                compare={
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
                    <form action={saveMealAction}>
                      <input type="hidden" name="dishId" value={r.dishId} />
                      <input type="hidden" name="saved" value={isSaved ? "no" : "yes"} />
                      <input type="hidden" name="returnTo" value={here} />
                      <button className="btn small" type="submit" aria-pressed={isSaved} data-testid="meal-save">
                        {isSaved ? "Saved" : "Save"}
                        <span className="sr-only"> {r.label}</span>
                      </button>
                    </form>
                    <Link
                      className="btn small"
                      href={`${hrefWith("/protein/meals", sp, { compare: next.join(",") || undefined, m: undefined, e: undefined })}${inCompare ? "" : "#compare"}`}
                      data-testid="meal-compare-toggle"
                    >
                      {inCompare ? "Remove from comparison" : compareIds.length >= 3 ? "Compare (replaces the oldest)" : "Compare"}
                      <span className="sr-only"> {r.label}</span>
                    </Link>
                  </div>
                }
              />
            );
          })}
        </ul>
      )}
      {rows.length > 0 && !placeSlug && (
        <MoreFromPlaces
          held={spread.held}
          total={spread.total}
          expanded={expand === "all" && new Set(rows.map((r) => r.place.slug)).size > 1}
          href={(slug) => hrefWith("/protein/meals", sp, { more: withExpanded(expand, slug), m: undefined, e: undefined })}
          allHref={hrefWith("/protein/meals", sp, { more: "all", m: undefined, e: undefined })}
          lessHref={hrefWith("/protein/meals", sp, { more: undefined, m: undefined, e: undefined })}
        />
      )}
      <p className="s14 muted">
        <Link href="/protein">Back to Protein Explorer foods</Link>
      </p>
    </>
  );
}

export default function MealsPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  if (!FLAGS.realCatalogPreview) notFound();
  return (
    <AppShell active="protein" realPlaces>
      <p className="eyebrow">Protein Explorer · Boston area</p>
      <h1 className="title">Restaurant meals</h1>
      <Suspense fallback={<MealListSkeleton />}>
        <Meals searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
