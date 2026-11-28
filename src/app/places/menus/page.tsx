import { MealsNotOpen } from "@/components/meals-not-open";
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { SignInPrompt } from "@/components/social/bits";
import { DietFilterNav, DietScope, MealListSkeleton, Monogram, UnverifiedBanner } from "@/components/menu-preview";
import { FLAGS } from "@/config/flags";
import { byProtein, menuAgreedHints } from "@/contracts/menu-preview";
import { HOODS, hoodByKey, inHood } from "@/contracts/neighbourhoods";
import { dietHintWords } from "@/contracts/places";
import { applyLens, dietTabCounts, type FitView, type MealLens } from "@/contracts/meal-eligibility";
import { describeDietChoice, hasDietChoice } from "@/domain/dietary/labels";
import { readMealLens } from "@/server/catalog/meal-lens";
import { hrefWith, type RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getPreviewAudience, getPreviewPlaces, getWaitingMenus, type PreviewPlace } from "@/server/catalog/menu-preview";
import { streetFile } from "@/server/map-tiles";
import { MenusMap } from "./menus-map";

export const metadata = { title: "Restaurants with menus (unverified preview)", robots: { index: false, follow: false } };
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function summary(p: PreviewPlace, lens: Pick<MealLens, "choice" | "view">) {
  const { shown: meals, counts } = applyLens(p.meals, lens);
  const stated = p.meals.filter((m) => !m.excluded);
  const vegan = stated.filter((m) => m.diet === "vegan_stated").length;
  const veg = stated.filter((m) => m.diet === "vegetarian_stated").length;
  const unknown = stated.filter((m) => m.diet === "unknown").length;
  const withProtein = meals.filter((m) => m.protein.low !== null).length;
  const top = [...meals].sort(byProtein)[0];
  const chosen = hasDietChoice(lens.choice);
  return {
    meals,
    counts,
    vegan,
    veg,
    topEstimate: top?.protein.basis === "usda_range",
    topGrams: top && top.protein.low !== null ? (top.protein.low === top.protein.high ? fmt(top.protein.low) : `${fmt(top.protein.low)}–${fmt(top.protein.high!)}`) : null,
    words: !chosen
      ? `${meals.length} ${meals.length === 1 ? "meal" : "meals"}: ${vegan} vegan and ${veg} vegetarian as the restaurant states, ${unknown} with diet not stated; ${withProtein} with a protein figure or range.`
      : `${counts.mine} ${counts.mine === 1 ? "meal fits" : "meals fit"} ${describeDietChoice(lens.choice).toLowerCase()}; ${counts.check} need confirmation; ${withProtein} shown with a protein figure or range.`,
    top: top && top.protein.low !== null ? `Most protein: ${top.label}, ${top.protein.low === top.protein.high ? fmt(top.protein.low) : `${fmt(top.protein.low)}–${fmt(top.protein.high!)}`} g (${top.protein.basis === "usda_range" ? "USDA estimate" : "restaurant's figure"})` : null,
  };
}

