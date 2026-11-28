import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell, Loading } from "@/components/app-shell";
import { SignInPrompt } from "@/components/social/bits";
import { FLAGS } from "@/config/flags";
import { addCoverage, placeCoverage, type Coverage } from "@/contracts/menu-coverage";
import { areaWords, type MenuPlace, type MenuPlaceRow } from "@/contracts/menu-review";
import { getCurrentMember } from "@/server/auth/session";
import { getMenuPlace, getMenuPlaces } from "@/server/catalog/menu-review";
import { SocialError } from "@/server/social";
import { FounderOnly } from "../bits";
import { FounderGate } from "../gate";

export const metadata = { title: "Menu review", robots: { index: false, follow: false } };


/**
 * Coverage of the private drafts (owner direction 18 Nov 2026 20:56 UTC). Each figure is its own
 * count: complete meals, build-your-own meals and their parts are never added together; published
 * nutrition, the restaurant's own estimates and USDA estimates are never added together; and an
 * estimate is never dietary evidence. Nothing here is checked or public.
 */
const COVERAGE_ROWS: { group: string; rows: [string, (c: Coverage) => number][] }[] = [
  {
    group: "What was drafted",
    rows: [
      ["Complete meals", (c) => c.completeMeals],
      ["Platters for a group (not one person's meal)", (c) => c.groupPlatters],
      ["Build-your-own meals", (c) => c.customizableMeals],
      ["Parts of build-your-own meals", (c) => c.parts],
      ["Sides, drinks and desserts", (c) => c.sidesDrinksDesserts],
      ["Not sorted yet", (c) => c.unclassified],
    ],
  },
  {
    group: "Protein for complete meals (each meal counted once)",
    rows: [
      ["Published by the restaurant, one value", (c) => c.protein.publishedValue],
      ["Published by the restaurant, a range", (c) => c.protein.publishedRange],
      ["The restaurant's own estimate", (c) => c.protein.restaurantEstimate],
      ["USDA estimate from typical amounts (not reviewed)", (c) => c.protein.usdaEstimate],
      ["USDA estimate tried, still unknown", (c) => c.protein.usdaUnknown],
      ["No protein figure at all", (c) => c.protein.none],
      ["Complete meals with any published nutrition", (c) => c.mealsWithPublishedNutrition],
    ],
  },
  {
    group: "What the menu says about diet (complete meals; these add up to the complete meals above)",
    rows: [
      ["Says vegan", (c) => c.dietary.veganStated],
      ["Says vegetarian (not vegan)", (c) => c.dietary.vegetarianStated],
      ["Says not vegetarian", (c) => c.dietary.notVegetarian],
      ["Doesn't say", (c) => c.dietary.notStated],
      ["No dietary evidence drafted", (c) => c.dietary.noEvidence],
      ["Of those that don't say: names meat or fish", (c) => c.namesMeatWithoutClaim],
    ],
  },
  {
    group: "What the menu says about diet (build-your-own meals, counted on their own)",
    rows: [
      ["Says vegan", (c) => c.dietaryBuildYourOwn.veganStated],
      ["Says vegetarian (not vegan)", (c) => c.dietaryBuildYourOwn.vegetarianStated],
      ["Doesn't say", (c) => c.dietaryBuildYourOwn.notStated + c.dietaryBuildYourOwn.noEvidence + c.dietaryBuildYourOwn.notVegetarian],
    ],
  },
  {
    group: "Review left",
    rows: [
      ["Flagged rows to check one at a time", (c) => c.review.exceptions],
      ["Rows with no flags, waiting", (c) => c.review.cleanWaiting],
      ["Groups those rows fall into", (c) => c.review.cleanGroups],
      ["Facts you have confirmed privately", (c) => c.review.transcriptionsConfirmed],
    ],
  },
];