async function Menus({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next="/places/menus">
        <p>Restaurant meals are in a small private test for now. Sign in if you are taking part.</p>
      </SignInPrompt>
    );
  }
  const [places, audience] = await Promise.all([getPreviewPlaces(), getPreviewAudience()]);
  if (!places) return <MealsNotOpen />;
  const waiting = audience === "founder" ? await getWaitingMenus() : [];
  const lens = await readMealLens(sp);
  const chosen = hasDietChoice(lens.choice);
  const cuisine = first(sp.cuisine) || "";
  const view = first(sp.view) === "map" ? "map" : "list";
  const hood = hoodByKey(first(sp.hood));
  const byCuisine = places.filter((p) => (!cuisine || p.cuisines.some((c) => c.cuisine === cuisine)) && (!hood || inHood(p, hood)));
  const shown = byCuisine
    .map((p) => ({ p, s: summary(p, lens) }))
    // With no diet (or under "All meals") a restaurant whose drafted rows are not sorted into meals yet still shows.
    .filter((x) => x.s.meals.length > 0 || !chosen || lens.view === "all")
    .sort((a, b) => {
      const x = [...a.s.meals].sort(byProtein)[0];
      const y = [...b.s.meals].sort(byProtein)[0];
      return !x || !y ? (x ? -1 : y ? 1 : a.p.name.localeCompare(b.p.name)) : byProtein(x, y);
    });
  const per = byCuisine.map((p) => summary(p, { choice: lens.choice, view: "all" }).counts);
  const counts: Record<FitView, number> = { mine: per.filter((c) => c.mine > 0).length, check: per.filter((c) => c.check > 0).length, all: byCuisine.length };
  const cuisines = [...new Set(places.flatMap((p) => p.cuisines.map((c) => c.cuisine)))].sort();
  const perTab = byCuisine.map((p) => dietTabCounts(p.meals));
  const tabs = { any: byCuisine.length, vegetarian: perTab.filter((c) => c.vegetarian > 0).length, vegan: perTab.filter((c) => c.vegan > 0).length };
  return (
    <>
      <UnverifiedBanner />
      {!lens.saved && <DietFilterNav current={lens.choice.diet === "none" ? "any" : lens.choice.diet} href={(d) => hrefWith("/places/menus", sp, { diet: d === "any" ? undefined : d, fit: undefined })} counts={tabs} />}
      <DietScope choice={lens.choice} saved={lens.saved} view={lens.view} counts={counts} href={(v) => hrefWith("/places/menus", sp, { fit: v === "mine" ? undefined : v })} />
      {chosen && (
        <p className="s14 muted" style={{ margin: "6px 0" }}>
          Counts are restaurants with at least one such meal. A meal fits only when the restaurant&rsquo;s own words cover your diet and nothing it lists is
          something you leave out.
        </p>
      )}
      <nav className="chips scroll" aria-label="Neighbourhood" data-testid="menus-hoods">
        <Link className="chip" href={hrefWith("/places/menus", sp, { hood: undefined })} aria-current={!hood ? "true" : undefined}>
          All Boston-area
        </Link>
        {HOODS.map((h) => ({ h, n: places.filter((p) => inHood(p, h)).length }))
          .filter(({ h, n }) => n > 0 || hood?.key === h.key)
          .map(({ h, n }) => (
            <Link key={h.key} className="chip" href={hrefWith("/places/menus", sp, { hood: h.key })} aria-current={hood?.key === h.key ? "true" : undefined}>
              {h.label} <span className="count">{n}</span>
            </Link>
          ))}
      </nav>
      <nav className="chips scroll" aria-label="Cuisine or style" data-testid="menus-cuisine">
        <Link className="chip" href={hrefWith("/places/menus", sp, { cuisine: undefined })} aria-current={!cuisine ? "true" : undefined}>
          All cuisines
        </Link>
        {cuisines.map((c) => (
          <Link key={c} className="chip" href={hrefWith("/places/menus", sp, { cuisine: c })} aria-current={cuisine === c ? "true" : undefined} data-testid="menus-cuisine-option">
            {c}
          </Link>
        ))}
      </nav>
      <nav className="seg" aria-label="Show restaurants as" style={{ marginBottom: 12 }}>
        <Link href={hrefWith("/places/menus", sp, { view: undefined })} aria-current={view === "list" ? "true" : undefined} data-testid="menus-view-list">
          List
        </Link>
        <Link href={hrefWith("/places/menus", sp, { view: "map" })} aria-current={view === "map" ? "true" : undefined} data-testid="menus-view-map">
          Map
        </Link>
      </nav>
      {audience === "founder" && (
        <p className="s14" style={{ margin: "6px 0" }}>
          <Link href="/places/menus/confirm" data-testid="menus-confirm-link">
            Meals that need confirmation
          </Link>{" "}
          <span className="muted">: what the menus leave unsaid, and what is missing.</span>
          <br />
          <Link href="/places/contributions" data-testid="menus-contrib-link">
            Suggestions from members
          </Link>{" "}
          <span className="muted">: leads to check at their source.</span>
          <br />
          <Link href="/places/menus/testers" data-testid="menus-testers-link">
            Meals for invited testers
          </Link>{" "}
          <span className="muted">: choose the small set testers could see.</span>
          <br />
          <Link href="/feedback/all" data-testid="menus-feedback-link">
            Tester feedback
          </Link>
        </p>
      )}
      {waiting.length > 0 && (
        <p className="callout" data-testid="menus-waiting">
          <strong>
            {waiting.length} linked {waiting.length === 1 ? "restaurant is" : "restaurants are"} waiting for your identity check:
          </strong>{" "}
          {waiting.map((w) => `${w.name}${w.street ? `, ${w.street}` : ""}`).join("; ")}. Its menu is loaded, but it shows here only after you confirm which
          place it is on the <Link href="/review">identity review</Link> page. Nothing is decided for you.
        </p>
      )}
      <h2 className="h-sec" data-testid="menus-count">
        {shown.length} {shown.length === 1 ? "restaurant" : "restaurants"}
      </h2>
      {view === "map" ? (
        <MenusMap
          pins={shown.filter((x) => x.s.meals.length > 0 || x.p.meals.length === 0).map(({ p, s }) => ({ id: p.listingId, slug: p.slug, name: p.name, area: p.area, lat: p.lat, lon: p.lon, meals: s.meals.length, summary: s.words }))}
          streetUrl={(await streetFile()) ? "/map-data/streets" : null}
          fitKey={`${lens.choice.diet}|${lens.view}|${cuisine}`}
        />
      ) : shown.length === 0 ? (
        <div className="empty" data-testid="menus-none">
          <h3>No restaurant matches</h3>
          <p>None of the researched restaurants has a meal that fits both filters.</p>
          <p>
            <Link className="btn" href="/places/menus">
              Clear filters
            </Link>
          </p>
        </div>
      ) : (
        <ul className="cards">
          {shown.map(({ p, s }) => (
            <li key={p.listingId} className="rcard" data-testid="menus-place">
              <Monogram name={p.name} cuisine={p.cuisines.find((c) => c.basis === "dataset_primary")?.cuisine} />
              <div className="body">
                <h3>
                  <Link href={`/places/${p.slug}${lens.view !== "mine" ? `?fit=${lens.view}` : !lens.saved && lens.choice.diet !== "none" ? `?diet=${lens.choice.diet}` : ""}`}>{p.name}</Link>
                </h3>
                <p className="meta">
                  {[p.area, p.cuisines.map((c) => (c.basis === "dataset_alternate" ? `possibly ${c.cuisine}` : c.cuisine)).join(", ")].filter(Boolean).join(" · ")}
                </p>
                <p className="meta">{p.street}</p>
                {dietHintWords(menuAgreedHints(p.dietHints, p.meals)) && (
                  <p className="s13 muted" style={{ margin: "2px 0 0" }} data-testid="menus-diet-hint">
                    {dietHintWords(menuAgreedHints(p.dietHints, p.meals))}; meal diets come only from the menu
                  </p>
                )}
                {s.meals.length === 0 && p.meals.length === 0 ? (
                  <p className="s13" style={{ margin: "6px 0 0" }}>
                    No complete meals yet: {p.otherRows} drafted {p.otherRows === 1 ? "row is" : "rows are"} not sorted into meal or side yet.
                  </p>
                ) : (
                  <div className="stats" data-testid="menus-stats">
                    <span className="dchip">
                      {s.meals.length} {s.meals.length === 1 ? "meal" : "meals"}
                    </span>
                    {s.vegan > 0 && <span className="dchip vegan">{s.vegan} vegan</span>}
                    {s.veg > 0 && <span className="dchip veg">{s.veg} vegetarian</span>}
                    {s.topGrams && (
                      <span className={`dchip ${s.topEstimate ? "est" : "ok"}`} title={s.topEstimate ? "USDA estimate, not the restaurant's figure" : "The restaurant's own figure"}>
                        Top {s.topGrams} g{s.topEstimate ? " (USDA est.)" : ""}
                      </span>
                    )}
                  </div>
                )}
                {s.top && <p className="s13 muted" style={{ margin: "4px 0 0" }}>{s.top}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="s14 muted">
        Cuisine comes from Overture Maps&rsquo; category for each restaurant, not checked by us. <Link href="/places">All restaurants and cafés</Link>
      </p>
    </>
  );
}

export default function MenusPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  if (!FLAGS.realCatalogPreview) notFound();
  return (
    <AppShell active="discover" realPlaces>
      <p className="eyebrow">Boston area</p>
      <h1 className="title">Restaurants with menus</h1>
      <Suspense fallback={<MealListSkeleton rows={4} />}>
        <Menus searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