function CoverageTable({ places }: { places: MenuPlace[] }) {
  const per = places.map((p) => ({ p, c: placeCoverage(p) }));
  const total = addCoverage(per.map((x) => x.c));
  return (
    <section className="stack" data-testid="menu-coverage">
      <h2 className="h-sec">Coverage of the drafts</h2>
      <p className="s14 muted" style={{ margin: 0 }}>
        Counts of drafted rows, kept separate. None of this is checked or public, and a USDA estimate never says whether a dish is vegetarian or vegan.
      </p>
      {/* Scrolls sideways on its own at phone width; focusable so a keyboard can scroll it. */}
      <div style={{ overflowX: "auto" }} tabIndex={0} role="region" aria-label="Coverage table, scrolls sideways">
        <table className="s14" style={{ borderCollapse: "collapse", minWidth: "100%" }}>
          <thead>
            <tr>
              <th scope="col" style={{ textAlign: "left" }}>
                Measure
              </th>
              <th scope="col" style={{ textAlign: "right" }}>
                All
              </th>
              {per.map(({ p }) => (
                <th key={p.placeId} scope="col" style={{ textAlign: "right", overflowWrap: "anywhere" }}>
                  {p.label}
                </th>
              ))}
            </tr>
          </thead>
          {COVERAGE_ROWS.map((g) => (
            <tbody key={g.group}>
              <tr>
                <th scope="colgroup" colSpan={per.length + 2} style={{ textAlign: "left", paddingTop: 8 }}>
                  {g.group}
                </th>
              </tr>
              {g.rows.map(([label, f]) => (
                <tr key={label} data-testid="menu-coverage-row" data-measure={label}>
                  <th scope="row" style={{ textAlign: "left", fontWeight: 400 }}>
                    {label}
                  </th>
                  <td style={{ textAlign: "right" }} data-testid="menu-coverage-total">
                    {f(total)}
                  </td>
                  {per.map(({ p, c }) => (
                    <td key={p.placeId} style={{ textAlign: "right" }}>
                      {f(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </section>
  );
}

function Row({ p }: { p: MenuPlaceRow }) {
  return (
    <li className="post" data-testid="menu-place">
      <div className="head">
        <Link href={`/places/review/menus/${p.placeId}`} style={{ fontWeight: 600, overflowWrap: "anywhere" }}>
          {p.label}
        </Link>
        <span className={`badge ${p.ready > 0 ? "wait" : "ok"}`}>{p.ready > 0 ? `${p.ready} to check` : "Nothing to check"}</span>
      </div>
      <p className="s14 muted" style={{ margin: "4px 0 0" }}>
        {areaWords(p.area)}, {p.city} · {p.dishes} {p.dishes === 1 ? "dish" : "dishes"} · {p.confirmed} confirmed by you
        {p.held > 0 && ` · ${p.held} waiting for source clearance`}
        {p.rejected > 0 && ` · ${p.rejected} rejected`}
      </p>
    </li>
  );
}

async function Places() {
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next="/places/review/menus">
        <p>Menu review is for the founder. Sign in to continue.</p>
      </SignInPrompt>
    );
  }
  let places: MenuPlaceRow[];
  try {
    places = await getMenuPlaces();
  } catch (e) {
    if (e instanceof SocialError && (e.status === 403 || e.status === 401)) return <FounderOnly />;
    return (
      <div className="callout stop" role="alert">
        <strong>We couldn&rsquo;t load the menus just now.</strong> <Link href="/places/review/menus">Try again</Link>
      </div>
    );
  }
  if (places.length === 0) {
    return (
      <div className="empty" data-testid="menu-empty">
        <h2>No drafted menus yet</h2>
        <p>When research drafts a restaurant&rsquo;s menu from a permitted source, it appears here for you to check.</p>
      </div>
    );
  }
  const ready = places.reduce((n, p) => n + p.ready, 0);
  // Coverage needs every place's rows; a place that fails to load is left out of the table and named.
  const loaded = await Promise.all(places.map((p) => getMenuPlace(p.placeId).catch(() => null)));
  const details = loaded.filter((x): x is MenuPlace => x !== null);
  return (
    <>
      <p data-testid="menu-total">
        <strong>{ready}</strong> drafted {ready === 1 ? "fact is" : "facts are"} ready for you to check across {places.length} {places.length === 1 ? "restaurant" : "restaurants"}.
      </p>
      <ul className="feed" data-testid="menu-places" style={{ listStyle: "none", padding: 0 }}>
        {places.map((p) => (
          <Row key={p.placeId} p={p} />
        ))}
      </ul>
      {details.length > 0 && <CoverageTable places={details} />}
      {details.length < places.length && (
        <p className="callout stop" role="alert">
          Coverage leaves out {places.length - details.length} {places.length - details.length === 1 ? "restaurant" : "restaurants"} that could not be loaded just now.
        </p>
      )}
    </>
  );
}

export default function MenuReviewPage() {
  if (!FLAGS.realCatalogPreview) notFound();
  return (
    <Suspense fallback={<Loading />}>
      <FounderGate probe={getMenuPlaces}>
    <AppShell active="discover" realPlaces>
      <p className="eyebrow">Private · founder only</p>
      <h1 className="title">Menu review</h1>
      <p>
        <Link href="/places/review">← Identity review</Link>
      </p>
      <p className="callout calm">
        Research drafts each dish from the restaurant&rsquo;s own pages, with the page and the date. You confirm, correct or reject whole rows. Nothing here is public, and
        confirming a row does not publish it.
      </p>
      <Suspense fallback={<Loading label="Loading menus…" />}>
        <Places />
      </Suspense>
    </AppShell>
      </FounderGate>
    </Suspense>
  );
}
